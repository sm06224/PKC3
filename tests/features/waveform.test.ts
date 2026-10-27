import { describe, expect, it } from 'vitest';
import {
  WAVE_MAX_POINTS,
  WAVE_MIN_POINTS,
  computePeaks,
  dragRange,
  msToFrac,
  peakCountFor,
  transcriptTimesMs,
  waveXToMs,
} from '../../src/features/audio/waveform';
import { ELAPSED_LINE_HEAD, parseElapsed } from '../../src/features/elapsed-text';
import { captureItemsFrom } from '../../src/features/capture/capture-item';

describe('computePeaks ── 山の高さ(#1232)', () => {
  it('既知の PCM から決まった山が出る(区間ごとの絶対値の最大)', () => {
    // 8 標本を 4 つに畳む: [0,.5] [-.25,.1] [0,-.75] [.2,0]
    const pcm = new Float32Array([0, 0.5, -0.25, 0.1, 0, -0.75, 0.2, 0]);
    expect([...computePeaks([pcm], 4)]).toEqual([0.5, 0.25, 0.75, 0.2].map(Math.fround));
  });

  it('全チャンネルの最大を採る(平均しない)', () => {
    const l = new Float32Array([0.5, 0, 0, 0]);
    const r = new Float32Array([0, 0, 0.9, 0]);
    expect([...computePeaks([l, r], 2)]).toEqual([Math.fround(0.5), Math.fround(0.9)]);
  });

  it('無音は全部 0(NaN にならない)', () => {
    const p = computePeaks([new Float32Array(1000)], 10);
    expect(p.length).toBe(10);
    expect([...p].every((v) => v === 0)).toBe(true);
  });

  it('個数の上限を超えない / 標本が山より少なくても NaN を作らない', () => {
    expect(computePeaks([new Float32Array(100000).fill(0.1)], 99999).length).toBe(WAVE_MAX_POINTS);
    const few = computePeaks([new Float32Array([1, 1])], 8);
    expect(few.length).toBe(8);
    expect([...few].every((v) => Number.isFinite(v))).toBe(true);
    expect(Math.max(...few)).toBeCloseTo(1);
  });

  it('クリップした値は 1 に丸める / チャンネル 0 本・空は全部 0', () => {
    expect(computePeaks([new Float32Array([3, -4])], 1)[0]).toBe(1);
    expect(computePeaks([], 4).length).toBe(4);
    expect(computePeaks([new Float32Array(0)], 4)[3]).toBe(0);
  });

  it('長さの違うチャンネルは短いほうに合わせる', () => {
    const a = new Float32Array([0.1, 0.1]);
    const b = new Float32Array([0, 0, 0.9, 0.9]);
    expect(Math.max(...computePeaks([a, b], 2))).toBeCloseTo(0.1);
  });
});

describe('peakCountFor ── 約 2px に 1 つ', () => {
  it('幅の半分・下限・上限', () => {
    expect(peakCountFor(400)).toBe(200);
    expect(peakCountFor(0)).toBe(WAVE_MIN_POINTS);
    expect(peakCountFor(Number.NaN)).toBe(WAVE_MIN_POINTS);
    expect(peakCountFor(50000)).toBe(WAVE_MAX_POINTS);
  });
});

describe('ポインタ ↔ 時刻(#1232)', () => {
  it('CSS で伸縮した幅(rect.width)で割る ── 画素幅ではない', () => {
    // 山 1000 個の画像が CSS で 250px に縮んでいる。帯の真ん中(left 100 + 125)= 長さの半分
    expect(waveXToMs(225, 100, 250, 600_000)).toBe(300_000);
    expect(waveXToMs(100, 100, 250, 600_000)).toBe(0);
    expect(waveXToMs(350, 100, 250, 600_000)).toBe(600_000);
  });

  it('はみ出しは端に張り付く / 幅 0・長さ不明は 0', () => {
    expect(waveXToMs(-50, 100, 250, 1000)).toBe(0);
    expect(waveXToMs(9999, 100, 250, 1000)).toBe(1000);
    expect(waveXToMs(5, 0, 0, 1000)).toBe(0);
    expect(waveXToMs(5, 0, 10, 0)).toBe(0);
  });

  it('msToFrac は waveXToMs の逆(重ね描きの位置)', () => {
    expect(msToFrac(300_000, 600_000)).toBe(0.5);
    expect(msToFrac(-1, 10)).toBe(0);
    expect(msToFrac(99, 10)).toBe(1);
    expect(msToFrac(5, 0)).toBe(0);
  });

  it('dragRange は小さいほうが始まり(右から左へ引いても同じ)', () => {
    expect(dragRange(10, 50)).toEqual({ startMs: 10, endMs: 50 });
    expect(dragRange(50, 10)).toEqual({ startMs: 10, endMs: 50 });
  });
});

describe('文字起こしの目盛り(#1232)', () => {
  const read = (b: string): number[] => transcriptTimesMs(b, ELAPSED_LINE_HEAD, parseElapsed);

  it('🔴 #1447 終わりつきの行(0:07 〜0:12)も、始まりの 1 点として拾う', () => {
    expect(read('0:07 〜0:12 こんにちは\n0:20 おわり')).toEqual([7000, 20_000]);
  });

  it('行頭の経過だけを拾う(本文の時刻リンクと同じ読み)', () => {
    expect(read('## 文字起こし 2026-10-02 12:34\n0:07 こんにちは\n1:02:03 おわり\n文中の 3:00 は拾わない\n0:75 壊れた綴り')).toEqual([
      7000, 3_723_000,
    ]);
  });

  it('添付の本文から CaptureItem.transcriptMs に載る / 無ければ空', () => {
    const fm = '---\nattachment.name: 録音-x.webm\nattachment.mime: audio/webm\nattachment.asset_key: k\n---\n';
    const [a, b] = captureItemsFrom([
      { lid: 'a', title: 'a', body: `${fm}\n0:15 はい\n0:30 ええ` },
      { lid: 'b', title: 'b', body: fm },
    ]);
    expect(a!.transcriptMs).toEqual([15000, 30000]);
    expect(b!.transcriptMs).toEqual([]);
  });
});
