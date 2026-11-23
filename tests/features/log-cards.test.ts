import { describe, it, expect } from 'vitest';
import { logCardEdges } from '@features/textlog/log-cards';

// 段の列: 0 = 見出しでない塊、2 = `##`(記録の頭)、3 = `###`(入れ子)
describe('logCardEdges(ログ 1 件 = 1 カードの区切り)', () => {
  it('記録の外(最初の見出しより前)は none', () => {
    expect(logCardEdges([0, 0, 2, 0])).toEqual(['none', 'none', 'first', 'last']);
  });
  it('見出しだけの記録は solo', () => {
    expect(logCardEdges([2, 2, 2])).toEqual(['solo', 'solo', 'solo']);
  });
  it('頭 + 本文 2 つ = first / mid / last', () => {
    expect(logCardEdges([2, 0, 0])).toEqual(['first', 'mid', 'last']);
  });
  it('入れ子 `###` とその中身は親と同じカードに入る', () => {
    expect(logCardEdges([2, 0, 3, 0, 2, 0])).toEqual(['first', 'mid', 'mid', 'last', 'first', 'last']);
  });
  it('段 1 の見出しも記録の頭', () => {
    expect(logCardEdges([1, 0, 2, 0])).toEqual(['first', 'last', 'first', 'last']);
  });
  it('見出しが 1 つも無ければ全部 none', () => {
    expect(logCardEdges([0, 0, 0])).toEqual(['none', 'none', 'none']);
  });
  it('空は空', () => {
    expect(logCardEdges([])).toEqual([]);
  });
  it('畳んだ記録(中身が隠れる)は見出しだけが solo', () => {
    expect(logCardEdges([2, 0, 0, 2, 0], [false, true, true, false, false])).toEqual(['solo', 'none', 'none', 'first', 'last']);
  });
  it('隠れた塊には印が付かず、見えている最後が last', () => {
    expect(logCardEdges([2, 0, 0], [false, false, true])).toEqual(['first', 'last', 'none']);
  });
  it('先頭の見出しが隠れたら、見えている最初の塊が first', () => {
    expect(logCardEdges([2, 0, 0], [true, false, false])).toEqual(['none', 'first', 'last']);
  });
  // ⚠ 降順(新しい順)は CSS の `order` だけで DOM の並びを変えない ── 「記録内の見た目の先頭 / 末尾 = DOM の先頭 / 末尾」は
  //   実ブラウザの smoke(`log-card.smoke.spec.ts` の新しい順)が見た目の座標で見る(この pure 関数の入力は降順でも変わらないので、ここでは主張しない)
});
