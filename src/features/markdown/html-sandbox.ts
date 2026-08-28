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
 *    かつて `img-src * data: blob:` を無条件で許していたので **`new Image().src` で
 *    任意の第三者へ要求が飛んだ**(= 「この user がこれを今読んだ」+ IP が漏れる)。
 *    直す前のこのコメントは img を見落としていた。
 *    ✅ **既定で塞ぐようにした**(2026-08-06、user 裁定)── `img-src` は
 *    `allowExternalImages` で決まり、既定は `data: blob:` のみ。設定と同意の
 *    意味論は `features/markdown/external-images.ts` に 1 か所で置いてある。
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

import {
  HTML_SANDBOX_BLOCKED_MSG_TYPE,
  imgSrcDirective,
} from './external-images';

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
  /**
   * 外部の画像を読み込ませてよいか(2026-08-06、user 裁定)。
   * ⚠ **既定は false**(塞ぐ側)── 呼び側が渡し忘れたときに漏れるのは、
   * 画面に何も出ないので**永久に露見しない**種類の欠陥である。逆側の
   * 渡し忘れ(塞がる)は user に見える。
   */
  allowExternalImages: boolean = false,
): string {
  // iframe ID:DOM 内 unique(postMessage で iframe を特定)。
  // 🔴 **中身から決める**(乱数にしない ── P8 段⑩ で判明)。かつて
  // `Math.random()` だったため、**同じ入力でも毎回ちがう HTML** になり、
  // 差分反映から見ると「毎回変わった」ことになって、この塊が毎回作り直されていた
  // (= iframe が毎回読み直され、中身が一度消える)。
  const iframeId = `pkc-html-render-${stableKey(content, String(occurrence))}`;

  // CSP:default-src は self + data:、script は inline only(外部 src 禁止)、
  // connect は none(fetch 禁止)、frame は none(再帰 iframe 禁止)。
  // 🔴 **`img-src` だけが可変**(2026-08-06)── ここが唯一「外へ出られる」穴で、
  //    開けるかどうかは user の設定と同意で決まる(`external-images.ts`)。
  const cspContent =
    "default-src 'self' data: blob:; " +
    `img-src ${imgSrcDirective(allowExternalImages)}; ` +
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

  /**
   * 🔴 **止めた画像の件数を親へ申告する**(2026-08-06)。
   *
   * 箱の中身は script なので「外部画像を出すか」は描く前には判らない ── 実際に
   * CSP が止めた瞬間だけが確かな材料である。これが無いと「常に確認」で箱の画像を
   * **同意する手段が無い**(帯が出ない)。
   * ⚠ 件数だけ送る(止められた URL は本文の秘密を含む)。
   * ⚠ 1 枚ごとに送らない ── 100 枚の箱で 100 通飛ぶ。まとめて 1 通。
   *
   * 🔴 **見張りは `<head>` に置く ── user の中身より前に登録しなければならない**
   * (2026-08-07。CI が 3 回に 1 回赤くなって判明)。かつては下の resize script と
   * 一緒に **body の末尾**、つまり `content` の**後ろ**に置いていた。
   * `<script>new Image().src='https://…'</script>` のように**解析中に**画像を
   * 要求する中身では、違反がこの listener の登録より**先**に起きうる ──
   * 起きる順は実装依存なので、**同じ入力で出たり出なかったりする**。
   * 実測: `chromium_headless_shell` で 3 回に 1 回、帯が出なかった。
   * ⚠ これは test の flake ではなく**製品の穴**である ── 帯が出なければ、
   *   その箱の画像は**二度と同意できない**。
   * ⚠ CSP の `<meta>` より**後**に置く(前に置くと方針が効く前に script が走る)。
   */
  /**
   * 🔴 **画像以外も数える**(#528 段③。2026-08-28)。
   *
   * ⚠ 直す前、この見張りは **`img-src` の違反だけを数えて残りを捨てて**いた ──
   *   外部の JavaScript / CSS / `fetch` が止まっても**どこにも 1 行も出ない**。
   *   CDN を前提にした中身は**真っ白になって、理由が画面のどこにも無い**。
   * 🔑 直すのは「動くようにする」ことではない ── **止めたことを言う**だけである
   *   (門は 1 つも開けない)。
   * ⚠ **URL は運ばない**(本文の秘密を含む)── 運ぶのは**種別と件数**だけ。
   * ⚠ 種別の綴りは箱の中で畳まない ── 親側の `sandboxBlockedKind` が
   *   1 か所で決める(§7)。ここは**生の項目名**をそのまま渡す。
   */
  const violationScript =
    '<script>(function(){' +
    'var id=' + JSON.stringify(iframeId) + ';' +
    'var blocked=0,timer=0,kinds={};' +
    "document.addEventListener('securitypolicyviolation',function(ev){" +
    "var d=String(ev.effectiveDirective||ev.violatedDirective||'');" +
    "if(d.indexOf('img-src')===0)blocked++;else kinds[d]=1;" +
    'if(timer)return;timer=setTimeout(function(){timer=0;' +
    "try{window.parent.postMessage({type:'" + HTML_SANDBOX_BLOCKED_MSG_TYPE +
    "',id:id,blocked:blocked,kinds:Object.keys(kinds)},'*');}catch(e){}},50);});" +
    '})();</script>';

  // 完全 HTML doc(content を body に入れる)。`<!DOCTYPE>` は付けず simple HTML
  // (markdown user は body fragment を書く想定、`<html>` 等は wrapper で補完)。
  const fullDoc =
    '<!DOCTYPE html><html><head>' +
    '<meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta http-equiv="Content-Security-Policy" content="' +
    cspContent.replace(/"/g, '&quot;') + '">' +
    // ⚠ **content より前**(上の violationScript の注記を読むこと)
    violationScript +
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

/**
 * 箱が「外部画像を CSP で止めた」と申告してきたのを受ける(2026-08-06)。
 *
 * ⚠ **宛先の決め方は resize と同じ**(`resolveSandboxSender`)── 名乗った id では
 * なく**実際の送り主**で引く。ここを緩めると、箱 A が箱 B の名を騙って
 * 「B で画像が止まった」と言えてしまい、user は**在りもしない画像**の同意を
 * 求められる(そして同意すると A の画像が読める)。
 *
 * @param onBlocked 止まった箱・**画像の**件数・**画像以外の種別**(CSP の生の項目名)。
 * ⚠ 同じ箱から**何度も来る**(件数は累計)
 * @returns teardown function
 */
export function installHtmlSandboxBlockedReporter(
  onBlocked: (iframe: HTMLIFrameElement, blocked: number, kinds: readonly string[]) => void,
  targetWindow: Window = window,
): () => void {
  const handler = (event: MessageEvent) => {
    const data = event.data;
    if (!data || typeof data !== 'object') return;
    if (data.type !== HTML_SANDBOX_BLOCKED_MSG_TYPE) return;
    if (typeof data.id !== 'string') return;
    if (typeof data.blocked !== 'number') return;
    /**
     * ⚠ **画像 0 件でも受ける**(#528 段③)── 外部の script だけ止まった箱は
     *   `blocked === 0` で来る。1 稿目はここで `> 0` を要求していたので、
     *   **画像が絡まない箱の申告を丸ごと捨てて**いた。
     */
    const kinds = Array.isArray(data.kinds)
      ? data.kinds.filter((k: unknown): k is string => typeof k === 'string')
      : [];
    if (data.blocked <= 0 && kinds.length === 0) return;
    const iframe = resolveSandboxSender(targetWindow.document, event.source, data.id);
    if (!iframe) return;
    onBlocked(iframe, data.blocked, kinds);
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
