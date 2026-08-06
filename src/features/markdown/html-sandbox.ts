/**
 * HTML を「箱」(sandbox iframe)として描く。
 *
 * ` ```html` fence で発火し、中身を iframe の `srcdoc` として隔離して描く。
 * AI が吐く複雑 layout / SVG / interactive widget を受けるための面である。
 *
 * ⚠ **この file のヘッダは PKC2 の履歴のままだった**(2026-08-06 に是正)。
 * 「reform-2026-05 Phase 2 PR-2M」という PKC2 の PR 番号を名乗り、
 * `installHtmlSandboxResizer` の doc は「main.ts / **rendered-viewer.ts** の両方で
 * wire する」と指示していたが、**PKC3 に `rendered-viewer.ts` は存在しない**
 * (実配線は `src/main.ts` の 1 か所だけ)。user 指示「流用 + 総合的見直し。
 * **丸写し禁止**」に照らして、PKC3 の根拠に書き換えた。
 *
 * セキュリティ設計(critical):
 *
 * 1. **iframe sandbox 属性**:`sandbox="allow-scripts"` のみ。`allow-same-origin`
 *    は付けない → cross-origin 隔離、parent の localStorage / cookie / IndexedDB
 *    にアクセス不可、container body にも触れない。
 *
 * 2. **CSP meta**:srcdoc 内に `<meta http-equiv="Content-Security-Policy">` を
 *    自動注入。`connect-src 'none'` で fetch / XHR / WebSocket を止め、
 *    外部 script src 禁止(`script-src 'unsafe-inline'` のみ)、
 *    `frame-src 'none'` で再帰 iframe 禁止。
 *    🔴 **「外部 fetch 禁止」は「外へ出られない」ではない**(2026-08-06 に是正)──
 *    `img-src * data: blob:` を許しているので **`new Image().src` で任意の第三者へ
 *    要求が飛ぶ**(= 「この user がこれを今読んだ」+ IP が漏れる)。直す前の
 *    このコメントは img を見落としていた。締める判断は方向 doc §2 Q3 の付帯裁定待ち
 *    (出力 HTML が変わり goldens が 1 度動くため)。
 *
 * 3. **referrerpolicy="no-referrer"**:iframe 内から外部 URL に飛ぶ時の referrer
 *    漏洩防止。
 *
 * 4. **height auto-resize cap**:iframe 内から postMessage で height を通知、
 *    parent は最大 5000px で cap(無限スクロール abuse 防止)。
 *
 * 5. **referrerpolicy / loading="lazy"**:scroll 外 iframe は遅延 load。
 *
 * メッセージ protocol:
 *   { type: 'pkc-html-render-resize', id: '<iframeId>', height: <px> }
 *   parent は document.querySelector(`[data-pkc-html-render-id="<id>"]`) で
 *   iframe を見つけて style.height = min(height, 5000) + 'px' を set。
 */

/** iframe 高さ cap(無限スクロール abuse 防止)。 */
export const HTML_SANDBOX_MAX_HEIGHT = 5000;

/** postMessage protocol type(parent/child 両方で使う)。 */
export const HTML_SANDBOX_RESIZE_MSG_TYPE = 'pkc-html-render-resize';

/**
 * `<iframe sandbox>` 要素 HTML を生成。content は raw HTML(エスケープなし、
 * sandbox 隔離されているので XSS risk 無し)。
 *
 * @param content user の `html-render` fence 内 HTML
 * @param sourceLineAttrs split view sync 用 `data-pkc-source-line-*` 文字列
 * @returns `<iframe ... srcdoc="...">` を含む div ラッパー HTML
 */
export function buildHtmlSandboxIframe(
  content: string,
  sourceLineAttrs: string = '',
  /**
   * **同じ中身の fence の中で何番目か**(0 始まり)。同じ中身を区別するために要る。
   * ⚠ **token 添字を渡してはいけない**(2026-08-05)── 前に行を足すだけで id が
   * 変わり、差分反映がこの塊を作り直して **iframe が読み直され中身が一度消える**。
   * 数えるのは `markdown-render.ts` の `nextFenceOccurrence`。
   */
  occurrence: number = 0,
): string {
  // iframe ID:DOM 内 unique(postMessage で iframe を特定)。
  // 🔴 **中身から決める**(乱数にしない ── P8 段⑩ で判明)。かつて
  // `Math.random()` だったため、**同じ入力でも毎回ちがう HTML** になり、
  // 差分反映から見ると「毎回変わった」ことになって、この塊が毎回作り直されていた
  // (= iframe が毎回読み直され、中身が一度消える)。
  const iframeId = `pkc-html-render-${stableKey(content, String(occurrence))}`;

  // CSP:default-src は self + data:、image は asset URI 想定で *、script は
  // inline only(外部 src 禁止)、connect は none(fetch 禁止)、frame は none
  // (再帰 iframe 禁止)。
  const cspContent =
    "default-src 'self' data: blob:; " +
    "img-src * data: blob:; " +
    "style-src 'self' 'unsafe-inline'; " +
    "script-src 'unsafe-inline'; " +
    "connect-src 'none'; " +
    "frame-src 'none'; " +
    "object-src 'none'; " +
    "base-uri 'none'";

  // 自動 resize スクリプト(iframe 内から parent に height 通知)。
  // ResizeObserver で body の size 変化を watch、postMessage で通知。
  const resizeScript =
    '<script>(function(){' +
    'var id=' + JSON.stringify(iframeId) + ';' +
    'function post(){' +
    'var h=Math.min(' + HTML_SANDBOX_MAX_HEIGHT + ',Math.max(' +
    'document.documentElement.scrollHeight,document.body.scrollHeight));' +
    "try{window.parent.postMessage({type:'" + HTML_SANDBOX_RESIZE_MSG_TYPE +
    "',id:id,height:h},'*');}catch(e){}}" +
    'if(window.ResizeObserver){' +
    'var ro=new ResizeObserver(post);' +
    'if(document.body)ro.observe(document.body);' +
    '}' +
    "window.addEventListener('load',post);" +
    'setTimeout(post,100);setTimeout(post,500);' +
    '})();</script>';

  // 完全 HTML doc(content を body に入れる)。`<!DOCTYPE>` は付けず simple HTML
  // (markdown user は body fragment を書く想定、`<html>` 等は wrapper で補完)。
  const fullDoc =
    '<!DOCTYPE html><html><head>' +
    '<meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta http-equiv="Content-Security-Policy" content="' +
    cspContent.replace(/"/g, '&quot;') + '">' +
    '<style>' +
    'body{margin:0;padding:0.5rem;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Hiragino Kaku Gothic ProN","Yu Gothic",sans-serif;line-height:1.5;color:#222;}' +
    '*{box-sizing:border-box;}' +
    'img,svg,video,canvas{max-width:100%;height:auto;}' +
    '</style>' +
    '</head><body>' + content + resizeScript +
    '</body></html>';

  // srcdoc attribute は HTML escape(&, ", <, > → entities)。
  // entities は attribute parsing 時に解決されて iframe には raw HTML が
  // 渡されるので、< / > escape しても render に影響なし。改行は保持。
  const srcdoc = fullDoc
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  return (
    `<iframe class="pkc-html-render" ` +
    `data-pkc-html-render-id="${iframeId}" ` +
    `sandbox="allow-scripts" ` +
    `referrerpolicy="no-referrer" ` +
    `loading="lazy" ` +
    `style="width:100%;border:0;height:0;display:block;" ` +
    `title="HTML sandbox render"${sourceLineAttrs} ` +
    `srcdoc="${srcdoc}"></iframe>`
  );
}

/**
 * 箱から届いた高さの申告を、**その箱にだけ**当てる。
 *
 * 🔴 **宛先は「名乗った id」ではなく「実際の送り主」で決める**(2026-08-06)。
 *
 * 直す前は `data.id` で `querySelector` していた。ところが id は中身の FNV-1a
 * (`stableKey`)なので **文書側から計算できる** ── つまり箱 A が、同じ文書の
 * 箱 B の id を名乗って **B の高さを 0px にできた**(= B の中身を隠せた)。
 * 高さの cap(5000px)は「大きすぎ」だけを守っており、**なりすまし**は素通りだった。
 *
 * 🔑 正しい規律は**同じ repo に実測付きで在る**(`src/features/launcher/app-shell.ts`
 * の「判定は `event.source === iframe.contentWindow` **だけ**にする /
 * `event.origin` は使わない ── sandbox の箱では両方向に嘘をつく」)。
 * ここはその規律の**移植**である。
 *
 * ⚠ **`event.origin` を条件に足さない**。`allow-same-origin` の無い箱の origin は
 *   `"null"` で、これは「安全な箱」も「攻撃者の箱」も同じ値になる ── 判定に使うと
 *   通してはいけないものを通し、通すべきものを落とす。
 * ⚠ **`data.id` は照合にしか使わない**(名乗りと実体が食い違ったら捨てる)。
 *   id を消さないのは、差分反映が箱を作り直さないための鍵として要るからである。
 *
 * @param targetWindow listener を登録する window(default: globalThis.window)
 * @returns teardown function(listener を unregister)
 */
export function installHtmlSandboxResizer(targetWindow: Window = window): () => void {
  const handler = (event: MessageEvent) => {
    const data = event.data;
    if (!data || typeof data !== 'object') return;
    if (data.type !== HTML_SANDBOX_RESIZE_MSG_TYPE) return;
    if (typeof data.id !== 'string') return;
    if (typeof data.height !== 'number') return;
    const iframe = resolveSandboxSender(targetWindow.document, event.source, data.id);
    if (!iframe) return;
    iframe.style.height = `${clampSandboxHeight(data.height)}px`;
  };
  targetWindow.addEventListener('message', handler);
  return () => {
    targetWindow.removeEventListener('message', handler);
  };
}

/** 高さの丸め(cap は「大きすぎ」だけを守る ── なりすましは送り主の同一性で守る)。 */
export function clampSandboxHeight(height: number): number {
  if (!Number.isFinite(height)) return 0;
  return Math.max(0, Math.min(HTML_SANDBOX_MAX_HEIGHT, height));
}

/**
 * 送り主の window から、その箱の `<iframe>` を引く。
 *
 * 🔑 **規則はここ 1 つ**(画面と書き出し HTML の両方がこの意味論に従う)。
 * ⚠ 名乗った id が実体と食い違ったら **null**(黙って別の箱へ当てない)。
 */
export function resolveSandboxSender(
  doc: Document,
  source: MessageEventSource | null,
  claimedId: string,
): HTMLIFrameElement | null {
  if (source === null) return null;
  const frames = doc.querySelectorAll<HTMLIFrameElement>('iframe[data-pkc-html-render-id]');
  for (const f of frames) {
    if (f.contentWindow !== source) continue;
    // ⚠ 実体が見つかったうえで、名乗りと一致することも確かめる
    return f.getAttribute('data-pkc-html-render-id') === claimedId ? f : null;
  }
  return null;
}

/**
 * 決定的な id。⚠ **乱数にしない** ── 差分反映が毎回この塊を作り直す。
 * 衝突しても壊れるのは resize の宛先だけなので、短い hash で十分。
 */
function stableKey(content: string, salt: string): string {
  let h = 0x811c9dc5;
  const text = content + '\u0000' + salt;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36).padStart(7, '0');
}
