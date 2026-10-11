/**
 * 🔴 **本文の置き場所**(#722、2026-09-08)。
 *
 * ⚠ **戻す口が 1 つも無かった** ── 2026-09-06 に読み幅を列の中央へ置いたが、
 *   左寄せに戻すには紙面を「フル HD」にするしかなく、そうすると
 *   **読み幅の上限ごと外れる**。「上限は欲しいが左寄せがよい」人の行き場が無い。
 * 🔑 user 指示 2026-08-28「**私が決めた見え方を配るより、user が変えられる
 *   設定を作る**」に沿って選べる形にした。⚠ **既定は中央 = いまのまま**。
 * ⚠ ここ「表示」に置く ── 紙面・文字の大きさと同じ「見え方の好み」である。
 * (#1382 で `settings.ts` から移した。中身は変えていない。)
 */
import { PROSE_ALIGNS } from '@features/prose-align';
import { buildChoiceRow, syncChoiceRow } from '../choice-buttons';
import { currentProseAlign } from '../prose-align';
import { buildSettingsNote } from './note';
import type { SettingsSection } from './section';

export function createProseAlignSection(region: HTMLElement): SettingsSection {
  return {
    id: 'prose-align',
    group: 'display',
    build(): Node[] {
      const pat = document.createElement('dt');
      pat.textContent = '本文の置き場所';
      const pad = document.createElement('dd');
      // 🔴 選択肢 2 つ ── プルダウンをボタンの列にする(#1038 段J、C18 / Q7 の裁定 A)
      const paRow = buildChoiceRow({
        field: 'prose-align-select',
        ariaLabel: '本文の置き場所',
        action: 'set-prose-align',
        dataAttr: 'data-pkc-prose-align-value',
        choices: PROSE_ALIGNS,
        currentId: '', // render 末尾の sync が必ず映す
      });
      // ⚠ **いつ効くのか**まで書く ── 窓が読み幅より狭ければ、どちらでも同じに見える
      paRow.title =
        '表・図・コードも段落と同じ側に揃います。ウィンドウが読み幅より狭い、または' +
        'ページ設定が「フル HD」のときはどちらでも同じ見え方です。' +
        '書き出した HTML は、書き出したときの置き場所のまま表示されます。';
      pad.append(paRow);
      pad.append(
        buildSettingsNote('ウィンドウが読み幅より広いとき、本文をペインの中央か左端に置きます(既定は中央)。'),
      );
      return [pat, pad];
    },
    /**
     * ⚠ 画面の値を**いまの置き場所に合わせる**(#722)。器は 1 度しか組まないので、
     *   映さないと**別の面へ行って戻ると古い値が見える**(§7 の「設定画面の値の同期」)。
     * ⚠ 正本は DOM(`applyProseAlign` が当てた属性)── 保存を読み直さない。
     */
    sync(): void {
      syncChoiceRow(
        region,
        'prose-align-select',
        'data-pkc-prose-align-value',
        currentProseAlign(document.documentElement),
      );
    },
  };
}
