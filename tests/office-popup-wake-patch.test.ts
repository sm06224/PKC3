/** @vitest-environment node */
/**
 * `build/office-wasm/patch-lo-popup-wake.py` を検める(#1344 の**直し**)。
 *
 * 🔴 **直す物**: popup(`QtMenu::ShowNativePopupMenu` の `mpQMenu->exec(...)`)が返った後、round が終わるまで
 * 13〜16 秒 user event が 1 件も dispatch されない(判別焼き run 37256418166)。`PostUserEvent` →
 * `TriggerUserEventProcessing` → `wakeUp()` は呼ばれているのに drain が起きない。読み(未確定): 入れ子 loop が
 * `wakeUp()` の印を消費済みのまま、外側の `processEvents(WaitForMoreEvents)` が待ちへ戻る。
 * 直しは、`exec()` が返って関数を出る時に **`QTimer::singleShot(0, qApp, …)` で本物の Qt の event を 1 つ置く**。
 *
 * ⚠ 見るのは 6 つ:
 *   ① **錨が原文に当たる**(上流の抜粋 ── 合成した物ではない)/ 1 つ外しても落ちる / 二重当ては落ちて不変
 *   ② **足した行は全部印を含み、原文の行は 1 行も書き換えない**(印の行を除くと原文と一致)/
 *      本体は `#if defined __EMSCRIPTEN__` の中だけ(非 wasm では include 3 行以外 1 行も変わらない)
 *   ③ 🔑 **描いた枝を g++ で動かす**(LO / Qt の header は無いので、枝の論理だけを stub の上で):
 *      exec の最中はまだ置かれず、**関数を出た後**に 1 つ(`singleShot(0, …)`)置かれ、発火すると
 *      `TriggerUserEventProcessing` が呼ばれる / 非 wasm では何も置かれない
 *   ④ 🔴 **menu-trace / uev-trace(同じ `QtMenu.cxx` を触る)と錨の区間が 1 バイトも交わらず、3 本 6 通りの順で出力が同一**
 *   ⑤ スコープ検査(`check-patch-scope.py` の FIXES)に載っている + 抜粋に対して**実際に走らせる**
 *   ⑥ workflow の本数の主張(25)
 *
 * 🔴 **言えないこと**: 当てた後の C++ が本物の LO / Qt の header でコンパイルできること /
 * 本物の JSPI で `exec` の後の待ちが本当に起きること。どちらも**焼いて、`PKC3-POPUPWAKE: armed after popup exec` が
 * 出ること・`exec-ret` の後 1 秒以内に `dispatch` が出ること**まで確かめられない。
 */
import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const SCRIPT = 'build/office-wasm/patch-lo-popup-wake.py';
const MENU_SCRIPT = 'build/office-wasm/patch-lo-menu-trace.py';
const UEV_SCRIPT = 'build/office-wasm/patch-lo-uev-trace.py';
const REL = 'vcl/qt5/QtMenu.cxx';
const MARK = 'PKC3-POPUPWAKE';
const FX = 'tests/fixtures/office-lo';
const EXCERPT = readFileSync(`${FX}/QtMenu.excerpt.cxx`, 'utf-8');

/** python の module から値を取り出す(⚠ 錨の字をここへ書き写さない)。 */
function pyJson(script: string, expr: string): unknown {
  const code = [
    'import importlib.util,sys,json',
    'sys.dont_write_bytecode=True',
    `sp=importlib.util.spec_from_file_location("p","${script}")`,
    'm=importlib.util.module_from_spec(sp); sp.loader.exec_module(m)',
    `print(json.dumps(${expr}))`,
  ].join('\n');
  return JSON.parse(execFileSync('python3', ['-B', '-c', code], { encoding: 'utf-8', stdio: 'pipe' }));
}

const FIX_ANCHORS = pyJson(SCRIPT, '[a for a,_ in m.PARTS]') as string[];
const [INC_ANCHOR, WAKE_ANCHOR] = FIX_ANCHORS as [string, string];

interface Tree {
  dir: string;
  read: (rel?: string) => string;
  cleanup: () => void;
}

function tree(body: string = EXCERPT, extra: Record<string, string> = {}): Tree {
  const dir = mkdtempSync(join(tmpdir(), 'pkc3-popupwake-'));
  const put = (b: string, rel: string = REL): void => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), b, 'utf-8');
  };
  put(body);
  for (const [rel, b] of Object.entries(extra)) put(b, rel);
  return {
    dir,
    read: (rel = REL) => readFileSync(join(dir, rel), 'utf-8'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function run(script: string, dir: string, env: Record<string, string> = {}): { code: number; out: string } {
  const r = spawnSync('python3', ['-B', script, dir], {
    encoding: 'utf-8',
    stdio: 'pipe',
    env: { ...process.env, ...env },
  });
  return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
}

const count = (text: string, needle: string): number => text.split(needle).length - 1;

/** 足した行(印を含む行)を取り除く。この直しは**原文の行を 1 行も書き換えない**(足すだけ)。 */
function restore(text: string): string {
  return text
    .split('\n')
    .filter((l) => !l.includes(MARK))
    .join('\n');
}

function patched(): string {
  const t = tree();
  try {
    const r = run(SCRIPT, t.dir);
    expect(r.code, r.out).toBe(0);
    return t.read();
  } finally {
    t.cleanup();
  }
}

const EXEC_LINE = '    mpQMenu->exec(aRect.bottomLeft());\n';

describe('#1344 の直し(popup-wake)── 当て方', () => {
  it('🔑 空振り防止: 錨を拾えている / 抜粋が `ShowNativePopupMenu` と file の頭の include を含む', () => {
    expect(FIX_ANCHORS.length, '直しの錨を拾えていない').toBe(2);
    expect(new Set(FIX_ANCHORS).size, '同じ錨が在る').toBe(FIX_ANCHORS.length);
    expect(EXCERPT).toContain('bool QtMenu::ShowNativePopupMenu(FloatingWindow* pWin, const tools::Rectangle& rRect,');
    expect(EXCERPT).toContain(EXEC_LINE);
    // 🔑 抜粋は**原文のまま**(印も計装も入っていない)
    expect(EXCERPT).not.toContain('PKC3-');
  });

  it('🔴 錨は、上流の原文の抜粋に**ちょうど 1 件**ずつ当たる。手で書いた期待値とも一致する', () => {
    for (const a of FIX_ANCHORS) expect(count(EXCERPT, a), `錨が 1 件でない:\n${a}`).toBe(1);
    expect(INC_ANCHOR).toBe('#include <sal/config.h>\n');
    // `exec` の**前**の行(`exec` の行は menu-trace の錨、`return true;` の直前は uev-trace の挿入点)
    expect(WAKE_ANCHOR).toBe('    const QRect aRect = toQRect(aFloatRect, 1 / pFrame->devicePixelRatioF());\n');
    expect(WAKE_ANCHOR, '錨が exec の行を含んでいる').not.toContain('mpQMenu->exec(');
  });

  it('🔴 毎回当たる(入力で gate しない)。当てると印が入り、file が変わる', () => {
    const t = tree();
    try {
      const r = run(SCRIPT, t.dir);
      expect(r.code, r.out).toBe(0);
      expect(t.read()).not.toBe(EXCERPT);
      expect(t.read()).toContain(MARK);
    } finally {
      t.cleanup();
    }
  });

  it('🔴 二重当ては落ち(exit 1)、file は 1 バイトも変わらない', () => {
    const t = tree();
    try {
      expect(run(SCRIPT, t.dir).code).toBe(0);
      const once = t.read();
      const r = run(SCRIPT, t.dir);
      expect(r.code, r.out).toBe(1);
      expect(r.out).toContain('二重当て');
      expect(t.read()).toBe(once);
    } finally {
      t.cleanup();
    }
  });

  it('🔴 錨が 1 つでも無ければ落ちる(何も書かない)/ 2 件になっても落ちる', () => {
    for (let i = 0; i < FIX_ANCHORS.length; i++) {
      const broken = EXCERPT.replace(FIX_ANCHORS[i]!, '// 上流が形を変えた\n');
      expect(broken, `錨 ${i} を外せていない`).not.toBe(EXCERPT);
      const t = tree(broken);
      try {
        const r = run(SCRIPT, t.dir);
        expect(r.code, `錨 ${i} を外しても落ちない:\n${r.out}`).toBe(1);
        expect(r.out).toContain('錨が 0 件');
        expect(t.read(), '落ちたのに書き換えている').toBe(broken);
      } finally {
        t.cleanup();
      }
      const doubled = `${EXCERPT}\n${FIX_ANCHORS[i]}`;
      const t2 = tree(doubled);
      try {
        const r = run(SCRIPT, t2.dir);
        expect(r.code, `錨 ${i}\n${r.out}`).toBe(1);
        expect(r.out).toContain('錨が 2 件');
        expect(t2.read()).toBe(doubled);
      } finally {
        t2.cleanup();
      }
    }
  });

  it('当て先の file が無ければ落ちる', () => {
    const t = tree();
    try {
      const r = run(SCRIPT, `${t.dir}/no-such-root`);
      expect(r.code).toBe(1);
      expect(r.out).toContain(REL);
    } finally {
      t.cleanup();
    }
  });
});

describe('#1344 の直し(popup-wake)── 当てた結果(描いた C++ で見る)', () => {
  it('🔴 局所 struct は `exec` の**前**・`aRect` の直後に在り、`#if defined __EMSCRIPTEN__` の中だけに本体が在る', () => {
    const after = patched();
    const at = (needle: string): number => {
      expect(count(after, needle), `「${needle.trim()}」が 1 件でない`).toBe(1);
      return after.indexOf(needle);
    };
    const rectAt = at(WAKE_ANCHOR);
    const ifAt = at(`#if defined __EMSCRIPTEN__ // ${MARK}\n`);
    const structAt = at(`    struct Pkc3PopupWake // ${MARK}\n`);
    const timerAt = at('QTimer::singleShot(0, qApp, [] { GetQtInstance().TriggerUserEventProcessing(); });');
    const fputsAt = at(`std::fputs("${MARK}: armed after popup exec\\n", stderr); // ${MARK}`);
    const varAt = at(`    } aPkc3PopupWake; // ${MARK}\n`);
    const endifAt = at(`#endif // ${MARK}\n`);
    const execAt = at(EXEC_LINE);
    // 順序: aRect → #if → struct → timer → fputs → 変数 → #endif → exec
    expect(rectAt).toBeLessThan(ifAt);
    expect(ifAt).toBeLessThan(structAt);
    expect(structAt).toBeLessThan(timerAt);
    expect(timerAt).toBeLessThan(fputsAt);
    expect(fputsAt).toBeLessThan(varAt);
    expect(varAt).toBeLessThan(endifAt);
    expect(endifAt).toBeLessThan(execAt);
    // `aRect` の直後の行が `#if`(間に原文の行が挟まらない)
    expect(after).toContain(`${WAKE_ANCHOR}#if defined __EMSCRIPTEN__ // ${MARK}\n`);
    // timer は**デストラクタの中**(= 関数を出る時 = exec が返った後)
    const dtorAt = at(`        ~Pkc3PopupWake() // ${MARK}\n`);
    expect(structAt).toBeLessThan(dtorAt);
    expect(dtorAt).toBeLessThan(timerAt);
  });

  it('🔴 `#include` は file の頭(`sal/config.h` の直後)に無条件で 3 本足されている', () => {
    const after = patched();
    for (const inc of ['<cstdio>', '<QtCore/QTimer>', '<QtWidgets/QApplication>']) {
      expect(count(EXCERPT, `#include ${inc}`), `抜粋の前提(元には無い): ${inc}`).toBe(0);
    }
    expect(after).toContain(
      `#include <sal/config.h>\n#include <cstdio> // ${MARK}\n#include <QtCore/QTimer> // ${MARK}\n` +
        `#include <QtWidgets/QApplication> // ${MARK}\n`,
    );
    // 無条件: include の行は `#if` より前(`#if defined __EMSCRIPTEN__ // PKC3-POPUPWAKE` の中ではない)
    expect(after.indexOf('#include <QtCore/QTimer>')).toBeLessThan(after.indexOf(`#if defined __EMSCRIPTEN__ // ${MARK}`));
  });

  it('🔴 足した行は全部印を含み、原文の行は 1 行も書き換えない(印の行を除くと原文と一致)', () => {
    const after = patched();
    expect(after).not.toBe(EXCERPT); // 対照群: 何も足していないなら「一致」は空振り
    expect(restore(after)).toBe(EXCERPT);
    const added = after.split('\n').filter((l) => l.includes(MARK));
    expect(added.length).toBe(17); // include 3 + #if 1 + 注釈 4 + struct 7 + 変数 1(`} aPkc3PopupWake;`)+ #endif 1
    // 🔴 中身まで見る(⚠ 期待値は patch から取らず**手で書く** ── 同じ盲点を共有しない)
    const code = added.filter((l) => !/^\s*\/\/ /.test(l)).map((l) => l.trim());
    expect(code).toEqual([
      `#include <cstdio> // ${MARK}`,
      `#include <QtCore/QTimer> // ${MARK}`,
      `#include <QtWidgets/QApplication> // ${MARK}`,
      `#if defined __EMSCRIPTEN__ // ${MARK}`,
      `struct Pkc3PopupWake // ${MARK}`,
      `{ // ${MARK}`,
      `~Pkc3PopupWake() // ${MARK}`,
      `{ // ${MARK}`,
      `QTimer::singleShot(0, qApp, [] { GetQtInstance().TriggerUserEventProcessing(); }); // ${MARK}`,
      `std::fputs("${MARK}: armed after popup exec\\n", stderr); // ${MARK}`,
      `} // ${MARK}`,
      `} aPkc3PopupWake; // ${MARK}`,
      `#endif // ${MARK}`,
    ]);
  });

  it('🔴 非 wasm では include 3 行以外 1 行も変わらない(`#if`〜`#endif` を除くと、足した行は include だけ)', () => {
    const after = patched();
    const lines = after.split('\n');
    const open = lines.findIndex((l) => l === `#if defined __EMSCRIPTEN__ // ${MARK}`);
    const close = lines.findIndex((l) => l === `#endif // ${MARK}`);
    expect(open, '#if が無い').toBeGreaterThan(-1);
    expect(close, '#endif が無い').toBeGreaterThan(open);
    const outside = [...lines.slice(0, open), ...lines.slice(close + 1)];
    const marked = outside.filter((l) => l.includes(MARK));
    // wasm 以外のビルドへ届くのは include の 3 行だけ(本体は 1 行も届かない)
    expect(marked.every((l) => l.startsWith('#include <')), `#if の外に include 以外の足し行が在る:\n${marked.join('\n')}`).toBe(true);
    expect(marked.length).toBe(3);
    // 本体(`singleShot` / `struct`)は全部 `#if`〜`#endif` の内側
    expect(outside.join('\n')).not.toContain('QTimer::singleShot');
    expect(outside.join('\n')).not.toContain('Pkc3PopupWake');
  });
});

describe('#1344 の直し(popup-wake)── 描いた枝を g++ で動かす(stub の上で)', () => {
  /** 当てた結果の `#if defined __EMSCRIPTEN__ … #endif`(本体)だけを取り出す。 */
  function block(after: string): string {
    const a = after.indexOf(`#if defined __EMSCRIPTEN__ // ${MARK}\n`);
    const endMark = `#endif // ${MARK}\n`;
    const b = after.indexOf(endMark, a);
    expect(a > -1 && b > a, '本体の塊を取り出せない').toBe(true);
    return after.slice(a, b + endMark.length);
  }

  function compileAndRun(defineEmscripten: boolean): { code: number; out: string } {
    const dir = mkdtempSync(join(tmpdir(), 'pkc3-popupwake-gpp-'));
    try {
      const src = `#include <cstdio>
#include <functional>
#include <vector>
// ── stub(Qt / LO の header は無い。本物の呼び方だけ写す)──
struct QObject {};
struct QCoreApplication : QObject {};
[[maybe_unused]] static QCoreApplication g_app;
#define qApp (&g_app)
static std::vector<std::function<void()>> g_timers;
static std::vector<int> g_delays;
struct QTimer
{
    // 本物の \`singleShot(int, const QObject*, Functor)\` と同じ形
    template <class F> static void singleShot(int nMsec, const QObject*, F aFunc)
    {
        g_delays.push_back(nMsec);
        g_timers.push_back(aFunc);
    }
};
static int g_nTrigger = 0;
struct QtInstance { void TriggerUserEventProcessing() { ++g_nTrigger; } };
[[maybe_unused]] static QtInstance& GetQtInstance() { static QtInstance aInst; return aInst; }

static int g_nTimersDuringExec = -1;
// ShowNativePopupMenu の形: [struct] → exec(今は何も置かれていない) → return true
static bool ShowNativePopupMenu()
{
${block(patched())}
    g_nTimersDuringExec = static_cast<int>(g_timers.size()); // = exec() の最中
    return true;
}

int main()
{
    const bool bRet = ShowNativePopupMenu();
    std::printf("ret=%d during=%d armed=%zu\\n", bRet ? 1 : 0, g_nTimersDuringExec, g_timers.size());
    if (!g_delays.empty())
        std::printf("delay=%d\\n", g_delays[0]);
    std::printf("trigger-before=%d\\n", g_nTrigger);
    for (auto& f : g_timers)
        f();
    std::printf("trigger-after=%d\\n", g_nTrigger);
    return 0;
}
`;
      writeFileSync(join(dir, 't.cxx'), src, 'utf-8');
      const flags = ['-std=c++20', '-Wall', '-Wextra', '-Werror'];
      if (defineEmscripten) flags.push('-D__EMSCRIPTEN__');
      const cc = spawnSync('g++', [...flags, join(dir, 't.cxx'), '-o', join(dir, 't')], { encoding: 'utf-8', stdio: 'pipe' });
      expect(cc.status, cc.stderr).toBe(0);
      const r = spawnSync(join(dir, 't'), [], { encoding: 'utf-8', stdio: 'pipe' });
      return { code: r.status ?? -1, out: `${r.stdout}\n--stderr--\n${r.stderr}` };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('🔴 wasm: exec の最中はまだ置かれず、関数を出た後に 0 ms の timer が 1 つ置かれ、発火すると user event の drain を起こす', () => {
    const r = compileAndRun(true);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('ret=1 during=0 armed=1');
    expect(r.out).toContain('delay=0');
    expect(r.out).toContain('trigger-before=0');
    expect(r.out).toContain('trigger-after=1');
    expect(r.out).toContain('PKC3-POPUPWAKE: armed after popup exec');
  });

  it('🔴 非 wasm: 何も置かれず、印も出ない(原文のまま)', () => {
    const r = compileAndRun(false);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('ret=1 during=0 armed=0');
    expect(r.out).toContain('trigger-after=0');
    expect(r.out).not.toContain('PKC3-POPUPWAKE');
  });
});

/**
 * 🔴 **錨の区間が交わらない**(= 当てる順で結果が変わらない理由そのもの)。
 * ⚠ 「6 通りで同一」だけだと、**どれかの錨が空振りしても同一**になる(当たっていない)── 区間も直に見る。
 */
describe('#1344 の直し(popup-wake)── menu-trace / uev-trace と同じ QtMenu.cxx を触るが、錨が重ならない', () => {
  const load = (script: string): { targets: [string, string][]; helperTargets: [string, string][] } =>
    pyJson(script, '{"targets":[[t[0],t[1]] for t in m.TARGETS],"helperTargets":[[t[0],t[1]] for t in m.HELPER_TARGETS]}') as {
      targets: [string, string][];
      helperTargets: [string, string][];
    };
  const anchorsIn = (script: string): string[] => {
    const p = load(script);
    return [...p.targets, ...p.helperTargets].filter(([src]) => src === REL).map(([, a]) => a);
  };
  const spans = (anchors: string[]): [number, number][] =>
    anchors.map((a) => {
      expect(count(EXCERPT, a), `錨が 1 件でない:\n${a}`).toBe(1);
      const i = EXCERPT.indexOf(a);
      return [i, i + a.length];
    });
  const overlaps = (a: [number, number][], b: [number, number][]): string[] =>
    a.flatMap((x, i) => b.flatMap((y, j) => (x[0] < y[1] && y[0] < x[1] ? [`${i}×${j}`] : [])));

  it('🔴 こちらの 2 つの錨は、menu-trace(本体 4 + ヘルパー 1)/ uev-trace(ヘルパー + exec-ret)の錨と 1 バイトも重ならない', () => {
    const menu = anchorsIn(MENU_SCRIPT);
    const uev = anchorsIn(UEV_SCRIPT);
    expect(menu.length, '空振り防止: menu-trace の錨').toBe(5);
    expect(uev.length, '空振り防止: uev-trace の錨').toBe(2);
    expect(spans(FIX_ANCHORS).length).toBe(2);
    expect(overlaps(spans(FIX_ANCHORS), spans(menu)), 'menu-trace と重なっている').toEqual([]);
    expect(overlaps(spans(FIX_ANCHORS), spans(uev)), 'uev-trace と重なっている').toEqual([]);
  });

  const ORDERS: string[][] = [
    [SCRIPT, MENU_SCRIPT, UEV_SCRIPT],
    [SCRIPT, UEV_SCRIPT, MENU_SCRIPT],
    [MENU_SCRIPT, SCRIPT, UEV_SCRIPT],
    [MENU_SCRIPT, UEV_SCRIPT, SCRIPT],
    [UEV_SCRIPT, SCRIPT, MENU_SCRIPT],
    [UEV_SCRIPT, MENU_SCRIPT, SCRIPT],
  ];
  const FILES: Record<string, string> = {
    [REL]: EXCERPT,
    'vcl/source/window/menu.cxx': readFileSync(`${FX}/menu.excerpt.cxx`, 'utf-8'),
    'vcl/source/app/svapp.cxx': readFileSync(`${FX}/svapp.excerpt.cxx`, 'utf-8'),
    'vcl/source/app/salusereventlist.cxx': readFileSync(`${FX}/salusereventlist.excerpt.cxx`, 'utf-8'),
    'vcl/qt5/QtInstance.cxx': readFileSync(`${FX}/QtInstance.excerpt.cxx`, 'utf-8'),
  };

  for (const trace of ['1', '0']) {
    it(`🔴 3 本を 6 通りの順で当てて全 file が同一(diff -r 同値)。3 本とも入っている(計装 ${trace === '1' ? 'ON' : 'OFF'})`, () => {
      const env = { PKC3_MENU_TRACE: trace, PKC3_UEV_TRACE: trace };
      const outs: Record<string, string>[] = [];
      for (const order of ORDERS) {
        const t = tree(EXCERPT, Object.fromEntries(Object.entries(FILES).filter(([rel]) => rel !== REL)));
        try {
          for (const s of order) {
            const r = run(s, t.dir, env);
            expect(r.code, `${order.join(' → ')}\n${s}\n${r.out}`).toBe(0);
          }
          outs.push(Object.fromEntries(Object.keys(FILES).map((rel) => [rel, t.read(rel)])));
        } finally {
          t.cleanup();
        }
      }
      for (let i = 1; i < outs.length; i++) {
        for (const rel of Object.keys(FILES)) {
          expect(outs[i]![rel], `${rel}: 当てる順で出力が違う(${ORDERS[0]!.join(' → ')} と ${ORDERS[i]!.join(' → ')})`).toBe(
            outs[0]![rel],
          );
        }
      }
      const qtm = outs[0]![REL]!;
      // 空振りで「同一」になっていない: 直しは必ず入る / 計装は環境変数のとおり
      expect(qtm).toContain('QTimer::singleShot(0, qApp,');
      expect(qtm.includes('pkc3_menu_trace("exec:return"'), '計装 menu の有無が環境変数と合っていない').toBe(trace === '1');
      expect(qtm.includes('pkc3_uev_exec_ret();'), '計装 uev の有無が環境変数と合っていない').toBe(trace === '1');
      if (trace === '1') {
        // 順: aRect → 直しの struct → menu の exec:enter → exec → exec:return → uev の exec-ret → return true
        const at = (s: string): number => {
          expect(count(qtm, s), `「${s}」が 1 件でない`).toBe(1);
          return qtm.indexOf(s);
        };
        const rect = at('const QRect aRect = toQRect(');
        const st = at('struct Pkc3PopupWake');
        const enter = at('pkc3_menu_trace("exec:enter"');
        const exec = at('mpQMenu->exec(aRect.bottomLeft());');
        const ret = at('pkc3_menu_trace("exec:return"');
        const uev = at('pkc3_uev_exec_ret();');
        const retTrue = qtm.indexOf('    return true;\n}\n', uev);
        expect(rect < st && st < enter && enter < exec && exec < ret && ret < uev && uev < retTrue, '3 本の並びが想定と違う').toBe(true);
      }
    }, 120_000);
  }
});

describe('#1344 の直し(popup-wake)── 台帳(スコープ検査 / workflow)に載っている', () => {
  it('🔑 当て先が、スコープ検査(check-patch-scope.py)の一覧(FIXES)に載っている', () => {
    // ⚠ 一覧は手書き ── 足し忘れると、この patch だけ検査の外になる
    const scope = readFileSync('build/office-wasm/check-patch-scope.py', 'utf-8');
    const at = scope.indexOf('FIXES = [');
    expect(at, 'check-patch-scope.py に FIXES が無い').toBeGreaterThan(-1);
    const block = scope.slice(at, scope.indexOf('print("=== 本番(ヘルパーを持たない直し', at));
    expect(block).toContain('"patch-lo-popup-wake.py"');
    expect(block).toContain(`"${REL}"`);
    expect(block).toContain('"struct Pkc3PopupWake // PKC3-POPUPWAKE"');
    expect(block).toContain('"#include <cstdio> // PKC3-POPUPWAKE"');
  });

  it('🔑 workflow の本数の主張が、この 1 本を数えている(24 → 25)', () => {
    const yml = readFileSync('.github/workflows/office-wasm-build.yml', 'utf-8');
    expect(yml).toMatch(/24 → 25\(2026-10-05\)/);
    expect(yml).toContain('patch-lo-popup-wake.py');
    expect(yml).toContain('test "$n" -eq 25');
  });

  it('🔑 check-patches-on-ref.sh が拾える形(`SRC = "…"`)で当て先を宣言している', () => {
    const src = readFileSync(SCRIPT, 'utf-8');
    expect(src).toMatch(/^SRC\s*=\s*"vcl\/qt5\/QtMenu\.cxx"/m);
  });
});

describe('#1344 の直し(popup-wake)── スコープ検査(check-patch-scope.py の FIXES)を実際に走らせる', () => {
  const CHECK = 'build/office-wasm/check-patch-scope.py';
  const OTHERS = [
    'build/office-wasm/patch-lo-scheduler-task-gone.py',
    'build/office-wasm/patch-lo-menu-popup-sync.py',
    'build/office-wasm/patch-lo-ime-nowait.py',
  ];

  /** FIXES だけを走らせる(`PKC3_SCOPE_ONLY=fixes`)。⚠ FIXES は 4 本 ── 全部の当て先が木に要る。 */
  function scopeTree(): string {
    const dir = mkdtempSync(join(tmpdir(), 'pkc3-popupwake-scope-'));
    for (const [rel, body] of [
      [REL, EXCERPT],
      ['vcl/source/app/scheduler.cxx', readFileSync(`${FX}/scheduler.excerpt.cxx`, 'utf-8')],
      ['framework/source/uielement/menubarmanager.cxx', readFileSync(`${FX}/menubarmanager.excerpt.cxx`, 'utf-8')],
      ['vcl/source/window/winproc.cxx', readFileSync(`${FX}/winproc.excerpt.cxx`, 'utf-8')],
    ] as const) {
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      writeFileSync(join(dir, rel), body, 'utf-8');
    }
    return dir;
  }

  function scope(checkScript: string, dir: string): { code: number; out: string } {
    const r = spawnSync('python3', ['-B', checkScript, dir], {
      encoding: 'utf-8',
      env: { ...process.env, PKC3_SCOPE_ONLY: 'fixes' },
      stdio: 'pipe',
    });
    return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
  }

  /** この直しの行だけ(他の直しは ✅ のままなので、全体を見ると取り違える)。 */
  const mine = (out: string): string[] => out.split('\n').filter((l) => l.includes('patch-lo-popup-wake.py'));

  /**
   * 検査と直しの patch を**別の場所へ写し**、patch の描く C++ だけを壊して走らせる。
   * ⚠ 壊す前に「元の字が 1 件在る」ことを見る(当たらなかった変異を「落ちた」と読まない)。
   */
  function scopeWithBrokenPatch(from: string, to: string): { code: number; out: string } {
    const dir = mkdtempSync(join(tmpdir(), 'pkc3-popupwake-mut-'));
    const root = scopeTree();
    try {
      const src = readFileSync(SCRIPT, 'utf-8');
      expect(count(src, from), '壊す元の字が 1 件でない(変異が当たらない)').toBe(1);
      writeFileSync(join(dir, 'patch-lo-popup-wake.py'), src.replace(from, to), 'utf-8');
      for (const o of OTHERS) writeFileSync(join(dir, o.split('/').pop()!), readFileSync(o, 'utf-8'), 'utf-8');
      writeFileSync(join(dir, 'check-patch-scope.py'), readFileSync(CHECK, 'utf-8'), 'utf-8');
      return scope(join(dir, 'check-patch-scope.py'), root);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('🔴 抜粋に当てた木で、FIXES が ✅(exit 0)。この直しの行も ✅', () => {
    const root = scopeTree();
    try {
      const r = scope(CHECK, root);
      expect(r.code, r.out).toBe(0);
      const lines = mine(r.out);
      expect(lines.length, 'この直しの行が出ていない').toBe(1);
      expect(lines[0]).toContain('✅ 同じスコープ');
      expect(lines[0]).toContain('ShowNativePopupMenu の exec の後始末');
      expect(lines[0]).toContain('include 深さ 0');
      expect(r.out).toContain('fail=0');
      expect(r.out).not.toContain('元 file が無い');
      expect(r.out).not.toContain('🔴');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('🔴 局所 struct が 1 段深くなる(`{` が 1 つ増える)と ✗(exit ≠ 0)', () => {
    const from = '    struct Pkc3PopupWake // PKC3-POPUPWAKE\n';
    const r = scopeWithBrokenPatch(from, `    { // PKC3-POPUPWAKE\n${from}`);
    expect(r.code, r.out).toBe(1);
    const lines = mine(r.out);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain('スコープが違う');
    expect(lines[0]).not.toContain('✅ 同じスコープ');
    expect(r.out).toContain('fail=1');
  });

  it('🔴 `#include` が file scope でなくなる(`namespace { }` の中)と ✗', () => {
    const from = '#include <cstdio> // PKC3-POPUPWAKE\n';
    const r = scopeWithBrokenPatch(from, `namespace { // PKC3-POPUPWAKE\n${from}} // PKC3-POPUPWAKE\n`);
    expect(r.code, r.out).toBe(1);
    const lines = mine(r.out);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain('include 深さ 1');
    expect(lines[0]).toContain('スコープが違う');
  });
});
