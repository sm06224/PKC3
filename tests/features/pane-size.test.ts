/**
 * ペインの大きさの**判定**(#497)。DOM も保存も出てこない ── ここは pure だけ。
 *
 * 🔴 守る主張:
 * 1. **向きが面ごとに違う**(右の面は左へ引くと広がる)── ここを取り違えると
 *    「掴んだ向きと逆に動く」という、触った瞬間に分かるのに test では見えない欠陥になる
 * 2. **下限を割ったら畳む**(0 の面を残さない)
 * 3. **掴みと鍵が同じ答えを出す**(§7 ── 判定が 2 か所に生えていない)
 * 4. 保存は**正規化**され、知らない値は捨てる
 */
import { describe, expect, it } from 'vitest';
import {
  decodePaneSizes,
  encodePaneSizes,
  nudgeOutcome,
  PANE_SIZE_SPECS,
  paneSizeCss,
  paneSizeVar,
  resizeOutcome,
  roundPaneSize,
  SIZED_PANES,
  type SizedPaneId,
} from '../../src/features/pane-size';

describe('向き(#497)', () => {
  /**
   * 🔴 **3 面を 1 つずつ名指しで見る。** ⚠ `PANE_SIZE_SPECS[id].grow` を使って
   * 期待値を組むと、**表を書き換えた変異がそのまま通る**(実装と同じ綴りの
   * 別の書き方になる ── CLAUDE.md §1「同じ盲点を共有する」)。
   */
  it('🔴 左の面は右へ引くと広がる', () => {
    expect(resizeOutcome('sidebar', 300, +40)).toEqual({ kind: 'size', px: 340 });
    expect(resizeOutcome('sidebar', 300, -40)).toEqual({ kind: 'size', px: 260 });
  });

  it('🔴 右の面は**左**へ引くと広がる', () => {
    expect(resizeOutcome('inspector', 300, -40)).toEqual({ kind: 'size', px: 340 });
    expect(resizeOutcome('inspector', 300, +40)).toEqual({ kind: 'size', px: 260 });
  });

  it('🔴 追記欄は**上**へ引くと高くなる', () => {
    expect(resizeOutcome('append', 100, -40)).toEqual({ kind: 'size', px: 140 });
    expect(resizeOutcome('append', 100, +40)).toEqual({ kind: 'size', px: 60 });
  });
});

describe('畳む・上限(#497)', () => {
  it('🔴 下限を割ったら「畳む」── 0 px の面を作らない', () => {
    for (const id of SIZED_PANES) {
      const min = PANE_SIZE_SPECS[id].min;
      // ⚠ 下限**ちょうど**は畳まない(境目をどちら側に置いたかを固定する)
      expect(resizeOutcome(id, min, 0), `${id}: 下限ちょうどで畳んだ`).toEqual({
        kind: 'size',
        px: min,
      });
      const outcome = resizeOutcome(id, min, PANE_SIZE_SPECS[id].grow * -1);
      expect(outcome, `${id}: 下限を割っても畳まない`).toEqual({ kind: 'collapse' });
    }
  });

  it('上限は超えない(引き続けても止まる)', () => {
    for (const id of SIZED_PANES) {
      const max = PANE_SIZE_SPECS[id].max;
      const outcome = resizeOutcome(id, max, PANE_SIZE_SPECS[id].grow * 10_000);
      expect(outcome, `${id}: 上限を超えた`).toEqual({ kind: 'size', px: max });
    }
  });

  /**
   * 🔴 **掴みと鍵が同じ答えを出す**(§7)。⚠ 別々に書くと、
   * 「鍵でだけ畳めない」「鍵でだけ上限が違う」が静かに生まれる。
   */
  it('🔴 鍵 1 回は「1 step ぶん掴んだ」と同じ', () => {
    for (const id of SIZED_PANES) {
      const step = PANE_SIZE_SPECS[id].step;
      expect(nudgeOutcome(id, 300, +1), id).toEqual(resizeOutcome(id, 300, +step));
      expect(nudgeOutcome(id, 300, -1), id).toEqual(resizeOutcome(id, 300, -step));
    }
  });

  it('🔴 畳んである面(0)から引き出せる ── 戻す口が 2 本ある', () => {
    // ⚠ 下限まで引かないと戻らない(中途半端に細い面を作らない)
    expect(resizeOutcome('sidebar', 0, +40)).toEqual({ kind: 'collapse' });
    expect(resizeOutcome('sidebar', 0, +200)).toEqual({ kind: 'size', px: 200 });
  });
});

describe('保存の形(#497)', () => {
  it('触っていない面は書かない', () => {
    expect(encodePaneSizes({})).toBe('');
    expect(encodePaneSizes({ inspector: 300 })).toBe('inspector:300');
  });

  it('🔴 並びは正規化する(同じ状態が 2 通りの文字列にならない)', () => {
    expect(encodePaneSizes({ inspector: 300, sidebar: 240 })).toBe(
      encodePaneSizes({ sidebar: 240, inspector: 300 }),
    );
  });

  it('往復して変わらない', () => {
    const sizes = { sidebar: 240, inspector: 300, append: 120 };
    expect(decodePaneSizes(encodePaneSizes(sizes))).toEqual(sizes);
  });

  it('知らない名前・数でない値・0 以下は捨てる', () => {
    expect(decodePaneSizes('sidebar:240 ghost:99 inspector:abc append:0 append:-5')).toEqual({
      sidebar: 240,
    });
    expect(decodePaneSizes('')).toEqual({});
    expect(decodePaneSizes(null)).toEqual({});
    expect(decodePaneSizes('sidebar')).toEqual({});
  });

  it('上限を超えた保存は丸める(手で書き換えた file でも壊れない)', () => {
    expect(decodePaneSizes('sidebar:99999')).toEqual({ sidebar: PANE_SIZE_SPECS.sidebar.max });
    expect(roundPaneSize('sidebar', Number.NaN)).toBe(0);
  });
});

describe('CSS へ渡す形(#497)', () => {
  /**
   * 🔴 **画面が狭くなったら自分で縮む** ── これが無いと、決めた幅のせいで
   * 本文が消えるところまで押し出される(そして user は直し方が分からない)。
   * ⚠ 上限が `vw` / `vh` で入っていることまで見る ── px だけだと縮まない。
   */
  it('🔴 clamp で自分を制限する(JS が resize を聞き直さなくてよい)', () => {
    expect(paneSizeCss('sidebar', 240)).toBe('clamp(0px, 240px, 45vw)');
    expect(paneSizeCss('inspector', 300)).toBe('clamp(0px, 300px, 45vw)');
    // ⚠ 高さの面は **vh** ── vw を使い回すと、横長の画面で青天井になる
    expect(paneSizeCss('append', 120)).toBe('clamp(0px, 120px, 60vh)');
  });

  it('変数名は 1 か所で綴る', () => {
    for (const id of SIZED_PANES) expect(paneSizeVar(id)).toBe(`--pkc-pane-${id}`);
  });

  /**
   * 🔴 **CSS 側にも同じ変数が在る**(§7 の「両端が別々に綴る」)。
   * ⚠ 片方の綴りを変えても、どちらの test も緑のまま通る ── だから
   *   **実物の CSS を読んで**突き合わせる。
   */
  it('🔴 app.css が同じ名前を読んでいる', async () => {
    const { readFileSync } = await import('node:fs');
    const css = readFileSync('src/styles/app.css', 'utf-8');
    for (const id of SIZED_PANES as readonly SizedPaneId[]) {
      expect(css, `${id}: CSS が ${paneSizeVar(id)} を読んでいない`).toContain(
        `var(${paneSizeVar(id)},`,
      );
    }
  });
});
