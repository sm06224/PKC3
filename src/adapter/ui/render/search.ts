/**
 * 🔴 **探す面**(#680。user 要望「検索専用の組み込みアプリ」/ 裁定 2026-09-04
 * 「アプリの基本は別窓」)。
 *
 * ## 左の列の欄と何が違うか
 *
 * | | 左の列の欄(`entry-filter`) | この面 |
 * |---|---|---|
 * | 仕事 | **一覧を絞る**(並びは変えない) | **見つける**(関連度順に並べ直す) |
 * | 見えるもの | 行(題名) | 題名 + **本文の抜粋**(当たった語に印) |
 * | 押すと | そのノートを中央に開く | そのノートを**小窓**で開く(いま読んでいる本文は退かさない) |
 * | 語 | `filterQuery` | `searchPage.query`(**別**── 面の語で本体の一覧を絞らない) |
 * | worker を叩く | 打鍵ごと | **300ms 止まってから**(effect が待つ) |
 *
 * ⚠ **この描画器は 1 つの器(中央の面)にしか居ない** ── 左の列に同じ面は無いので、
 *   `data-pkc-region` を焼いても衝突しないが、予定 / 連絡先と揃えて焼かない
 *   (器の印 `data-pkc-view-pane='search'` で足りる)。
 * ⚠ 抜粋は **`textContent` で入れ、当たった所だけ `<mark>` を組む** ── worker から来た
 *   字を HTML として注入しない。印の綴りは `features/filter/search-snippet.ts` の 1 か所。
 */
import type { AppState, SearchPageState } from '@adapter/state/app-state';
import { splitSnippet } from '@features/filter/search-snippet';

export class SearchRenderer {
  private readonly host: HTMLElement;
  /** 直前に描いた指紋。⚠ 同じなら触らない(押している最中に行を作り直さない)。 */
  private last = ' ';
  /** 打つ欄。⚠ 1 度だけ組む ── 一覧の描き直しで作り直さない(打ちかけを失わせない)。 */
  private input: HTMLInputElement | null = null;
  private note: HTMLElement | null = null;
  /** 一覧を描き直す器(`contacts.ts` の `body` と同じ作法)。 */
  private body: HTMLElement | null = null;
  /**
   * 🔴 **開いた最初の 1 回だけ欄へ焦点を入れる** ── この面は「語を打つため」に開く
   *   (別窓のディープリンクで立ち上がった user が最初にすることは打鍵である)。
   * ⚠ 2 回目以降は入れない ── 結果が届くたびに焦点を奪うと、行を押そうとした指が外れる。
   */
  private focused = false;

  constructor(host: HTMLElement) {
    this.host = host;
  }

  private ensureFrame(): HTMLElement {
    if (this.body !== null) return this.body;
    const head = document.createElement('div');
    head.setAttribute('data-pkc-field', 'search-page-head');
    const title = document.createElement('h2');
    title.setAttribute('data-pkc-field', 'pane-title');
    title.textContent = '探す';
    const input = document.createElement('input');
    input.type = 'search';
    input.setAttribute('data-pkc-field', 'search-page-input');
    input.placeholder = '題名と本文から探す';
    input.setAttribute('aria-label', '探す語(題名と本文)');
    // ⚠ ブラウザの補完を切る ── 打った語の履歴が欄の下に被さり、結果の行を隠す
    input.autocomplete = 'off';
    head.append(title, input);
    const note = document.createElement('p');
    note.setAttribute('data-pkc-field', 'search-page-note');
    const body = document.createElement('div');
    body.setAttribute('data-pkc-field', 'search-page-body');
    this.host.append(head, note, body);
    this.input = input;
    this.note = note;
    this.body = body;
    return body;
  }

  render(state: AppState): void {
    const body = this.ensureFrame();
    const page = state.searchPage;
    /**
     * ⚠ 欄の字は state が正(renderer は DOM から読まない)。ただし**同じなら触らない**
     *   ── `value` への代入は caret を末尾へ飛ばすので、打っている最中に書き戻さない。
     */
    if (this.input !== null && this.input.value !== page.query) this.input.value = page.query;
    if (!this.focused && !this.host.hidden) {
      this.focused = true;
      this.input?.focus();
    }
    const print = [
      page.query,
      page.rowsQuery,
      page.truncated ? 't' : '',
      page.failed ? 'f' : '',
      page.rows.map((r) => `${r.lid}|${r.title}|${r.snippet}`).join('\u0001'),
    ].join('\u0002');
    if (print === this.last) return;
    this.last = print;

    if (this.note !== null) this.note.textContent = this.noteText(page);
    body.textContent = '';
    if (page.rows.length === 0) return;
    const list = document.createElement('ul');
    list.setAttribute('data-pkc-field', 'search-page-list');
    for (const row of page.rows) {
      const li = document.createElement('li');
      li.setAttribute('data-pkc-search-row', row.lid);
      /**
       * 🔑 行は**小窓で開く**(#685 の `open-note-window` を通す ── 開く口を増やさない)。
       *   受け手は `data-pkc-entry` から lid を読むので、ボタン自身に持たせる。
       * ⚠ 「本体で開く」の合図は作っていない ── 窓をまたいで選択を運ぶ仕掛けは
       *   まだ無い(`note-window-registry.ts` の `raise` は焦点だけ)。
       */
      const open = document.createElement('button');
      open.type = 'button';
      open.setAttribute('data-pkc-action', 'open-note-window');
      open.setAttribute('data-pkc-entry', row.lid);
      open.setAttribute('data-pkc-field', 'search-row');
      open.title = 'このノートを別のウィンドウ(小窓)で開きます。いま読んでいる本文はそのままです';
      const title = document.createElement('span');
      title.setAttribute('data-pkc-field', 'search-row-title');
      title.textContent = row.title === '' ? '(題名なし)' : row.title;
      const snippet = document.createElement('span');
      snippet.setAttribute('data-pkc-field', 'search-row-snippet');
      // 🔴 **`textContent` で入れる** ── worker から来た字を HTML にしない。印の所だけ `<mark>`
      for (const part of splitSnippet(row.snippet)) {
        if (part.hit) {
          const mark = document.createElement('mark');
          mark.textContent = part.text;
          snippet.append(mark);
        } else {
          snippet.append(document.createTextNode(part.text));
        }
      }
      open.append(title, snippet);
      li.append(open);
      list.append(li);
    }
    body.append(list);
  }

  /**
   * 欄の下の 1 行。⚠ **「まだ」と「駄目だった」と「0 件」を区別する** ── 区別しないと
   * 「探しています…」で永久に止まるか、失敗が「無い」に見える。
   * ⚠ **切ったことは必ず言う**(左の列の「ほかにもあります」と同じ向き)。
   */
  private noteText(page: SearchPageState): string {
    if (page.query.trim() === '') return '語を打つと、題名と本文から探します。行を押すと、そのノートが別のウィンドウで開きます';
    if (page.failed) return 'この版では探せません(ページを読み直すと直ることがあります)';
    if (page.rowsQuery !== page.query) return '探しています…';
    if (page.rows.length === 0) return `「${page.query}」に当たるノートはありません`;
    if (page.truncated)
      return `200 件より多く当たりました(関連の高い 200 件を出しています)。語を足して絞ってください`;
    return `${page.rows.length} 件(関連の高い順)`;
  }
}
