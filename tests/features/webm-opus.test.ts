/**
 * 🔴 **録った音の前後を削る**(#683 段②a。user 裁定 2026-09-14)。
 *
 * ## ⚠ fixture は**手で組む**(実装の書き手で組まない)
 *
 * 読む側を、**同じ file の書く側**で組んだ fixture に当てると、
 * 両者が**同じ間違いを共有していても一致する**(CLAUDE.md §1
 * 「期待値を『実装と同じ文法の別の綴り』で組むと、同じ盲点を共有する」)。
 * 🔑 だからここの `el()` は **1〜2 バイトの大きさしか書けない別物**で、
 *   バイトは手で数えられる形にしてある。
 * 🔑 書く側は**往復**(自分で書いた物を自分でほどく)と、
 *   **実ブラウザ**(`tests/smoke/audio-trim.smoke.spec.ts` ── `<audio>.duration`)で見る。
 */
import { describe, expect, it } from 'vitest';
import { demuxWebmOpus, trimWebmOpus, TRIM_REFUSAL_TEXT } from '../../src/features/audio/webm-opus';

/** 16 進の字 → バイト列。 */
const hex = (s: string): number[] => {
  const out: number[] = [];
  for (let i = 0; i < s.length; i += 2) out.push(Number.parseInt(s.slice(i, i + 2), 16));
  return out;
};

/**
 * 要素を 1 つ組む。⚠ **大きさは 1〜2 バイトだけ**(手で数えられる範囲)──
 * 実装の `writeSize` とは別の書き方である(共有の盲点を作らない)。
 */
const el = (id: string, payload: readonly number[]): number[] => {
  const n = payload.length;
  const size = n < 0x7f ? [0x80 | n] : [0x40 | (n >> 8), n & 0xff];
  if (n >= 0x3fff) throw new RangeError('fixture が大きすぎる(手で組める範囲を超えた)');
  return [...hex(id), ...size, ...payload];
};

/** `OpusHead`(19 バイト)。⚠ 9 バイト目がチャンネル数。 */
const opusHead = (channels = 1): number[] => [
  ...'OpusHead'.split('').map((c) => c.charCodeAt(0)),
  1, // version
  channels,
  0x00, 0x00, // pre-skip(LE)
  0x80, 0xbb, 0x00, 0x00, // 48000(LE)
  0x00, 0x00, // gain
  0x00, // mapping family
];

const ascii = (s: string): number[] => s.split('').map((c) => c.charCodeAt(0));

/** int16(大きい方から)。 */
const i16 = (n: number): number[] => [(n >> 8) & 0xff, n & 0xff];

interface Fixture {
  readonly codecId?: string;
  readonly count?: number;
  readonly stepMs?: number;
  readonly lacing?: number;
  readonly payload?: number;
  readonly channels?: number;
  /** ⚠ `Cluster` を何 ms ごとに切るか(元の file も分かれていることが在る)。 */
  readonly clusterMs?: number;
}

/** 最小の webm を手で組む。 */
function webm(f: Fixture = {}): Uint8Array {
  const codecId = f.codecId ?? 'A_OPUS';
  const count = f.count ?? 10;
  const step = f.stepMs ?? 60;
  const payload = f.payload ?? 4;
  const clusterMs = f.clusterMs ?? 1e9;

  const head = el('1a45dfa3', el('4282', ascii('webm')));
  const info = el('1549a966', el('2ad7b1', hex('0f4240'))); // TimestampScale = 1000000
  const tracks = el(
    '1654ae6b',
    el('ae', [
      ...el('d7', [1]),
      ...el('86', ascii(codecId)),
      ...el('63a2', opusHead(f.channels ?? 1)),
    ]),
  );
  const clusters: number[] = [];
  let at = 0;
  while (at < count) {
    const baseMs = Math.floor((at * step) / clusterMs) * clusterMs;
    const blocks: number[] = [];
    while (at < count && at * step - baseMs < clusterMs) {
      blocks.push(
        ...el('a3', [
          0x81,
          ...i16(at * step - baseMs),
          ((f.lacing ?? 0) << 1) | 0x80,
          // ⚠ 中身は**位置が分かる**ようにする(並べ替えや取り違えを見るため)
          ...Array.from({ length: payload }, (_, k) => (at * 16 + k) & 0xff),
        ]),
      );
      at += 1;
    }
    clusters.push(...el('1f43b675', [...el('e7', [baseMs & 0xff, (baseMs >> 8) & 0xff].reverse()), ...blocks]));
  }
  return Uint8Array.from([...head, ...el('18538067', [...info, ...tracks, ...clusters])]);
}

describe('ほどく(demuxWebmOpus)', () => {
  it('🔴 packet の数・時刻・1 つの長さが読める', () => {
    const d = demuxWebmOpus(webm({ count: 10, stepMs: 60 }));
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(d.source.packets).toHaveLength(10);
    expect(d.source.packets.map((p) => p.ms)).toEqual([0, 60, 120, 180, 240, 300, 360, 420, 480, 540]);
    expect(d.source.packetMs, '1 packet の長さは実測する(仕様の値を決め打たない)').toBe(60);
    expect(d.source.durationMs).toBe(600);
    expect(d.source.channels).toBe(1);
  });

  it('⚠ 中身は元のバイトそのまま(写し間違えていない)', () => {
    const d = demuxWebmOpus(webm({ count: 3, payload: 4 }));
    if (!d.ok) throw new Error('ほどけない');
    expect([...d.source.packets[2]!.data]).toEqual([32, 33, 34, 35]);
  });

  it('🔴 Cluster が分かれていても、時刻は通しで読める', () => {
    const d = demuxWebmOpus(webm({ count: 10, stepMs: 100, clusterMs: 300 }));
    if (!d.ok) throw new Error('ほどけない');
    expect(d.source.packets.map((p) => p.ms)).toEqual([0, 100, 200, 300, 400, 500, 600, 700, 800, 900]);
  });

  it('⚠ チャンネル数は OpusHead から読む(Audio の宣言ではなく)', () => {
    const d = demuxWebmOpus(webm({ channels: 2 }));
    if (!d.ok) throw new Error('ほどけない');
    expect(d.source.channels).toBe(2);
  });

  /**
   * 🔴 **空振り防止** ── 断る側が本当に断ることを、**理由ごと**見る。
   * ⚠ 「落ちた」だけを見る assert は、**どの門が鳴ったか**を区別しない(§1)。
   */
  it('🔴 EBML の頭が無ければ not-webm', () => {
    expect(demuxWebmOpus(Uint8Array.of(0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70))).toEqual({
      ok: false,
      reason: 'not-webm',
    });
  });

  it('🔴 opus でなければ not-opus', () => {
    expect(demuxWebmOpus(webm({ codecId: 'A_VORBIS' }))).toEqual({ ok: false, reason: 'not-opus' });
  });

  it('🔴 lacing は受けない(黙って壊れた file を作らない)', () => {
    expect(demuxWebmOpus(webm({ lacing: 1 }))).toEqual({ ok: false, reason: 'lacing' });
  });

  it('🔴 音が 1 つも無ければ no-audio', () => {
    expect(demuxWebmOpus(webm({ count: 0 }))).toEqual({ ok: false, reason: 'no-audio' });
  });

  it('🔴 途中で切れていたら broken(読めた分で押し通さない)', () => {
    const full = webm({ count: 10 });
    expect(demuxWebmOpus(full.subarray(0, full.length - 5))).toEqual({ ok: false, reason: 'broken' });
  });

  it('⚠ 断り文は全部の理由に在る(内部の綴りを画面に出さない)', () => {
    for (const [reason, text] of Object.entries(TRIM_REFUSAL_TEXT)) {
      expect(text, reason).toMatch(/。$/);
      expect(text, `${reason} の断り文に内部の綴りが出ている`).not.toContain(reason);
    }
  });
});

describe('切り出す(trimWebmOpus)', () => {
  /** 60ms × 50 = 3 秒。⚠ 本物の録音と同じ刻み(実測 2026-09-14)。 */
  const src = (): Uint8Array => webm({ count: 50, stepMs: 60 });

  it('🔴 端は札で合わせる ── 頼んだ長さがそのまま出る', () => {
    const t = trimWebmOpus(src(), 1000, 2000);
    expect(t.ok).toBe(true);
    if (!t.ok) return;
    // 1000ms は packet 16(960ms)の中 → 前置き 2 つ戻って packet 14(840ms)から
    expect(t.result.codecDelayNs, '頭で捨てる量').toBe(160_000_000);
    // 最後に残すのは packet 33(1980ms)── 終わりは 2040ms なので 40ms 捨てる
    expect(t.result.discardPaddingNs, '尻で捨てる量').toBe(40_000_000);
    expect(t.result.durationMs, '鳴らしたときの長さ').toBe(1000);
    expect(t.result.keptPackets).toBe(20);
  });

  it('🔴 前置きを必ず取る(いきなり切ると頭が濁る)', () => {
    const t = trimWebmOpus(src(), 1000, 2000);
    if (!t.ok) throw new Error('切れない');
    // 🔑 80ms 以上が要る ── 60ms の packet なら 2 つ = 120ms
    expect(t.result.codecDelayNs / 1e6, '前置きが 80ms を下回っている').toBeGreaterThanOrEqual(80);
  });

  it('⚠ 端が packet の境目にぴったり当たっても、前置きは取る', () => {
    const t = trimWebmOpus(src(), 600, 1200);
    if (!t.ok) throw new Error('切れない');
    expect(t.result.codecDelayNs).toBe(120_000_000);
    expect(t.result.durationMs).toBe(600);
  });

  it('🔴 頭から切るときは捨てる量が 0(前置きが無い)', () => {
    const t = trimWebmOpus(src(), 0, 600);
    if (!t.ok) throw new Error('切れない');
    expect(t.result.codecDelayNs).toBe(0);
    expect(t.result.durationMs).toBe(600);
  });

  it('🔴 終わりが録音より後でも、在る所までで収める', () => {
    const t = trimWebmOpus(src(), 2900, 9999);
    if (!t.ok) throw new Error('切れない');
    expect(t.result.discardPaddingNs, '無い音を捨てるとは言わない').toBe(0);
    expect(t.result.durationMs).toBeCloseTo(100, 5);
  });

  it('🔴 往復できる ── 自分が書いた物を自分でほどける', () => {
    const t = trimWebmOpus(src(), 1000, 2000);
    if (!t.ok) throw new Error('切れない');
    const back = demuxWebmOpus(t.result.bytes);
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.source.packets).toHaveLength(20);
    // ⚠ **中身が写っている**(並べ替えも取り違えもしていない)
    expect([...back.source.packets[0]!.data]).toEqual([224, 225, 226, 227]); // packet 14
  });

  it('🔴 元の OpusHead をそのまま写す(音を作り直していない証拠)', () => {
    const t = trimWebmOpus(webm({ channels: 2, count: 20 }), 200, 600);
    if (!t.ok) throw new Error('切れない');
    const back = demuxWebmOpus(t.result.bytes);
    if (!back.ok) throw new Error('ほどけない');
    expect([...back.source.codecPrivate]).toEqual(opusHead(2));
  });

  /**
   * 🔴 **block の相対時刻は 16 ビット**(±32.767 秒)。
   * ⚠ 1 つの `Cluster` に詰め続けると、**33 秒を超える切り出しが書けずに落ちる**。
   */
  it('🔴 33 秒を超える切り出しでも書ける(Cluster が分かれる)', () => {
    const long = webm({ count: 60, stepMs: 1000, clusterMs: 5000 }); // 60 秒
    const t = trimWebmOpus(long, 0, 60000);
    expect(t.ok, '長い切り出しが書けない').toBe(true);
    if (!t.ok) return;
    expect(t.result.keptPackets).toBe(60);
    const back = demuxWebmOpus(t.result.bytes);
    if (!back.ok) throw new Error('ほどけない');
    // ⚠ **全部の時刻を見る** ── 切り直した `Cluster` の基準を間違えると、
    //   2 つ目以降だけがずれる(最後の 1 つだけ見ると、それを見逃す)
    expect(back.source.packets.map((p) => p.ms)).toEqual(
      Array.from({ length: 60 }, (_, i) => i * 1000),
    );
  });

  it('🔴 範囲が逆・同じなら断る', () => {
    expect(trimWebmOpus(src(), 2000, 1000)).toEqual({ ok: false, reason: 'empty-range' });
    expect(trimWebmOpus(src(), 500, 500)).toEqual({ ok: false, reason: 'empty-range' });
  });

  it('🔴 範囲が録音より後なら断る(空の file を作らない)', () => {
    expect(trimWebmOpus(src(), 9000, 9999)).toEqual({ ok: false, reason: 'empty-range' });
  });

  it('⚠ ほどけない file は、切り出しでも同じ理由で断る', () => {
    expect(trimWebmOpus(webm({ codecId: 'A_VORBIS' }), 0, 100)).toEqual({
      ok: false,
      reason: 'not-opus',
    });
  });

  /** 🔑 **記憶の門**(設計 doc §8)── 切り出しは範囲に比例した量しか作らない。 */
  it('🔴 出る bytes は範囲に比例する(丸ごと展開していない)', () => {
    const whole = trimWebmOpus(src(), 0, 3000);
    const part = trimWebmOpus(src(), 1000, 2000);
    if (!whole.ok || !part.ok) throw new Error('切れない');
    expect(part.result.bytes.length).toBeLessThan(whole.result.bytes.length * 0.6);
  });
});
