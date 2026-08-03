/**
 * ランチャーの「アプリ」タイルを**隔離して**開くための外殻(P7b 段⑩ 修正)。
 *
 * 🔴 **これは事故の修理である**。段⑩ の初版は取り込んだ HTML 添付の Blob を
 * そのまま `window.open` していた ── blob: URL は**生成したページの origin を
 * 継ぐ**ので、添付の中の script が**アプリ本体と同じ origin** で動いていた。
 * 実測(smoke で計測):
 *
 * ```
 * {"origin":"http://localhost:45732","ls":2,"idb":"pkc3-assets","opfs":".pkc3"}
 * ```
 *
 * つまり `localStorage` に書け、**IndexedDB(`pkc3-assets` = 添付の実体)**と
 * **OPFS(`.pkc3` = SQLite 本体)**を列挙できていた。取り込んだ他人の HTML が
 * ノート全体を読めるということで、これは通してはいけない。
 *
 * 🔑 **既にこのリポジトリには答えがある** ── `features/markdown/html-sandbox.ts`
 * が「`allow-same-origin` を**付けない**」という明文化された設計を持っている。
 * ランチャーだけがそれを迂回していた。同じ規律に載せる:
 *
 * 1. 開くのは**この外殻**(信頼できる自前の HTML)。添付そのものは開かない
 * 2. 添付は `<iframe sandbox="allow-scripts …">` の `srcdoc` に入れる ──
 *    `allow-same-origin` が無いので **opaque origin** になり、
 *    `localStorage` / `indexedDB` / OPFS のどれにも到達できない
 * 3. 外殻は `message` を**聴かない**。iframe から parent へ話しかけられても
 *    受け口が無い(html-sandbox の resize protocol は持ち込まない ──
 *    アプリは画面いっぱいに置くので高さを教えてもらう必要が無い)
 *
 * ⚠ **`allow-popups` を付けても sandbox は外れない** ── 開いた先の window は
 * 同じ sandbox flag を継ぐ(`allow-popups-to-escape-sandbox` を**付けない**限り)。
 * ⚠ **pure module**。browser API を使わない(文字列を組むだけ)。
 */

/**
 * 添付に許す権限。**`allow-same-origin` は絶対に入れない**
 * ── 入れた瞬間に opaque origin ではなくなり、上の実測の穴が開く。
 *
 * 付けてあるものはどれも「アプリとして成り立つための最低限」で、
 * origin を渡すものは 1 つも無い:
 * - `allow-scripts` … 動かないとアプリではない
 * - `allow-forms` … 入力して送る形の道具が動かない
 * - `allow-modals` … `alert` / `confirm` を潰すと黙って壊れて見える
 * - `allow-popups` … 中のリンクを新しいタブで開ける(sandbox は継がれる)
 * - `allow-downloads` … 生成したファイルを保存できる
 */
export const LAUNCHER_APP_SANDBOX =
  'allow-scripts allow-forms allow-modals allow-popups allow-downloads';

/**
 * `srcdoc` 属性に入れるための escape。
 *
 * ⚠ `&` を**最初に**置き換える(後にすると自分が作った `&lt;` を壊す)。
 * ⚠ `<` `>` も escape してよい ── 属性値は parse 時に実体参照が解決されるので、
 * iframe には元の HTML が渡る(html-sandbox と同じ考え方)。
 */
export function escapeForSrcdoc(html: string): string {
  return html
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** テキストノード用(題名)。属性には使わない。 */
function escapeText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 属性値用。 */
function escapeAttr(text: string): string {
  return escapeText(text).replace(/"/g, '&quot;');
}

/**
 * 外殻 HTML を組む。`html` は添付の中身(**信頼しない**)。
 *
 * ⚠ 返り値は `text/html` の Blob にして `window.open` する想定。
 * 外殻自体はアプリ origin で動くが、**中身は入っていない**
 * (script も何も持たない静的な器)。
 */
export function buildLauncherAppShell(title: string, html: string): string {
  const t = escapeAttr(title);
  return (
    '<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    `<title>${escapeText(title)}</title>` +
    '<style>html,body{margin:0;padding:0;height:100%;overflow:hidden;background:#1b1d21}' +
    'iframe{display:block;border:0;width:100%;height:100%}</style>' +
    '</head><body>' +
    `<iframe sandbox="${LAUNCHER_APP_SANDBOX}" referrerpolicy="no-referrer"` +
    ` data-pkc-field="launcher-app" title="${t}"` +
    ` srcdoc="${escapeForSrcdoc(html)}"></iframe>` +
    '</body></html>'
  );
}
