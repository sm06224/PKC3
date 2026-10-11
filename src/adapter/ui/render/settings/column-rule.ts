/**
 * 🔴 **段の境界線の濃さ**(#525。user 報告 2026-08-28
 * 「**段組の境界線を見たい。今は境界がわかりにくい**」)。
 *
 * ⚠ 実測すると、明るいテーマで**コントラスト 1.52 : 1** ── 文字以外の要素の
 *   下限(3 : 1)を大きく下回っていた。
 * 🔑 それでも**こちらで濃さを決めない** ── user 指示 2026-08-28
 *   「**user が選べる形にできるなら、そちらを先に出す**」に従い、
 *   **既定は現行そのまま**にして選べるようにする(#504 と同じ作法)。
 * ⚠ 段組みの**すぐ下**に置く(効くのは段組みのときだけなので、離すと結び付かない)。
 * (#1382 で `settings.ts` から移した。中身は変えていない。)
 */
import { COLUMN_RULES } from '@features/column-rule';
import { buildChoiceRow, syncChoiceRow } from '../choice-buttons';
import { currentColumnRule } from '../column-rule';
import { buildSettingsNote } from './note';
import type { SettingsSection } from './section';

export function createColumnRuleSection(region: HTMLElement): SettingsSection {
  return {
    id: 'column-rule',
    group: 'display',
    build(): Node[] {
      const rt = document.createElement('dt');
      rt.textContent = '段の境界線';
      const rd = document.createElement('dd');
      // 🔴 選択肢 3 つ ── プルダウンをボタンの列にする(#1038 段J)
      const rRow = buildChoiceRow({
        field: 'column-rule-select',
        ariaLabel: '段の境界線',
        action: 'set-column-rule',
        dataAttr: 'data-pkc-column-rule-value',
        choices: COLUMN_RULES,
        currentId: '', // render 末尾の sync が必ず映す
      });
      rRow.title = '1 段で読んでいるときは関係ありません。既定は細い線で、いまと同じ見え方です。';
      rd.append(rRow);
      rd.append(buildSettingsNote('段組みで読むときの、段と段のあいだの線の濃さです。'));
      return [rt, rd];
    },
    /**
     * ⚠ 段の線も映す ── 器は 1 度しか組まないので、映さないと
     *   別の面へ行って戻ったとき古い値が見える(§7)。
     */
    sync(): void {
      syncChoiceRow(
        region,
        'column-rule-select',
        'data-pkc-column-rule-value',
        currentColumnRule(document.documentElement),
      );
    },
  };
}
