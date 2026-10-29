/**
 * 🔴 **日付ノートの上の「‹ 前の日 / 次の日 ›」**(#1640 項 2。推薦 =「日付が題名のノートだけ、本文の上に出す。
 * ノートがある日だけ飛ぶ」)。
 *
 * - 出すのは**題名が日付(`2026-10-15` の形)のノートを読んでいるとき**だけ。それ以外は何も出さない(器ごと隠す)。
 * - 行き先は `adjacentDateNote`(「操作を探す」の「前の日のノートを開く」と同じ 1 本 ── 判定を 2 本にしない)。
 *   その向きに日付のノートが無いボタンは押せない形で出す(押しても何も起きないボタンを作らない)。
 * - 本文には触らない・ノートは増えない。押した先の日が `title` で分かる。
 */
import type { EntryMeta } from '@core/model/entry-meta';
import { adjacentDateNote, isDateTitle } from '@features/schedule/today-note';

/** 器の印(`detail.ts` が組む)。 */
export const DAY_NAV_FIELD = 'detail-day-nav';

export function paintDayNav(
  host: HTMLElement,
  metas: ReadonlyMap<string, EntryMeta>,
  lid: string,
): void {
  const cur = metas.get(lid);
  const title = cur !== undefined && !cur.archived && isDateTitle(cur.title) ? cur.title : null;
  const key = title === null ? '' : `${title}|${adjacentDateNote(metas.values(), title, 'prev')?.lid ?? ''}|${adjacentDateNote(metas.values(), title, 'next')?.lid ?? ''}`;
  // 同じ中身なら触らない(焦点を握っているボタンを作り直さない)
  if (host.getAttribute('data-pkc-day-nav-key') === key) return;
  host.setAttribute('data-pkc-day-nav-key', key);
  host.textContent = '';
  host.hidden = title === null;
  if (title === null) return;
  for (const dir of ['prev', 'next'] as const) {
    const to = adjacentDateNote(metas.values(), title, dir);
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('data-pkc-action', 'open-adjacent-day');
    b.setAttribute('data-pkc-dir', dir);
    b.textContent = dir === 'prev' ? '‹ 前の日' : '次の日 ›';
    if (to === null) {
      b.disabled = true;
      b.title = dir === 'prev' ? 'これより前の日付のノートはありません' : 'これより後の日付のノートはありません';
    } else {
      b.title = `${to.title} のノートを開きます(ノートがある日だけ飛びます)`;
    }
    host.append(b);
  }
}
