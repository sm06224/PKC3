/**
 * 🔴 **録音・画面収録**(#413)。
 *
 * 守る主張:
 * 1. 🔴 **bytes を base64 にしない / heap に貯めない** ── PKC2 が 100MB 級で
 *    タブごと落ちて**全損**した原因(user 報告 2026-07-21)を繰り返さない
 * 2. 🔴 **黙って終わらない** ── 上限で自動停止 / ブラウザ側の「共有を停止」/
 *    権限拒否・非対応は**理由が出る**
 * 3. 🔴 **止めたら、それまでの分は残る**(落ちて全損だけは繰り返さない)
 *
 * ⚠ `MediaRecorder` は happy-dom に無いので**口を注入して**確かめる ──
 *   実ブラウザでしか確かめられない形にすると、壊れても間欠の赤でしか気づけない。
 */
/** @vitest-environment happy-dom */
import { describe, expect, it, vi } from 'vitest';
import {
  CaptureRefused,
  startCapture,
  type CaptureDeps,
  type CaptureEnd,
} from '../../src/adapter/platform/media-capture';

/** 既定の上限(12 時間)。⚠ **切る大きさ**とは別の門である(#771)。 */
const HOURS12 = 12 * 60 * 60 * 1000;

/** 止められる track。⚠ ブラウザ側の「共有を停止」も撃てる形にする。 */
function fakeTrack(): MediaStreamTrack & { fire: () => void; stopped: () => boolean } {
  let stopped = false;
  const listeners: Array<() => void> = [];
  return {
    stop: () => {
      stopped = true;
    },
    addEventListener: (_t: string, fn: () => void) => listeners.push(fn),
    fire: () => listeners.forEach((f) => f()),
    stopped: () => stopped,
  } as unknown as MediaStreamTrack & { fire: () => void; stopped: () => boolean };
}

function fakeStream(tracks: ReturnType<typeof fakeTrack>[]): MediaStream {
  return { getTracks: () => tracks } as unknown as MediaStream;
}

/**
 * 実物と同じ形の `MediaRecorder`。⚠ **stub を本物より甘くしない**(§3)。
 *
 * 🔴 **器は 1 つとは限らない**(#771)── 切るたびに `new` されるので、
 *   **何個作られたか**を数えられる形にしてある(切れたことの観測点)。
 *   ⚠ `last()` は**いちばん新しい器** ── 切った後に押す先はこちらである。
 */
function fakeRecorder(): {
  Recorder: typeof MediaRecorder;
  last: () => { push: (n: number) => void; state: string; stops: number; fail: () => void };
  made: () => number;
} {
  let inst: { push: (n: number) => void; state: string; stops: number; fail: () => void } | null =
    null;
  let made = 0;
  class R {
    state = 'inactive';
    mimeType = 'audio/webm';
    ondataavailable: ((e: BlobEvent) => void) | null = null;
    onstop: (() => void) | null = null;
    /** 🔴 実物が持っている口(#771 まで**誰も配線していなかった**)。 */
    onerror: (() => void) | null = null;
    stops = 0;
    constructor() {
      made += 1;
      inst = {
        push: (n: number) =>
          this.ondataavailable?.({ data: new Blob(['x'.repeat(n)]) } as BlobEvent),
        fail: () => this.onerror?.(),
        get state() {
          return (inst as unknown as { _s: string })._s ?? 'inactive';
        },
        stops: 0,
      } as never;
      // ⚠ 参照を実体に繋ぐ(state / stops を外から読む)
      Object.defineProperty(inst!, 'state', { get: () => this.state });
      Object.defineProperty(inst!, 'stops', { get: () => this.stops });
    }
    start(): void {
      this.state = 'recording';
    }
    stop(): void {
      // ⚠ 本物は inactive で呼ぶと投げる ── stub でも同じにする
      if (this.state === 'inactive') throw new Error('InvalidStateError');
      this.stops += 1;
      this.state = 'inactive';
      this.onstop?.();
    }
  }
  return { Recorder: R as unknown as typeof MediaRecorder, last: () => inst!, made: () => made };
}

/**
 * 🔴 **実物と同じ「あとから届く」`MediaRecorder`**(2026-08-27)。
 *
 * ⚠ 実物の `stop()` は**同期には何も撃たない** ── 最後の `dataavailable` を配って
 *   から `stop` を撃つ。上の stub は同期に撃つので、**「押した時点の断片で組む」
 *   実装の欠陥が unit から見えない**(CLAUDE.md §3「stub を本物より甘くしない」)。
 * 🔑 だからこの型を別に持つ ── 上限 / 共有停止で**先に**終わっている回に、
 *   受け側が `stop()` を呼ぶのは数ミリ秒あとであり、そこが欠ける当の場面である。
 */
function lateRecorder(tail: number): {
  Recorder: typeof MediaRecorder;
  last: () => { push: (n: number) => void };
} {
  let inst: { push: (n: number) => void } | null = null;
  class R {
    state = 'inactive';
    mimeType = 'audio/webm';
    ondataavailable: ((e: BlobEvent) => void) | null = null;
    onstop: (() => void) | null = null;
    constructor() {
      inst = {
        push: (n: number) =>
          this.ondataavailable?.({ data: new Blob(['x'.repeat(n)]) } as BlobEvent),
      };
    }
    start(): void {
      this.state = 'recording';
    }
    stop(): void {
      if (this.state === 'inactive') throw new Error('InvalidStateError');
      this.state = 'inactive';
      // ⚠ **あとから**(実物と同じ順序 ── 最後の断片 → stop)
      queueMicrotask(() => {
        if (tail > 0) this.ondataavailable?.({ data: new Blob(['y'.repeat(tail)]) } as BlobEvent);
        this.onstop?.();
      });
    }
  }
  return { Recorder: R as unknown as typeof MediaRecorder, last: () => inst! };
}

function deps(over: Partial<CaptureDeps> = {}): { d: CaptureDeps; track: ReturnType<typeof fakeTrack>; rec: ReturnType<typeof fakeRecorder> } {
  const track = fakeTrack();
  const rec = fakeRecorder();
  return {
    track,
    rec,
    d: {
      getUserMedia: async () => fakeStream([track]),
      getDisplayMedia: async () => fakeStream([track]),
      Recorder: rec.Recorder,
      now: () => 1_000,
      ...over,
    },
  };
}

describe('収録を始める / 止める(#413)', () => {
  it('🔴 止めたら、それまでの分が 1 本の Blob になる', async () => {
    const { d, rec } = deps();
    const h = await startCapture('audio', d, { partBytes: 1_000_000, maxMs: HOURS12 });
    rec.last().push(10);
    rec.last().push(20);
    const blob = await h.stop();
    expect(blob, '止めたのに何も返らない').not.toBeNull();
    expect(blob!.size).toBe(30);
    expect(h.bytes()).toBe(30);
  });

  it('🔴 1 バイトも録れていなければ null(空の添付を作らない)', async () => {
    const { d } = deps();
    const h = await startCapture('audio', d, { partBytes: 1_000_000, maxMs: HOURS12 });
    expect(await h.stop()).toBeNull();
  });

  it('🔴 大きくなったら「切って次を始める」── 止めない(#771)', async () => {
    const ends: CaptureEnd[] = [];
    const parts: Array<{ size: number; n: number }> = [];
    const { d, rec } = deps();
    const h = await startCapture('audio', d, {
      partBytes: 25,
      maxMs: HOURS12,
      onPart: (b, n) => parts.push({ size: b.size, n }),
      onEnd: (r) => ends.push(r),
    });
    rec.last().push(10);
    rec.last().push(20); // ここで 30 >= 25 → **切る**
    // 🔴 user の言葉は「**途中終了はしてほしくない**」── 終わりの合図は出ていない
    expect(ends, '切ったのに止まっている').toEqual([]);
    expect(parts, '1 本目が落ちてこない').toEqual([{ size: 30, n: 1 }]);
    // 🔴 **新しい器で録り続けている**(切っただけで終わっていない)
    expect(rec.made(), '次の器を作っていない').toBe(2);
    rec.last().push(7);
    const blob = await h.stop();
    expect(blob!.size, '2 本目が空 ── 新しい器に配線していない').toBe(7);
    // ⚠ 通算は切っても戻さない(帯に出す量)
    expect(h.bytes()).toBe(37);
    expect(h.parts(), '渡した本数が合わない').toBe(1);
  });

  it('⚠ 対照群 ── 切る大きさに届かなければ、器は 1 つのままである', async () => {
    const parts: number[] = [];
    const { d, rec } = deps();
    const h = await startCapture('audio', d, {
      partBytes: 25,
      maxMs: HOURS12,
      onPart: (_b, n) => parts.push(n),
    });
    rec.last().push(10);
    rec.last().push(10); // 20 < 25
    expect(parts, '切る必要が無いのに切っている').toEqual([]);
    expect(rec.made()).toBe(1);
    expect(h.parts()).toBe(0);
    expect((await h.stop())!.size).toBe(20);
  });

  it('🔴 何本でも切れる(3 本目まで続く)', async () => {
    const parts: Array<{ size: number; n: number }> = [];
    const { d, rec } = deps();
    const h = await startCapture('audio', d, {
      partBytes: 10,
      maxMs: HOURS12,
      onPart: (b, n) => parts.push({ size: b.size, n }),
    });
    rec.last().push(10); // 1 本目 → 切る
    rec.last().push(11); // 2 本目 → 切る
    rec.last().push(3);
    expect(parts).toEqual([
      { size: 10, n: 1 },
      { size: 11, n: 2 },
    ]);
    expect((await h.stop())!.size, '3 本目が返らない').toBe(3);
    expect(h.parts()).toBe(2);
  });

  it('🔴 12 時間に達したら止める(切らずに終わる)', async () => {
    const ends: CaptureEnd[] = [];
    const parts: number[] = [];
    let t = 1_000;
    const { d, rec } = deps({ now: () => t });
    const h = await startCapture('audio', d, {
      partBytes: 5,
      maxMs: HOURS12,
      onPart: (_b, n) => parts.push(n),
      onEnd: (r) => ends.push(r),
    });
    t = 1_000 + HOURS12;
    rec.last().push(9); // ⚠ 切る大きさにも届いているが、**止まるほうが勝つ**
    expect(ends, '12 時間で止まっていない').toEqual(['too-long']);
    expect(parts, '止まる回に空の 1 本を作っている').toEqual([]);
    expect((await h.stop())!.size, '止まった分が消えた').toBe(9);
  });

  it('⚠ 対照群 ── 12 時間の 1 ミリ秒手前では止まらない', async () => {
    const ends: CaptureEnd[] = [];
    let t = 1_000;
    const { d, rec } = deps({ now: () => t });
    const h = await startCapture('audio', d, {
      partBytes: 1_000_000,
      maxMs: HOURS12,
      onEnd: (r) => ends.push(r),
    });
    t = 1_000 + HOURS12 - 1;
    rec.last().push(9);
    expect(ends).toEqual([]);
    await h.stop();
  });

  it('🔴 符号化が死んだら止めて、理由を出す(#771。直す前は受け口が 0 件だった)', async () => {
    const ends: CaptureEnd[] = [];
    const { d, rec } = deps();
    const h = await startCapture('audio', d, {
      partBytes: 1_000_000,
      maxMs: HOURS12,
      onEnd: (r) => ends.push(r),
    });
    rec.last().push(6);
    rec.last().fail();
    // 🔴 直す前は**帯だけ伸び続けた**(断片が来ないので上限にも当たらない)
    expect(ends, '死んだのに黙っている').toEqual(['failed']);
    expect((await h.stop())!.size, 'そこまでの分が消えた').toBe(6);
  });

  it('🔴 ブラウザ側の「共有を停止」でも終わる(帯が残り続けない)', async () => {
    const ends: CaptureEnd[] = [];
    const { d, rec, track } = deps();
    const h = await startCapture('screen', d, { partBytes: 1_000_000, maxMs: HOURS12, onEnd: (r) => ends.push(r) });
    rec.last().push(5);
    track.fire();
    expect(ends).toEqual(['shared-ended']);
    expect((await h.stop())!.size, '止まった後に積んだ分が消えた').toBe(5);
  });

  it('⚠ 止めるのは 1 回だけ(共有停止と「止める」が重なっても落ちない)', async () => {
    const { d, rec, track } = deps();
    const h = await startCapture('audio', d, { partBytes: 1_000_000, maxMs: HOURS12 });
    rec.last().push(5);
    track.fire();
    await expect(h.stop()).resolves.not.toBeNull();
    expect(rec.last().stops, '2 回止めている').toBe(1);
  });

  it('🔴 track を必ず止める(マイクの印が消えないのを作らない)', async () => {
    const { d, track } = deps();
    const h = await startCapture('audio', d, { partBytes: 1_000_000, maxMs: HOURS12 });
    await h.stop();
    expect(track.stopped(), 'マイクを掴んだままになる').toBe(true);
  });

  it('🔴 捨てたら bytes を手放す(2026-07-27「速やかな破棄」)', async () => {
    const { d, rec } = deps();
    const h = await startCapture('audio', d, { partBytes: 1_000_000, maxMs: HOURS12 });
    rec.last().push(50);
    h.discard();
    expect(h.bytes()).toBe(0);
    expect(await h.stop(), '捨てたのに中身が返る').toBeNull();
  });

  it('⚠ 経過が読める(帯に出す)', async () => {
    let t = 1_000;
    const { d } = deps({ now: () => t });
    const h = await startCapture('audio', d, { partBytes: 1_000_000, maxMs: HOURS12 });
    t = 4_500;
    expect(h.elapsedMs()).toBe(3_500);
  });
});

describe('🔴 最後の断片まで残る(#413。実物は「あとから」届く)', () => {
  it('🔴 先に終わっていても、あとから止めれば末尾まで返る', async () => {
    const rec = lateRecorder(7);
    const track = fakeTrack();
    const h = await startCapture(
      'screen',
      { getDisplayMedia: async () => fakeStream([track]), Recorder: rec.Recorder },
      { partBytes: 1_000_000, maxMs: HOURS12 },
    );
    rec.last().push(5);
    // 🔴 ブラウザ側の「共有を停止」で**先に**終わる(受け側はまだ止めていない)
    track.fire();
    // ⚠ 受け側が止めるのは**数ミリ秒あと**である ── ここで末尾が欠けていた
    const blob = await h.stop();
    expect(blob, '止めたのに何も返らない').not.toBeNull();
    expect(blob!.size, '最後の断片が欠けている').toBe(12);
  });

  it('⚠ 対照群 ── 自分で止めた回も末尾まで返る', async () => {
    const rec = lateRecorder(7);
    const track = fakeTrack();
    const h = await startCapture(
      'audio',
      { getUserMedia: async () => fakeStream([track]), Recorder: rec.Recorder },
      { partBytes: 1_000_000, maxMs: HOURS12 },
    );
    rec.last().push(5);
    expect((await h.stop())!.size, '最後の断片が欠けている').toBe(12);
  });

  it('🔴 切っている最中に「止める」が来ても、末尾まで返る(#771)', async () => {
    /**
     * ⚠ **この場面は同期の stub では 1 度も通らない**(変異試験 A10 が SURVIVED で
     *   教えた)── 同期に `onstop` が撃たれる器では、切りは押した瞬間に終わるので
     *   「切っている最中」という時間が存在しない。🔑 だから**あとから届く器**で見る。
     */
    const rec = lateRecorder(7);
    const track = fakeTrack();
    const parts: number[] = [];
    const h = await startCapture(
      'audio',
      { getUserMedia: async () => fakeStream([track]), Recorder: rec.Recorder },
      { partBytes: 25, maxMs: HOURS12, onPart: (_b, n) => parts.push(n) },
    );
    rec.last().push(30); // 30 >= 25 → 切りに入る(`stop()` は撃ったが `onstop` はまだ)
    // 🔴 **切っている最中に止める** ── ここで `stop()` を撃ち直すと例外になり、
    //    しかも**あとから届く 7 バイトが落ちる**
    const blob = await h.stop();
    expect(blob, '止めたのに何も返らない').not.toBeNull();
    expect(blob!.size, '切っている最中に止めたら末尾が欠けた').toBe(37);
    // ⚠ 止めたので「切れた本」としては渡さない(最後の 1 本は `stop()` が返す)
    expect(parts, '止めたのに切れた本として渡している').toEqual([]);
  });

  it('🔴 捨てた回は、あとから届く断片も返さない', async () => {
    const rec = lateRecorder(7);
    const track = fakeTrack();
    const ends: CaptureEnd[] = [];
    const h = await startCapture(
      'audio',
      { getUserMedia: async () => fakeStream([track]), Recorder: rec.Recorder },
      { partBytes: 1_000_000, maxMs: HOURS12, onEnd: (r) => ends.push(r) },
    );
    rec.last().push(5);
    h.discard();
    // 🔴 **理由が `stopped` と別**(受け側が「取り込まない」を理由で分けられる)
    expect(ends, '捨てたのに「止めた」と言っている').toEqual(['discarded']);
    expect(await h.stop(), '捨てたのに中身が返る').toBeNull();
    expect(h.bytes(), 'bytes を手放していない').toBe(0);
  });
});

describe('🔴 黙って no-op にしない(#413)', () => {
  it('マイクを断られたら、理由が出る', async () => {
    const err = Object.assign(new Error('x'), { name: 'NotAllowedError' });
    const { d } = deps({ getUserMedia: () => Promise.reject(err) });
    await expect(startCapture('audio', d, { partBytes: 1, maxMs: HOURS12 })).rejects.toThrow(/マイクの許可/);
  });

  it('画面の共有を断られたら、理由が出る', async () => {
    const err = Object.assign(new Error('x'), { name: 'NotAllowedError' });
    const { d } = deps({ getDisplayMedia: () => Promise.reject(err) });
    await expect(startCapture('screen', d, { partBytes: 1, maxMs: HOURS12 })).rejects.toThrow(/共有が許可されません/);
  });

  it('⚠ 別の理由でも黙らない(名前を出す)', async () => {
    const err = Object.assign(new Error('x'), { name: 'NotFoundError' });
    const { d } = deps({ getUserMedia: () => Promise.reject(err) });
    await expect(startCapture('audio', d, { partBytes: 1, maxMs: HOURS12 })).rejects.toThrow(/NotFoundError/);
  });

  it('🔴 対応していない環境では、そう言う', async () => {
    const { rec } = deps();
    await expect(
      startCapture('audio', { Recorder: rec.Recorder }, { partBytes: 1, maxMs: HOURS12 }),
    ).rejects.toBeInstanceOf(CaptureRefused);
    await expect(
      startCapture('audio', { getUserMedia: async () => fakeStream([fakeTrack()]) }, { partBytes: 1, maxMs: HOURS12 }),
    ).rejects.toThrow(/対応していません/);
  });
});

describe('🔴 bytes を heap に載せない(#413 の芯)', () => {
  it('断片は Blob のまま積む(文字列にも base64 にもしない)', async () => {
    const seen: unknown[] = [];
    const { d, rec } = deps();
    const h = await startCapture('audio', d, { partBytes: 1_000_000, maxMs: HOURS12 });
    const orig = Blob.prototype.text;
    // ⚠ 積む途中で **1 度も中身を読まない**ことを見る
    //   (読んだ瞬間、bytes が JS heap に載る)
    const spy = vi.spyOn(Blob.prototype, 'text').mockImplementation(function (this: Blob) {
      seen.push(this);
      return orig.call(this);
    });
    rec.last().push(100);
    rec.last().push(100);
    await h.stop();
    expect(seen, 'bytes を文字列として読んでいる').toEqual([]);
    spy.mockRestore();
  });
});
