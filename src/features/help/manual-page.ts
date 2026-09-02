/**
 * 🔴 **マニュアルを 1 枚の HTML(`manual.html`)として焼くための純粋部**(#645 段②)。
 *
 * ## なぜ「窓の中を opener が組む」(段①)だけでは足りないのか
 *
 * 段①の窓は `about:blank` を開いて opener 側から DOM を組む。実 URL を持たないので、
 * 2 つが**原理的に**できない(着地前の実地調査が拾った):
 *
 * | | `about:blank` の窓(段①) | **`manual.html`(この file)** |
 * |---|---|---|
 * | 再読み込み(F5) | 🔴 **白紙になる**(組んだ DOM は再読み込みで消える) | ✅ 同じ page が読み直される |
 * | 設定で選んだ配色 | 🔴 届かない(`--bg` 等の**テーマ 9 種**は BODY_CSS に無い) | ✅ `tokens.css` を丸ごと持ち、起動時に `localStorage` の配色を当てる |
 * | 目次 | `<button>` + `scrollIntoView`(`<a href="#…">` は base URL を引き継いで**アプリへ飛ぶ**) | ✅ 素の `<a href="#m-3">`(実 URL なので断片は**この page の中**で解決する) |
 * | オフライン | opener が生きていれば描ける | ✅ SW の precache に載る(build の生成物なので自動) |
 *
 * 🔑 **1 枚に焼く**のは build 時(`build/manual-page-plugin.ts`)。ここは
 *   「材料を受け取って HTML 文字列を返す」だけ ── browser API を使わない
 *   (build でも test でも同じ関数が走る)。
 *
 * ## ⚠ 段①の窓は**残す**(持ち歩ける 1 枚 = portable では `manual.html` が隣に無い)
 *
 * 器の見た目(`MANUAL_CHROME_CSS`)・帯の字・窓の題名は**この file が正本**で、
 * `adapter/platform/manual-window.ts` はここから import する ── 2 つの経路で
 * 見た目が静かにずれるのを防ぐ(CLAUDE.md §7「同じ値は 1 回だけ作って両方へ配る」)。
 *
 * ## 🔴 inline `<script>` は 1 本だけ、しかも配色を当てるだけ
 *
 * アプリ本体は CSP を持たない(`index.html` に meta 無し / SW は COI の 2 ヘッダのみ)ので
 * inline script は通る。だが**この page に振る舞いを持たせない** ── 持たせた瞬間、
 * 段①の窓(script 無し)と**同じ字の別物**が 2 つできる。配色の初期化は
 * 「最初の描画の前に属性を 1 つ立てる」ことでしか実現できないので、それだけを許す。
 */
import { buildManualDoc } from './manual-doc';
import type { ManualSection } from './manual-find';
import { TEXT_SCALES } from '../text-scale';

/** 焼く file の名前。⚠ `dist/` 直下(`index.html` の隣)。SW の precache に載る。 */
export const MANUAL_PAGE_FILE = 'manual.html';

/**
 * 窓の題名。⚠ **1 か所で持つ** ── タイルの字(`tiles.ts` の `manualTile`)と
 * 揃っているかは `tests/features/manual-doc.test.ts` が見る。
 */
export const MANUAL_WINDOW_TITLE = 'PKC3 マニュアル';

/**
 * 🔴 **どの版で組んだ窓か**(#645)。
 *
 * ⚠ **版で見分ける** ── 「組んであるか」だけで見ると、**アプリが新しくなっても
 *   古い本文の窓が前に出続ける**(user は直したはずのマニュアルを読み続ける)。
 * ⚠ 帯の字ではなく属性で持つ ── 文言を直した日に判定が壊れないようにする。
 * 🔑 焼いた page も**同じ属性を `<body>` に持つ** ── opener は `about:blank` の窓と
 *   焼いた page の窓を**同じ式**で見分ける(経路ごとに判定を増やさない)。
 */
export const MANUAL_BUILT_ATTR = 'data-pkc-manual-version';

/**
 * 🔴 **窓に刻む「どの版で組んだか」の印**(2026-09-02、着地前の動線レビュー D2 が拾った)。
 *
 * ⚠ 版の行(`versionText()`)だけでは足りない ── `/dev/` は merge のたびに新しくなるのに
 *   `APP_VERSION` は手書きのリテラル(`release-meta.ts`)なので、**版の字が 1 文字も
 *   変わらない**。「PKC3 を新しくしたら新しいマニュアルに入れ替わる」が `/dev/` では起きず、
 *   **古い本文の窓が前に出続ける**(段①が避けようとした当の形)。
 * 🔑 だから印は **版の行 + マニュアルの原文の hash** ── 原文が 1 字でも変われば別の印になり、
 *   次に押したとき入れ替わる。build 時(焼く側)と実行時(opener)が**同じ関数**で
 *   同じ材料から作るので、食い違いようがない。
 * ⚠ hash は FNV-1a 32bit ── 237 KB の原文で 1 ms 前後。暗号用ではない(衝突しても
 *   「入れ替わらない」だけで、データは壊れない)。
 */
export function manualBuildTag(version: string, text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${version} #${h.toString(16).padStart(8, '0')}`;
}

/** 帯に出す取り分の字(#636 で Ctrl+F を返した意味がここで効く)。 */
export const MANUAL_TIP = 'Ctrl+F(Mac は ⌘+F)で、ブラウザの検索がそのまま使えます';

/**
 * 本文の器の class。⚠ 本文の見た目は `.pkc-md-rendered` を起点にした規則が持つ。
 * ⚠ `tests/adapter/page-format-surfaces.test.ts` が「器を作る file」を全数で数える ──
 *   この綴りを template の中へ直書きすると、その走査から**見えなくなる**。
 */
const HOST_CLASS = 'pkc-md-rendered';

/**
 * 窓の器の見た目。⚠ 本文の見た目は `BODY_CSS`(app.css から抜いた正本)が持つ。
 *
 * 🔴 **地と字はトークンから取り、無ければ UA の色へ落ちる**(2026-08-31 / 09-02)。
 * ⚠ 段①の 1 稿目は `background: var(--bg, #fff)` と書いていたが、**`--bg` は
 *   `BODY_CSS` に入っていない**(実測: 変数 30 個のうち `--fg` / `--border` /
 *   `--surface-2` は在り、`--bg` は**無い**)── 地は常に `#fff` に固定される一方、
 *   字は `--fg` で環境に追従するので、**暗い環境では白地に白い字**になった。
 * 🔑 だから fallback は `Canvas` / `CanvasText`(`color-scheme` に従う UA の色)にする。
 *   焼いた page は `tokens.css` を丸ごと持つので `--bg` が**必ず在り**、選んだ配色が効く。
 *   `about:blank` の窓は `--bg` が無いので UA の色へ落ち、環境の明暗に従う。
 * ⚠ `:root{color-scheme:light dark}` は**テーマの `color-scheme`(属性つきの規則)に負ける**
 *   詳細度なので、焼いた page ではテーマの値が勝つ ── 意図どおり。
 */
export const MANUAL_CHROME_CSS = [
  ':root{color-scheme:light dark}',
  'html,body{margin:0;height:100%}',
  // 🔑 字の大きさは設定(`pkc3.text-scale`)が効く ── 選んでいなければ 14px のまま
  //    (2026-09-02、動線レビュー D3: 「特大」を選んだ user の窓だけ 14px に戻っていた)
  'body{display:grid;grid-template-rows:auto 1fr;font-family:system-ui,sans-serif;',
  'font-size:var(--pkc-text-size,14px);color:var(--fg,CanvasText);background:var(--bg,Canvas)}',
  // 帯 ── 題名と版だけ。⚠ 地は無彩色(不可侵指示)
  '[data-pkc-field="manual-window-head"]{display:flex;gap:12px;align-items:baseline;',
  'padding:8px 16px;border-bottom:1px solid var(--border,#8884)}',
  '[data-pkc-field="manual-window-head"] strong{font-size:15px}',
  '[data-pkc-field="manual-window-head"] span{opacity:.7;font-size:12px}',
  // 目次(左)と本文(右)
  '[data-pkc-region="manual-window-body"]{display:grid;grid-template-columns:280px 1fr;',
  'min-height:0}',
  '[data-pkc-region="manual-window-toc"]{overflow:auto;padding:12px 8px;',
  'border-right:1px solid var(--border,#8884);min-height:0}',
  // ⚠ 目次の行は 2 種在る ── 焼いた page は `<a>`、`about:blank` の窓は `<button>`。
  //    **同じ規則で描く**(どちらの経路でも同じ見え方)
  '[data-pkc-region="manual-window-toc"] :is(a,button){display:block;width:100%;',
  'box-sizing:border-box;text-align:left;padding:2px 6px;border:0;background:0;',
  'font:inherit;color:inherit;text-decoration:none;cursor:pointer;border-radius:3px;',
  'line-height:1.5}',
  '[data-pkc-region="manual-window-toc"] :is(a,button):hover{background:var(--surface-2,#8882)}',
  '[data-pkc-region="manual-window-toc"] :is(a,button):focus-visible{outline:2px solid currentColor}',
  // 🔑 段付けは `#` の数から(見出しの深さがそのまま読める)
  '[data-pkc-region="manual-window-toc"] [data-pkc-level="1"]{font-weight:700}',
  '[data-pkc-region="manual-window-toc"] [data-pkc-level="2"]{padding-left:14px}',
  '[data-pkc-region="manual-window-toc"] [data-pkc-level="3"]{padding-left:28px;opacity:.9}',
  '[data-pkc-region="manual-window-toc"] [data-pkc-level="4"]{padding-left:42px;opacity:.85}',
  '[data-pkc-region="manual-window-toc"] [data-pkc-level="5"]{padding-left:56px;opacity:.8}',
  '[data-pkc-region="manual-window-toc"] [data-pkc-level="6"]{padding-left:70px;opacity:.8}',
  // 🔴 **本文は窓いっぱい**(ヘルプ面の 60vh の箱がこの窓に来ないようにする)
  '[data-pkc-region="manual-window-main"]{overflow:auto;padding:16px 24px 64px;min-height:0}',
  /**
   * 🔴 **行を長くしすぎない**(着地前の設計レビューが拾った)。
   * ⚠ 窓を最大化すると、器いっぱい = **1 行が 2000px を超える**ことがある ──
   *   「大きく出す」ために開いた窓が、**かえって読みにくく**なる。
   * 🔑 上限は **76rem**(≒1216px)── 既定の窓(1100px から目次 280px を引いた
   *   820px)では**当たらない**ので、いまの見え方は 1 ドットも変わらない。
   *   効くのは「広げすぎたとき」だけである。
   * ⚠ 器そのものは器いっぱいのまま(送るのは器)── 中身の幅だけを抑える。
   */
  '[data-pkc-region="manual-window-main"] > *{max-width:76rem}',
  /**
   * 🔑 **飛んだ見出しが帯の下に隠れない** ── `scroll-margin-top` を置く。
   * ⚠ 置かないと、目次から飛んだとき見出しが**器の上端ぴったり**に来て、
   *   直前の段落と見分けにくい。
   */
  '[data-pkc-region="manual-window-main"] :is(h1,h2,h3,h4,h5,h6){scroll-margin-top:8px}',
  // 狭い窓では目次を上へ畳む(横に潰さない)
  '@media (max-width:760px){[data-pkc-region="manual-window-body"]{grid-template-columns:1fr;',
  'grid-template-rows:minmax(0,32vh) 1fr}',
  '[data-pkc-region="manual-window-toc"]{border-right:0;border-bottom:1px solid var(--border,#8884)}}',
  /**
   * 🔴 **紙に出すときは器をほどく**(2026-09-02、動線レビュー D6 が拾った)。
   * ⚠ 本文は `overflow:auto` のスクロール箱に居るので、そのまま Ctrl+P すると
   *   **見えている 1 頁ぶんしか出ない**(アプリ本体が `app.css` の `@media print` で
   *   同じ形を踏んで直した ── 「残り約 90% が黙って落ちていた」)。
   * 🔑 grid と 100% と overflow を外し、帯と目次は紙に要らないので落とす。
   *   `tests/smoke/manual-window.smoke.spec.ts` が PDF の頁数で見る。
   */
  '@media print{html,body{height:auto}body{display:block}',
  '[data-pkc-field="manual-window-head"],[data-pkc-region="manual-window-toc"]{display:none}',
  '[data-pkc-region="manual-window-body"]{display:block}',
  '[data-pkc-region="manual-window-main"]{overflow:visible;height:auto;padding:0}}',
].join('');

/**
 * `tokens.css` が持つ配色の id(`:root[data-pkc-theme='x']`)。
 * 🔑 **CSS から読む**(`theme.ts` の `THEMES` を写さない)── 描けるのは CSS に定義が
 *   在る配色だけなので、CSS が正本。`THEMES` と 1 対 1 であることは
 *   `tests/features/manual-page.test.ts` が突き合わせる。
 */
export function themeIdsIn(tokensCss: string): string[] {
  const out = new Set<string>();
  for (const m of tokensCss.matchAll(/:root\[data-pkc-theme='([^']+)'\]/gu)) out.add(m[1]!);
  return [...out];
}

/**
 * 最初の描画の前に配色の属性を立てる script。
 *
 * 🔑 **`theme.ts` の `initialTheme()` と同じ倒し方**にする ── 保存されていれば それ、
 *   無ければ OS に従う。⚠ 保存が読めない環境(private mode で `localStorage` が投げる)
 *   でも**必ず属性は立つ**(立たないと `tokens.css` の既定 = light に落ちるだけだが、
 *   暗い部屋の人に白を出す)。
 * ⚠ 保存されている値が CSS に無い配色(古い / 壊れた値)なら OS に落ちる ──
 *   `theme.ts` の `isTheme` と同じ門。
 */
export function themeBootScript(
  themeIds: readonly string[],
  storageKey: string,
  textScale?: { readonly storageKey: string; readonly sizes: Readonly<Record<string, string>> },
): string {
  /**
   * 🔑 字の大きさも同じ倒し方で当てる(`text-scale.ts` の `initialTextScale` と同じ門:
   *   保存が在り、知っている id なら その大きさ / それ以外は触らない = CSS の既定 14px)。
   * ⚠ 対応表(id → px)は `features/text-scale.ts` の `TEXT_SCALES` から焼く ── 写さない。
   */
  const size = textScale
    ? 'var s=null;try{s=localStorage.getItem(' +
      JSON.stringify(textScale.storageKey) +
      ')}catch(e){}var m=' +
      JSON.stringify(textScale.sizes) +
      ';if(s!==null&&Object.prototype.hasOwnProperty.call(m,s))document.documentElement.style.setProperty("--pkc-text-size",m[s]);'
    : '';
  return (
    '(function(){var ok=' +
    JSON.stringify([...themeIds]) +
    ',t=null;try{t=localStorage.getItem(' +
    JSON.stringify(storageKey) +
    ')}catch(e){}if(ok.indexOf(t)<0){t="light";try{if(matchMedia("(prefers-color-scheme: dark)").matches)t="dark"}catch(e){}}' +
    'document.documentElement.setAttribute("data-pkc-theme",t);' +
    size +
    /**
     * 🔑 **URL の節の印(`#m-N`)へ、読み込みの後に自分で送る**(2026-09-02 実測)。
     * ⚠ 再読み込み(F5)では、ブラウザは断片へ送らない ── 印は URL に残るのに見出しが
     *   画面の外(実測 top = 43718px)。`history.scrollRestoration = 'manual'` にしても
     *   変わらなかった(本文がスクロール箱の中に居るため、断片の送りが箱に届かない)。
     *   だから DOMContentLoaded で `scrollIntoView` する。⚠ これは「配色を立てる」に次ぐ
     *   2 つ目の振る舞いだが、**目次の `<a>` が押されたときと同じ送り**を再読み込みと
     *   ブックマークにも効かせるだけである(新しい操作は増えない)。
     */
    'addEventListener("DOMContentLoaded",function(){var h=location.hash.slice(1);' +
    'if(!h)return;var e=document.getElementById(h);if(e)e.scrollIntoView({block:"start"})});' +
    '})();'
  );
}

/** `TEXT_SCALES` を script に焼く形(id → px)。 */
export function textScaleSizes(): Readonly<Record<string, string>> {
  return Object.fromEntries(TEXT_SCALES.map((t) => [t.id, t.size]));
}

export interface ManualPageInput {
  /** 窓の題名(`MANUAL_WINDOW_TITLE`)。 */
  readonly title: string;
  /** 帯に出す版の行(`versionText()`)。 */
  readonly version: string;
  /** `<body>` に刻む印(`manualBuildTag(version, text)`)。⚠ opener はこれで入れ替えを決める。 */
  readonly tag: string;
  /** 描いた本文の HTML(`renderMarkdown(MANUAL_TEXT)`)。⚠ 空は受けない(build を止める側の仕事)。 */
  readonly html: string;
  /** 源文の節(`manualSections(text)`)。 */
  readonly sections: readonly ManualSection[];
  /** `src/styles/tokens.css` の全文(配色 9 種 + 幾何)。 */
  readonly tokensCss: string;
  /** 本文の CSS(`extractBodyCss(...).css` = `virtual:pkc-body-css` と同じもの)。 */
  readonly bodyCss: string;
  /** 配色の保存の鍵(`theme.ts` の `THEME_STORAGE_KEY`)。 */
  readonly themeStorageKey: string;
  /** 字の大きさの保存の鍵(`text-scale.ts` の `TEXT_SCALE_STORAGE_KEY`)。 */
  readonly textScaleStorageKey: string;
}

export interface ManualPage {
  /** 完成した 1 枚(`<!doctype html>` から)。 */
  readonly html: string;
  /** 本文に在った見出しの数(空振り防止の観測点 ── build 側が下限を見る)。 */
  readonly headings: number;
  /** 目次の行数。 */
  readonly toc: number;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;');
}

/** コメントと余分な空白を落とす(`tokens.css` は注記が本文より長い)。 */
function compactCss(css: string): string {
  return css
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/\s+/gu, ' ')
    .replace(/\s*([{};:,])\s*/gu, '$1')
    .trim();
}

/**
 * 1 枚に焼く。
 *
 * ⚠ CSS の並びは **tokens(9 配色)→ 本文 → 器** ── 本文の CSS は自分でも
 *   `:root{light}` / `@media dark` を持つが、配色の属性つきの規則(詳細度が 1 段上)が
 *   **順番に依らず勝つ**ので、テーマの値が本文にも効く。
 * ⚠ 目次と本文の id は `buildManualDoc` の**同じ走査**から出る(段①と同じ不変量)。
 */
export function buildManualPage(input: ManualPageInput): ManualPage {
  const built = buildManualDoc(input.html, input.sections);
  const css = `${compactCss(input.tokensCss)}\n${input.bodyCss}\n${MANUAL_CHROME_CSS}`;
  const boot = themeBootScript(themeIdsIn(input.tokensCss), input.themeStorageKey, {
    storageKey: input.textScaleStorageKey,
    sizes: textScaleSizes(),
  });
  const toc = built.toc
    .map(
      (t) =>
        `<a href="#${t.targetId}" data-pkc-level="${t.level}">${escapeHtml(t.label)}</a>`,
    )
    .join('');
  const html = [
    '<!doctype html>',
    '<html lang="ja">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(input.title)}</title>`,
    `<style>${css}</style>`,
    // ⚠ `<body>` より前 ── 最初の描画の前に配色の属性が立つ
    `<script>${boot}</script>`,
    '</head>',
    `<body ${MANUAL_BUILT_ATTR}="${escapeHtml(input.tag)}">`,
    '<div data-pkc-field="manual-window-head">',
    `<strong>${escapeHtml(input.title)}</strong>`,
    `<span>${escapeHtml(input.version)}</span>`,
    `<span>${escapeHtml(MANUAL_TIP)}</span>`,
    '</div>',
    '<div data-pkc-region="manual-window-body">',
    `<nav data-pkc-region="manual-window-toc" aria-label="目次">${toc}</nav>`,
    `<div data-pkc-region="manual-window-main" class="${HOST_CLASS}">${built.html}</div>`,
    '</div>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
  return { html, headings: built.headings, toc: built.toc.length };
}
