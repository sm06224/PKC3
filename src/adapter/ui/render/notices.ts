/**
 * 複数件の注意を**全部**見せる面(P6c review H-2)。
 *
 * ⚠ これが無かった間、`notify` の 1 行に `notes[0]` だけを載せていたため
 * **2 件目以降はどこにも出力されていなかった**(console にも state にも残らない)。
 * 段②までは注意が 1〜2 件だったので実害が出ていなかっただけで、段④ で件数が
 * 内側 bundle 数に比例した瞬間に効く ── 「欠損は必ず warning で可視化する」の
 * 出口が塞がっていた。
 *
 * user が閉じるまで残す(status footer は次の操作で上書きされて消えるので、
 * 「取り込んだ後に読み返す」ができない)。
 */
import type { NoticeAction } from '../actions/import-undo';

export function showNotices(
  region: HTMLElement,
  title: string,
  notes: readonly string[],
  action: NoticeAction | null = null,
): void {
  region.textContent = '';
  /**
   * ⚠ **操作が在るときは、注意が 0 件でも出す**(#535 ②)── 取り込みの戻り道は
   *   「注意が出たときだけ在る」ものではない。⚠ 逆に**どちらも無ければ出さない**
   *   (空の箱を置かない)。
   */
  if (notes.length === 0 && action === null) {
    region.hidden = true;
    return;
  }

  const head = document.createElement('div');
  head.setAttribute('data-pkc-field', 'notices-title');
  // ⚠ 件数は**注意の数** ── 0 件のときに「(0 件)」と出さない
  head.textContent = notes.length > 0 ? `${title}(${notes.length} 件)` : title;

  if (action !== null) {
    const act = document.createElement('button');
    act.type = 'button';
    act.setAttribute('data-pkc-action', action.action);
    act.setAttribute('data-pkc-field', 'notices-action');
    act.title = action.title;
    act.textContent = action.label;
    head.append(act);
  }

  const close = document.createElement('button');
  close.type = 'button';
  close.setAttribute('data-pkc-action', 'dismiss-notices');
  close.textContent = '閉じる';
  // ⚠ **閉じるは最後** ── 押し慣れた場所(いちばん右)を動かさない
  head.append(close);

  const list = document.createElement('ul');
  for (const n of notes) {
    const li = document.createElement('li');
    li.setAttribute('data-pkc-notice', '');
    li.textContent = n;
    list.append(li);
  }

  region.append(head, list);
  region.hidden = false;
}

/** 閉じる(次の取込で再び出る)。 */
export function clearNotices(region: HTMLElement): void {
  region.textContent = '';
  region.hidden = true;
}
