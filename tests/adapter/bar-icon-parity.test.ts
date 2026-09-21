/** @vitest-environment happy-dom */
/**
 * 🔴 **同じ帯のボタンは、全部に絵が在るか、全部無いか**(#1029 段 D)。
 *
 * ## なぜ要るか
 *
 * user 指摘 2026-09-21:「**視覚的にもでこぼこで統一感がなく、ストレス**」。
 * 実測すると、**同じ字のボタンが帯によって絵つき / 無地**に分かれていた ──
 * 収録の帯の「止める」「捨てる」には絵が在るのに、**計るの帯の同じ 2 つは無地**だった。
 * ⚠ 絵の無いほうは**字の始まりがずれる**ので、並びの中で**弱い操作に見える**。
 *
 * 🔑 守るのは「絵が在るか」ではなく「**その帯の中で揃っているか**」である。
 * ⚠ 「絵の登記が N 件以上」で書くと、**混ざっていても緑**になる(§1 の空振り)。
 *
 * ## ⚠ 「全部に付ける」を正解にしない
 *
 * 書体に無い絵(写す / 移す / 別の窓 / スライド)を**それらしく当てる**と、
 * 2026-09-05 の実測「**50 個のうち 23 個が完全に同じ見た目**」を絵で再演する。
 * だからこの検査は**揃っていること**だけを見る ── 全部無地の帯も合格である。
 *
 * ## 🔑 見るのは**描いた DOM**(字面を切り出さない)
 *
 * ⚠ 1 稿目は source から関数の本文を切り出したが、**収録の帯だけ `buildShell` の中**で
 *   組まれていて切り出せなかった ── 字面の形に寄りかかると、置き場が変わった日に
 *   「切り出せない」で落ちる。**描いた物を見れば、置き場に依らない。**
 */
import { describe, expect, it, beforeEach } from 'vitest';
import {
  buildShell,
  paintAlarmBar,
  paintCaptureBar,
  paintTimerBar,
} from '../../src/adapter/ui/render/shell';

/** 🔴 **揃っていてほしい帯**(⚠ 足すときは理由を 1 行書く)。 */
const BARS: readonly (readonly [region: string, why: string])[] = [
  ['capture-bar', '止める / 捨てる が並ぶ'],
  ['timer-bar', '収録の帯と同じ字が並ぶ'],
  ['alarm-bar', '開く / 閉じる が並ぶ'],
];

function shellWithBars(): HTMLElement {
  const root = document.createElement('div');
  document.body.append(root);
  buildShell(root);
  paintCaptureBar(root, '録音しています 00:12');
  paintTimerBar(root, [{ lid: 'n1', title: '会議メモ', startedAtMs: 0 }], 60_000);
  paintAlarmBar(root, [
    { key: 'k1', lid: 'n1', line: 3, text: '打ち合わせ', time: '10:00' },
  ]);
  return root;
}

beforeEach(() => {
  document.body.textContent = '';
});

describe('同じ帯のボタンは、絵の有無が揃っている(#1029 段 D)', () => {
  it('🔴 帯ごとに、絵つきと無地が混ざっていない', () => {
    const root = shellWithBars();
    const mixed: string[] = [];
    for (const [region, why] of BARS) {
      const bar = root.querySelector<HTMLElement>(`[data-pkc-region="${region}"]`);
      expect(bar, `${region} が描けていない(${why})`).not.toBeNull();
      const btns = [...(bar?.querySelectorAll<HTMLButtonElement>('button') ?? [])];
      // ⚠ 空振り防止 ── 0 個だと「揃っている」は 0 対 0 で成立する
      expect(btns.length, `${region} のボタンを 1 つも描けていない(空振り。${why})`).toBeGreaterThan(
        1,
      );
      const withIcon = btns.filter((b) => b.querySelector('[data-pkc-symbol]') !== null).length;
      if (withIcon !== 0 && withIcon !== btns.length)
        mixed.push(`${region}: 絵あり ${withIcon} / ${btns.length}`);
    }
    expect(
      mixed,
      `同じ帯の中で絵の有無が混ざっている(字の始まりがずれて、無地のほうが弱く見える): ${mixed.join(' / ')}`,
    ).toEqual([]);
  });

  it('⚠ 空振り防止 ── 絵を持つボタンが実際に描けている(全部無地なら上は素通りする)', () => {
    const root = shellWithBars();
    const all = [...root.querySelectorAll('[data-pkc-region="capture-bar"] [data-pkc-symbol]')];
    expect(all.length, '収録の帯に絵が 1 つも無い ── 観測が効いていない').toBeGreaterThan(0);
  });
});
