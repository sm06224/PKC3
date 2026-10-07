/** @vitest-environment node */
/**
 * `build/office-wasm/patch-lo-yield-wait.py` を検める(#1408 の**印**。直しではない)。
 *
 * 🔴 **何のための印か**: Impress を読み込む最中(約 13 秒)に 30 回に 1 回、無言で固まる。直前まで main の timer は鍵を取れずに skip し続け、
 * その後 `m_aTimer.start(1)` 自体が止まる = main の event loop が回らない。候補は、main の別の入口が
 * `QtYieldMutex::doAcquire`(上流 `d6226c1a` の `QtInstance.cxx`)の `m_InMainCondition.wait` で LO スレッドの鍵を待ったまま戻らないこと。
 * 印は `wait` の**外側の前後**に `PKC3-YIELDWAIT: enter #N …` / `leave #M (enter #N) …` を置き、
 * 「enter があって leave が無い」で main がそこで止まっていることを言う。
 *
 * ⚠ 見るのは:
 *   ① **錨が原文に当たる**(上流の file そのまま ── 合成した物ではない)/ 1 つ外しても落ちる(file は不変)/
 *      当て済みは **SKIP(exit 0)で file は 1 バイトも変わらない** / 印が欠けた file・多い file は SKIP せず exit 1
 *   ② **印の位置**: `doAcquire` の中・`tryToAcquire` が偽だった後・`wait` の**直前**に enter、`std::swap(func, m_Closure);` の**直後**に leave。
 *      `wait` の行は 1 行も動かない(loop の内側に入れない = spurious wakeup のたびには出ない)
 *   ③ **頻度**: enter は毎回(上限 3000 の後は 100 回ごと)/ leave は同じ + **100 ms を超えて待った回は必ず**。連番は enter / leave で**別**に数え、
 *      leave には自分の番号と enter の番号を両方添える
 *   ④ **足した行は全部印を含み、原文の行は 1 行も書き換えない**
 *   ⑤ workflow の本数の主張がこの 1 本を数えている / 上流の実 file(在れば)へ本当に当たる
 *
 * 🔴 **言えないこと**: 当てた後の C++ が本物の LO の header でコンパイルできること(手元で型を stub に替えた harness では通した)/
 * 本物で印が固まった run を読み分けること。🔴 3000 回目より後に固まれば enter の行は 100 回に 1 回しか出ない。
 */
import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const SCRIPT = 'build/office-wasm/patch-lo-yield-wait.py';
const REL = 'vcl/qt5/QtInstance.cxx';
const MARK = 'PKC3-YIELDWAIT';
const EXCERPT = readFileSync('tests/fixtures/office-lo/QtYieldMutex.excerpt.cxx', 'utf-8');
/** 上流の実 file(在る箱でだけ回す。CI には無いので skip ── 実物の錨は焼く前の `check-patches-on-ref.sh` が見る)。 */
const UPSTREAM = process.env['PKC3_LO_UP'] ?? '';
/** 足す行の数(include 2 + enter 側 15 + leave 側 6)。数え直したら理由を 1 行書く。 */
const ADDED = 23;

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
  const dir = mkdtempSync(join(tmpdir(), 'pkc3-yieldwait-'));
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

/** `QtYieldMutex::doAcquire` の本体(関数の頭から、次の関数 `doRelease` の頭まで)。 */
function acquireBody(after: string): string {
  const at = after.indexOf('void QtYieldMutex::doAcquire(sal_uInt32 nLockCount)');
  expect(at).toBeGreaterThan(-1);
  const end = after.indexOf('sal_uInt32 QtYieldMutex::doRelease(', at);
  expect(end).toBeGreaterThan(at);
  return after.slice(at, end);
}

/** 足した本体のうち、`wait` の前(enter 側)と後(leave 側)。 */
function enterPart(after: string): string {
  const body = acquireBody(after);
  const w = body.indexOf('m_InMainCondition.wait(');
  expect(w).toBeGreaterThan(-1);
  const from = body.indexOf(`// ${MARK}: main is about to wait`);
  expect(from).toBeGreaterThan(-1);
  expect(from).toBeLessThan(w);
  return body.slice(from, w);
}

function leavePart(after: string): string {
  const body = acquireBody(after);
  const sw = body.indexOf('std::swap(func, m_Closure);');
  expect(sw).toBeGreaterThan(-1);
  const to = body.indexOf('        if (func)', sw);
  expect(to).toBeGreaterThan(sw);
  return body.slice(sw, to);
}

describe('#1408 yield-wait ── 当て方', () => {
  it('🔑 空振り防止: 錨を拾えている(0 件でも「全部当たった」は真になる)', () => {
    expect(FIX_ANCHORS.length, '錨を拾えていない').toBe(2);
    expect(new Set(FIX_ANCHORS).size, '同じ錨が 2 つ在る').toBe(FIX_ANCHORS.length);
    expect(EXCERPT, '抜粋が空').toContain('void QtYieldMutex::doAcquire(sal_uInt32 nLockCount)');
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
      expect(count(t.read(), `${MARK}: enter #`)).toBe(1);
      expect(count(t.read(), `${MARK}: leave #`)).toBe(1);
    } finally {
      t.cleanup();
    }
  });

  it('🔴 印が在るのに足りない file(部分適用 / 手編集)は SKIP しない ── exit 1 で file は不変', () => {
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
      const full = t.read();
      const extra = full.replace(`#include <chrono> // ${MARK}\n`, `#include <chrono> // ${MARK}\n#include <atomic> // ${MARK}\n`);
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

  it('🔴 錨が 1 字違っても落ちる(上流が `wait` の述語を変えたら、黙って通さない)', () => {
    const broken = EXCERPT.replace('return m_isWakeUpMain; });', 'return m_isWakeUpMain || false; });');
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

describe('#1408 yield-wait ── 当てた結果(描いた C++ で見る)', () => {
  it('🔴 enter 側の全文(手で書いた期待値)── `wait` の直前まで', () => {
    // 🔑 期待値は patch から取らず**手で書く**
    expect(enterPart(patched())).toBe(
      [
        `// ${MARK}: main is about to wait for the LO thread to release the SolarMutex (tryToAcquire failed above).`,
        `            // ${MARK}: enter without a matching leave in the log = main is stuck in this wait. The wait is predicate-form`,
        `            // ${MARK}: (its loop is inside), so these marks sit outside it and do not repeat on spurious wakeups.`,
        `            static unsigned nPkc3In = 0; // ${MARK}`,
        `            static unsigned nPkc3Out = 0; // ${MARK}`,
        `            auto const pPkc3Ms = []() -> long long // ${MARK}`,
        `            { // ${MARK}`,
        `                return std::chrono::duration_cast<std::chrono::milliseconds>( // ${MARK}`,
        `                           std::chrono::steady_clock::now().time_since_epoch()) // ${MARK}`,
        `                    .count(); // ${MARK}`,
        `            }; // ${MARK}`,
        `            unsigned const nPkc3EnterSeq = ++nPkc3In; // ${MARK}`,
        `            long long const nPkc3EnterMs = pPkc3Ms(); // ${MARK}`,
        `            if (nPkc3EnterSeq <= 3000 || nPkc3EnterSeq % 100 == 0) // ${MARK}`,
        `                std::fprintf(stderr, "${MARK}: enter #%u t=%lld held_by_lo=1 wake=%d closure=%d\\n", nPkc3EnterSeq, nPkc3EnterMs, m_isWakeUpMain ? 1 : 0, m_Closure ? 1 : 0); // ${MARK}`,
        `            `,
      ].join('\n'),
    );
  });

  it('🔴 leave 側の全文(手で書いた期待値)── `std::swap` の行から、closure を走らせる `if (func)` の手前まで', () => {
    expect(leavePart(patched())).toBe(
      [
        `std::swap(func, m_Closure);`,
        `            // ${MARK}: back from the wait (func is the closure we were woken for, empty if it was a plain release).`,
        `            unsigned const nPkc3LeaveSeq = ++nPkc3Out; // ${MARK}`,
        `            long long const nPkc3LeaveMs = pPkc3Ms(); // ${MARK}`,
        `            long long const nPkc3Waited = nPkc3LeaveMs - nPkc3EnterMs; // ${MARK}`,
        `            if (nPkc3LeaveSeq <= 3000 || nPkc3LeaveSeq % 100 == 0 || nPkc3Waited > 100) // ${MARK}`,
        `                std::fprintf(stderr, "${MARK}: leave #%u (enter #%u) t=%lld waited=%lld closure=%d\\n", nPkc3LeaveSeq, nPkc3EnterSeq, nPkc3LeaveMs, nPkc3Waited, func ? 1 : 0); // ${MARK}`,
        `        }`,
        ``,
      ].join('\n'),
    );
  });

  it('🔴 位置: enter は `tryToAcquire` が偽だった後・`wait` の前、leave は `swap` の後。`wait` / `m_isWakeUpMain = false` / `swap` の行は動かない', () => {
    const after = patched();
    const body = acquireBody(after);
    const acq = body.indexOf('if (m_aMutex.tryToAcquire())');
    const enter = body.indexOf(`${MARK}: enter #`);
    const wait = body.indexOf('m_InMainCondition.wait(g, [this]() { return m_isWakeUpMain; });');
    const reset = body.indexOf('            m_isWakeUpMain = false;\n            std::swap(func, m_Closure);\n');
    const leave = body.indexOf(`${MARK}: leave #`);
    expect(acq, 'tryToAcquire の枝が無い').toBeGreaterThan(-1);
    for (const [name, v] of Object.entries({ enter, wait, reset, leave })) {
      expect(v, `${name} が doAcquire の中に無い`).toBeGreaterThan(-1);
    }
    // 取れた枝(`break`)より後 = 取れなかった(待つ)側
    expect(body.indexOf('break;', acq)).toBeLessThan(enter);
    expect(enter).toBeLessThan(wait);
    expect(wait).toBeLessThan(reset);
    expect(reset).toBeLessThan(leave);
    // `wait` の直後は原文の 2 行(`wait` と `swap` の間に印を挟まない = 戻った直後の状態で `func` を見る)
    expect(body).toContain(
      '            m_InMainCondition.wait(g, [this]() { return m_isWakeUpMain; });\n            m_isWakeUpMain = false;\n            std::swap(func, m_Closure);\n',
    );
    // 印は `unique_lock` の塊の中(`g` を持ったまま `m_isWakeUpMain` / `m_Closure` を読む)= 塊の `}` より前
    expect(leave).toBeLessThan(body.indexOf('        if (func)'));
    // wait は 1 件(spurious wakeup 用の loop を足していない)
    expect(count(body, 'm_InMainCondition.wait(')).toBe(1);
    expect(count(after, 'm_InMainCondition.wait('), '他の関数に wait を足した').toBe(count(EXCERPT, 'm_InMainCondition.wait('));
  });

  it('🔴 loop の内側に置いていない: 印を含む行は `while` / `for` / `wait_for` を持たない', () => {
    const marked = patched()
      .split('\n')
      .filter((l) => l.includes(MARK) && !/^\s*\/\//.test(l));
    for (const l of marked) {
      expect(l, '印の行に loop / timeout 付きの待ちが混じっている').not.toMatch(/\bwhile\b|\bfor\b|wait_for|wait_until/);
    }
  });

  it('🔴 連番は enter / leave で**別**: `++nPkc3In` と `++nPkc3Out` が 1 件ずつ、leave の行は自分の番号と enter の番号の両方を出す', () => {
    const after = patched();
    expect(count(after, '++nPkc3In;')).toBe(1);
    expect(count(after, '++nPkc3Out;')).toBe(1);
    const enterLine = after.split('\n').find((l) => l.includes(`${MARK}: enter #`))!;
    const leaveLine = after.split('\n').find((l) => l.includes(`${MARK}: leave #`))!;
    // enter は enter の番号だけ(leave の番号を読まない)
    expect(enterLine).toContain('nPkc3EnterSeq');
    expect(enterLine).not.toContain('nPkc3LeaveSeq');
    // leave は `#<自分の番号> (enter #<enter の番号>)` の順
    expect(leaveLine).toContain('leave #%u (enter #%u)');
    expect(leaveLine).toMatch(/nPkc3LeaveSeq, nPkc3EnterSeq,/);
    // 数える変数の名前が混ざっていない(leave の数え方が `nPkc3In` を共有しない)
    const leaveCounter = after.split('\n').find((l) => l.includes('nPkc3LeaveSeq = '))!;
    expect(leaveCounter).toContain('++nPkc3Out');
    expect(leaveCounter).not.toContain('nPkc3In');
    const enterCounter = after.split('\n').find((l) => l.includes('nPkc3EnterSeq = '))!;
    expect(enterCounter).toContain('++nPkc3In');
    expect(enterCounter).not.toContain('nPkc3Out');
  });

  it('🔴 頻度: enter は「3000 回まで毎回 + 100 回ごと」、leave は同じ + **100 ms を超えた回は必ず**', () => {
    const after = patched();
    const enterIf = after.split('\n').find((l) => l.includes('if (nPkc3EnterSeq <= 3000'))!;
    const leaveIf = after.split('\n').find((l) => l.includes('if (nPkc3LeaveSeq <= 3000'))!;
    expect(enterIf).toContain('nPkc3EnterSeq <= 3000 || nPkc3EnterSeq % 100 == 0');
    expect(enterIf, 'enter に待った時間の条件が混じっている(まだ待った時間は分からない)').not.toContain('Waited');
    expect(leaveIf).toContain('nPkc3LeaveSeq <= 3000 || nPkc3LeaveSeq % 100 == 0 || nPkc3Waited > 100');
    // 100 ms 超の枝は「必ず出す」= `||` の最後の項で、`&&` で絞っていない
    expect(leaveIf).not.toContain('&&');
    expect(enterIf).not.toContain('&&');
    // 上限の `if` は波括弧なしの 1 文(= fprintf だけ)
    const lines = after.split('\n');
    const i = lines.findIndex((l) => l.includes('if (nPkc3EnterSeq <= 3000'));
    expect(lines[i + 1]).toContain('std::fprintf(');
    expect(lines[i + 2]).toContain('m_InMainCondition.wait(');
    const j = lines.findIndex((l) => l.includes('if (nPkc3LeaveSeq <= 3000'));
    expect(lines[j + 1]).toContain('std::fprintf(');
    expect(lines[j + 2]).toBe('        }');
    expect(count(after, 'std::fprintf('), 'fprintf が 2 件でない').toBe(2);
  });

  it('🔴 時刻と待った時間: どちらの印にも `t=%lld`、leave は `waited=%lld` = leave 時刻 − enter 時刻。時計は steady で ms', () => {
    const after = patched();
    const prints = after.split('\n').filter((l) => l.includes('std::fprintf('));
    expect(prints.length).toBe(2);
    for (const l of prints) expect(l).toContain(' t=%lld');
    expect(prints[0]).toContain('nPkc3EnterMs');
    expect(prints[1]).toContain('nPkc3LeaveMs, nPkc3Waited');
    expect(after).toContain('long long const nPkc3Waited = nPkc3LeaveMs - nPkc3EnterMs;');
    expect(count(after, 'std::chrono::steady_clock::now()')).toBe(1);
    expect(after).not.toContain('system_clock');
    expect(count(after, 'std::chrono::milliseconds')).toBe(1);
    // enter の時刻を取ってから `wait`、leave の時刻はその後(順序が逆なら waited が負になる)
    expect(after.indexOf('nPkc3EnterMs = pPkc3Ms()')).toBeLessThan(after.indexOf('m_InMainCondition.wait('));
    expect(after.indexOf('nPkc3LeaveMs = pPkc3Ms()')).toBeGreaterThan(after.indexOf('m_InMainCondition.wait('));
    // 🔴 所有者の thread id は出さない(`m_nThreadId` は private で、読み出し口が上流に無い)
    expect(after).not.toMatch(/get_id|m_nThreadId|#define private/);
  });

  it('🔴 enter が載せる状態は、鍵を持ったまま(`g` の中)で読む `m_isWakeUpMain` と `m_Closure` の有無。leave は `func` の有無', () => {
    const after = patched();
    const enterLine = after.split('\n').find((l) => l.includes(`${MARK}: enter #`))!;
    expect(enterLine).toContain('wake=%d closure=%d');
    expect(enterLine).toContain('m_isWakeUpMain ? 1 : 0, m_Closure ? 1 : 0');
    const leaveLine = after.split('\n').find((l) => l.includes(`${MARK}: leave #`))!;
    expect(leaveLine).toContain('closure=%d');
    expect(leaveLine).toContain('func ? 1 : 0');
    // `held_by_lo` は構成上いつも 1(tryToAcquire が偽の枝)。変数にしていない
    expect(enterLine).toContain('held_by_lo=1');
  });

  it('🔴 include: `<chrono>` と `<cstdio>` が `<mutex>` の直後に足され、使う所より前に在る', () => {
    const after = patched();
    expect(count(EXCERPT, '#include <cstdio>'), '抜粋の前提(元には無い)').toBe(0);
    expect(count(EXCERPT, '#include <chrono>'), '抜粋の前提(元には無い)').toBe(0);
    expect(after).toContain(`#include <mutex>\n#include <chrono> // ${MARK}\n#include <cstdio> // ${MARK}\n\nnamespace\n{\n`);
    const fnAt = after.indexOf('void QtYieldMutex::doAcquire(');
    expect(after.indexOf('#include <cstdio>')).toBeLessThan(fnAt);
    expect(after.indexOf('#include <chrono>')).toBeLessThan(fnAt);
  });

  it('🔴 足した行は全部 mark を含む。原文の行は 1 行も書き換えない(足すだけ)', () => {
    const after = patched();
    expect(after).not.toBe(EXCERPT);
    expect(restore(after)).toBe(EXCERPT);
    const added = after.split('\n').filter((l) => l.includes(MARK));
    expect(added.length).toBe(ADDED);
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

  it('🔴 原文の他の所は動かない: `doRelease` の `notify_all` / `RunInMainThread` 側の待ちには印を足していない', () => {
    const after = patched();
    expect(count(after, 'm_InMainCondition.notify_all(); // unblock main thread')).toBe(1);
    // 印は doAcquire の中だけ(doRelease には出ない)
    const rel = after.slice(after.indexOf('sal_uInt32 QtYieldMutex::doRelease('));
    expect(rel).not.toContain(MARK);
    const head = after.slice(0, after.indexOf('void QtYieldMutex::doAcquire('));
    // 先頭側に在る印は include の 2 行だけ
    expect(head.split('\n').filter((l) => l.includes(MARK)).length).toBe(2);
  });
});

describe('#1408 yield-wait ── 上流の実 file へ', () => {
  const real = UPSTREAM ? join(UPSTREAM, REL) : '';
  it.skipIf(!real || !existsSync(real))('🔴 実 file へ当たる(exit 0)。足した行は 23・消した行は 0。2 度目は SKIP で不変', () => {
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

  it.skipIf(!real || !existsSync(real))('🔴 抜粋は実 file の原文そのまま(95〜205 行)', () => {
    const orig = readFileSync(real, 'utf-8').split('\n').slice(94, 205).join('\n') + '\n';
    expect(EXCERPT.endsWith(orig)).toBe(true);
  });
});

describe('#1408 yield-wait ── 他の検査との関係', () => {
  it('🔑 同じ file(QtInstance.cxx)を触る別の patch の抜粋に、この patch の錨が混じっていない(錨が重ならない)', () => {
    const other = readFileSync('tests/fixtures/office-lo/QtInstance.excerpt.cxx', 'utf-8');
    for (const a of FIX_ANCHORS) {
      expect(count(other, a), `他の patch の抜粋に錨が在る:\n${a}`).toBe(0);
    }
    const owners = readdirSync('build/office-wasm')
      .filter((f) => /^patch-.*\.py$/.test(f))
      .filter((f) => readFileSync(join('build/office-wasm', f), 'utf-8').includes(`"${REL}"`));
    expect(owners).toContain('patch-lo-yield-wait.py');
  });

  it('🔑 check-patches-on-ref.sh が拾える形(`SRC = "…"`)で当て先を宣言している', () => {
    const src = readFileSync(SCRIPT, 'utf-8');
    expect(src).toMatch(/^SRC\s*=\s*"vcl\/qt5\/QtInstance\.cxx"/m);
  });

  it('🔑 workflow の本数の主張が、この 1 本を数えている(30 → 31)', () => {
    const yml = readFileSync('.github/workflows/office-wasm-build.yml', 'utf-8');
    expect(yml).toMatch(/30 → 31\(2026-10-07\)/);
    expect(yml).toContain('patch-lo-yield-wait.py');
    expect(yml).toContain('test "$n" -eq 31');
    expect(readdirSync('build/office-wasm').filter((f) => /^patch-.*\.py$/.test(f))).toContain('patch-lo-yield-wait.py');
  });
});
