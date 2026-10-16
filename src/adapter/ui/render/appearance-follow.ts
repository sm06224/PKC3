/**
 * 🔴 **別のウィンドウで選んだ見た目の好みを、開いたままの自分にも当てる**(#1087)。
 *
 * ⚠ 配色・文字の大きさは `theme.ts` / `text-scale.ts` が持つ。ここは残りの 5 つ
 *   (紙面・本文の置き場所・段数・段の境界線・タグの見せ方)。直す前は、予定のウィンドウや
 *   付箋など開いたままの別ウィンドウは読み込み直すまで古いままだった。
 * ⚠ `storage` event は**書いた側以外**にだけ届くので、自分が選んだ回に二重に当たらない。
 * 🔑 当て方は起動時と同じ `apply*(initial*())`(段の高さは `installColumnFit` が追随する)。
 * ⚠ **返り値で外す**。
 */
import { applyPageFormat, initialPageFormat, PAGE_FORMAT_STORAGE_KEY } from './page-format';
import { applyProseAlign, initialProseAlign, PROSE_ALIGN_STORAGE_KEY } from './prose-align';
import { applyReadColumns, initialReadColumns, READ_COLUMNS_STORAGE_KEY } from './read-columns';
import { applyColumnRule, initialColumnRule, COLUMN_RULE_STORAGE_KEY } from './column-rule';
import { applyTagBadge, initialTagBadge, TAG_BADGE_STORAGE_KEY } from './tag-badge';

export function watchAppearanceFromOtherWindows(
  target: HTMLElement,
  win: Pick<Window, 'addEventListener' | 'removeEventListener'>,
): () => void {
  const follows: ReadonlyArray<readonly [string, () => void]> = [
    [PAGE_FORMAT_STORAGE_KEY, () => applyPageFormat(target, initialPageFormat())],
    [PROSE_ALIGN_STORAGE_KEY, () => applyProseAlign(target, initialProseAlign())],
    [READ_COLUMNS_STORAGE_KEY, () => applyReadColumns(target, initialReadColumns())],
    [COLUMN_RULE_STORAGE_KEY, () => applyColumnRule(target, initialColumnRule())],
    [TAG_BADGE_STORAGE_KEY, () => applyTagBadge(target, initialTagBadge())],
  ];
  const onStorage = (ev: Event): void => {
    const key = (ev as StorageEvent).key;
    // ⚠ `key === null` は「全消し」── 既定へ戻るので全部当て直す
    for (const [k, apply] of follows) if (key === null || key === k) apply();
  };
  win.addEventListener('storage', onStorage);
  return () => win.removeEventListener('storage', onStorage);
}
