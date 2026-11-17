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
  /**
   * 🔴 **前の日の未完了を引き継ぐ**(#1966 4-4)── 「‹ 前の日」と同じ行き先(いちばん近い前の日付のノート)から写す。
   * ⚠ 前の日付のノートが無いときは押せない形で出す。⚠ 未完了の有無は本文を読まないと分からないので、ここでは見ない
   *   (押して 0 件なら「引き継ぐ未完了はありません」と言う ── 黙らない)。
   */
  const prev = adjacentDateNote(metas.values(), title, 'prev');
  const carry = document.createElement('button');
  carry.type = 'button';
  carry.setAttribute('data-pkc-action', 'carry-over-tasks');
  carry.textContent = '前の日の未完了を引き継ぐ';
  if (prev === null) {
    carry.disabled = true;
    carry.title = 'これより前の日付のノートはありません';
  } else {
    carry.title = `${prev.title} の未完了のチェック項目をこのノートの末尾に加え、${prev.title} の行は取り消し線とこのノートへのリンクに変えます`;
  }
  host.append(carry);
}
