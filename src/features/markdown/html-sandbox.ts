/**
 * reform-2026-05 Phase 2 PR-2M(2026-05-10):HTML sandbox iframe builder。
 *
 * ` ```html-render` fence info string で発火、content を iframe sandbox 経由
 * で seamless 描画する。AI が「複雑 layout / SVG / interactive widget は HTML
 * 生成の方が優れる」と主張する分野(2026-05-10 user 報告:A4 2 段組レポート
 * style 含む)に対応する。
 *
 * セキュリティ設計(critical):
 *
 * 1. **iframe sandbox 属性**:`sandbox="allow-scripts"` のみ。`allow-same-origin`
 *    は付けない → cross-origin 隔離、parent の localStorage / cookie / IndexedDB
 *    にアクセス不可、container body にも触れない。
 *
 * 2. **CSP meta**:srcdoc 内に `<meta http-equiv="Content-Security-Policy">` を
 *    自動注入。外部 fetch 禁止(`connect-src 'none'`)、外部 script src 禁止
 *    (`script-src 'unsafe-inline'` のみ)、`frame-src 'none'` で再帰 iframe 禁止。
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
): string {
  // iframe ID:DOM 内 unique(postMessage で iframe を特定)。Math.random で
  // 衝突確率は無視可能(同 doc 内 10K iframe で衝突 ~0.05%)。
  const iframeId = `pkc-html-render-${Math.random().toString(36).slice(2, 10)}`;

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
 * Parent-side resizer:postMessage で iframe height を受信、対応 iframe の
 * style.height を更新する。main.ts / rendered-viewer.ts の両方で wire する。
 *
 * @param targetWindow listener を登録する window(default: globalThis.window)
 * @returns teardown function(listener を unregister)
 */
export function installHtmlSandboxResizer(
  targetWindow: Window = window,
): () => void {
  const handler = (event: MessageEvent) => {
    const data = event.data;
    if (!data || typeof data !== 'object') return;
    if (data.type !== HTML_SANDBOX_RESIZE_MSG_TYPE) return;
    if (typeof data.id !== 'string') return;
    if (typeof data.height !== 'number') return;
    const height = Math.max(0, Math.min(HTML_SANDBOX_MAX_HEIGHT, data.height));
    const iframe = targetWindow.document.querySelector<HTMLIFrameElement>(
      `iframe[data-pkc-html-render-id="${CSS.escape(data.id)}"]`,
    );
    if (!iframe) return;
    iframe.style.height = `${height}px`;
  };
  targetWindow.addEventListener('message', handler);
  return () => {
    targetWindow.removeEventListener('message', handler);
  };
}
