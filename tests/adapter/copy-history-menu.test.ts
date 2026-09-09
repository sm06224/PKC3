/**
 * 🔴 **「コピーした物」の一覧に何が並ぶか**(#678 / #679)。
 *
 * ⚠ ここは #678 の着地時に**1 本も無かった** ── メニューを組む規則(空なら 0 件 /
 *   消す口を必ず置く)は smoke だけが見ていた。🔑 規則そのものは純粋なので、
 *   ここで見るほうが速く・確実である。
 */
import { describe, expect, it } from 'vitest';
import type { CopiedItem } from '../../src/features/clipboard/history';
import {
  COPY_HISTORY_CLEAR,
  COPY_HISTORY_MANY,
  copyHistoryMenu,
} from '../../src/adapter/ui/actions/copy-history-menu';

const item = (text: string): CopiedItem => ({ at: 0, text, html: '' });
const labels = (items: readonly CopiedItem[]): string[] =>
  copyHistoryMenu(items).map((m) => m.label);

describe('コピーした物の一覧', () => {
  /**
   * 🔴 **空のときは 0 件**(#678)── 「まだ何もコピーしていません」を*項目*で出すと、
   * 押しても何も起きない行になる(呼び側が帯で言う)。
   */
  it('空なら 1 件も出さない', () => {
    expect(copyHistoryMenu([])).toEqual([]);
  });

  it('消す口を必ず置く(残り続ける情報を消せなくしない)', () => {
    expect(labels([item('あ')])).toContain(COPY_HISTORY_CLEAR);
  });

  /**
   * 🔴 **まとめて貼るは 2 件以上のときだけ**(#679)── 1 件しか無いのに出すと、
   * 押しても 1 件を選ぶだけの遠回りになる。
   */
  it('1 件のときは「まとめて貼る…」を出さない', () => {
    expect(labels([item('あ')])).not.toContain(COPY_HISTORY_MANY);
  });

  it('2 件以上なら「まとめて貼る…」が出る', () => {
    expect(labels([item('あ'), item('い')])).toContain(COPY_HISTORY_MANY);
  });

  /** ⚠ 並びは「物 → 束ねる操作 → 消す」── 消す口が物の間に紛れない。 */
  it('物が先、束ねる操作と消す口は後ろ', () => {
    expect(labels([item('あ'), item('い')])).toEqual([
      'あ',
      'い',
      COPY_HISTORY_MANY,
      COPY_HISTORY_CLEAR,
    ]);
  });

  /** ⚠ 押した行がどれかは**添字**で運ぶ(字で当てない ── 同じ字が並びうる)。 */
  it('物の行は添字を持つ', () => {
    const menu = copyHistoryMenu([item('あ'), item('い')]);
    expect(menu[0]?.attrs).toEqual({ 'data-pkc-copied': '0' });
    expect(menu[1]?.attrs).toEqual({ 'data-pkc-copied': '1' });
  });
});
