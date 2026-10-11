/**
 * 🔴 **文字の大きさ**(#504。user 指示 2026-08-28
 * 「**正直変更はユーザーに委ねて欲しい**」)。
 *
 * ⚠ **flag ではない**(正規設定)── 15 枠は 1 つも使わない。
 * ⚠ ここ「表示」に置く ── 紙面・編集の仕方と同じ「見え方の好み」である。
 * ⚠ **既定は「標準」= 現行そのまま** ── 選ばなければ見え方は変わらない。
 * (#1382 で `settings.ts` から移した。中身は変えていない。)
 */
import { TEXT_SCALES } from '@features/text-scale';
import { buildChoiceRow, syncChoiceRow } from '../choice-buttons';
import { currentTextScale } from '../text-scale';
import { buildSettingsNote } from './note';
import type { SettingsSection } from './section';

export function createTextScaleSection(region: HTMLElement): SettingsSection {
  return {
    id: 'text-scale',
    group: 'display',
    build(): Node[] {
      const tt = document.createElement('dt');
      tt.textContent = '文字の大きさ';
      const td = document.createElement('dd');
      // 🔴 選択肢 4 つ ── プルダウンをボタンの列にする(#1038 段J)
      const tRow = buildChoiceRow({
        field: 'text-scale-select',
        ariaLabel: '文字の大きさ',
        action: 'set-text-scale',
        dataAttr: 'data-pkc-text-scale-value',
        choices: TEXT_SCALES,
        currentId: '', // render 末尾の sync が必ず映す
      });
      td.append(tRow);
      // ⚠ **何が動いて、何が動かないか**を書く(押した後に探させない)。詳しくは hover。
      const tnote = buildSettingsNote('本文と画面の字の大きさを、この端末だけで変えます。');
      tRow.title =
        '読み幅(1 行の長さ)は動かないので、大きくすると 1 行に入る字が減ります。' +
        'ノートの中身には入りません。';
      td.append(tnote);
      return [tt, td];
    },
    /**
     * ⚠ 画面の値を**いまの大きさに合わせる**(#504)。器は 1 度しか組まないので、
     *   映さないと**別の面へ行って戻ると古い値が見える**(§7 の「設定画面の値の同期」)。
     * ⚠ 正本は DOM(`applyTextScale` が当てた属性)── 保存を読み直さない。
     */
    sync(): void {
      syncChoiceRow(
        region,
        'text-scale-select',
        'data-pkc-text-scale-value',
        currentTextScale(document.documentElement),
      );
    },
  };
}
