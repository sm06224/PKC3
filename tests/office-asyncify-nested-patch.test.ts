/** @vitest-environment node */
/**
 * `build/office-wasm/qtbase-patch-asyncify-nested.py` を検める(#1344 の Qt 側の直し)。
 *
 * ## 何を直すか(v2)
 *
 * Qt 6.9 の `qeventdispatcher_wasm.cpp` は suspend の resolver を **1 枠**に置き、resume の `setTimeout` は
 * 発火時に **suspendId が違えば起こさずに捨てる**(外側の `processEvents` が二度と戻らない = #1344)。
 * v1(#1350)は「溜まっている全部を同じ tick で起こす」に替えたが、🔴 **JSPI でも C の shadow stack は 1 本**なので、
 * 外側を先に起こすと内側の frame(`QMenuPrivate::exec` の局所 `QEventLoop`)を踏み、
 * `QMenu::hideEvent` → `QEventLoop::exit(int)` が `unaligned accesses` で trap した(実ブラウザ)。
 * v2 は suspend を **stack**(`Module.qtSuspends`)に積み、**LIFO で起こす**:最も内側だけを見て、
 * 起こされていなければ外側は待ち、内側が JS へ戻った後の tick で外側を起こす。
 *
 * ## ⚠ ここで検められること / 検められないこと
 *
 * | 見る | 見ない |
 * |---|---|
 * | 錨が 1 件ずつ当たる / 二重当ては落ちて file 不変 | 🔴 **Qt 全体のコンパイル**(Qt の header が無い。焼きで見る) |
 * | 原文の削除は 1 枠・1 bit の周りだけ / 足した行は全部印つき | 実機で外側の `processEvents` が戻るか(焼いた一式の probe) |
 * | 🔑 **JS の挙動を node で実走**(原文・v1 を対照群に。変異 6 件を機械で当てる) | |
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
  it('🔴 原文に当たり、1 枠・suspendId・1 bit が消えて suspend の stack と深さの数が入る', () => {
    expect(PATCHED).toContain('Module.qtSuspends.push({ resolve: resolve, wake: false });');
    expect(PATCHED).toContain('static int g_asyncify_suspend_depth = 0;');
    // 🔴 原文の 1 枠と suspendId は、**どの字も**残っていない(v1 の `qtAsyncifyWakeUps` も含めて 0 件)
    expect(PATCHED).not.toContain('qtAsyncifyWakeUp');
    expect(PATCHED).not.toContain('qtSuspendId');
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
   * 🔴 **錨が 1 件ずつ当たる** ── 6 つの錨それぞれを**原文から消した** tree を作り、
   * そのたびに落ちる(「錨が」と言う)ことと、**file が 1 バイトも動かない**ことを見る。
   * ⚠ 錨が 1 つでも黙って素通りすると、**直っていない一式を「直った」と思って焼く**。
   */
  it.each([
    ['変数', 'static bool g_is_asyncify_suspended = false;\n'],
    ['JS(1 枠)', '        Module.qtAsyncifyWakeUp = resolve;\n'],
    ['JS(suspendId の照合)', '        if (Module.qtSuspendId !== suspendId)\n'],
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

  it('🔴 消えた原文の行は、1 枠・suspendId の JS(`qtAsyncifyWakeUp` / `qtSuspendId` 周り)と 1 bit(`g_is_asyncify_suspended`)の周りだけ', () => {
    expect(jsFrom > 0 && jsTo > jsFrom, 'fixture から JS の区間を引けない').toBe(true);
    expect(d.removed.length, '空振り防止: 消えた行が 0 件').toBeGreaterThan(8);
    const outside = d.removed.filter((r) => !(r.n >= jsFrom && r.n <= jsTo) && !r.text.includes(OLD_NAME));
    expect(outside, '1 枠 / 1 bit の外の原文が消えている').toEqual([]);
    // 1 枠・suspendId の字を持つ行・1 bit の字を持つ行は、原文の全部が消えている(取り残しが無い)
    const mustGo = origLines.map((t, i) => ({ n: i + 1, t })).filter((x) => x.t.includes('qtAsyncifyWakeUp') || x.t.includes('qtSuspendId') || x.t.includes(OLD_NAME));
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
 * 🔑 **JS の挙動の実走(v2: 起こす順は LIFO)**。patch 後の file から `EM_ASYNC_JS` / `EM_JS` の本体を抜き出し、
 * `Module` と `setTimeout` を偽物にして走らせる。⚠ **tick は手で進める**(`fire()` が「`setTimeout(0)` が 1 周した」)。
 *
 * 対照群を**同じ台**で回す:
 * - **原文** ── resolver は 1 枠で、外側の起こしは**捨てられる**(外側は二度と起きない = #1344 の症状)
 * - **v1(#1350)** ── resolver は id ごとの Map で、溜まった**全部を同じ tick で起こす**(= LIFO 違反)。
 *   実ブラウザで `QEventLoop::exit(int)` が `unaligned accesses` で trap した
 *
 * 観測は 2 つの独立した物で取る:harness の `pending`(suspend してまだ起きていない名前 ── Module の中身を見ない)と、
 * v2 だけ `Module.qtSuspends.length`(stack に残っている entry の数)。
 */
describe('#1344 の直し v2(asyncify-nested)── JS を node で実走する(LIFO)', () => {
  type Mod = Record<string, unknown>;
  type Woke = { name: string; pending: string[]; stack: number };

  function bodyOf(text: string, head: string): string {
    const a = text.indexOf(head);
    expect(a, `${head} が見つからない`).toBeGreaterThan(-1);
    const start = text.indexOf('\n', a) + 1;
    const end = text.indexOf('\n});', start);
    expect(end).toBeGreaterThan(start);
    return text.slice(start, end);
  }

  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (...a: string[]) => (...a: unknown[]) => Promise<void>;

  /** v1(#1350)の JS ── 全部を同じ tick で起こす。⚠ 対照群なので、変えずに持つ。 */
  const V1 = `EM_ASYNC_JS(void, qt_asyncify_suspend_js, (), {
    if (Module.qtSuspendId === undefined)
        Module.qtSuspendId = 0;
    ++Module.qtSuspendId;
    const id = Module.qtSuspendId;
    if (Module.qtAsyncifyWakeUps === undefined) Module.qtAsyncifyWakeUps = new Map();
    await new Promise(resolve => {
        Module.qtAsyncifyWakeUps.set(id, resolve);
    });
});

EM_JS(void, qt_asyncify_resume_js, (), {
    const m = Module.qtAsyncifyWakeUps;
    if (m === undefined || m.size === 0)
        return;
    const wakeUps = Array.from(m.values());
    m.clear();
    setTimeout(() => { for (const wakeUp of wakeUps) wakeUp(); });
});
`;

  function harness(src: string) {
    const suspendBody = bodyOf(src, 'EM_ASYNC_JS(void, qt_asyncify_suspend_js, (), {');
    const resumeBody = bodyOf(src, 'EM_JS(void, qt_asyncify_resume_js, (), {');
    const Module: Mod = {};
    const timers: (() => void)[] = [];
    const fakeSetTimeout = (fn: () => void): number => timers.push(fn);
    const suspendFn = new AsyncFunction('Module', suspendBody);
    const resumeFn = new Function('Module', 'setTimeout', resumeBody) as (m: Mod, st: typeof fakeSetTimeout) => void;
    const woke: Woke[] = [];
    const pending = new Set<string>();
    const stackLen = (): number => {
      const s = Module['qtSuspends'] as unknown[] | undefined;
      return s === undefined ? -1 : s.length;
    };
    return {
      woke,
      timers,
      stackLen,
      /** 名前を付けて suspend する。起きたら `woke` へ積み、`then` を走らせる(= その frame が次にやること)。 */
      suspend(name: string, then?: () => void): void {
        pending.add(name);
        void suspendFn(Module).then(() => {
          pending.delete(name);
          woke.push({ name, pending: [...pending].sort(), stack: stackLen() });
          then?.();
        });
      },
      resume: (): void => resumeFn(Module, fakeSetTimeout),
      /** 置かれた timer を全部発火させる(= `setTimeout(0)` が 1 周した)。⚠ 発火中に足された timer は次の周で回る。 */
      fire(): void {
        for (const t of timers.splice(0)) t();
      },
      /** promise の後続を回し切る。 */
      async flush(): Promise<void> {
        for (let i = 0; i < 12; i++) await Promise.resolve();
      },
      names: (): string[] => woke.map((w) => w.name),
    };
  }
  type H = ReturnType<typeof harness>;

  /**
   * 場面 B(入れ子 + 内側が 1 度戻って、もう一度 suspend する ── popup の入れ子 loop の形):
   * 外側 A suspend → resume#1 → 内側 B suspend(B は起きたら**もう一度 suspend** = B2)→
   * tick① → resume#2 → tick② → tick③ → resume#3 → tick④ → tick⑤。各 tick の後の「起きた名前」を返す。
   */
  async function sceneB(src: string): Promise<{ h: H; steps: string[][] }> {
    const h = harness(src);
    const steps: string[][] = [];
    const tick = async (): Promise<void> => {
      h.fire();
      await h.flush();
      steps.push(h.names());
    };
    h.suspend('A');
    await h.flush();
    h.resume(); // resume#1: この時点で stack は [A] ── A に wake が立つ
    h.suspend('B', () => h.suspend('B2'));
    await h.flush();
    await tick(); // ① 内側 B は wake=false
    h.resume(); // resume#2
    await tick(); // ② 内側だけ
    await tick(); // ③ B は B2 としてもう一度 suspend している
    h.resume(); // resume#3
    await tick(); // ④ B2 が戻る(push しない)
    await tick(); // ⑤ 外側
    return { h, steps };
  }

  /** 場面 C(2 つ溜まっているところへ resume が **1 回だけ**): 外側 A・内側 B が suspend → resume#1 → tick① → tick②。 */
  async function sceneC(src: string): Promise<{ h: H; steps: string[][] }> {
    const h = harness(src);
    const steps: string[][] = [];
    h.suspend('A');
    h.suspend('B');
    await h.flush();
    h.resume();
    for (let i = 0; i < 2; i++) {
      h.fire();
      await h.flush();
      steps.push(h.names());
    }
    return { h, steps };
  }

  const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
  const LIFO = 'LIFO: 外側が起きた時点で、内側がまだ suspend している';

  /** 場面 B の主張のうち、**破れているもの**の名前を返す(空 = 全部成り立つ)。 */
  function claimsB(r: { h: H; steps: string[][] }): string[] {
    const bad: string[] = [];
    const [t1, t2, t3, t4, t5] = r.steps;
    if (!same(t1, [])) bad.push('B1: 内側が起こされる前に誰かが起きた');
    if (!same(t2, ['B'])) bad.push('B2: resume#2 の tick で、内側だけが起きていない');
    if (!same(t3, ['B'])) bad.push('B3: 内側が再 suspend している間に、外側が起きた');
    if (!same(t4, ['B', 'B2'])) bad.push('B4: 再 suspend した内側が resume#3 で戻っていない');
    if (!same(t5, ['B', 'B2', 'A'])) bad.push('B5: 内側が戻った後に、外側が起きていない');
    const a = r.h.woke.find((w) => w.name === 'A');
    if (a !== undefined && a.pending.length > 0) bad.push(LIFO);
    return bad;
  }
  function claimsC(r: { h: H; steps: string[][] }): string[] {
    const bad: string[] = [];
    if (!same(r.steps[0], ['B'])) bad.push('C1: 1 回目の tick で内側だけが起きていない');
    if (!same(r.steps[1], ['B', 'A'])) bad.push('C2: 内側が戻った後の tick で外側が起きていない(resume を足していない)');
    const a = r.h.woke.find((w) => w.name === 'A');
    if (a !== undefined && a.pending.length > 0) bad.push(LIFO);
    return bad;
  }

  it('① (a) 入れ子でない普段の経路 ── 原文 / v1 / v2 とも: 1 回 suspend → resume → tick 1 周で、その 1 つが起きる', async () => {
    for (const [label, src] of [
      ['原文', ORIG],
      ['v1', V1],
      ['v2', PATCHED],
    ] as const) {
      const h = harness(src);
      h.suspend('A');
      await h.flush();
      expect(h.names(), `${label}: suspend しただけで起きた`).toEqual([]);
      h.resume();
      await h.flush();
      expect(h.names(), `${label}: timer が回る前に起きている(setTimeout が無い)`).toEqual([]);
      expect(h.timers.length, label).toBe(1);
      h.fire();
      await h.flush();
      expect(h.names(), label).toEqual(['A']);
    }
  });

  it('① (a) v2: 起きた後に stack は空で、次の suspend → resume も同じに動く(再予約の tick が残っていても)', async () => {
    const h = harness(PATCHED);
    h.suspend('A');
    await h.flush();
    h.resume();
    h.fire();
    await h.flush();
    expect(h.names()).toEqual(['A']);
    expect(h.stackLen(), 'A が起きたのに stack に残っている').toBe(0);
    expect(h.woke[0]?.stack).toBe(0);
    // 再予約の tick が 1 つ残っている(= 「戻ったか」を次の周で見る)── ⚠ これを回さずに次の suspend → resume へ進む
    expect(h.timers.length).toBe(1);
    h.suspend('A2');
    await h.flush();
    h.resume(); // armed のまま → timer を足さない。残っている tick が拾う
    expect(h.timers.length, 'resume が timer を二重に足した').toBe(1);
    h.fire();
    await h.flush();
    expect(h.names()).toEqual(['A', 'A2']);
    // 余った tick は何もしない / suspend していないときの resume も何もしない
    h.fire();
    h.resume();
    expect(h.timers.length).toBe(0);
    expect(h.names()).toEqual(['A', 'A2']);
  });

  it('③ v2: resume を続けて 2 回呼んでも timer は 1 つ(armed)で、1 つ起きる', async () => {
    const h = harness(PATCHED);
    h.suspend('A');
    await h.flush();
    h.resume();
    h.resume();
    expect(h.timers.length, '2 回目が timer を足した').toBe(1);
    h.fire();
    await h.flush();
    expect(h.names()).toEqual(['A']);
    const h2 = harness(PATCHED);
    h2.resume();
    expect(h2.timers.length, 'suspend していないのに timer を足した').toBe(0);
  });

  it('③ v2: 再予約の空 tick を回した後も、次の suspend → resume は timer を 1 つ置いて起きる(armed の戻し)', async () => {
    // ⚠ 着地前レビュー(2026-10-05)の M-A: tick 頭の `armed = false` を「stack が空なら return」の後ろへ動かすと、
    //    空 tick が armed を立てたまま終わり、次の resume が timer を置けず、LO の main loop が 2 回目の wake で永久に止まる。
    //    上の「(a) 再予約の tick が残っていても」は空 tick を**回さずに**次へ進むので、この形を見ていなかった。
    const h = harness(PATCHED);
    h.suspend('A');
    await h.flush();
    h.resume();
    h.fire();
    await h.flush();
    expect(h.names()).toEqual(['A']);
    expect(h.timers.length, '再予約の tick が無い').toBe(1);
    h.fire(); // 空 tick を回す(stack は空)
    await h.flush();
    expect(h.timers.length).toBe(0);
    h.suspend('A3');
    await h.flush();
    h.resume();
    expect(h.timers.length, '空 tick の後の resume が timer を置けない(armed が立ったまま)').toBe(1);
    h.fire();
    await h.flush();
    expect(h.names()).toEqual(['A', 'A3']);
  });

  it('③ v2: 単独の entry が起きて再 suspend しても、再予約の tick は wake の無い entry を起こさない(空転しない)', async () => {
    // ⚠ 着地前レビュー(2026-10-05)の M-B: `if (!top.wake) return;` を `s.length > 1` のときだけにすると、
    //    入れ子でない LO の普段の loop(suspend → 起きる → 再 suspend)が tick ごとに自発的に起き続け、
    //    setTimeout 周期で空転する(常駐 CPU の実害)。場面 B は外側が下に居るときしか見ない。
    const h = harness(PATCHED);
    h.suspend('A', () => h.suspend('A2'));
    await h.flush();
    h.resume();
    h.fire();
    await h.flush();
    expect(h.names()).toEqual(['A']);
    expect(h.stackLen(), 'A2 が積まれていない').toBe(1);
    for (let i = 0; i < 3; i++) {
      h.fire();
      await h.flush();
    }
    expect(h.names(), 'wake の無い A2 が tick で起きた(空転)').toEqual(['A']);
    expect(h.timers.length, '誰も起こさない tick が回り続けている').toBe(0);
    // wake が来れば起きる(止まっているのではない)
    h.resume();
    h.fire();
    await h.flush();
    expect(h.names()).toEqual(['A', 'A2']);
  });

  it('🔴 (b) v2: 入れ子 ── 内側だけが先に起き、外側は内側が JS へ戻った後で、stack に内側が 1 つも無い状態で起きる', async () => {
    const r = await sceneB(PATCHED);
    expect(claimsB(r)).toEqual([]);
    // 外側が resolve された時点の stack ── 内側の entry が 1 つも無い(= LIFO の主張そのもの)
    const a = r.h.woke.find((w) => w.name === 'A');
    expect(a, '外側が起きていない').toBeDefined();
    expect(a!.stack, '外側が起きた時点で、内側の entry が stack に残っている').toBe(0);
    expect(a!.pending).toEqual([]);
    // 内側が起きた時点では外側がまだ stack に居る(= 外側を先に起こしていない)
    const b = r.h.woke.find((w) => w.name === 'B');
    expect(b!.stack, '内側が起きた時点で、外側が stack に居ない').toBe(1);
    expect(b!.pending).toEqual(['A']);
  });

  it('🔴 (c) v2: wake は捨てられない ── 2 つ溜まっているところへ resume が 1 回だけ。内側が戻れば、resume を足さなくても外側が起きる', async () => {
    const r = await sceneC(PATCHED);
    expect(claimsC(r)).toEqual([]);
    expect(r.h.woke.find((w) => w.name === 'A')!.stack).toBe(0);
  });

  it('🔴 (d) 対照群・原文: 外側の resolver は**捨てられ**、二度と起きない', async () => {
    const rb = await sceneB(ORIG);
    expect(rb.h.names(), '原文でも外側が起きている ── 対照群が捨てを再現していない').not.toContain('A');
    expect(rb.h.names()).toEqual(['B', 'B2']);
    // 余分に resume と tick を足しても戻らない
    for (let i = 0; i < 3; i++) {
      rb.h.resume();
      rb.h.fire();
      await rb.h.flush();
    }
    expect(rb.h.names(), '何度 resume しても外側は戻らない').not.toContain('A');
    // 同じ台で v2 の主張を当てると、外側が起きていない所で破れる
    expect(claimsB(rb).some((c) => c.startsWith('B5'))).toBe(true);
    const rc = await sceneC(ORIG);
    expect(rc.h.names()).toEqual(['B']);
    expect(claimsC(rc).some((c) => c.startsWith('C2'))).toBe(true);
  });

  it('🔴 (d) 対照群・v1: 外側と内側を**同じ tick で両方**起こす(= LIFO 違反。実ブラウザで unaligned accesses の trap)', async () => {
    // 場面 C: 1 回の resume → 1 周目の tick で両方起きる
    const rc = await sceneC(V1);
    expect(rc.steps[0], 'v1 でも内側だけ起きている ── 対照群が全部起こしを再現していない').toEqual(['A', 'B']);
    expect(claimsC(rc).some((c) => c.startsWith('C1'))).toBe(true);
    expect(claimsC(rc)).toContain(LIFO);
    // 場面 B: 内側が suspend している最中(resume#1 の tick)に、外側が起きる
    const rb = await sceneB(V1);
    expect(rb.steps[0]).toEqual(['A']);
    expect(rb.h.woke[0]?.pending, '外側が起きた時点で内側が pending').toEqual(['B']);
    expect(claimsB(rb)).toContain(LIFO);
  });

  /**
   * 🔴 **変異試験**(v2 の JS の 1 行ずつを壊し、場面 B / C のどれかが**破れる**ことを見る)。
   * `NOT-APPLIED`(元の字が 1 件でない)は合格ではない ── 当たっていない変異を「生き延びた」とも「殺した」とも読まない。
   */
  const MUTANTS: { name: string; from: string; to: string; claim: string }[] = [
    {
      name: '① `if (!top.wake) return;` を外す(起こされていない内側も起こす)',
      from: '        if (!top.wake) return; // PKC3-ASYNCNEST: 内側が起こされていないなら外側は待つ(wake は立ったまま残る)\n',
      to: '',
      claim: 'B1: 内側が起こされる前に誰かが起きた',
    },
    {
      name: '② `for (const e of s) e.wake = true;` を最も内側だけにする(wake を溜まっている全部に立てない)',
      from: '    for (const e of s) e.wake = true;',
      to: '    s[s.length - 1].wake = true; //',
      claim: 'C2: 内側が戻った後の tick で外側が起きていない',
    },
    {
      name: '③a 再予約の `setTimeout(tick)` を外す(起こした後に次の tick を置かない)',
      from: '        setTimeout(tick); // PKC3-ASYNCNEST: 再予約\n',
      to: '',
      claim: 'B5: 内側が戻った後に、外側が起きていない',
    },
    {
      name: '③b 再予約の 2 行(armed を立てる + `setTimeout(tick)`)を丸ごと外す',
      from: '        Module.qtResumeTickArmed = true; // PKC3-ASYNCNEST\n        setTimeout(tick); // PKC3-ASYNCNEST: 再予約\n',
      to: '',
      claim: 'B5: 内側が戻った後に、外側が起きていない',
    },
    {
      name: '④ 最も内側ではなく最も外側を見る(`s[s.length - 1]` → `s[0]`。LIFO を FIFO にする)',
      from: '        const top = s[s.length - 1];',
      to: '        const top = s[0];',
      claim: LIFO,
    },
    {
      name: '⑤ tick の頭で armed を落とさない(次の resume が tick を予約できなくなる)',
      from: '        Module.qtResumeTickArmed = false; // PKC3-ASYNCNEST\n',
      to: '',
      claim: 'B2: resume#2 の tick で、内側だけが起きていない',
    },
  ];

  it.each(MUTANTS)('🔴 変異 $name → KILLED', async ({ from, to, claim }) => {
    const hits = PATCHED.split(from).length - 1;
    expect(hits, `NOT-APPLIED: 元の字が ${hits} 件(1 件でない)`).toBe(1);
    const mutated = PATCHED.replace(from, () => to);
    expect(mutated, 'NOT-APPLIED: 何も変わっていない').not.toBe(PATCHED);
    let claims: string[];
    try {
      claims = [...claimsB(await sceneB(mutated)), ...claimsC(await sceneC(mutated))];
    } catch (e) {
      claims = [`threw: ${String(e)}`];
    }
    expect(claims.length, 'SURVIVED: 変異を当てても場面 B / C の主張が 1 つも破れない').toBeGreaterThan(0);
    expect(claims.some((c) => c.startsWith(claim)), `KILLED だが別の主張で: ${claims.join(' / ')}(期待: ${claim})`).toBe(true);
  });

  it('⚠ 対照: 変異を当てていない v2 は、同じ台で主張が 1 つも破れない(台が全部を破っているのではない)', async () => {
    expect([...claimsB(await sceneB(PATCHED)), ...claimsC(await sceneC(PATCHED))]).toEqual([]);
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
