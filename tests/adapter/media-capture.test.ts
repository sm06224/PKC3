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
import { readId, readSizeAt } from '../../src/features/audio/ebml';

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
  last: () => {
    push: (n: number) => void;
    /** 🔴 **本物の形の bytes を積む**(#952 A3)── `push(n)` は webm ですら
     *   ない中身しか作れないので、容器を読む処理の検算にはこちらが要る。 */
    pushBytes: (b: Uint8Array) => void;
    state: string;
    stops: number;
    fail: () => void;
  };
  made: () => number;
} {
  let inst: {
    push: (n: number) => void;
    pushBytes: (b: Uint8Array) => void;
    state: string;
    stops: number;
    fail: () => void;
  } | null = null;
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
        pushBytes: (b: Uint8Array) =>
          this.ondataavailable?.({ data: new Blob([b as BlobPart]) } as BlobEvent),
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
    // 🔴 **新しい器で録り続けている**(切っただけで終わっていない)
    expect(rec.made(), '次の器を作っていない').toBe(2);
    rec.last().push(7);
    const blob = await h.stop();
    /**
     * ⚠ **`onPart` は #952 A3 から非同期**(容器へ `Duration` を書くのに
     *   `blob` の先頭を読む一手間が要る ── `finalizeSegment` を見よ)。
     *   `stop()` を待てば、**先に積まれた `onPart`(同じ形の約束)も片付いている**
     *   ので、ここで検算できる(CLAUDE.md §2「`async` にした瞬間、それを呼ぶ
     *   同期の test は全部空振りになる」)。
     */
    expect(parts, '1 本目が落ちてこない').toEqual([{ size: 30, n: 1 }]);
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
    const blob = await h.stop();
    // ⚠ #952 A3 で `onPart` は非同期になった ── `stop()` を待てば片付いている
    expect(parts).toEqual([
      { size: 10, n: 1 },
      { size: 11, n: 2 },
    ]);
    expect(blob!.size, '3 本目が返らない').toBe(3);
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

/**
 * 🔴 **長さを容器へ書く(#952 A3)**。
 *
 * ⚠ 上の test は全部 `push(n)`(webm ですらない中身)を使うので、**この機能を
 *   丸ごと削っても 1 本も落ちない** ── ここだけは**本物の形をした bytes**を
 *   積んで、配線(`startCapture` → `withRecordedDuration` → 容器へ書く)を
 *   通しで見る(`insertMissingDuration` 自身の正しさは
 *   `tests/features/webm-opus.test.ts` が独立に見ている)。
 */
describe('🔴 長さを容器へ書く(#952 A3)', () => {
  /**
   * 最小限の webm(`Segment` の大きさは**不明** ── 実物の `MediaRecorder` と
   * 同じ形)。`Info` は在るが `Duration` はまだ無い。
   */
  function minimalWebm(): Uint8Array {
    return Uint8Array.of(
      // EBML head: DocType = 'webm'
      0x1a, 0x45, 0xdf, 0xa3, 0x87, 0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d,
      // Segment(大きさ不明 ── 8 バイト vint、全ビット 1)
      0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
      // Info: TimestampScale = 1000000 のみ(Duration は無い)
      0x15, 0x49, 0xa9, 0x66, 0x87, 0x2a, 0xd7, 0xb1, 0x83, 0x0f, 0x42, 0x40,
    );
  }

  /**
   * `Duration`(id `4489`)を Info の中から読む。⚠ 実装とは別に歩く(検算)。
   * 🔑 **値そのものを読む**(在るかどうかだけでは、「常に 0 を書く」ような
   *   変異を殺せない)。
   */
  function durationOf(bytes: Uint8Array): number | null {
    const head = readId(bytes, 0);
    if (head === null) return null;
    const headSize = readSizeAt(bytes, head.length);
    if (headSize === null || headSize.value === null) return null;
    let pos = head.length + headSize.length + headSize.value;
    const seg = readId(bytes, pos);
    if (seg === null) return null;
    const segSizeStart = pos + seg.length;
    const segSize = readSizeAt(bytes, segSizeStart);
    if (segSize === null) return null;
    pos = segSizeStart + segSize.length;
    while (pos < bytes.length) {
      const id = readId(bytes, pos);
      if (id === null) return null;
      const sizeStart = pos + id.length;
      const size = readSizeAt(bytes, sizeStart);
      if (size === null || size.value === null) return null;
      const bodyStart = sizeStart + size.length;
      if (id.id === '1549a966') {
        let q = bodyStart;
        const end = bodyStart + size.value;
        while (q < end) {
          const cid = readId(bytes, q);
          if (cid === null) return null;
          const cSizeStart = q + cid.length;
          const cSize = readSizeAt(bytes, cSizeStart);
          if (cSize === null || cSize.value === null) return null;
          const cBodyStart = cSizeStart + cSize.length;
          if (cid.id === '4489') {
            return new DataView(bytes.buffer, bytes.byteOffset + cBodyStart, cSize.value).getFloat64(
              0,
              false,
            );
          }
          q = cBodyStart + cSize.value;
        }
        return null;
      }
      pos = bodyStart + size.value;
    }
    return null;
  }

  it('🔴 止めたら、容器に Duration が書き足されている', async () => {
    const { d, rec } = deps();
    const h = await startCapture('audio', d, { partBytes: 1_000_000, maxMs: HOURS12 });
    rec.last().pushBytes(minimalWebm());
    const blob = await h.stop();
    expect(blob, '止めたのに何も返らない').not.toBeNull();
    expect(blob!.size, '長さぶん増えていない(何も書いていない)').toBeGreaterThan(
      minimalWebm().length,
    );
    const bytes = new Uint8Array(await blob!.arrayBuffer());
    expect(durationOf(bytes), 'Duration が書かれていない').not.toBeNull();
  });

  /**
   * 🔴 **切れた 1 本(`onPart`)にも書く**(#952 A3)── 最後の 1 本だけ直して
   *   途中で切れた本を忘れると、**長い録音ほど直っていない本の割合が増える**。
   */
  it('🔴 切れた 1 本(onPart)にも Duration が書き足されている', async () => {
    const parts: Blob[] = [];
    const { d, rec } = deps();
    const h = await startCapture('audio', d, {
      partBytes: 10,
      maxMs: HOURS12,
      onPart: (b) => parts.push(b),
    });
    rec.last().pushBytes(minimalWebm()); // ⚠ 36 バイト >= partBytes(10) → 切る
    /**
     * ⚠ **#952 A3 で `onPart` は非同期になった**(容器の先頭を読む一手間がある)。
     * 🔑 ここは `await h.stop()` では**足りない** ── 直後に止めると、
     *   2 本目(空)の `emit()` は `takeRawSegment` が `null` を返すので
     *   **同期に解決してしまい**、1 本目の `onPart` より先に片付くことがある。
     *   `vi.waitFor` で「届くまで」を見る。
     */
    await vi.waitFor(() => expect(parts, '切れていない').toHaveLength(1));
    const bytes = new Uint8Array(await parts[0]!.arrayBuffer());
    expect(durationOf(bytes), '切れた本には書かれていない').not.toBeNull();
    await h.stop();
  });

  /**
   * 🔴 **書くのは「切ってからの経過」であって、収録全体の経過ではない**
   *   (#952 A3)。⚠ 1 本目は始まりが `0` なので**収録全体の経過と一致してしまい**、
   *   この 2 つを区別する検算にならない ── **2 本目**(始まりが `0` でない)で
   *   初めて言える。
   */
  it('🔴 2 本目は「切ってから」の経過を書く(収録全体の経過ではない)', async () => {
    let t = 0;
    const parts: Blob[] = [];
    const { d, rec } = deps({ now: () => t });
    const h = await startCapture('audio', d, {
      partBytes: 20,
      maxMs: HOURS12,
      onPart: (b) => parts.push(b),
    });
    t = 5000;
    rec.last().pushBytes(minimalWebm()); // 1 本目(0〜5000ms)→ 切る
    await vi.waitFor(() => expect(parts, '1 本目が切れていない').toHaveLength(1));
    expect(durationOf(new Uint8Array(await parts[0]!.arrayBuffer())), '1 本目の長さが違う').toBe(
      5000,
    );

    t = 8000;
    rec.last().pushBytes(minimalWebm()); // 2 本目(5000〜8000ms = 3000ms)→ 切る
    await vi.waitFor(() => expect(parts, '2 本目が切れていない').toHaveLength(2));
    /**
     * 🔑 ここが本命 ── 収録全体では `8000`(= `now() - startedAt`)だが、
     *   2 本目自身は `3000`(= `now() - segStartedAt`)。**この 2 つを取り違える
     *   変異**は、1 本目だけを見る test では殺せない(1 本目は両方とも一致する)。
     */
    expect(
      durationOf(new Uint8Array(await parts[1]!.arrayBuffer())),
      '収録全体の経過を書いている(切ってからの経過を書いていない)',
    ).toBe(3000);
    await h.stop();
  });

  /**
   * 🔴 **画面収録はまだ対象外**(docstring のとおり ── 実ブラウザの画面収録では
   *   確かめていない)。⚠ ここが `true` に裏返ったら、それは**確かめずに
   *   「動画でも直った」と言っている**ことになる(依頼の禁止事項そのもの)。
   */
  it('⚠ 画面収録はまだ対象外', async () => {
    const track = fakeTrack();
    const rec = fakeRecorder();
    const h = await startCapture(
      'screen',
      { getDisplayMedia: async () => fakeStream([track]), Recorder: rec.Recorder },
      { partBytes: 1_000_000, maxMs: HOURS12 },
    );
    rec.last().pushBytes(minimalWebm());
    const blob = await h.stop();
    if (blob === null) throw new Error('止めたのに何も返らない');
    expect(blob.size, '画面収録なのにバイト数が変わっている').toBe(minimalWebm().length);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    expect(durationOf(bytes), '画面収録にまで効くようになった(docstring と食い違う)').toBeNull();
  });

  /**
   * 🔴 **値そのものを検算する**(#952 A3)── 「書いてはいる」だけでは、
   *   `durationMs` を常に `0` にする・別の変数(`total` 等)を使う、といった
   *   変異を殺せない(CLAUDE.md §3「印の数では見えない門がある」の親戚)。
   */
  it('🔴 12 時間ぶんの録音(長い値)が、そのまま値として書かれる', async () => {
    let t = 0;
    const { d, rec } = deps({ now: () => t });
    const h = await startCapture('audio', d, { partBytes: 1_000_000, maxMs: HOURS12 + 1 });
    t = HOURS12; // ⚠ この 1 本の壁時計を 12 時間ぶんにする
    rec.last().pushBytes(minimalWebm());
    const blob = await h.stop();
    if (blob === null) throw new Error('止めたのに何も返らない');
    const bytes = new Uint8Array(await blob.arrayBuffer());
    expect(durationOf(bytes), '長い値がそのまま書かれていない').toBe(HOURS12);
  });
});
