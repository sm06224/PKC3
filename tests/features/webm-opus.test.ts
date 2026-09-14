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
 *   **実ブラウザ**(`tests/smoke/media-capture.smoke.spec.ts` の段⑤ ── `<audio>.duration`)で見る。
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
  /** ⚠ `CodecID` に詰め物を足す(上流が偶数長に揃える形)。 */
  readonly padCodecId?: boolean;
  /** ⚠ 最初の `Cluster` の時刻(外から来た webm は 0 から始まらないことが在る)。 */
  readonly originMs?: number;
  /** ⚠ **もう 1 本 track を混ぜる**(番号 2。opus ではない側)。 */
  readonly extraTrack?: 'before' | 'after';
  /**
   * ⚠ **頭の 1 つだけ間隔を変える**(実測で起きた形 ── `MediaRecorder` の 1 本目の
   *   塊に、他と違う間隔の packet が混じる)。
   */
  readonly oddFirstGapMs?: number;
}

/** 最小の webm を手で組む。 */
function webm(f: Fixture = {}): Uint8Array {
  const codecId = f.codecId ?? 'A_OPUS';
  const count = f.count ?? 10;
  const step = f.stepMs ?? 60;
  const payload = f.payload ?? 4;
  const clusterMs = f.clusterMs ?? 1e9;
  const origin = f.originMs ?? 0;

  const head = el('1a45dfa3', el('4282', ascii('webm')));
  const info = el('1549a966', el('2ad7b1', hex('0f4240'))); // TimestampScale = 1000000
  /** ⚠ 混ぜ物の track(番号 2)。opus ではない ── 選ばれてはいけない側。 */
  const other = el('ae', [...el('d7', [2]), ...el('86', ascii('V_VP8'))]);
  const mine = el('ae', [
    ...el('d7', [1]),
    // ⚠ **詰め物を足す** ── 上流は id を偶数長に揃えて埋めることがある
    ...el('86', [...ascii(codecId), ...(f.padCodecId === true ? [0, 0] : [])]),
    ...el('63a2', opusHead(f.channels ?? 1)),
  ]);
  const tracks = el('1654ae6b', [
    ...(f.extraTrack === 'before' ? other : []),
    ...mine,
    ...(f.extraTrack === 'after' ? other : []),
  ]);
  /**
   * ⚠ 頭の 1 つだけ間隔を変えられるようにする ── 実測で、そこを掴むと
   *   **file 全体の物差しが狂った**(切り出しが 0.1 秒長くなる)。
   */
  const odd = f.oddFirstGapMs ?? step;
  const msAt = (i: number): number => (i === 0 ? 0 : odd + (i - 1) * step);
  const clusters: number[] = [];
  let at = 0;
  while (at < count) {
    const baseMs = Math.floor(msAt(at) / clusterMs) * clusterMs;
    const blocks: number[] = [];
    while (at < count && msAt(at) - baseMs < clusterMs) {
      blocks.push(
        ...el('a3', [
          0x81,
          ...i16(msAt(at) - baseMs),
          ((f.lacing ?? 0) << 1) | 0x80,
          // ⚠ 中身は**位置が分かる**ようにする(並べ替えや取り違えを見るため)
          ...Array.from({ length: payload }, (_, k) => (at * 16 + k) & 0xff),
        ]),
      );
      // ⚠ **別の track の block を同じ Cluster に混ぜる**(番号 2)
      if (f.extraTrack !== undefined)
        blocks.push(...el('a3', [0x82, ...i16(at * step - baseMs), 0x80, 0xee, 0xee, 0xee, 0xee]));
      at += 1;
    }
    const ts = baseMs + origin;
    clusters.push(...el('1f43b675', [...el('e7', i16(ts)), ...blocks]));
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
    /**
     * 🔑 **算数**:1000ms を含むのは packet 16(960ms)。前置きは**時間で**戻るので、
     *   80ms 以上さかのぼる最初の packet 15(900ms)が基点 → 頭で **100ms** 捨てる。
     *   尻は「次の packet の時刻」= packet 34(2040ms)なので **40ms** 捨てる。
     */
    expect(t.result.codecDelayNs, '頭で捨てる量').toBe(100_000_000);
    expect(t.result.discardPaddingNs, '尻で捨てる量').toBe(40_000_000);
    expect(t.result.durationMs, '鳴らしたときの長さ').toBe(1000);
    expect(t.result.keptPackets).toBe(19);
  });

  it('🔴 前置きを必ず取る(いきなり切ると頭が濁る)', () => {
    const t = trimWebmOpus(src(), 1000, 2000);
    if (!t.ok) throw new Error('切れない');
    // 🔑 80ms 以上が要る(packet の長さに依らず、**時間で**戻る)
    expect(t.result.codecDelayNs / 1e6, '前置きが 80ms を下回っている').toBeGreaterThanOrEqual(80);
  });

  it('⚠ 端が packet の境目にぴったり当たっても、前置きは取る', () => {
    const t = trimWebmOpus(src(), 600, 1200);
    if (!t.ok) throw new Error('切れない');
    // ⚠ 600ms は packet 10 の頭 ── 80ms 以上戻るので packet 8(480ms)が基点
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
    expect(back.source.packets).toHaveLength(19);
    // ⚠ **中身が写っている**(並べ替えも取り違えもしていない)
    expect([...back.source.packets[0]!.data]).toEqual([240, 241, 242, 243]); // packet 15
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

  /**
   * 🔴 **頭の間隔が例外でも、切り口がずれない**(#683 段②a、実ブラウザ smoke が教えた)。
   *
   * ⚠ 直す前は **1 packet の長さを「最初の 2 つの差」だけ**で決め、それを
   *   **尻の位置**(最後の packet + 1 つぶん)にも使っていた。⚠ だから頭が例外的な
   *   file では物差しが狂い、**頼んだより 0.1 秒長い**物ができた
   *   (実測:in-app で 2.10〜2.12 秒。頼んだのは 2.00)。
   * 🔑 いまは ①長さは**間隔のまん中**で採り ②尻は**次の packet の時刻**で採る
   *   ── ②は見積もりを 1 つも使わない。
   */
  it('🔴 頭の間隔だけ違っても、頼んだ長さがそのまま出る', () => {
    // ⚠ 先頭だけ 170ms 空き、以降は 60ms(実測で読み違えた値)
    const odd = webm({ count: 60, stepMs: 60, oddFirstGapMs: 170 });
    const d = demuxWebmOpus(odd);
    if (!d.ok) throw new Error('ほどけない');
    expect(d.source.packetMs, '頭の 1 つに引きずられている').toBe(60);

    const t = trimWebmOpus(odd, 1000, 3000);
    if (!t.ok) throw new Error('切れない');
    expect(t.result.durationMs, '頼んだより長い / 短い物ができている').toBe(2000);
    // ⚠ 前置きは**時間で**確かめる(数ではない)
    expect(t.result.codecDelayNs / 1e6).toBeGreaterThanOrEqual(80);
  });

  it('⚠ 対照群 ── 間隔が揃っていれば、もちろん合う', () => {
    const t = trimWebmOpus(webm({ count: 60, stepMs: 60 }), 1000, 3000);
    if (!t.ok) throw new Error('切れない');
    expect(t.result.durationMs).toBe(2000);
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
  /**
   * 🔴 **札が本当に bytes へ書けているか**(変異試験 W9 / W10 が SURVIVED で教えた)。
   *
   * ⚠ 返り値の `codecDelayNs` / `discardPaddingNs` は**書く前に計算した値**なので、
   *   それを見ても「書けたか」は 1 ビットも分からない ── 実際、札を書かない変異も
   *   0 で書く変異も**両方生き延びた**。
   * 🔑 だから**書いた物を読み戻す**(`demuxWebmOpus` が両方の札を読む)。
   */
  it('🔴 頭の札(CodecDelay)が bytes に書かれている', () => {
    const t = trimWebmOpus(src(), 1000, 2000);
    if (!t.ok) throw new Error('切れない');
    const back = demuxWebmOpus(t.result.bytes);
    if (!back.ok) throw new Error('ほどけない');
    expect(back.source.codecDelayMs, '頭の札が書かれていない').toBe(100);
  });

  it('🔴 尻の札(DiscardPadding)が bytes に書かれている', () => {
    const t = trimWebmOpus(src(), 1000, 2000);
    if (!t.ok) throw new Error('切れない');
    const back = demuxWebmOpus(t.result.bytes);
    if (!back.ok) throw new Error('ほどけない');
    expect(back.source.discardPaddingMs, '尻の札が書かれていない').toBe(40);
  });

  it('⚠ 空振り防止 ── 捨てる物が無い切り出しには尻の札を書かない', () => {
    // 3 秒ちょうどで切れば余りが無い ── 札が 0 なら書かない側に倒れる
    const t = trimWebmOpus(src(), 0, 3000);
    if (!t.ok) throw new Error('切れない');
    const back = demuxWebmOpus(t.result.bytes);
    if (!back.ok) throw new Error('ほどけない');
    expect(back.source.discardPaddingMs).toBe(0);
    expect(back.source.codecDelayMs).toBe(0);
  });

  /**
   * 🔴 **切り出した物を、もう一度切る**(同じ変異から見つかった実害)。
   *
   * ⚠ 切り出した物には札が付いているので、`<audio>` が見せる時刻は
   *   **packet の時刻より札のぶん手前**である。札を読まずに切ると、
   *   **2 回目だけ 0.16 秒ずれる**(user から見ると「少し手前から始まる」)。
   */
  it('🔴 2 回目の切り出しが、札のぶんずれない', () => {
    const once = trimWebmOpus(src(), 1000, 2000);
    if (!once.ok) throw new Error('1 回目が切れない');
    expect(once.result.durationMs).toBe(1000);
    // 🔑 1 回目の結果の「鳴らして 0.2〜0.8 秒」を切る
    const twice = trimWebmOpus(once.result.bytes, 200, 800);
    if (!twice.ok) throw new Error('2 回目が切れない');
    expect(twice.result.durationMs, '2 回目の長さが頼んだとおりでない').toBe(600);
    const back = demuxWebmOpus(twice.result.bytes);
    if (!back.ok) throw new Error('ほどけない');
    /**
     * 🔑 **算数**:1 回目の file は packet を 60ms 刻みで持ち、札は 160ms。
     *   だから「鳴らして 200ms」は packet の物差しで **360ms**。前置き 2 つ戻って
     *   base は **240ms** なので、新しい札は **360 − 240 = 120ms** になる。
     * ⚠ 札を足さずに切ると `from0` が 200 のままになり、**別の packet から**
     *   始まって **160ms 手前の音**が混ざる(user には「少し手前から始まる」と見える)。
     */
    expect(back.source.codecDelayMs, '元の札を足していない(札のぶんずれる)').toBe(120);
    // ⚠ **選んだ packet そのもの**も見る(札だけ合って中身がずれる形を弾く)
    expect(back.source.packets).toHaveLength(12);
  });

  it('🔴 頼んだ始まりが録音より手前でも、捨てる量は負にならない', () => {
    // ⚠ 負の札を書くと、読み手は**頭を伸ばす**(音が増える)か、file ごと壊れる
    const t = trimWebmOpus(src(), -50, 500);
    if (!t.ok) throw new Error('切れない');
    expect(t.result.codecDelayNs).toBeGreaterThanOrEqual(0);
  });

  /**
   * 🔴 **外から来た webm は 0 から始まらないことが在る**(着地前レビュー 1-B)。
   *
   * ⚠ 印は `<audio>.currentTime` から採るが、**ブラウザは最初の時刻を 0 と見せる**
   *   (実測 2026-09-14:`Cluster` を +5000ms ずらしても `currentTime` は 0 起点で、
   *   `seekable` も `[0, …]` だった)。揃えないと、**まるで違う所を、黙って**切る。
   */
  it('🔴 0 から始まらない webm でも、頼んだ所が切れる', () => {
    const shifted = webm({ count: 50, stepMs: 60, originMs: 5000 });
    const d = demuxWebmOpus(shifted);
    if (!d.ok) throw new Error('ほどけない');
    expect(d.source.packets[0]!.ms, '0 起点に直していない').toBe(0);

    const t = trimWebmOpus(shifted, 1000, 2000);
    if (!t.ok) throw new Error('切れない');
    // ⚠ 0 から始まる file と**同じ結果**になる(起点は切り出しに影響しない)
    const plain = trimWebmOpus(src(), 1000, 2000);
    if (!plain.ok) throw new Error('切れない');
    expect(t.result.keptPackets).toBe(plain.result.keptPackets);
    expect(t.result.codecDelayNs).toBe(plain.result.codecDelayNs);
    expect(t.result.durationMs).toBe(plain.result.durationMs);
  });

  /**
   * 🔴 **track が 2 本あっても、opus のほうだけ採る**(着地前レビュー 1-C)。
   *
   * ⚠ 直す前は ①最後に読んだ track で上書きしていたので **`not-opus` で断り**
   *   ②block を track で分けていなかったので、**別の track の中身が混ざった**
   *   壊れた音を「切り出せました」と出していた。
   */
  it('🔴 opus でない track が混ざっていても、opus だけを切り出す', () => {
    for (const where of ['before', 'after'] as const) {
      const two = webm({ count: 20, stepMs: 60, extraTrack: where });
      const d = demuxWebmOpus(two);
      expect(d.ok, `${where}: opus の track が在るのに断った`).toBe(true);
      if (!d.ok) continue;
      expect(d.source.packets, `${where}: 別の track の block が混ざった`).toHaveLength(20);
      // ⚠ 中身も見る(数が合っていても、混ざれば内容が変わる)
      expect([...d.source.packets[0]!.data]).toEqual([0, 1, 2, 3]);
    }
  });

  it('⚠ CodecID に詰め物が付いていても opus と読める', () => {
    const d = demuxWebmOpus(webm({ padCodecId: true }));
    expect(d.ok, '末尾の \0 を落としていない').toBe(true);
  });

  it('🔴 出る bytes は範囲に比例する(丸ごと展開していない)', () => {
    const whole = trimWebmOpus(src(), 0, 3000);
    const part = trimWebmOpus(src(), 1000, 2000);
    if (!whole.ok || !part.ok) throw new Error('切れない');
    expect(part.result.bytes.length).toBeLessThan(whole.result.bytes.length * 0.6);
  });
});
