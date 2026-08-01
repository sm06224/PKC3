//! PKC3 core (Rust → wasm32)。
//!
//! payload は **revision 復元チェーン**ひとつだけ(rust-wasm-strategy §4.2)。
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
//! 🔒 **境界検査は必ず checked 演算で行う**(review H1、実証済み):
//! wasm32 の `usize` は 32bit で、release ビルドは wrap しても panic しない。
//! `off + n > len` のような素朴な検査は**巨大な長さを渡すと wrap して通過**し、
//! 確保外のスライスを作る(UB)。今 trap で済んでいたのは「wrap 後の長さが
//! 4GB 級になり確保が失敗するから」という偶然にすぎない。
//! 生ポインタは**入口で 1 回だけ**スライス化し、以後は `get()` と
//! `checked_add()` だけを使う ── lifetime の嘘も同時に消える。
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

/// フレーム形式 = ABI の版。**橋と同時に上げる**(古い .wasm は橋の照合で弾かれる)。
/// v2: insert を「行ごと」から「連結 1 本」に変更(review M4 ── 行ごとの
/// encode が挿入の多い段で支配項になっていた。出力は連結なので意味論は同一)。
const FRAME_VERSION: u32 = 2;
const KIND_FULL: u32 = 0;
const KIND_PATCH: u32 = 1;
const OP_COPY: u32 = 0;
const OP_DELETE: u32 = 1;
const OP_INSERT: u32 = 2;

/// 結果バッファ先頭のヘッダ(status, len)。本体はその直後に続く。
const RESULT_HEADER: usize = 2 * size_of::<u32>();

// ── メモリ(Layout を固定して確保・解放を対称にする)──

/// **panic しない**(review L2): 不正なサイズは None → caller が null を返す。
fn layout(len: usize) -> Option<Layout> {
    Layout::from_size_align(len.max(1), 1).ok()
}

/// JS が入力フレームを書き込むための領域を確保する。確保できなければ null。
#[no_mangle]
pub extern "C" fn pkc_alloc(len: usize) -> *mut u8 {
    match layout(len) {
        Some(l) => unsafe { sys_alloc(l) },
        None => core::ptr::null_mut(),
    }
}

/// `pkc_alloc` で得た領域を返す(**確保時と同じ len を渡すこと**)。
///
/// # Safety
/// `ptr` は `pkc_alloc(len)` の戻り値でなければならない。
#[no_mangle]
pub unsafe extern "C" fn pkc_free(ptr: *mut u8, len: usize) {
    if let (false, Some(l)) = (ptr.is_null(), layout(len)) {
        sys_dealloc(ptr, l);
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
    let mut b = [0u8; 4];
    core::ptr::copy_nonoverlapping(ptr.add(size_of::<u32>()), b.as_mut_ptr(), 4);
    let len = u32::from_le_bytes(b) as usize;
    if let Some(l) = len.checked_add(RESULT_HEADER).and_then(layout) {
        sys_dealloc(ptr, l);
    }
}

/// 疎通と ABI 照合(橋が起動時に確かめる ── 古い .wasm を黙って使わない)。
#[no_mangle]
pub extern "C" fn pkc_abi_version() -> u32 {
    FRAME_VERSION
}

// ── フレーム読み出し(すべて checked。生ポインタは入口で 1 回だけ)──

struct Cursor<'a> {
    buf: &'a [u8],
    off: usize,
}

impl<'a> Cursor<'a> {
    fn u32(&mut self) -> Option<u32> {
        let end = self.off.checked_add(4)?;
        let b = self.buf.get(self.off..end)?;
        self.off = end;
        Some(u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    }
    fn bytes(&mut self, n: usize) -> Option<&'a [u8]> {
        let end = self.off.checked_add(n)?;
        let s = self.buf.get(self.off..end)?;
        self.off = end;
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
}

/// 行数(TS の `splitLines(x).length` と一致する)。
fn line_count(starts: &[usize], buf_len: usize) -> usize {
    let n = starts.len();
    if n == 0 {
        0
    } else if starts[n - 1] == buf_len {
        n - 1 // 末尾が改行 = 最後の要素は「行」ではない
    } else {
        n
    }
}

/// 1 段ぶんのパッチ適用。TS の `applyLinePatch` と同じ検査(全消費要求)を行う。
fn apply_patch(
    state: &[u8],
    starts: &mut Vec<usize>,
    cur: &mut Cursor<'_>,
    out: &mut Vec<u8>,
) -> u32 {
    let n_ops = match cur.u32() {
        Some(v) => v as usize,
        None => return ST_MALFORMED_FRAME,
    };
    line_starts(state, starts);
    let total = line_count(starts, state.len());

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
                let end = match i.checked_add(n) {
                    Some(v) if v <= total => v,
                    _ => return ST_COPY_OVERRUN,
                };
                // 連続行はまとめて 1 回で写す(行ごとの extend を避ける)
                let from = starts[i];
                let to = if end < starts.len() { starts[end] } else { state.len() };
                out.extend_from_slice(&state[from..to]);
                i = end;
            }
            OP_DELETE => {
                let n = match cur.u32() {
                    Some(v) => v as usize,
                    None => return ST_MALFORMED_FRAME,
                };
                i = match i.checked_add(n) {
                    Some(v) if v <= total => v,
                    _ => return ST_DELETE_OVERRUN,
                };
            }
            OP_INSERT => {
                // v2: 挿入行は**連結 1 本**で来る(出力は連結なので意味論は同一)
                let len = match cur.u32() {
                    Some(v) => v as usize,
                    None => return ST_MALFORMED_FRAME,
                };
                match cur.bytes(len) {
                    Some(b) => out.extend_from_slice(b),
                    None => return ST_MALFORMED_FRAME,
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
///   u32 version (= 2)
///   u32 n_steps
///   u32 tip_len ; [tip bytes]
///   n_steps 回:
///     u32 kind            (0 = full, 1 = patch)
///     kind==full  : u32 len ; [bytes]
///     kind==patch : u32 n_ops ; 各 op:
///                     u32 tag (0 copy / 1 delete / 2 insert)
///                     copy|delete: u32 count
///                     insert     : u32 byte_len ; [連結済み bytes]
/// ```
/// 戻り値は `[u32 status][u32 len][len bytes]`。**呼び出し側が `pkc_free_result`
/// で必ず解放する**(生成物のライフサイクル終端での即破棄 ── user 指示 2026-07-27)。
///
/// # Safety
/// `in_ptr` は `pkc_alloc(in_len)` で確保し、フレームを書き込んだ領域であること。
#[no_mangle]
pub unsafe extern "C" fn pkc_restore_chain(in_ptr: *const u8, in_len: usize) -> *mut u8 {
    // 🔒 生ポインタを触るのは**ここ 1 回だけ**。以後は安全なスライス操作
    if in_ptr.is_null() {
        return alloc_result(ST_MALFORMED_FRAME, &[]);
    }
    let buf = core::slice::from_raw_parts(in_ptr, in_len);
    restore_chain_impl(buf)
}

fn restore_chain_impl(buf: &[u8]) -> *mut u8 {
    let mut cur = Cursor { buf, off: 0 };
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
    let mut starts: Vec<usize> = Vec::new(); // 行頭索引も使い回す

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
                let st = apply_patch(&state, &mut starts, &mut cur, &mut scratch);
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
    drop(starts);
    alloc_result(ST_OK, &state)
}

fn alloc_result(status: u32, body: &[u8]) -> *mut u8 {
    let total = match body.len().checked_add(RESULT_HEADER) {
        Some(v) => v,
        None => return core::ptr::null_mut(),
    };
    let p = match layout(total) {
        Some(l) => unsafe { sys_alloc(l) },
        None => return core::ptr::null_mut(),
    };
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
