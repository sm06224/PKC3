/** @vitest-environment node */
/**
 * `build/office-wasm/patch-lo-scheduler-task-gone.py` を検める(#117 の**直し**)。
 *
 * 🔴 **直す物**: Office の文書を閉じると `RuntimeError: null function or function signature
 * mismatch` で止まる。`Scheduler::CallbackTaskScheduling()` の JSPI の枝は、`pTask` を**先に**
 * 読んでから `SolarMutexGuard g;` を取る。その錠の待ちで JSPI が中断している間に文書が閉じられ、
 * `Task`(`InterimItemWindow` の `m_aLayoutIdle`)が破棄されると、再開した外側の frame は
 * **破棄済みの番地へ** `pTask->Invoke()` を呼ぶ。直しは、錠を取った**後**で
 * `pMostUrgent->mpTask` を読み直し、null なら Invoke しない。
 *
 * ⚠ 見るのは 6 つ:
 *   ① **錨が原文に当たる**(上流の原文から抜いた抜粋 ── 合成した物ではない)/ 1 つ外しても落ちる /
 *      二重当ては落ちて不変
 *   ② **直しの中身を、描いた結果で見る**: JSPI の枝から `pTask->Invoke();` が消え、錠の**後**に
 *      読み直した Task を条件つきで Invoke する / `#else`(非 JSPI)と proxy の枝は残る
 *   ③ **足した行は全部印を含み、置き換えた原文は 1 行だけ**(印の行を除いて戻すと原文と一致)
 *   ④ **計装(`patch-lo-scheduler-trace.py`)と両立**: 錨が重ならず、どちらの順で当てても出力が同一
 *   ⑤ **`<cstdio>`** が足されている(`std::fputs` の宣言)
 *   ⑥ スコープ検査(`check-patch-scope.py`)の一覧に載っている **+ その FIXES を抜粋に対して実際に走らせる**
 *      (✅ になる / 足した行を 1 段深くする・`#include` を括弧の中へ入れると ✗)
 *
 * 🔴 **言えないこと**: 当てた後の C++ が本物の LO の header でコンパイルできること /
 * 本物の JSPI で破棄済みの Task を飛ばして文書が閉じられること。どちらも**焼いて、文書を閉じる
 * probe で `PKC3-TASKGONE:` の行が出て fault が消える**まで確かめられない
 * (抜粋は上流の原文だが、全文ではない)。
 */
import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const SCRIPT = 'build/office-wasm/patch-lo-scheduler-task-gone.py';
const TRACE = 'build/office-wasm/patch-lo-scheduler-trace.py';
const REL = 'vcl/source/app/scheduler.cxx';
const MARK = 'PKC3-TASKGONE';
const EXCERPT = readFileSync('tests/fixtures/office-lo/scheduler.excerpt.cxx', 'utf-8');

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
const TRACE_ANCHORS = pyJson(TRACE, '[m._anchor(p) for p in m.PARTS] + [m.HELPER_ANCHOR]') as string[];

interface Tree {
  dir: string;
  read: () => string;
  write: (body: string) => void;
  cleanup: () => void;
}

function tree(body: string = EXCERPT): Tree {
  const dir = mkdtempSync(join(tmpdir(), 'pkc3-taskgone-'));
  const put = (b: string): void => {
    mkdirSync(dirname(join(dir, REL)), { recursive: true });
    writeFileSync(join(dir, REL), b, 'utf-8');
  };
  put(body);
  return {
    dir,
    read: () => readFileSync(join(dir, REL), 'utf-8'),
    write: put,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function run(script: string, dir: string, trace = false): { code: number; out: string } {
  const r = spawnSync('python3', [script, dir], {
    encoding: 'utf-8',
    env: { ...process.env, PKC3_SCHEDULER_TRACE: trace ? '1' : '0' },
    stdio: 'pipe',
  });
  return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
}

/** 数える(部分文字列の出現数)。 */
const count = (text: string, needle: string): number => text.split(needle).length - 1;

const JSPI_HEAD = '            else\n            {\n';
const GUARD = '                SolarMutexGuard g;\n';

/** JSPI の枝(`else {` から、`#else` の行まで)を切り出す。⚠ 切り出せたことも assert する。 */
function jspiBranch(text: string): string {
  const from = text.indexOf(JSPI_HEAD + GUARD);
  expect(from, 'JSPI の枝を引けない').toBeGreaterThan(-1);
  const to = text.indexOf('#else\n', from);
  expect(to, 'JSPI の枝の終わり(`#else`)を引けない').toBeGreaterThan(from);
  return text.slice(from, to);
}

/**
 * 足した行(印を含む行)を取り除き、置き換えた JSPI の枝の 1 行を戻す。
 * ⚠ 戻す字は**原文の字**(patch から取らない)。残るのが原文と一致しなければ、
 * 「足す + 1 行置き換える」以外をしている。
 */
function restore(text: string): string {
  return text
    .split('\n')
    .filter((l) => !l.includes(MARK))
    .join('\n')
    .replace(`${GUARD}            }\n`, `${GUARD}                pTask->Invoke();\n            }\n`);
}

describe('#117 の直し(scheduler-task-gone)── 当て方', () => {
  it('🔑 空振り防止: 錨を拾えている(0 件でも「全部当たった」は真になる)', () => {
    expect(FIX_ANCHORS.length, '直しの錨を拾えていない').toBe(2);
    expect(new Set(FIX_ANCHORS).size, '同じ錨が 2 つ在る').toBe(FIX_ANCHORS.length);
    expect(TRACE_ANCHORS.length, '計装の錨を拾えていない').toBeGreaterThanOrEqual(15);
    expect(EXCERPT, '抜粋が空').toContain('Scheduler::CallbackTaskScheduling()');
  });

  it('🔴 錨は、上流の原文の抜粋に**ちょうど 1 件**ずつ当たる', () => {
    for (const a of FIX_ANCHORS) {
      expect(count(EXCERPT, a), `錨が 1 件でない:\n${a}`).toBe(1);
    }
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

describe('#117 の直し(scheduler-task-gone)── 当てた結果(描いた C++ で見る)', () => {
  function patched(): string {
    const t = tree();
    try {
      expect(run(SCRIPT, t.dir).code).toBe(0);
      return t.read();
    } finally {
      t.cleanup();
    }
  }

  it('🔴 JSPI の枝: 錠の「後」に mpTask を読み直し、null なら Invoke しない', () => {
    const branch = jspiBranch(patched());
    const guardAt = branch.indexOf('SolarMutexGuard g;');
    const readAt = branch.indexOf('Task* const pLiveTask = pMostUrgent->mpTask;');
    const ifAt = branch.indexOf('if (pLiveTask)');
    const callAt = branch.indexOf('pLiveTask->Invoke();');
    const elseAt = branch.indexOf('else // PKC3-TASKGONE');
    for (const [n, at] of Object.entries({ guardAt, readAt, ifAt, callAt, elseAt })) {
      expect(at, `${n} が JSPI の枝に無い`).toBeGreaterThan(-1);
    }
    // 順序: 錠 → 読み直し → 条件 → Invoke → 飛ばした印
    expect(guardAt).toBeLessThan(readAt);
    expect(readAt).toBeLessThan(ifAt);
    expect(ifAt).toBeLessThan(callAt);
    expect(callAt).toBeLessThan(elseAt);
    // 🔴 破棄済みかもしれない古い pTask は、この枝で Invoke されない
    expect(branch, 'JSPI の枝に古い pTask の Invoke が残っている').not.toContain('pTask->Invoke()');
    // 飛ばした回数を数える印(libc だけ)
    expect(branch).toContain('std::fputs("PKC3-TASKGONE: ');
  });

  it('🔴 触らない枝が残っている: `#else`(非 JSPI)と proxy の lambda の Invoke、`pTask` の読みと SetDeletionFlags', () => {
    const after = patched();
    // 元の 3 つ(JSPI / proxy lambda / #else)のうち、JSPI の 1 つだけが減る
    expect(count(EXCERPT, 'pTask->Invoke();'), '抜粋の前提(元は 3 つ)').toBe(3);
    expect(count(after, 'pTask->Invoke();')).toBe(2);
    expect(after).toContain('#else\n            pTask->Invoke();\n#endif\n');
    expect(after).toContain('                        SolarMutexGuard g;\n                        pTask->Invoke();\n');
    expect(after).toContain('    Task *pTask = pMostUrgent->mpTask;\n');
    expect(after).toContain('            pTask->SetDeletionFlags();\n');
    expect(after).toContain('            if (pTask->DecideTransferredExecution())\n');
  });

  it('🔴 `#include <cstdio>` が `<cstdlib>` の直後に足されている(`std::fputs` の宣言)', () => {
    const after = patched();
    expect(count(EXCERPT, '#include <cstdio>'), '抜粋の前提(元には無い)').toBe(0);
    expect(after).toContain(`#include <cstdlib>\n#include <cstdio> // ${MARK}\n#include <exception>`);
    // include は file の頭(関数の外)に在り、fputs を使う所より前
    expect(after.indexOf('#include <cstdio>')).toBeLessThan(after.indexOf('std::fputs'));
  });

  it('🔴 足した行は全部印を含み、置き換えた原文は JSPI の枝の 1 行だけ(戻すと原文と一致)', () => {
    const after = patched();
    // ⚠ 対照群: 当たった後が原文と違うこと(違わなければ、何も足していない)
    expect(after).not.toBe(EXCERPT);
    expect(restore(after)).toBe(EXCERPT);
    // 足した行は 10 行(include 1 + 注釈 4 + 読み直し 1 + if/call/else/fputs 4)
    const added = after.split('\n').filter((l) => l.includes(MARK));
    expect(added.length).toBe(10);
    // 🔴 中身まで見る(レビュー 2026-10-04): 件数と順序だけだと、注釈の 1 行を `return;` に替える /
    //    注釈の行末に `\\` を足して次の宣言をコメントに連結する、という変異が緑のまま C++ を壊す。
    //    ⚠ 期待値は patch から取らず**手で書く**(同じ盲点を共有しない)。
    const code = added.filter((l) => !/^\s*\/\/ /.test(l)).map((l) => l.trim());
    expect(code).toEqual([
      `#include <cstdio> // ${MARK}`,
      `Task* const pLiveTask = pMostUrgent->mpTask; // ${MARK}`,
      `if (pLiveTask) // ${MARK}`,
      `pLiveTask->Invoke(); // ${MARK}`,
      `else // ${MARK}`,
      `std::fputs("${MARK}: task destroyed while waiting for the SolarMutex; Invoke skipped\\n", stderr); // ${MARK}`,
    ]);
    for (const l of added) {
      expect(l, '行末の \\ は次の行をコメントへ連結する').not.toMatch(/\\\s*$/);
      expect(l, 'ブロックコメントは使わない').not.toMatch(/\/\*|\*\//);
    }
    // 注釈は 4 行で、全部 `//` 始まり(実行文を注釈の顔で足していない)
    expect(added.filter((l) => /^\s*\/\/ /.test(l)).length).toBe(4);
  });
});

describe('#117 の直し(scheduler-task-gone)── 計装(scheduler-trace)と両立する', () => {
  it('🔴 錨の範囲が重ならない(原文の上で、どの錨も別の錨の字を含まない)', () => {
    const spans = [
      ...FIX_ANCHORS.map((a) => ({ who: 'fix', a })),
      ...TRACE_ANCHORS.map((a) => ({ who: 'trace', a })),
    ].map(({ who, a }) => ({ who, from: EXCERPT.indexOf(a), to: EXCERPT.indexOf(a) + a.length }));
    for (const s of spans) expect(s.from, `${s.who} の錨が原文に無い`).toBeGreaterThanOrEqual(0);
    for (let i = 0; i < spans.length; i++) {
      for (let j = i + 1; j < spans.length; j++) {
        const a = spans[i]!;
        const b = spans[j]!;
        expect(a.to <= b.from || b.to <= a.from, `錨が重なっている: ${a.who} と ${b.who}`).toBe(true);
      }
    }
  });

  it('🔴 両方当てても、どちらの順でも出力が 1 バイトも違わない', () => {
    const ab = tree();
    const ba = tree();
    try {
      expect(run(SCRIPT, ab.dir).code).toBe(0);
      const r1 = run(TRACE, ab.dir, true);
      expect(r1.code, r1.out).toBe(0);
      const r2 = run(TRACE, ba.dir, true);
      expect(r2.code, r2.out).toBe(0);
      expect(run(SCRIPT, ba.dir).code).toBe(0);
      expect(ab.read(), '当てる順で出力が違う').toBe(ba.read());
      // 対照群: 両方入っている(片方が当たっていないだけの「一致」を許さない)
      expect(ab.read()).toContain(MARK);
      expect(ab.read()).toContain('// PKC3-SCHED');
      expect(ab.read()).toContain('pLiveTask->Invoke();');
      expect(ab.read()).toContain('"Invoke", ');
    } finally {
      ab.cleanup();
      ba.cleanup();
    }
  });

  it('🔴 計装を切った回(既定)でも直しは当たる ── 計装の有無で直しが変わらない', () => {
    const fixOnly = tree();
    const both = tree();
    try {
      expect(run(SCRIPT, fixOnly.dir).code).toBe(0);
      expect(run(TRACE, both.dir, false).code).toBe(0); // skip(1 バイトも書かない)
      expect(both.read(), '計装を切った回なのに書き換えている').toBe(EXCERPT);
      expect(run(SCRIPT, both.dir).code).toBe(0);
      expect(both.read()).toBe(fixOnly.read());
    } finally {
      fixOnly.cleanup();
      both.cleanup();
    }
  });
});

describe('#117 の直し(scheduler-task-gone)── 他の検査との関係', () => {
  it('🔑 当て先が、スコープ検査(check-patch-scope.py)の一覧に載っている', () => {
    // ⚠ 一覧は手書き ── 足し忘れると、この patch だけ検査の外になる
    const scope = readFileSync('build/office-wasm/check-patch-scope.py', 'utf-8');
    const at = scope.indexOf('FIXES = [');
    expect(at, 'check-patch-scope.py に FIXES が無い').toBeGreaterThan(-1);
    const block = scope.slice(at, scope.indexOf('print("=== 本番(ヘルパーを持たない直し', at));
    expect(block).toContain('"patch-lo-scheduler-task-gone.py"');
    expect(block).toContain(`"${REL}"`);
    expect(block).toContain('Task* const pLiveTask = pMostUrgent->mpTask;');
  });

  it('🔑 workflow の本数の主張が、実在する patch-*.py と合っている(新しい 1 本を数えている)', () => {
    const yml = readFileSync('.github/workflows/office-wasm-build.yml', 'utf-8');
    expect(yml).toContain('patch-lo-scheduler-task-gone.py');
    expect(yml).toMatch(/19 → 20\(2026-10-04\)/);
  });

  it('🔑 check-patches-on-ref.sh が拾える形(`SRC = "…"`)で当て先を宣言している', () => {
    const src = readFileSync(SCRIPT, 'utf-8');
    expect(src).toMatch(/^SRC\s*=\s*"vcl\/source\/app\/scheduler\.cxx"/m);
  });
});

describe('#117 の直し(scheduler-task-gone)── スコープ検査(check-patch-scope.py の FIXES)を実際に走らせる', () => {
  const CHECK = 'build/office-wasm/check-patch-scope.py';

  /** FIXES だけを走らせる(`PKC3_SCOPE_ONLY=fixes`)。LO の全体は要らず、抜粋 1 つの木で足りる。 */
  function scope(checkScript: string, dir: string): { code: number; out: string } {
    // 🔑 FIXES は他の直しも載せる(`patch-lo-menu-popup-sync.py` ── #121)。その当て先も木に要る
    //    (無いと「元 file が無い」で、この直しと関係なく落ちる)。
    const other = join(dir, 'framework/source/uielement/menubarmanager.cxx');
    mkdirSync(dirname(other), { recursive: true });
    writeFileSync(other, readFileSync('tests/fixtures/office-lo/menubarmanager.excerpt.cxx', 'utf-8'), 'utf-8');
    const r = spawnSync('python3', [checkScript, dir], {
      encoding: 'utf-8',
      env: { ...process.env, PKC3_SCOPE_ONLY: 'fixes' },
      stdio: 'pipe',
    });
    return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
  }

  /**
   * 検査と直しの patch を**別の場所へ写し**、patch の描く C++ だけを壊して走らせる。
   * ⚠ 検査は `HERE`(自分の置き場)から patch を引くので、写した先の patch が当たる。
   * ⚠ 壊す前に「元の字が 1 件在る」ことを見る(当たらなかった変異を「落ちた」と読まない)。
   */
  function scopeWithBrokenPatch(from: string, to: string): { code: number; out: string } {
    const dir = mkdtempSync(join(tmpdir(), 'pkc3-scope-mut-'));
    const t = tree();
    try {
      const src = readFileSync(SCRIPT, 'utf-8');
      expect(count(src, from), '壊す元の字が 1 件でない(変異が当たらない)').toBe(1);
      writeFileSync(join(dir, 'patch-lo-scheduler-task-gone.py'), src.replace(from, to), 'utf-8');
      writeFileSync(join(dir, 'check-patch-scope.py'), readFileSync(CHECK, 'utf-8'), 'utf-8');
      writeFileSync(
        join(dir, 'patch-lo-menu-popup-sync.py'),
        readFileSync('build/office-wasm/patch-lo-menu-popup-sync.py', 'utf-8'),
        'utf-8',
      );
      return scope(join(dir, 'check-patch-scope.py'), t.dir);
    } finally {
      t.cleanup();
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('🔴 抜粋に当てた木で、FIXES が ✅(exit 0)。対照群 / SPECS は走らない', () => {
    const t = tree();
    try {
      const r = scope(CHECK, t.dir);
      expect(r.code, r.out).toBe(0);
      expect(r.out).toContain('✅ 同じスコープ');
      expect(r.out).toContain('CallbackTaskScheduling の JSPI の枝');
      expect(r.out).toContain('include 深さ 0');
      expect(r.out).toContain('fail=0');
      // 🔑 絞れていること(LO の全体が無い木で、対照群の「元 file が無い」が出ていない)
      expect(r.out).not.toContain('元 file が無い');
      expect(r.out).not.toContain('🔴');
    } finally {
      t.cleanup();
    }
  });

  it('🔴 足した行が原文より 1 段深くなる(`{` が 1 つ増える)と ✗(exit ≠ 0)', () => {
    // ⚠ 字下げではなく**括弧**で深さが決まる(検査は `{` `}` を数える。空白だけ動かしても深さは同じ)
    const from = '                Task* const pLiveTask = pMostUrgent->mpTask; // PKC3-TASKGONE\n';
    const r = scopeWithBrokenPatch(from, `                { // PKC3-TASKGONE\n${from}`);
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain('スコープが違う');
    expect(r.out).toContain('fail=1');
    // ⚠ FIXES は他の直しも走らせる(それは ✅ のまま)── 見るのはこの直しの行だけ
    const mine = r.out.split('\n').filter((l) => l.includes('patch-lo-scheduler-task-gone.py'));
    expect(mine.length, 'この直しの行が出ていない').toBe(1);
    expect(mine[0]).not.toContain('✅ 同じスコープ');
  });

  it('🔴 `#include` が file scope でなくなる(`namespace { }` の中)と ✗ ── 足した行の深さは原文と同じでも落ちる', () => {
    const from = '#include <cstdio> // PKC3-TASKGONE\n';
    const r = scopeWithBrokenPatch(from, `namespace { // PKC3-TASKGONE\n${from}} // PKC3-TASKGONE\n`);
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain('include 深さ 1');
    expect(r.out).toContain('スコープが違う');
  });

  it('🔑 未知の絞り込みは断る(黙って全部走らせない / 黙って何も走らせない)', () => {
    const r = spawnSync('python3', [CHECK, '/nonexistent'], {
      encoding: 'utf-8',
      env: { ...process.env, PKC3_SCOPE_ONLY: 'no-such-name' },
      stdio: 'pipe',
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('PKC3_SCOPE_ONLY');
  });
});
