/**
 * 🔴 **可搬単一 HTML の保存**(#400 段③)。
 *
 * ⚠ この層が壊れたときの症状は「**閉じたら最後の編集だけ消えていた**」である ──
 * いちばん惜しい所が、いちばん静かに落ちる。だから**落ちる形**を名指しで見る。
 */
import { describe, expect, it } from 'vitest';
import {
  connectPortablePersist,
  IDLE_MS,
  MAX_WAIT_MS,
  PENDING_NOTICE_MS,
  type PersistState,
  type PortablePersist,
} from '../../src/adapter/platform/storage/portable-persist';

/** 手で進める時計と待ち行列(実時間を待たない)。 */
function harness(over: {
  exportImage?: () => Promise<Uint8Array>;
  write?: (r: { savedAt: number; image: Uint8Array }) => Promise<void>;
} = {}) {
  let clock = 1_000;
  const timers: Array<{ at: number; fn: () => void; h: number }> = [];
  let nextH = 1;
  const exports: number[] = [];
  const writes: Array<{ savedAt: number; bytes: number }> = [];
  const states: PersistState[] = [];
  let live = 0;
  let maxLive = 0;

  const p: PortablePersist = connectPortablePersist({
    exportImage:
      over.exportImage ??
      (async () => {
        live++;
        maxLive = Math.max(maxLive, live);
        exports.push(clock);
        await Promise.resolve();
        live--;
        return new Uint8Array(64).fill(1);
      }),
    write:
      over.write ??
      (async (r) => {
        writes.push({ savedAt: r.savedAt, bytes: r.image.byteLength });
        await Promise.resolve();
      }),
    onState: (s) => states.push(s),
    now: () => clock,
    setTimer: (fn, ms) => {
      const h = nextH++;
      timers.push({ at: clock + ms, fn, h });
      return h;
    },
    clearTimer: (h) => {
      const i = timers.findIndex((t) => t.h === h);
      if (i >= 0) timers.splice(i, 1);
    },
  });

  /**
   * 時計を進める。
   *
   * 🔴 **刻みごとに飛ばさない** ── 「1100ms ずつ進める」形にしたら、
   * 15000ms に予約された timer が **15400ms に発火したように見えて**
   * `MAX_WAIT_MS` の主張が落ちた(製品ではなく**計器の artifact**)。
   * 🔑 期限の早い順に**その時刻へ時計を合わせてから**発火する
   * (= 本物の timer と同じ意味論。CLAUDE.md §3「stub は本物の意味論を真似る」)。
   */
  const advance = async (ms: number): Promise<void> => {
    const until = clock + ms;
    for (;;) {
      const due = timers.filter((t) => t.at <= until).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      timers.splice(timers.indexOf(due), 1);
      clock = Math.max(clock, due.at);
      due.fn();
      for (let i = 0; i < 20; i++) await Promise.resolve();
    }
    clock = until;
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };

  return {
    p,
    exports,
    writes,
    states,
    advance,
    tick: (ms: number) => (clock += ms),
    maxLive: () => maxLive,
    clockNow: () => clock,
  };
}

describe('#400 段③ ── 束ねて遅らせる', () => {
  it('打鍵が止まってから 1 回だけ書く', async () => {
    const h = harness();
    h.p.touch();
    h.p.touch();
    h.p.touch();
    expect(h.writes).toHaveLength(0); // ⚠ すぐには書かない(これが要点)
    await h.advance(IDLE_MS);
    expect(h.exports).toHaveLength(1);
    expect(h.writes).toHaveLength(1);
    expect(h.p.state().kind).toBe('idle');
  });

  it('🔴 打ち続けても `MAX_WAIT_MS` で 1 度書く', async () => {
    const h = harness();
    h.p.touch();
    // ⚠ 遅延だけだと「打ち続ける限り 1 度も保存されない」が成立する
    for (let i = 0; i < 20; i++) {
      await h.advance(IDLE_MS - 100);
      h.p.touch();
      if (h.writes.length > 0) break;
    }
    expect(h.writes.length).toBeGreaterThan(0);
    expect(h.exports[0]! - 1_000).toBeLessThanOrEqual(MAX_WAIT_MS);
  });
});

describe('#400 段③ ── 落とさない / 重ねない', () => {
  it('🔴 保存中に来た編集は、その保存の直後にもう 1 回書かれる', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let first = true;
    const h = harness({
      exportImage: async () => {
        if (first) {
          first = false;
          await gate; // 1 本目を止めておく
        }
        return new Uint8Array(64).fill(2);
      },
    });
    h.p.touch();
    await h.advance(IDLE_MS);
    const flushed = h.p.flush();
    h.p.touch(); // ← 画像を出している最中の編集
    release();
    await flushed;
    // 🔴 2 回書かれていること。1 回なら**最後の編集が消えている**
    expect(h.writes).toHaveLength(2);
    expect(h.p.state().kind).toBe('idle');
  });

  it('画像を出す処理を 2 本同時に走らせない(heap のピークを 2 倍にしない)', async () => {
    const h = harness();
    h.p.touch();
    const a = h.p.flush();
    h.p.touch();
    const b = h.p.flush();
    await Promise.all([a, b]);
    expect(h.maxLive()).toBe(1);
  });

  it('flush は「飛んでいる保存」と「その最中に来た編集」の両方を待つ', async () => {
    const h = harness();
    h.p.touch();
    await h.p.flush();
    expect(h.writes).toHaveLength(1);
    // 何も溜まっていなければ flush は何も書かない(空振り防止の対照群)
    await h.p.flush();
    expect(h.writes).toHaveLength(1);
  });
});

describe('#400 段③ ── 書いてはいけないもの / 失敗の扱い', () => {
  it('🔴 空の画像は器へ書かない(次の起動が「記録がある」と読んでしまう)', async () => {
    const h = harness({ exportImage: async () => new Uint8Array(0) });
    h.p.touch();
    await h.p.flush();
    expect(h.writes).toHaveLength(0);
    expect(h.p.state().kind).toBe('idle'); // ⚠ 失敗ではない(書くものが無いだけ)
  });

  it('🔴 画像を出せなかったぶんは溜めたままにする(捨てない)', async () => {
    let fail = true;
    const h = harness({
      exportImage: async () => {
        if (fail) throw new Error('出せません');
        return new Uint8Array(8).fill(3);
      },
    });
    h.p.touch();
    await h.p.flush();
    expect(h.p.state()).toEqual({ kind: 'error', why: 'Error: 出せません' });
    expect(h.writes).toHaveLength(0);
    // 🔑 溜まっているので、直れば**次の flush で書ける**
    fail = false;
    await h.p.flush();
    expect(h.writes).toHaveLength(1);
  });

  it('🔴 器へ書けなかったら user に出す(黙ると編集が消えたことが分からない)', async () => {
    const h = harness({
      write: async () => {
        throw new Error('QuotaExceededError');
      },
    });
    h.p.touch();
    await h.p.flush();
    expect(h.p.state().kind).toBe('error');
    expect((h.p.state() as { why: string }).why).toContain('Quota');
  });
});

describe('#400 段③ ── 見え方', () => {
  it('⚠ ふつうの打鍵では「保存待ち」を出さない(ちらつかせない)', async () => {
    const h = harness();
    h.p.touch();
    await h.advance(IDLE_MS);
    expect(h.states.map((s) => s.kind)).not.toContain('pending');
  });

  it('🔴 長く書けていないときだけ「保存待ち」を出す', async () => {
    const h = harness({
      write: async () => {
        throw new Error('まだ書けない');
      },
    });
    h.p.touch();
    await h.advance(IDLE_MS);
    // 失敗して溜まったまま、さらに打鍵が続く
    h.tick(PENDING_NOTICE_MS);
    h.p.touch();
    expect(h.states.map((s) => s.kind)).toContain('pending');
  });

  it('dispose の後は timer も保存も動かない', async () => {
    const h = harness();
    h.p.touch();
    h.p.dispose();
    await h.advance(IDLE_MS * 4);
    expect(h.writes).toHaveLength(0);
  });

  it('🔴 dispose の**後に来た**編集も動かさない', async () => {
    /**
     * ⚠ 上の test は `dispose` が**予約を畳む**ことしか見ていない
     *   (変異試験 M16b が SURVIVED で教えた)── `touch` が後から来る形は
     *   1 度も通っていなかった。
     * 🔑 分岐を書いたら、**分岐の数だけ通す**(CLAUDE.md §2)。
     */
    const h = harness();
    h.p.dispose();
    h.p.touch();
    await h.advance(IDLE_MS * 4);
    expect(h.writes).toHaveLength(0);
    expect(h.exports, '画像まで出しに行っている').toHaveLength(0);
  });

  it('🔴 dispose の後に flush が来ても書かない(閉じる合図の受け口は残っている)', async () => {
    // ⚠ `visibilitychange` の listener は畳んだ後も document に残るので、
    //    **この形は実際に起きる**
    const h = harness();
    h.p.touch();
    h.p.dispose();
    await h.p.flush();
    expect(h.writes).toHaveLength(0);
    expect(h.exports).toHaveLength(0);
  });
});
