/** @vitest-environment node */
/**
 * `build/office-wasm/patch-lo-hop-borrow.py` を検める(#1408 の候補 (c) の**直し**)。
 *
 * 🔴 **何を直すか**: `vcl/qt5/QtInstance.cxx`(上流 `d6226c1a`)の `QtInstance::EmscriptenLightweightRunInMainThread_` は、本体スレッドから main へ
 * 関数を渡すとき `SolarMutexReleaser` で SolarMutex を**手放してから**渡し、main の lambda が `SolarMutexGuard` で取り直す。
 * 本体スレッドが別の osl::Mutex(Z)を持ったままここへ入ると、その隙に main の Qt イベントが SolarMutex を取って Z を要求し(busy-wait)、
 * 本体は hop から戻って SolarMutex を取り直せない ── 鍵の順序の逆転(実測 1/150)。
 * 直しは、手放さずに main へ貸す(`QtYieldMutex::m_bNoYieldLock`。重い経路 `doAcquire` と同じ作法)。持っていない呼び手は従来どおり。
 *
 * ⚠ 見るのは:
 *   ① **錨が原文に当たる**(上流の file そのまま)/ 1 つ外しても落ちる(file は不変)/ 当て済みは **SKIP(exit 0)で file は 1 バイトも変わらない** /
 *      印が欠けた file・多い file は SKIP せず exit 1
 *   ② **足した行以外は不変**: 原文の hop の 10 行は `#if 0` の中に**そのまま**残り、足した行は全部印を含む。`#if` は引数の中に挟まない
 *   ③ **描いた C++ を g++ + pthread で動かす**(LO の header は stub。対照群は**当てていない原文**):
 *      借りて走る(旗が func の間だけ立つ・本体が持ち続ける・main は SolarMutexGuard を作らない・Releaser を作らない)/
 *      持っていない呼び手は従来どおり main が取る / 入れ子は旗に触らない / func が投げても旗が戻る
 *      ⚠ `emscripten_sync_run_in_main_runtime_thread` は**関数ではなく可変長 macro**(Emscripten 4.0.10 `threading_legacy.h:180`)── harness はその字を fixture
 *      (`tests/fixtures/emscripten/threading_legacy-4.0.10.excerpt.h`)から取り込む。lambda を macro の引数に直書きすると最上位カンマで引数が割れて落ちる(直し前の形を再現して見る)
 *   ④ workflow の本数の主張がこの 1 本を数えている / 上流の実 file(在れば)へ本当に当たる / 同じ file の `patch-lo-yield-wait.py` と順序に依らず同一
 *
 * 🔴 **言えないこと**: 当てた後の C++ が本物の LO / Emscripten の header でコンパイルできること(手元の harness は型だけ stub)/
 * 鍵なしで走る呼び手が無いこと(持っていない呼び手は従来どおり取るので新しい穴は作らないが、静的には数え切れない)/
 * main が func の中で Qt のイベントループを回した場合(借りた鍵の下でイベントが走る)/ 1/150 の形が消えたこと(次の焼き)。
 */
import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const SCRIPT = 'build/office-wasm/patch-lo-hop-borrow.py';
const YIELD_SCRIPT = 'build/office-wasm/patch-lo-yield-wait.py';
const REL = 'vcl/qt5/QtInstance.cxx';
const MARK = 'PKC3-HOPBORROW';
const EXCERPT = readFileSync('tests/fixtures/office-lo/QtInstance-hop.excerpt.cxx', 'utf-8');
const YIELD_EXCERPT = readFileSync('tests/fixtures/office-lo/QtYieldMutex.excerpt.cxx', 'utf-8');
/** Emscripten 4.0.10 `threading_legacy.h` の宣言と macro(字のまま。`emscripten_sync_run_in_main_runtime_thread` は**関数ではなく可変長 macro**)。
 *  版は `.github/workflows/office-wasm-build.yml` の `emsdk` 入力の既定と並べる(下の test が突き合わせる)。 */
const EM_LEGACY = readFileSync('tests/fixtures/emscripten/threading_legacy-4.0.10.excerpt.h', 'utf-8');
/** 上流の実 file(在る箱でだけ回す。CI には無いので skip ── 実物の錨は焼く前の `check-patches-on-ref.sh` が見る)。 */
const UPSTREAM = process.env['PKC3_LO_UP'] ?? '';
/** 足す行の数(注釈 + 実行文 + `#if 0` / `#else` / `#endif`)。数え直したら理由を 1 行書く。
 * 43 → 45: lambda を macro の呼び出しの外へ出した(macro の引数は `( )` でしか守られず、最上位カンマで割れるため)。分割しても行数は変わらず、
 * その理由の注釈 2 行(`PKC3-HOPBORROW` つき)だけが増えた。 */
const ADDED = 45;

/** python の module から値を取り出す(⚠ 錨の字をここへ書き写さない)。 */
function pyJson(script: string, expr: string): unknown {
  const code = [
    'import importlib.util,sys,json',
    'sys.dont_write_bytecode=True',
    `sp=importlib.util.spec_from_file_location("p","${script}")`,
    'm=importlib.util.module_from_spec(sp); sp.loader.exec_module(m)',
    `print(json.dumps(${expr}))`,
  ].join('\n');
  return JSON.parse(execFileSync('python3', ['-c', code], { encoding: 'utf-8', stdio: 'pipe' }));
}

const FIX_ANCHORS = pyJson(SCRIPT, '[a for a,_ in m.PARTS]') as string[];

interface Tree {
  dir: string;
  read: () => string;
  cleanup: () => void;
}

function tree(body: string = EXCERPT): Tree {
  const dir = mkdtempSync(join(tmpdir(), 'pkc3-hopborrow-'));
  mkdirSync(dirname(join(dir, REL)), { recursive: true });
  writeFileSync(join(dir, REL), body, 'utf-8');
  return {
    dir,
    read: () => readFileSync(join(dir, REL), 'utf-8'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function run(script: string, dir: string): { code: number; out: string } {
  const r = spawnSync('python3', [script, dir], { encoding: 'utf-8', stdio: 'pipe' });
  return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
}

/** 数える(部分文字列の出現数)。 */
const count = (text: string, needle: string): number => text.split(needle).length - 1;

/** 足した行(印を含む行)を取り除く。この直しは**原文の行を 1 行も書き換えない**(`#if 0` の中に残す)。 */
function restore(text: string): string {
  return text
    .split('\n')
    .filter((l) => !l.includes(MARK))
    .join('\n');
}

function patched(): string {
  const t = tree();
  try {
    expect(run(SCRIPT, t.dir).code).toBe(0);
    return t.read();
  } finally {
    t.cleanup();
  }
}

/** `EmscriptenLightweightRunInMainThread_` の本体(関数の頭から、閉じの `}` まで)。 */
function lightweightFn(text: string): string {
  const at = text.indexOf('void QtInstance::EmscriptenLightweightRunInMainThread_(std::function<void()> func)');
  expect(at, 'EmscriptenLightweightRunInMainThread_ が無い').toBeGreaterThan(-1);
  const end = text.indexOf('\n}\n', at);
  expect(end).toBeGreaterThan(at);
  return text.slice(at, end + 3);
}

/** 当てた後の `#else` から `#endif`(印つき)の間 = 実際にコンパイルされる側。 */
function liveBranch(after: string): string {
  const fn = lightweightFn(after);
  const from = fn.indexOf(`#else // ${MARK}\n`);
  const to = fn.indexOf(`#endif // ${MARK}\n`);
  expect(from, '#else が無い').toBeGreaterThan(-1);
  expect(to).toBeGreaterThan(from);
  return fn.slice(from, to);
}

/** `#if 0` から `#else` の間 = コンパイルされない側(上流の原文が残る)。 */
function deadBranch(after: string): string {
  const fn = lightweightFn(after);
  const from = fn.indexOf(`#if 0 // ${MARK}\n`);
  const to = fn.indexOf(`#else // ${MARK}\n`);
  expect(from, '#if 0 が無い').toBeGreaterThan(-1);
  expect(to).toBeGreaterThan(from);
  return fn.slice(from, to);
}

describe('#1408 hop-borrow ── 当て方', () => {
  it('🔑 空振り防止: 錨を拾えている(0 件でも「全部当たった」は真になる)', () => {
    expect(FIX_ANCHORS.length, '錨を拾えていない').toBe(1);
    expect(EXCERPT, '抜粋が空').toContain('void QtInstance::EmscriptenLightweightRunInMainThread_(std::function<void()> func)');
    expect(EXCERPT, '抜粋に RunInMainThread が無い').toContain('void QtInstance::RunInMainThread(std::function<void()> func)');
    expect(EXCERPT.endsWith('}\n')).toBe(true);
    expect(EXCERPT.endsWith('\n\n')).toBe(false);
  });

  it('🔴 錨は、上流の原文に**ちょうど 1 件**ずつ当たる', () => {
    for (const a of FIX_ANCHORS) {
      expect(count(EXCERPT, a), `錨が 1 件でない:\n${a}`).toBe(1);
    }
  });

  it('🔴 毎回当たる(入力で gate しない)。当てると印が入り、file が変わる', () => {
    const t = tree();
    try {
      const r = run(SCRIPT, t.dir);
      expect(r.code, r.out).toBe(0);
      expect(r.out).toContain('patched:');
      expect(t.read()).not.toBe(EXCERPT);
      expect(t.read()).toContain(MARK);
    } finally {
      t.cleanup();
    }
  });

  it('🔴 冪等: 当て済みは SKIP(exit 0)で、file は 1 バイトも変わらない', () => {
    const t = tree();
    try {
      expect(run(SCRIPT, t.dir).code).toBe(0);
      const once = t.read();
      const r = run(SCRIPT, t.dir);
      expect(r.code, r.out).toBe(0);
      expect(r.out).toContain('SKIP');
      expect(t.read()).toBe(once);
      expect(count(t.read(), `#if 0 // ${MARK}`)).toBe(1);
    } finally {
      t.cleanup();
    }
  });

  it('🔴 印が在るのに足りない file(部分適用 / 手編集)は SKIP しない ── exit 1 で file は不変', () => {
    const partial = EXCERPT.replace(FIX_ANCHORS[0]!, `#if 0 // ${MARK}\n` + FIX_ANCHORS[0]!);
    expect(partial, '部分適用の形を作れていない').not.toBe(EXCERPT);
    const t = tree(partial);
    try {
      const r = run(SCRIPT, t.dir);
      expect(r.code, r.out).toBe(1);
      expect(r.out).not.toContain('SKIP');
      expect(r.out).toContain('部分適用');
      expect(t.read(), '部分適用の file を書き換えた').toBe(partial);
    } finally {
      t.cleanup();
    }
  });

  it('🔴 当てた後から印を 1 行消した file も SKIP しない(行数が期待と違う = exit 1)', () => {
    const t = tree();
    try {
      expect(run(SCRIPT, t.dir).code).toBe(0);
      const full = t.read();
      const dropped = full.replace(`#endif // ${MARK}\n`, '');
      expect(dropped).not.toBe(full);
      writeFileSync(join(t.dir, REL), dropped, 'utf-8');
      const r = run(SCRIPT, t.dir);
      expect(r.code, r.out).toBe(1);
      expect(r.out).not.toContain('SKIP');
      expect(t.read()).toBe(dropped);
    } finally {
      t.cleanup();
    }
  });

  it('🔴 当てた後に印の行を 1 行**足した** file も SKIP しない(行数が期待より多い = exit 1 で不変)', () => {
    const t = tree();
    try {
      expect(run(SCRIPT, t.dir).code).toBe(0);
      const full = t.read();
      const extra = full.replace(`#endif // ${MARK}\n`, `#endif // ${MARK}\n// ${MARK} extra\n`);
      expect(extra).not.toBe(full);
      writeFileSync(join(t.dir, REL), extra, 'utf-8');
      const r = run(SCRIPT, t.dir);
      expect(r.code, r.out).toBe(1);
      expect(r.out).not.toContain('SKIP');
      expect(t.read(), '印が多い file を書き換えた').toBe(extra);
    } finally {
      t.cleanup();
    }
  });

  it('🔴 錨が無ければ落ちる(exit 1)。何も書かない', () => {
    const broken = EXCERPT.replace(FIX_ANCHORS[0]!, '// 上流が形を変えた\n');
    expect(broken, '錨を外せていない').not.toBe(EXCERPT);
    const t = tree(broken);
    try {
      const r = run(SCRIPT, t.dir);
      expect(r.code, `錨を外しても落ちない:\n${r.out}`).toBe(1);
      expect(r.out, '落ち方が「錨の欠落」でない').toContain('錨が 0 件');
      expect(t.read(), '落ちたのに書き換えている').toBe(broken);
    } finally {
      t.cleanup();
    }
  });

  it('🔴 錨が 1 字違っても落ちる(上流が hop の引数を変えたら、黙って通さない)', () => {
    const broken = EXCERPT.replace('EM_FUNC_SIG_WITH_N_PARAMETERS(1)', 'EM_FUNC_SIG_WITH_N_PARAMETERS(2)');
    expect(broken).not.toBe(EXCERPT);
    const t = tree(broken);
    try {
      const r = run(SCRIPT, t.dir);
      expect(r.code, r.out).toBe(1);
      expect(r.out).toContain('錨が 0 件');
      expect(t.read()).toBe(broken);
    } finally {
      t.cleanup();
    }
  });

  it('🔴 錨が 2 件になっても落ちる(同じ形が増えたら、どちらかを選ばない)', () => {
    const doubled = `${EXCERPT}\n${FIX_ANCHORS[0]}`;
    const t = tree(doubled);
    try {
      const r = run(SCRIPT, t.dir);
      expect(r.code, r.out).toBe(1);
      expect(r.out).toContain('錨が 2 件');
      expect(t.read()).toBe(doubled);
    } finally {
      t.cleanup();
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

describe('#1408 hop-borrow ── 当てた結果(描いた C++ で見る)', () => {
  it('🔴 足した行は全部 mark を含む。原文の行は 1 行も書き換えない(`#if 0` の中に残る)', () => {
    const after = patched();
    expect(after).not.toBe(EXCERPT);
    expect(restore(after)).toBe(EXCERPT);
    const added = after.split('\n').filter((l) => l.includes(MARK));
    expect(added.length).toBe(ADDED);
    // 印の無い足し行が無い(原文の行集合に無い行は、全部印を含む)
    const origLines = new Set(EXCERPT.split('\n'));
    const bare = after.split('\n').filter((l) => !origLines.has(l) && !l.includes(MARK));
    expect(bare, '印の無い足し行').toEqual([]);
    for (const l of added) {
      expect(l, '行末の \\ は次の行をコメントへ連結する').not.toMatch(/\\\s*$/);
      expect(l, 'ブロックコメントは使わない').not.toMatch(/\/\*|\*\//);
    }
    // 括弧は釣り合っている(文字列と行コメントを除いて `{` と `}` の数が同じ)
    const braces = added
      .filter((l) => !/^\s*\/\/ /.test(l))
      .map((l) => l.replace(/"[^"]*"/g, '').replace(/\/\/.*$/, ''))
      .join('\n');
    expect(count(braces, '{')).toBe(count(braces, '}'));
    // `#if` と `#endif` の数が合う(足したのは `#if 0` 1 + `#endif` 1。`#else` は `#if` の中)
    const dir = (text: string, d: RegExp): number => text.split('\n').filter((l) => d.test(l)).length;
    expect(dir(after, /^#if\b/) - dir(EXCERPT, /^#if\b/)).toBe(1);
    expect(dir(after, /^#endif\b/) - dir(EXCERPT, /^#endif\b/)).toBe(1);
    expect(dir(after, /^#else\b/) - dir(EXCERPT, /^#else\b/)).toBe(1);
  });

  it('🔴 上流の hop の 10 行は `#if 0` の中に**そのまま**残り、無効側に `SolarMutexReleaser` と `SolarMutexGuard` がある', () => {
    const after = patched();
    const dead = deadBranch(after);
    expect(dead).toBe(`#if 0 // ${MARK}\n${FIX_ANCHORS[0]}`);
    expect(count(dead, 'SolarMutexReleaser release;')).toBe(1);
    expect(count(dead, 'SolarMutexGuard g;')).toBe(1);
  });

  it('🔴 `#if` は呼び出しの**引数の中に挟まない**: `#if 0` は `emscripten_sync_run_in_main_runtime_thread` の前、`#else` / `#endif` は呼び出しの `);` の後', () => {
    const after = patched();
    const fn = lightweightFn(after);
    const ifAt = fn.indexOf(`#if 0 // ${MARK}`);
    const call1 = fn.indexOf('emscripten_sync_run_in_main_runtime_thread(');
    const elseAt = fn.indexOf(`#else // ${MARK}`);
    const call2 = fn.indexOf('emscripten_sync_run_in_main_runtime_thread( // ' + MARK);
    const endAt = fn.indexOf(`#endif // ${MARK}`);
    expect(ifAt).toBeGreaterThan(-1);
    expect(ifAt).toBeLessThan(call1);
    // 無効側の呼び出しは `&func);` で終わってから `#else`
    expect(fn.slice(call1, elseAt).trimEnd().endsWith('&func);')).toBe(true);
    // 有効側の呼び出しは `&aPkc3Hop);` で終わってから `#endif`
    expect(call2).toBeGreaterThan(elseAt);
    expect(fn.slice(call2, endAt).trimEnd().endsWith(`&aPkc3Hop); // ${MARK}`)).toBe(true);
    // 呼び出しの引数の間に前処理行が無い(有効側の `emscripten_sync_run…(` から `);` まで)
    const callText = fn.slice(call2, fn.indexOf('&aPkc3Hop);', call2));
    expect(callText.split('\n').some((l) => l.startsWith('#'))).toBe(false);
    // 全体は `if (pthread_self() != …)` の枝の中で、`return;` が `#endif` の後に残る
    expect(fn.indexOf('return;', endAt)).toBeGreaterThan(endAt);
  });

  it('🔴 有効側(コンパイルされる側): `SolarMutexReleaser` を作らない / `m_bNoYieldLock` を立てて戻す(1 件ずつ)/ `SolarMutexGuard` は持っていない呼び手の枝だけ', () => {
    // ⚠ 注釈は落として数える(注釈が `SolarMutexGuard` / `SolarMutexReleaser` の字を持っていても、実行文の数は変わらない)
    const live = liveBranch(patched())
      .split('\n')
      .filter((l) => !/^\s*\/\/ /.test(l))
      .map((l) => l.replace(/\/\/.*$/, ''))
      .join('\n');
    expect(live, '有効側が Releaser を作っている').not.toContain('SolarMutexReleaser');
    expect(count(live, 'm_bNoYieldLock = true;')).toBe(1);
    expect(count(live, 'm_bNoYieldLock = false;')).toBe(1);
    expect(count(live, 'SolarMutexGuard '), 'Guard が 1 件でない(持っていない呼び手の枝だけ)').toBe(1);
    // Guard は `if (!pHop->bHeld)` の枝の中(その枝は `return;` で抜ける = 借りる側に Guard を残さない)
    const guard = live.indexOf('SolarMutexGuard aPkc3Guard;');
    const heldIf = live.indexOf('if (!pHop->bHeld)');
    const retAfter = live.indexOf('return;', guard);
    const setTrue = live.indexOf('m_bNoYieldLock = true;');
    expect(heldIf).toBeGreaterThan(-1);
    expect(heldIf).toBeLessThan(guard);
    expect(retAfter).toBeGreaterThan(guard);
    expect(retAfter).toBeLessThan(setTrue);
    // 旗を立てる前に、入れ子の判定(既に立っていれば触らない)
    expect(live).toContain('!pHop->pMutex->m_bNoYieldLock');
    expect(live).toContain('if (aPkc3Borrow.bSet)');
    // 戻しはデストラクタ(func が投げても戻る)。`func` の呼び出しは旗を立てた後
    expect(live).toContain('~Pkc3Borrow()');
    expect(live.indexOf('(*pHop->pFunc)();', setTrue)).toBeGreaterThan(setTrue);
    // 持っているかは hop の**前**に本体スレッドで取る(main では取れない)
    expect(live.indexOf('IsCurrentThread()')).toBeLessThan(live.indexOf('emscripten_sync_run_in_main_runtime_thread('));
    // `DBG_TESTNOTSOLARMUTEX()` は残す(借りる前の main は持っていない)
    expect(live).toContain('DBG_TESTNOTSOLARMUTEX();');
  });

  it('🔴 `GetYieldMutex()` の cast は同じ file の `RunInMainThread` と同じ形(`static_cast<QtYieldMutex*>(GetYieldMutex())`)で、`friend` を足していない', () => {
    const after = patched();
    expect(EXCERPT).toContain('QtYieldMutex* const pMutex(static_cast<QtYieldMutex*>(GetYieldMutex()));');
    expect(liveBranch(after)).toContain('static_cast<QtYieldMutex*>(GetYieldMutex())');
    expect(after).not.toContain('friend');
    expect(after).not.toContain('#define private');
  });

  it('🔴 原文の他の所は動かない: `RunInMainThread` と `useCairo` の手前までは 1 字も変わらない', () => {
    const after = patched();
    const head = EXCERPT.slice(0, EXCERPT.indexOf('void QtInstance::EmscriptenLightweightRunInMainThread_('));
    expect(after.startsWith(head)).toBe(true);
    expect(head).toContain('void QtInstance::RunInMainThread(std::function<void()> func)');
    // 関数の末尾(`#endif` の後の `func();`)も同じ
    expect(after.endsWith('#endif\n    func();\n}\n')).toBe(true);
  });
});

describe('#1408 hop-borrow ── 描いた C++ を g++ + pthread で動かす(LO / Emscripten の header は stub。対照群は当てていない原文)', () => {
  /** 関数を取り出し、型だけ stub の上で動かす。⚠ 関数の中身は当てた後 / 原文のまま取り出す(期待値を手で書かない)。 */
  function harness(text: string): string {
    const fn = lightweightFn(text);
    return `#include <atomic>
#include <condition_variable>
#include <cstdarg>
#include <cstdio>
#include <cstring>
#include <functional>
#include <mutex>
#include <string>
#include <thread>
#include <pthread.h>
#define __EMSCRIPTEN__ 1
#define ENABLE_QT6 1
#define HAVE_EMSCRIPTEN_JSPI 1
#define HAVE_EMSCRIPTEN_PROXY_TO_PTHREAD 0
#define EM_FUNC_SIG_RETURN_VALUE_V 0
#define EM_FUNC_SIG_WITH_N_PARAMETERS(n) (n)
#define EM_FUNC_SIG_SET_PARAM(i, t) (t)
#define EM_FUNC_SIG_PARAM_P 1

static pthread_t g_mainId;
static bool IsMain() { return pthread_equal(pthread_self(), g_mainId) != 0; }
static pthread_t emscripten_main_runtime_thread_id() { return g_mainId; }

static int g_mainAcquires = 0; // main が**本当に**取った回数(借りて素通りした回は数えない)
static int g_releasers = 0; // SolarMutexReleaser を作った回数
static int g_dbgViolations = 0; // DBG_TESTNOTSOLARMUTEX: hop の入口で main が既に持っていた回数

namespace comphelper
{
class SolarMutex
{
public:
    virtual ~SolarMutex() = default;
    std::mutex m_aMutex;
    std::atomic<std::thread::id> m_owner{ std::thread::id() };
    virtual bool IsCurrentThread() const { return m_owner.load() == std::this_thread::get_id(); }
    void acquire() { doAcquire(1); }
    unsigned release() { return doRelease(); }
    virtual void doAcquire(unsigned) { m_aMutex.lock(); m_owner = std::this_thread::get_id(); }
    virtual unsigned doRelease() { m_owner = std::thread::id(); m_aMutex.unlock(); return 1; }
};
}

struct QtYieldMutex : comphelper::SolarMutex
{
    bool m_bNoYieldLock = false; // main だけが触る
    bool IsCurrentThread() const override
    {
        if (IsMain() && m_bNoYieldLock) return true;
        return SolarMutex::IsCurrentThread();
    }
    void doAcquire(unsigned n) override
    {
        if (IsMain())
        {
            if (m_bNoYieldLock) return;
            ++g_mainAcquires;
        }
        SolarMutex::doAcquire(n);
    }
    unsigned doRelease() override
    {
        if (IsMain() && m_bNoYieldLock) return 1;
        return SolarMutex::doRelease();
    }
};
static QtYieldMutex g_mutex;

struct SolarMutexGuard
{
    SolarMutexGuard() { g_mutex.acquire(); }
    ~SolarMutexGuard() { g_mutex.release(); }
};
struct SolarMutexReleaser
{
    unsigned mnReleased;
    SolarMutexReleaser() : mnReleased(g_mutex.IsCurrentThread() ? g_mutex.release() : 0) { ++g_releasers; }
    ~SolarMutexReleaser() { if (mnReleased) g_mutex.acquire(); }
};
#define DBG_TESTNOTSOLARMUTEX() do { if (g_mutex.IsCurrentThread()) ++g_dbgViolations; } while (0)

// ── main への「proxy」: 本体スレッドが積んで待ち、main の loop が走らせる
static std::mutex g_qm;
static std::condition_variable g_qcv;
static void (*g_fn)(void*) = nullptr;
static void* g_arg = nullptr;
static bool g_done = false;
static bool g_quit = false;
// 🔑 macro は fixture(Emscripten 4.0.10 の字のまま)。関数ではなく可変長 macro なので、引数は \`( )\` でしか守られない(\`{ }\` では割れる)。
// 実体は末尾 \`_\` の関数(本物は main へ proxy する。ここでは下の loop が受ける)。
// 🔑 g++ は parameter の \`__attribute__((nonnull))\` を -Wattributes で断る(clang は受ける)。fixture の字を変えず、この範囲だけ黙らせる。
#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wattributes"
extern "C"
{
${EM_LEGACY}
}
#pragma GCC diagnostic pop
extern "C" int emscripten_sync_run_in_main_runtime_thread_(EM_FUNC_SIGNATURE sig, void* func_ptr, ...)
{
    (void)sig;
    void (*fn)(void*) = reinterpret_cast<void (*)(void*)>(func_ptr);
    va_list ap;
    va_start(ap, func_ptr);
    void* arg = va_arg(ap, void*);
    va_end(ap);
    std::unique_lock<std::mutex> l(g_qm);
    g_fn = fn;
    g_arg = arg;
    g_done = false;
    g_qcv.notify_all();
    g_qcv.wait(l, [] { return g_done; });
    return 0;
}

class QtInstance
{
public:
    comphelper::SolarMutex* GetYieldMutex() { return &g_mutex; }
    void EmscriptenLightweightRunInMainThread_(std::function<void()> func);
};

${fn}
// ── 観測
static bool g_ran = false, g_ranOnMain = false, g_flagIn = false, g_ownsIn = false, g_workerOwnsIn = false, g_threw = false;
static bool g_flagAfter = false, g_nested = false, g_workerOwnsAfter = false, g_workerOwnsBefore = false;
static std::thread::id g_worker;

int main(int argc, char** argv)
{
    const std::string mode = argc > 1 ? argv[1] : "held";
    g_mainId = pthread_self();
    g_nested = mode == "nested";
    const bool held = mode != "unheld";
    const bool doThrow = mode == "throw";
    QtInstance qi;
    std::thread worker([&] {
        g_worker = std::this_thread::get_id();
        if (held) g_mutex.acquire();
        g_workerOwnsBefore = g_mutex.IsCurrentThread();
        qi.EmscriptenLightweightRunInMainThread_([&] {
            g_ran = true;
            g_ranOnMain = IsMain();
            g_flagIn = g_mutex.m_bNoYieldLock;
            g_ownsIn = g_mutex.IsCurrentThread();
            g_workerOwnsIn = g_mutex.m_owner.load() == g_worker;
            if (doThrow) throw 42;
        });
        g_workerOwnsAfter = g_mutex.IsCurrentThread();
        if (g_workerOwnsAfter) g_mutex.release();
        std::lock_guard<std::mutex> l(g_qm);
        g_quit = true;
        g_qcv.notify_all();
    });
    // main の loop
    for (;;)
    {
        std::unique_lock<std::mutex> l(g_qm);
        g_qcv.wait(l, [] { return g_fn != nullptr || g_quit; });
        if (g_fn == nullptr) break;
        void (*fn)(void*) = g_fn;
        void* arg = g_arg;
        g_fn = nullptr;
        l.unlock();
        if (g_nested) g_mutex.m_bNoYieldLock = true; // main が既に借りている最中に hop が来た形
        try { fn(arg); } catch (int) { g_threw = true; }
        g_flagAfter = g_mutex.m_bNoYieldLock;
        if (g_nested) g_mutex.m_bNoYieldLock = false;
        l.lock();
        g_done = true;
        g_qcv.notify_all();
    }
    worker.join();
    std::printf("ran=%d onMain=%d flagIn=%d ownsIn=%d workerOwnsIn=%d workerOwnsBefore=%d workerOwnsAfter=%d flagAfter=%d releasers=%d mainAcquires=%d dbg=%d threw=%d\\n",
                g_ran, g_ranOnMain, g_flagIn, g_ownsIn, g_workerOwnsIn, g_workerOwnsBefore, g_workerOwnsAfter, g_flagAfter, g_releasers, g_mainAcquires, g_dbgViolations, g_threw);
    return 0;
}
`;
  }

  /** コンパイルだけ(落ちてもよい)。⚠ LO は C++20/23 なので `-std=c++20`。 */
  function compile(text: string): { bin: string; dir: string; status: number; stderr: string } {
    const dir = mkdtempSync(join(tmpdir(), 'pkc3-hopborrow-h-'));
    writeFileSync(join(dir, 't.cxx'), harness(text), 'utf-8');
    const cc = spawnSync('g++', ['-std=c++20', '-Wall', '-Wextra', '-Werror', '-pthread', join(dir, 't.cxx'), '-o', join(dir, 't')], {
      encoding: 'utf-8',
      stdio: 'pipe',
    });
    return { bin: join(dir, 't'), dir, status: cc.status ?? -1, stderr: cc.stderr };
  }

  function build(text: string): { bin: string; dir: string } {
    const c = compile(text);
    expect(c.status, c.stderr).toBe(0);
    return { bin: c.bin, dir: c.dir };
  }

  /** 実行して `key=value` を取り出す。 */
  function exec(bin: string, mode: string): Record<string, number> {
    const r = spawnSync('timeout', ['-k', '2', '20', bin, mode], { encoding: 'utf-8', stdio: 'pipe' });
    expect(r.status, `mode=${mode} が終わらない / 落ちた:\n${r.stdout}${r.stderr}`).toBe(0);
    const o: Record<string, number> = {};
    for (const kv of r.stdout.trim().split(' ')) {
      const [k, v] = kv.split('=');
      o[k!] = Number(v);
    }
    return o;
  }

  /** 🔑 直し前(1 稿目)の形に戻す: lambda を macro の呼び出しの**引数の中**へ直書きする。⚠ 期待値を手で書かず、当てた後の字から組み替える。 */
  function lambdaInsideMacro(after: string): string {
    const decl = 'void (*const pPkc3Fn)(void*) = ';
    const lamEnd = `            }; // ${MARK}\n`;
    const callHead = `        emscripten_sync_run_in_main_runtime_thread( // ${MARK}\n`;
    const callTail = `            pPkc3Fn, &aPkc3Hop); // ${MARK}\n`;
    const a = after.indexOf(`        ${decl}`);
    const e = after.indexOf(lamEnd, a);
    const c = after.indexOf(callHead, e);
    const k = after.indexOf(callTail, c);
    expect(a, '前提: lambda の宣言が無い').toBeGreaterThan(-1);
    expect(e, '前提: lambda の閉じが無い').toBeGreaterThan(a);
    expect(c, '前提: macro の呼び出しが lambda の後に無い').toBeGreaterThan(e);
    expect(k, '前提: macro の末尾の行が無い').toBeGreaterThan(c);
    // lambda 本体(`+[](void* pf) {` から閉じの \`}\` まで)
    const lambda = after.slice(a + 8 + decl.length, e).replace(/\n$/, '') + '\n            }';
    const head = after.slice(c, k); // macro 呼び出しの頭 3 行
    return after.slice(0, a) + head + `            ${lambda}, // ${MARK}\n            &aPkc3Hop); // ${MARK}\n` + after.slice(k + callTail.length);
  }

  it('🔑 空振り防止: harness の macro は Emscripten 4.0.10 の字のまま(関数 stub ではない)。lambda 内の最上位カンマは macro の引数を割り、コンパイルで落ちる', () => {
    expect(EM_LEGACY).toContain('#define emscripten_sync_run_in_main_runtime_thread(sig, func_ptr, ...) emscripten_sync_run_in_main_runtime_thread_((sig), (void*)(func_ptr),##__VA_ARGS__)');
    const h = harness(EXCERPT);
    expect(h, 'harness が macro を取り込んでいない').toContain('#define emscripten_sync_run_in_main_runtime_thread(sig, func_ptr, ...)');
    expect(h, 'harness が関数 stub を持っている(macro を隠す)').not.toMatch(/static int emscripten_sync_run_in_main_runtime_thread\(/);
    // 対照・原文: 最上位カンマの無い lambda は macro でも通る(= 上流は今のまま焼ける)
    const ok = compile(EXCERPT);
    try {
      expect(ok.status, ok.stderr).toBe(0);
    } finally {
      rmSync(ok.dir, { recursive: true, force: true });
    }
    // 変異: 原文の lambda に最上位カンマを 1 行足す ── macro が本物なら引数が割れて落ちる
    const needle = '                SolarMutexGuard g;\n';
    expect(count(EXCERPT, needle), '前提: 足し先の行が 1 件でない').toBe(1);
    const mutated = EXCERPT.replace(needle, `${needle}                [[maybe_unused]] int aPkc3A = 1, aPkc3B = 2;\n`);
    const bad = compile(mutated);
    try {
      expect(bad.status, 'macro の引数の中の lambda にカンマを足してもコンパイルが通る ── harness が macro を本物の形で持っていない').not.toBe(0);
      expect(bad.stderr).toMatch(/error/);
    } finally {
      rmSync(bad.dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('🔴 直し前の形(lambda を macro の引数の中へ直書き)は、harness でコンパイルが落ちる。当てた後の形は通る', () => {
    const after = patched();
    const old = lambdaInsideMacro(after);
    expect(old, '前提: 組み替えが効いていない').not.toBe(after);
    expect(count(old, 'pPkc3Fn'), '前提: 関数ポインタが残っている').toBe(0);
    const bad = compile(old);
    try {
      expect(bad.status, '直し前の形がコンパイルを通った ── harness が macro の引数の割れを見ていない').not.toBe(0);
      // 落ちる理由まで見る(別の理由で落ちたのを「macro で割れた」と読まない)── レビューが g++ で再現した文言
      expect(bad.stderr).toMatch(/expected '\}' before '\)' token/);
    } finally {
      rmSync(bad.dir, { recursive: true, force: true });
    }
    const good = compile(after);
    try {
      expect(good.status, good.stderr).toBe(0);
    } finally {
      rmSync(good.dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('🔴 当てた後の lambda は macro の外に在る ── 中に最上位カンマを足しても引数は割れない', () => {
    const after = patched();
    const needle = `                Pkc3Hop* const pHop = static_cast<Pkc3Hop*>(pf); // ${MARK}\n`;
    expect(count(after, needle), '前提: 足し先の行が 1 件でない').toBe(1);
    const mutated = after.replace(needle, `${needle}                [[maybe_unused]] int aPkc3A = 1, aPkc3B = 2; // ${MARK}\n`);
    const c = compile(mutated);
    try {
      expect(c.status, c.stderr).toBe(0);
    } finally {
      rmSync(c.dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('🔴 持っている呼び手: Releaser を作らず、本体が持ち続けたまま main が旗を立てて走る。戻ったら旗が戻り、本体はまだ持っている', () => {
    const { bin, dir } = build(patched());
    try {
      const o = exec(bin, 'held');
      expect(o['ran'], 'func が走っていない').toBe(1);
      expect(o['onMain'], 'func が main で走っていない').toBe(1);
      expect(o['workerOwnsBefore'], '前提: hop の前に本体が持っている').toBe(1);
      expect(o['releasers'], 'SolarMutexReleaser を作っている(= 手放している)').toBe(0);
      expect(o['flagIn'], 'func の間に旗が立っていない').toBe(1);
      expect(o['ownsIn'], 'main が借りた鍵を持っていると見えない').toBe(1);
      expect(o['workerOwnsIn'], 'func の間に本体が手放している').toBe(1);
      expect(o['mainAcquires'], 'main が本当に鍵を取りに行った(借りていない)').toBe(0);
      expect(o['flagAfter'], 'hop の後に旗が戻っていない').toBe(0);
      expect(o['workerOwnsAfter'], 'hop の後に本体が持っていない').toBe(1);
      expect(o['dbg'], 'hop の入口で main が既に持っていた').toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('🔴 対照群(当てていない原文): 同じ場面で Releaser を作って手放し、main は本当に取りに行く ── 上の test がこの差を見ている', () => {
    const { bin, dir } = build(EXCERPT);
    try {
      const o = exec(bin, 'held');
      expect(o['ran']).toBe(1);
      expect(o['workerOwnsBefore']).toBe(1);
      expect(o['releasers'], '対照群の前提(原文は Releaser を作る)').toBe(1);
      expect(o['flagIn'], '対照群の前提(原文は旗を立てない)').toBe(0);
      expect(o['workerOwnsIn'], '対照群の前提(原文は func の間に手放している)').toBe(0);
      expect(o['mainAcquires'], '対照群の前提(原文は main が取る)').toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('🔴 持っていない呼び手: 従来どおり(旗を立てず、main が SolarMutexGuard で本当に取る)。借りる物が無いのに旗を立てて鍵なしで走らない', () => {
    const { bin, dir } = build(patched());
    try {
      const o = exec(bin, 'unheld');
      expect(o['ran']).toBe(1);
      expect(o['workerOwnsBefore'], '前提: 本体は持っていない').toBe(0);
      expect(o['flagIn'], '持っていないのに旗を立てた(= 鍵なしで走る)').toBe(0);
      expect(o['ownsIn'], 'func の間に main が鍵を持っていない').toBe(1);
      expect(o['mainAcquires'], 'main が取りに行っていない').toBe(1);
      expect(o['releasers']).toBe(0);
      expect(o['flagAfter']).toBe(0);
      expect(o['dbg']).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('🔴 入れ子: main が既に借りている最中(旗が立っている)の hop は旗に触らない ── 戻した後も立ったまま', () => {
    const { bin, dir } = build(patched());
    try {
      const o = exec(bin, 'nested');
      expect(o['ran']).toBe(1);
      expect(o['flagIn'], '前提: 入れ子の形(旗が立っている)になっていない').toBe(1);
      expect(o['flagAfter'], '外側が借りている旗を内側が戻した').toBe(1);
      expect(o['releasers']).toBe(0);
      expect(o['mainAcquires']).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('🔴 func が投げても旗は戻る(立ったまま戻らないと main の SolarMutexGuard が全部素通りになる)', () => {
    const { bin, dir } = build(patched());
    try {
      const o = exec(bin, 'throw');
      expect(o['ran']).toBe(1);
      expect(o['threw'], '前提: func が投げて main に届いた').toBe(1);
      expect(o['flagIn']).toBe(1);
      expect(o['flagAfter'], '投げた後に旗が立ったまま').toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('#1408 hop-borrow ── 上流の実 file へ', () => {
  const real = UPSTREAM ? join(UPSTREAM, REL) : '';
  it.skipIf(!real || !existsSync(real))('🔴 実 file へ当たる(exit 0)。足した行は 45・消した行は 0。2 度目は SKIP で不変', () => {
    const orig = readFileSync(real, 'utf-8');
    const t = tree(orig);
    try {
      const r = run(SCRIPT, t.dir);
      expect(r.code, r.out).toBe(0);
      const after = t.read();
      expect(after.split('\n').length - orig.split('\n').length).toBe(ADDED);
      expect(restore(after)).toBe(orig);
      const r2 = run(SCRIPT, t.dir);
      expect(r2.code, r2.out).toBe(0);
      expect(r2.out).toContain('SKIP');
      expect(t.read()).toBe(after);
    } finally {
      t.cleanup();
    }
  });

  it.skipIf(!real || !existsSync(real))('🔴 抜粋は実 file の原文そのまま(207〜266 行)', () => {
    const orig = readFileSync(real, 'utf-8').split('\n').slice(206, 266).join('\n') + '\n';
    expect(EXCERPT.endsWith(orig)).toBe(true);
  });
});

describe('#1408 hop-borrow ── 他の検査との関係', () => {
  it('🔑 同じ file を触る `patch-lo-yield-wait.py` と、錨が重ならずどの順でも出力が同一(抜粋 2 つを並べた版で)', () => {
    const yieldAnchors = pyJson(YIELD_SCRIPT, '[a for a,_ in m.PARTS]') as string[];
    for (const a of yieldAnchors) expect(count(EXCERPT, a), 'yield-wait の錨がこの抜粋に在る').toBe(0);
    for (const a of FIX_ANCHORS) expect(count(YIELD_EXCERPT, a), 'この錨が yield-wait の抜粋に在る').toBe(0);
    const both = `${YIELD_EXCERPT}\n${EXCERPT}`;
    const outs: string[] = [];
    for (const order of [
      [SCRIPT, YIELD_SCRIPT],
      [YIELD_SCRIPT, SCRIPT],
    ]) {
      const t = tree(both);
      try {
        for (const s of order) {
          const r = run(s, t.dir);
          expect(r.code, `${s}: ${r.out}`).toBe(0);
        }
        outs.push(t.read());
      } finally {
        t.cleanup();
      }
    }
    expect(outs[0]).toBe(outs[1]);
    expect(outs[0]).toContain('PKC3-YIELDWAIT');
    expect(outs[0]).toContain(MARK);
  });

  it('🔑 check-patches-on-ref.sh が拾える形(`SRC = "…"`)で当て先を宣言している', () => {
    const src = readFileSync(SCRIPT, 'utf-8');
    expect(src).toMatch(/^SRC\s*=\s*"vcl\/qt5\/QtInstance\.cxx"/m);
    const owners = readdirSync('build/office-wasm')
      .filter((f) => /^patch-.*\.py$/.test(f))
      .filter((f) => readFileSync(join('build/office-wasm', f), 'utf-8').includes(`"${REL}"`));
    expect(owners).toContain('patch-lo-hop-borrow.py');
  });

  it('🔑 macro の fixture の版(4.0.10)は workflow の `emsdk` 入力の既定と同じ(上げたら fixture を取り直す)', () => {
    const yml = readFileSync('.github/workflows/office-wasm-build.yml', 'utf-8');
    const m = /emsdk:\n\s+description: [^\n]*\n\s+default: '([^']+)'/.exec(yml);
    expect(m, 'workflow の emsdk 入力を拾えていない').not.toBeNull();
    expect(m![1]).toBe('4.0.10');
    expect(EM_LEGACY).toContain('Emscripten 4.0.10');
  });

  it('🔑 workflow の本数の主張が、この 1 本を数えている(34 → 35)', () => {
    const yml = readFileSync('.github/workflows/office-wasm-build.yml', 'utf-8');
    expect(yml).toMatch(/34 → 35\(2026-10-08\)/);
    expect(yml).toContain('patch-lo-hop-borrow.py');
    expect(yml).toContain('test "$n" -eq 35');
    expect(readdirSync('build/office-wasm').filter((f) => /^patch-.*\.py$/.test(f))).toContain('patch-lo-hop-borrow.py');
  });
});
