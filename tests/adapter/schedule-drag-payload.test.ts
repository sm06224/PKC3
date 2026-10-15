/**
 * 🔴 **マウスで掴んだ予定の札の荷物**(#1087)── 掴んだ時点の行の中身が、落とす側まで届くこと。
 * ⚠ 実ブラウザの smoke は、掴んでから落とすまでに行がずれないので、5 つ目が欠けても日付は動く(変異が生き延びた)。
 *   だから組む口と読む口をここで往復させて見る。
 */
import { describe, expect, it } from 'vitest';
import { decodeTaskDrag, encodeTaskDrag } from '../../src/adapter/ui/render/schedule-drag';

describe('予定の札の荷物', () => {
  it('🔴 掴んだ行の中身(空白・全角・記号つき)が往復する', () => {
    const t = { lid: 'n1', line: '3', from: '2026-10-15', repeat: '', rawLine: '- [ ] 会議 @2026-10-15 　資料 100% #重要' };
    expect(decodeTaskDrag(encodeTaskDrag(t))).toEqual(t);
  });
  it('繰り返しの回・ノート丸ごと(行なし)も往復する', () => {
    const t = { lid: 'n2', line: '', from: '', repeat: 'week' };
    expect(decodeTaskDrag(encodeTaskDrag(t))).toEqual(t);
  });
  it('⚠ 5 つ目が壊れていたら省く(従来の引き方に倒れる)', () => {
    expect(decodeTaskDrag('n1 3 2026-10-15  %E0%A4%A')).toEqual({ lid: 'n1', line: '3', from: '2026-10-15', repeat: '' });
  });
  it('lid が無ければ受けない', () => {
    expect(decodeTaskDrag('')).toBeNull();
  });
});
