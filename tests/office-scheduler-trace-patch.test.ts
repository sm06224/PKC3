/** @vitest-environment node */
/**
 * `build/office-wasm/patch-lo-scheduler-trace.py` を検める(#117 の**計装**)。
 *
 * 🔴 **これは直しではなく、数える計装である。** 文書を閉じると
 * `Scheduler::CallbackTaskScheduling()` の中で `null function or function signature
 * mismatch` が出る ── 仮説 A(破棄後の `mpTask`)と B(JSPI の再入)のどちらかを
 * **数で言う**ための patch で、焼きは 15〜30 分かかる。
 *
 * ⚠ 見るのは 3 つ:
 *   ① **挙動を変えていない** ── 足した行(行末が `// PKC3-SCHED`)と helper の塊を取り除くと、
 *      **原文と 1 バイトも違わない**(= 足しただけ)
 *   ② **錨が 1 つでも外れたら落ちる**(上流の変形を黙って通さない)/ 既定は 1 バイトも書かない
 *   ③ **helper が数えるべき物を数える** ── 解放後参照 / 再入 / LIFO でない出口 / 頂の取り違え
 *      (実際に g++ で組んで走らせ、印を読む)
 *
 * ⚠ **錨が「本物の上流」に当たることは、この test では言えない**(fixture は錨を並べた合成物)。
 * 本物への当たりは、焼く前に `check-patches-on-ref.sh` か、上流の原文へ直に当てて確かめる。
 */
import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = 'build/office-wasm/patch-lo-scheduler-trace.py';
const REL = 'vcl/source/app/scheduler.cxx';
const MARK = '// PKC3-SCHED';

/** patch の module から、錨・helper・印を取り出す(⚠ 錨の字をここへ書き写さない)。 */
function loadPatch(): { helper: string; helperAnchor: string; anchors: string[]; adds: number } {
  const code = [
    'import importlib.util,sys,json',
    'sys.dont_write_bytecode=True',
    `sp=importlib.util.spec_from_file_location("p","${SCRIPT}")`,
    'm=importlib.util.module_from_spec(sp); sp.loader.exec_module(m)',
    'print(json.dumps({"helper":m.HELPER,"helperAnchor":m.HELPER_ANCHOR,' +
      '"anchors":[m._anchor(p) for p in m.PARTS],' +
      '"adds":sum(1 for p in m.PARTS for x in p if not isinstance(x,str))}))',
  ].join('\n');
  return JSON.parse(execFileSync('python3', ['-c', code], { encoding: 'utf-8', stdio: 'pipe' }));
}

const PATCH = loadPatch();

/** 錨を 1 つずつ並べた合成の `scheduler.cxx`(⚠ 本物の上流ではない)。 */
function fixture(without: number | null = null): string {
  const parts = ['// head\n', PATCH.helperAnchor, '    int nBody = 0;\n};\n'];
  PATCH.anchors.forEach((a, i) => {
    if (i !== without) parts.push(`\n// ---- gap ${i} ----\n`, a);
  });
  return parts.join('');
}

interface Tree {
  dir: string;
  read: () => string;
  run: (on: boolean) => { code: number; out: string };
  cleanup: () => void;
}

function tree(body: string): Tree {
  const dir = mkdtempSync(join(tmpdir(), 'pkc3-sched-'));
  mkdirSync(join(dir, 'vcl/source/app'), { recursive: true });
  writeFileSync(join(dir, REL), body, 'utf-8');
  return {
    dir,
    read: () => readFileSync(join(dir, REL), 'utf-8'),
    run: (on) => {
      const env = { ...process.env, PKC3_SCHEDULER_TRACE: on ? '1' : '0' };
      const r = spawnSync('python3', [SCRIPT, dir], { encoding: 'utf-8', env, stdio: 'pipe' });
      return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** 足した行と helper の塊を取り除く。⚠ 残るのが原文と一致しなければ、足す以外をしている。 */
function strip(text: string): string {
  return text
    .replace(/\/\/ PKC3-SCHED-HELPER-BEGIN\n[\s\S]*?\/\/ PKC3-SCHED-HELPER-END\n\n/, '')
    .split('\n')
    .filter((l) => !l.trimEnd().endsWith(MARK))
    .join('\n');
}

describe('#117 の計装(scheduler)── 当て方', () => {
  it('🔑 空振り防止: 錨を拾えている(0 件でも「全部当たった」は真になる)', () => {
    expect(PATCH.anchors.length, '錨を 1 つも拾えていない').toBeGreaterThanOrEqual(15);
    expect(PATCH.adds, '足す行を 1 つも拾えていない').toBeGreaterThanOrEqual(PATCH.anchors.length);
    expect(new Set(PATCH.anchors).size, '同じ錨が 2 つ在る').toBe(PATCH.anchors.length);
  });

  it('🔴 既定(PKC3_SCHEDULER_TRACE!=1)は 1 バイトも書き換えない。錨の検査はする', () => {
    const t = tree(fixture());
    try {
      const before = t.read();
      const r = t.run(false);
      expect(r.code, r.out).toBe(0);
      expect(r.out).toContain('skip');
      expect(t.read(), '既定なのに書き換えている').toBe(before);
    } finally {
      t.cleanup();
    }
  });

  it('🔴 当てると helper が 1 つ入り、足した行は全部、行末が印で終わる', () => {
    const t = tree(fixture());
    try {
      const r = t.run(true);
      expect(r.code, r.out).toBe(0);
      const after = t.read();
      expect(after.match(/\/\/ PKC3-SCHED-HELPER-BEGIN/g)?.length, 'helper が 1 つでない').toBe(1);
      expect(after.match(/^void pkc3_sched_trace\(/gm)?.length, '入口が 1 つでない').toBe(1);
      const marks = after.split('\n').filter((l) => l.trimEnd().endsWith(MARK)).length;
      expect(marks, '足した行の数が、定義の数と違う').toBe(PATCH.adds);
    } finally {
      t.cleanup();
    }
  });

  it('🔴 挙動を変えていない ── 足した行と helper を除くと原文と一致する', () => {
    const t = tree(fixture());
    try {
      const before = t.read();
      const r = t.run(true);
      expect(r.code, r.out).toBe(0);
      // ⚠ 対照群: 当たった後が原文と違うこと(違わなければ、何も足していない)
      expect(t.read()).not.toBe(before);
      expect(strip(t.read())).toBe(before);
    } finally {
      t.cleanup();
    }
  });

  it('🔴 二重当ては落ち、file は 1 バイトも変わらない', () => {
    const t = tree(fixture());
    try {
      expect(t.run(true).code).toBe(0);
      const once = t.read();
      const r = t.run(true);
      expect(r.code, r.out).toBe(1);
      expect(r.out).toContain('二重当て');
      expect(t.read()).toBe(once);
    } finally {
      t.cleanup();
    }
  });

  /**
   * 🔴 **錨を 1 つずつ外して、毎回落ちること** ── 「N 個目だけが鳴る場面を N 通り作る」
   * (1 つ外しても他が救って緑、を許さない)。⚠ 既定(計装を入れない回)でも落ちる:
   * 上流の変形は、計装を入れない焼きでも**先に**気づきたい。
   */
  // ⚠ 錨全数のテストで並列負荷時に 5 秒を超えるため 20 秒に緩和(#1463)
  it('🔴 錨が 1 つでも無ければ落ちる(全数 ── 既定の回でも)', { timeout: 20_000 }, () => {
    expect(PATCH.anchors.length).toBeGreaterThan(0);
    for (let i = 0; i < PATCH.anchors.length; i++) {
      for (const on of [false, true]) {
        const t = tree(fixture(i));
        try {
          const before = t.read();
          const r = t.run(on);
          expect(r.code, `錨 ${i}(on=${on})を外しても落ちない:\n${r.out}`).toBe(1);
          expect(r.out, `錨 ${i} の落ち方が「錨の欠落」でない`).toContain('錨が 0 件');
          expect(t.read(), '落ちたのに書き換えている').toBe(before);
        } finally {
          t.cleanup();
        }
      }
    }
  });

  it('🔴 helper の錨が無くても落ちる(helper だけ入らず「呼ぶ側だけ入る」を許さない)', () => {
    const t = tree(fixture().replace(PATCH.helperAnchor, ''));
    try {
      const r = t.run(true);
      expect(r.code, r.out).toBe(1);
      expect(r.out).toContain('ヘルパーの錨が 0 件');
    } finally {
      t.cleanup();
    }
  });
});

/**
 * helper を**実際に g++ で組んで走らせ**、数えるべき物を数えることを見る。
 * ⚠ 呼び出し側(LO の中)は焼かないと通せないが、**数える部分は libc だけ**なので
 * 手元で全部通せる。`check-trace-helpers-compile.py` は「通る・1 行出る」しか見ない。
 */
const HARNESS = String.raw`
int main()
{
    int a = 0, b = 0, c = 0, d = 0;
    int many[1030];
    std::fprintf(stderr, "== S1\n");
    // ~Task: 静的な Task は mpTask を消さない枝なので、そこでも控える
    pkc3_sched_note_task_freed(&a, &b, "StaticTimer", 1);
    pkc3_sched_check("loop", 1, &b, &a);
    std::fprintf(stderr, "== S2\n");
    // 同じ番地に作り直された物は「解放済み」ではない
    pkc3_sched_note_alloc(&a);
    pkc3_sched_check("loop", 1, &b, &a);
    std::fprintf(stderr, "== S3\n");
    pkc3_sched_note_data_freed(&b, &a, "IdleX");
    pkc3_sched_check("post-invoke", 2, &b, &a);
    std::fprintf(stderr, "== S4\n");
    // 解放済みの Task の名前は読まない(読むと落ちる番地を渡す)
    pkc3_sched_note_task_freed(&c, nullptr, "T", 0);
    pkc3_sched_note_data_freed(&d, &c, reinterpret_cast<const char*>(1));
    pkc3_sched_check("loop", 1, &d, nullptr);
    std::fprintf(stderr, "== S5\n");
    // 環は 1024 件: 1030 件控えると、最初の 6 件が押し出される
    for (int i = 0; i < 1030; ++i)
        pkc3_sched_note_task_freed(&many[i], nullptr, "M", 0);
    std::fprintf(stderr, "S5 first=%d sixth=%d seventh=%d last=%d\n",
                 pkc3_sched_check("ring", 1, nullptr, &many[0]),
                 pkc3_sched_check("ring", 1, nullptr, &many[5]),
                 pkc3_sched_check("ring", 1, nullptr, &many[6]),
                 pkc3_sched_check("ring", 1, nullptr, &many[1029]));
    std::fprintf(stderr, "== S6\n");
    {
        Pkc3SchedDepth d1;
        // 深さ 1 かつ再入が起きる前は、STEP を出さない(高頻度なので)
        pkc3_sched_step(d1.nMy, "pre", &a, &b, "OuterTask");
        pkc3_sched_step(d1.nMy, "Invoke", &a, &b, "OuterTask");
        {
            Pkc3SchedDepth d2;
            pkc3_sched_step(d2.nMy, "inner", &c, &d, "InnerTask");
        }
        // 再入が一度でも起きた後は、深さ 1 でも出す
        pkc3_sched_step(d1.nMy, "post", &a, &b, "OuterTask");
    }
    std::fprintf(stderr, "== S7\n");
    {
        // JSPI は入れ子の順に再開するとは限らない: 先に入った物が先に出る
        Pkc3SchedDepth* x = new Pkc3SchedDepth;
        Pkc3SchedDepth* y = new Pkc3SchedDepth;
        delete x;
        delete y;
    }
    std::fprintf(stderr, "== S8\n");
    pkc3_sched_stack_pop(1, &a, &a);
    pkc3_sched_stack_pop(1, &a, &b);
    std::fprintf(stderr, "== S9\n");
    pkc3_sched_state(1, nullptr, &a, nullptr, nullptr);
    pkc3_sched_note_data_freed(&c, nullptr, "S");
    pkc3_sched_state(1, &a, &a, &c, nullptr);
    return 0;
}
`;

function runHarness(): string {
  const code = [
    'import importlib.util,sys',
    'sys.dont_write_bytecode=True',
    `sp=importlib.util.spec_from_file_location("p","${SCRIPT}")`,
    'm=importlib.util.module_from_spec(sp); sp.loader.exec_module(m)',
    'sys.stdout.write(m.HELPER)',
  ].join('\n');
  const helper = execFileSync('python3', ['-c', code], { encoding: 'utf-8', stdio: 'pipe' });
  const dir = mkdtempSync(join(tmpdir(), 'pkc3-sched-h-'));
  try {
    const cxx = join(dir, 't.cxx');
    const exe = join(dir, 't');
    writeFileSync(cxx, `${helper}\n${HARNESS}`, 'utf-8');
    execFileSync('g++', ['-std=c++20', '-Wall', '-Wextra', '-Werror', cxx, '-o', exe], {
      stdio: 'pipe',
    });
    const r = spawnSync(exe, [], { encoding: 'utf-8', cwd: dir, stdio: 'pipe' });
    expect(r.status, r.stderr).toBe(0);
    return r.stderr;
  } finally {
    rmSync(dir, { recursive: true, force: true });
    // helper は固定の path(/tmp/pkc3-sched.log)へも書く ── 走らせた後に残さない
    rmSync('/tmp/pkc3-sched.log', { force: true });
  }
}

/** `== Sn` で区切った各場面の行を返す。 */
function sections(err: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  let cur = '';
  for (const line of err.split('\n')) {
    const m = /^== (S\d+)$/.exec(line);
    if (m) {
      cur = m[1]!;
      out[cur] = [];
    } else if (cur && line.length > 0) out[cur]!.push(line);
  }
  return out;
}

/** 計装が出した行だけ(`PKC3-SCHED ` で始まる)。 */
const say = (lines: string[] | undefined): string[] =>
  (lines ?? []).filter((l) => l.startsWith('PKC3-SCHED '));

describe('#117 の計装(scheduler)── helper が数えるべき物を数える', () => {
  const err = runHarness();
  const S = sections(err);

  it('🔑 空振り防止: 9 場面とも走っている', () => {
    for (let i = 1; i <= 9; i++) expect(S[`S${i}`], `S${i} が走っていない`).toBeDefined();
  });

  it('🔴 A: 解放済みの Task を握ったら USE-AFTER-FREE を出す(静的な Task の枝でも)', () => {
    const l = say(S.S1);
    const hit = l.find((x) => x.includes('USE-AFTER-FREE'));
    expect(hit, `出ていない:\n${l.join('\n')}`).toBeDefined();
    expect(hit).toMatch(/name=StaticTimer depth=1 where=loop via=task static=1/);
  });

  it('🔴 A の対照: 同じ番地に作り直されたら、解放済みと言わない', () => {
    expect(say(S.S2).filter((x) => x.includes('USE-AFTER-FREE'))).toEqual([]);
  });

  it('🔴 A: 解放済みの ImplSchedulerData(data 側)も当てる。控えた名前を出す', () => {
    const hit = say(S.S3).find((x) => x.includes('USE-AFTER-FREE'));
    expect(hit, `出ていない:\n${say(S.S3).join('\n')}`).toBeDefined();
    expect(hit).toMatch(/name=IdleX depth=2 where=post-invoke via=data/);
  });

  it('🔴 解放済みの Task の名前は読まない(読むと落ちる番地を渡しても落ちない)', () => {
    // harness が status 0 で終わっていること自体が、名前を読んでいない証拠
    const hit = say(S.S4).find((x) => x.includes('USE-AFTER-FREE'));
    expect(hit, `出ていない:\n${say(S.S4).join('\n')}`).toBeDefined();
    expect(hit).toMatch(/name=\? /);
  });

  it('🔴 環は直近 1024 件: 古い 6 件は押し出され、新しい物は残る', () => {
    expect(S.S5!.find((l) => l.startsWith('S5 '))).toBe('S5 first=0 sixth=0 seventh=1 last=1');
  });

  it('🔴 B: 深さ 2 で入ったら REENTER と、外側の frame(どの task の Invoke の中か)を出す', () => {
    const l = say(S.S6);
    expect(l.some((x) => /REENTER depth=2 reenters=1/.test(x)), l.join('\n')).toBe(true);
    expect(
      l.some((x) => /FRAME\[1\] why=REENTER step=Invoke .*name=OuterTask/.test(x)),
      `外側が名指しされていない:\n${l.join('\n')}`,
    ).toBe(true);
  });

  it('🔴 STEP は、深さ 1 で再入の前なら出さず、再入の後なら深さ 1 でも出す', () => {
    const steps = say(S.S6).filter((x) => x.includes(' STEP '));
    expect(steps.some((x) => x.includes('STEP pre ')), '再入の前なのに出している').toBe(false);
    expect(steps.some((x) => x.includes('STEP Invoke ')), '再入の前なのに出している').toBe(false);
    expect(steps.some((x) => x.includes('STEP inner ')), '深さ 2 なのに出ていない').toBe(true);
    expect(steps.some((x) => x.includes('STEP post ')), '再入の後なのに出ていない').toBe(true);
  });

  it('🔴 B: LIFO でない出口を NON-LIFO と言う。LIFO の出口は言わない', () => {
    const l = say(S.S7);
    expect(l.some((x) => /LEAVE-NON-LIFO a=1 b=2 /.test(x)), l.join('\n')).toBe(true);
    // 2 つ目(a=2)は、そのとき b=1 ── 順は逆で、a と b が違うので NON-LIFO
    expect(l.some((x) => /LEAVE-NON-LIFO a=2 b=1 /.test(x)), l.join('\n')).toBe(true);
    // 対照群: S6 の内側の出口(a=2, b=2)は LIFO なので NON-LIFO と言わない
    const leave = say(S.S6).find((x) => /PKC3-SCHED LEAVE/.test(x));
    expect(leave, 'S6 の出口が出ていない').toBeDefined();
    expect(leave).toMatch(/LEAVE a=2 b=2 /);
    expect(leave).not.toContain('NON-LIFO');
  });

  it('🔴 B: pop で頂が自分でなければ STACK-MISMATCH。自分なら言わない', () => {
    const l = say(S.S8);
    expect(l.filter((x) => x.includes('STACK-MISMATCH ')).length, l.join('\n')).toBe(1);
  });

  it('🔴 依存が null なら NULL-DEPS、スタックの頂が解放済みなら where=stack で言う', () => {
    const l = say(S.S9);
    expect(l.some((x) => /NULL-DEPS timer=(\(nil\)|0x0|0) /.test(x)), l.join('\n')).toBe(true);
    expect(l.some((x) => /USE-AFTER-FREE .* where=stack /.test(x)), l.join('\n')).toBe(true);
  });
});

describe('#117 の計装(scheduler)── 他の patch との関係', () => {
  it('🔑 行の取り合いが無い: idles-deadlock が触る所(IdlesLockGuard)を、この patch は錨にしない', () => {
    const touched = PATCH.anchors.concat([PATCH.helperAnchor]).join('\n');
    expect(touched).not.toContain('IdlesLockGuard');
    expect(touched).not.toContain('m_inExecuteCondtion');
  });

  it('🔑 helper の当て先が、スコープ検査(check-patch-scope.py)にも載っている', () => {
    // ⚠ SPECS は手書きの一覧 ── 足し忘れると、この file だけ検査の外になる
    const scope = readFileSync('build/office-wasm/check-patch-scope.py', 'utf-8');
    const at = scope.indexOf('"PKC3_SCHEDULER_TRACE"');
    expect(at, 'SPECS に PKC3_SCHEDULER_TRACE が無い').toBeGreaterThan(-1);
    const block = scope.slice(at, scope.indexOf('"PKC3_IME_TRACE"'));
    expect(block).toContain('"patch-lo-scheduler-trace.py"');
    expect(block).toContain('"pkc3_sched_trace"');
    expect(block).toContain(`"${REL}"`);
    expect(block).toContain(PATCH.helperAnchor.trim().replace(/\($/, '('));
  });
});
