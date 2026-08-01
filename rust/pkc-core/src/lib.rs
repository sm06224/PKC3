//! PKC3 core (Rust → wasm32)。
//!
//! 現在の payload は **revision 復元チェーン**ひとつだけ(rust-wasm-strategy §4.2)。
//! 採用条件(同 doc §2.1)を満たすのがこれだからである:
//!   B1 境界 1 往復に対して仕事が大きい(N 段ぶんの適用を 1 回の呼び出しで回す)
//!   B2 戻り値が小さい(最終本文 1 本のみ。中間状態を JS へ出さない)
//!   B3 無状態(呼び出し内で完結。linear memory の高水位を残さない)
//!
//! 設計の約束:
//! - **wasm-bindgen を使わない**。生の `extern "C"` + 手動メモリ管理。
//!   glue 無し・imports 0 件で、境界とライフサイクルを完全に制御する
//! - **panic を正常系に使わない**。想定内の失敗はすべて status code で返す
//!   (`panic = "abort"` なので panic は trap になる。JS 側は trap を捕まえたら
//!   instance を毒として捨て、TS 実装へフォールバックする)
//! - **hash は計算しない**。`content_hash` は JS 側の UTF-16 FNV で永続化済みで、
//!   UTF-8 で計算すると非 ASCII で必ず値が変わる(同 doc §5-2 / F1)。
//!   ここで再現しようとしないこと ── 既存 DB の履歴が全滅する
//!
//! 行分割は UTF-8 バイト列に対して `\n` を探すだけでよい。UTF-8 の多バイト
//! 列に 0x0A は現れないため、TS の `splitLines` と**完全に同じ切り方**になる。

use core::mem::size_of;
use std::alloc::{alloc as sys_alloc, dealloc as sys_dealloc, Layout};

// ── status code(JS 側と対応。TS 実装と同じ文言へ写す)──
const ST_OK: u32 = 0;
const ST_MALFORMED_FRAME: u32 = 1;
const ST_COPY_OVERRUN: u32 = 2;
const ST_DELETE_OVERRUN: u32 = 3;
const ST_NOT_CONSUMED: u32 = 4;
const ST_UNSUPPORTED_VERSION: u32 = 5;

const FRAME_VERSION: u32 = 1;
const KIND_FULL: u32 = 0;
const KIND_PATCH: u32 = 1;
const OP_COPY: u32 = 0;
const OP_DELETE: u32 = 1;
const OP_INSERT: u32 = 2;

/// 結果バッファ先頭のヘッダ(status, len)。本体はその直後に続く。
const RESULT_HEADER: usize = 2 * size_of::<u32>();

// ── メモリ(Layout を固定して確保・解放を対称にする)──

fn layout(len: usize) -> Layout {
    // align 1 で確保し、同じ align で解放する。len == 0 でも Layout は有効
    Layout::from_size_align(len.max(1), 1).expect("layout")
}

/// JS が入力フレームを書き込むための領域を確保する。
#[no_mangle]
pub extern "C" fn pkc_alloc(len: usize) -> *mut u8 {
    unsafe { sys_alloc(layout(len)) }
}

/// `pkc_alloc` で得た領域を返す(**確保時と同じ len を渡すこと**)。
///
/// # Safety
/// `ptr` は `pkc_alloc(len)` の戻り値でなければならない。
#[no_mangle]
pub unsafe extern "C" fn pkc_free(ptr: *mut u8, len: usize) {
    if !ptr.is_null() {
        sys_dealloc(ptr, layout(len));
    }
}

/// 結果バッファを返す(ヘッダの len を読んで全体を解放する)。
///
/// # Safety
/// `ptr` は `pkc_restore_chain` の戻り値でなければならない。
#[no_mangle]
pub unsafe extern "C" fn pkc_free_result(ptr: *mut u8) {
    if ptr.is_null() {
        return;
    }
    let len = read_u32(ptr, size_of::<u32>()) as usize;
    sys_dealloc(ptr, layout(RESULT_HEADER + len));
}

/// 疎通確認用(境界が生きていることを test/probe が確かめるためだけの関数)。
#[no_mangle]
pub extern "C" fn pkc_abi_version() -> u32 {
    FRAME_VERSION
}

// ── フレーム読み出し ──

unsafe fn read_u32(base: *const u8, off: usize) -> u32 {
    let mut b = [0u8; 4];
    core::ptr::copy_nonoverlapping(base.add(off), b.as_mut_ptr(), 4);
    u32::from_le_bytes(b)
}

struct Cursor {
    base: *const u8,
    len: usize,
    off: usize,
}

impl Cursor {
    fn u32(&mut self) -> Option<u32> {
        if self.off + 4 > self.len {
            return None;
        }
        let v = unsafe { read_u32(self.base, self.off) };
        self.off += 4;
        Some(v)
    }
    fn bytes(&mut self, n: usize) -> Option<&'static [u8]> {
        if self.off + n > self.len {
            return None;
        }
        let s = unsafe { core::slice::from_raw_parts(self.base.add(self.off), n) };
        self.off += n;
        Some(s)
    }
}

/// 行の開始位置(終端の `\n` を含む切り方 ── TS の splitLines と同一)。
fn line_starts(buf: &[u8], out: &mut Vec<usize>) {
    out.clear();
    out.push(0);
    for (i, b) in buf.iter().enumerate() {
        if *b == b'\n' {
            out.push(i + 1);
        }
    }
    // 末尾が改行で終わる場合、最後の要素は buf.len() = 空の余り(行としては数えない)
}

/// 行数(TS の `splitLines(x).length` と一致する)。
fn line_count(starts: &[usize], buf_len: usize) -> usize {
    // starts は 0 始まりで、改行のたびに次の開始位置が入る。
    // 末尾が改行なら starts の最後 == buf_len で、それは行ではない
    let n = starts.len();
    if n == 0 {
        0
    } else if starts[n - 1] == buf_len {
        n - 1
    } else {
        n
    }
}

/// 1 段ぶんのパッチ適用。TS の `applyLinePatch` と同じ検査(全消費要求)を行う。
fn apply_patch(state: &[u8], cur: &mut Cursor, out: &mut Vec<u8>) -> u32 {
    let n_ops = match cur.u32() {
        Some(v) => v as usize,
        None => return ST_MALFORMED_FRAME,
    };
    let mut starts: Vec<usize> = Vec::new();
    line_starts(state, &mut starts);
    let total = line_count(&starts, state.len());

    // 行 i のバイト範囲
    let line_range = |i: usize| -> (usize, usize) {
        let s = starts[i];
        let e = if i + 1 < starts.len() { starts[i + 1] } else { state.len() };
        (s, e)
    };

    out.clear();
    let mut i = 0usize; // 消費した行数
    for _ in 0..n_ops {
        let tag = match cur.u32() {
            Some(v) => v,
            None => return ST_MALFORMED_FRAME,
        };
        match tag {
            OP_COPY => {
                let n = match cur.u32() {
                    Some(v) => v as usize,
                    None => return ST_MALFORMED_FRAME,
                };
                if i + n > total {
                    return ST_COPY_OVERRUN;
                }
                for _ in 0..n {
                    let (s, e) = line_range(i);
                    out.extend_from_slice(&state[s..e]);
                    i += 1;
                }
            }
            OP_DELETE => {
                let n = match cur.u32() {
                    Some(v) => v as usize,
                    None => return ST_MALFORMED_FRAME,
                };
                i += n;
                if i > total {
                    return ST_DELETE_OVERRUN;
                }
            }
            OP_INSERT => {
                let n_lines = match cur.u32() {
                    Some(v) => v as usize,
                    None => return ST_MALFORMED_FRAME,
                };
                for _ in 0..n_lines {
                    let len = match cur.u32() {
                        Some(v) => v as usize,
                        None => return ST_MALFORMED_FRAME,
                    };
                    match cur.bytes(len) {
                        Some(b) => out.extend_from_slice(b),
                        None => return ST_MALFORMED_FRAME,
                    }
                }
            }
            _ => return ST_MALFORMED_FRAME,
        }
    }
    if i != total {
        return ST_NOT_CONSUMED;
    }
    ST_OK
}

/// 復元チェーンを 1 往復で回す。
///
/// 入力フレーム(すべて little-endian u32):
/// ```text
///   u32 version
///   u32 n_steps
///   u32 tip_len ; [tip bytes]
///   n_steps 回:
///     u32 kind            (0 = full, 1 = patch)
///     kind==full  : u32 len ; [bytes]
///     kind==patch : u32 n_ops ; 各 op:
///                     u32 tag (0 copy / 1 delete / 2 insert)
///                     copy|delete: u32 count
///                     insert     : u32 n_lines ; 各行 u32 len ; [bytes]
/// ```
/// 戻り値は `[u32 status][u32 len][len bytes]`。**呼び出し側が `pkc_free_result`
/// で必ず解放する**(生成物のライフサイクル終端での即破棄 ── user 指示 2026-07-27)。
///
/// # Safety
/// `in_ptr` は `pkc_alloc(in_len)` で確保し、フレームを書き込んだ領域であること。
#[no_mangle]
pub unsafe extern "C" fn pkc_restore_chain(in_ptr: *const u8, in_len: usize) -> *mut u8 {
    let mut cur = Cursor { base: in_ptr, len: in_len, off: 0 };

    let fail = |status: u32| -> *mut u8 { alloc_result(status, &[]) };

    match cur.u32() {
        Some(v) if v == FRAME_VERSION => {}
        Some(_) => return fail(ST_UNSUPPORTED_VERSION),
        None => return fail(ST_MALFORMED_FRAME),
    }
    let n_steps = match cur.u32() {
        Some(v) => v as usize,
        None => return fail(ST_MALFORMED_FRAME),
    };
    let tip_len = match cur.u32() {
        Some(v) => v as usize,
        None => return fail(ST_MALFORMED_FRAME),
    };
    let tip = match cur.bytes(tip_len) {
        Some(b) => b,
        None => return fail(ST_MALFORMED_FRAME),
    };

    // state を 2 面で持ち回し、段ごとに入れ替える(中間生成物を貯めない)
    let mut state: Vec<u8> = tip.to_vec();
    let mut scratch: Vec<u8> = Vec::new();

    for _ in 0..n_steps {
        let kind = match cur.u32() {
            Some(v) => v,
            None => return fail(ST_MALFORMED_FRAME),
        };
        match kind {
            KIND_FULL => {
                let len = match cur.u32() {
                    Some(v) => v as usize,
                    None => return fail(ST_MALFORMED_FRAME),
                };
                match cur.bytes(len) {
                    Some(b) => {
                        state.clear();
                        state.extend_from_slice(b);
                    }
                    None => return fail(ST_MALFORMED_FRAME),
                }
            }
            KIND_PATCH => {
                let st = apply_patch(&state, &mut cur, &mut scratch);
                if st != ST_OK {
                    return fail(st);
                }
                core::mem::swap(&mut state, &mut scratch);
            }
            _ => return fail(ST_MALFORMED_FRAME),
        }
    }
    // 使い終わった中間バッファはここで落とす(高水位を残さない)
    drop(scratch);
    alloc_result(ST_OK, &state)
}

fn alloc_result(status: u32, body: &[u8]) -> *mut u8 {
    let total = RESULT_HEADER + body.len();
    let p = unsafe { sys_alloc(layout(total)) };
    if p.is_null() {
        return p;
    }
    unsafe {
        core::ptr::copy_nonoverlapping(status.to_le_bytes().as_ptr(), p, 4);
        core::ptr::copy_nonoverlapping((body.len() as u32).to_le_bytes().as_ptr(), p.add(4), 4);
        if !body.is_empty() {
            core::ptr::copy_nonoverlapping(body.as_ptr(), p.add(RESULT_HEADER), body.len());
        }
    }
    p
}
