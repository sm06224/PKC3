/** @vitest-environment node */
/**
 * `build/office-wasm/qtbase-patch-wake-async.py` を検める(#1408)。
 *
 * ## 何を直すか
 *
 * main が SolarMutex を futex の busy-wait で待つと JS のイベントループが止まる。そのとき持ち主(別スレッド)が
 * `QEventDispatcherWasm::wakeEventDispatcherThread()` の `runOnMainThread`(= `proxySync`、main の mailbox を待つ)に入ると
 * 双方が永久に待つ。Qt 6.10 も別スレッドからの起こしは非同期なので、**別スレッドからは `runOnMainThreadAsync`**、main 自身は従来どおり同期にする。
 *
 * ## ⚠ ここで検められること / 検められないこと
 *
 * 🔴 **compile も実行もできない**(emsdk も Qt ツリーもこの箱に無い。焼きで見る)。
 *
 * | 見る | 見ない |
 * |---|---|
 * | 当たる(1 件・足した行は全部印つき・非 main の枝が Async)/ 足した行の外は 1 バイトも動かない | その C++ がコンパイルできるか |
 * | 2 度目は SKIP / 錨が無ければ exit 1 で file 不変 | 実機で固まりが消えるか(焼いた一式の probe) |
 * | 🔑 **順番の依存**:asyncify-nested を当てていない素の原文には当たらない | |
 *
 * 🔑 当たる順は glob(アルファベット順)で `asyncify-nested` → `wake-async`。この test もその順で当てる。
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const NESTED = 'build/office-wasm/qtbase-patch-asyncify-nested.py';
const SCRIPT = 'build/office-wasm/qtbase-patch-wake-async.py';
const REL = 'src/corelib/kernel/qeventdispatcher_wasm.cpp';
const MARK = 'PKC3-WAKEASYNC';
/** 🔴 上流 Qt 6.9 の**原文の全文**(要約しない ── 錨は字面で当たる)。 */
const FIXTURE = 'tests/fixtures/qtbase/qeventdispatcher_wasm.cpp';
const ORIG = readFileSync(FIXTURE, 'utf-8');

const SYNC = '    runOnMainThread([]() { qt_asyncify_resume(); });';

function tree(text: string = ORIG): { dir: string; read(): string } {
  const dir = mkdtempSync(join(tmpdir(), 'pkc3-qt-wakeasync-'));
  const file = join(dir, REL);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text, 'utf-8');
  return { dir, read: () => readFileSync(file, 'utf-8') };
}

/** patch を回す。⚠ **落ちても投げない**(exit を検めたいので自分で拾う)。 */
function run(script: string, dir: string): { code: number; out: string } {
  try {
    const out = execFileSync('python3', [script, dir], { encoding: 'utf-8', stdio: 'pipe' });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? -1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

function count(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

/** 原文に asyncify-nested を当てた後の姿(wake-async が当たる先)と、その上に wake-async を当てた姿。 */
const { NESTED_TEXT, PATCHED } = (() => {
  const t = tree();
  try {
    const a = run(NESTED, t.dir);
    if (a.code !== 0) throw new Error(`asyncify-nested が原文に当たらない: ${a.out}`);
    const nested = t.read();
    const b = run(SCRIPT, t.dir);
    if (b.code !== 0) throw new Error(`wake-async が asyncify-nested の後に当たらない: ${b.out}`);
    return { NESTED_TEXT: nested, PATCHED: t.read() };
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
})();

describe('#1408 の直し(wake-async)── 当て方', () => {
  it('🔑 前提:原文に印は無く、wake の同期の 1 行が 1 件・<emscripten/threading.h> は既に include されている', () => {
    expect(count(ORIG, MARK)).toBe(0);
    expect(count(NESTED_TEXT, MARK)).toBe(0);
    expect(count(NESTED_TEXT, SYNC + '\n')).toBe(1);
    // include を足す必要が無い(足すなら足す行にも印が要る)── 前提が崩れたらここで落ちる
    expect(ORIG).toContain('#include <emscripten/threading.h>');
    expect(count(ORIG, 'runOnMainThreadAsync('), 'runOnMainThreadAsync は同じ class に在る').toBeGreaterThan(1);
  });

  it('🔴 ① 当たり、wakeEventDispatcherThread の中で、main は同期・非 main は Async になる(同期の 1 行は非 main の枝に残らない)', () => {
    const lines = PATCHED.split('\n');
    const fn = lines.findIndex((l) => l.startsWith('bool QEventDispatcherWasm::wakeEventDispatcherThread()'));
    expect(fn, '関数が見つからない').toBeGreaterThan(-1);
    const end = lines.findIndex((l, i) => i > fn && l === '}');
    const body = lines.slice(fn, end + 1);
    // 🔑 コメントは落として、実行する行だけで見る(解説の字に満たされない)
    const code = body.filter((l) => !l.trimStart().startsWith('//'));
    const at = (needle: string): number => code.findIndex((l) => l.includes(needle));
    const iDepth = at('if (g_asyncify_suspend_depth == 0)');
    const iMain = at('if (emscripten_is_main_runtime_thread()) // ' + MARK);
    const iSync = at('runOnMainThread([]() { qt_asyncify_resume(); });');
    const iElse = at('else // ' + MARK);
    const iAsync = at('runOnMainThreadAsync([]() { qt_asyncify_resume(); });');
    expect(iDepth, '深さの門が無い').toBeGreaterThan(-1);
    // 並び:深さの門 → if (main) → 同期 → else → Async(行ごとの順)
    expect([iDepth, iMain, iSync, iElse, iAsync].every((x, k, a) => x > -1 && (k === 0 || x > a[k - 1]!))).toBe(true);
    // 同期の呼び出しは 1 件だけで、main の枝(印つき)。Async は 1 件だけで else の枝
    expect(code.filter((l) => l.includes('runOnMainThread([]() { qt_asyncify_resume(); });'))).toEqual([
      '        runOnMainThread([]() { qt_asyncify_resume(); }); // ' + MARK,
    ]);
    expect(code.filter((l) => l.includes('runOnMainThreadAsync('))).toEqual([
      '        runOnMainThreadAsync([]() { qt_asyncify_resume(); }); // ' + MARK,
    ]);
    // 関数の外(全体)にも、印の無い同期の呼び出しが残っていない
    const unmarked = lines.filter((l) => l.includes('runOnMainThread([]() { qt_asyncify_resume(); });') && !l.includes(MARK));
    expect(unmarked, '印の無い同期の resume が残っている').toEqual([]);
  });

  it('🔴 ⑤ 足した行は全部印つきで、足した行(と置き換わった 1 行)の外は 1 バイトも変わらない', () => {
    const marked = PATCHED.split('\n').filter((l) => l.includes(MARK));
    expect(marked.length, '足した行が 7 行ではない').toBe(7);
    // 印を持つ行を全部落とし、asyncify-nested の後の姿から同期の 1 行だけを引くと、残りは同じ
    const rest = PATCHED.split('\n').filter((l) => !l.includes(MARK)).join('\n');
    const expected = NESTED_TEXT.replace(SYNC + '\n', '');
    expect(expected, '変異が当たっていない').not.toBe(NESTED_TEXT);
    expect(rest, '足した行の外が動いている').toBe(expected);
  });

  it('⚠ ② 2 度当てると SKIP で、file は 1 バイトも変わらない', () => {
    const t = tree(PATCHED);
    try {
      const again = run(SCRIPT, t.dir);
      expect(again.code, `2 度目が落ちた: ${again.out}`).toBe(0);
      expect(again.out, 'SKIP と言っていない').toContain('SKIP');
      expect(t.read(), '2 度目で字が変わった').toBe(PATCHED);
    } finally {
      rmSync(t.dir, { recursive: true, force: true });
    }
  });

  it('🔴 ③ 錨が無い入力(asyncify-nested の後で、wake の 1 行を壊した)は exit 1 で、file は不変', () => {
    const broken = NESTED_TEXT.replace(SYNC, SYNC.replace('runOnMainThread', 'runOnMainThreadX'));
    expect(broken, '変異が当たっていない').not.toBe(NESTED_TEXT);
    const t = tree(broken);
    try {
      const r = run(SCRIPT, t.dir);
      expect(r.code, '錨が無いのに通った').toBe(1);
      expect(r.out, '何が食い違ったか言っていない').toContain('錨が 0 件');
      expect(t.read(), '落ちたのに file が動いた').toBe(broken);
    } finally {
      rmSync(t.dir, { recursive: true, force: true });
    }
  });

  it('🔴 ③b 錨が 2 件になっても落ちる(一意でない錨で黙って直さない)', () => {
    const at = NESTED_TEXT.indexOf('    if (g_asyncify_suspend_depth == 0) // PKC3-ASYNCNEST(#1344)\n        return false;\n' + SYNC + '\n');
    expect(at, 'fixture から錨を引けない').toBeGreaterThan(-1);
    const block = '    if (g_asyncify_suspend_depth == 0) // PKC3-ASYNCNEST(#1344)\n        return false;\n' + SYNC + '\n';
    const dup = `${NESTED_TEXT}\n${block}`;
    const t = tree(dup);
    try {
      const r = run(SCRIPT, t.dir);
      expect(r.code).toBe(1);
      expect(r.out).toContain('錨が 2 件');
      expect(t.read(), '落ちたのに file が動いた').toBe(dup);
    } finally {
      rmSync(t.dir, { recursive: true, force: true });
    }
  });

  /**
   * 🔴 **④ 順番の依存を pin する** ── 素の原文にも同期の 1 行は 1 件在るので、錨が 1 行だと
   * asyncify-nested より先に走っても当たってしまい、後から来た asyncify-nested の錨(`if (!g_is_asyncify_suspended)` と
   * その次の行)を壊す。錨は asyncify-nested が書いた 3 行なので、素の原文には**当たらない**。
   */
  it('🔴 ④ asyncify-nested を当てていない素の原文には当たらない(exit 1・file 不変)', () => {
    expect(count(ORIG, SYNC + '\n'), '素の原文にも同期の 1 行は在る(だから 1 行の錨では順番を守れない)').toBe(1);
    const t = tree();
    try {
      const r = run(SCRIPT, t.dir);
      expect(r.code, '素の原文に当たってしまった').toBe(1);
      expect(r.out).toContain('錨が 0 件');
      expect(t.read(), '落ちたのに file が動いた').toBe(ORIG);
    } finally {
      rmSync(t.dir, { recursive: true, force: true });
    }
  });

  it('引数が違えば usage を出して 2 で落ちる(既存の qtbase patch と同じ形)', () => {
    let status = 0;
    let err = '';
    try {
      execFileSync('python3', [SCRIPT], { encoding: 'utf-8', stdio: 'pipe' });
    } catch (e) {
      const x = e as { status?: number; stderr?: string };
      status = x.status ?? -1;
      err = x.stderr ?? '';
    }
    expect(status).toBe(2);
    expect(err).toContain('usage');
  });

  it('⚠ 制御文字・見えない字(BOM / ゼロ幅 / NBSP)が入っていない', () => {
    for (const f of [PATCHED, readFileSync(SCRIPT, 'utf-8')]) {
      const bad = [...f].filter((c) => {
        const n = c.codePointAt(0)!;
        return (
          n <= 0x08 || n === 0x0b || n === 0x0c || (n >= 0x0e && n <= 0x1f) ||
          n === 0xfeff || (n >= 0x200b && n <= 0x200d) || n === 0x2060 || n === 0xa0
        );
      });
      expect(bad).toEqual([]);
    }
  });
});
