/** @vitest-environment node */
/**
 * `build/office-wasm/patch-lo-ime-nowait.py` を検める(#121 の**直し**。取り下げた
 * `patch-lo-yield-proxy-guard.py` の直し直し)。
 *
 * 🔴 **直す物**: IME 入力の callback(`ImplHandleExtTextInput`)の中で、frame の focus event の保留を
 * `Application::Yield()` で**待つ**。wasm/JSPI ではこの callback の stack は中断できないので、
 * `Yield()` が積まれていた user event を dispatch すると `QtInstance::ProcessEvent` の
 * `emscripten_promise_await` が JS 例外になり、process ごと落ちる(計装 run 37234042770 で観測した
 * 落ちる**唯一**の経路)。直しは、Emscripten では LibreOfficeKit と同じ扱い ── 待たずに `break` する。
 *
 * 🔴 **取り下げた直し**: `Yield` **全体**を「proxy された yield の中でだけ dispatch」に締めたら、
 * **文書が開かなくなった**(読み込み中の入れ子 Yield も user event を処理しており、それが進行に必要)。
 * だから**この 1 か所だけ**を直す。⚠ 下の「`patch-lo-yield-proxy-guard.py` が存在しない」はその門。
 *
 * ⚠ 見るのは 7 つ:
 *   ① **錨が原文に当たる**(上流の原文から抜いた抜粋 ── 合成した物ではない)/ 1 つ外しても落ちる /
 *      二重当ては落ちて不変
 *   ② **直しの中身を、描いた結果で見る**: `Application::Yield();` は `#else` 側に**1 回だけ**残り、
 *      `#if` 側に `break;` が在る / LOK の 5 行は無傷 / 印のカウンタは file scope
 *   ③ **足した行は全部印を含み、原文の行は 1 行も書き換えない**(印の行を除くと原文と一致する)
 *   ④ 🔑 **描いた枝を g++ で動かす**(LO の header は無いので、枝の論理だけを stub の上で):
 *      wasm では待たずに抜け、印は 20 回で止まる / wasm 以外は原文のまま 200 回待つ / LOK は印も出さない
 *   ⑤ **`patch-lo-idles-trace.py`(同じ file を触る)と錨が重ならず、どの順でも出力が同一**
 *   ⑥ スコープ検査(`check-patch-scope.py` の FIXES)に載っている **+ 抜粋に対して実際に走らせる**
 *   ⑦ workflow の本数の主張(24)/ 取り下げた patch が**存在しない**
 *
 * 🔴 **言えないこと**: 当てた後の C++ が本物の LO の header でコンパイルできること /
 * 本物の JSPI で IME 入力が通ること / B2 の fault が消えること。どれも**焼いて、IME 入力の probe で
 * `PKC3-IMENOWAIT:` の行が出る**まで確かめられない(抜粋は上流の原文だが、全文ではない)。
 */
import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const SCRIPT = 'build/office-wasm/patch-lo-ime-nowait.py';
const IDLES_SCRIPT = 'build/office-wasm/patch-lo-idles-trace.py';
const POPUP_SYNC = 'build/office-wasm/patch-lo-menu-popup-sync.py';
const TASK_GONE = 'build/office-wasm/patch-lo-scheduler-task-gone.py';
const REL = 'vcl/source/window/winproc.cxx';
const MARK = 'PKC3-IMENOWAIT';
const EXCERPT = readFileSync('tests/fixtures/office-lo/winproc.excerpt.cxx', 'utf-8');
const MENU_EXCERPT = readFileSync('tests/fixtures/office-lo/menubarmanager.excerpt.cxx', 'utf-8');
const SCHED_EXCERPT = readFileSync('tests/fixtures/office-lo/scheduler.excerpt.cxx', 'utf-8');

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
const [INC_ANCHOR, COUNTER_ANCHOR, YIELD_ANCHOR] = FIX_ANCHORS as [string, string, string];

interface Tree {
  dir: string;
  read: (rel?: string) => string;
  cleanup: () => void;
}

function tree(body: string = EXCERPT, extra: Record<string, string> = {}): Tree {
  const dir = mkdtempSync(join(tmpdir(), 'pkc3-imenowait-'));
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

/** 数える(部分文字列の出現数)。 */
const count = (text: string, needle: string): number => text.split(needle).length - 1;

/**
 * 足した行(印を含む行)を取り除く。この直しは**原文の行を 1 行も書き換えない**(足すだけ)ので、
 * 取り除いた残りが原文と一致しなければ「足す以外」をしている。
 */
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

/** 上流の原文の `Application::Yield();`(8 字下げ。`ImplHandleExtTextInput` の while の中の 1 行)。 */
const YIELD_LINE = '        Application::Yield();\n';

describe('#121 の直し(ime-nowait)── 当て方', () => {
  it('🔑 空振り防止: 錨を拾えている / 抜粋が `ImplHandleExtTextInput` と `ImplHandleUserEvent` を含む', () => {
    expect(FIX_ANCHORS.length, '直しの錨を拾えていない').toBe(3);
    expect(new Set(FIX_ANCHORS).size, '同じ錨が在る').toBe(FIX_ANCHORS.length);
    expect(EXCERPT).toContain('static bool ImplHandleExtTextInput( vcl::Window* pWindow,');
    expect(EXCERPT).toContain('static void ImplHandleUserEvent( ImplSVEvent* pSVEvent )');
    // 🔑 抜粋は**原文のまま**(印も計装も入っていない)
    expect(EXCERPT).not.toContain('PKC3-');
  });

  it('🔴 錨は、上流の原文の抜粋に**ちょうど 1 件**ずつ当たる(`Yield` は LOK の塊で一意にしている)', () => {
    for (const a of FIX_ANCHORS) {
      expect(count(EXCERPT, a), `錨が 1 件でない:\n${a}`).toBe(1);
    }
    // ⚠ 対照群: 素の `Application::Yield();` の行は、この抜粋では 1 件だが、上流の file 全体には複数在る。
    //    だから錨に LOK の 5 行を含めている(含めない錨は上流で 1 件にならない)
    expect(YIELD_ANCHOR).toContain('comphelper::LibreOfficeKit::isActive()');
    // 補助 2 つの錨は、手で書いた期待値と一致する(include は無条件に `sal/config.h` の直後 / カウンタは関数の宣言の 1 行目)
    expect(INC_ANCHOR).toBe('#include <sal/config.h>\n');
    expect(COUNTER_ANCHOR).toBe('static bool ImplHandleExtTextInput( vcl::Window* pWindow,\n');
    expect(YIELD_ANCHOR.endsWith(YIELD_LINE), '錨が `Yield` の行で終わっていない').toBe(true);
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

  /** 🔴 錨を 1 つずつ外して、毎回落ちること。⚠ 落ちるだけでなく file が 1 バイトも変わらないこと。 */
  it('🔴 錨が 1 つでも無ければ落ちる。何も書かない', () => {
    for (let i = 0; i < FIX_ANCHORS.length; i++) {
      const broken = EXCERPT.replace(FIX_ANCHORS[i]!, '// 上流が形を変えた\n');
      expect(broken, `錨 ${i} を外せていない`).not.toBe(EXCERPT);
      const t = tree(broken);
      try {
        const r = run(SCRIPT, t.dir);
        expect(r.code, `錨 ${i} を外しても落ちない:\n${r.out}`).toBe(1);
        expect(r.out, `錨 ${i} の落ち方が「錨の欠落」でない`).toContain('錨が 0 件');
        expect(t.read(), '落ちたのに書き換えている').toBe(broken);
      } finally {
        t.cleanup();
      }
    }
  });

  it('🔴 錨が 2 件になっても落ちる(同じ形が上流に増えたら、どちらかを選ばない)', () => {
    for (let i = 0; i < FIX_ANCHORS.length; i++) {
      const doubled = `${EXCERPT}\n${FIX_ANCHORS[i]}`;
      const t = tree(doubled);
      try {
        const r = run(SCRIPT, t.dir);
        expect(r.code, `錨 ${i}\n${r.out}`).toBe(1);
        expect(r.out).toContain('錨が 2 件');
        expect(t.read()).toBe(doubled);
      } finally {
        t.cleanup();
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

describe('#121 の直し(ime-nowait)── 当てた結果(描いた C++ で見る)', () => {
  it('🔴 wasm は待たずに `break` し、原文の `Application::Yield();` は `#else` 側に 1 回だけ残る(順序で見る)', () => {
    const after = patched();
    const at = (needle: string): number => {
      expect(count(after, needle), `「${needle.trim()}」が 1 件でない`).toBe(1);
      return after.indexOf(needle);
    };
    const lokAt = at('        if (comphelper::LibreOfficeKit::isActive())\n');
    const ifAt = at('#if defined __EMSCRIPTEN__ // PKC3-IMENOWAIT\n        // PKC3-IMENOWAIT(#121):');
    const capAt = at('        if (g_nPkc3ImeNoWaitSaid < 20) // PKC3-IMENOWAIT\n');
    const fputsAt = at('std::fputs("PKC3-IMENOWAIT: focus event pending; not yielding on wasm\\n", stderr); // PKC3-IMENOWAIT');
    const breakAt = at('        break; // PKC3-IMENOWAIT\n');
    const elseAt = at('#else // PKC3-IMENOWAIT\n');
    const yieldAt = at(YIELD_LINE);
    const endifAt = at('        Application::Yield();\n#endif // PKC3-IMENOWAIT\n');
    // 順序: LOK の枝 → #if → 印の上限 → 印 → break → #else → 原文の Yield → #endif
    expect(lokAt).toBeLessThan(ifAt);
    expect(ifAt).toBeLessThan(capAt);
    expect(capAt).toBeLessThan(fputsAt);
    expect(fputsAt).toBeLessThan(breakAt);
    expect(breakAt).toBeLessThan(elseAt);
    expect(elseAt).toBeLessThan(yieldAt);
    expect(yieldAt, '`Yield` の行と `#endif` の組が同じ位置にある').toBe(endifAt);
    // 🔴 `Yield` は **`#else` 側に 1 回だけ**(#if 側に入っていない)── `break` が `#if` 側に在る
    expect(count(after, 'Application::Yield();')).toBe(count(EXCERPT, 'Application::Yield();'));
    expect(after.slice(ifAt, elseAt)).not.toContain('Application::Yield();');
    expect(after.slice(ifAt, elseAt)).toContain('break;');
    expect(after.slice(elseAt, endifAt)).not.toContain('break;');
  });

  it('🔴 LibreOfficeKit の 5 行は無傷(原文の字のまま、`break` も `SAL_WARN` も残る)', () => {
    const after = patched();
    const lok =
      '        if (comphelper::LibreOfficeKit::isActive())\n        {\n' +
      '            SAL_WARN("vcl", "Failed to get ext text input context");\n            break;\n        }\n';
    expect(count(EXCERPT, lok), '抜粋の前提(原文に 1 件)').toBe(1);
    expect(count(after, lok)).toBe(1);
    // LOK の塊の**直後**が wasm の `#if`(= LOK を先に抜ける。wasm の枝より前)
    expect(after).toContain(`${lok}#if defined __EMSCRIPTEN__ // ${MARK}\n`);
  });

  it('🔴 カウンタは file scope で、関数の**直前**(`#if __EMSCRIPTEN__` の中の無名 namespace)', () => {
    const after = patched();
    expect(after).toContain(
      `#if defined __EMSCRIPTEN__ // ${MARK}\nnamespace { int g_nPkc3ImeNoWaitSaid = 0; } // ${MARK}\n#endif // ${MARK}\n` +
        'static bool ImplHandleExtTextInput( vcl::Window* pWindow,\n',
    );
    // 使う所(関数の中)より前
    expect(after.indexOf('int g_nPkc3ImeNoWaitSaid = 0;')).toBeLessThan(after.indexOf('++g_nPkc3ImeNoWaitSaid;'));
    expect(count(after, 'g_nPkc3ImeNoWaitSaid = 0')).toBe(1);
  });

  it('🔴 `#include <cstdio>` が `sal/config.h` の**直後**に、無条件で足されている(`std::fputs` の宣言)', () => {
    const after = patched();
    expect(count(EXCERPT, '#include <cstdio>'), '抜粋の前提(元には無い)').toBe(0);
    expect(after).toContain(`#include <sal/config.h>\n#include <cstdio> // ${MARK}\n\n#include <o3tl/safeint.hxx>\n`);
    // 他の patch の有無に引きずられない: `#if` の中に入っていない(include の行の直前・直後が前処理でない)
    expect(after.indexOf('#include <cstdio>')).toBeLessThan(after.indexOf('std::fputs'));
  });

  it('🔴 足した行は全部印を含み、原文の行は 1 行も書き換えない(印の行を除くと原文と一致)', () => {
    const after = patched();
    // ⚠ 対照群: 当たった後が原文と違うこと(違わなければ、何も足していない)
    expect(after).not.toBe(EXCERPT);
    expect(restore(after)).toBe(EXCERPT);
    // 足した行は 18 行(include 1 + カウンタ 3 + `#if` 1 + 注釈 5 + 印の塊 5 + `break` 1 + `#else` 1 + `#endif` 1)
    const added = after.split('\n').filter((l) => l.includes(MARK));
    expect(added.length).toBe(18);
    // 🔴 中身まで見る: 件数と順序だけだと、注釈の 1 行を実行文に替える /
    //    注釈の行末に `\\` を足して次の宣言をコメントに連結する、という変異が緑のまま C++ を壊す。
    //    ⚠ 期待値は patch から取らず**手で書く**(同じ盲点を共有しない)。
    const code = added.filter((l) => !/^\s*\/\/ /.test(l)).map((l) => l.trim());
    expect(code).toEqual([
      `#include <cstdio> // ${MARK}`,
      `#if defined __EMSCRIPTEN__ // ${MARK}`,
      `namespace { int g_nPkc3ImeNoWaitSaid = 0; } // ${MARK}`,
      `#endif // ${MARK}`,
      `#if defined __EMSCRIPTEN__ // ${MARK}`,
      `if (g_nPkc3ImeNoWaitSaid < 20) // ${MARK}`,
      `{ // ${MARK}`,
      `++g_nPkc3ImeNoWaitSaid; // ${MARK}`,
      `std::fputs("${MARK}: focus event pending; not yielding on wasm\\n", stderr); // ${MARK}`,
      `} // ${MARK}`,
      `break; // ${MARK}`,
      `#else // ${MARK}`,
      `#endif // ${MARK}`,
    ]);
    for (const l of added) {
      expect(l, '行末の \\ は次の行をコメントへ連結する').not.toMatch(/\\\s*$/);
      expect(l, 'ブロックコメントは使わない').not.toMatch(/\/\*|\*\//);
    }
    // 注釈は 5 行で、全部 `//` 始まり(実行文を注釈の顔で足していない)
    expect(added.filter((l) => /^\s*\/\/ /.test(l)).length).toBe(5);
    // 括弧は釣り合っている(足した `{` と `}` の数が同じ)
    const braces = code.join('\n').replace(/"[^"]*"/g, '');
    expect(count(braces, '{')).toBe(count(braces, '}'));
    // `#if` と `#endif` の数が合う(`#else` は `#if` の中)
    expect(count(code.join('\n'), '#if ')).toBe(count(code.join('\n'), '#endif'));
  });
});

describe('#121 の直し(ime-nowait)── 描いた枝を g++ で動かす(枝の論理。LO の header は stub)', () => {
  /** 当てた後の file から `ImplHandleExtTextInput` の待ちの loop とカウンタを取り出して stub の上で動かす。 */
  function harness(after: string, wasm: boolean): string {
    const lines = after.split('\n');
    // カウンタ: `#if defined … // MARK` の直後が `namespace {` である 3 行
    const cStart = lines.findIndex((l, i) => l.startsWith('#if defined') && (lines[i + 1] ?? '').startsWith('namespace {'));
    expect(cStart, 'カウンタの塊を取り出せない').toBeGreaterThan(-1);
    const counter = lines.slice(cStart, cStart + 3).join('\n');
    expect(counter).toContain('g_nPkc3ImeNoWaitSaid');
    // loop: `int nTries = 200;` から、`// If it is the first ExtTextInput call` の前まで
    const lStart = lines.findIndex((l) => l === '    int nTries = 200;');
    const lEnd = lines.findIndex((l, i) => i > lStart && l.startsWith('    // If it is the first ExtTextInput call'));
    expect(lStart, 'loop を取り出せない').toBeGreaterThan(-1);
    expect(lEnd).toBeGreaterThan(lStart);
    const loop = lines.slice(lStart, lEnd).join('\n');
    expect(loop).toContain('Application::Yield();');
    return `#include <cstdio>
#include <cstring>
${wasm ? '#define __EMSCRIPTEN__ 1\n' : ''}
static bool g_bLok = false;
static int g_nYields = 0;
namespace comphelper { namespace LibreOfficeKit { static bool isActive() { return g_bLok; } } }
#define SAL_WARN(area, msg) ((void)0)
struct FrameData { int mnFocusId; };
struct WindowImpl { FrameData* mpFrameData; };
struct Win { WindowImpl maImpl; WindowImpl* ImplGetWindowImpl() { return &maImpl; } };
struct WinData { Win* mpExtTextInputWin; };
struct ImplSVData { WinData* mpWinData; };
static Win* ImplGetKeyInputWindow(Win* p) { return p; }
struct Application { static void Yield() { ++g_nYields; } };
${counter}
static bool Run(Win* pWindow, ImplSVData* pSVData)
{
    Win* pChild = nullptr;
${loop}
    (void)pChild;
    return true;
}
int main(int argc, char** argv)
{
    const char* mode = argc > 1 ? argv[1] : "";
    g_bLok = std::strcmp(mode, "lok") == 0;
    FrameData fd{ std::strcmp(mode, "nofocus") == 0 ? 0 : 1 };
    Win w{ { &fd } };
    WinData wd{ nullptr };
    ImplSVData sv{ &wd };
    for (int i = 0; i < 25; ++i)
        Run(&w, &sv);
    std::printf("yields=%d\\n", g_nYields);
    return 0;
}
`;
  }

  function build(wasm: boolean): { bin: string; dir: string } {
    const dir = mkdtempSync(join(tmpdir(), 'pkc3-imenowait-h-'));
    writeFileSync(join(dir, 't.cxx'), harness(patched(), wasm), 'utf-8');
    const cc = spawnSync('g++', ['-std=c++17', '-Wall', '-Wextra', '-Werror', join(dir, 't.cxx'), '-o', join(dir, 't')], {
      encoding: 'utf-8',
      stdio: 'pipe',
    });
    expect(cc.status, cc.stderr).toBe(0);
    return { bin: join(dir, 't'), dir };
  }

  const exec = (bin: string, mode: string): { out: string; marks: number } => {
    const r = spawnSync(bin, [mode], { encoding: 'utf-8', stdio: 'pipe' });
    expect(r.status, r.stderr).toBe(0);
    return { out: r.stdout.trim(), marks: r.stderr.split('\n').filter((l) => l.startsWith('PKC3-IMENOWAIT:')).length };
  };

  it('🔴 wasm: focus event が保留でも待たない(Yield 0 回)。印は 20 回で止まる。保留が無ければ / LOK なら印も出ない', () => {
    const { bin, dir } = build(true);
    try {
      // 保留あり: 25 回呼んでも Yield は 0、印は 20(上限で止まる)
      const pending = exec(bin, 'pending');
      expect(pending.out).toBe('yields=0');
      expect(pending.marks, '印が 20 回で止まっていない').toBe(20);
      // 保留なし(`mnFocusId == 0`): そもそも待たない。印も出ない(= 枝に入っていない)
      const nofocus = exec(bin, 'nofocus');
      expect(nofocus.out).toBe('yields=0');
      expect(nofocus.marks).toBe(0);
      // LOK: 原文の枝で先に抜ける。wasm の枝(印)には入らない
      const lok = exec(bin, 'lok');
      expect(lok.out).toBe('yields=0');
      expect(lok.marks).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('🔴 wasm でない build(`#else`)は原文のまま: 保留の間 `Yield` を 200 回待ち、印は出ない', () => {
    const { bin, dir } = build(false);
    try {
      const pending = exec(bin, 'pending');
      // 25 呼び出し × 200 回(`nTries`)。⚠ 対照群: wasm の側は 0 になる(上の test)
      expect(pending.out).toBe('yields=5000');
      expect(pending.marks).toBe(0);
      expect(exec(bin, 'lok').out).toBe('yields=0');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('#121 の直し(ime-nowait)── `patch-lo-idles-trace.py`(同じ file)と、錨が重ならずどの順でも出力が同一', () => {
  const IDLES_TARGETS = pyJson(IDLES_SCRIPT, '[{"src":t[0],"anchor":t[1]} for t in m.TARGETS]') as {
    src: string;
    anchor: string;
  }[];
  const IDLES_HELPERS = pyJson(IDLES_SCRIPT, '[{"src":t[0],"anchor":t[1]} for t in m.HELPER_TARGETS]') as {
    src: string;
    anchor: string;
  }[];
  const IDLES_WIN = [...IDLES_HELPERS, ...IDLES_TARGETS].filter((t) => t.src === REL);

  /** idles-trace が当たる winproc.cxx 以外の file は、錨を並べただけの版で足りる(本物の上流 file は repo に無い)。 */
  function synth(src: string): string {
    const anchors = [...IDLES_HELPERS, ...IDLES_TARGETS]
      .filter((t) => t.src === src)
      .map((t) => t.anchor)
      .sort((x, y) => y.length - x.length);
    let text = '';
    for (const a of anchors) if (!text.includes(a)) text += `${a}\n`;
    return text;
  }
  const OTHER_SRCS = [...new Set([...IDLES_HELPERS, ...IDLES_TARGETS].map((t) => t.src))].filter((s) => s !== REL);

  function root(): Tree {
    const extra: Record<string, string> = {};
    for (const s of OTHER_SRCS) extra[s] = synth(s);
    return tree(EXCERPT, extra);
  }

  it('🔑 空振り防止: idles-trace が winproc.cxx に当てる錨を拾え、抜粋に**ちょうど 1 件**ずつ在る', () => {
    expect(IDLES_WIN.length, 'idles-trace の winproc の錨を拾えていない').toBeGreaterThanOrEqual(2);
    expect(OTHER_SRCS.length, 'idles-trace の他の当て先を拾えていない').toBeGreaterThanOrEqual(3);
    for (const t of IDLES_WIN) expect(count(EXCERPT, t.anchor), `idles の錨が 1 件でない:\n${t.anchor}`).toBe(1);
  });

  it('🔴 錨の範囲が**重ならない**(原文の中で、2 本の錨が占める区間が交わらない)', () => {
    const span = (a: string): [number, number] => [EXCERPT.indexOf(a), EXCERPT.indexOf(a) + a.length];
    for (const idles of IDLES_WIN) {
      const [is, ie] = span(idles.anchor);
      for (const mine of FIX_ANCHORS) {
        const [ms, me] = span(mine);
        expect(ie <= ms || me <= is, `錨が重なる:\n${idles.anchor}\n--\n${mine}`).toBe(true);
      }
    }
  });

  for (const trace of ['1', '0']) {
    it(`🔴 2 通りの順で当てて winproc.cxx が同一(PKC3_IDLES_TRACE=${trace})。2 本とも入っている`, () => {
      const orders = [
        [SCRIPT, IDLES_SCRIPT],
        [IDLES_SCRIPT, SCRIPT],
      ];
      const outs: string[] = [];
      for (const order of orders) {
        const t = root();
        try {
          for (const s of order) {
            const r = run(s, t.dir, { PKC3_IDLES_TRACE: trace });
            expect(r.code, `${order.join(' → ')}\n${s}\n${r.out}`).toBe(0);
          }
          outs.push(t.read());
        } finally {
          t.cleanup();
        }
      }
      expect(outs[1], `当てる順で出力が違う: ${orders[0]!.join(' → ')} と ${orders[1]!.join(' → ')}`).toBe(outs[0]);
      const out = outs[0]!;
      // 2 本とも空振りで「同一」になっていない
      expect(out).toContain('break; // PKC3-IMENOWAIT');
      expect(out.includes('pkc3_idles_trace("uev:in"'), '計装の有無が環境変数と合っていない').toBe(trace === '1');
      if (trace === '1') {
        // 🔑 `uev:in` / `uev:out` は `ImplHandleUserEvent` の中(直しの `ImplHandleExtTextInput` の後)
        expect(out.indexOf('break; // PKC3-IMENOWAIT')).toBeLessThan(out.indexOf('pkc3_idles_trace("uev:in"'));
        expect(out).toContain('pkc3_idles_trace("uev:out"');
      }
    }, 120_000);
  }

  it('🔴 直しを**先に**当てても、idles-trace の錨は全部 1 件ずつ残っている(計装が外れない)', () => {
    const t = root();
    try {
      expect(run(SCRIPT, t.dir).code).toBe(0);
      const text = t.read();
      for (const a of IDLES_WIN) {
        expect(count(text, a.anchor), `直しの後に idles の錨が 1 件でない:\n${a.anchor}`).toBe(1);
      }
    } finally {
      t.cleanup();
    }
  });

  it('🔴 逆も: 計装を**先に**当てても、この直しの錨は 1 件ずつ残っている(直しが外れない)', () => {
    const t = root();
    try {
      expect(run(IDLES_SCRIPT, t.dir, { PKC3_IDLES_TRACE: '1' }).code).toBe(0);
      const text = t.read();
      for (const a of FIX_ANCHORS) expect(count(text, a), `計装の後に錨が 1 件でない:\n${a}`).toBe(1);
    } finally {
      t.cleanup();
    }
  });
});

describe('#121 の直し(ime-nowait)── 他の検査との関係', () => {
  it('🔑 当て先が、スコープ検査(check-patch-scope.py)の一覧(FIXES)に載っている', () => {
    // ⚠ 一覧は手書き ── 足し忘れると、この patch だけ検査の外になる
    const scope = readFileSync('build/office-wasm/check-patch-scope.py', 'utf-8');
    const at = scope.indexOf('FIXES = [');
    expect(at, 'check-patch-scope.py に FIXES が無い').toBeGreaterThan(-1);
    const block = scope.slice(at, scope.indexOf('print("=== 本番(ヘルパーを持たない直し', at));
    expect(block).toContain('"patch-lo-ime-nowait.py"');
    expect(block).toContain(`"${REL}"`);
    expect(block).toContain('"if (g_nPkc3ImeNoWaitSaid < 20) // PKC3-IMENOWAIT"');
    expect(block).toContain('"#include <cstdio> // PKC3-IMENOWAIT"');
  });

  it('🔑 workflow の本数の主張が、この 1 本を数えている(23 → 24)', () => {
    const yml = readFileSync('.github/workflows/office-wasm-build.yml', 'utf-8');
    expect(yml).toMatch(/23 → 24\(2026-10-04\)/);
    expect(yml).toContain('patch-lo-ime-nowait.py');
    expect(yml).toContain('test "$n" -eq 24');
  });

  it('🔑 実在する `patch-*.py` が 24 本(workflow の `-eq` と同じ数。glob と同じ集合)', () => {
    const files = readdirSync('build/office-wasm').filter((f) => /^patch-.*\.py$/.test(f));
    expect(files.length).toBe(24);
    expect(files).toContain('patch-lo-ime-nowait.py');
  });

  it('🔴 取り下げた `patch-lo-yield-proxy-guard.py` は存在せず、台帳(FIXES / workflow の本数)にも載っていない', () => {
    expect(existsSync('build/office-wasm/patch-lo-yield-proxy-guard.py')).toBe(false);
    expect(existsSync('tests/office-yield-proxy-guard-patch.test.ts')).toBe(false);
    const scope = readFileSync('build/office-wasm/check-patch-scope.py', 'utf-8');
    expect(scope).not.toContain('patch-lo-yield-proxy-guard');
    expect(scope).not.toContain('PKC3-YIELDGUARD');
  });

  it('🔑 check-patches-on-ref.sh が拾える形(`SRC = "…"`)で当て先を宣言している', () => {
    const src = readFileSync(SCRIPT, 'utf-8');
    expect(src).toMatch(/^SRC\s*=\s*"vcl\/source\/window\/winproc\.cxx"/m);
  });
});

describe('#121 の直し(ime-nowait)── スコープ検査(check-patch-scope.py の FIXES)を実際に走らせる', () => {
  const CHECK = 'build/office-wasm/check-patch-scope.py';

  /** FIXES だけを走らせる(`PKC3_SCOPE_ONLY=fixes`)。⚠ FIXES は 3 本 ── 全部の当て先が木に要る。 */
  function scopeTree(): string {
    const dir = mkdtempSync(join(tmpdir(), 'pkc3-imenowait-scope-'));
    for (const [rel, body] of [
      [REL, EXCERPT],
      ['framework/source/uielement/menubarmanager.cxx', MENU_EXCERPT],
      ['vcl/source/app/scheduler.cxx', SCHED_EXCERPT],
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
  const mine = (out: string): string[] => out.split('\n').filter((l) => l.includes('patch-lo-ime-nowait.py'));

  /**
   * 検査と直しの patch を**別の場所へ写し**、patch の描く C++ だけを壊して走らせる。
   * ⚠ 検査は `HERE`(自分の置き場)から patch を引くので、写した先の patch が当たる。
   * ⚠ 壊す前に「元の字が 1 件在る」ことを見る(当たらなかった変異を「落ちた」と読まない)。
   */
  function scopeWithBrokenPatch(from: string, to: string): { code: number; out: string } {
    const dir = mkdtempSync(join(tmpdir(), 'pkc3-imenowait-mut-'));
    const root = scopeTree();
    try {
      const src = readFileSync(SCRIPT, 'utf-8');
      expect(count(src, from), '壊す元の字が 1 件でない(変異が当たらない)').toBe(1);
      writeFileSync(join(dir, 'patch-lo-ime-nowait.py'), src.replace(from, to), 'utf-8');
      writeFileSync(join(dir, 'patch-lo-menu-popup-sync.py'), readFileSync(POPUP_SYNC, 'utf-8'), 'utf-8');
      writeFileSync(join(dir, 'patch-lo-scheduler-task-gone.py'), readFileSync(TASK_GONE, 'utf-8'), 'utf-8');
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
      expect(lines[0]).toContain('ImplHandleExtTextInput の待ちの分岐');
      expect(lines[0]).toContain('include 深さ 0');
      expect(r.out).toContain('fail=0');
      expect(r.out).not.toContain('元 file が無い');
      expect(r.out).not.toContain('🔴');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('🔴 `if (g_nPkc3ImeNoWaitSaid < 20)` が 1 段深くなる(`{` が 1 つ増える)と ✗(exit ≠ 0)', () => {
    // ⚠ 字下げではなく**括弧**で深さが決まる(検査は `{` `}` を数える)
    const from = '        if (g_nPkc3ImeNoWaitSaid < 20) // PKC3-IMENOWAIT\n';
    const r = scopeWithBrokenPatch(from, `        { // PKC3-IMENOWAIT\n${from}`);
    expect(r.code, r.out).toBe(1);
    const lines = mine(r.out);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain('スコープが違う');
    expect(lines[0]).not.toContain('✅ 同じスコープ');
    expect(r.out).toContain('fail=1');
  });

  it('🔴 `#include` が file scope でなくなる(`namespace { }` の中)と ✗', () => {
    const from = '#include <cstdio> // PKC3-IMENOWAIT\n';
    const r = scopeWithBrokenPatch(from, `namespace { // PKC3-IMENOWAIT\n${from}} // PKC3-IMENOWAIT\n`);
    expect(r.code, r.out).toBe(1);
    const lines = mine(r.out);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain('include 深さ 1');
    expect(lines[0]).toContain('スコープが違う');
  });
});
