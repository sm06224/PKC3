/**
 * 🔴 **システムの画面で、設定を語で絞る**(#1966 3-1)。
 *
 * 設定は 40 ほどの節が縦に長く並ぶ ── 目次で節へは飛べるが、「文字の大きさはどこ」のように**項目の名前で**探す道が無かった。
 *
 * ## 何を単位に絞るか
 * - **設定 1 行**(`dl` の `dt` と、それに続く `dd` の組)── 名前と説明の字に語が全部入っていれば残す
 * - **見出し**(`h3` / `h4`)が語に当たったら、その節の中は全部残す(「表示」と打てば表示の節が丸ごと出る)
 * - `dl` を持たない節(ショートカットキーの表・お知らせの一覧など)は、節の字全体を 1 つとして見る
 * - 残る物が 1 つも無い節は、見出しごと隠す
 *
 * ⚠ 隠すのは**専用の印**(`data-pkc-settings-filtered`)で、`hidden` は触らない ── 各節が `sync` で自分の都合の
 *   `hidden` を付け外ししている(未読の行・許可の行など)。絞り込みが `hidden` を書くと、語を消したときに
 *   節が隠していた物まで出てしまう。
 */
import { matchesSettingsQuery, settingsQueryWords } from '@features/settings/settings-query';

/** 絞り込みで隠した物に付ける印(CSS が `display: none` にする)。 */
export const SETTINGS_FILTERED_ATTR = 'data-pkc-settings-filtered';

/** この要素を含む節の見出しの字(外側から内側へ)。 */
function headingTrail(el: Element, root: Element): string {
  const parts: string[] = [];
  let cur: Element | null = el;
  while (cur !== null && cur !== root) {
    if (cur.tagName === 'SECTION') {
      const h = cur.querySelector(':scope > h3, :scope > h4, :scope > [data-pkc-field="settings-heading-row"] > h3');
      if (h !== null) parts.unshift(h.textContent ?? '');
    }
    cur = cur.parentElement;
  }
  return parts.join(' ');
}

/**
 * 探す対象の字。⚠ **ボタンの字は入れない**(着地前レビュー ⚠3)── ショートカットキーの行は全部「キーを割り当てる」
 *   「割り当てを既定に戻す」を持つので、ボタンの字まで見ると「割り当て」で約 60 行が当たる。
 * 🔑 選択肢(`option`)の字は入れる ── 「ダーク」で配色の行に届く。
 */
function searchText(el: Element): string {
  if (el.querySelector('button') === null) return el.textContent ?? '';
  const copy = el.cloneNode(true) as Element;
  for (const b of Array.from(copy.querySelectorAll('button'))) b.remove();
  return copy.textContent ?? '';
}

/** 節が自分の都合で隠している物か(`hidden`)。⚠ 当たりにも件数にも数えない(見えない物を「1 件」と言わない)。 */
function ownHidden(el: Element): boolean {
  return el instanceof HTMLElement && el.hidden === true;
}

/** `dl` の中の「名前と説明」の組(`dt` と、次の `dt` までの `dd`)。 */
function pairsOf(dl: Element): Element[][] {
  const out: Element[][] = [];
  for (const child of Array.from(dl.children)) {
    if (child.tagName === 'DT' || out.length === 0) out.push([child]);
    else out[out.length - 1]!.push(child);
  }
  return out;
}

/**
 * 語で絞る。⚠ 毎回、前の印を全部外してから付け直す(語を消せば元どおり)。
 * @returns 当たった設定の数(語が空なら `null` = 絞っていない)
 */
export function applySettingsFilter(body: HTMLElement, query: string): number | null {
  for (const el of Array.from(body.querySelectorAll(`[${SETTINGS_FILTERED_ATTR}]`)))
    el.removeAttribute(SETTINGS_FILTERED_ATTR);
  const words = settingsQueryWords(query);
  if (words.length === 0) return null;

  let hits = 0;
  // ① 設定 1 行ずつ(見出しに当たっていれば、その節の行は全部残す)
  for (const dl of Array.from(body.querySelectorAll('dl'))) {
    /**
     * 🔴 **見出しと行の字を 1 つにして判定する**(着地前レビュー 🔴1)── 「表示 配色」のように節の名前と項目の名前を
     *   混ぜて打っても当たる(見出しだけ・行だけで別々に全語を求めると、語が分かれたとき両方外れる)。
     */
    const trail = headingTrail(dl, body);
    for (const pair of pairsOf(dl)) {
      if (ownHidden(pair[0]!)) continue;
      const text = pair.map(searchText).join(' ');
      if (matchesSettingsQuery(`${trail} ${text}`, words)) hits += 1;
      else for (const e of pair) e.setAttribute(SETTINGS_FILTERED_ATTR, '');
    }
  }
  // ② `dl` を持たない一番内側の節は、節の字全体を 1 つとして見る
  for (const sec of Array.from(body.querySelectorAll('section'))) {
    if (sec.querySelector('section, dl') !== null || ownHidden(sec)) continue;
    const text = `${headingTrail(sec, body)} ${searchText(sec)}`;
    if (matchesSettingsQuery(text, words)) hits += 1;
    else sec.setAttribute(SETTINGS_FILTERED_ATTR, '');
  }
  // ③ 残る行が 1 つも無い節は見出しごと隠す(内側から)
  const sections = Array.from(body.querySelectorAll('section')).reverse();
  for (const sec of sections) {
    if (sec.hasAttribute(SETTINGS_FILTERED_ATTR)) continue;
    const visibleRow = Array.from(sec.querySelectorAll('dt')).some(
      (dt) => !ownHidden(dt) && !dt.hasAttribute(SETTINGS_FILTERED_ATTR),
    );
    const visibleLeaf = Array.from(sec.querySelectorAll('section')).some(
      (s) => s.querySelector('section, dl') === null && !ownHidden(s) && !s.hasAttribute(SETTINGS_FILTERED_ATTR),
    );
    const isLeaf = sec.querySelector('section, dl') === null;
    if (!isLeaf && !visibleRow && !visibleLeaf) sec.setAttribute(SETTINGS_FILTERED_ATTR, '');
  }
  // ④ 節の外に直に置かれた物(先頭のメッセージなど)は、字全体で見る
  for (const child of Array.from(body.children)) {
    if (child.tagName === 'SECTION' || ownHidden(child)) continue;
    if (matchesSettingsQuery(searchText(child), words)) hits += 1;
    else child.setAttribute(SETTINGS_FILTERED_ATTR, '');
  }
  return hits;
}
