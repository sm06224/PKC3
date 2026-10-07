/** @vitest-environment node */
/**
 * `build/office-wasm/patch-lo-timer-mutex.py` を検める(#1393 / #1396 / #117 の**原因側の直し**)。
 *
 * 🔴 **直す物**: JSPI かつ PROXY_TO_PTHREAD でない wasm では、`QtTimer::timeoutActivated()` が SolarMutex を取らずに
 * main スレッドで走る(上流 `QtTimer.cxx` が前処理で `SolarMutexGuard` を外し、「too brittle」の TODO を書いている)。
 * そのため `Scheduler::CallbackTaskScheduling` の走査 → `UpdateMinPeriod()` → `pTask` の選択が mutex なしで進み、
 * LO のスレッドが mutex を持って dispose / delete した Task や窓を触って「Office が停止しました」になる(🟡 推測)。
 * 直しは、`#if` の**偽の側**(`#else`)で mutex を**待たずに**試し、LO のスレッドが持っていれば 1 ms 後に張り直して返る形。
 * main が既に持っている(`IsCurrentThread()` が真 = QtYieldMutex の「借りている」状態)ときは今まで通り走る。
 *
 * ⚠ 見るのは:
 *   ① **錨が原文に当たる**(上流 `d6226c1a` の file そのまま ── 合成した物ではない)/ 1 つ外しても落ちる(file は不変)/
 *      当て済みは **SKIP(exit 0)で file は 1 バイトも変わらない** / 印が欠けた file は SKIP せず exit 1
 *   ② **`#else` の位置**: `#if !(defined __EMSCRIPTEN__ …` → `SolarMutexGuard aGuard;` → `#else` → 足した本体 → 原文の `#endif` の順で、
 *      `#else` は 1 件(2 件目を足すと前処理が壊れる)
 *   ③ **本体の中身を、描いた結果で見る**: `IsCurrentThread()` を**先に**見る / 取れなければ `m_aTimer.start(1)` して `return`
 *      (どちらも失敗の枝の**中**)/ 取れたら RAII で `release()` / 印は 最初の 20 回 + 100 回ごと(上限は印だけを包む)・どの行にも `t=<ms>`(#1408 固まった後に印が止まるか続くかを時刻で読む)
 *   ④ **足した行は全部印を含み、原文の行は 1 行も書き換えない**
 *   ⑤ workflow の本数の主張がこの 1 本を数えている / 上流の実 file(在れば)へ本当に当たる
 *
 * 🔴 **言えないこと**: 当てた後の C++ が本物の LO の header でコンパイルできること /
 * 本物で停止が消えること。🔴 **この直しが塞ぐのは「走査と選択 → `Invoke`」の窓だけ** ── LO のスレッド自身が mutex を手放す所
 * (`EmscriptenLightweightRunInMainThread` / `DoYield` の枝 B)は塞がない。焼いて、`PKC3-TASKGONE` / `PKC3-LAYOUTGUARD` /
 * `PKC3-TOOLTIPGUARD` / `PKC3-VIEWDATAGONE` の回数が 0 に近づくかを読むまで言えない。
 */
import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const SCRIPT = 'build/office-wasm/patch-lo-timer-mutex.py';
const REL = 'vcl/qt5/QtTimer.cxx';
const MARK = 'PKC3-TIMERMUTEX';
const EXCERPT = readFileSync('tests/fixtures/office-lo/QtTimer.excerpt.cxx', 'utf-8');
/** 上流の実 file(在る箱でだけ回す。CI には無いので skip ── 実物の錨は焼く前の `check-patches-on-ref.sh` が見る)。 */
const UPSTREAM = process.env['PKC3_LO_UP'] ?? '';

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
  const dir = mkdtempSync(join(tmpdir(), 'pkc3-timermutex-'));
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
    expect(run(SCRIPT, t.dir).code).toBe(0);
    return t.read();
  } finally {
    t.cleanup();
  }
}

/** `timeoutActivated()` の本体(関数の頭から、原文の `CallCallback();` まで)。 */
function fnBody(after: string): string {
  const at = after.indexOf('void QtTimer::timeoutActivated()');
  expect(at).toBeGreaterThan(-1);
  const end = after.indexOf('CallCallback();', at);
  expect(end).toBeGreaterThan(at);
  return after.slice(at, end);
}

/** `#else // PKC3-TIMERMUTEX` から、原文の `#endif` の直前まで(足した本体だけ)。 */
function elseBody(after: string): string {
  const from = after.indexOf(`#else // ${MARK}\n`);
  expect(from).toBeGreaterThan(-1);
  const to = after.indexOf('#endif\n', from);
  expect(to).toBeGreaterThan(from);
  return after.slice(from, to);
}

describe('#1393 timer-mutex ── 当て方', () => {
  it('🔑 空振り防止: 錨を拾えている(0 件でも「全部当たった」は真になる)', () => {
    expect(FIX_ANCHORS.length, '錨を拾えていない').toBe(2);
    expect(new Set(FIX_ANCHORS).size, '同じ錨が 2 つ在る').toBe(FIX_ANCHORS.length);
    expect(EXCERPT, '抜粋が空').toContain('void QtTimer::timeoutActivated()');
    // 抜粋は上流の file そのまま(末尾の改行は 1 つ)
    expect(EXCERPT.endsWith('*/\n')).toBe(true);
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
      // 印の行が 2 組に増えていない
      expect(count(t.read(), `#else // ${MARK}`)).toBe(1);
      expect(count(t.read(), 'tryToAcquire()')).toBe(1);
    } finally {
      t.cleanup();
    }
  });

  it('🔴 印が在るのに足りない file(部分適用 / 手編集)は SKIP しない ── exit 1 で file は不変', () => {
    // 印を 1 行だけ持つ file(include の行だけ当たっていて、本体が無い形)
    const partial = EXCERPT.replace(FIX_ANCHORS[0]!, FIX_ANCHORS[0]! + `// ${MARK} (only the include line)\n`);
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
      const dropped = full.replace(`#include <cstdio> // ${MARK}\n`, '');
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
      const extra = t.read().replace('#else // PKC3-TIMERMUTEX\n', '#else // PKC3-TIMERMUTEX\n    // hand-added line // PKC3-TIMERMUTEX\n');
      expect(extra).not.toBe(t.read());
      writeFileSync(join(t.dir, REL), extra, 'utf-8');
      const r = run(SCRIPT, t.dir);
      expect(r.code, r.out).toBe(1);
      expect(r.out).not.toContain('SKIP');
      expect(t.read(), '印が多い file を書き換えた').toBe(extra);
    } finally {
      t.cleanup();
    }
  });

  it('🔴 錨が 1 つでも無ければ落ちる(exit 1)。何も書かない', () => {
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

  it('🔴 錨が 1 字違っても落ちる(上流が `SolarMutexGuard` の行を変えたら、黙って通さない)', () => {
    const broken = EXCERPT.replace('    SolarMutexGuard aGuard;\n#endif', '    SolarMutexGuard  aGuard;\n#endif');
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
    const doubled = `${EXCERPT}\n${FIX_ANCHORS[1]}`;
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

describe('#1393 timer-mutex ── 当てた結果(描いた C++ で見る)', () => {
  it('🔴 前処理の順: `#if !(defined __EMSCRIPTEN__` → `SolarMutexGuard aGuard;` → `#else` → `#endif`、`#else` は 1 件だけ', () => {
    const after = patched();
    const fn = fnBody(after);
    const ifAt = fn.indexOf('#if !(defined __EMSCRIPTEN__');
    const guardAt = fn.indexOf('    SolarMutexGuard aGuard;\n');
    const elseAt = fn.indexOf(`#else // ${MARK}\n`);
    expect(ifAt, '`#if !(defined __EMSCRIPTEN__` が関数の中に無い').toBeGreaterThan(-1);
    expect(ifAt).toBeLessThan(guardAt);
    expect(guardAt).toBeLessThan(elseAt);
    // `#else` は `SolarMutexGuard aGuard;` の**すぐ次の行**(間に何も挟まない = `#if` の偽の側だけに入る)
    expect(fn.slice(guardAt)).toMatch(new RegExp(`^ {4}SolarMutexGuard aGuard;\\n#else // ${MARK}\\n`));
    // 原文の `#endif` は `#else` の後に 1 件(足した本体の後)。関数の中の前処理は `#if` / `#else` / `#endif` の 3 つだけ
    const directives = fn.split('\n').filter((l) => /^#\s*(if|else|elif|endif)/.test(l));
    expect(directives.length, '関数の中の前処理が `#if` / `#else` / `#endif` の 3 つでない').toBe(3);
    expect(directives[0]).toMatch(/^#if !\(defined __EMSCRIPTEN__/);
    expect(directives[1]).toBe(`#else // ${MARK}`);
    expect(directives[2]).toBe('#endif');
    expect(count(after, '#else'), '`#else` が 1 件でない').toBe(1);
    expect(count(EXCERPT, '#else'), '抜粋の前提(元には無い)').toBe(0);
    expect(count(after, '#endif')).toBe(count(EXCERPT, '#endif'));
    expect(count(after, '#if ')).toBe(count(EXCERPT, '#if '));
  });

  it('🔴 本体の全文(手で書いた期待値)── `#else` から `#endif` の直前まで', () => {
    const after = patched();
    // 🔑 期待値は patch から取らず**手で書く**
    expect(elseBody(after)).toBe(
      [
        `#else // ${MARK}`,
        `    // ${MARK}: this build runs scheduler selection without the SolarMutex, so a task can be`,
        `    // ${MARK}: stopped/destroyed between selection and Invoke. Try (never wait) for the mutex`,
        `    // ${MARK}: here; if the LO thread holds it, retry in 1 ms. Skip when main already owns it`,
        `    // ${MARK}: (QtYieldMutex borrowed state: IsCurrentThread() is true there).`,
        `    struct Pkc3Held // ${MARK}`,
        `    { // ${MARK}`,
        `        comphelper::SolarMutex* m_pMutex = nullptr; // ${MARK}`,
        `        ~Pkc3Held() // ${MARK}`,
        `        { // ${MARK}`,
        `            if (m_pMutex) // ${MARK}`,
        `                m_pMutex->release(); // ${MARK}`,
        `        } // ${MARK}`,
        `    } aPkc3Held; // ${MARK}`,
        `    comphelper::SolarMutex* const pPkc3Mutex = comphelper::SolarMutex::get(); // ${MARK}`,
        `    static int nPkc3Skipped = 0; // ${MARK}`,
        `    static int nPkc3Ran = 0; // ${MARK}`,
        `    // ${MARK}: ms on the steady clock (wasm: since page start), so the log shows whether the re-arm keeps going.`,
        `    auto const pPkc3Ms = []() -> long long // ${MARK}`,
        `    { // ${MARK}`,
        `        return std::chrono::duration_cast<std::chrono::milliseconds>( // ${MARK}`,
        `                   std::chrono::steady_clock::now().time_since_epoch()) // ${MARK}`,
        `            .count(); // ${MARK}`,
        `    }; // ${MARK}`,
        `    if (pPkc3Mutex && !pPkc3Mutex->IsCurrentThread()) // ${MARK}`,
        `    { // ${MARK}`,
        `        if (!pPkc3Mutex->tryToAcquire()) // ${MARK}`,
        `        { // ${MARK}`,
        `            if (nPkc3Skipped++ < 20 || nPkc3Skipped % 100 == 0) // ${MARK}`,
        `                std::fprintf(stderr, "${MARK}: skipped #%d (LO thread holds SolarMutex) t=%lld\\n", nPkc3Skipped, pPkc3Ms()); // ${MARK}`,
        `            m_aTimer.start(1); // ${MARK}`,
        `            return; // ${MARK}`,
        `        } // ${MARK}`,
        `        aPkc3Held.m_pMutex = pPkc3Mutex; // ${MARK}`,
        `        if (nPkc3Ran++ < 20 || nPkc3Ran % 100 == 0) // ${MARK}`,
        `            std::fprintf(stderr, "${MARK}: ran under mutex (skipped so far %d) ran=%d t=%lld\\n", nPkc3Skipped, nPkc3Ran, pPkc3Ms()); // ${MARK}`,
        `    } // ${MARK}`,
        ``,
      ].join('\n'),
    );
  });

  it('🔴 順序: `IsCurrentThread()` を**先に**見る(借りている状態で `tryToAcquire` を呼ばない)。`tryToAcquire` は 1 件', () => {
    const body = elseBody(patched());
    const cur = body.indexOf('IsCurrentThread())');
    const acq = body.indexOf('tryToAcquire()');
    expect(cur, '`IsCurrentThread()` の検査が無い').toBeGreaterThan(-1);
    expect(acq).toBeGreaterThan(-1);
    expect(cur).toBeLessThan(acq);
    expect(count(body, 'tryToAcquire()')).toBe(1);
    // 検査は `if (… && !…IsCurrentThread())`(借りている = 真のときは中へ入らない)で、`tryToAcquire` はその `{` の中
    const guardLine = body.split('\n').find((l) => l.includes('IsCurrentThread())'))!;
    expect(guardLine).toContain('!pPkc3Mutex->IsCurrentThread()');
    expect(guardLine).toContain('pPkc3Mutex &&');
  });

  it('🔴 取れなかった枝: `m_aTimer.start(1)` で張り直して `return` する(待たない)。どちらも失敗の枝の**中**', () => {
    const body = elseBody(patched());
    const at = body.indexOf('if (!pPkc3Mutex->tryToAcquire())');
    expect(at).toBeGreaterThan(-1);
    const open = body.indexOf('{', at);
    const close = body.indexOf(`        } // ${MARK}\n`, open);
    expect(close).toBeGreaterThan(open);
    const branch = body.slice(open, close);
    expect(count(branch, 'm_aTimer.start(1);'), '1 ms 後の張り直しが失敗の枝に無い').toBe(1);
    expect(count(branch, 'return;'), '`return` が失敗の枝に無い').toBe(1);
    expect(branch.indexOf('m_aTimer.start(1);')).toBeLessThan(branch.indexOf('return;'));
    // 失敗の枝の外には、`start` も `return` も無い(= 取れたら最後まで走る)
    const outside = body.slice(0, open) + body.slice(close);
    expect(count(outside, 'm_aTimer.start('), '失敗の枝の外に張り直しが漏れている').toBe(0);
    expect(count(outside, 'return;')).toBe(0);
    // 🔴 待つ道具を使っていない(main が固まる)
    const code = body
      .split('\n')
      .filter((l) => !/^\s*\/\/ /.test(l))
      .map((l) => l.replace(/"[^"]*"/g, '""').replace(/\/\/.*$/, ''))
      .join('\n');
    expect(code).not.toMatch(/\bacquire\(\)|\bSolarMutexGuard\b|\bMutexGuard\b|\bsleep|\bwait/i);
  });

  it('🔴 取れたら RAII で手放す: `Pkc3Held` の dtor が `release()` し、取れた後にだけ `m_pMutex` を入れる', () => {
    const body = elseBody(patched());
    expect(count(body, 'm_pMutex->release();'), 'release が 1 件でない').toBe(1);
    expect(body).toMatch(/~Pkc3Held\(\)[^\n]*\n\s*\{[^\n]*\n\s*if \(m_pMutex\)[^\n]*\n\s*m_pMutex->release\(\);/);
    expect(count(body, 'aPkc3Held.m_pMutex = pPkc3Mutex;')).toBe(1);
    // 代入は失敗の枝の後ろ(取れなかったのに release しない)
    expect(body.indexOf('aPkc3Held.m_pMutex = pPkc3Mutex;')).toBeGreaterThan(body.indexOf('m_aTimer.start(1);'));
    // RAII の器は取る試行より前に宣言されている(`return` でも dtor が走る)
    expect(body.indexOf('} aPkc3Held;')).toBeLessThan(body.indexOf('tryToAcquire()'));
    // 器の初期値は null(何も取らずに出るとき release しない)
    expect(body).toContain('comphelper::SolarMutex* m_pMutex = nullptr;');
  });

  it('🔴 印の頻度: skip も ran も「最初の 20 回 + 100 回ごと」で、**印だけ**を包む(`m_aTimer.start(1)` と `return` は毎回)', () => {
    const body = elseBody(patched());
    expect(count(body, 'nPkc3Skipped++ < 20 || nPkc3Skipped % 100 == 0')).toBe(1);
    expect(count(body, 'nPkc3Ran++ < 20 || nPkc3Ran % 100 == 0')).toBe(1);
    // 🔴 1000 回ごとへ戻していない(#1408: 372 → 1000 の間が無音で、固まった後の様子が読めなかった)
    expect(body, '1000 回ごとへ戻っている').not.toMatch(/% 1000\b/);
    expect(count(body, 'std::fprintf(')).toBe(2);
    expect(count(body, 'skipped so far %d')).toBe(1);
    expect(count(body, 'static int nPkc3Skipped = 0;')).toBe(1);
    expect(count(body, 'static int nPkc3Ran = 0;')).toBe(1);
    // 上限の `if` は波括弧なしの 1 文(= fprintf だけ)。次の行が `m_aTimer.start(1);` で、`{` で包んでいない
    const lines = body.split('\n');
    const i = lines.findIndex((l) => l.includes('nPkc3Skipped++ < 20'));
    expect(lines[i + 1]).toContain('std::fprintf(');
    expect(lines[i + 2]).toContain('m_aTimer.start(1);');
    const j = lines.findIndex((l) => l.includes('nPkc3Ran++ < 20'));
    expect(lines[j + 1]).toContain('std::fprintf(');
    expect(lines[j + 2]).toContain('} //');
  });

  it('🔴 時刻: どちらの印にも `t=%lld` + `pPkc3Ms()` が付き、接頭辞は既存の形のまま(集計 script が grep する)', () => {
    const body = elseBody(patched());
    const prints = body.split('\n').filter((l) => l.includes('std::fprintf('));
    expect(prints.length).toBe(2);
    for (const l of prints) {
      expect(l, '経過時間の欄が無い').toMatch(/ t=%lld\\n"/);
      expect(l, '経過時間を渡していない').toMatch(/pPkc3Ms\(\)\)/);
    }
    // 接頭辞(`PKC3-TIMERMUTEX: skipped #` / `PKC3-TIMERMUTEX: ran under mutex`)は残す
    expect(prints[0]).toContain(`"${MARK}: skipped #%d (LO thread holds SolarMutex) t=%lld`);
    expect(prints[1]).toContain(`"${MARK}: ran under mutex (skipped so far %d) ran=%d t=%lld`);
    // 時計は steady(壁時計は巻き戻る)で、ms に落とす。lambda は 1 件で、使う所より前
    expect(count(body, 'std::chrono::steady_clock::now()')).toBe(1);
    expect(body).not.toContain('system_clock');
    expect(count(body, 'std::chrono::milliseconds')).toBe(1);
    expect(body.indexOf('auto const pPkc3Ms')).toBeLessThan(body.indexOf('std::fprintf('));
    // 🔴 所有者の thread id は出さない(`m_nThreadId` は private で、読み出し口が上流に無い。private を覗く手は使わない)
    expect(body).not.toMatch(/get_id|m_nThreadId|#define private/);
  });

  it('🔴 include: `<comphelper/solarmutex.hxx>` と `<cstdio>` と `<chrono>` が `<vcl/svapp.hxx>` の直後に足され、使う所より前に在る', () => {
    const after = patched();
    expect(count(EXCERPT, '#include <cstdio>'), '抜粋の前提(元には無い)').toBe(0);
    expect(count(EXCERPT, '#include <chrono>'), '抜粋の前提(元には無い)').toBe(0);
    expect(count(EXCERPT, 'solarmutex.hxx'), '抜粋の前提(元には無い)').toBe(0);
    expect(after).toContain(
      `#include <vcl/svapp.hxx>\n#include <comphelper/solarmutex.hxx> // ${MARK}\n#include <cstdio> // ${MARK}\n#include <chrono> // ${MARK}\n`,
    );
    const fnAt = after.indexOf('void QtTimer::timeoutActivated()');
    expect(after.indexOf('#include <cstdio>')).toBeLessThan(fnAt);
    expect(after.indexOf('#include <chrono>')).toBeLessThan(fnAt);
    expect(after.indexOf('#include <comphelper/solarmutex.hxx>')).toBeLessThan(fnAt);
  });

  it('🔴 足した行は全部 mark を含む。原文の行は 1 行も書き換えない(足すだけ)', () => {
    const after = patched();
    expect(after).not.toBe(EXCERPT);
    expect(restore(after)).toBe(EXCERPT);
    // 足した行は 40 行(include 3 + `#else` 1 + 注釈 4 + 本体 32)
    const added = after.split('\n').filter((l) => l.includes(MARK));
    expect(added.length).toBe(40);
    // 🔴 印の無い足し行が無い(原文の行集合に無い行は、全部印を含む)
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
  });

  it('🔴 原文の他の所は動かない: `SolarMutexGuard aGuard;` / `CallCallback();` / `startTimer` が元のまま 1 件', () => {
    const after = patched();
    expect(count(after, '    SolarMutexGuard aGuard;\n')).toBe(1);
    expect(count(after, '        GetQtInstance().DispatchUserEvents(true);\n    CallCallback();\n')).toBe(1);
    expect(count(after, 'void QtTimer::startTimer(int nMS) { m_aTimer.start(nMS); }')).toBe(1);
    // `m_aTimer` は上流の QTimer の member 名(ctor が使っている)
    expect(count(EXCERPT, 'm_aTimer.setSingleShot(true);')).toBe(1);
  });
});

describe('#1393 timer-mutex ── 上流の実 file へ', () => {
  const real = UPSTREAM ? join(UPSTREAM, REL) : '';
  it.skipIf(!real || !existsSync(real))('🔴 実 file へ当たる(exit 0)。足した行は 40・消した行は 0。2 度目は SKIP で不変', () => {
    const orig = readFileSync(real, 'utf-8');
    const t = tree(orig);
    try {
      const r = run(SCRIPT, t.dir);
      expect(r.code, r.out).toBe(0);
      const after = t.read();
      const o = orig.split('\n');
      const a = after.split('\n');
      expect(a.length - o.length).toBe(40);
      expect(restore(after)).toBe(orig);
      const r2 = run(SCRIPT, t.dir);
      expect(r2.code, r2.out).toBe(0);
      expect(r2.out).toContain('SKIP');
      expect(t.read()).toBe(after);
    } finally {
      t.cleanup();
    }
  });
});

describe('#1393 timer-mutex ── 他の検査との関係', () => {
  it('🔑 当て先が、他の LO patch と重ならない(同じ file を 2 本が触ると当てる順で結果が変わる)', () => {
    const owners = readdirSync('build/office-wasm')
      .filter((f) => /^patch-.*\.py$/.test(f))
      .filter((f) => readFileSync(join('build/office-wasm', f), 'utf-8').includes(`"${REL}"`));
    expect(owners).toEqual(['patch-lo-timer-mutex.py']);
  });

  it('🔑 check-patches-on-ref.sh が拾える形(`SRC = "…"`)で当て先を宣言している', () => {
    const src = readFileSync(SCRIPT, 'utf-8');
    expect(src).toMatch(/^SRC\s*=\s*"vcl\/qt5\/QtTimer\.cxx"/m);
  });

  it('🔑 workflow の本数の主張が、この 1 本を数えている(29 → 30)', () => {
    const yml = readFileSync('.github/workflows/office-wasm-build.yml', 'utf-8');
    expect(yml).toMatch(/29 → 30\(2026-10-07\)/);
    expect(yml).toContain('patch-lo-timer-mutex.py');
    expect(yml).toContain('test "$n" -eq 34');
  });
});
