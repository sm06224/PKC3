/** @vitest-environment node */
/**
 * `build/office-wasm/patch-lo-yield-proxy-guard.py` を検める(#121 の**直し**)。
 *
 * 🔴 **直す物**: JSPI の wasm build で、main thread の**入力 callback の中**の `Application::Yield()`
 * (実測: `ImplHandleExtTextInput`)が、溜まっていた user event を `DispatchUserEvents` し、
 * `ProcessEvent` の `emscripten_promise_await`(中断できる stack でしか成立しない)が JS 例外になって
 * `libc++abi: terminating` → `RuntimeError: unreachable` で落ちる(計装 run 37234042770 の probe、3/3)。
 * 直しは「**proxy された yield の中でだけ** user event を dispatch する」: `DoYield` の proxy lambda が
 * 旗 `g_bPkc3InProxiedYield` を立てて戻し、`ImplYield` は旗が立っているときだけ dispatch。入れ子の
 * main-thread Yield では `DispatchUserEvents` を**飛ばして**(event は queue に残す)
 * `TriggerUserEventProcessing()` で loop を起こす。
 *
 * ⚠ 見るのは 7 つ:
 *   ① **錨が原文に当たる**(上流の原文から抜いた抜粋)/ 1 つ外しても落ちる / 二重当ては落ちて不変
 *   ② **直しの中身を、描いた C++ で見る**: 旗は file scope で `ImplYield` / lambda より前 /
 *      lambda の前後で true → 原文の呼び出し → false / `DispatchUserEvents` は `#if` 側が旗の中・
 *      `#else` 側が原文のままの**計 2 回** / `TriggerUserEventProcessing()` が guard の枝に在る / 印は 20 で止まる
 *   ③ **足した行は全部印を含み、原文の行は 1 行も書き換えない**(印の行を除くと原文と一致)
 *   ④ 🔑 **描いた枝を g++ で動かす**(Qt / LO の header は無いので、旗と枝の論理だけを stub の上で):
 *      入れ子の yield は dispatch せず Trigger し、印は 20 回で止まる / proxy された yield は dispatch する /
 *      旗は戻る / JSPI でない build は原文のまま毎回 dispatch する
 *   ⑤ 🔴 **同じ file に当たる他の 2 本(`patch-lo-idles-trace.py` / `patch-lo-qt-cjk-fonts.py`)と、
 *      6 通りの順で当てて出力が同一**(計装あり・なしの両方)。⚠ 直しを先に当てても計装の錨が外れない
 *   ⑥ スコープ検査(`check-patch-scope.py` の FIXES)に載っている **+ その FIXES を抜粋に対して実際に走らせる**
 *   ⑦ workflow の本数の主張が、この 1 本を数えている
 *
 * 🔴 **言えないこと**: 当てた後の C++ が本物の LO / Qt の header でコンパイルできること
 * (`HasUserEvents()` が `SalUserEventList` の public inline であることは上流 header を読んで確かめたが、
 * 焼くまで**コンパイルは確かめていない**)/ 本物の JSPI で入力 callback の Yield が落ちなくなること。
 * どちらも**焼いて、IME / popup の probe で `PKC3-YIELDGUARD:` の行が出て落ちない**まで確かめられない。
 */
import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const SCRIPT = 'build/office-wasm/patch-lo-yield-proxy-guard.py';
const IDLES_SCRIPT = 'build/office-wasm/patch-lo-idles-trace.py';
const CJK_SCRIPT = 'build/office-wasm/patch-lo-qt-cjk-fonts.py';
const REL = 'vcl/qt5/QtInstance.cxx';
const MARK = 'PKC3-YIELDGUARD';
const EXCERPT = readFileSync('tests/fixtures/office-lo/QtInstance.excerpt.cxx', 'utf-8');
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
  return JSON.parse(execFileSync('python3', ['-c', code], { encoding: 'utf-8', stdio: 'pipe' }));
}

const FIX_ANCHORS = pyJson(SCRIPT, '[a for a,_ in m.PARTS]') as string[];

interface Tree {
  dir: string;
  read: (rel?: string) => string;
  write: (body: string, rel?: string) => void;
  cleanup: () => void;
}

function tree(body: string = EXCERPT, extra: Record<string, string> = {}): Tree {
  const dir = mkdtempSync(join(tmpdir(), 'pkc3-yieldguard-'));
  const put = (b: string, rel: string = REL): void => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), b, 'utf-8');
  };
  put(body);
  for (const [rel, b] of Object.entries(extra)) put(b, rel);
  return {
    dir,
    read: (rel = REL) => readFileSync(join(dir, rel), 'utf-8'),
    write: put,
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

const DISPATCH = 'DispatchUserEvents(bHandleAllCurrentEvents)';
const PROXY_CALL = '                args.bWasEvent = args.This->DoYield(args.bWait, args.bHandleAllCurrentEvents);\n';

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

describe('#121 の直し(yield-proxy-guard)── 当て方', () => {
  it('🔑 空振り防止: 錨を拾えている(0 件でも「全部当たった」は真になる)', () => {
    expect(FIX_ANCHORS.length, '直しの錨を拾えていない').toBe(4);
    expect(new Set(FIX_ANCHORS).size, '同じ錨が 2 つ在る').toBe(FIX_ANCHORS.length);
    expect(EXCERPT, '抜粋が空').toContain('bool QtInstance::ImplYield(bool bWait, bool bHandleAllCurrentEvents)');
    expect(EXCERPT, '抜粋に印が入っている(原文でない)').not.toContain(MARK);
  });

  it('🔴 錨は、上流の原文の抜粋に**ちょうど 1 件**ずつ当たる', () => {
    for (const a of FIX_ANCHORS) {
      expect(count(EXCERPT, a), `錨が 1 件でない:\n${a}`).toBe(1);
    }
  });

  it('🔴 毎回当たる(入力で gate しない)。環境変数が無くても、あっても、印が入り file が変わる', () => {
    for (const env of [{} as Record<string, string>, { PKC3_IDLES_TRACE: '1' }]) {
      const t = tree();
      try {
        const r = run(SCRIPT, t.dir, env);
        expect(r.code, r.out).toBe(0);
        expect(t.read()).not.toBe(EXCERPT);
        expect(t.read()).toContain(MARK);
      } finally {
        t.cleanup();
      }
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
        expect(r.code, `錨 ${i}: ${r.out}`).toBe(1);
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

describe('#121 の直し(yield-proxy-guard)── 当てた結果(描いた C++ で見る)', () => {
  it('🔴 旗は file scope(深さ 0)に在り、`ImplYield` と `DoYield` の lambda より前に定義されている', () => {
    const after = patched();
    const at = (needle: string): number => {
      expect(count(after, needle), `「${needle.trim()}」が 1 件でない`).toBe(1);
      return after.indexOf(needle);
    };
    const flagAt = at('bool g_bPkc3InProxiedYield = false; // PKC3-YIELDGUARD');
    const saidAt = at('int g_nPkc3YieldGuardSaid = 0; // PKC3-YIELDGUARD');
    const implAt = at('bool QtInstance::ImplYield(bool bWait, bool bHandleAllCurrentEvents)\n');
    const lambdaAt = at('g_bPkc3InProxiedYield = true; // PKC3-YIELDGUARD');
    expect(flagAt).toBeLessThan(implAt);
    expect(saidAt).toBeLessThan(implAt);
    expect(implAt).toBeLessThan(lambdaAt);
    // 🔴 括弧の深さ: 旗の定義は `namespace { … }` の中(深さ 1)で、namespace 自体は file scope(深さ 0)
    //    ⚠ 注釈と文字列を落としてから数える(解説の `{` に満たされない)
    const code = (s: string): string =>
      s
        .split('\n')
        .map((l) => l.replace(/\/\/.*$/, '').replace(/"[^"]*"/g, '""'))
        .filter((l) => !l.startsWith('#'))
        .join('\n');
    const depthAt = (pos: number): number => {
      const head = code(after.slice(0, pos));
      return count(head, '{') - count(head, '}');
    };
    const nsAt = at('namespace // PKC3-YIELDGUARD');
    expect(depthAt(nsAt), 'namespace が file scope に無い').toBe(0);
    expect(depthAt(flagAt), '旗が namespace の中に無い').toBe(1);
    // 旗の `#if` は、使う側(`ImplYield` の分岐 / lambda)と**同じ条件**(字面が揃う)
    const jspiIf = '#if defined __EMSCRIPTEN__ && ENABLE_QT6 && HAVE_EMSCRIPTEN_JSPI && !HAVE_EMSCRIPTEN_PROXY_TO_PTHREAD';
    expect(count(after, `${jspiIf} // ${MARK}`)).toBe(2);
    // 旗の定義の前の `#if` と、後の `#endif`(= 旗は条件の中に閉じている)
    const ifBefore = after.lastIndexOf(`${jspiIf} // ${MARK}`, flagAt);
    const endifAfter = after.indexOf(`#endif // ${MARK}`, flagAt);
    expect(ifBefore).toBeGreaterThan(-1);
    expect(endifAfter).toBeGreaterThan(flagAt);
    expect(endifAfter, '旗の #endif が ImplYield を越えている').toBeLessThan(implAt);
  });

  it('🔴 DoYield の proxy lambda: 旗を立て → 原文の呼び出し → 旗を戻す(順序で見る)。lambda の中に 1 組だけ', () => {
    const after = patched();
    expect(count(EXCERPT, PROXY_CALL), '抜粋の前提(元は 1 件)').toBe(1);
    expect(count(after, PROXY_CALL)).toBe(1);
    const upAt = after.indexOf('g_bPkc3InProxiedYield = true; // PKC3-YIELDGUARD');
    const callAt = after.indexOf(PROXY_CALL);
    const downAt = after.indexOf('g_bPkc3InProxiedYield = false; // PKC3-YIELDGUARD\n', callAt);
    expect(count(after, 'g_bPkc3InProxiedYield = true;')).toBe(1);
    // ⚠ 旗の定義(`= false;` の初期化)も同じ字で終わるので、lambda の字下げ(16)つきで数える
    expect(count(after, '                g_bPkc3InProxiedYield = false; // PKC3-YIELDGUARD\n'), '旗を戻す行は lambda に 1 行').toBe(1);
    expect(upAt).toBeGreaterThan(-1);
    expect(upAt).toBeLessThan(callAt);
    expect(callAt).toBeLessThan(downAt);
    // 3 行は隣り合う(間に別の文が入っていない = 旗が立っている間に走るのは `DoYield` の 1 呼び出しだけ)
    expect(after.slice(upAt, downAt + 80)).toMatch(
      /^g_bPkc3InProxiedYield = true; \/\/ PKC3-YIELDGUARD\n {16}args\.bWasEvent = args\.This->DoYield\(args\.bWait, args\.bHandleAllCurrentEvents\);\n {16}g_bPkc3InProxiedYield = false; \/\/ PKC3-YIELDGUARD\n/,
    );
    // lambda の中(`[](void* p) {` と `},` の間)。この lambda は JSPI の `#if` の中に在る
    const lamAt = after.lastIndexOf('[](void* p) {', upAt);
    const lamEndAt = after.indexOf('&o3tl::temporary<Args>', downAt);
    expect(lamAt).toBeGreaterThan(-1);
    expect(lamEndAt).toBeGreaterThan(downAt);
    expect(after.slice(lamAt, upAt)).not.toContain('}');
    const jspiAt = after.lastIndexOf('#if defined __EMSCRIPTEN__ && ENABLE_QT6 && HAVE_EMSCRIPTEN_JSPI', upAt);
    expect(after.slice(jspiAt, upAt), 'lambda が JSPI の #if の外').not.toContain('#endif');
  });

  it('🔴 `DispatchUserEvents` は計 2 回: `#if` 側は旗の中、`#else` 側は原文のまま。guard の枝には無い', () => {
    const after = patched();
    expect(count(EXCERPT, DISPATCH), '抜粋の前提(元は 1 件)').toBe(1);
    expect(count(after, DISPATCH)).toBe(2);
    const at = (needle: string): number => {
      expect(count(after, needle), `「${needle.trim()}」が 1 件でない`).toBe(1);
      return after.indexOf(needle);
    };
    const origLine = `    bool wasEvent = ${DISPATCH};\n`;
    const guardedLine = `        wasEvent = ${DISPATCH}; // ${MARK}\n`;
    const ifAt = at(`    if (g_bPkc3InProxiedYield) // ${MARK}\n`);
    const guardedAt = at(guardedLine);
    const elseIfAt = at(`    else if (HasUserEvents()) // ${MARK}\n`);
    const trigAt = at(`        TriggerUserEventProcessing(); // ${MARK}\n`);
    const elseAt = at(`#else // ${MARK}\n`);
    const origAt = at(origLine);
    const endifAt = after.indexOf(`#endif // ${MARK}\n`, origAt);
    const nextAt = at('    if (!bHandleAllCurrentEvents && wasEvent)\n        return true;\n');
    const wasAt = at(`    bool wasEvent = false; // ${MARK}\n`);
    // 順序: 宣言 → 旗の分岐 → 旗の中の dispatch → 旗が無いとき(= 入れ子)の枝 → Trigger → #else → 原文 → #endif → 原文の続き
    expect(wasAt).toBeLessThan(ifAt);
    expect(ifAt).toBeLessThan(guardedAt);
    expect(guardedAt).toBeLessThan(elseIfAt);
    expect(elseIfAt).toBeLessThan(trigAt);
    expect(trigAt).toBeLessThan(elseAt);
    expect(elseAt).toBeLessThan(origAt);
    expect(origAt).toBeLessThan(endifAt);
    expect(endifAt).toBeLessThan(nextAt);
    // 🔴 旗の `if` の直下 1 文が dispatch(`else` の前に `{` が無い ── dispatch は旗の枝の中だけ)
    expect(after.slice(ifAt, elseIfAt)).toBe(
      `    if (g_bPkc3InProxiedYield) // ${MARK}\n        wasEvent = ${DISPATCH}; // ${MARK}\n`,
    );
    // 🔴 deferred の枝(`else if` から `#else` まで)に `DispatchUserEvents` は無い(在れば、skip していない)
    expect(count(after.slice(elseIfAt, elseAt), 'DispatchUserEvents')).toBe(0);
    // `SolarMutexGuard` は dispatch より前に在り、触っていない(guard の枝も錠を持ったまま)
    expect(after.indexOf('    SolarMutexGuard aGuard;\n')).toBeLessThan(wasAt);
  });

  it('🔴 印は先頭 20 回だけ: 数える旗は `< 20` の中で増え、`fputs` もその中。Trigger は回数に依らず毎回', () => {
    const after = patched();
    const lim = after.indexOf(`        if (g_nPkc3YieldGuardSaid < 20) // ${MARK}\n`);
    const inc = after.indexOf(`            ++g_nPkc3YieldGuardSaid; // ${MARK}\n`);
    const say = after.indexOf(
      `            std::fputs("PKC3-YIELDGUARD: user events deferred (nested main-thread yield)\\n", stderr); // ${MARK}\n`,
    );
    const trig = after.indexOf(`        TriggerUserEventProcessing(); // ${MARK}\n`);
    expect(lim, '上限の if が無い').toBeGreaterThan(-1);
    expect(lim).toBeLessThan(inc);
    expect(inc).toBeLessThan(say);
    expect(say).toBeLessThan(trig);
    // `< 20` の塊: `{` `++` `fputs` `}` が連続する(間に別の文が入って上限を外していない)
    expect(after.slice(lim, trig)).toBe(
      [
        `        if (g_nPkc3YieldGuardSaid < 20) // ${MARK}`,
        `        { // ${MARK}`,
        `            ++g_nPkc3YieldGuardSaid; // ${MARK}`,
        `            std::fputs("PKC3-YIELDGUARD: user events deferred (nested main-thread yield)\\n", stderr); // ${MARK}`,
        `        } // ${MARK}`,
        '',
      ].join('\n'),
    );
    // 20 は 1 か所だけ(他の数に替えた変異が、注釈の数字に満たされない)
    expect(count(after, '< 20')).toBe(1);
    // 印の字は `std::fputs` の 1 か所だけ(別の経路で出していない)
    expect(count(after, 'user events deferred (nested main-thread yield)')).toBe(1);
  });

  it('🔴 `#include <cstdio>` が `sal/config.h` の直後に足されている(`std::fputs` の宣言)', () => {
    const after = patched();
    expect(count(EXCERPT, '#include <cstdio>'), '抜粋の前提(元には無い)').toBe(0);
    expect(after).toContain(`#include <sal/config.h>\n#include <cstdio> // ${MARK}\n#include <config_emscripten.h>\n`);
    // include は file の頭(関数の外)に在り、fputs を使う所より前
    expect(after.indexOf('#include <cstdio>')).toBeLessThan(after.indexOf('std::fputs'));
  });

  it('🔴 足した行は全部印を含み、原文の行は 1 行も書き換えない(印の行を除くと原文と一致)', () => {
    const after = patched();
    // ⚠ 対照群: 当たった後が原文と違うこと(違わなければ、何も足していない)
    expect(after).not.toBe(EXCERPT);
    expect(restore(after)).toBe(EXCERPT);
    // 足した行は 30 行(include 1 + 旗 7 + ImplYield 20 + lambda 2)
    const added = after.split('\n').filter((l) => l.includes(MARK));
    expect(added.length).toBe(30);
    // 🔴 中身まで見る: 件数と順序だけだと、注釈の 1 行を `return;` に替える /
    //    注釈の行末に `\\` を足して次の宣言をコメントに連結する、という変異が緑のまま C++ を壊す。
    //    ⚠ 期待値は patch から取らず**手で書く**(同じ盲点を共有しない)。
    const code = added.filter((l) => !/^\s*\/\/ /.test(l)).map((l) => l.trim());
    const JSPI = '#if defined __EMSCRIPTEN__ && ENABLE_QT6 && HAVE_EMSCRIPTEN_JSPI && !HAVE_EMSCRIPTEN_PROXY_TO_PTHREAD';
    expect(code).toEqual([
      `#include <cstdio> // ${MARK}`,
      `${JSPI} // ${MARK}`,
      `namespace // ${MARK}`,
      `{ // ${MARK}`,
      `bool g_bPkc3InProxiedYield = false; // ${MARK}`,
      `int g_nPkc3YieldGuardSaid = 0; // ${MARK}`,
      `} // ${MARK}`,
      `#endif // ${MARK}`,
      `${JSPI} // ${MARK}`,
      `bool wasEvent = false; // ${MARK}`,
      `if (g_bPkc3InProxiedYield) // ${MARK}`,
      `wasEvent = DispatchUserEvents(bHandleAllCurrentEvents); // ${MARK}`,
      `else if (HasUserEvents()) // ${MARK}`,
      `{ // ${MARK}`,
      `if (g_nPkc3YieldGuardSaid < 20) // ${MARK}`,
      `{ // ${MARK}`,
      `++g_nPkc3YieldGuardSaid; // ${MARK}`,
      `std::fputs("PKC3-YIELDGUARD: user events deferred (nested main-thread yield)\\n", stderr); // ${MARK}`,
      `} // ${MARK}`,
      `TriggerUserEventProcessing(); // ${MARK}`,
      `} // ${MARK}`,
      `#else // ${MARK}`,
      `#endif // ${MARK}`,
      `g_bPkc3InProxiedYield = true; // ${MARK}`,
      `g_bPkc3InProxiedYield = false; // ${MARK}`,
    ]);
    for (const l of added) {
      expect(l, '行末の \\ は次の行をコメントへ連結する').not.toMatch(/\\\s*$/);
      expect(l, 'ブロックコメントは使わない').not.toMatch(/\/\*|\*\//);
    }
    // 注釈は 5 行で、全部 `//` 始まり(実行文を注釈の顔で足していない)
    expect(added.filter((l) => /^\s*\/\/ /.test(l)).length).toBe(5);
    // 括弧は釣り合っている(足した `{` と `}` の数が同じ。文字列の中は数えない)
    const braces = code.join('\n').replace(/"[^"]*"/g, '');
    expect(count(braces, '{')).toBe(count(braces, '}'));
    // `#if` と `#endif` / `#else` の数が合っている(足した前処理が閉じている)
    const pp = (re: RegExp): number => code.filter((l) => re.test(l)).length;
    expect(pp(/^#if /)).toBe(2);
    expect(pp(/^#endif/)).toBe(2);
    expect(pp(/^#else/)).toBe(1);
  });
});

describe('#121 の直し(yield-proxy-guard)── 描いた枝を g++ で動かす(旗と枝の論理。Qt / LO の header は stub)', () => {
  /** 当てた後の file から、枝の論理だけを取り出して stub の上で動かす。⚠ 取り出し方自体も検める。 */
  function harness(after: string, jspi: boolean): string {
    const lines = after.split('\n');
    // 旗の塊: 最初の `#if … // MARK` から `#endif // MARK` まで
    const flagStart = lines.findIndex((l) => l.startsWith('#if defined') && l.includes(MARK));
    const flagEnd = lines.findIndex((l, i) => i > flagStart && l === `#endif // ${MARK}`);
    expect(flagStart, '旗の塊を取り出せない').toBeGreaterThan(-1);
    expect(flagEnd).toBeGreaterThan(flagStart);
    // ImplYield の枝: 2 つ目の `#if … // MARK` から `#endif // MARK` まで
    const yStart = lines.findIndex((l, i) => i > flagEnd && l.startsWith('#if defined') && l.includes(MARK));
    const yEnd = lines.findIndex((l, i) => i > yStart && l === `#endif // ${MARK}`);
    expect(yStart, 'ImplYield の枝を取り出せない').toBeGreaterThan(-1);
    expect(yEnd).toBeGreaterThan(yStart);
    // lambda の 3 行(旗 → 呼び出し → 旗)
    const up = lines.findIndex((l) => l.includes(`g_bPkc3InProxiedYield = true; // ${MARK}`));
    expect(up).toBeGreaterThan(-1);
    const proxied = lines.slice(up, up + 3).join('\n');
    expect(proxied).toContain('args.This->DoYield(');
    expect(proxied).toContain(`g_bPkc3InProxiedYield = false; // ${MARK}`);
    const flag = lines.slice(flagStart, flagEnd + 1).join('\n');
    const branch = lines.slice(yStart, yEnd + 1).join('\n');
    return `#include <cstdio>
#include <cstdlib>
#include <cstring>
${jspi ? '#define __EMSCRIPTEN__ 1\n#define ENABLE_QT6 1\n#define HAVE_EMSCRIPTEN_JSPI 1\n#define HAVE_EMSCRIPTEN_PROXY_TO_PTHREAD 0\n' : ''}
struct QtInstance
{
    int nDisp = 0;
    int nTrig = 0;
    bool bPending = true;
    bool DispatchUserEvents(bool) { ++nDisp; return true; }
    bool HasUserEvents() const { return bPending; }
    void TriggerUserEventProcessing() { ++nTrig; }
    bool ImplYield(bool bWait, bool bHandleAllCurrentEvents);
    bool DoYield(bool bWait, bool bHandleAllCurrentEvents) { return ImplYield(bWait, bHandleAllCurrentEvents); }
};
${flag}
bool QtInstance::ImplYield(bool bWait, bool bHandleAllCurrentEvents)
{
    (void)bWait;
${branch}
    return wasEvent;
}
${jspi ? `struct Args
{
    QtInstance* This;
    bool bWait;
    bool bHandleAllCurrentEvents;
    bool& bWasEvent;
};
static void RunProxied(Args const& args)
{
${proxied}
}` : ''}
int main(int argc, char** argv)
{
    QtInstance q;
    const char* mode = argc > 1 ? argv[1] : "";
    if (std::strcmp(mode, "nested-empty") == 0)
        q.bPending = false;
    if (std::strcmp(mode, "proxied") == 0)
    {
${jspi ? `        bool bWas = false;
        RunProxied(Args{ &q, false, false, bWas });
        std::printf("was=%d\\n", bWas ? 1 : 0);` : ''}
    }
    else
    {
        for (int i = 0; i < 25; ++i)
            q.ImplYield(false, false);
    }
${jspi ? `    if (std::strcmp(mode, "proxied") == 0)
        q.ImplYield(false, false); // 旗は戻っている(= 入れ子の扱いに戻る)` : ''}
    std::printf("disp=%d trig=%d\\n", q.nDisp, q.nTrig);
    return 0;
}
`;
  }

  function build(jspi: boolean): { bin: string; dir: string } {
    const dir = mkdtempSync(join(tmpdir(), 'pkc3-yg-h-'));
    writeFileSync(join(dir, 't.cxx'), harness(patched(), jspi), 'utf-8');
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
    return { out: r.stdout.trim(), marks: r.stderr.split('\n').filter((l) => l.startsWith('PKC3-YIELDGUARD:')).length };
  };

  it('🔴 JSPI: 入れ子の yield は dispatch せず毎回 Trigger し、印は 20 回で止まる。proxy された yield は dispatch し、旗は戻る', () => {
    const { bin, dir } = build(true);
    try {
      // 入れ子(旗なし)+ event が溜まっている: 25 回呼んでも dispatch は 0、Trigger は 25、印は 20
      const nested = exec(bin, 'nested');
      expect(nested.out).toBe('disp=0 trig=25');
      expect(nested.marks, '印が 20 回で止まっていない').toBe(20);
      // 入れ子 + event が無い: 何もしない(Trigger しない = loop を無駄に起こさない)。印も出ない
      const empty = exec(bin, 'nested-empty');
      expect(empty.out).toBe('disp=0 trig=0');
      expect(empty.marks).toBe(0);
      // proxy された yield(旗あり): dispatch する。終わったら旗は戻り、次の入れ子は defer に戻る
      const proxied = exec(bin, 'proxied');
      expect(proxied.out).toBe('was=1\ndisp=1 trig=1');
      expect(proxied.marks).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('🔴 JSPI でない build(`#else`)は原文のまま: 毎回 dispatch し、Trigger も印も出ない', () => {
    const { bin, dir } = build(false);
    try {
      const r = exec(bin, 'nested');
      expect(r.out).toBe('disp=25 trig=0');
      expect(r.marks).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('#121 の直し(yield-proxy-guard)── 同じ file に当たる他の 2 本と、どの順でも出力が同一', () => {
  const IDLES_TARGETS = pyJson(IDLES_SCRIPT, '[{"src":t[0],"anchor":t[1]} for t in m.TARGETS]') as {
    src: string;
    anchor: string;
  }[];
  const IDLES_HELPERS = pyJson(IDLES_SCRIPT, '[{"src":t[0],"anchor":t[1]} for t in m.HELPER_TARGETS]') as {
    src: string;
    anchor: string;
  }[];
  const CJK_ANCHORS = pyJson(CJK_SCRIPT, '[m.INC_ANCHOR, m.BODY_ANCHOR]') as string[];

  /** idles-trace が当たる QtInstance.cxx 以外の file は、錨を並べただけの版で足りる(本物の上流 file は repo に無い)。 */
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

  const PERMS: string[][] = [
    [SCRIPT, IDLES_SCRIPT, CJK_SCRIPT],
    [SCRIPT, CJK_SCRIPT, IDLES_SCRIPT],
    [IDLES_SCRIPT, SCRIPT, CJK_SCRIPT],
    [IDLES_SCRIPT, CJK_SCRIPT, SCRIPT],
    [CJK_SCRIPT, SCRIPT, IDLES_SCRIPT],
    [CJK_SCRIPT, IDLES_SCRIPT, SCRIPT],
  ];

  it('🔑 空振り防止: 当てる 3 本が、抜粋(+ 錨を並べた版)の錨に**ちょうど 1 件**ずつ当たる', () => {
    expect(OTHER_SRCS.length, 'idles-trace の他の当て先を拾えていない').toBeGreaterThanOrEqual(3);
    for (const a of CJK_ANCHORS) expect(count(EXCERPT, a), `cjk の錨:\n${a}`).toBe(1);
    for (const t of [...IDLES_TARGETS, ...IDLES_HELPERS]) {
      const text = t.src === REL ? EXCERPT : synth(t.src);
      expect(count(text, t.anchor), `${t.src} の idles の錨が 1 件でない:\n${t.anchor}`).toBe(1);
    }
  });

  for (const trace of ['1', '0']) {
    it(`🔴 6 通りの順で当てて QtInstance.cxx が同一(PKC3_IDLES_TRACE=${trace})。3 本とも入っている`, () => {
      const outs: string[] = [];
      for (const order of PERMS) {
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
      for (let i = 1; i < outs.length; i++) {
        expect(outs[i], `当てる順で出力が違う: ${PERMS[0]!.join(' → ')} と ${PERMS[i]!.join(' → ')}`).toBe(outs[0]);
      }
      const out = outs[0]!;
      // 3 本とも空振りで「同一」になっていない
      expect(out).toContain(`g_bPkc3InProxiedYield = true; // ${MARK}`);
      expect(out).toContain('QFontDatabase::addApplicationFont(');
      expect(out.includes('pkc3_idles_trace("yield:disp"'), '計装の有無が環境変数と合っていない').toBe(trace === '1');
      if (trace === '1') {
        // 🔴 計装の `yield:disp`(dispatch できたか)は、直しの `#endif` の後・原文の `if` の前 ──
        //    直しを先に当てても、計装を先に当てても、同じ位置に入っている
        const endifAt = out.indexOf(`#endif // ${MARK}\n`, out.indexOf('bool wasEvent = false; // PKC3-YIELDGUARD'));
        const dispAt = out.indexOf('pkc3_idles_trace("yield:disp"');
        const ifAt = out.indexOf('    if (!bHandleAllCurrentEvents && wasEvent)\n        return true;\n');
        expect(endifAt).toBeGreaterThan(-1);
        expect(endifAt).toBeLessThan(dispAt);
        expect(dispAt).toBeLessThan(ifAt);
        // `yield:guard`(錠を取った直後)は直しの前
        expect(out.indexOf('pkc3_idles_trace("yield:guard"')).toBeLessThan(out.indexOf('bool wasEvent = false; // PKC3-YIELDGUARD'));
      }
    }, 120_000);
  }

  it('🔴 直しを**先に**当てても、idles-trace の錨は全部 1 件ずつ残っている(計装が外れない)', () => {
    const t = root();
    try {
      expect(run(SCRIPT, t.dir).code).toBe(0);
      const text = t.read();
      for (const a of IDLES_TARGETS.filter((x) => x.src === REL).concat(IDLES_HELPERS.filter((x) => x.src === REL))) {
        expect(count(text, a.anchor), `直しの後に idles の錨が 1 件でない:\n${a.anchor}`).toBe(1);
      }
    } finally {
      t.cleanup();
    }
  });

  it('🔴 idles-trace だけを当てた出力は、割る前と同じ(割った錨が `yield:disp` の位置を動かしていない)', () => {
    const other = root();
    try {
      // 割った 2 つの錨が、元の 1 つの錨(`SolarMutexGuard` + `bool wasEvent = …`)の位置に入る
      expect(run(IDLES_SCRIPT, other.dir, { PKC3_IDLES_TRACE: '1' }).code).toBe(0);
      const out = other.read();
      const guardAt = out.indexOf('pkc3_idles_trace("yield:guard"');
      const wasAt = out.indexOf(`    bool wasEvent = ${DISPATCH};\n`);
      const dispAt = out.indexOf('pkc3_idles_trace("yield:disp"');
      const ifAt = out.indexOf('    if (!bHandleAllCurrentEvents && wasEvent)\n        return true;\n');
      expect(guardAt).toBeGreaterThan(-1);
      expect(guardAt).toBeLessThan(wasAt);
      expect(wasAt).toBeLessThan(dispAt);
      expect(dispAt).toBeLessThan(ifAt);
      // 原文の dispatch の行と `if` の間には、計装の塊しか無い(他の文を挟んでいない)
      const between = out.slice(wasAt + `    bool wasEvent = ${DISPATCH};\n`.length, ifAt);
      expect(between.replace(/\s+/g, ' ')).toMatch(
        /^ \{ \/\/ ⚠ 配れたか\(`PostUserEvent` で積まれたものが、ここで捌かれる\) static int nPkc3Disp = 0; if \(nPkc3Disp < 5\) \{ \+\+nPkc3Disp; pkc3_idles_trace\("yield:disp", wasEvent \? 1 : 0, -1, nPkc3Disp\); \} \} $/,
      );
    } finally {
      other.cleanup();
    }
  });
});

describe('#121 の直し(yield-proxy-guard)── 他の検査との関係', () => {
  it('🔑 当て先が、スコープ検査(check-patch-scope.py)の一覧(FIXES)に 2 行載っている', () => {
    // ⚠ 一覧は手書き ── 足し忘れると、この patch だけ検査の外になる
    const scope = readFileSync('build/office-wasm/check-patch-scope.py', 'utf-8');
    const at = scope.indexOf('FIXES = [');
    expect(at, 'check-patch-scope.py に FIXES が無い').toBeGreaterThan(-1);
    const block = scope.slice(at, scope.indexOf('print("=== 本番(ヘルパーを持たない直し', at));
    expect(count(block, '"patch-lo-yield-proxy-guard.py"')).toBe(2);
    expect(block).toContain(`"${REL}"`);
    expect(block).toContain('"if (g_bPkc3InProxiedYield) // PKC3-YIELDGUARD"');
    expect(block).toContain('"g_bPkc3InProxiedYield = true; // PKC3-YIELDGUARD"');
  });

  it('🔑 workflow の本数の主張が、この 1 本を数えている(23 → 24)', () => {
    const yml = readFileSync('.github/workflows/office-wasm-build.yml', 'utf-8');
    expect(yml).toMatch(/23 → 24\(2026-10-04\)/);
    expect(yml).toContain('patch-lo-yield-proxy-guard.py');
    expect(yml).toContain('test "$n" -eq 24');
  });

  it('🔑 check-patches-on-ref.sh が拾える形(`SRC = "…"`)で当て先を宣言している', () => {
    const src = readFileSync(SCRIPT, 'utf-8');
    expect(src).toMatch(/^SRC\s*=\s*"vcl\/qt5\/QtInstance\.cxx"/m);
  });
});

describe('#121 の直し(yield-proxy-guard)── スコープ検査(check-patch-scope.py の FIXES)を実際に走らせる', () => {
  const CHECK = 'build/office-wasm/check-patch-scope.py';
  const SIBLINGS = ['patch-lo-scheduler-task-gone.py', 'patch-lo-menu-popup-sync.py'];

  /** FIXES だけを走らせる(`PKC3_SCOPE_ONLY=fixes`)。⚠ FIXES は全部の当て先が木に要る。 */
  function scopeTree(): string {
    const dir = mkdtempSync(join(tmpdir(), 'pkc3-yg-scope-'));
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

  const mine = (out: string): string[] => out.split('\n').filter((l) => l.includes('patch-lo-yield-proxy-guard.py'));

  /** 検査と patch を別の場所へ写し、この patch の描く C++ だけを壊して走らせる(壊す前に元の字が 1 件在ることを見る)。 */
  function scopeWithBrokenPatch(from: string, to: string): { code: number; out: string } {
    const dir = mkdtempSync(join(tmpdir(), 'pkc3-yg-mut-'));
    const root = scopeTree();
    try {
      const src = readFileSync(SCRIPT, 'utf-8');
      expect(count(src, from), '壊す元の字が 1 件でない(変異が当たらない)').toBe(1);
      writeFileSync(join(dir, 'patch-lo-yield-proxy-guard.py'), src.replace(from, to), 'utf-8');
      for (const s of SIBLINGS) writeFileSync(join(dir, s), readFileSync(`build/office-wasm/${s}`, 'utf-8'), 'utf-8');
      writeFileSync(join(dir, 'check-patch-scope.py'), readFileSync(CHECK, 'utf-8'), 'utf-8');
      return scope(join(dir, 'check-patch-scope.py'), root);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('🔴 抜粋に当てた木で、FIXES が ✅(exit 0)。この直しの 2 行も ✅', () => {
    const root = scopeTree();
    try {
      const r = scope(CHECK, root);
      expect(r.code, r.out).toBe(0);
      const lines = mine(r.out);
      expect(lines.length, 'この直しの行が 2 本出ていない').toBe(2);
      for (const l of lines) {
        expect(l).toContain('✅ 同じスコープ');
        expect(l).toContain('include 深さ 0');
      }
      expect(lines[0]).toContain('QtInstance::ImplYield の dispatch の分岐');
      expect(lines[1]).toContain('QtInstance::DoYield の proxy lambda の旗');
      expect(r.out).toContain('fail=0');
      expect(r.out).not.toContain('元 file が無い');
      expect(r.out).not.toContain('🔴');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('🔴 `if (g_bPkc3InProxiedYield)` が 1 段深くなる(`{` が 1 つ増える)と ✗(exit ≠ 0)', () => {
    // ⚠ 字下げではなく**括弧**で深さが決まる(検査は `{` `}` を数える)
    const from = '    if (g_bPkc3InProxiedYield) // PKC3-YIELDGUARD\n';
    // ⚠ 壊すのは patch の**ソース**(この塊は f-string なので `{` は `{{` と書く)
    const r = scopeWithBrokenPatch(from, `    {{ // PKC3-YIELDGUARD\n${from}`);
    expect(r.code, r.out).toBe(1);
    const lines = mine(r.out);
    expect(lines.length, r.out).toBe(2);
    expect(lines.some((l) => l.includes('QtInstance::ImplYield') && l.includes('スコープが違う'))).toBe(true);
    // ⚠ 閉じない `{` は後ろの深さを全部ずらす(lambda の行も ✗ になる)── 見るのは「ImplYield の行が ✗」だけ
    expect(r.out).toContain('fail=1');
  });

  it('🔴 lambda の旗を立てる行が 1 段深くなると ✗(もう 1 行の検査が鳴る)', () => {
    const from = '                g_bPkc3InProxiedYield = true; // PKC3-YIELDGUARD\n';
    const r = scopeWithBrokenPatch(from, `                { // PKC3-YIELDGUARD\n${from}`);
    expect(r.code, r.out).toBe(1);
    const lines = mine(r.out);
    expect(lines.find((l) => l.includes('QtInstance::DoYield'))).toContain('スコープが違う');
    expect(lines.find((l) => l.includes('QtInstance::ImplYield'))).toContain('✅ 同じスコープ');
  });

  it('🔴 `#include` が file scope でなくなる(`namespace { }` の中)と ✗', () => {
    const from = '#include <cstdio> // PKC3-YIELDGUARD\n';
    const r = scopeWithBrokenPatch(from, `namespace { // PKC3-YIELDGUARD\n${from}} // PKC3-YIELDGUARD\n`);
    expect(r.code, r.out).toBe(1);
    const lines = mine(r.out);
    expect(lines.length).toBe(2);
    for (const l of lines) {
      expect(l).toContain('include 深さ 1');
      expect(l).toContain('スコープが違う');
    }
  });
});
