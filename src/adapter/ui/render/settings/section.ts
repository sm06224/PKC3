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
 * 節が収まる場所。
 * - `top`: 目次の直後、「設定」より前(メッセージ)
 * - `permissions`: h3「許可」の中
 * - `history`: h3「記録」の中(「狭い画面の断り書き」より前)
 * - `inline`: まだ `settings.ts` の `render()` が直に組んでいる節(`build` は `null`)。
 *   ⚠ 映す口だけを登録表へ載せてある(順次ファイルへ移す)。
 */
export type SettingsGroup = 'top' | 'permissions' | 'history' | 'inline';

export interface SettingsSection {
  /** 登録表の中で一意の名前。 */
  readonly id: string;
  readonly group: SettingsGroup;
  /**
   * 器を 1 度だけ組む。`inline` の節は `null`(`render()` が直に組んでいる)。
   * ⚠ 戻り値の根の要素は、登録表の並びのまま DOM に並ぶ(test が pin する)。
   */
  build(): HTMLElement | null;
  /** 状態を映す。⚠ 最初の組み立ての直後と、以後の `render()` のたびに呼ばれる。 */
  sync(state: AppState): void;
}
