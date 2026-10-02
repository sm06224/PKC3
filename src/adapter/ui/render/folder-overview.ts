/**
 * 🔴 **フォルダの概要を描く**(#1222。Gemini 裁定 2026-10-01 = A)。
 *
 * > user の物語:フォルダを 1 回押した。中央にはその説明が出るだけで、**中に何が在るか**は
 * > 左の列を見に行かないと分からなかった。いまは説明の**下に**、直下の件数と
 * > 題名・更新日の一覧が出る。行を押すと、そのノートが中央に開き、**左の列もそのフォルダの中へ移る**。
 *
 * ⚠ 行の中身(並び・件数)は `features/relation/folder-overview.ts` が決める ── ここは描くだけ。
 * ⚠ 押した結果は `select-entry`(binder)が受ける。**押された行の lid は
 *   `data-pkc-entry`、その行が属するフォルダは器の `data-pkc-overview-scope`** が運ぶ。
 * ⚠ 器は**本文の器の外**に置く(`DetailRenderer` が `applyBlocks` の差分で本文の器を作り直しても
 *   消えない / 逆に本文の差分が概要を消さない)。
 */
import type { EntryMeta } from '@core/model/entry-meta';
import { formatListDate, formatStoredDate } from '@features/datetime/stored-date';
import { archetypeLabel } from '@features/flavor/archetype-label';
import { ENTRY_ACTION_LABELS } from '@features/entry-actions';
import { overviewMore, overviewSummary, type FolderOverview } from '@features/relation/folder-overview';
import { ARCHETYPE_ICONS, iconSpan } from './icons';

export const OVERVIEW_REGION = 'folder-overview';

/** 概要の器を組む。`lid` はこの概要が属するフォルダ。 */
export function buildFolderOverview(
  lid: string,
  overview: FolderOverview,
  year: number,
): HTMLElement {
  const box = document.createElement('section');
  box.setAttribute('data-pkc-region', OVERVIEW_REGION);
  box.setAttribute('data-pkc-overview-scope', lid);
  box.setAttribute('aria-label', 'フォルダ概要');

  const summary = document.createElement('p');
  summary.setAttribute('data-pkc-field', 'overview-summary');
  summary.textContent = overviewSummary(overview);
  box.append(summary);

  /**
   * 🔴 **空のフォルダには、作る入口を 1 つ置く**(#1254 §3 改善 A。Gemini 裁定 = a)。
   *
   * > user の物語:空のフォルダを押した。「直下 ノート 0 件 / フォルダ 0 件」と出るだけで、
   * > **何をすればよいか**が画面に無かった(作る入口は行の右クリックか Shift+F4 だけ)。
   *
   * ⚠ **押したときの動きは行の右クリックの「この中に新しいノートを作る」と同じ 1 本**
   *   (`create-in-folder`。新しい action を作らない ── 字も `ENTRY_ACTION_LABELS` から引く。§7)。
   *   受け手は押した所から lid を引き、無ければ**いま選んでいるフォルダ**(= この概要の持ち主)。
   * ⚠ 出すのは**ノートもフォルダも 0 件のときだけ**(1 件でも在れば、左の列の「+ ノート」と
   *   右クリックがあり、概要の行を押す邪魔にしない)。
   */
  if (overview.notes === 0 && overview.folders === 0) {
    const create = document.createElement('button');
    create.type = 'button';
    create.setAttribute('data-pkc-action', 'create-in-folder');
    create.setAttribute('data-pkc-field', 'overview-create');
    create.textContent = ENTRY_ACTION_LABELS['create-in-folder'] ?? '';
    box.append(create);
  }

  if (overview.rows.length === 0) return box;

  const list = document.createElement('ul');
  list.setAttribute('data-pkc-field', 'overview-list');
  for (const m of overview.rows) list.append(buildRow(m, year));
  box.append(list);

  if (overview.more > 0) {
    const more = document.createElement('p');
    more.setAttribute('data-pkc-field', 'overview-more');
    more.textContent = overviewMore(overview.more);
    box.append(more);
  }
  return box;
}

function buildRow(m: EntryMeta, year: number): HTMLElement {
  const li = document.createElement('li');
  // ⚠ `data-pkc-entry` はボタン自身が持つ(`select-entry` と同じ綴り ── 行の右クリックなどの
  //   「押した所から lid を引く」受け手がそのまま効く)
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.setAttribute('data-pkc-action', 'select-entry');
  btn.setAttribute('data-pkc-entry', m.lid);
  const chip = iconSpan(ARCHETYPE_ICONS[m.archetype] ?? 'dot');
  chip.setAttribute('data-pkc-chip', m.archetype);
  chip.title = archetypeLabel(m.archetype);
  const name = document.createElement('span');
  name.setAttribute('data-pkc-field', 'overview-title');
  name.textContent = m.title;
  const when = document.createElement('span');
  when.setAttribute('data-pkc-field', 'when');
  when.textContent = formatListDate(m.updatedAt, year);
  const full = formatStoredDate(m.updatedAt, '');
  if (full !== '') when.title = `更新 ${full}`;
  btn.append(chip, name, when);
  li.append(btn);
  return li;
}
