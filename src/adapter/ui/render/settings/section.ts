/**
 * 設定(システム)画面の「節」の形(#1382)。
 *
 * 🔑 **節を足す = この形のファイルを 1 つ足し、`settings.ts` の登録表へ 1 行足す**。
 * ⚠ **`sync` は必須** ── 器は 1 度しか組まない(`build`)ので、映す口(`sync`)が無い節は
 *   「古い値が見える」画面になる(CLAUDE.md §7、`tests/adapter/settings-sections.test.ts`)。
 *   節を足す人が `sync` を呼び忘れる道を消すため、描画器は**登録表を回して**
 *   組む(`build`)・映す(`sync`)の両方を呼ぶ。個別の `syncX()` を直に呼ばない。
 */
import type { AppState } from '@adapter/state/app-state';

/**
 * 節が収まる場所(= 中身を受ける入れ物)。**同じ `group` の節は、登録の順に 1 つの入れ物へ並ぶ**。
 * - `top`: 目次の直後、「設定」より前(メッセージ)
 * - `display` / `edit` / `notify` / `open`: 「設定」の h4(表示 / 編集 / 通知 / 開き方)の `dl`
 *   ── 節は `dt` / `dd` の対を返す
 * - `paste`: 「設定」の中、編集と通知のあいだに置く独立した節(貼り付け)
 * - `permissions`: h3「許可」の中
 * - `history`: h3「記録」の中(「狭い画面の断り書き」より前)
 * - `too-narrow`: h4「狭い画面の断り書き」の `dl`(h3「記録」の末尾)
 * - `persist`: h4「PKC3 のデータ」の `dl`(h3「保存領域」の先頭)
 * - `notice` / `notice-list`: h3「お知らせ」の中の `dl` と、その下の「これまでのお知らせ」
 */
export type SettingsGroup =
  | 'top'
  | 'display'
  | 'edit'
  | 'paste'
  | 'notify'
  | 'open'
  | 'permissions'
  | 'history'
  | 'too-narrow'
  | 'persist'
  | 'notice'
  | 'notice-list';

export interface SettingsSection {
  /** 登録表の中で一意の名前。 */
  readonly id: string;
  readonly group: SettingsGroup;
  /**
   * 器を 1 度だけ組む。`dl` の中へ入る節は `dt` / `dd` の対(配列)を返す。
   * ⚠ 戻り値は、登録表の並びのまま DOM に並ぶ(test が pin する)。
   */
  build(): Node | Node[];
  /** 状態を映す。⚠ 最初の組み立ての直後と、以後の `render()` のたびに呼ばれる。 */
  sync(state: AppState): void;
}
