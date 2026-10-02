/**
 * 🔴 **索引の片づけの係(`AutoOptimizer`)**(#999 段③)── 時計と書込の回数を差して通す。
 *
 * 判断そのもの(3 条件の境界)は `tests/features/auto-optimize.test.ts` が見る。
 * ここが見るのは**係の配線**:
 * - 書込を数え、落ち着いてから **1 回だけ**打つ(打った後は数え直す)
 * - **書込の列の中で**打つ(列が空くまで打たない)/ 列の中で**もう 1 度**判断する
 * - 隠れているタブは戻ってから / lease を握らないタブは打たない
 * - 記録は **1 回につき 1 件**、**連続の失敗は 1 件**
 *
 * ⚠ 時計・タイマー・タブの見え方は全部**差し込み**(実時間を待たない)。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AutoOptimizer } from '../../src/adapter/platform/storage/auto-optimize';
import type { OptimizeIndexesResult, StorageGauge } from '../../src/adapter/platform/storage/protocol';
import {
  AUTO_OPTIMIZE_MIN_INTERVAL_MS,
  AUTO_OPTIMIZE_MIN_WRITES,
  AUTO_OPTIMIZE_QUIET_MS,
  OPTIMIZE_FAILED_TEXT,
  optimizeDoneText,
} from '../../src/features/storage/auto-optimize';

const MiB = 1024 * 1024;

function gauge(freeBytes: number): StorageGauge {
  return {
    pageCount: 100,
    pageSize: 8192,
    freelistCount: freeBytes / 8192,
    fileBytes: 100 * 8192,
    freeBytes,
    ftsSegments: 1,
    journalMode: 'truncate',
    tempStore: 0,
    elapsedMs: 1,
  };
}

const RESULT: OptimizeIndexesResult = {
  elapsedMs: 400,
  before: gauge(4 * MiB),
  after: gauge(12 * MiB),
};

interface Rig {
  optimizer: AutoOptimizer;
  /** 時計を進める(途中で期限が来たタイマーを順に鳴らす)。 */
  advance(ms: number): Promise<void>;
  noteWrites(n: number): void;
  posts: Array<{ kind: string; source: string; text: string }>;
  /** `optimize` が呼ばれた順の記録(`run` に入ってから呼ばれたかも載る)。 */
  log: string[];
  setHidden(h: boolean): void;
  setWriter(w: boolean): void;
  /** タブが見えるようになった合図を撃つ。 */
  fireVisible(): void;
  /** 書込の列を「まだ前の書込が着地していない」状態にする。 */
  holdQueue(): () => void;
  failNext(count: number): void;
  now(): number;
  optimizeCalls(): number;
}

function rig(): Rig {
  let t = 50_000_000;
  let hidden = false;
  let writer = true;
  let failures = 0;
  const timers: Array<{ at: number; fn: () => void; live: boolean }> = [];
  const visibleHandlers = new Set<() => void>();
  const posts: Rig['posts'] = [];
  const log: string[] = [];
  let queue: Promise<unknown> = Promise.resolve();
  let gate: Promise<void> | null = null;
  let optimizeCount = 0;
  let inRun = false;

  const flush = async (): Promise<void> => {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  };

  const optimizer = new AutoOptimizer({
    holdsWriterLease: () => writer,
    run: <T,>(job: () => Promise<T>): Promise<T> => {
      const wait = gate;
      const out = queue.then(async () => {
        if (wait) await wait;
        inRun = true;
        try {
          return await job();
        } finally {
          inRun = false;
        }
      });
      queue = out.then(
        () => undefined,
        () => undefined,
      );
      return out;
    },
    optimize: async () => {
      optimizeCount += 1;
      log.push(inRun ? 'optimize(in-run)' : 'optimize(OUTSIDE-RUN)');
      if (failures > 0) {
        failures -= 1;
        throw new Error('こわれた「秘密の題名」');
      }
      return RESULT;
    },
    post: (m) => {
      posts.push(m);
    },
    now: () => t,
    hidden: () => hidden,
    schedule: (fn, ms) => {
      const e = { at: t + ms, fn, live: true };
      timers.push(e);
      return () => {
        e.live = false;
      };
    },
    onVisible: (fn) => {
      visibleHandlers.add(fn);
      return () => {
        visibleHandlers.delete(fn);
      };
    },
  });

  return {
    optimizer,
    posts,
    log,
    now: () => t,
    optimizeCalls: () => optimizeCount,
    async advance(ms) {
      const target = t + ms;
      for (;;) {
        const due = timers
          .filter((e) => e.live && e.at <= target)
          .sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        due.live = false;
        t = Math.max(t, due.at);
        due.fn();
        await flush();
      }
      t = target;
      await flush();
    },
    noteWrites(n) {
      for (let i = 0; i < n; i += 1) optimizer.noteWrite();
    },
    setHidden(h) {
      hidden = h;
    },
    setWriter(w) {
      writer = w;
    },
    fireVisible() {
      for (const fn of [...visibleHandlers]) fn();
    },
    holdQueue() {
      let release!: () => void;
      gate = new Promise<void>((r) => (release = r));
      return () => {
        gate = null;
        release();
      };
    },
    failNext(count) {
      failures = count;
    },
  };
}

const MIN = AUTO_OPTIMIZE_MIN_WRITES;

describe('書込が落ち着いたら 1 回だけ打つ(#999 段③)', () => {
  it('🔴 50 回書いて 60 秒黙ると、1 回だけ打ち、処理の記録に 1 件積む', async () => {
    const r = rig();
    r.noteWrites(MIN);
    await r.advance(AUTO_OPTIMIZE_QUIET_MS - 1);
    expect(r.optimizeCalls(), '60 秒に 1ms 足りないのに打った').toBe(0);
    await r.advance(1);
    expect(r.optimizeCalls()).toBe(1);
    expect(r.posts).toEqual([
      { kind: 'job', source: 'storage-optimize', text: optimizeDoneText(400, 12 * MiB) },
    ]);
    // ⚠ 字の実物も 1 度は見る(関数を通しただけで「合っている」と言わない)
    expect(r.posts[0]?.text).toBe('索引を片づけました(0.4 秒、空き 12.0 MiB)');
    // その後も黙っていれば、もう打たない(1 回につき 1 件)
    await r.advance(AUTO_OPTIMIZE_MIN_INTERVAL_MS * 5);
    expect(r.optimizeCalls()).toBe(1);
    expect(r.posts).toHaveLength(1);
  });

  it('🔴 書込が 49 回では、何時間黙っていても打たない', async () => {
    const r = rig();
    r.noteWrites(MIN - 1);
    await r.advance(3 * 60 * 60_000);
    expect(r.optimizeCalls()).toBe(0);
    expect(r.posts).toHaveLength(0);
    // 対照群 ── あと 1 回で打つ
    r.noteWrites(1);
    await r.advance(AUTO_OPTIMIZE_QUIET_MS);
    expect(r.optimizeCalls()).toBe(1);
  });

  it('🔴 書き続けている間は打たない ── 最後の書込から 60 秒で打つ', async () => {
    const r = rig();
    r.noteWrites(MIN);
    await r.advance(AUTO_OPTIMIZE_QUIET_MS - 1_000);
    r.noteWrites(1); // 59 秒目にもう 1 回 → 数え直し
    await r.advance(AUTO_OPTIMIZE_QUIET_MS - 1);
    expect(r.optimizeCalls(), '最後の書込から 60 秒経っていないのに打った').toBe(0);
    await r.advance(1);
    expect(r.optimizeCalls()).toBe(1);
  });

  it('🔴 前回から 10 分は空ける(打った後は書込の数も数え直す)', async () => {
    const r = rig();
    r.noteWrites(MIN);
    await r.advance(AUTO_OPTIMIZE_QUIET_MS);
    expect(r.optimizeCalls()).toBe(1);
    const firstAt = r.now();

    // 打った後に 49 回では足りない ── 10 分を過ぎても打たない(数え直している)
    r.noteWrites(MIN - 1);
    await r.advance(AUTO_OPTIMIZE_MIN_INTERVAL_MS + AUTO_OPTIMIZE_QUIET_MS);
    expect(r.optimizeCalls(), '数え直していない(前回までの書込を持ち越した)').toBe(1);

    // 50 回目で足りる ── ただし前回から 10 分が経っているので、静かになり次第打つ
    r.noteWrites(1);
    await r.advance(AUTO_OPTIMIZE_QUIET_MS);
    expect(r.optimizeCalls()).toBe(2);
    expect(r.now() - firstAt).toBeGreaterThanOrEqual(AUTO_OPTIMIZE_MIN_INTERVAL_MS);
  });

  it('🔴 前回から 10 分に足りなければ、50 回書いて静かでも打たない ── 10 分で打つ', async () => {
    const r = rig();
    r.noteWrites(MIN);
    await r.advance(AUTO_OPTIMIZE_QUIET_MS);
    expect(r.optimizeCalls()).toBe(1);
    const firstAt = r.now();

    r.noteWrites(MIN);
    await r.advance(AUTO_OPTIMIZE_QUIET_MS); // 静かにはなったが、前回から 2 分
    expect(r.optimizeCalls(), '前回から 10 分経っていないのに打った').toBe(1);
    await r.advance(AUTO_OPTIMIZE_MIN_INTERVAL_MS - (r.now() - firstAt) - 1);
    expect(r.optimizeCalls()).toBe(1);
    await r.advance(1);
    expect(r.optimizeCalls(), '10 分経っても打たない(見直していない)').toBe(2);
  });
});

describe('隠れているタブ / lease を握らないタブ(#999 段③)', () => {
  it('🔴 隠れている間は打たない ── 戻ってきてから打つ', async () => {
    const r = rig();
    r.setHidden(true);
    r.noteWrites(MIN);
    await r.advance(AUTO_OPTIMIZE_QUIET_MS * 10);
    expect(r.optimizeCalls(), '隠れているのに打った').toBe(0);

    r.fireVisible(); // まだ隠れたまま(誤報)── 打たない
    await r.advance(0);
    expect(r.optimizeCalls()).toBe(0);

    r.setHidden(false);
    r.fireVisible();
    await r.advance(0);
    expect(r.optimizeCalls(), '戻ってきても打たない').toBe(1);
    expect(r.posts).toHaveLength(1);
  });

  it('🔴 lease を握らないタブは、50 回書いたと数えても打たない', async () => {
    const r = rig();
    r.setWriter(false);
    r.noteWrites(MIN);
    await r.advance(AUTO_OPTIMIZE_QUIET_MS * 10);
    expect(r.optimizeCalls(), 'lease を握らないのに打った').toBe(0);
    expect(r.posts).toHaveLength(0);
  });

  it('🔴 待っている間に lease を失ったら、打たない(列の中で見直す)', async () => {
    const r = rig();
    r.noteWrites(MIN);
    const release = r.holdQueue();
    await r.advance(AUTO_OPTIMIZE_QUIET_MS); // 列に載ったが、前の書込が着地していない
    r.setWriter(false);
    release();
    await r.advance(0);
    expect(r.optimizeCalls()).toBe(0);
  });
});

describe('書込の列に載せる(#999 段③)', () => {
  it('🔴 前の書込が着地するまで打たない ── 列の中で呼ばれる', async () => {
    const r = rig();
    r.noteWrites(MIN);
    const release = r.holdQueue();
    await r.advance(AUTO_OPTIMIZE_QUIET_MS);
    expect(r.optimizeCalls(), '列が空く前に打った(書込と並走)').toBe(0);
    // 書込が着地したが、それが「最後の書込」を動かさない形(= 落ち着いたまま)なら打つ
    release();
    await r.advance(0);
    expect(r.optimizeCalls()).toBe(1);
    expect(r.log).toEqual(['optimize(in-run)']);
  });

  it('🔴 列を待っている間に書込が着地したら、「落ち着いた」は崩れている ── 打たずに見直す', async () => {
    const r = rig();
    r.noteWrites(MIN);
    const release = r.holdQueue();
    await r.advance(AUTO_OPTIMIZE_QUIET_MS);
    expect(r.optimizeCalls()).toBe(0);
    r.noteWrites(1); // 列に並んでいた書込がいま着地した
    release();
    await r.advance(0);
    expect(r.optimizeCalls(), '着地したばかりの書込の直後に打った').toBe(0);
    // 見直しの時計が張られている ── 静かになれば打つ(取りこぼさない)
    await r.advance(AUTO_OPTIMIZE_QUIET_MS - 1);
    expect(r.optimizeCalls()).toBe(0);
    await r.advance(1);
    expect(r.optimizeCalls()).toBe(1);
  });
});

describe('処理の記録(#999 段③)', () => {
  it('🔴 失敗は 1 件積む ── 字に例外の中身(題名など)を載せない', async () => {
    const r = rig();
    r.failNext(1);
    r.noteWrites(MIN);
    await r.advance(AUTO_OPTIMIZE_QUIET_MS);
    expect(r.optimizeCalls()).toBe(1);
    expect(r.posts).toEqual([{ kind: 'job', source: 'storage-optimize', text: OPTIMIZE_FAILED_TEXT }]);
    expect(r.posts[0]?.text).not.toContain('秘密');
  });

  it('🔴 同じ失敗が続いても積むのは 1 件 ── 成功したら数え直す', async () => {
    const r = rig();
    r.failNext(2);
    const cycle = async (): Promise<void> => {
      r.noteWrites(MIN);
      await r.advance(AUTO_OPTIMIZE_MIN_INTERVAL_MS + AUTO_OPTIMIZE_QUIET_MS);
    };
    await cycle(); // 失敗 1
    await cycle(); // 失敗 2(連続)
    expect(r.optimizeCalls()).toBe(2);
    expect(r.posts.map((p) => p.text), '連続の失敗を積み増した').toEqual([OPTIMIZE_FAILED_TEXT]);
    await cycle(); // 成功
    expect(r.posts.map((p) => p.text)).toEqual([OPTIMIZE_FAILED_TEXT, optimizeDoneText(400, 12 * MiB)]);
    r.failNext(1);
    await cycle(); // 成功の後の失敗は、また 1 件積む(数え直している)
    expect(r.posts.map((p) => p.text)).toEqual([
      OPTIMIZE_FAILED_TEXT,
      optimizeDoneText(400, 12 * MiB),
      OPTIMIZE_FAILED_TEXT,
    ]);
  });

  it('🔴 失敗した回も「前回」に数える ── 10 分以内にやり直さない', async () => {
    const r = rig();
    r.failNext(1);
    r.noteWrites(MIN);
    await r.advance(AUTO_OPTIMIZE_QUIET_MS);
    expect(r.optimizeCalls()).toBe(1);
    r.noteWrites(MIN);
    await r.advance(AUTO_OPTIMIZE_QUIET_MS * 2);
    expect(r.optimizeCalls(), '失敗の直後にやり直した').toBe(1);
  });

  it('🔴 dispose の後は、数えも打ちもしない', async () => {
    const r = rig();
    r.noteWrites(MIN);
    r.optimizer.dispose();
    await r.advance(AUTO_OPTIMIZE_QUIET_MS * 10);
    expect(r.optimizeCalls()).toBe(0);
    r.noteWrites(MIN);
    await r.advance(AUTO_OPTIMIZE_QUIET_MS * 10);
    expect(r.optimizeCalls()).toBe(0);
  });
});

/**
 * 🔴 **配線の原文 pin**(⚠ 弱いと自覚して置く)── `main.ts` はどの test からも実行されない
 * (CLAUDE.md §2)。判断は上で見ているので、ここは**繋がっていること**だけを見る:
 * 書込の通知が `onMutation` から係へ届く / lease の判定に `writerHolder` を渡す /
 * 書込の列(`storeEffects.run`)に載せる / VACUUM を打たない。
 * ⚠ **注釈を落としてから見る**(自分の解説に満たされない)。
 */
describe('main.ts の配線(原文 pin)', () => {
  const code = ((): string => {
    const src = readFileSync(join(process.cwd(), 'src/main.ts'), 'utf-8');
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  })();

  it('🔴 書込の通知(onMutation)が係へ届く', () => {
    const m = /onMutation:\s*\(\):\s*void\s*=>\s*\{([\s\S]*?)\},\s*\};/.exec(code);
    expect(m, 'onMutation の手が見つからない(空振り防止)').not.toBeNull();
    expect(m?.[1]).toContain('autoOptimizer?.noteWrite()');
    // ⚠ 可搬の保存の通知を落としていない(同じ手の中に残っている)
    expect(m?.[1]).toContain('persist?.touch()');
  });

  it('🔴 lease の判定は writerHolder・列は storeEffects.run・打つ op は optimizeIndexes だけ', () => {
    const m = /new AutoOptimizer\(\{([\s\S]*?)\}\);/.exec(code);
    expect(m, '係を組む所が見つからない(空振り防止)').not.toBeNull();
    const body = m?.[1] ?? '';
    expect(body).toContain('holdsWriterLease: () => writerHolder');
    expect(body).toContain('storeEffects.run(job)');
    expect(body).toContain("op: 'optimizeIndexes'");
    expect(/VACUUM/i.test(body), 'VACUUM を打っている').toBe(false);
  });
});
