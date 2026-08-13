/** @vitest-environment node */
/**
 * 🔴 **調査ビルド(SAFE_HEAP)が配布 tag へ出ない**ことを縛る(#134)。
 *
 * `-sSAFE_HEAP=1` は全 load/store を検査するので、範囲外に触った**その瞬間**に
 * どのアドレスかが出る ── #134(ダイアログを閉じると `memory access out of bounds`、
 * 5/5 で再現)を自分で追うのに要る。⚠ 代わりに**実行が数倍遅くなる**。
 *
 * つまりこの仕掛けは「便利な調査 flag」ではなく、**取り違えると user の Office が
 * 使い物にならなくなる**もの。だから守り方は 2 段にしてある:
 *
 * 1. **tag を入力させない**(workflow で `safe_heap` から**導出**する)──
 *    「気をつける」ではなく**間違えられない形**にする
 * 2. patch script が **両方向**の後条件を持つ(頼まないのに入った / 頼んだのに
 *    入らなかった、のどちらでも異常終了する)
 *
 * ⚠ **1 は yaml なので、どの test からも実行されない** ── CLAUDE.md
 * 「どの test からも実行されない file に、判断を書かない」に真正面から当たる。
 * 取り出せないので**原文 pin で妥協する**が、**弱いと自覚して使う**。
 * 2 のほうは**本物を実行する**(python を起こして出力を読む)。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** ⚠ shell の cwd に依らせない(`office-pages-bundle.test.ts` で 4 件落とした)。 */
const PATCHER = fileURLToPath(
  new URL('../../build/office-wasm/patch-lo-memory.py', import.meta.url),
);
const WORKFLOW = fileURLToPath(
  new URL('../../.github/workflows/office-wasm-build.yml', import.meta.url),
);

const MK = 'solenv/gbuild/platform/EMSCRIPTEN_INTEL_GCC.mk';

/**
 * 上流 `EMSCRIPTEN_INTEL_GCC.mk` の該当箇所を再現した極小の fixture。
 * ⚠ 錨は**空白まで含めて**上流と同じにする ── ずれたら patch script が落ちるのが正しい。
 *
 * 🔴 **上流の注記行を必ず入れておく**(2026-08-13、これが無くて CI で踏んだ)。
 * `# avoid -s SAFE_HEAP=1 …` は上流 13 行目に**実在する**。初稿の fixture は
 * この行を持っていなかったので、「頼んでいないのに SAFE_HEAP が在る」と
 * 誤判定する検査が**緑のまま通り、普通の配布ビルドを全部止める**ところだった。
 * ⚠ **fixture に無い次元は、測っていない次元である**(CLAUDE.md)。
 */
const UPSTREAM = [
  '# avoid -s SAFE_HEAP=1 - c.f. gh#8584 this breaks source maps',
  'gb_EMSCRIPTEN_LDFLAGS += -s TOTAL_MEMORY=1GB',
  'gb_EMSCRIPTEN_LDFLAGS += -sSTACK_SIZE=131072 -sDEFAULT_PTHREAD_STACK_SIZE=65536',
  'gb_EMSCRIPTEN_LDFLAGS += -sEXPORTED_RUNTIME_METHODS=\'["ClassHandle","HEAPU16","HEAPU32"]\'',
  'ifeq ($(ENABLE_EMSCRIPTEN_PROXY_TO_PTHREAD),)',
  'gb_EMSCRIPTEN_LDFLAGS += -sPTHREAD_POOL_SIZE=7',
  'endif',
  '',
].join('\n');

const made: string[] = [];
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Run {
  readonly status: number;
  readonly stderr: string;
  /** 書き換わった makefile。⚠ **落ちたときは書かれていない**ので原文が返る。 */
  readonly mk: string;
}

function patch(env: Record<string, string>, upstream = UPSTREAM): Run {
  const root = mkdtempSync(join(tmpdir(), 'pkc3-lo-'));
  made.push(root);
  mkdirSync(join(root, 'solenv/gbuild/platform'), { recursive: true });
  writeFileSync(join(root, MK), upstream);
  let status = 0;
  let stderr = '';
  try {
    execFileSync('python3', [PATCHER, root], {
      stdio: 'pipe',
      env: { ...process.env, PKC3_SAFE_HEAP: '', ...env },
    });
  } catch (e) {
    const err = e as { status?: number; stderr?: Buffer };
    status = err.status ?? 1;
    stderr = err.stderr?.toString() ?? '';
  }
  return { status, stderr, mk: readFileSync(join(root, MK), 'utf-8') };
}

describe('🔴 SAFE_HEAP は頼んだときだけ入る', () => {
  it('頼まなければ入らない(= 配布物は素のまま)', () => {
    const r = patch({});
    expect(r.status, r.stderr).toBe(0);
    // ⚠ **file 全体で探さない** ── 上流に `# avoid -s SAFE_HEAP=1 …` の注記が在る。
    //    見るのは**自分が書いた行**である(全文で見た初稿は配布ビルドを全部止めた)
    const line = r.mk.split('\n').find((l) => l.includes('INITIAL_MEMORY=1GB'));
    expect(line).not.toContain('SAFE_HEAP');
    // 🔑 上流の注記は**残っている**こと(fixture がその次元を持つ証拠 = 空振り防止)
    expect(r.mk, 'fixture が上流の注記行を失っている').toContain('avoid -s SAFE_HEAP=1');
    // ⚠ 空振り防止 ── 「何も置換していないから SAFE_HEAP も無い」で通らせない
    expect(r.mk).toContain('ALLOW_MEMORY_GROWTH=1');
    expect(r.mk).toContain('PTHREAD_POOL_SIZE=16');
    expect(r.mk).toContain('"HEAPU8"');
  });

  it('明示的な 0 でも入らない(空文字と 0 を取り違えない)', () => {
    const r = patch({ PKC3_SAFE_HEAP: '0' });
    expect(r.status, r.stderr).toBe(0);
    const line = r.mk.split('\n').find((l) => l.includes('INITIAL_MEMORY=1GB'));
    expect(line).not.toContain('SAFE_HEAP');
  });

  /**
   * 🔴 **これが CI で落ちた回の回帰 test である**(2026-08-13)。
   * 上流の注記行を後条件が拾ってしまい、**頼んでいない回が異常終了**した ──
   * つまり **`lo-wasm-dev`(配布)を焼くたびに落ちる**状態だった。
   * ⚠ 「両方向を検めている」と書いた検査が、**片方向でしか走っていなかった**
   * (調査ビルドは `=1` なので通ってしまう)。
   */
  it('🔴 上流の注記に釣られない ── 名前つきだけ頼んだ回が通る', () => {
    const r = patch({ PKC3_SAFE_HEAP: '0', PKC3_PROFILING_FUNCS: '1' });
    expect(r.status, r.stderr).toBe(0);
    const line = r.mk.split('\n').find((l) => l.includes('INITIAL_MEMORY=1GB'));
    expect(line).toContain('--profiling-funcs');
    expect(line).not.toContain('SAFE_HEAP');
  });

  it('🔴 名前を残す指示も、頼んだときだけ入る(#134 の 2 本目)', () => {
    // ⚠ SAFE_HEAP とは**別の軸**である ── 片方だけ頼めること自体を pin する
    const off = patch({});
    expect(off.mk).not.toContain('--profiling-funcs');
    expect(off.status, off.stderr).toBe(0);
    const on = patch({ PKC3_PROFILING_FUNCS: '1' });
    expect(on.status, on.stderr).toBe(0);
    const line = on.mk.split('\n').find((l) => l.includes('INITIAL_MEMORY=1GB'));
    expect(line).toContain('--profiling-funcs');
    expect(line, '頼んでいない SAFE_HEAP が混ざっている').not.toContain('SAFE_HEAP');
  });

  it('2 つ同時に頼める(調査は組み合わせで効く)', () => {
    const r = patch({ PKC3_SAFE_HEAP: '1', PKC3_PROFILING_FUNCS: '1' });
    expect(r.status, r.stderr).toBe(0);
    const line = r.mk.split('\n').find((l) => l.includes('INITIAL_MEMORY=1GB'));
    expect(line).toContain('-s SAFE_HEAP=1');
    expect(line).toContain('--profiling-funcs');
  });

  it('PKC3_SAFE_HEAP=1 のときだけ、メモリの行に足される', () => {
    const r = patch({ PKC3_SAFE_HEAP: '1' });
    expect(r.status, r.stderr).toBe(0);
    // 🔑 **同じ行**に在ること ── 別の行に足すと変数の代入順で消えることがある
    const line = r.mk.split('\n').find((l) => l.includes('INITIAL_MEMORY=1GB'));
    expect(line).toContain('-s SAFE_HEAP=1');
    // 素のときの中身も全部揃っている(調査ビルドだけ別物にしない)
    expect(r.mk).toContain('ALLOW_MEMORY_GROWTH=1');
    expect(r.mk).toContain('PTHREAD_POOL_SIZE=16');
  });

  it('⚠ 錨が消えたら異常終了する(黙って素通りしない)', () => {
    const r = patch({}, 'nothing to see here\n');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('TOTAL_MEMORY=1GB');
    expect(r.mk, '落ちたのに書き換えている').toBe('nothing to see here\n');
  });
});

/**
 * 🔴 **導出であって、入力ではない。**
 * ⚠ コメントを落としてから当てる ── 説明コメントに `lo-wasm-dev` や
 * `SAFE_HEAP` の字が**そのまま書いてある**ので、素の本文に `toContain` を
 * 当てると**説明文に救われる**(`release-meta.test.ts` で 2 件生き残った実績)。
 */
function stripComments(yaml: string): string {
  return yaml.replace(/^\s*#.*$/gm, '');
}

describe('🔴 workflow が配布 tag を守る', () => {
  const wf = stripComments(readFileSync(WORKFLOW, 'utf-8'));

  /** `workflow_dispatch.inputs:` から次の top-level key(`jobs:` 等)まで。 */
  function inputsBlock(): string {
    const at = wf.indexOf('    inputs:');
    expect(at, 'workflow_dispatch.inputs が見つからない').toBeGreaterThan(-1);
    const rest = wf.slice(at);
    const end = rest.search(/\n[a-z]/);
    return end < 0 ? rest : rest.slice(0, end);
  }

  it('🔴 tag を入力させない(調査ビルドを配布 tag へ出せる穴を作らない)', () => {
    expect(inputsBlock()).not.toMatch(/^ {6}tag:/m);
  });

  it('safe_heap は boolean で、既定は false', () => {
    const block = inputsBlock();
    expect(block).toContain('safe_heap:');
    const safe = block.slice(block.indexOf('safe_heap:'));
    expect(safe).toMatch(/type:\s*boolean/);
    expect(safe).toMatch(/default:\s*false/);
  });

  it('🔴 接尾辞は入力から組まれる(字を直書きしない)', () => {
    // ⚠ 「`-safeheap` の字が在る」だけでは、死に行でも通る ── **組み立ての行**を見る
    const at = wf.indexOf('SAFE_SUFFIX="${SAFE_SUFFIX}-safeheap"');
    expect(at, '接尾辞を safe_heap から組んでいない').toBeGreaterThan(-1);
    expect(wf.slice(Math.max(0, at - 120), at)).toContain('inputs.safe_heap');
    const at2 = wf.indexOf('SAFE_SUFFIX="${SAFE_SUFFIX}-names"');
    expect(at2, '接尾辞を profiling_funcs から組んでいない').toBeGreaterThan(-1);
    expect(wf.slice(Math.max(0, at2 - 120), at2)).toContain('inputs.profiling_funcs');
  });

  it('🔴 patch step が PKC3_SAFE_HEAP を同じ入力から導く', () => {
    const at = wf.indexOf('export PKC3_SAFE_HEAP=1');
    expect(at, 'PKC3_SAFE_HEAP を渡していない').toBeGreaterThan(-1);
    expect(wf.slice(Math.max(0, at - 200), at)).toContain('inputs.safe_heap');
    expect(wf).toContain('export PKC3_SAFE_HEAP=0');
    // ⚠ `[ … ] && echo 1 || echo 0` は書かない(CLAUDE.md: 同順位・左結合)
    expect(wf).not.toMatch(/PKC3_SAFE_HEAP=\$\(\[/);
  });

  it('調査ビルドは版の字面で見分けが付く', () => {
    expect(wf).toContain('-safeheap');
    expect(wf).toContain('-names');
    expect(wf).toContain('${SAFE_SUFFIX}');
  });

  it('🔴 名前つきビルドも同じ入力から導かれ、tag を汚さない', () => {
    const block = inputsBlock();
    expect(block).toContain('profiling_funcs:');
    const pf = block.slice(block.indexOf('profiling_funcs:'));
    expect(pf).toMatch(/type:\s*boolean/);
    expect(pf).toMatch(/default:\s*false/);
    // patch step が同じ入力から導く
    const at = wf.indexOf('export PKC3_PROFILING_FUNCS=1');
    expect(at, 'PKC3_PROFILING_FUNCS を渡していない').toBeGreaterThan(-1);
    expect(wf.slice(Math.max(0, at - 200), at)).toContain('inputs.profiling_funcs');
    expect(wf).toContain('export PKC3_PROFILING_FUNCS=0');
  });

  /**
   * 🔴 **tag と版を、同じ 1 つの接尾辞から導く。**
   * ⚠ 2 か所で組み立てると「版は素なのに tag は調査用」がいつか起きる ──
   *   そうなると、どの一式を見ているか**版で確かめられなくなる**。
   */
  it('🔴 tag は接尾辞から導く(素のときだけ配布 tag)', () => {
    expect(wf).toContain('tag="lo-wasm${SAFE_SUFFIX}"');
    expect(wf).toContain('tag=lo-wasm-dev');
    const at = wf.indexOf('tag="lo-wasm${SAFE_SUFFIX}"');
    // 接尾辞が空のときだけ配布 tag へ落ちる
    expect(wf.slice(Math.max(0, at - 200), at)).toContain('-n "$SAFE_SUFFIX"');
  });
});
