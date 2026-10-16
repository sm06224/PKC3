/**
 * 🔴 **読み手が features に無い設定の鍵の検査**(#1087)。
 *
 * ⚠ 読み手と**同じ判定**を渡す(別に書き写さない)── 下見と当てるの 2 か所が同じ表を通る(§7)。
 *   features に読み手が在る鍵は `features/settings/settings-file.ts` の `PORTABLE_KEYS` が自分で持つ。
 */
import { isBrowseMode, BROWSE_STORAGE_KEY } from './browse-mode';
import { isQueryKeyValue, QUERY_KEY_STORAGE_KEY } from './query-key-store';
import { isThemeChoice, THEME_STORAGE_KEY } from './theme';

export const ADAPTER_SETTING_VALIDATORS: Readonly<Record<string, (value: string) => boolean>> = {
  [THEME_STORAGE_KEY]: isThemeChoice,
  [BROWSE_STORAGE_KEY]: isBrowseMode,
  [QUERY_KEY_STORAGE_KEY]: isQueryKeyValue,
};
