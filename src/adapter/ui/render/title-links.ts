/**
 * 🔴 **本文の `[[題名]]` に、「ノートがある / まだ無い」の印を当てる**(#1174 段②)。
 *
 * ## 何をするか
 * `[[題名]]`(markdown が `.pkc-title-link` に焼いた押せる字)のうち、**その題名のノートが無い**ものへ
 * `data-pkc-link-missing` と `title`(押す前の案内)を付ける。ある物は実線の下線のまま、
 * 無い物は薄い字 + 点線(既存の「リンク先が無い」と同じ見え方 ── 同じ意味に同じ見た目)。
 * 押すと、ある物は開き、無い物は画面の下に「○○のノートを作る」が出る(`binder.ts` の `open-title-note`)。
 *
 * ## 🔑 なぜ描画後の DOM 走査か
 * markdown はワーカーで描かれ、`entryMetas` を持っていない(`link-missing.ts` と同じ事情)。
 * 冪等 ── 描画のたびに / `entryMetas` が変わったときに、描き直さずにこれだけを当て直す。
 * 題名の集合は 1 回だけ作る(リンクごとに全ノートを舐めない)。
 *
 * ## 判定は 1 本
 * 「題名で探す」は `findTodayNote`(`schedule/today-note.ts`。片付けたノートを拾わない・同名は一覧で上のほう)と
 * **同じ規則**でなければならない ── 印が「ある」と言うのに押すと「無い」になるのを防ぐため、
 * 規則の本体(`preferTitleNote`)を共有する `titleNoteIndex` を引く。
 *
 * ⚠ 当てるのは中央の読む面だけ(書き出した HTML・別窓には `entryMetas` が無く、1 バイトも変えない)。
 * ⚠ `title` は user が付けたものを潰さない(空のときだけ書き、消すのも自分の字のときだけ)。
 */
import type { EntryMeta } from '@core/model/entry-meta';
import { titleNoteIndex } from '@features/schedule/today-note';

export const TITLE_LINK_MISSING_HINT = 'まだ無いノートです(押すと作る案内が出ます)';
const ATTR = 'data-pkc-link-missing';


export function applyTitleLinks(host: ParentNode, metas: Iterable<EntryMeta>): void {
  const links = host.querySelectorAll<HTMLElement>('.pkc-title-link[data-pkc-title]');
  if (links.length === 0) return;
  // 🔑 「ある」の規則は `findTodayNote`(押したときに開くノートを選ぶ関数)と同じ 1 本 ── `titleNoteIndex`
  const titles = titleNoteIndex(metas);
  for (const el of links) {
    const missing = !titles.has(el.getAttribute('data-pkc-title') ?? '');
    if (missing) {
      if (!el.hasAttribute(ATTR)) el.setAttribute(ATTR, '');
      const cur = el.getAttribute('title');
      if (cur === null || cur.trim() === '') el.setAttribute('title', TITLE_LINK_MISSING_HINT);
    } else if (el.hasAttribute(ATTR)) {
      el.removeAttribute(ATTR);
      if (el.getAttribute('title') === TITLE_LINK_MISSING_HINT) el.removeAttribute('title');
    }
  }
}
