/** @vitest-environment node */
/**
 * `build/office-wasm/qtbase-patch-asyncify-nested.py` を検める(#1344 の Qt 側の直し)。
 *
 * ## 何を直すか
 *
 * Qt 6.9 の `qeventdispatcher_wasm.cpp` は suspend の resolver を **1 枠**
 * (`Module.qtAsyncifyWakeUp`)に置き、resume の `setTimeout` は発火時に
 * **`Module.qtSuspendId !== suspendId` なら起こさずに捨てる**。C++ 側の
 * `g_is_asyncify_suspended` は **1 bit** で、resume を**予約した時点で**落ちる。
 * JSPI では、予約の直後に `QMenu::exec` の入れ子 `processEvents` が suspend できてしまい、
 * 予約していた起こしが**外側の frame の resolver を捨てる** → 外側が二度と戻らない。
 *
 * ## ⚠ ここで検められること / 検められないこと
 *
 * | 見る | 見ない |
 * |---|---|
 * | 錨が 1 件ずつ当たる / 二重当ては落ちて file 不変 | 🔴 **Qt 全体のコンパイル**(Qt の header が無い。焼きで見る) |
 * | 原文の削除は 1 枠・1 bit の周りだけ / 足した行は全部印つき | 実機で外側の `processEvents` が戻るか(焼いた一式の probe) |
 * | 🔑 **JS の挙動を node で実走**(原文を対照群に) | |
 * | 🔑 C++ の 2 関数を**取り出して g++ で動かす**(stub の上で) | |
 */
import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const SCRIPT = 'build/office-wasm/qtbase-patch-asyncify-nested.py';
const REL = 'src/corelib/kernel/qeventdispatcher_wasm.cpp';
const MARK = 'PKC3-ASYNCNEST';
/** 🔴 上流 Qt 6.9 の**原文の全文**(要約しない ── 錨は字面で当たる)。 */
const FIXTURE = 'tests/fixtures/qtbase/qeventdispatcher_wasm.cpp';
const ORIG = readFileSync(FIXTURE, 'utf-8');
const OLD_NAME = 'g_is_asyncify_suspended';

function tree(text: string = ORIG): { dir: string; file: string; read(): string } {
  const dir = mkdtempSync(join(tmpdir(), 'pkc3-qt-asyncnest-'));
  const file = join(dir, REL);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text, 'utf-8');
  return { dir, file, read: () => readFileSync(file, 'utf-8') };
}

/** patch を回す。⚠ **落ちても投げない**(exit を検めたいので自分で拾う)。 */
function run(dir: string): { code: number; out: string } {
  try {
    const out = execFileSync('python3', [SCRIPT, dir], { encoding: 'utf-8', stdio: 'pipe' });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? -1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

/** 原文に当てた結果(1 度だけ作って使い回す。⚠ 変異は別の tree で行う)。 */
const PATCHED = (() => {
  const t = tree();
  try {
    const r = run(t.dir);
    if (r.code !== 0) throw new Error(`原文に当たらない: ${r.out}`);
    return t.read();
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
})();

describe('#1344 の直し(asyncify-nested)── 当て方', () => {
  it('🔴 原文に当たり、1 枠・1 bit が消えて Map と深さの数が入る', () => {
    expect(PATCHED).toContain('Module.qtAsyncifyWakeUps.set(id, resolve);');
    expect(PATCHED).toContain('static int g_asyncify_suspend_depth = 0;');
    // 1 枠は消え、`...WakeUps`(複数形)だけが残る(⚠ 単数形の字は複数形の前半ではない)
    expect(PATCHED).not.toMatch(/qtAsyncifyWakeUp\b/);
    expect(PATCHED).not.toMatch(/qtSuspendId\s*!==/);
    // 1 bit の読み手が**コードに**残っていない(注釈は数えない)
    const readers = PATCHED.split('\n').filter((l) => l.includes(OLD_NAME) && !l.trimStart().startsWith('//'));
    expect(readers).toEqual([]);
  });

  it('⚠ 2 度当てると落ち、file は 1 バイトも変わらない', () => {
    const t = tree();
    try {
      expect(run(t.dir).code).toBe(0);
      const once = t.read();
      const again = run(t.dir);
      expect(again.code, '2 度目が通った').toBe(1);
      expect(again.out).toContain('既に当たっている');
      expect(t.read(), '2 度目で file が動いた').toBe(once);
    } finally {
      rmSync(t.dir, { recursive: true, force: true });
    }
  });

  /**
   * 🔴 **錨が 1 件ずつ当たる** ── 5 つの錨それぞれを**原文から消した** tree を作り、
   * そのたびに落ちる(「錨が」と言う)ことと、**file が 1 バイトも動かない**ことを見る。
   * ⚠ 錨が 1 つでも黙って素通りすると、**直っていない一式を「直った」と思って焼く**。
   */
  it.each([
    ['変数', 'static bool g_is_asyncify_suspended = false;\n'],
    ['JS(1 枠)', '        Module.qtAsyncifyWakeUp = resolve;\n'],
    ['suspend', '    g_is_asyncify_suspended = true;\n'],
    ['resume', '    g_is_asyncify_suspended = false;\n'],
    ['wake', '    runOnMainThread([]() { qt_asyncify_resume(); });\n'],
  ])('🔴 錨「%s」が無ければ落ちる(file は不変)', (_name, line) => {
    expect(ORIG.split(line).length - 1, `fixture に ${line.trim()} が 1 件ずつ在ること`).toBe(1);
    const broken = ORIG.replace(line, line.replace(/\w/, 'X'));
    const t = tree(broken);
    try {
      const r = run(t.dir);
      expect(r.code, '錨が無いのに通った').not.toBe(0);
      expect(r.out, '何が食い違ったか言っていない').toContain('錨が');
      expect(t.read(), '落ちたのに file が動いた').toBe(broken);
    } finally {
      rmSync(t.dir, { recursive: true, force: true });
    }
  });

  it('🔴 錨が 2 件に増えても落ちる(一意でない錨で当てない)', () => {
    const line = '    runOnMainThread([]() { qt_asyncify_resume(); });\n';
    const dup = ORIG.replace(
      'bool QEventDispatcherWasm::wakeEventDispatcherThread()',
      `// ↓ 上流が同じ形を足した\n    if (!${OLD_NAME})\n        return false;\n${line}\nbool QEventDispatcherWasm::wakeEventDispatcherThread()`,
    );
    const t = tree(dup);
    try {
      const r = run(t.dir);
      expect(r.code).not.toBe(0);
      expect(r.out).toContain('錨が 2 件');
      expect(t.read()).toBe(dup);
    } finally {
      rmSync(t.dir, { recursive: true, force: true });
    }
  });

  it('🔴 錨に載っていない 1 bit の読み手が足されていたら落ちる(file は不変)', () => {
    const extra = `${ORIG}\nstatic bool pkc3Probe() { return ${OLD_NAME}; }\n`;
    const t = tree(extra);
    try {
      const r = run(t.dir);
      expect(r.code).not.toBe(0);
      expect(r.out).toContain('読み手が残っている');
      expect(t.read()).toBe(extra);
    } finally {
      rmSync(t.dir, { recursive: true, force: true });
    }
  });
});

/** `diff -U0` の結果を、原文の行番号つきで読む。 */
function diffU0(a: string, b: string): { removed: { n: number; text: string }[]; added: string[] } {
  const dir = mkdtempSync(join(tmpdir(), 'pkc3-qt-asyncnest-diff-'));
  try {
    writeFileSync(join(dir, 'a'), a, 'utf-8');
    writeFileSync(join(dir, 'b'), b, 'utf-8');
    const r = spawnSync('diff', ['-U0', join(dir, 'a'), join(dir, 'b')], { encoding: 'utf-8', stdio: 'pipe' });
    const removed: { n: number; text: string }[] = [];
    const added: string[] = [];
    let old = 0;
    for (const l of r.stdout.split('\n')) {
      const h = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/.exec(l);
      if (h) {
        // `-U0` の「削除 0 行」は開始が 1 つ手前を指す(+1 して次の行から数える)
        old = Number(h[1]) + (h[2] === '0' ? 1 : 0);
        continue;
      }
      if (l.startsWith('---') || l.startsWith('+++')) continue;
      if (l.startsWith('-')) removed.push({ n: old++, text: l.slice(1) });
      else if (l.startsWith('+')) added.push(l.slice(1));
    }
    return { removed, added };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('#1344 の直し(asyncify-nested)── 原文との差', () => {
  const d = diffU0(ORIG, PATCHED);
  const origLines = ORIG.split('\n');
  const jsFrom = origLines.findIndex((l) => l.startsWith('EM_ASYNC_JS(void, qt_asyncify_suspend_js')) + 1;
  const jsTo = origLines.findIndex((l) => l.includes('// clang-format on')) + 1;

  it('🔴 足した行・変えた行は、全部印を含む(印の無い足し行が 0)', () => {
    expect(d.added.length, '空振り防止: 足した行が 0 件').toBeGreaterThan(10);
    expect(d.added.filter((l) => !l.includes(MARK))).toEqual([]);
  });

  it('🔴 消えた原文の行は、1 枠の JS(`qtAsyncifyWakeUp` 周り)と 1 bit(`g_is_asyncify_suspended`)の周りだけ', () => {
    expect(jsFrom > 0 && jsTo > jsFrom, 'fixture から JS の区間を引けない').toBe(true);
    expect(d.removed.length, '空振り防止: 消えた行が 0 件').toBeGreaterThan(8);
    const outside = d.removed.filter((r) => !(r.n >= jsFrom && r.n <= jsTo) && !r.text.includes(OLD_NAME));
    expect(outside, '1 枠 / 1 bit の外の原文が消えている').toEqual([]);
    // 1 枠の字を持つ行・1 bit の字を持つ行は、原文の全部が消えている(取り残しが無い)
    const mustGo = origLines.map((t, i) => ({ n: i + 1, t })).filter((x) => x.t.includes('qtAsyncifyWakeUp') || x.t.includes(OLD_NAME));
    expect(mustGo.length, '空振り防止').toBeGreaterThan(8);
    const removedNs = new Set(d.removed.map((r) => r.n));
    expect(mustGo.filter((x) => !removedNs.has(x.n) && !x.t.trimStart().startsWith('//'))).toEqual([]);
  });

  it('🔴 それ以外の原文は 1 バイトも変わらない(消えた行を戻すと、足した行の外は原文と一致する)', () => {
    // 原文から「消えた行の範囲」を除いた行が、当てた後の file に**順序どおり**残っている
    const gone = new Set(d.removed.map((r) => r.n));
    const kept = origLines.filter((_, i) => !gone.has(i + 1));
    const patchedLines = PATCHED.split('\n');
    let at = 0;
    for (const l of kept) {
      const found = patchedLines.indexOf(l, at);
      expect(found, `原文の行が順序どおりに残っていない: ${l.slice(0, 60)}`).toBeGreaterThanOrEqual(0);
      at = found + 1;
    }
  });

  it('🔴 `#else`(QT_STATIC でない側の stub)は 1 バイトも変わらない', () => {
    const stub = (t: string): string => {
      const a = t.indexOf('#else\n\n// EM_JS is not supported for side modules');
      const b = t.indexOf('#endif // defined(QT_STATIC)');
      expect(a > -1 && b > a, 'stub の区間を引けない').toBe(true);
      return t.slice(a, b);
    };
    const s = stub(ORIG);
    expect(s).toContain('Q_UNREACHABLE()');
    expect(stub(PATCHED)).toBe(s);
  });

  it('⚠ 制御文字・見えない字(BOM / ゼロ幅 / NBSP)が入っていない', () => {
    for (const f of [PATCHED, readFileSync(SCRIPT, 'utf-8')]) {
      // 範囲は**字の種類**で決める(制御文字だけだと BOM / ゼロ幅が残る)
      // 字の値で見る(正規表現に生字を書かない)
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

/**
 * 🔑 **JS の挙動の実走**。patch 後の file から `EM_ASYNC_JS` / `EM_JS` の本体を抜き出し、
 * `Module` と `setTimeout` を偽物にして走らせる。**原文の JS にも同じ harness を回し、
 * 「入れ子のとき捨てられる」ことを対照群として見る**(見えないなら、harness が捨てを再現していない)。
 */
describe('#1344 の直し(asyncify-nested)── JS を node で実走する', () => {
  type Mod = Record<string, unknown>;

  function bodyOf(text: string, head: string): string {
    const a = text.indexOf(head);
    expect(a, `${head} が見つからない`).toBeGreaterThan(-1);
    const start = text.indexOf('\n', a) + 1;
    const end = text.indexOf('\n});', start);
    expect(end).toBeGreaterThan(start);
    return text.slice(start, end);
  }

  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (...a: string[]) => (...a: unknown[]) => Promise<void>;

  function harness(src: string) {
    const suspendBody = bodyOf(src, 'EM_ASYNC_JS(void, qt_asyncify_suspend_js, (), {');
    const resumeBody = bodyOf(src, 'EM_JS(void, qt_asyncify_resume_js, (), {');
    const Module: Mod = {};
    const timers: (() => void)[] = [];
    const fakeSetTimeout = (fn: () => void): number => timers.push(fn);
    const suspendFn = new AsyncFunction('Module', suspendBody);
    const resumeFn = new Function('Module', 'setTimeout', resumeBody) as (m: Mod, st: typeof fakeSetTimeout) => void;
    const woke: string[] = [];
    return {
      woke,
      timers,
      /** 名前を付けて suspend する(戻ってきたら `woke` へ積む)。 */
      suspend(name: string): void {
        void suspendFn(Module).then(() => {
          woke.push(name);
        });
      },
      resume: (): void => resumeFn(Module, fakeSetTimeout),
      /** 置かれた timer を全部発火させる(= `setTimeout(0)` が回った)。 */
      fire(): void {
        for (const t of timers.splice(0)) t();
      },
      /** promise の後続を回し切る。 */
      async flush(): Promise<void> {
        for (let i = 0; i < 5; i++) await Promise.resolve();
      },
    };
  }

  for (const [label, src] of [
    ['原文(対照群)', ORIG],
    ['patch 後', PATCHED],
  ] as const) {
    it(`① ${label}: 入れ子でない普段の経路 ── 1 回 suspend → resume → timer 発火で、その 1 つが起きる`, async () => {
      const h = harness(src);
      h.suspend('A');
      await h.flush();
      expect(h.woke).toEqual([]);
      h.resume();
      await h.flush();
      expect(h.woke, 'timer が回る前に起きている(setTimeout が無い)').toEqual([]);
      expect(h.timers.length).toBe(1);
      h.fire();
      await h.flush();
      expect(h.woke).toEqual(['A']);
    });
  }

  it('🔴 ② 原文(対照群): 入れ子 ── resume を予約した後に 2 つ目が suspend すると、1 つ目の起こしは**捨てられる**', async () => {
    const h = harness(ORIG);
    h.suspend('A');
    await h.flush();
    h.resume(); // A の起こしを予約
    h.suspend('B'); // 予約の後、timer が回る前に入れ子 suspend
    await h.flush();
    h.fire();
    await h.flush();
    expect(h.woke, '原文でも起きている ── harness が「捨て」を再現していない').toEqual([]);
    h.resume(); // B の分
    h.fire();
    await h.flush();
    expect(h.woke, 'A は二度と起きない(B だけ)').toEqual(['B']);
    h.resume();
    h.fire();
    await h.flush();
    expect(h.woke, 'A は何度 resume しても戻らない').toEqual(['B']);
  });

  it('🔴 ② patch 後: 同じ入れ子で、予約していた 1 つ目が起き、次の resume で 2 つ目も起きる', async () => {
    const h = harness(PATCHED);
    h.suspend('A');
    await h.flush();
    h.resume();
    h.suspend('B');
    await h.flush();
    h.fire();
    await h.flush();
    expect(h.woke, '予約していた A が起きていない').toEqual(['A']);
    h.resume();
    h.fire();
    await h.flush();
    expect(h.woke).toEqual(['A', 'B']);
  });

  it('🔴 ④ patch 後: 2 つが同時に溜まっていれば、1 回の resume で**両方**起きる(1 つだけ起こさない)', async () => {
    const h = harness(PATCHED);
    h.suspend('A');
    h.suspend('B');
    await h.flush();
    h.resume();
    expect(h.timers.length, 'timer は 1 つにまとめる').toBe(1);
    h.fire();
    await h.flush();
    expect(h.woke.sort()).toEqual(['A', 'B']);
  });

  it('③ patch 後: resume を続けて 2 回呼んでも、2 回目は何もしない(Map が空)', async () => {
    const h = harness(PATCHED);
    h.suspend('A');
    await h.flush();
    h.resume();
    h.resume();
    expect(h.timers.length, '2 回目が timer を足した(二重に起こす)').toBe(1);
    h.fire();
    await h.flush();
    expect(h.woke).toEqual(['A']);
    // suspend していないときの resume も何もしない
    const h2 = harness(PATCHED);
    h2.resume();
    expect(h2.timers.length).toBe(0);
  });
});

/**
 * 🔑 **C++ の 2 関数(suspend / resume)を取り出して g++ で動かす**(stub の上で)。
 * ⚠ Qt の header は無いので**ファイル全体のコンパイルはしない**(焼きで見る)。ここで見るのは
 * 「深さの数」という作りが、**入れ子 suspend を JSPI でだけ許し、resume が深さを動かさない**こと。
 */
describe('#1344 の直し(asyncify-nested)── C++ の suspend / resume を g++ で動かす(stub の上で)', () => {
  const grab = (text: string, head: string): string => {
    const a = text.indexOf(head);
    const b = text.indexOf('\n}\n', a);
    expect(a > -1 && b > a, `${head} を取り出せない`).toBe(true);
    return text.slice(a, b + 3);
  };

  function compileAndRun(jspi: boolean): { code: number; out: string } {
    const dir = mkdtempSync(join(tmpdir(), 'pkc3-asyncnest-gpp-'));
    try {
      const varLine = PATCHED.split('\n').find((l) => l.startsWith('static int g_asyncify_suspend_depth'));
      expect(varLine, '深さの変数を引けない').toBeTruthy();
      const src = `#include <cstdio>
#include <functional>
// ── stub(Qt の header は無い。本物の呼び方だけ写す)──
namespace qstdweb { static bool g_jspi = ${jspi}; static bool haveJspi() { return g_jspi; } }
${varLine}
static std::function<void()> g_inSuspend; // suspend_js の最中(= JS で待っている間)に走らせる物
static int g_resumeJs = 0;
void qt_asyncify_suspend_js()
{
    std::printf("  [js suspend] depth=%d\\n", g_asyncify_suspend_depth);
    if (g_inSuspend) {
        auto f = g_inSuspend;
        g_inSuspend = nullptr;
        f();
    }
}
void qt_asyncify_resume_js() { ++g_resumeJs; std::printf("  [js resume] depth=%d\\n", g_asyncify_suspend_depth); }

${grab(PATCHED, 'bool qt_asyncify_suspend()')}
${grab(PATCHED, 'void qt_asyncify_resume()')}

int main()
{
    // (1) suspend していないとき、resume は JS を呼ばない
    qt_asyncify_resume();
    std::printf("idle-resume js=%d depth=%d\\n", g_resumeJs, g_asyncify_suspend_depth);

    // (2) 外側が suspend 中に: resume を予約 → (深さは落ちない) → 入れ子で suspend
    bool nested = false;
    g_inSuspend = [&] {
        qt_asyncify_resume();
        std::printf("after-reserve js=%d depth=%d\\n", g_resumeJs, g_asyncify_suspend_depth);
        nested = qt_asyncify_suspend();
        std::printf("nested-returned=%d depth=%d\\n", nested ? 1 : 0, g_asyncify_suspend_depth);
    };
    const bool outer = qt_asyncify_suspend();
    std::printf("outer=%d depth=%d\\n", outer ? 1 : 0, g_asyncify_suspend_depth);
    return 0;
}
`;
      writeFileSync(join(dir, 't.cxx'), src, 'utf-8');
      const cc = spawnSync('g++', ['-std=c++20', '-Wall', '-Wextra', '-Werror', join(dir, 't.cxx'), '-o', join(dir, 't')], {
        encoding: 'utf-8',
        stdio: 'pipe',
      });
      expect(cc.status, cc.stderr).toBe(0);
      const r = spawnSync(join(dir, 't'), [], { encoding: 'utf-8', stdio: 'pipe' });
      return { code: r.status ?? -1, out: r.stdout };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('🔴 JSPI: 予約しても深さは落ちず、入れ子の suspend が通り(戻ると 1 つ減る)、外側も戻る', () => {
    const r = compileAndRun(true);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('idle-resume js=0 depth=0');
    expect(r.out).toContain('after-reserve js=1 depth=1');
    expect(r.out, '入れ子の suspend が JS まで届いていない').toContain('[js suspend] depth=2');
    // stub の suspend_js は即戻るので、入れ子は戻った後 1 に、外側が戻ると 0 になる
    expect(r.out).toContain('nested-returned=1 depth=1');
    expect(r.out).toContain('outer=1 depth=0');
  });

  it('🔴 asyncify(1): 入れ子は従来どおり断る(false)。JS へ 2 度目は入らない', () => {
    const r = compileAndRun(false);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('nested-returned=0 depth=1');
    expect(r.out).not.toContain('[js suspend] depth=2');
    expect(r.out).toContain('outer=1 depth=0');
  });

  it('🔴 wake の門が深さの数で判定している(1 bit を読む所が 0 件で、深さを読む所が在る)', () => {
    const wake = grab(PATCHED, 'bool QEventDispatcherWasm::wakeEventDispatcherThread()');
    expect(wake).toContain('if (g_asyncify_suspend_depth == 0)');
    expect(wake).toContain('runOnMainThread([]() { qt_asyncify_resume(); });');
    // 1 bit の字は、コードの中に 1 つも残っていない
    const code = PATCHED.split('\n').filter((l) => !l.trimStart().startsWith('//'));
    expect(code.filter((l) => l.includes(OLD_NAME))).toEqual([]);
  });
});
