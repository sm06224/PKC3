/**
 * Markdown-to-HTML renderer powered by markdown-it.
 *
 * Features layer — pure function, no browser APIs.
 * markdown-it is chosen for:
 *   - Full CommonMark compliance
 *   - Plugin ecosystem (future: KaTeX, footnotes, containers)
 *   - Customizable rendering (future: typesetting, document generation)
 *   - XSS-safe by default (HTML input is escaped)
 *
 * Current configuration:
 *   - HTML tags in source: disabled (XSS prevention)
 *   - Linkify: enabled (auto-detect URLs)
 *   - Typographer: enabled (smart quotes, dashes)
 *   - Breaks: enabled (newline → <br>)
 *   - Tables, strikethrough: enabled via base config
 *
 * Phase 2 additions:
 *   - GFM-style task lists (`- [ ]` / `- [x]`)
 *   - Hardened link safety (`rel="noopener noreferrer"`)
 *   - Explicit safe URL scheme allowlist
 *   - Language class hint on fenced code blocks
 */

import MarkdownIt from 'markdown-it';
import { parseTagLine } from '../flavor/body-tags';
import { MAX_TAGS, sameTag } from '../flavor/tags';
// ⚠ v15 で型は本体 package が同梱するようになり、`markdown-it/lib/**` の
// 部分 path は exports map から**消えた**(v14 では `@types/markdown-it` が
// `lib/token.mjs` を生やしていた)。型は本入口から名前付きで取る。
import type { Token } from 'markdown-it';
// PR-W18:HTML footnote plugin(`[^id]` → `<sup class="footnote-ref">`)。
// CJS package だが exports map で `.mjs` を提供しているため ESM import OK。
import footnotePlugin from 'markdown-it-footnote';
import { makeSlugCounter } from './markdown-toc';
import { highlightCode, isHighlightable } from './code-highlight';
import { renderCsvFence } from './csv-table';
import { buildHtmlSandboxIframe } from './html-sandbox';
import {
  EXTERNAL_IMAGE_ATTR,
  EXTERNAL_IMAGE_CLASS,
  isExternalImageSrc,
} from './external-images';
import {
  takeFenceAsset,
  asFenceContent,
  FENCE_ASSET_PREFIX,
  type FenceAssetParse,
} from './fence-asset';
import { parsePortablePkcReference } from '../link/permalink';
import {
  inferQ8ValueOnlyKey,
  parseBlockDirectiveOpen,
  parseTier1FormatOpen,
  isBlockDirectiveClose,
  type BlockDirectiveAttrs as _BlockDirectiveAttrs,
} from './block-directive-attrs';
import { ensureBlankAroundColonBlocksWithLineMap } from './colon-block-normalize';
import {
  splitAttrs,
  parseVocabularyTokensToStyles,
  parseTier0FormatOpen,
  classifyDirectiveOpen,
} from './directive-open';
import { parseInlineRoleAt, type InlineRoleMatch } from './inline-role-parser';
import {
  isCardPresentationLabel,
  parseCardPresentation,
} from '../link/card-presentation';

const md = new MarkdownIt({
  html: false,          // Disable HTML tags in source (XSS safety)
  linkify: true,        // Auto-convert URL-like text to links
  typographer: true,    // Smart quotes, em-dash, etc.
  breaks: true,         // Convert \n to <br> for easier editing
  langPrefix: 'language-', // Code block language class prefix (for highlighting token selectors)
  // Fenced code block syntax highlighting. We return already-escaped
  // HTML for known languages; markdown-it then wraps it in
  // `<pre><code class="language-xxx">...</code></pre>`. For unknown
  // / empty languages, returning an empty string lets markdown-it
  // fall back to its default escape-and-wrap behaviour — preserving
  // the historical plain appearance. See code-highlight.ts.
  highlight: (str, lang) => {
    if (!isHighlightable(lang)) return '';
    return highlightCode(str, lang);
  },
});

/**
 * 🔴 **URL の中の `user:pass@` は、上流の既定どおり URL の外として読む**
 * (#78、markdown-it 15 移行。⚠ **着地前レビューの指摘で ON から OFF へ翻した**)。
 *
 * ## 何が変わるか
 *
 * v15 は linkify-it 6 になり `urlAuth` が既定 off になった。off だと
 * `https://token@github.com/a/b.git` は **`https://token` で切れて**、
 * 残りの `@github.com/a/b.git` が地の文になる ── v14 では 1 本だったので、
 * user から見れば**リンクが割れる後退**である。
 *
 * ## それでも ON に戻さない理由(いったん戻して、取り下げた)
 *
 * 🔴 戻したときに書いた理由は「PKC は自分のノートで、リンクの字は**全文が
 * そのまま出る**(ラベルで隠れない)から騙されない」だった。⚠ **これは誤りである。**
 * 実測(2026-08-22): `https://example.com@evil.example/x` は ON だと
 * **1 本のリンク**になり、`href` の**行き先は `evil.example`** なのに、
 * 字は左から `https://example.com…` と読める ── **全文が出ていても騙せる**。
 * 隠れているのは字ではなく、**`@` より前が host ではないという文法**のほうだった。
 *
 * 🔑 そこで裁き直すと、天秤の両側は**どちらも壊れたリンク**である:
 * ON は「**行き先が違うのに正しく見える**」(静か)、OFF は「**途中で切れる**」(見える)。
 * ⚠ **静かなほうが悪い** ── だから OFF を取る。同じ物差しで `・`(下)は
 * 「静かに別の記事へ行く」ので直し、こちらは直さない。
 *
 * ⚠ そして「他人の本文は来ない」も成り立たない ── 貼り付け変換
 * (`html-to-markdown.ts`)/ PKC2 の取込 / `.md` の取込は**どれも既定で在る**。
 *
 * 🔑 **これが分かったら覆る**: user が `user@host` 形の URL を日常的に貼っていて、
 * 割れるのが実害だと分かったら、そのときは `urlAuth: true` + 「`@` の前に `.` を
 * 含むものは自動リンクしない」を組で入れる(正当な token は `.` を含まない)。
 * ⚠ **`urlAuth: true` を単独で入れ直さない** ── それが今回取り下げた形である。
 *
 * 🔑 pin は `tests/features/markdown-linkify.test.ts` ── **見える字と `href` を
 * 対で見る**(片方だけ見ていると、この食い違いは検出できない)。
 */

/**
 * 🔴 **中黒(・)で URL を切らない**(#78、2026-08-22。着地前の動線レビューが拾った)。
 *
 * ⚠ v15 は「Unicode の句読点が来たらリンクを終える」ようになった ── 日本語には
 * 効く変更だが、**`・` は文を終える印ではなく語をつなぐ印**である。そのため
 * `https://ja.wikipedia.org/wiki/クロード・モネ` が
 * **`…/wiki/クロード` で切れて、実在する別の記事へ行くリンク**になっていた
 * (日本語 Wikipedia の人名記事がそのまま該当する)。
 *
 * 🔑 **裁いた物差しは上の `urlAuth` と同じ**(そちらは同じ物差しで OFF になった)──
 * 「**静かに間違う**」のがいちばん悪い。ここは**リンクの字が正しく見えて、
 * 行き先だけが違う** ── `…/wiki/クロード` は実在の別記事なので、
 * user は押した先が違うことに気づけない。
 *
 * ⚠ **代償はある。** `参考 https://a.example・以上です` のように `・` を**区切り**に
 * 使うと、後ろの地の文まで URL に飲む(v14 と同じ形)。⚠ ただしこちらは
 * **リンクの字に文がまるごと入る**ので user から見えて、`[題名](URL)` へ直せる。
 * 🔑 **見える誤りを取り、見えない誤りを捨てた**、という交換である。
 *
 * ⚠ 句点・読点・かぎかっこ・波ダッシュは**上流のまま終端にする**(そちらは
 * 「URL の外」に置かれる印なので、v15 の判断が正しい)。外すのは `・` の 2 字だけ。
 *
 * 🔑 触っているのは `linkify-it` の**公開クラス** `REBuilder` の公開 field である
 * (`linkify.re: REBuilder` / `src_P` / `src_ZPCc` ── いずれも `.d.ts` に在る)。
 * ⚠ それでも上流の版が動けば黙って効かなくなりうるので、
 * `tests/features/markdown-linkify.test.ts` が**人名の URL 1 本**で見張る。
 *
 * ⚠ 実測(2026-08-22): `src_ZPCc` の組み直しは **`src_P` の後でなければ効かない**
 * (前に組むと古い `src_P` が焼き込まれる)。`cache` の破棄は**いまは要らない**
 * (最初の描画より前に走るので空である) ── 順序に依存しないための保険として置く。
 */
{
  /** `・`(U+30FB)と半角の `･`(U+FF65)。⚠ 生バイトで書かない(CLAUDE.md)。 */
  const JOIN_MARKS = '\\u30FB\\uFF65';
  const re = md.linkify.re;
  re.src_P = `(?![${JOIN_MARKS}])(?:${re.src_P})`;
  re.src_ZPCc = [re.src_Z, re.src_P, re.src_Cc].join('|');
  re.cache = {};
}

// PR-W18(user「footnote 機能してない、前々から実装した気になって実装されて
// ない機能の代表、HTML 側もできてない」):markdown-it-footnote plugin で
// `[^id]` + 末尾 `[^id]: 本文` 定義を native HTML render(`<sup class=
// "footnote-ref">` + 末尾 `<section class="footnotes">`)。AST 経路は
// parse.ts で shield + decompose-pkc で AstFootnoteRef 化済(別経路、
// docx export 用)。本 plugin は HTML render 専用。
// PR-W19 hotfix:旧 `require('markdown-it-footnote')` は browser bundle
// で `require is not defined` で boot 全体が死ぬ重大 regression(vitest
// Node 環境では通っていたため気付かなかった)。ESM import に切替。
md.use(footnotePlugin);

// ── Link hardening ────────────────────────────────────
//
// Phase 2: tighten the default validateLink to an explicit allowlist.
// Only http(s), mailto, tel, relative paths, fragment anchors, and
// safe image data URIs pass through. Everything else (javascript:,
// vbscript:, file:, data:text/html, etc.) is rejected.
//
// Extended: Microsoft Office URI schemes are also allowed so that
// [Edit](ms-word:ofe|u|https://…/file.docx) style links open the
// corresponding Office desktop app (Word / Excel / PowerPoint /
// OneNote etc.) via the OS URL handler. The allowlist is explicit —
// only the schemes documented in the Office URI Schemes reference
// pass through; arbitrary `ms-*:` schemes remain blocked.
// https://learn.microsoft.com/office/client-developer/office-uri-schemes

// `entry:` is PKC2's internal cross-entry link scheme (see
// `PKC2: docs/development/textlog-viewer-and-linkability-redesign.md` §6.5
// and `src/features/entry-ref/entry-ref.ts`). `pkc:` is the external
// shareable permalink scheme defined by
// `PKC2: docs/spec/pkc-link-unification-v0.md` §4. Both schemes are on the
// safe allowlist so markdown-it emits the `<a>` at all; the link_open
// rule below then tags them for the right in-app behaviour (internal
// navigation for `entry:`, cross-container placeholder for `pkc:`).
//
// `asset:` は PKC3 では allowlist に**載せる**(P4b。PKC2 からの総合的見直し)。
// PKC2 は asset-resolver preprocessor が markdown-it の前に
// `![alt](asset:key)` → `<img src="data:…">` に展開していた ── base64 を
// render 結果に常駐させる、まさに廃止対象の経路。PKC3 に preprocessor は
// 存在せず、代わりに:
//   - image rule が `<img data-pkc-asset-key=…>`(src 無し)placeholder を出す
//   - link_open rule が href を剥がして download-asset action の `<a>` にする
// bytes は adapter 層の hydrator(DetailRenderer.hydrateAssetRefs)が表示の
// 寿命に合わせて lend/dispose する(ObjectURL は次 render で必ず破棄 ──
// user 指示 2026-07-27 不可侵)。features 層はここで key を運ぶだけで、
// blob / URL には一切触れない(core ← features ← adapter の import 規律)。
// どちらの rule も href/src から `asset:` を消すので、生きた
// `<a href="asset:…">` / `<img src="asset:…">` が DOM に出ることはない。
const SAFE_URL_RE = /^(https?:|mailto:|tel:|ftp:|entry:|pkc:|asset:|#|\/|\.\/|\.\.\/|[^:]*$)/i;
const SAFE_DATA_IMG_RE = /^data:image\/(gif|png|jpeg|webp|svg\+xml);/i;
const SAFE_OFFICE_URI_RE =
  /^(?:ms-(?:word|excel|powerpoint|visio|access|project|publisher|officeapp|spd|infopath)|onenote):/i;

md.validateLink = function (url: string): boolean {
  const trimmed = url.trim();
  if (SAFE_DATA_IMG_RE.test(trimmed)) return true;
  if (SAFE_OFFICE_URI_RE.test(trimmed)) return true;
  return SAFE_URL_RE.test(trimmed);
};

// Add target="_blank" and rel="noopener noreferrer" to all links.
// noreferrer prevents the destination from seeing the document URL,
// which matters when the bundle is opened from a local file path.
const defaultLinkOpen = md.renderer.rules.link_open ??
  function (tokens, idx, options, _env, self) {
    return self.renderToken(tokens, idx, options);
  };

// ── B-1 (USER_REQUEST_LEDGER S-16, 2026-04-14): CSV / TSV / PSV
//    fenced blocks render as `<table>`. Short-circuits BEFORE the
//    `highlight:` hook so CSV blocks bypass syntax highlighting
//    (they're not code). On parse failure or unknown lang, fall
//    through to the default fence renderer (which then runs the
//    highlight hook, preserving B-2 behaviour for code blocks).
const defaultFence = md.renderer.rules.fence ??
  function (tokens, idx, options, _env, self) {
    return self.renderToken(tokens, idx, options);
  };
// ── コードブロック・レンダリング標準規約(codeblock-render-standard-2026-07、
//    user 裁定 2026-07-24)──
//    レンダラを持つ言語(registry)は fence suffix で表示を選ぶ:
//      無印            = `-both` の省略形(レンダリング + ソース切替トグル)
//      <lang>-render   = レンダリングのみ固定(旧 ` ```html-render ` は
//                        この規則で自然に解釈される = 挙動不変)
//      <lang>-norender = コードブロックのみ固定(render 経路に一切入らない)
//    フラグ制御はしない(user 裁定)。トグルは CSS-only(checkbox + label の
//    sibling combinator)── S2 Viewer popup / S4 entry-window は action-binder
//    の無い独立 document のため、JS 配線ゼロで全 surface に効く方式を正とする。

export type RenderableFenceLang = 'html' | 'svg' | 'mermaid' | 'chart' | 'csv' | 'tsv' | 'psv';
export type RenderableFenceMode = 'both' | 'render' | 'norender';

/** ⚠ 公開しているのは `tests/docs-parity.test.ts` がマニュアルと突合するため。 */
export const RENDERABLE_FENCE_LANGS: ReadonlySet<string> = new Set([
  'html', 'svg', 'mermaid', 'chart', 'csv', 'tsv', 'psv',
]);

export interface RenderableFence {
  readonly lang: RenderableFenceLang;
  readonly mode: RenderableFenceMode;
  /** 先頭 token 以降のオプション文字列(csv 系の `noheader` 等)。 */
  readonly rest: string;
}

/**
 * fence info 文字列を標準規約の `{ lang, mode }` に分解する。registry 外の
 * 言語(suffix があっても base がレンダラを持たない場合を含む)は null を
 * 返し、caller は従来の code block 経路へ fall through する。
 */
export function parseRenderableFence(info: string | null | undefined): RenderableFence | null {
  if (!info) return null;
  const trimmed = info.trim();
  if (!trimmed) return null;
  const first = trimmed.split(/\s+/)[0]!;
  const rest = trimmed.slice(first.length).trim();
  const lower = first.toLowerCase();
  let mode: RenderableFenceMode = 'both';
  let base = lower;
  if (lower.endsWith('-norender')) {
    mode = 'norender';
    base = lower.slice(0, -'-norender'.length);
  } else if (lower.endsWith('-render')) {
    mode = 'render';
    base = lower.slice(0, -'-render'.length);
  } else if (lower.endsWith('-both')) {
    mode = 'both';
    base = lower.slice(0, -'-both'.length);
  }
  if (!RENDERABLE_FENCE_LANGS.has(base)) return null;
  return { lang: base as RenderableFenceLang, mode, rest };
}

/** norender / render-失敗 fallback 用のソース表示(base lang で highlight)。 */
function renderFenceSourceHtml(content: string, lang: RenderableFenceLang): string {
  return `<pre><code class="language-${lang}">${highlightCode(content, lang)}</code></pre>`;
}

/**
 * mode = render / both の「レンダリング面」を言語別に生成する。
 * csv 系は parse 失敗で null(caller がソース表示へ fall back)。
 */
/**
 * 🔴 **salt は「同じ中身の中での出現順」にする**(2026-08-05 に実測で判明)。
 *
 * かつてここは **token 添字**だった。すると図の**前**に段落を 1 つ足すだけで
 * 添字がずれ、`id` が変わり、**図を含む塊の HTML が変わる** ── `apply-blocks.ts`
 * から見ると「その塊は変わった」ことになるので作り直され、**生きている
 * `<img>` が捨てられて絵が一度消える**(ObjectURL の作り直し + IDB の読み直し +
 * decode)。実測: 図の前に段落 1 つを挿入すると、塊の差は
 * **`pkc-rv-…` の値だけ**なのに `diffBlocks` の `middle` に図の塊が入る。
 * ⚠ これは `sourceLineAnchors` を切っている**今日のプレビューでも起きている**。
 *
 * 出現順にすれば「同じ内容の fence を区別する」という当初の目的は保ったまま、
 * **無関係な編集で id が動かなくなる**。
 * ⚠ カウンタは `env`(render 1 回ぶん)に持つ ── `md` は module 内で共有なので、
 * module スコープに置くと render を跨いで増え続け、id が毎回変わる(元の病気に戻る)。
 */
function nextFenceOccurrence(env: unknown, lang: string, content: string): number {
  const bag = env as { fenceSeen?: Map<string, number> };
  const seen = (bag.fenceSeen ??= new Map<string, number>());
  const key = `${lang}\u0000${content}`;
  const n = seen.get(key) ?? 0;
  seen.set(key, n + 1);
  return n;
}

function buildRenderableSlotHtml(
  fence: RenderableFence,
  content: string,
  inlineRender: (text: string) => string,
  /**
   * **同じ (lang, 中身) の fence の中で何番目か**(0 始まり)── 決定的な id を
   * 作るために要る。⚠ **token 添字ではない**(下の `nextFenceOccurrence` を見よ)。
   */
  occurrence: number,
  /** 箱の CSP の `img-src` を開けるか。⚠ **既定は塞ぐ側**(`external-images.ts`)。 */
  allowExternalImages: boolean,
  /**
   * 🔴 **囲みの中身が原文の何行目から始まるか**(#418 段①)。
   * `undefined` = セルを押せないまま(既定)。csv 系だけが使う。
   */
  firstContentLine: number | undefined,
): string | null {
  switch (fence.lang) {
    case 'html':
    /**
     * 🔴 **`svg` は `html` と同じ箱で描く**(#528 段⑥。user 要望 2026-08-28
     * 「**HTML も plotly も SVG も…レンダリングできていた**」)。
     *
     * ⚠ 直す前、SVG は**本文に生で書いても ` ```svg ` の囲みに入れても字になった**
     *   (実測 ── 出るのは `&lt;svg` である)。描けたのは ` ```html ` に入れたときだけで、
     *   **それを知っている人しか図を貼れなかった**(UML と同じ形の落差である)。
     * 🔑 **新しい門は 1 つも開けない** ── 中身は `<svg>` も `<script>` も書ける以上
     *   HTML と危険度が同じなので、**同じ箱・同じ CSP** に通す。
     *   ⚠ 別経路(本文へ直に差し込む)にすると、外部取得の同意も、止めた理由の行も、
     *   高さ追従も**全部もう 1 組**要る(CLAUDE.md §7)。
     * ⚠ **本文に生で書いた SVG は、今までどおり字のまま**である ── markdown の
     *   生 HTML を通す判断は別の話で、ここでは変えない。
     */
    // eslint-disable-next-line no-fallthrough
    case 'svg':
      // reform-2026-05 PR-2M:iframe sandbox 経由で HTML を直接 render。
      // sandbox="allow-scripts" のみ(allow-same-origin 無し)で cross-origin 隔離。
      return buildHtmlSandboxIframe(content, '', occurrence, allowExternalImages);
    case 'mermaid': {
      // pgc-203 wave-α' polish #24:placeholder div のみ emit。実 SVG render は
      // adapter 層の `hydrateMermaidPlaceholders` が lazy import('mermaid') で
      // 行う(I4 invariant:features 層 pure を維持)。source は attribute に
      // 保持(HTML entity escape 必須、md.utils.escapeHtml 使用)。
      const escaped = md.utils.escapeHtml(content);
      return `<div class="pkc-mermaid-placeholder" data-pkc-mermaid-src="${escaped}" data-pkc-md-block-kind="mermaid"><pre class="pkc-mermaid-source"><code class="language-mermaid">${escaped}</code></pre></div>`;
    }
    case 'chart': {
      /**
       * 🔴 **mermaid と同じ形にする**(#188)── placeholder を出し、実際に描くのは
       * adapter 層(`hydrateChartPlaceholders`)。features 層は DOM を持たない。
       * ⚠ 描いた結果は **PNG の `<img>` 1 枚**(不可侵指示「描いたら焼く」)。
       * ⚠ 原文は属性に持つ ── **同じ塊の HTML が変わらない**ことが、生きている
       *   `<img>` を捨てないための条件である(mermaid で実測済み)。
       */
      const escapedChart = md.utils.escapeHtml(content);
      return `<div class="pkc-chart-placeholder" data-pkc-chart-src="${escapedChart}" data-pkc-md-block-kind="chart"><pre class="pkc-chart-source"><code class="language-chart">${escapedChart}</code></pre></div>`;
    }
    default: {
      // csv / tsv / psv:suffix を剥がした info を渡す(`noheader` 等の
      // オプションは rest 経由で温存)。
      const info = fence.rest ? `${fence.lang} ${fence.rest}` : fence.lang;
      return renderCsvFence(content, info, inlineRender, firstContentLine);
    }
  }
}

/**
 * 標準規約 wrapper(§2.3):copy ボタン + [both のみ] CSS-only トグル +
 * レンダリング slot + 隠しソース。隠しソースは copy の供給源
 * (action-binder の `:scope > pre` がこれを拾う)と -both のソース面を兼ねる。
 * トグル状態は ephemeral(再 render で初期 = レンダリング側に戻る)。
 */
/**
 * トグルの id。⚠ **決定的**であること ── 乱数だと差分反映が毎回全部作り直す。
 * 衝突しても壊れるのは「切替が連動する」だけなので、短い hash で十分。
 */
function toggleKey(content: string, salt: string): string {
  let h = 0x811c9dc5;
  const text = content + salt;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36).padStart(7, '0');
}

function buildRenderableBlockHtml(
  fence: RenderableFence,
  slotHtml: string,
  content: string,
  sourceLineAttrs: string,
  /**
   * **同じ (lang, 中身) の fence の中で何番目か**(0 始まり)。
   * ⚠ **同じ中身の fence を区別する**ために要るが、**token 添字にしてはいけない**。
   */
  occurrence: number,
): string {
  let toggleHtml = '';
  if (fence.mode === 'both') {
    // 🔴 **中身から決める**(乱数にしない ── P8 段⑩ で判明)。
    // かつて `Math.random()` を使っており、**同じ入力でも毎回ちがう HTML** に
    // なっていた。差分反映(`apply-blocks.ts`)から見ると fence を含む塊は
    // 「毎回変わった」ことになり、**図が毎回作り直されて絵が一度消える**
    // (user 指摘「レンダリングで画面がガクガクする」の実体の 1 つ)。
    // ⚠ 同じ文書に同じ内容の fence が 2 つあっても衝突しないよう、位置も混ぜる。
    const id = `pkc-rv-${toggleKey(fence.lang + '\u0000' + content, String(occurrence))}`;
    toggleHtml =
      `<input type="checkbox" id="${id}" class="pkc-render-toggle-input" aria-label="ソース / レンダリング切替">` +
      `<label for="${id}" class="pkc-render-toggle" title="ソース / レンダリング切替">‹/›</label>`;
  }
  const sourceHtml = `<pre class="pkc-render-source"><code class="language-${fence.lang}">${highlightCode(content, fence.lang)}</code></pre>`;
  return `<div class="pkc-md-block" data-pkc-md-block-kind="code" data-pkc-render-lang="${fence.lang}" data-pkc-render-mode="${fence.mode}"${sourceLineAttrs}>` +
    `<button class="pkc-md-copy-btn" data-pkc-action="copy-md-block" data-pkc-copy-kind="code" type="button" aria-label="コピー" title="コピー">⧉</button>` +
    toggleHtml +
    `<div class="pkc-render-slot">${slotHtml}</div>` +
    sourceHtml +
    `</div>`;
}

/**
 * 🔴 **中身を添付から取る囲みの器**(#444 段①)。
 *
 * ⚠ **ここでは読まない。** 添付は IDB に在り、markdown の描画は同期である ──
 *   器だけ置いて、adapter の hydrator が埋める(mermaid と同じ形)。
 * 🔴 **誰も埋めなかったときに読める字にする** ── 書き出した HTML には hydrator が
 *   居ないので、ここが空だと「持ち出したら中身が消える」になる(PKC の芯に反する)。
 *   だから **「このコードブロックの中身は添付(asset:…)に在ります」** と、鍵ごと出しておく。
 * ⚠ 囲みの中に書いた字は**控え**として残す ── 添付が読めたら hydrator が捨てる。
 */
function buildFenceAssetHtml(
  /** ⚠ `none` は呼ばない(呼び側が弾く)── 型で示して分岐を 2 か所に置かない。 */
  parse: Exclude<FenceAssetParse, { kind: 'none' }>,
  /**
   * `asset:` の語を抜いた残りの見出し(`csv` / `csv-render noheader` / `js` / 空)。
   * ⚠ 分解は hydrator 側でやる ── ここは**そのまま預ける**だけである。
   */
  withoutAsset: string,
  body: string,
  sourceLineAttrs: string,
): string {
  if (parse.kind === 'invalid') {
    // ⚠ **黙って普通の囲みに落とさない** ── user は `asset:` と書いたのだから、
    //   効かなかった理由が要る(#264 段② と同じ向き)
    return (
      `<div class="pkc-md-block" data-pkc-md-block-kind="code"${sourceLineAttrs}>` +
      `<p data-pkc-fence-asset-error>このコードブロックは添付を指していますが読めません: ` +
      `${md.utils.escapeHtml(parse.why)}</p>` +
      `</div>`
    );
  }
  const info = withoutAsset;
  const fallback =
    body === ''
      ? ''
      : `<pre data-pkc-fence-asset-fallback><code>${md.utils.escapeHtml(body)}</code></pre>`;
  return (
    `<div class="pkc-md-block" data-pkc-md-block-kind="code"` +
    ` data-pkc-fence-asset-key="${escapeHtmlAttr(parse.key)}"` +
    ` data-pkc-fence-asset-info="${escapeHtmlAttr(info)}"${sourceLineAttrs}>` +
    `<p data-pkc-fence-asset-pending>このコードブロックの中身は添付(asset:` +
    `${md.utils.escapeHtml(parse.key)})に在ります</p>` +
    fallback +
    `</div>`
  );
}

/**
 * 🔴 **囲みの見出しを 1 か所だけで読む**(#444 段②で取り出した)。
 *
 * 🔑 **読み手を 2 つにしない**(CLAUDE.md §7)── 描く側(`fence` rule)と
 *   **鍵を数え上げる側**(`collectFenceAssetKeys`)が同じ見出しを別の綴りで
 *   読むと、片方だけが古くなっても誰も気づかない。
 */
function fenceAssetOfInfo(info: string): { parse: FenceAssetParse; withoutAsset: string } {
  const parse = takeFenceAsset(info);
  /**
   * ⚠ **`asset:` の語を抜いた残り**が、そのまま「ふつうの見出し」である。
   *
   * 🔴 直す前は**先頭語を言語だと決め打って**その後ろだけ読んでいたので、
   *   言語を書かない ` ```asset:鍵 ` が**記法として読まれず**、
   *   `class="language-asset:鍵"` の素のコード囲みに静かに落ちていた
   *   (段② の一致検査が 1 件落ちて教えた)。
   * 🔑 語順に依らないという 段① の約束を、先頭語でも守る形である。
   */
  return { parse, withoutAsset: parse.kind === 'one' ? parse.rest : info };
}

/**
 * 🔴 **本文が指している添付の鍵を数え上げる**(#444 段②)。
 *
 * 書き出し側が「どの添付を字として読むか」を決めるために使う。
 * ⚠ 戻るのは **`kind: 'one'` だけ**── 書き方が使えない囲みは読まない
 *   (描く側がその場で理由を出す)。
 * ⚠ **重複は畳む**(同じ鍵を 2 つのコードブロックが指しても読みは 1 回)。
 * ⚠ fence の判定は markdown-it 自身にさせる ── 自前の正規表現で数えると
 *   引用の中・リストの中・`~~~` の囲みを取りこぼす。
 * ⚠ **読むのは前処理の前の原文である。** だから数えは描画と 1:1 ではない ──
 *   `%%%…%%%` の中の囲みも数える(**多く読む**側)/ `{{vars.x}}` の展開で
 *   初めて現れる囲みは数えない(**焼かれずに器が残る**側)。
 *   🔑 どちらも**黙って空にはならない** ── 多い側は上限つきの読みが 1 回増えるだけ、
 *   少ない側は「このコードブロックの中身は添付に在ります」が残って**何が入っていないか読める**。
 */
export function collectFenceAssetKeys(text: string): string[] {
  if (!text.includes(FENCE_ASSET_PREFIX)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const token of md.parse(text, {})) {
    if (token.type !== 'fence') continue;
    const { parse } = fenceAssetOfInfo((token.info ?? '').trim());
    if (parse.kind !== 'one' || seen.has(parse.key)) continue;
    seen.add(parse.key);
    out.push(parse.key);
  }
  return out;
}

md.renderer.rules.fence = function (tokens, idx, options, env, self) {
  const token = tokens[idx]!;
  // 領域 10-1 PR 2 hotfix: tagSourceLines puts data-pkc-source-line
  // on the fence token, but custom fence renderers emit their own HTML
  // and bypass token.attrs entirely. Hoist the source-line attrs onto
  // the wrapper div so the active-block lookup can find the fence.
  const sourceLineAttrs = collectSourceLineAttrs(token);
  const info = (token.info ?? '').trim();
  /**
   * 🔴 **中身を添付から取る囲み**(#444 段①)── **どの言語でも**効く。
   * ⚠ 読むのは**先頭語より後ろ**である(先頭語は言語 + 表示の指定)。
   * ⚠ ここは `parseRenderableFence` の**手前**に置く ── 素のコード囲み
   *   (` ```js `)は registry の外なので、後ろに置くと届かない。
   */
  const { parse: fenceAsset, withoutAsset } = fenceAssetOfInfo(info);
  /**
   * 🔴 **字が手元にあるなら、その場で描く**(#444 段②)。
   *
   * 書き出し(閲覧用 HTML / Word)には hydrator が居ないので、器だけ置くと
   * 「持ち出したら中身が消える」になる ── 呼び手が `fenceAssets` を渡していれば
   * **本文に書いてあったのと同じ道**で描く。
   * 🔑 だから**中身を差し替えて落とし込む**だけにする ── 描き方の規則を
   *   ここへ書き写さない(写した瞬間、本文の囲みと見た目がずれうる)。
   * ⚠ 渡されていない(アプリの画面)ときはこれまでどおり器を置く ──
   *   添付の読みは非同期で、markdown の描画は同期である。
   */
  let content = token.content ?? '';
  let effectiveInfo = info;
  if (fenceAsset.kind !== 'none') {
    const lent =
      fenceAsset.kind === 'one'
        ? (env as { fenceAssets?: Readonly<Record<string, string>> } | undefined)?.fenceAssets?.[
            fenceAsset.key
          ]
        : undefined;
    if (fenceAsset.kind !== 'one' || lent === undefined) {
      return buildFenceAssetHtml(fenceAsset, withoutAsset, content, sourceLineAttrs);
    }
    content = asFenceContent(lent);
    effectiveInfo = withoutAsset;
  }
  const fence = parseRenderableFence(effectiveInfo);
  if (fence) {
    /**
     * 🔴 **表のセルを押せるようにする**(#418 段①)。
     *
     * ⚠ 焼くのは**原文の行番号**なので、`toggle-task` と**同じ 3 段**を通す:
     *   ① token の `map[0]`(前処理後の行)② `env.lineMap` で原文へ逆引き
     *   ③ `taskLineOffset`(剥がした frontmatter のぶん)を足す。
     * ⚠ **中身の 1 行目は囲みの見出しの次**なので `+ 1`。
     * ⚠ 添付から焼いた囲み(#444)は**原文にその字が無い**ので押させない ──
     *   押せても、書き戻す先が本文に存在しない。
     */
    let firstContentLine: number | undefined;
    if (
      (env as { interactiveCells?: boolean } | undefined)?.interactiveCells === true &&
      content === (token.content ?? '')
    ) {
      const outLine = token.map?.[0];
      if (typeof outLine === 'number') {
        const map = (env as { lineMap?: number[] } | undefined)?.lineMap;
        const raw = map ? (map[outLine] ?? outLine) : outLine;
        const offset = (env as { taskLineOffset?: number } | undefined)?.taskLineOffset ?? 0;
        firstContentLine = raw + offset + 1;
      }
    }
    return renderRenderableFence(fence, content, sourceLineAttrs, env, firstContentLine);
  }
  /**
   * ⚠ 素のコード囲みは `defaultFence` が token を読むので、**写しを渡す**
   *   (別の描き方をここへ書き写さない ── 段① の parity 検査と同じ理由)。
   * 🔑 **本物は 1 バイトも書き換えない。** 書き換えて戻す形も試したが、
   *   「戻す」を**誰も見ていない**(外から観測できない)── 変異試験で
   *   「戻さない」変異が生き延びて分かった。⚠ 観測できない後始末に頼るより、
   *   **書き換えないほうが強い**(CLAUDE.md「『これが無いと壊れる』と書く前に、
   *   外して壊れるのを見る」)。
   * ⚠ `defaultFence` が読むのは `tokens[idx]` の `info` / `content` / `attrs` /
   *   `attrIndex` だけなので、写し 1 つの配列で足りる(上流の実装を読んで確かめた)。
   */
  if (content !== (token.content ?? '') || effectiveInfo !== info) {
    const surrogate = Object.assign(
      Object.create(Object.getPrototypeOf(token) as object) as typeof token,
      token,
      { content, info: effectiveInfo },
    );
    return wrapWithCopyButton(
      defaultFence([surrogate], 0, options, env, self),
      'code',
      sourceLineAttrs,
    );
  }
  const fenceHtml = defaultFence(tokens, idx, options, env, self);
  return wrapWithCopyButton(fenceHtml, 'code', sourceLineAttrs);
};

/**
 * 🔴 **registry の囲み 1 つを描く**(#444 段①で `fence` rule から取り出した)。
 *
 * ⚠ **取り出した理由は 1 つだけ**:中身を**外から渡せる**ようにするため
 *   ── 添付から取った字を、本文に書いてあったのと**同じ経路**で描く
 *   (CLAUDE.md §7「判定を増やさない」── 描き方の規則を 2 本にしない)。
 * ⚠ 中身以外は 1 バイトも変えていない。
 */
function renderRenderableFence(
  fence: RenderableFence,
  content: string,
  sourceLineAttrs: string,
  env: unknown,
  /**
   * 🔴 **囲みの中身が原文の何行目から始まるか**(#418 段①)。
   * ⚠ `undefined` = 押せない ── **受け手が居る面だけ**が渡す
   *   (`interactiveTasks` と同じ作法。書き出し・印刷では押させない)。
   */
  firstContentLine?: number,
): string {
  {
    if (fence.mode === 'norender') {
      return wrapWithCopyButton(renderFenceSourceHtml(content, fence.lang), 'code', sourceLineAttrs);
    }
    /**
     * セルの中の inline markup(`**bold**` / `==highlight==` / `:text:attrs:` 等)
     * を描く口。
     *
     * 🔴 **文書の env を渡してはいけない**(2026-08-06。user 報告 2-1)。
     * 直す前は `md.renderInline(text, env)` で**文書の env を共有**していた ──
     * `markdown-it-footnote` の `footnote_tail` は core rule なので
     * `renderInline` でも走り、**セルごとに文書の脚注セクションを丸ごと吐いた**。
     * 実測: 4 セルの表で `<section class="footnotes">` が **5 個**、
     * `id="fn1"` も **5 個** ── **DOM id が重複**して `[^a]` のジャンプ先が
     * 表の中のセルになっていた。
     * ⚠ セルが env から要るのは `currentContainerId` **だけ**(`pkc://` の
     *   同 container 判定)。それだけを写した**使い捨ての env** を渡す。
     */
    /**
     * ⚠ **外部画像の許可も写す**(2026-08-06)── 写さないと、表のセルの中の
     * 画像だけが**設定と逆に振る舞う**(「常にオン」でもセルの画像は出ない)。
     * env を丸ごと渡さない理由(脚注)は上のとおりなので、**要る 2 つだけ**写す。
     */
    const cellEnv = {
      currentContainerId: (env as { currentContainerId?: string } | undefined)?.currentContainerId ?? '',
      allowExternalImages:
        (env as { allowExternalImages?: boolean } | undefined)?.allowExternalImages === true,
    };
    const inlineRender = (text: string): string => md.renderInline(text, { ...cellEnv });
    /**
     * 1 度だけ数えて両方へ同じ値を渡す。
     *
     * ⚠ **2 回数えても壊れない**(変異試験で確認 ── `<input id>` と `<label for>` は
     * どちらも `buildRenderableBlockHtml` の中で同じ引数から作るので対応は崩れず、
     * 鍵に中身が入っているので衝突もしない)。1 度にするのは**数が「何番目か」の
     * 意味を保つ**ためで、安全性の根拠ではない ── ここに「2 回数えると壊れる」と
     * 書くのは嘘になる。
     */
    const occurrence = nextFenceOccurrence(env, fence.lang, content);
    const slot = buildRenderableSlotHtml(
      fence,
      content,
      inlineRender,
      occurrence,
      (env as { allowExternalImages?: boolean } | undefined)?.allowExternalImages === true,
      firstContentLine,
    );
    if (slot !== null) {
      return buildRenderableBlockHtml(fence, slot, content, sourceLineAttrs, occurrence);
    }
    // csv 系 parse 失敗:従来どおり user のソースを可視で残す。
    return wrapWithCopyButton(renderFenceSourceHtml(content, fence.lang), 'code', sourceLineAttrs);
  }
}

/**
 * 🔴 **添付から取った中身で囲みを描く**(#444 段①)── adapter の hydrator が呼ぶ。
 *
 * ⚠ **registry の外(素のコード囲み)もここで描く** ── 本文の rule は
 *   markdown-it の `defaultFence` を通すが、そこは token を要るので単独では
 *   呼べない。⚠ **同じ見た目になること**は
 *   `tests/features/fence-asset.test.ts` の parity 検査が pin する
 *   (書き写しである以上、片方だけ古くなるのを機械で止める)。
 * ⚠ `env` は**使い捨て**にする ── 文書の env を渡すと脚注が混ざる
 *   (2026-08-06 の事故。上の `cellEnv` の註記と同じ理由)。
 */
export function renderFenceFromAsset(
  info: string,
  content: string,
  /**
   * 🔴 **1 回の埋め込みでは 1 つの object を使い回す**(着地前の自己レビューで判明)。
   *
   * ⚠ `-both`(既定)の切替 id は「**同じ(言語, 中身)の中で何番目か**」から作る。
   *   その数を憶えているのは**この object** なので、囲みごとに新しい object を渡すと
   *   常に「0 番目」になり、**同じ囲みを 2 つ書くと id が衝突する**
   *   ── 片方の `‹/›` を押すともう片方が開く。
   * 🔑 本文の経路(`renderMarkdown`)は 1 回の描画で env を 1 つ作って共有している ──
   *   ここもそれに揃える(規則を 2 つにしない)。
   */
  env: { currentContainerId?: string; allowExternalImages?: boolean } = {},
): string {
  content = asFenceContent(content);
  const fence = parseRenderableFence(info);
  if (fence) return renderRenderableFence(fence, content, '', env);
  const lang = (info.trim().split(/\s+/)[0] ?? '').toLowerCase();
  const cls = lang === '' ? '' : ` class="language-${escapeHtmlAttr(lang)}"`;
  /**
   * ⚠ **末尾の改行まで真似る** ── markdown-it の既定の `fence` renderer は
   *   `</pre>` のあとに `\n` を出す。parity 検査(`tests/features/fence-asset.test.ts`)が
   *   **この 1 バイトの差で落ちて教えた**(書き写しは必ずどこかがずれる)。
   */
  return wrapWithCopyButton(
    `<pre><code${cls}>${highlightCode(content, lang)}</code></pre>\n`,
    'code',
  );
}

// PR #196: table copy button overlay. Wraps the entire <table>…</table>
// in a `<div class="pkc-md-block">` carrying the copy button. The
// button reads the rendered table cell text on click (via
// action-binder) and writes both `text/plain` (TSV) and `text/html`
// (the table's own HTML) to the clipboard via `copyMarkdownAndHtml`-
// style multi-MIME write.
md.renderer.rules.table_open = function (tokens, idx, options, _env, self) {
  // 領域 10-1 PR 2 hotfix: also propagate source-line attrs onto the
  // pkc-md-block wrapper so caret-on-table-line activates the wrapper
  // visually (the inner <table> still carries its own attrs through
  // self.renderToken). The wrapper appearing first in DOM order means
  // querySelectorAll('[data-pkc-source-line]') sees it before the
  // <table> — fine for active-block lookup since both anchors share
  // the same source range.
  const token = tokens[idx]!;
  const sourceLineAttrs = collectSourceLineAttrs(token);
  return `<div class="pkc-md-block" data-pkc-md-block-kind="table"${sourceLineAttrs}><button class="pkc-md-copy-btn" data-pkc-action="copy-md-block" data-pkc-copy-kind="table" type="button" aria-label="コピー" title="コピー">⧉</button>${self.renderToken(tokens, idx, options)}`;
};
md.renderer.rules.table_close = function (tokens, idx, options, _env, self) {
  return `${self.renderToken(tokens, idx, options)}</div>`;
};

/**
 * PR #196: wrap a code block's HTML in a copy-button host. The button
 * carries `data-pkc-action="copy-md-block"` so the existing
 * `action-binder` event delegation picks it up. The host element is
 * `position: relative` so the button can sit absolutely top-right.
 *
 * 領域 10-1 PR 2 hotfix: optional `extraAttrs` carries the source-line
 * attribute string (e.g. ' data-pkc-source-line="5" data-pkc-source-end="13"')
 * built from the originating token. Custom fence / table renderers
 * emit their own HTML and bypass token.attrs, so the wrapper has to
 * propagate these attrs explicitly for source ↔ preview sync to work.
 */
function wrapWithCopyButton(
  innerHtml: string,
  kind: 'code' | 'table',
  extraAttrs: string = '',
): string {
  return `<div class="pkc-md-block" data-pkc-md-block-kind="${kind}"${extraAttrs}><button class="pkc-md-copy-btn" data-pkc-action="copy-md-block" data-pkc-copy-kind="${kind}" type="button" aria-label="コピー" title="コピー">⧉</button>${innerHtml}</div>`;
}

/**
 * Build a `data-pkc-source-line` / `data-pkc-source-end` attribute
 * string from raw values. Token-agnostic — designed to be re-used by
 * future renderer paths that don't go through markdown-it (領域 10-3
 * 内部 IR、PKC-Message dispatch to extension, etc.). Returns '' when
 * `start` is null/undefined so callers can splice the result
 * unconditionally.
 *
 * Internally this is the kernel of the source-line anchor contract:
 * **the only HTML output that matters for the source ↔ preview sync
 * layer is the attribute string itself**, regardless of which renderer
 * produced it. Keeping this generic now means the hypothetical IR
 * walker (領域 10-3) can call `makeSourceLineAttrs(node.startLine,
 * node.endLine)` directly — no markdown-it Token shim required.
 */
export function makeSourceLineAttrs(
  start: number | string | null | undefined,
  end?: number | string | null | undefined,
): string {
  if (start === null || start === undefined) return '';
  let out = ` data-pkc-source-line="${start}"`;
  if (end !== null && end !== undefined) {
    out += ` data-pkc-source-end="${end}"`;
  }
  return out;
}

/**
 * Collect `data-pkc-source-line` / `data-pkc-source-end` attrs from a
 * markdown-it token (set by `tagSourceLines`) into an attr string.
 *
 * **Public — extension contract for markdown-it custom renderers**.
 * `tagSourceLines` writes the source-line anchor pair onto block-level
 * tokens via `token.attrSet`. The default markdown-it renderer copies
 * `token.attrs` onto the rendered element automatically — but **custom
 * renderers that emit their own HTML string bypass that copy**, so the
 * source-line attrs are silently dropped and the source ↔ preview
 * sync layer cannot find the block.
 *
 * Any custom renderer registered on `md.renderer.rules.<token>` MUST
 * call `collectSourceLineAttrs(token)` and splice the result onto the
 * **outermost element** of its emitted HTML. The 領域 10-1 PR 2
 * hotfix established this contract for `fence` (CSV-to-table) and
 * `table_open` (copy-button wrapper); future renderer additions
 * (e.g. clickable image / ToC / per-archetype embed) MUST follow the
 * same pattern.
 *
 * Pattern:
 *
 * ```ts
 * md.renderer.rules.my_block = function (tokens, idx, options, env, self) {
 *   const token = tokens[idx]!;
 *   const sourceLineAttrs = collectSourceLineAttrs(token);
 *   return `<div class="my-wrapper"${sourceLineAttrs}>...</div>`;
 * };
 * ```
 *
 * The opt-in flag `RenderMarkdownOptions.sourceLineAnchors` controls
 * whether the upstream `tagSourceLines` runs at all — view-mode
 * rendering skips it for backwards compatibility, so this helper
 * returns `''` when no anchors were stamped (silent no-op, safe).
 *
 * Internally a thin wrapper around `makeSourceLineAttrs(start, end)`
 * — that primitive is reusable by future non-markdown-it renderers
 * (領域 10-3 IR, PKC-Message extension dispatch, etc.).
 *
 * See `PKC2: docs/development/markdown-render-scope.md` §「拡張時の
 * source-line anchor 規約」for the full extension contract.
 */
export function collectSourceLineAttrs(token: Token): string {
  return makeSourceLineAttrs(
    token.attrGet('data-pkc-source-line'),
    token.attrGet('data-pkc-source-end'),
  );
}

/**
 * 🔴 **属性を「文字列として」読む唯一の口**(markdown-it v15 移行、#78)。
 *
 * ⚠ v15 で属性値の型が `string` から **`string | number`** へ広がった
 * (`attrSet(name, 3)` が型として許される)。PKC の描画側は href / src /
 * title を**全部文字列として**扱う(`startsWith` / `slice` / エスケープ)ので、
 * 広がった型がそのまま流れると **tsc が 12 か所で落ちる**。
 *
 * 🔑 **`String(...)` を 12 か所へ散らさない** ── 読み口を 1 つに寄せる
 * (CLAUDE.md §7「同じ判定が複数の場所にある」)。
 *
 * ⚠ **`String(...)` は型のための備えであって、いま実行時に効く経路は無い**
 * (変異試験 M3 = 文字列化をやめる変異は **SURVIVED**)。href / src / title は
 * parser が文字列で積むもので、PKC 自身は `attrSet` に数を渡さない。
 * 🔑 だから「これが無いと壊れる」とは**書かない** ── 効くのは
 * 「将来 plugin が数を積んだとき」だけである(CLAUDE.md §1、no-op に因果を書かない)。
 *
 * 🔴 **効くのは `null` を保つほう**(こちらは変異試験 M2 が実害を示した)。
 * ⚠ `?? ''` に畳むと「属性が無い」と「空文字の属性」が区別できなくなり、
 * 題を書いていない添付画像に **`title=""` が全部付く**。
 * pin は `tests/features/asset-ref-render.test.ts`。
 */
function attrString(token: Token, name: string): string | null {
  const v = token.attrGet(name);
  return v === null ? null : String(v);
}

md.renderer.rules.link_open = function (tokens, idx, options, env, self) {
  const token = tokens[idx]!;
  const href = attrString(token, 'href') ?? '';
  // `entry:` links stay in-app: they are routed through
  // `action-binder`'s `navigate-entry-ref` handler which parses the
  // fragment via `parseEntryRef` and scrolls to the right
  // `<section id="day-...">`, `<article id="log-...">`, or heading
  // slug anchor. Adding `target="_blank"` here would pop a new tab
  // for every in-app jump; `rel="noopener noreferrer"` is also
  // unnecessary for a link that never actually navigates. The
  // `data-pkc-entry-ref` attribute carries the raw href so the
  // handler can read the unescaped original (the parser accepts
  // the same grammar formatted by `formatEntryRef`).
  if (href.startsWith('asset:')) {
    // P4b: `[label](asset:key)` はダウンロード導線。href は**剥がす**──
    // binder の click delegation は preventDefault しないので、href を残すと
    // ブラウザが `asset:` へのナビゲーションを試みる。href 無し `<a>` は
    // ナビゲートしない(P4a の attachment DL ボタンと同じ action に載せる)
    const key = href.slice('asset:'.length);
    const hIdx = token.attrIndex('href');
    if (hIdx >= 0) token.attrs!.splice(hIdx, 1);
    // DL ファイル名はラベル文字列(挿入時の既定はファイル名)。空なら key
    let label = '';
    for (let j = idx + 1; j < tokens.length; j++) {
      const t = tokens[j]!;
      if (t.type === 'link_close') break;
      if (t.type === 'text' || t.type === 'code_inline') label += t.content;
    }
    const cls = token.attrGet('class');
    token.attrSet('class', cls ? `${cls} pkc-asset-link` : 'pkc-asset-link');
    token.attrSet('data-pkc-action', 'download-asset');
    token.attrSet('data-pkc-asset-key', key);
    token.attrSet('data-pkc-asset-name', label || key);
  } else if (href.startsWith('entry:')) {
    token.attrSet('data-pkc-action', 'navigate-entry-ref');
    token.attrSet('data-pkc-entry-ref', href);
  } else if (href.startsWith('pkc:')) {
    // Portable PKC Reference — spec/pkc-link-unification-v0.md §5.5
    // (post-correction). Despite the historical name, `pkc://` is
    // NOT a permalink (no OS protocol handler, not clickable in
    // external apps). It is the **machine identifier form** used
    // by paste conversion / cross-PKC marshalling.
    //
    // Paste conversion normally demotes same-container Portable
    // References to `entry:` / `asset:` internal refs, so any
    // `pkc://` that lands in a rendered body is almost always
    // cross-container. We tag it with placeholder data-attributes
    // so CSS can render it as a portable-reference badge, and
    // keep the raw href so a future resolver (P2P / import / share
    // UI) can pick it up verbatim.
    //
    // Malformed `pkc://...` values fall back to the default
    // external-link treatment below so the body isn't silently
    // suppressed.
    const parsed = parsePortablePkcReference(href);
    const rawEnv = (env ?? {}) as { currentContainerId?: unknown };
    const currentContainerId =
      typeof rawEnv.currentContainerId === 'string' ? rawEnv.currentContainerId : '';
    /**
     * 🔴 同一コンテナの携帯参照は 2 種(#100)── entry は `navigate-entry-ref`、
     * asset は `navigate-asset-ref`(段②、2026-08-14)。⚠ 受け手の無い action を
     * 焼くと #97 の `preventDefault` に当たって**無言の dead click**になるため、
     * 段②までは asset 枝を閉じていた(枝と受け手は同じ PR で開ける)。
     * cross-container は今までどおり札(`pkc-portable-reference-placeholder`)。
     */
    const sameContainer =
      parsed !== null && currentContainerId !== '' && parsed.containerId === currentContainerId;
    if (sameContainer && parsed!.kind === 'asset') {
      /**
       * 🔴 同一コンテナの添付参照(#100 段②)── **所有ノートへ飛ぶ**。
       * 受け手は binder の `navigate-asset-ref`(storage worker の
       * `findAssetOwner` で key → lid を引く)。⚠ 段②が入るまでは
       * 「受け手の無い action を焼くと無言の dead click になる」ため
       * この枝を閉じていた ── 受け手と**同じ PR で**開けている。
       */
      token.attrSet('data-pkc-action', 'navigate-asset-ref');
      token.attrSet('data-pkc-asset-ref', parsed!.targetId);
      token.attrSet('rel', 'noopener noreferrer');
    } else if (sameContainer && parsed!.kind === 'entry') {
      // Same-container Portable Reference fallback rendering
      // (spec/pkc-link-unification-v0.md §5.5). Paste conversion
      // normally demotes `pkc://<self>/...` to `entry:<lid>`
      // before the body ever reaches the renderer, but a writer
      // can also type the portable form by hand, or an older
      // import can leave it in place. When that happens we make
      // the anchor behave exactly like the equivalent `entry:`
      // internal reference so the click path stays consistent:
      //
      //   pkc://<self>/entry/<lid>           → entry:<lid>
      //   pkc://<self>/entry/<lid>#log/xyz   → entry:<lid>#log/xyz
      //
      // Entry portable references route through
      // `navigate-entry-ref` (same handler that services `entry:`
      // anchors). Asset portable references route through the new
      // `navigate-asset-ref` handler (Phase 1 step 4 / audit G3),
      // which hops to the attachment entry whose `body.asset_key`
      // matches — mirroring the External Permalink receive
      // behaviour for `&asset=<key>`.
      //
      //   pkc://<self>/entry/<lid>           → entry:<lid>
      //   pkc://<self>/entry/<lid>#log/xyz   → entry:<lid>#log/xyz
      //   pkc://<self>/asset/<key>           → owner attachment entry
      const frag = parsed!.fragment ?? '';
      token.attrSet('data-pkc-action', 'navigate-entry-ref');
      token.attrSet('data-pkc-entry-ref', `entry:${parsed!.targetId}${frag}`);
      token.attrSet('rel', 'noopener noreferrer');
    } else if (parsed) {
      // Cross-container (or currentContainerId is unknown — treat
      // as cross for safety): emit the portable-reference placeholder.
      const cls = token.attrGet('class');
      const placeholderClass = 'pkc-portable-reference-placeholder';
      token.attrSet('class', cls ? `${cls} ${placeholderClass}` : placeholderClass);
      token.attrSet('data-pkc-portable-container', parsed.containerId);
      token.attrSet('data-pkc-portable-kind', parsed.kind);
      token.attrSet('data-pkc-portable-target', parsed.targetId);
      if (parsed.fragment !== undefined) {
        token.attrSet('data-pkc-portable-fragment', parsed.fragment);
      }
      token.attrSet(
        'title',
        `Portable PKC ${parsed.kind} · container ${parsed.containerId} · target ${parsed.targetId}`,
      );
      token.attrSet('rel', 'noopener noreferrer');
    } else {
      // Malformed pkc:// — treat as ordinary external URL.
      token.attrSet('target', '_blank');
      token.attrSet('rel', 'noopener noreferrer');
    }
  } else if (href.startsWith('#')) {
    // 🔴 **文書内アンカーは外部リンクではない**(2026-08-05、user 報告から判明)。
    //
    // 直す前は「`entry:` / `pkc:` / `asset:` 以外は全部外部」という前提で
    // `target="_blank"` を立てており、`[見出しへ](#anchor)` を押すと
    // **2 枚目のタブが開いて**、PKC3 の単一タブ保護
    // (`docs/manual.md`「🔴 タブは 1 つだけ」/ writer lease)に突き当たっていた。
    // 実測:クリックで pages 1 → 2 になり、2 枚目は
    // 「別のタブで開いています。そのタブを閉じると、ここで続きが開きます…」で止まる。
    //
    // ⚠ `rel` も付けない ── 同一文書内の移動に noopener は意味を持たない。
    // ⚠ 判定は `#` 始まりだけに**狭く**当てる。相対パス(`./` `../`)は
    //    このアプリでは意味を持たない(単一 HTML / Pages 配信)ので、
    //    外部扱いのままにしておく方が安全側である。
  } else {
    token.attrSet('target', '_blank');
    token.attrSet('rel', 'noopener noreferrer');
  }
  return defaultLinkOpen(tokens, idx, options, env, self);
};

// ── Entry transclusion placeholder (Slice 5-B) ────────
//
// `![alt](entry:<lid>[#frag])` is the transclusion syntax. markdown-it
// would otherwise emit `<img src="entry:...">` and the browser would
// try to load it as a real image (404'ing and cluttering the console).
// Instead, the image rule below detects the `entry:` scheme and emits
// an inert `<div class="pkc-transclusion-placeholder">`.
//
// 🔴 **展開する側は、まだ在りません**(#397 ②、2026-08-25 に訂正)。
// ⚠ ここには「adapter-layer expander (`adapter/ui/transclusion.ts`) later replaces
//    with the actual embed HTML」と**現在形で、file 名まで名指しして**書いてありましたが、
//    **その file は存在しません**(`grep -rn "pkc-transclusion-placeholder"` の hit は
//    この file 自身と `styles/app.css` の空状態の見た目だけ)。
// 🔴 「未実装」より悪い形でした ── 次に読む人は「在るもの」として設計します。
// 🔑 いまの実物の挙動: **空の器が残る**(本文には何も出ない)。
//    ⚠ この記法は `docs/manual.md` に 1 度も出てこないので、踏む user はほぼ居ません。
//    展開する側を作るかどうかは #397 ② で決めます(作るなら循環参照の門が要る)。
//
// Why a `<div>` (not a `<span>`): the expanded content is block-level
// (day-grouped articles for TEXTLOG, paragraphs for TEXT). markdown-it
// emits the image inside a `<p>`, so the browser's HTML parser will
// auto-close the paragraph when it encounters the div, leaving an
// empty `<p></p>` behind. ⚠ **いまは誰も掃除しません**(展開する側が無いので)──
// 展開する側を作るときに、その空 `<p>` を消すところまで含めてください。
//
// The raw `entry:` href is preserved in `data-pkc-embed-ref` verbatim
// so a future expander can re-parse it via `parseEntryRef` (same grammar
// as `navigate-entry-ref`). The `alt` text is preserved in
// `data-pkc-embed-alt` and is used by the fallback path (broken /
// unsupported refs) as visible placeholder text.
//
// HTML attribute escaping: markdown-it's `escapeHtml` quotes `"`, `&`,
// `<`, `>`, which is exactly what we need for attribute values.
const defaultImage =
  md.renderer.rules.image ??
  function (tokens, idx, options, _env, self) {
    return self.renderToken(tokens, idx, options);
  };

md.renderer.rules.image = function (tokens, idx, options, env, self) {
  const token = tokens[idx]!;
  const src = attrString(token, 'src') ?? '';
  if (src.startsWith('asset:')) {
    // P4b: `![alt](asset:key)` は **src 無し** placeholder(hydrator が
    // lend した blob: URL を後から差す)。`src="asset:…"` を出すと
    // ブラウザが即 fetch を試みて console を汚す(entry: transclusion と
    // 同じ理由)。alt はそのまま保持 ── missing 時の可視 fallback を兼ねる
    const key = src.slice('asset:'.length);
    const alt = token.content ?? '';
    const title = attrString(token, 'title');
    return (
      `<img class="pkc-asset-ref"` +
      ` data-pkc-asset-key="${escapeHtmlAttr(key)}"` +
      ` alt="${escapeHtmlAttr(alt)}"` +
      (title !== null ? ` title="${escapeHtmlAttr(title)}"` : '') +
      ` loading="lazy" decoding="async"` +
      `${collectSourceLineAttrs(token)}>`
    );
  }
  if (src.startsWith('entry:')) {
    // markdown-it stashes the alt text on token.content by the time
    // the renderer runs (inline children were already linearized).
    const alt = token.content ?? '';
    const srcEsc = escapeHtmlAttr(src);
    const altEsc = escapeHtmlAttr(alt);
    return (
      `<div class="pkc-transclusion-placeholder"` +
      ` data-pkc-embed-ref="${srcEsc}"` +
      ` data-pkc-embed-alt="${altEsc}"></div>`
    );
  }
  // メモリ:画面外画像のデコード後ビットマップ常駐を抑えるため、描画 <img> を
  // 遅延ロード + 非同期デコードにする(data-safe、描画ヒントのみで本文・データ・
  // 契約は不変)。長い image-heavy ドキュメントで viewport 外画像のデコードを
  // 後回しにし、RAM を削る。明示指定があれば尊重。
  if (token.attrGet('loading') === null) token.attrSet('loading', 'lazy');
  if (token.attrGet('decoding') === null) token.attrSet('decoding', 'async');
  /**
   * 🔴 **外部の画像は既定で読み込まない**(2026-08-06、user 裁定)。
   *
   * `![](https://例/x.png)` は開いた瞬間に相手へ「この端末がいまこれを開いた」を
   * 伝える(追跡用の画像)。⚠ **`src` を消して `data-pkc-external-src` に退避する**
   * だけにする ── 消してしまうと同意が出ても復元できず、`src` を残すと
   * `loading="lazy"` でも**画面に入った瞬間に飛ぶ**(遅延は「飛ばない」ではない)。
   * ⚠ 器は残す ── 見えない場所で消すと「画像を書いたのに何も無い」になる。
   *   見た目は `.pkc-external-img:not([src])`(`app.css` と書出し HTML の両面)。
   * 意味論の正本は `features/markdown/external-images.ts`。
   */
  const allowExternal = (env as { allowExternalImages?: boolean } | undefined)
    ?.allowExternalImages === true;
  if (!allowExternal && isExternalImageSrc(src)) {
    const srcAttrIdx = token.attrIndex('src');
    if (srcAttrIdx >= 0) token.attrs!.splice(srcAttrIdx, 1);
    token.attrSet(EXTERNAL_IMAGE_ATTR, src);
    token.attrJoin('class', EXTERNAL_IMAGE_CLASS);
  }
  return defaultImage(tokens, idx, options, env, self);
};

function escapeHtmlAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}


// ── L-2 (2026-05-07、wave-10-2 Phase 1):Inline 修飾 ──
//
// 3 つの新 inline syntax を markdown-it の inline ruler に登録:
//   - `==text==` → <mark>text</mark>(highlight)
//   - `==[red]text==` → <mark style="background-color:red">text</mark>
//   - `[[ruby:base|reading]]` → <ruby>base<rt>reading</rt></ruby>
//   - `[[em:text]]` → <em class="pkc-em-dot">text</em>(圏点)
//
// Code span / fence 内では markdown-it が code を先に tokenize するため、
// 我々の inline rule は適用されない(自然な escape)。
//
// Inner content への inline markup は Phase 1 では非対応(plain text)、
// 必要に応じて Phase 2 で再帰 tokenize 検討。

const HIGHLIGHT_COLOR_RE = /^\[([a-zA-Z][a-zA-Z0-9-]*|#[0-9a-fA-F]{3,8}|rgb\([\d.,\s]+\)|rgba\([\d.,\s]+\))\]([\s\S]+)$/;

md.inline.ruler.after('emphasis', 'pkc_highlight', function highlightRule(state, silent) {
  if (silent) return false;
  const src = state.src;
  const start = state.pos;
  // == 開始判定
  if (src.charCodeAt(start) !== 0x3D || src.charCodeAt(start + 1) !== 0x3D) return false;
  // 前文字が = だと strikethrough や別パターンと衝突しうるので skip
  if (start > 0 && src.charCodeAt(start - 1) === 0x3D) return false;
  // 終端 == を探す
  let closeIdx = -1;
  for (let i = start + 2; i < state.posMax - 1; i++) {
    if (src.charCodeAt(i) === 0x0A /* \n */) return false; // 改行を跨がない
    if (src.charCodeAt(i) === 0x3D && src.charCodeAt(i + 1) === 0x3D) {
      closeIdx = i;
      break;
    }
  }
  if (closeIdx < 0) return false;
  const content = src.slice(start + 2, closeIdx);
  if (!content || /^\s|\s$/.test(content)) return false;  // leading/trailing space NG
  // Optional [color] prefix
  let color: string | null = null;
  let prefixLen = 0;
  const colorMatch = HIGHLIGHT_COLOR_RE.exec(content);
  if (colorMatch) {
    color = colorMatch[1]!;
    const matchedAll = colorMatch[0]!;
    const matchedRest = colorMatch[2]!;
    prefixLen = matchedAll.length - matchedRest.length;
    // PKC3: `content = matchedRest` は死代入だった(nested tokenize は pos 範囲で
    // 動き content を読まない)ため削除。挙動は golden parity で担保
  }
  const tokenOpen = state.push('mark_open', 'mark', 1);
  if (color) tokenOpen.attrSet('style', `background-color: ${color};`);
  // reform-2026-05 hotfix(2026-05-10、user 報告):content を **nested inline
  // parse** で tokenize し、`==[red]**126,853**==` の中で `**bold**` 等 commonmark
  // markup を効かせる。Phase 1 plain-text 制約を highlight だけ先行解除。
  // 仕組み:state.pos / posMax を一時的に content 範囲に切り替えて
  // state.md.inline.tokenize で再帰的に inline rule 全部を走らせる。
  const oldPos = state.pos;
  const oldPosMax = state.posMax;
  state.pos = start + 2 + prefixLen;
  state.posMax = closeIdx;
  state.md.inline.tokenize(state);
  state.pos = oldPos;
  state.posMax = oldPosMax;
  state.push('mark_close', 'mark', -1);
  state.pos = closeIdx + 2;
  return true;
});

md.inline.ruler.after('emphasis', 'pkc_ruby', function rubyRule(state, silent) {
  if (silent) return false;
  const src = state.src;
  const start = state.pos;
  if (!src.startsWith('[[ruby:', start)) return false;
  const closeIdx = src.indexOf(']]', start + 7);
  if (closeIdx < 0) return false;
  const content = src.slice(start + 7, closeIdx);
  if (content.includes('\n')) return false;
  const sepIdx = content.indexOf('|');
  if (sepIdx <= 0 || sepIdx >= content.length - 1) return false;
  const base = content.slice(0, sepIdx);
  const reading = content.slice(sepIdx + 1);
  if (!base || !reading) return false;
  state.push('ruby_open', 'ruby', 1);
  const tokenBase = state.push('text', '', 0);
  tokenBase.content = base;
  state.push('rt_open', 'rt', 1);
  const tokenReading = state.push('text', '', 0);
  tokenReading.content = reading;
  state.push('rt_close', 'rt', -1);
  state.push('ruby_close', 'ruby', -1);
  state.pos = closeIdx + 2;
  return true;
});

md.inline.ruler.after('emphasis', 'pkc_em_dot', function emDotRule(state, silent) {
  if (silent) return false;
  const src = state.src;
  const start = state.pos;
  if (!src.startsWith('[[em:', start)) return false;
  const closeIdx = src.indexOf(']]', start + 5);
  if (closeIdx < 0) return false;
  const content = src.slice(start + 5, closeIdx);
  if (!content || content.includes('\n')) return false;
  const tokenOpen = state.push('em_dot_open', 'em', 1);
  tokenOpen.attrSet('class', 'pkc-em-dot');
  const tokenText = state.push('text', '', 0);
  tokenText.content = content;
  state.push('em_dot_close', 'em', -1);
  state.pos = closeIdx + 2;
  return true;
});

// reform-2026-05 hotfix(2026-05-09):em-dot の **新形** `^^text^^`。
// v2 AI spec で promise した形(simple 記法、`[[em:..]]` の短縮 deprecated 後継)。
// `^^` 連続を delimiter として、内部に改行 / `^` を含まないこと。
// 空 content は reject(literal `^^^^` を圏点扱いしない)。
//
// 2026-05-10 hotfix 1(user バグレポ):従来 content を plain text として push して
// いたため `^^**X**^^` の inner emphasis が処理されず literal `**X**` が残った。
// pushNestedInlineContent で markdown-it inline parser に通すように変更、
// `^^**bold**^^` `^^==hl==^^` 等 nested inline markup が正常 render。
//
// 2026-05-10 hotfix 2(user バグレポ続報):asymmetric `*X**` / `**X*`(user typo
// で AI 生成にも頻出)を tolerant に `**X**` に正規化する。em-dot 内 context 限定
// で適用、外側 markdown には影響しない。`***X***`(triple)は normalize せず
// markdown-it の標準 strong+em 処理に任せる。

/**
 * em-dot 内 content の asymmetric `*X**` / `**X*` を `**X**` に正規化(tolerant)。
 * 外側 markdown には影響しない em-dot scope 限定処理。
 *
 *   `*X**`  → `**X**`(single open + double close)
 *   `**X*`  → `**X**`(double open + single close)
 *   `*X*`   → そのまま(emphasis、normalize しない)
 *   `**X**` → そのまま(bold、すでに正しい)
 *   `***X***` → そのまま(markdown 標準 strong+em)
 */
function normalizeAsymmetricEmphasis(content: string): string {
  // *X** → **X**(content に `*` 無し、前後に余分な `*` 無し)
  let normalized = content.replace(
    /(^|[^*])\*([^*\n]+?)\*\*(?!\*)/g,
    '$1**$2**',
  );
  // **X* → **X**(content に `*` 無し、前後に余分な `*` 無し)
  normalized = normalized.replace(
    /(^|[^*])\*\*([^*\n]+?)\*(?!\*)/g,
    '$1**$2**',
  );
  return normalized;
}

md.inline.ruler.after('pkc_em_dot', 'pkc_em_dot_caret', function emDotCaretRule(state, silent) {
  if (silent) return false;
  const src = state.src;
  const start = state.pos;
  if (src.charCodeAt(start) !== 0x5e /* ^ */) return false;
  if (src.charCodeAt(start + 1) !== 0x5e /* ^ */) return false;
  // 直後が ^(`^^^` 形)なら figure caption marker と曖昧、reject
  if (src.charCodeAt(start + 2) === 0x5e /* ^ */) return false;
  const closeIdx = src.indexOf('^^', start + 2);
  if (closeIdx < 0) return false;
  const content = src.slice(start + 2, closeIdx);
  if (!content || content.includes('\n')) return false;
  // content 内に `^^` が複数あれば最初の close で取る(non-greedy)
  const tokenOpen = state.push('em_dot_open', 'em', 1);
  tokenOpen.attrSet('class', 'pkc-em-dot');
  // inner content を markdown-it inline parser に通す(nested **X** / *X* /
  // ==X== / `X` 等が処理される。2026-05-10 user バグレポ修正)。
  // asymmetric `*X**` / `**X*` は tolerant に `**X**` 正規化(em-dot scope 限定)。
  const normalized = normalizeAsymmetricEmphasis(content);
  pushNestedInlineContent(state, normalized);
  state.push('em_dot_close', 'em', -1);
  state.pos = closeIdx + 2;
  return true;
});

// ── PR-E (reform-2026-05、Phase 1):formal inline role `:role:[content]{attrs}` ──
//
// Spec §1.3:AI / 機械が emit する厳密形 inline markup。
//
// 受理する形(parser 詳細は src/features/markdown/inline-role-parser.ts):
//
//   :sup:[2]                  → <sup>2</sup>
//   :sub:[n]                  → <sub>n</sub>
//   :span:[hi]{class=warn}    → <span class="warn">hi</span>
//
// 衝突回避:L-6 simple-inline `:text:attrs:` より先に試行する(`:role:` の後に
// `[` または `{` がある場合のみ match、それ以外は L-6 へ fall-through)。
//
// Phase 1 で対応する role:`sup` / `sub` / `span` の 3 つ。content は plain
// text として push(L-6 と同じ Phase 1 制約)、nested markdown は後続 PR で。
//
// `span` の attrs:
//   - id    ── slug-safe な英字 / 数字 / `-` / `_`(parseBlockDirectiveAttrs で valid 化済)
//   - class ── HTML 安全な class 名(同上)
//   - data-* ── 任意の data attribute、value は HTML escape
//   - その他 ── 既知ホワイトリスト外は無視(XSS 対策、style / on* は受理しない)

// reform-2026-05 Phase 2 PR-2B(2026-05-10):commonmark inline 修飾の formal 等価
// (`:strong:[]` ↔ `**`、`:emphasis:[]` ↔ `*`、`:code:[]` ↔ `` ` ``、
// `:strike:[]` ↔ `~~`)を inline role として実装。AI / serializer が IR-driven
// emit する時の formal 形として spec 完全実装。content は nested inline parse
// で commonmark equivalent との完全互換(`:strong:[**bold**]` も nested 効く)。
const INLINE_ROLE_KNOWN = new Set([
  'sup', 'sub', 'span',
  // PR-2B formal commonmark 等価
  'strong', 'emphasis', 'code', 'strike',
]);
// span に許容する HTML attribute(id / class / data-* 以外)
const SPAN_SAFE_ATTRS = new Set(['title', 'lang', 'dir']);

// commonmark 等価 role → 出力 HTML tag
const COMMONMARK_ROLE_TAG: Record<string, string> = {
  strong: 'strong',
  emphasis: 'em',
  code: 'code',
  strike: 's',
};

function pushInlineRoleTokens(
  state: Parameters<Parameters<typeof md.inline.ruler.before>[2]>[0],
  match: InlineRoleMatch,
): boolean {
  const role = match.role;
  if (!INLINE_ROLE_KNOWN.has(role)) return false;
  // reform-2026-05 Phase 2 PR-2J:multi-line `[content]` の場合、先頭末尾の
  // 改行 / whitespace を trim(`:emphasis:[\n本文\n]` を `:emphasis:[本文]` 等価に正規化)。
  const content = (match.content ?? '').replace(/^[\s\n]+|[\s\n]+$/g, '');

  if (role === 'sup' || role === 'sub') {
    const tag = role; // 'sup' or 'sub'
    state.push(`pkc_${role}_open`, tag, 1);
    const t = state.push('text', '', 0);
    t.content = content;
    state.push(`pkc_${role}_close`, tag, -1);
    return true;
  }

  // PR-2B:commonmark 等価 role(strong / emphasis / code / strike)
  if (role in COMMONMARK_ROLE_TAG) {
    const tag = COMMONMARK_ROLE_TAG[role]!;
    if (role === 'code') {
      // code は内容を nested parse しない(`<code>` content は plain text)
      state.push(`pkc_role_${role}_open`, tag, 1);
      const t = state.push('text', '', 0);
      t.content = content;
      state.push(`pkc_role_${role}_close`, tag, -1);
      return true;
    }
    // strong / emphasis / strike は content を nested inline parse(commonmark 等価)
    state.push(`pkc_role_${role}_open`, tag, 1);
    pushNestedInlineContent(state, content);
    state.push(`pkc_role_${role}_close`, tag, -1);
    return true;
  }

  // role === 'span'
  const open = state.push('pkc_inline_role_span_open', 'span', 1);
  if (match.attrs.id) open.attrSet('id', match.attrs.id);
  if (match.attrs.classes.length > 0) {
    open.attrSet('class', match.attrs.classes.join(' '));
  } else if (typeof match.attrs.kvs.class === 'string') {
    open.attrSet('class', match.attrs.kvs.class);
  }
  for (const [k, v] of Object.entries(match.attrs.kvs)) {
    if (k === 'class') continue;
    if (typeof v !== 'string') continue;
    if (k.startsWith('data-')) {
      open.attrSet(k, v);
      continue;
    }
    if (SPAN_SAFE_ATTRS.has(k)) {
      open.attrSet(k, v);
    }
    // unknown attrs(style / on* 等)は silent skip
  }
  const t = state.push('text', '', 0);
  t.content = content;
  state.push('pkc_inline_role_span_close', 'span', -1);
  return true;
}

/**
 * Nested inline content を完全 parse(tokenize + postprocess emphasis pairing)
 * して state.tokens に push。`**bold**` 等の delimiter が role 内で正しく
 * <strong> に解決される。
 */
function pushNestedInlineContent(
  state: Parameters<Parameters<typeof md.inline.ruler.before>[2]>[0],
  content: string,
): void {
  if (!content) return;
  const innerTokens: typeof state.tokens = [];
  // markdown-it の inline.parse(src, md, env, outTokens)で完全 parse
  // (tokenize + emphasis pairing 解決 + postProcess 全部走る)
  state.md.inline.parse(content, state.md, state.env, innerTokens);
  // inline.parse は inline 'token' を 1 個 push、その children に実 inline tokens
  // が入っている。children を bare で展開して state.tokens に追加する。
  for (const tok of innerTokens) {
    if (tok.type === 'inline' && Array.isArray(tok.children)) {
      for (const child of tok.children) {
        state.tokens.push(child);
      }
    } else {
      state.tokens.push(tok);
    }
  }
}

md.inline.ruler.before('emphasis', 'pkc_inline_role', function inlineRoleRule(state, silent) {
  if (silent) return false;
  if (state.src.charCodeAt(state.pos) !== 0x3A /* : */) return false;
  const match = parseInlineRoleAt(state.src, state.pos);
  if (!match) return false;
  // `:role:` だけで `[` も `{` も来ない場合は parser 側で null、ここに来た時点で必ず form OK
  if (!INLINE_ROLE_KNOWN.has(match.role)) return false;
  const ok = pushInlineRoleTokens(state, match);
  if (!ok) return false;
  state.pos += match.length;
  return true;
});

// ── L-6 (2026-05-07、wave-10-2 Phase 1):簡易 inline `:text:attrs:` ──
//
// Spec §4.3:`:<内容>:<attrs カンマ区切り>:` で <span> に attrs 適用。
//
// 例:
//   :太字かつ赤字:bold, red:        → <span style="font-weight:bold;color:red;">…</span>
//   :背景黒文字白:bg-black, white:   → <span style="background-color:black;color:white;">…</span>
//   :大きい:lg, italic:              → <span style="font-size:var(--fs-lg);font-style:italic;">…</span>
//
// vocabulary は §4.5 で統一(L-2 と整合):
//   - 強調:bold / italic / underline / strikethrough / code
//   - 色:CSS color name / `#hex` / `rgb(...)` / `rgba(...)`
//   - 背景色:`bg-<color>`
//   - サイズ:xs / sm / md / lg / xl(font-size 段階)
//   - font-family:serif / sans / mono
//
// 順不同、未知 attr が混じると false で fall through。
//
// 衝突回避:
//   - vocab 厳格化により `12:30:45` 等の非 attrs 文字列は誤発火しない
//   - code span / fenced 内では markdown-it が code を先に tokenize、適用されない





// 先頭は a-z(keyword / 色名)、`#`(hex 色)、または digit(`120%` / `1.5em` 等の size 値、`2xl` の vocab keyword 形)。
// `:120%:` のような size only attrs を許容するため digit + `%` を class に追加。
// 時刻 `12:30:45` 等の誤発火は parseSimpleInlineAttrs 側で keyword / color / size value のいずれにも該当しないため reject される(数値だけは valid attr にならない)。
// Q7(v4 spec §16、2026-05-25):separator 寛容化に合わせて leading whitespace も accept、
// `:text: bold red :` 等の padding 形を attrs として valid 化(空白区切り対応)。
const ATTRS_INNER_RE = /^\s*[a-zA-Z0-9#][a-zA-Z0-9\-,#()\s.%]*$/;



interface ParsedAttrs {
  valid: boolean;
  inlineStyle: string;
}


function parseSimpleInlineAttrs(attrsStr: string): ParsedAttrs {
  const tokens = splitAttrs(attrsStr);
  const styles = parseVocabularyTokensToStyles(tokens);
  if (!styles) return { valid: false, inlineStyle: '' };
  // canonical attrs 順:ABC sorted(v4 §1.4 diff-friendly、stack PR 6 で inline / block 統一)
  const inlineStyle = Object.entries(styles)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}: ${v}`)
    .join('; ');
  return { valid: true, inlineStyle };
}





/**
 * 🔴 **開きの次の行から、対応する閉じ `:::` の行番号を返す**(無ければ null)。
 *
 * 入れ子の深さを数えるので、中に別の `:::` が在っても取り違えない。
 * ⚠ **fence の中は数えない** ── コードブロックに書いた `:::` は記法ではない。
 * ⚠ 閉じが無いときは `null` を返す(呼び手は従来どおり「末尾まで飲む」)。
 */
function findMatchingClose(lines: readonly string[], from: number): number | null {
  let depth = 0;
  let fence: FenceState = { inFence: false, marker: '' };
  for (let i = from; i < lines.length; i += 1) {
    const line = lines[i]!;
    const t = fenceTransition(line, fence);
    fence = t.state;
    if (fence.inFence || t.isBoundary) continue;
    if (isBlockDirectiveClose(line)) {
      if (depth === 0) return i;
      depth -= 1;
      continue;
    }
    const kind = classifyDirectiveOpen(line);
    if (kind === 'container') {
      depth += 1;
    } else if (kind === 'self-contained') {
      // ⚠ 中を飲まないので深さは動かさないが、**直後の `:::` はこの directive のもの**
      const next = lines[i + 1];
      if (next !== undefined && isBlockDirectiveClose(next)) i += 1;
    }
  }
  return null;
}

/**
 * 🔴 **`:::` の囲いを畳む走査を 1 本に寄せた**(2026-08-07)。
 *
 * `quote` / `details` / `format` / `frontmatter`・`body` / `section` の 5 つは、
 * 「開きを見つける条件」以外**完全に同じ処理**だった。にもかかわらず
 * `section` だけが 2026-08-06 に入れ子対応を受け、**残り 4 つは平坦なまま**
 * 取り残されていた ── 同じ形が 5 か所に散っていると、直しが 1 か所にしか届かない。
 *
 * ## 何を守る走査か
 *
 * ① **開いている `:::` を数える**(自分の種類に限らない)── 他人の閉じを
 *    自分の閉じとして食わない。他人の開き / 閉じは**そのまま流す**ので、
 *    後段の処理が自分で対にできる
 * ② **同じ種類の入れ子も畳む** ── `:::.outer` の中の `:::.inner` は
 *    同じ処理が担当するので、飛ばして読むと内側が literal のまま残る
 * ③ **閉じ忘れは末尾で閉じる**(HTML を壊さない)
 *
 * ⚠ 数える対象は `classifyDirectiveOpen` が 1 か所で決める ──
 *   `:::foo` のような**畳まれない名前**を数えると `:::` を 1 つ余計に食う。
 */
function scanContainerDirective<T>(
  source: string,
  lineMapIn: number[],
  /**
   * 🔴 **本文にこれが 1 度も出てこないなら、段ごと素通りする**(2026-08-07)。
   *
   * ⚠ **素通りは「出力を 1 バイトも変えない」ことが条件**である。この走査は
   * 自分の開きが 1 つも無ければ**全行をそのまま流す**だけなので、素通りと
   * 完全に同じ結果になる(lineMap も入力のまま)。
   * ⚠ 目印は**広い側**に取る ── 狭すぎると、その記法が黙って効かなくなる。
   *   例: 装飾箱は `:::format` / Tier 0(`:::red`)/ Tier 1(`:::.hl`)の 3 形が
   *   あるので、目印は共通の `:::` にする。
   */
  marker: string,
  sentinelOpen: string,
  sentinelSep: string,
  /** 自分が畳む開きなら registry へ入れる値を、そうでなければ null を返す。 */
  match: (line: string) => T | null,
): { transformed: string; registry: Map<number, T>; lineMap: number[] } {
  if (!source.includes(marker)) {
    return { transformed: source, registry: new Map(), lineMap: lineMapIn };
  }
  const registry = new Map<number, T>();
  const lines = source.split('\n');
  const out: string[] = [];
  const lineMapOut: number[] = [];
  const emit = (s: string, idx: number): void => {
    out.push(s);
    lineMapOut.push(idx);
  };
  let counter = 0;
  let fence: FenceState = { inFence: false, marker: '' };
  const stack: ({ mine: true; id: number; inputIdx: number } | { mine: false })[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const inputIdx = lineMapIn[i] ?? i;
    const t = fenceTransition(line, fence);
    fence = t.state;
    if (fence.inFence || t.isBoundary) {
      emit(line, inputIdx);
      i += 1;
      continue;
    }
    // 閉じ ── いちばん内側の開きに対応させる
    if (stack.length > 0 && isBlockDirectiveClose(line)) {
      const top = stack.pop()!;
      if (top.mine) {
        emit('', inputIdx);
        emit(`${sentinelOpen}${top.id}${sentinelSep}CLOSE${sentinelOpen}`, inputIdx);
      } else {
        emit(line, inputIdx); // 他の directive の閉じ ── 後段へ渡す
      }
      i += 1;
      continue;
    }
    const kind = classifyDirectiveOpen(line);
    if (kind === null) {
      emit(line, inputIdx);
      i += 1;
      continue;
    }
    if (kind === 'self-contained') {
      // 中を飲まない ── 直後の `:::` が在ればそれはこの directive のもの
      emit(line, inputIdx);
      i += 1;
      const next = lines[i];
      if (next !== undefined && isBlockDirectiveClose(next)) {
        emit(next, lineMapIn[i] ?? i);
        i += 1;
      }
      continue;
    }
    const mine = match(line);
    if (mine === null) {
      // 他の directive ── 中身も閉じもそのまま流すが、**閉じは数える**
      stack.push({ mine: false });
      emit(line, inputIdx);
      i += 1;
      continue;
    }
    counter += 1;
    registry.set(counter, mine);
    stack.push({ mine: true, id: counter, inputIdx });
    emit(`${sentinelOpen}${counter}${sentinelSep}OPEN${sentinelOpen}`, inputIdx);
    emit('', inputIdx);
    i += 1;
  }
  // ⚠ 閉じ忘れは**末尾で閉じる**(HTML を壊さない)
  while (stack.length > 0) {
    const top = stack.pop()!;
    if (!top.mine) continue;
    const last = lineMapIn[lines.length - 1] ?? top.inputIdx;
    emit('', last);
    emit(`${sentinelOpen}${top.id}${sentinelSep}CLOSE${sentinelOpen}`, last);
  }
  return { transformed: out.join('\n'), registry, lineMap: lineMapOut };
}

md.inline.ruler.after('emphasis', 'pkc_simple_inline', function simpleInlineRule(state, silent) {
  if (silent) return false;
  const src = state.src;
  const start = state.pos;
  if (src.charCodeAt(start) !== 0x3A /* : */) return false;
  // Scan forward to find a `:<attrs>:` boundary。
  for (let i = start + 1; i < state.posMax; i++) {
    const ch = src.charCodeAt(i);
    if (ch === 0x0A /* newline */) return false;
    if (ch !== 0x3A /* : */) continue;
    // 候補境界。i から `:<attrs>:` を試行。
    // `:` 以後 attrs 部分を抽出。
    const restAfter = src.slice(i + 1);
    const closeIdx = restAfter.indexOf(':');
    if (closeIdx < 0) continue;
    const attrsCandidate = restAfter.slice(0, closeIdx);
    if (!attrsCandidate || !ATTRS_INNER_RE.test(attrsCandidate)) continue;
    const parsed = parseSimpleInlineAttrs(attrsCandidate);
    if (!parsed.valid) continue;
    const content = src.slice(start + 1, i);
    if (!content) continue;
    // Match found:`<span style="...">content</span>` を出力。
    // inner content は inline markup を保持したいので state.md.inline.parse で
    // tokenize したいところだが、Phase 1 は plain text で。
    const tokenOpen = state.push('simple_inline_open', 'span', 1);
    tokenOpen.attrSet('class', 'pkc-inline-mark');
    if (parsed.inlineStyle) tokenOpen.attrSet('style', parsed.inlineStyle);
    const tokenText = state.push('text', '', 0);
    tokenText.content = content;
    state.push('simple_inline_close', 'span', -1);
    state.pos = i + 1 + closeIdx + 1;  // skip past closing `:`
    return true;
  }
  return false;

});

// ── Inline `<br>` 改行(2026-06-22 user バグレポ)────────────────
//
// `html: false`(raw HTML を全 escape する XSS 安全既定)の副作用で、表
// セル内の改行に使う `<br>` がそのまま `&lt;br&gt;` と生タグ表示されてしまう。
// GFM の表セルは複数行ソースを書けず、`breaks: true` の「改行 → <br>」変換も
// セルは 1 行のため効かない。よって `<br>` がセル内改行の事実上の標準手段。
//
// 緩和は **void 要素 `<br>` だけ** を許す narrow allowlist:`<br>` / `<br/>` /
// `<br />`(大文字小文字無視・内部空白許容)を hardbreak token 化して `<br>`
// を emit する。属性付き(`<br onload=…>` 等)や他タグには match しないので
// script / event handler の注入面はゼロ ── `html: false` の XSS 姿勢を保った
// まま、共有 md 経由で表 / CSV セル / 段落の全 inline 文脈に一様に効く
// (center pane / Viewer popup / Split View preview の 3 surface 共通)。
const HTML_BR_RE = /<br\s*\/?>/iy;
md.inline.ruler.before('html_inline', 'pkc_html_br', function htmlBrRule(state, silent) {
  // `<` 以外は即 false(高速 path)。
  if (state.src.charCodeAt(state.pos) !== 0x3c /* < */) return false;
  // sticky(`y`)+ lastIndex で state.pos 位置のみを判定。
  HTML_BR_RE.lastIndex = state.pos;
  const m = HTML_BR_RE.exec(state.src);
  if (m === null) return false;
  if (!silent) {
    // markdown-it 標準 hardbreak renderer は `<br>\n` を出力。AST 経路
    // (parse.ts)も hardbreak → AstText '\n' として同等に扱える。
    state.push('hardbreak', 'br', 0);
  }
  state.pos += m[0].length;
  return true;
});

// ── M-7 Variables `{{vars.x}}`(2026-05-08、wave-10-2 Phase 2)──
//
// Spec §3.6 + OQ-6:frontmatter `vars.x` の値を本文中 `{{vars.x}}` で展開。
//
// 実装方針(2026-05-08 hotfix):**pre-process 段階の text 置換**で実装。
// 当初 inline rule で実装していたが、L-2 highlight(`==xxx==`) / L-2 em-dot
// (`[[em:xxx]]`) / L-2 ruby(`[[ruby:base|reading]]`) / L-6 simple-inline
// (`:xxx:attrs:`)等の **content を text token として直接 push する系統**
// の中では `{{vars.x}}` が展開されない(これらの content は inline parser
// 経路を通らない)現象が user 報告で発覚。pre-process で source 文字列を
// 置換 してしまえば、後段の inline rule は展開済 text を見るので必ず効く。
//
// 構文:
//   `{{vars.<key>}}` で展開、`<key>` は `[A-Za-z_][\w-]*`
//   `\{{vars.x}}` で literal 出力(escape)
//   `{{macros.x}}` 等 vars 以外は Phase 2 では未対応 = literal で残置
//   fenced code block(``` / ~~~)の中身では展開しない(fence-aware)
//
// trade-off:inline backtick code span(`` `{{vars.x}}` ``)の中も展開される。
// spec doc / AI 規約書 / Manual に明記。Jinja2 / Handlebars 等の慣習に近い
// 振る舞い、escape は `\{{vars.x}}` で対応可能。
//
// 未定義変数は post-process まで sentinel(U+E140 / U+E141)で残し、最終
// 段で `<span class="pkc-variable-undefined">` に置換。

const VAR_OPEN = '\u{E140}';
const VAR_SEP = '\u{E141}';

function expandVarsInText(source: string, vars: Record<string, string>): string {
  if (!source) return source;
  /**
   * 🔴 **本文に目印が無いなら段ごと素通りする**(2026-08-07)。出力は 1 バイトも
   * 変わらない ── この段は目印が 1 つも無ければ全行をそのまま流すだけである。
   * ⚠ 目印は**広い側**に取る(狭すぎるとその記法が黙って効かなくなる)。
   */
  if (!source.includes('{{')) return source;
  const lines = source.split('\n');
  let fence: FenceState = { inFence: false, marker: '' };
  return lines.map((line) => {
    const t = fenceTransition(line, fence);
    fence = t.state;
    if (fence.inFence || t.isBoundary) return line;
    // escape(`\{{vars.x}}`)優先。先に escape を sentinel(U+E142)で隠して
    // 通常の置換を行い、最後に元に戻す。
    let out = line.replace(/\\\{\{(vars\.[A-Za-z_][\w-]*)\}\}/g, '\u{E142}$1\u{E143}');
    out = out.replace(/\{\{\s*vars\.([A-Za-z_][\w-]*)\s*\}\}/g, (_match, key: string) => {
      if (Object.prototype.hasOwnProperty.call(vars, key)) {
        const v = vars[key]!;
        // escape sentinel char が値内にあれば剥がす(衝突対策)
        return v.replace(new RegExp(`[${VAR_OPEN}${VAR_SEP}]`, 'g'), '');
      }
      return `${VAR_OPEN}${key}${VAR_SEP}`;
    });
    out = out.replace(/\u{E142}(vars\.[A-Za-z_][\w-]*)\u{E143}/gu, (_m, ref: string) => `{{${ref}}}`);
    return out;
  }).join('\n');
}

function postProcessVariableUndefined(html: string): string {
  // sentinel `U+E140 key U+E141` を `<span class="pkc-variable-undefined">` に変換。
  // markdown-it が text を escape した後の状態で sentinel を含む HTML を扱う。
  return html.replace(
    new RegExp(`${VAR_OPEN}([A-Za-z_][\\w-]*)${VAR_SEP}`, 'g'),
    (_match, key: string) =>
      `<span class="pkc-variable-undefined" title="未定義変数: vars.${key}">{{vars.${key}}}</span>`,
  );
}

// ── Heading id injection ──────────────────────────────
//
// Stamp an `id` attribute on every h1/h2/h3 so the right-pane Table
// of Contents can scroll to a heading via `getElementById`. Slugs are
// produced by the same `makeSlugCounter` helper the TOC extractor uses,
// so the id emitted here matches the slug the TOC lists.
//
// Counter state is stored on the per-render `env` object (markdown-it
// creates a fresh `{}` when `md.render(src)` is called without an
// explicit env), so renders are independent. TEXTLOG renders each log
// entry in its own `renderMarkdown()` call and therefore has its own
// slug-collision scope — click handlers disambiguate cross-log-entry
// id collisions by scoping the DOM lookup to the owning log row.
//
// See `PKC2: docs/development/table-of-contents-right-pane.md`.

md.renderer.rules.heading_open = function (tokens, idx, options, env, self) {
  const token = tokens[idx]!;
  const level = parseInt(token.tag.slice(1), 10);
  if (level >= 1 && level <= 3) {
    const inline = tokens[idx + 1];
    const text = inline && inline.type === 'inline' ? inline.content.trim() : '';
    if (text) {
      const e = env as { __pkcHeadingSlug?: (t: string) => string };
      if (!e.__pkcHeadingSlug) e.__pkcHeadingSlug = makeSlugCounter();
      token.attrSet('id', e.__pkcHeadingSlug(text));
    }
  }
  return self.renderToken(tokens, idx, options);
};

// ── Card presentation placeholder (Slice 2, PKC2: docs/spec/card-embed-presentation-v0.md §5) ──
//
// Detect the `@[card](<target>)` (and `@[card:<variant>](<target>)`)
// notation and emit a minify-safe placeholder span that a future
// card widget renderer can pick up. Slice 2 **does not** render a
// widget — it only makes sure the notation survives the markdown
// pipeline with its target / variant / raw string preserved.
//
// At the markdown-it token level, `@[card](entry:e1)` tokenizes as
// four inline children:
//
//   text       "@" (may be prefixed with other text, e.g. "see @")
//   link_open  href=entry:e1
//   text       "card" (or "card:compact" etc.)
//   link_close
//
// We walk each paragraph's inline children, look for this 4-token
// shape with a recognised card label, validate the reconstructed
// `@[<label>](<href>)` through the Slice-1 parser (no grammar is
// re-implemented here), and on a successful match:
//
//   - strip the trailing `@` from the preceding text token
//   - splice the 3 link tokens out and insert one `html_inline`
//     placeholder in their place
//
// Any rejected case (unknown variant, invalid target, plain link
// without a `@` prefix, clickable-image, image-embed, etc.) is
// skipped — markdown-it continues with its default rendering so
// the body keeps displaying as `@` + plain link, which is exactly
// the fallback documented in `card-embed-presentation-v0.md` §6.1.

md.core.ruler.after('inline', 'pkc-card', function (state) {
  const tokens = state.tokens;
  for (const token of tokens) {
    if (token.type !== 'inline') continue;
    const children = token.children;
    if (!children) continue;

    // Walk forward; splicing shrinks the array, so we compare to
    // the live `children.length` each iteration.
    for (let i = 0; i + 3 < children.length; i++) {
      const t0 = children[i]!;
      const t1 = children[i + 1]!;
      const t2 = children[i + 2]!;
      const t3 = children[i + 3]!;

      if (t0.type !== 'text') continue;
      if (t1.type !== 'link_open') continue;
      if (t2.type !== 'text') continue;
      if (t3.type !== 'link_close') continue;
      if (!t0.content.endsWith('@')) continue;

      const label = t2.content;
      if (!isCardPresentationLabel(label)) continue;

      const href = attrString(t1, 'href');
      if (href === null) continue;

      const parsed = parseCardPresentation(`@[${label}](${href})`);
      if (!parsed) continue;

      // Strip trailing `@` from the preceding text.
      t0.content = t0.content.slice(0, -1);

      // Build the placeholder HTML. All values come from the
      // Slice-1 parser which restricts targets to entry: / asset:
      // / pkc:// with TOKEN_RE / SLUG_RE / DATE_RE tokens, so no
      // HTML metacharacters can appear — but we escape defensively
      // anyway so a future grammar relaxation cannot silently
      // degrade safety.
      const targetEsc = escapeHtmlAttr(parsed.target);
      const variantEsc = escapeHtmlAttr(parsed.variant);
      const rawEsc = escapeHtmlAttr(parsed.raw);
      const visibleLabel =
        parsed.variant === 'default' ? '@card' : `@card:${parsed.variant}`;
      const visibleLabelEsc = escapeHtmlAttr(visibleLabel);

      const placeholder = new state.Token('html_inline', '', 0);
      // Slice 4 (2026-04-25) — the placeholder gains
      // `data-pkc-action="navigate-card-ref"` plus `tabindex="0"` and
      // `role="link"` so action-binder can route clicks AND keyboard
      // (Enter / Space) through the same code path the existing
      // `entry:` link uses. The new attributes are additive — every
      // pre-Slice-4 selector (`.pkc-card-placeholder`,
      // `data-pkc-card-target`, `data-pkc-card-variant`,
      // `data-pkc-card-raw`) is preserved verbatim, so the Slice-2
      // and Slice-3 tests continue to pass and a future widget
      // renderer can still pick the placeholder up.
      placeholder.content =
        `<span class="pkc-card-placeholder"` +
        ` data-pkc-action="navigate-card-ref"` +
        ` data-pkc-card-target="${targetEsc}"` +
        ` data-pkc-card-variant="${variantEsc}"` +
        ` data-pkc-card-raw="${rawEsc}"` +
        ` role="link" tabindex="0">${visibleLabelEsc}</span>`;

      // Replace [link_open, text, link_close] with the placeholder.
      children.splice(i + 1, 3, placeholder);
      // Loop continues; the next iteration will evaluate the token
      // following the placeholder — which cannot itself start a
      // card match because card requires a preceding `@` text.
    }
  }
});

// ── Task list support (GFM-style) ─────────────────────
//
// Phase 2: transform list items whose inline content begins with
// `[ ]` or `[x]` into task list items with a disabled checkbox.
// The `pkc-task-item` class is added to the <li> so CSS can
// remove the bullet marker.

/**
 * 🔴 **本文の中のタグ行を、バッジで出す**(#550 段③。user 要望 2026-08-29)。
 *
 * > 「**そして、タグはバッジ化して表示が必要**」
 *
 * 🔑 **タグ行かどうかの判定は `parseTagLine` 1 本**である ── 走査
 *   (`scanBodyTags` → 索引 → スマートフォルダ)と**同じ関数**を呼ぶ。
 *   ⚠ ここに独自の正規表現を書くと、**集まるタグと画面のバッジが静かに食い違う**
 *   (CLAUDE.md §7)。
 *
 * ⚠ **行単位で見る** ── 走査は**原文の行**を見るので、
 *   `本文\n#買い物` のように**段落の 2 行目**に書かれたタグ行も拾う。
 *   だからここも `softbreak` で区切った**走ごと**に当てる
 *   (段落まるごとにしか当てないと、その形だけバッジが出ずに食い違う)。
 *
 * ⚠ **押せるのは受け手が居る面だけ**(`interactiveTags`)── 書き出した HTML では
 *   押しても何も起きないので、属性を 1 つも出さない(dead click を配らない)。
 */
/**
 * 🔴 **タグ行を当てない入れ子**(2026-08-29)。引用・箇条書き・脚注の中では当てない。
 * ⚠ 走査(`scanBodyTags`)は**原文の行**を見るので、`> #買い物` / `- #買い物` /
 *   `[^1]: #買い物` はタグ行ではない ── ここで数えないと**画面にだけ札が出る**。
 */
const NESTED_OPEN = new Set([
  'blockquote_open',
  'list_item_open',
  'footnote_open',
  'footnote_reference_open',
]);
const NESTED_CLOSE = new Set([
  'blockquote_close',
  'list_item_close',
  'footnote_close',
  'footnote_reference_close',
]);

md.core.ruler.after('inline', 'pkc-tagline', function (state) {
  const interactive = (state.env as { interactiveTags?: boolean }).interactiveTags === true;
  /**
   * 🔴 **引用と箇条書きの中では当てない**(2026-08-29、走査との parity test が教えた)。
   *
   * ⚠ 走査は**原文の行**を見るので、`> #買い物` / `- #買い物` は
   *   行頭が `#` ではなく**タグ行ではない**。ところが描画側はブロックの印を
   *   食べた**後**の中身を見るので、そのままだと**札になる** ──
   *   🔴 **画面には札が出るのに、押しても 1 件も出てこない**という食い違いになる。
   * 🔑 だから「いま引用・箇条書きの中か」を数えて、中では当てない。
   */
  let depth = 0;
  /**
   * 🔴 **1 ノートのタグ数の上限を、画面でも守る**(2026-08-29 の着地後レビュー。実測)。
   *
   * ⚠ 索引は `foldTags` が `MAX_TAGS`(32 個)で切るのに、**画面は切っていなかった** ──
   *   40 個書いたノートは「札は 40 枚出るのに索引は 32 件」で、
   *   **33 個目以降は黙って集計にもスマートフォルダにも入らない**。
   * 🔑 走査は本文の**行の順**に拾って畳むので、ここも**同じ順で数える**と一致する
   *   (突き合わせは `sameTag` ── 表示は原文、比較は大小無視)。
   * ⚠ 上限に当たった名前は**札にしない** ── 出すと「押せるのに集まらない」に戻る。
   */
  const taken: string[] = [];
  const keepName = (name: string): boolean => {
    if (taken.some((t) => sameTag(t, name))) return true;
    if (taken.length >= MAX_TAGS) return false;
    taken.push(name);
    return true;
  };
  const tokens = state.tokens;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    /**
     * ⚠ **脚注は `footnote_reference_*` で来る** ── この規則は `footnote_tail` の
     *   **前**に走る(どちらも `after('inline')` で、後から足したほうが先に来る)ので、
     *   最終形の `footnote_open` ではなく**定義そのものの印**を数える
     *   (2026-08-29、token の並びを実測して直した)。
     */
    if (NESTED_OPEN.has(token.type)) depth += 1;
    else if (NESTED_CLOSE.has(token.type)) depth -= 1;
    if (depth > 0) continue;
    if (token.type !== 'inline') continue;
    /**
     * 🔴 **段落の直下だけ**(2026-08-29 の着地後レビュー。**実物で再現した**)。
     *
     * ⚠ `inline` の token は**段落だけのものではない** ── 見出し・**表のセル**・
     *   脚注の中身も同じ形で来る。だから直前の block token を見ないと、
     *   `| #タグ | x |` の**セルが札になる**(画面には札、索引には入らない)。
     * 🔑 タグ行の規則は「**独立した行**」なので、段落の中身だけが対象である。
     * ⚠ 見出しは `heading_open` なのでここで自然に外れる(`# 見出し` は見出しのまま)。
     */
    if (tokens[i - 1]?.type !== 'paragraph_open') continue;
    const children = token.children;
    if (!children) continue;
    const out: typeof children = [];
    let run: typeof children = [];
    let changed = false;
    const flush = (): void => {
      // ⚠ タグ行は**素の文字だけ**でできている(`#` に inline 規則は当たらない)
      const only = run.length === 1 ? run[0]! : null;
      const parsed = only !== null && only.type === 'text' ? parseTagLine(only.content) : null;
      // ⚠ 上限を超えた名前は落とす。⚠ **1 つも残らなければタグ行ではない**(素の文に戻す)
      const names = parsed === null ? null : parsed.filter((x) => keepName(x));
      if (names !== null && names.length > 0) {
        const tok = new state.Token('html_inline', '', 0);
        tok.content = tagLineHtml(names, interactive);
        out.push(tok);
        changed = true;
      } else {
        out.push(...run);
      }
      run = [];
    };
    for (const t of children) {
      /**
       * ⚠ **改行は 2 種類ある** ── 行末に半角 2 つを書くと `hardbreak` になる。
       *   ここで割らないと、**その次の行が前の行と 1 つの run** になり、
       *   **索引には入るのに画面には札が出ない**(2026-08-29 に実測)。
       */
      if (t.type === 'softbreak' || t.type === 'hardbreak') {
        flush();
        out.push(t);
        continue;
      }
      run.push(t);
    }
    flush();
    // ⚠ 当たらなかった段落は**触らない**(token の同一性を無駄に壊さない)
    if (changed) token.children = out;
  }
  return true;
});

/** バッジ 1 行の HTML。⚠ 属性も本文も**必ず escape する**。 */
function tagLineHtml(names: readonly string[], interactive: boolean): string {
  const chips = names
    .map((name) => {
      const attrs =
        ` class="pkc-tag" data-pkc-tag="${escapeHtmlAttr(name)}"` +
        (interactive
          ? ' data-pkc-action="filter-by-tag" role="button" tabindex="0"' +
            // 🔴 **起きることをそのまま書く**(2026-08-29 の動線レビュー)。
            // ⚠ 押すと**その語で一覧を絞る**(題名と本文を見る)ので、
            //   「が付いたノートを探す」は嘘になる ── タグの無いノートも混ざる。
            // ⚠ 情報ペインの札(`inspector.ts`)と**同じ字**にする(呼び名を 2 つ作らない)。
            ` title="「${escapeHtmlAttr(name)}」を含むノートを探します"`
          : '');
      return `<span${attrs}>#${md.utils.escapeHtml(name)}</span>`;
    })
    .join('');
  return `<span class="pkc-tagline" data-pkc-tagline>${chips}</span>`;
}

md.core.ruler.after('inline', 'pkc-task-list', function (state) {
  const tokens = state.tokens;
  let taskIndex = 0;
  for (let i = 2; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.type !== 'inline') continue;
    if (tokens[i - 1]!.type !== 'paragraph_open') continue;
    if (tokens[i - 2]!.type !== 'list_item_open') continue;

    const match = /^\[([ xX])\](?:\s+|$)/.exec(token.content);
    if (!match) continue;

    const checked = match[1]!.toLowerCase() === 'x';

    // Mark the <li> for CSS styling
    tokens[i - 2]!.attrJoin('class', 'pkc-task-item');

    // Strip the marker from the inline content
    token.content = token.content.slice(match[0].length);

    // Update children: remove marker from first text token, prepend checkbox
    const children = token.children ?? [];
    for (const child of children) {
      if (child.type === 'text') {
        child.content = child.content.replace(/^\[[ xX]\](?:\s+|$)/, '');
        break;
      }
    }

    const checkbox = new state.Token('html_inline', '', 0);
    /**
     * 🔴 **押せるのは「受け手が居る面」だけ**(#277。2026-08-19)。
     *
     * ⚠ 既定はいまも**押せない形**である(P8 段⑳ の判断は生きている)──
     *   `disabled` が無いのに本文が変わらないと、user から見て
     *   「チェックしたのに消えた」= データを失った挙動になる。書き出した HTML・
     *   Viewer・印刷など**受け手の居ない面では押せないままにする**。
     * 🔑 効かせる面(本文の読む面)だけが `interactiveTasks` を渡す。
     * 🔴 **行番号で指す**(索引ではない)── `list_item_open` の `map[0]` が
     *   原文の行である。索引だと、数え方が描画側と原文側で 1 つでもずれた瞬間に
     *   **別の行を書き換える**(いちばん静かなデータ破壊)。
     */
    const interactive = (state.env as { interactiveTasks?: boolean }).interactiveTasks === true;
    const outLine = tokens[i - 2]!.map?.[0];
    // ⚠ **原文の行へ逆引きする**(前処理で行がずれている ── 上の `env.lineMap`)
    const map = (state.env as { lineMap?: number[] }).lineMap;
    const rawLine =
      typeof outLine === 'number' ? (map ? (map[outLine] ?? outLine) : outLine) : undefined;
    /**
     * 🔴 **剥がした行番号を原文へ戻す**(N1)。⚠ 受け手(`body-rewrite.ts`)は
     * **原文**を splice するので、剥がした本文の行のまま焼くと別の行が書き換わる。
     */
    const offset = (state.env as { taskLineOffset?: number }).taskLineOffset ?? 0;
    const srcLine = typeof rawLine === 'number' ? rawLine + offset : undefined;
    const wired = interactive && typeof srcLine === 'number';
    const attrs = wired
      ? ` data-pkc-action="toggle-task" data-pkc-task-line="${srcLine}"`
      : ' disabled';
    checkbox.content = `<input type="checkbox" class="pkc-task-checkbox" data-pkc-task-index="${taskIndex}"${attrs}${checked ? ' checked' : ''}> `;
    taskIndex++;
    children.unshift(checkbox);
    token.children = children as Token[];
  }
});

/**
 * Optional rendering context threaded into markdown-it's `env`.
 *
 * `currentContainerId` lets the `link_open` rule distinguish
 * same-container from cross-container `pkc://` permalinks so only
 * external references turn into the `.pkc-permalink-external`
 * placeholder badge. Omitting the field — or passing an empty
 * string — makes every recognised permalink render as an external
 * placeholder, which is the safe conservative default.
 */
export interface RenderMarkdownOptions {
  readonly currentContainerId?: string;
  /**
   * 🔴 **囲みの中身を添付から取ったもの**(#444 段②。鍵 → 字)。
   *
   * 🔑 **書き出しのためにある** ── 配った HTML / Word には hydrator が居ないので、
   *   渡さないと「持ち出したら中身が消える」になる。渡せば、本文に書いてあったのと
   *   **同じ道**で描かれる。
   * ⚠ **アプリの画面は渡さない** ── 添付の読みは非同期で、この描画は同期である
   *   (画面は器を置いて `hydrateAssetRefs` が埋める)。
   * ⚠ **素の object にする**(関数を渡さない)── 描画は markdown ワーカーへ
   *   `postMessage` で渡ることがあり、関数は clone できずにそこで落ちる。
   * ⚠ 載せるのは**本文が指している鍵だけ**(`collectFenceAssetKeys`)── 全添付を
   *   字にして渡すと、ゼロコピーの積み上げ(不可侵指示 2026-07-27)が崩れる。
   */
  readonly fenceAssets?: Readonly<Record<string, string>>;
  /**
   * 🔴 **表のセルを押して打てる形で出すか**(#418 段①。既定 `false`)。
   *
   * ⚠ **受け手(`edit-cell`)が居る面だけ** `true` にする ── `interactiveTasks` と
   *   同じ理由で、押せるのに本文が変わらないと「打ったのに消えた」になる。
   *   書き出した HTML・印刷・可搬 1 枚は受け手が居ないので**押せないまま**。
   * ⚠ 渡さなければ属性は 1 つも出ない = goldens は 1 バイトも動かない。
   */
  readonly interactiveCells?: boolean;
  /**
   * 🔴 **チェックの印を押せる形で出すか**(#277。既定 `false` = 押せない)。
   *
   * ⚠ **受け手(`toggle-task`)が居る面だけ** `true` にする ── 押せるのに
   *   本文が変わらないと、user から見て「チェックしたのに消えた」= データを
   *   失った挙動になる(P8 段⑳ で一度そうなった)。書き出した HTML・Viewer・
   *   印刷は受け手が居ないので、**押せないまま**にする。
   */
  readonly interactiveTasks?: boolean;
  /**
   * 🔴 **本文中のタグを押せる形で出すか**(#550 段③。既定 `false` = 押せない)。
   *
   * ⚠ **受け手(`filter-by-tag`)が居る面だけ** `true` にする ── `interactiveTasks` と
   *   同じ理由で、押せるのに何も起きないと**dead click** になる。書き出した HTML・
   *   印刷・可搬 1 枚は受け手が居ないので**押せないまま**にする。
   * ⚠ 渡さなければ属性は 1 つも出ない = 書き出しの goldens は 1 バイトも動かない。
   */
  readonly interactiveTags?: boolean;
  /**
   * 🔴 **チェックの印が指す行を、原文の行へ戻すためのずらし**(N1)。
   *
   * 読む面は **frontmatter を剥がした本文**を描く(`detail.ts` の `fm.body`)が、
   * 押されたときに書き換えるのは **原文**(`body-rewrite.ts` が
   * `body.split('\n')[line]` を splice する)。ずらさないと
   * **frontmatter の行数だけ上の、別の行**が書き換わる ── 押した項目と違う所に
   * 印が付く、静かなデータ破壊である。
   * ⚠ かんばんの札は `listTaskItems(row.body)`(**原文**)から行を採るので
   *   ずらさない ── だから**ずらすのは剥がして描く面だけ**であり、
   *   既定は `0`(何も変えない)。
   * 🔑 live editor は同じ補正を `detail.ts` の `startLine + fmLines` で持っている。
   *   **ずらす値は `fmLines` 1 つ** ── ここに 2 本目の計算を置かない。
   */
  readonly taskLineOffset?: number;
  /**
   * M-7(wave-10-2 Phase 2、2026-05-08):本文中の `{{vars.name}}` 展開に
   * 使う変数 map。caller(presenter)は `extractVars(entry.body)` で
   * frontmatter から抽出して渡す。spec doc §3.6 + OQ-6(展開 timing は
   * render 時)。未定義変数は `<span class="pkc-variable-undefined">` で
   * visible warning として残す。
   */
  readonly vars?: Record<string, string>;
  /**
   * 領域 10-1 Split View 同期スクロール(2026-05-05、PR #206 reform 後再実装)
   * — stamp `data-pkc-source-line="<n>"` on every block-level token's
   * rendered output so the caret-sync adapter can match preview
   * elements to editor source lines (and vice versa).
   *
   * Each tagged element also gets `data-pkc-source-end="<m>"` (zero-
   * indexed inclusive end of the source range) so a long fence /
   * table / list spanning multiple source lines can compute internal
   * progress (caret on line K within [S, E] → preview offset
   * (K - S) / (E - S) of the rendered block height).
   *
   * Opt-in — view-only call sites (detail / todo / folder / textlog
   * presenters) leave this off and emit clean HTML. Only the split
   * editor preview turns it on. */
  readonly sourceLineAnchors?: boolean;
  /**
   * reform-2026-05 Phase 2 PR-2K(2026-05-10):寛容 parse(`:::note` /
   * `:align:{…}` 等)を受理したときの hint を console へ書くか。
   *
   * 🔴 **既定は `true`(書かない)へ変えた**(#710、2026-09-05)。
   * ⚠ 直す前の既定は「書く」で、**支えている記法を描くたびに** `console.info` が
   *   出ていた(実測:smoke 全量で `[PKC2009]` / `[PKC2007]`)。書いても user に
   *   直す所は無く、smoke の収集は `error` 以外を捨てるので**増えても見えない**。
   * 🔑 **口は残す** ── 道具(hint を読む側)は `false` を明示して呼ぶ。
   *   `tests/features/markdown-user-reports.test.ts` が両方向を pin している
   *   (既定で 0 行 / 頼めば出る)。
   */
  readonly silentHallucinationWarnings?: boolean;
  /**
   * 領域 8 Layer 3:見出しアウトライン番号(opt-in)。指定時、レンダラが
   * `#` / `##` / `###` に `start.` / `start.M` / `start.M.L` を前置する
   * (`####` 以降は無番号)。frontmatter `heading-number` から caller が
   * 抽出して渡す。
   */
  readonly headingNumber?: { start: number } | null;
  /**
   * 🔴 **何向けに描くか**(#187 段⑤)。`:::if{format=X}` の X と突き合わせる。
   *
   * ⚠ 既定は `'html'`(画面・印刷・閲覧用 HTML)── いままでと同じ。
   * 🔑 Word の書き出しが `'docx'` を渡すことで、**`:::if{format=docx}` が初めて
   * 生きる** ── それまでこの記法は「受理はするが**永久に不可視**」だった
   * (user 不可侵指示「記法を減らすことは user の動線を減らすこと」の逆向き:
   * 出口ができたので、落ちていた動線が戻る)。
   */
  readonly format?: string;
  /**
   * 🔴 **行の対応表をここへ集める**(2026-08-05。ライブエディタ S2)。
   *
   * 渡すと `SOURCE_LINE_TOKEN_TYPES` の token ぶんの `SourceRange` が
   * **文書順で** push される。⚠ **HTML は変わらない**(= anchors OFF と byte 一致)──
   * 行番号を焼くと、行数が変わる編集で全塊の HTML が変わって差分が全滅する。
   * ⚠ 呼び側は空配列を渡す(この関数は push するだけで、消さない)。
   * 使い方は `features/markdown/source-ranges.ts` の `renderMarkdownWithRanges`。
   */
  readonly collectRanges?: SourceRange[];
  /**
   * 🔴 **外部の画像を読み込ませるか**(2026-08-06、user 裁定。既定 = false)。
   *
   * 効くのは **2 か所だけ**で、どちらも同じ値で動く:
   * ① 本文の `![](https://…)` に `src` を付けるか ② ` ```html` の箱の CSP の
   * `img-src` を開けるか。⚠ **片方だけ開けてはいけない** ── 設定が嘘になる。
   *
   * ⚠ **既定を true にしない**。渡し忘れで漏れると画面に何も出ないので
   * 永久に露見しない。逆(塞がる)は user に見えるので直る。
   * 意味論の正本は `features/markdown/external-images.ts`。
   */
  readonly allowExternalImages?: boolean;
}

/**
 * Block-level token types whose rendered HTML should carry the
 * `data-pkc-source-line` / `data-pkc-source-end` attributes when
 * `sourceLineAnchors` is opt-in. Top-level blocks the user can
 * point at in the live preview.
 */
const SOURCE_LINE_TOKEN_TYPES: ReadonlySet<string> = new Set([
  'heading_open',
  'paragraph_open',
  'blockquote_open',
  'bullet_list_open',
  'ordered_list_open',
  'list_item_open',
  'fence',
  'code_block',
  'table_open',
  // 領域 10-1 PR 2 hotfix: table row level anchoring so click-on-row
  // and caret-on-row land on the right source line. Without this,
  // a click anywhere in a 5-row table jumps to table_open's start
  // line for every row — surprising the user.
  'tr_open',
  'hr',
  'html_block',
]);

/**
 * 🔴 **行の対応表(sidecar)の 1 件**(2026-08-05。ライブエディタ S2)。
 *
 * `data-pkc-source-line` と**同じ材料**から作るが、**HTML には焼かない**。
 * ⚠ `level` は token の入れ子の深さ ── 0 = 最上位。表の行(`tr`)や
 * 箇条書きの項目(`li`)は深いところに出るので、活性単位を行まで下げるのに使う
 * (設計 §5.6 ④)。
 */
export interface SourceRange {
  /** 原文(frontmatter を除いた本文)の開始行。0 始まり。 */
  readonly start: number;
  /** 同・終了行(含む)。 */
  readonly end: number;
  /** token の入れ子の深さ。0 = 最上位。 */
  readonly level: number;
  /** token の型(`paragraph_open` / `tr_open` / `list_item_open` / `fence` …)。 */
  readonly type: string;
}

/**
 * `tagSourceLines` の**双子**。属性を焼く代わりに配列へ集める。
 *
 * ⚠ **判定を 2 つに増やさない** ── 対象 token の集合(`SOURCE_LINE_TOKEN_TYPES`)と
 * 行の逆引き(`lineMap`)は焼く側と**同じもの**を使う。ここが分岐すると
 * 「画面に出ている刻印」と「対応表」が食い違い、caret が別の行へ入る。
 */
function collectSourceRanges(
  tokens: Token[],
  lineMap: number[] | undefined,
  out: SourceRange[],
): void {
  for (const token of tokens) {
    if (token.map && SOURCE_LINE_TOKEN_TYPES.has(token.type)) {
      const outStart = token.map[0];
      const outEndIncl = Math.max(outStart, token.map[1] - 1);
      out.push({
        start: lineMap ? (lineMap[outStart] ?? outStart) : outStart,
        end: lineMap ? (lineMap[outEndIncl] ?? outEndIncl) : outEndIncl,
        level: token.level,
        type: token.type,
      });
    }
    if (token.children && token.children.length > 0) {
      collectSourceRanges(token.children, lineMap, out);
    }
  }
}

function tagSourceLines(tokens: Token[], lineMap?: number[]): void {
  for (const token of tokens) {
    if (token.map && SOURCE_LINE_TOKEN_TYPES.has(token.type)) {
      // `token.map` = [startLine, endLineExclusive] in the **stripped** source
      // (output of all preprocess passes). 2026-05-08 user 報告で発覚した
      // Split View 行ズレ修正:lineMap が渡されていれば output index を user
      // の textarea(原文)行 index に逆引きする。lineMap[outIdx] = inputIdx。
      const outStart = token.map[0];
      const outEndIncl = Math.max(outStart, token.map[1] - 1);
      const inStart = lineMap ? (lineMap[outStart] ?? outStart) : outStart;
      const inEnd = lineMap ? (lineMap[outEndIncl] ?? outEndIncl) : outEndIncl;
      token.attrSet('data-pkc-source-line', String(inStart));
      token.attrSet('data-pkc-source-end', String(inEnd));
    }
    if (token.children && token.children.length > 0) {
      tagSourceLines(token.children, lineMap);
    }
  }
}

// ── L-7 (2026-05-07、wave-10-2 Phase 1):図 / 表 / 式 caption + 自動採番 ──
//
// Spec §3.5:
//
//   :::figure{#fig-flow}
//   ![](asset:flowchart.png)
//   ^^^ 全体フロー
//   :::
//
//   本文 → 図 [@fig-flow] を参照
//
// `:::figure|table|equation{#id}` ... `^^^ caption` ... `:::` で図表番号を
// 自動採番、`[@id]` で参照展開(template_kind 依存ラベル「図 N」「表 N」
// 「式 N」)。
//
// 実装:pre-process で block を sentinel 置換 + registry 構築、md.render 後に
// post-process で sentinel を <figure id=...><figcaption>...</figcaption></figure>
// に展開、`[@id]` を <a href="#id">図 N</a> に展開。
// markdown-it `html: false` を回避するため Unicode PUA(U+E110〜)を sentinel に。

type FigKind = 'figure' | 'table' | 'equation';

interface FigEntry {
  kind: FigKind;
  num: number;
  caption: string;
}

const FIG_LABEL_PREFIX: Record<FigKind, string> = {
  figure: '図',
  table: '表',
  equation: '式',
};

const FIG_SENTINEL_OPEN = '';
const FIG_SENTINEL_SEP = '';
const FIG_REF_OPEN = '';
const FIG_REF_SEP = '';
const FIG_REF_CLOSE = '';

// ── Fenced code block の検出ヘルパ(2026-05-08 user 報告:fence 内で
// preprocessor が誤発火、sentinel 漏れ → glyph 化する bug の根治)。
//
// CommonMark の fenced code block は ` ``` ` または ` ~~~ ` を行頭(0〜3 半角
// SP のインデント許容)に置いた行で開閉する。同じ marker(``` or ~~~)で
// 閉じる必要があるが、長さは開きと同等以上が必要。Phase 1 では「marker 種が
// 一致したら閉じる」の単純ルールで処理(ほぼ実用上同等)。
//
// preprocessor が fence の中身行を「マーカー入り plain 段落」として処理すると
// sentinel char が <code> 内に埋め込まれ、後段 markdown-it が <pre><code>...</code></pre>
// で wrap、post-process regex(`<p[^>]*>SENT</p>`)が当たらず PUA glyph が
// HTML に残る。fence 内は preprocessor 全件が **素通し** すべき。
//
// 各 preprocessor は同じ state machine を持つ:
//   - inFence === false かつ line が fence 開き → 開きとして state 遷移、line は素通し
//   - inFence === true かつ line が fence 閉じ(同 marker)→ 閉じとして state 遷移、line は素通し
//   - inFence === true (中身)→ line は素通し
//   - inFence === false (通常)→ marker 検出ロジック適用

interface FenceState {
  inFence: boolean;
  marker: string;  // '```' or '~~~'(空 = 閉)
}

function fenceTransition(line: string, state: FenceState): { state: FenceState; isBoundary: boolean } {
  const m = /^\s{0,3}(```+|~~~+)/.exec(line);
  if (!m) return { state, isBoundary: false };
  const lineMarker = m[1]!.startsWith('```') ? '```' : '~~~';
  if (!state.inFence) {
    return { state: { inFence: true, marker: lineMarker }, isBoundary: true };
  }
  if (lineMarker === state.marker) {
    return { state: { inFence: false, marker: '' }, isBoundary: true };
  }
  return { state, isBoundary: false };
}

function processFigureBlocks(source: string, lineMapIn: number[]): {
  transformed: string;
  registry: Map<string, FigEntry>;
  lineMap: number[];
} {
  /**
   * 🔴 **本文に目印が無いなら段ごと素通りする**(2026-08-07)。出力は 1 バイトも
   * 変わらない ── この段は目印が 1 つも無ければ全行をそのまま流すだけである。
   * ⚠ 目印は**広い側**に取る(狭すぎるとその記法が黙って効かなくなる)。
   */
  if (!source.includes(':::')) return { transformed: source, registry: new Map(), lineMap: lineMapIn };
  const registry = new Map<string, FigEntry>();
  const lines = source.split('\n');
  const out: string[] = [];
  const lineMapOut: number[] = [];
  const counter: Record<FigKind, number> = { figure: 0, table: 0, equation: 0 };
  let fence: FenceState = { inFence: false, marker: '' };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const inputIdx = lineMapIn[i] ?? i;
    // fence 内 / fence 境界行は figure marker 検出を skip(2026-05-08 hotfix)
    const t = fenceTransition(line, fence);
    fence = t.state;
    if (fence.inFence || t.isBoundary) {
      out.push(line);
      lineMapOut.push(inputIdx);
      i++;
      continue;
    }
    // reform-2026-05 hotfix(2026-05-10):`:::figure{#id}` Pandoc hash 形 +
    // `:::figure{id="..."}` Pandoc kv quoted 形の **両形** を受理する。後者は
    // ChatGPT 等 AI が頻繁に生成するため、parseBlockDirectiveOpen 経由で統合。
    // table / equation も同様。
    const open = parseBlockDirectiveOpen(line);
    if (!open || (open.name !== 'figure' && open.name !== 'table' && open.name !== 'equation')) {
      out.push(line);
      lineMapOut.push(inputIdx);
      i++;
      continue;
    }
    const kind = open.name as FigKind;
    // id は Pandoc `#id` 形(open.attrs.id)or `id=...` kv 形(open.attrs.kvs.id)から取る
    const idFromHash = open.attrs.id;
    const idFromKv = typeof open.attrs.kvs.id === 'string' ? open.attrs.kvs.id : undefined;
    const idAttr = idFromHash ?? idFromKv;
    /**
     * 🔴 **id の無い図表も図表として描く**(2026-08-06。user 報告 minor
     * 「`:::figure` が素のテキスト」)。
     *
     * 直す前は id が無いと**その 3 行が literal 文字列**として出ていた
     * (`:::figure` / `^^^ 説明` / `:::` がそのまま画面に並ぶ)。id は
     * **`[@id]` で参照するときだけ**要るもので、番号付け・キャプション・
     * `<figure>` の組み立てには要らない ── 参照しない図に id を強制するのは、
     * 記法を覚えている人ほど踏む罠である。
     *
     * ⚠ **不正な id は今までどおり literal**(`:::figure{#あ い}` 等)──
     * そこは打ち間違いの合図なので、黙って通すと直す機会を奪う。
     * ⚠ id が無い図は registry に入れない(参照できないものを参照させない)。
     */
    if (idAttr !== undefined && !/^[\w-]+$/.test(idAttr)) {
      out.push(line);
      lineMapOut.push(inputIdx);
      i++;
      continue;
    }
    const id = idAttr ?? '';
    counter[kind]++;
    const num = counter[kind];
    const content: string[] = [];
    const contentInputIdx: number[] = [];
    let caption = '';
    let captionInputIdx = inputIdx;
    const openInputIdx = inputIdx;
    i++;
    /**
     * ⚠ **入れ子を数えて閉じを探す**(2026-08-07)。直す前は「最初に出会った `:::`」で
     * 止めていたので、`:::figure` の中に `:::note` を 1 つ書くだけで**内側の閉じで
     * 図が終わり**、外側の閉じが `<p>:::</p>` として漏れていた(実測 8 形すべて)。
     * ⚠ 中の directive は `content` へそのまま入れて後段へ渡す ── figure はこの
     * 前処理の中で**いちばん早く**走るので、中身は後段が自分で畳む。
     */
    const figCloseIdx = findMatchingClose(lines, i);
    const figBodyEnd = figCloseIdx ?? lines.length;
    while (i < figBodyEnd) {
      const innerInputIdx = lineMapIn[i] ?? i;
      const cm = /^\^\^\^\s*(.*)$/.exec(lines[i]!);
      // reform-2026-05 Phase 2 PR-2C(2026-05-10):`:caption:[…]` formal marker
      // も `^^^` 等価で受理。AI / serializer が IR-driven で emit する形。
      // 行頭 `:caption:[content]` or `:caption:[content]{attrs}` の content を
      // 抽出して caption として扱う。
      const cm2 = /^:caption:\[([^\]\n]*)\](?:\{[^}]*\})?\s*$/.exec(lines[i]!);
      // PR-2J(2026-05-10):multi-line :caption:[\n…\n] も受理(ChatGPT 等が
      // 改行を含む caption を出力するパターン)。`:caption:[` で始まり、後続行で
      // `]` で閉じる形を scan、content は trim 済 caption text に。
      const isCaptionMultiOpen = /^:caption:\[\s*$/.test(lines[i]!);
      if (cm) {
        caption = cm[1]!;
        captionInputIdx = innerInputIdx;
      } else if (cm2) {
        caption = cm2[1]!;
        captionInputIdx = innerInputIdx;
      } else if (isCaptionMultiOpen) {
        // multi-line caption: 後続行から `]` 行(or `]{attrs}`)を探す
        const captionLines: string[] = [];
        i++;
        while (i < figBodyEnd && !/^\]\s*(?:\{[^}]*\})?\s*$/.test(lines[i]!)) {
          captionLines.push(lines[i]!);
          i++;
        }
        caption = captionLines.map((l) => l.trim()).filter(Boolean).join(' ');
        captionInputIdx = innerInputIdx;
        // `]` 行を consume(あれば)。`:::` 行なら consume せず外側 while に委ねる。
        if (i < lines.length && /^\]\s*(?:\{[^}]*\})?\s*$/.test(lines[i]!)) {
          // skip the `]` line
        } else {
          // `:::` に到達した場合は外側 while の終了条件で抜ける、i を戻す必要なし
          continue;
        }
      } else {
        content.push(lines[i]!);
        contentInputIdx.push(innerInputIdx);
      }
      i++;
    }
    const closeInputIdx =
      figCloseIdx !== null ? (lineMapIn[figCloseIdx] ?? figCloseIdx) : openInputIdx;
    if (figCloseIdx !== null) i = figCloseIdx + 1; // skip closing `:::`
    // ⚠ id が無い図は登録しない(`[@id]` の参照先にならない ── 空文字を鍵にすると
    //    id 無しの図が 2 つあるだけで「同じものを指す」になる)
    if (id !== '') registry.set(id, { kind, num, caption });
    // Sentinel emission(各 sentinel は own-line で出力 → markdown-it が <p>...</p> wrap)。
    // OPEN は figure 開き行に対応、CAPTION は ^^^ 行(なければ open 行 fallback)、
    // CLOSE は閉じる ::: 行に対応。content は元の各行に対応。
    out.push(`${FIG_SENTINEL_OPEN}OPEN${FIG_SENTINEL_SEP}${kind}${FIG_SENTINEL_SEP}${id}${FIG_SENTINEL_SEP}${num}${FIG_SENTINEL_OPEN}`);
    lineMapOut.push(openInputIdx);
    out.push('');
    lineMapOut.push(openInputIdx);
    for (let k = 0; k < content.length; k++) {
      out.push(content[k]!);
      lineMapOut.push(contentInputIdx[k] ?? openInputIdx);
    }
    if (caption) {
      out.push('');
      lineMapOut.push(captionInputIdx);
      out.push(`${FIG_SENTINEL_OPEN}CAPTION${FIG_SENTINEL_SEP}${kind}${FIG_SENTINEL_SEP}${num}${FIG_SENTINEL_SEP}${caption}${FIG_SENTINEL_OPEN}`);
      lineMapOut.push(captionInputIdx);
    }
    out.push('');
    lineMapOut.push(closeInputIdx);
    out.push(`${FIG_SENTINEL_OPEN}CLOSE${FIG_SENTINEL_OPEN}`);
    lineMapOut.push(closeInputIdx);
  }
  return { transformed: out.join('\n'), registry, lineMap: lineMapOut };
}

function processFigureRefs(source: string, registry: Map<string, FigEntry>): string {
  // simple `[@id]` を sentinel に変換
  let out = source.replace(/\[@([\w-]+)\]/g, (full, id) => {
    const e = registry.get(id);
    if (!e) return full;
    const label = `${FIG_LABEL_PREFIX[e.kind]} ${e.num}`;
    return `${FIG_REF_OPEN}${id}${FIG_REF_SEP}${label}${FIG_REF_CLOSE}`;
  });
  // reform-2026-05 Phase 2 PR-2D(2026-05-10):`:autoref:{id="…"}` formal 等価。
  // AI / serializer が IR-driven で emit する formal 形。`{id="fig1"}` /
  // `{id=fig1}` / smart quote すべて受理(parseBlockDirectiveAttrs と同等の
  // tolerance、ChatGPT typographer / textarea autocorrect 対策)。
  // quote chars(ASCII + smart):" ' U+201C U+201D U+2018 U+2019
  out = out.replace(
    /:autoref:\{\s*id\s*=\s*(?:["'“”‘’]([^"'“”‘’]+)["'“”‘’]|([\w-]+))\s*\}/g,
    (full: string, quoted: string | undefined, unquoted: string | undefined) => {
      const id = quoted ?? unquoted;
      if (!id) return full;
      const e = registry.get(id);
      if (!e) return full;
      const label = `${FIG_LABEL_PREFIX[e.kind]} ${e.num}`;
      return `${FIG_REF_OPEN}${id}${FIG_REF_SEP}${label}${FIG_REF_CLOSE}`;
    },
  );
  return out;
}

// ── reform-2026-05 PR-D:`:::quote{author=…}` block directive ──
//
// Pandoc-style attribute syntax で複数 embed を 1 つの引用 block に纏める形。
// 学術 / 法律 / 報道で「同じ著者の複数文献を共通 attribution でまとめて引用」
// 用途を想定。設計詳細は
// `PKC2: docs/development/notation-redesign-2026-05/03-link-embed-card.md` §3.5.2。
//
// 実装:figure と同じ sentinel pattern。U+E150 / U+E151 を sentinel に使用、
// markdown-it `html: false` を回避。registry に attrs を保存、post-process で
// `<blockquote class="pkc-quote-citation" data-pkc-quote-*="...">` に展開。

const QUOTE_SENTINEL_OPEN = '\u{E150}';
const QUOTE_SENTINEL_SEP = '\u{E151}';

interface QuoteEntry {
  attrs: _BlockDirectiveAttrs;
}

// ── PR-F (reform-2026-05、Phase 1):`:::if{format=X}` conditional block ──
//
// Spec §1.4 #23:`:::if{format=html} content :::` で、format が render target と
// 一致する時のみ content を render、一致しない時は content を strip(空行で line
// count 維持、Split View source-preview-sync を保つ)。
//
// 受理 attrs:
//   - `format=html|markdown|docx|pdf|...` — target format に match する時のみ render
//   - 省略時は always match(plain wrapper として効く)
//
// PKC2 の renderer は HTML 専用なので target='html' で固定。export 系で別 format
// (docx / pdf 等)に dispatch する時は caller が target を指定して呼ぶ拡張余地。
//
// nested directive 対応:`:::if` 内に `:::quote` 等の他 directive がネスト可能。
// directive-aware depth tracking で対応(open で depth++、close で depth--)。
//
// 例:
//   :::if{format=html}          ← html target で match → content 出力
//   ![](entry:A)
//   :::
//
//   :::if{format=docx}          ← html target で不一致 → content 全部 empty 化
//   docx 専用本文
//   :::

function processIfBlocks(source: string, lineMapIn: number[], targetFormat: string): {
  transformed: string;
  lineMap: number[];
} {
  /**
   * 🔴 **本文に目印が無いなら段ごと素通りする**(2026-08-07)。出力は 1 バイトも
   * 変わらない ── この段は目印が 1 つも無ければ全行をそのまま流すだけである。
   * ⚠ 目印は**広い側**に取る(狭すぎるとその記法が黙って効かなくなる)。
   */
  if (!source.includes(':::if')) return { transformed: source, lineMap: lineMapIn };
  const lines = source.split('\n');
  const out: string[] = [];
  const lineMapOut: number[] = [];
  let fence: FenceState = { inFence: false, marker: '' };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const inputIdx = lineMapIn[i] ?? i;
    const t = fenceTransition(line, fence);
    fence = t.state;
    if (fence.inFence || t.isBoundary) {
      out.push(line);
      lineMapOut.push(inputIdx);
      i++;
      continue;
    }
    const open = parseBlockDirectiveOpen(line);
    if (!open || open.name !== 'if') {
      out.push(line);
      lineMapOut.push(inputIdx);
      i++;
      continue;
    }
    // match 判定:format kv が target と一致するか、format 省略時は always match
    // Q8 value-only 寛容パース(v4 §16):`:::if{html}` → format=html
    let formatVal = open.attrs.kvs.format;
    if (typeof formatVal !== 'string') {
      const innerMatch = /\{([^}]*)\}/.exec(line);
      if (innerMatch) {
        const inferred = inferQ8ValueOnlyKey('if', innerMatch[1]!);
        if (inferred && inferred.key === 'format') formatVal = inferred.value;
      }
    }
    const match = typeof formatVal === 'string' ? formatVal === targetFormat : true;

    // open 行は consume(出力しない)
    i++;
    // content scan with directive-aware depth tracking
    let depth = 1;
    let innerFence: FenceState = { inFence: false, marker: '' };
    while (i < lines.length && depth > 0) {
      const inner = lines[i]!;
      const innerInputIdx = lineMapIn[i] ?? i;
      const it = fenceTransition(inner, innerFence);
      innerFence = it.state;
      if (innerFence.inFence || it.isBoundary) {
        // fence 中身は depth tracking しない、ただし match に応じて emit
        if (match) {
          out.push(inner);
        } else {
          out.push('');
        }
        lineMapOut.push(innerInputIdx);
        i++;
        continue;
      }
      if (isBlockDirectiveClose(inner)) {
        depth--;
        if (depth === 0) {
          // closing ::: は consume(出力しない)
          i++;
          break;
        }
        // nested close は emit
        if (match) {
          out.push(inner);
        } else {
          out.push('');
        }
        lineMapOut.push(innerInputIdx);
        i++;
        continue;
      }
      /**
       * ⚠ **数えるのは `classifyDirectiveOpen` が決める**(2026-08-07)。直す前は
       * `parseBlockDirectiveOpen` で数えていたので **Tier 0 / Tier 1 を数え落とし**、
       * `:::if{format=docx}` の中に `:::.hl` を書くと**捨てるはずの中身が漏れて
       * 画面に出ていた**(実測)。逆に `:::foo` のような畳まれない名前は数えて
       * しまい、`:::` を 1 つ余計に食っていた。
       */
      const innerKind = classifyDirectiveOpen(inner);
      if (innerKind === 'container') {
        depth++;
      }
      if (match) {
        out.push(inner);
      } else {
        out.push('');
      }
      lineMapOut.push(innerInputIdx);
      i++;
      if (innerKind === 'self-contained') {
        // 中を飲まない ── 直後の `:::` が在ればそれはこの directive のもの
        const after = lines[i];
        if (after !== undefined && isBlockDirectiveClose(after)) {
          out.push(match ? after : '');
          lineMapOut.push(lineMapIn[i] ?? i);
          i++;
        }
      }
    }
    // depth > 0 のまま EOF 到達 → 閉じ ::: 無し(parser tolerance、content は出力済)
  }
  return { transformed: out.join('\n'), lineMap: lineMapOut };
}

// reform-2026-05 Phase 2 PR-2F:`:::section{role=…}` semantic / callout block。
//
// 仕様(01-notation-catalog.md §1.4):
//   `:::section{role=summary|warning|note|tip|caution|important|info|danger}`
//   semantic な区切り + callout 表現を formal で提供。AI / 機械生成 doc で
//   構造化 callout を出力する formal vocabulary、user は既存 simple(`> note`
//   blockquote 等)で十分。
//
// HTML 出力:
//   <section class="pkc-section-callout pkc-section-<role>" data-pkc-role="<role>">
//     ...content (markdown rendered)...
//   </section>
//
// PUA sentinel pattern(:::quote と同じ)で markdown-it html:false 制約を回避。
const SECTION_SENTINEL_OPEN = '\u{E160}';
const SECTION_SENTINEL_SEP = '\u{E161}';

const SECTION_KNOWN_ROLES: ReadonlySet<string> = new Set([
  'summary', 'warning', 'note', 'tip', 'caution', 'important', 'info', 'danger',
  // 'cover' / 'body' / 'appendix' などの structural role も将来追加余地、
  // 現時点では callout 系 8 個に絞る(unknown は generic に attr stamp のみ)。
]);

interface SectionEntry {
  role: string;
  attrs: _BlockDirectiveAttrs;
}

/**
 * PR-2V(2026-05-12):`:::toc{depth=N}` block を正式実装。
 *
 * 入力例:
 *   :::toc
 *   :::
 *
 *   :::toc{depth=2}
 *   :::
 *
 * 動作:
 *   1. block を sentinel(U+E168/E169)で wrap、depth を含めて記録
 *   2. block 内の content(あれば)は無視(自動生成のみ)
 *   3. post-process で `extractHeadingsFromMarkdown` で TOC nodes を取得、
 *      depth で filter、`renderStaticTocHtml` 等価の `<nav class="pkc-toc">`
 *      を生成して sentinel と入れ替え
 *   4. PKC1010 deny list から除外(PR-2K)
 *
 * fence aware(``` 内は無視)。depth default は 3、range [1..6]。
 */
const TOC_OPEN = '\u{E168}';
const TOC_SEP = '\u{E169}';

interface TocDirectiveRecord {
  depth: number;
  // 将来の attr 拡張用(id / role / variant 等)
}

function processTocDirective(
  source: string,
  lineMapIn: number[],
): { transformed: string; lineMap: number[]; records: TocDirectiveRecord[] } {
  /**
   * 🔴 **本文に目印が無いなら段ごと素通りする**(2026-08-07)。出力は 1 バイトも
   * 変わらない ── この段は目印が 1 つも無ければ全行をそのまま流すだけである。
   * ⚠ 目印は**広い側**に取る(狭すぎるとその記法が黙って効かなくなる)。
   */
  if (!source.includes(':::toc')) return { transformed: source, lineMap: lineMapIn, records: [] };
  const lines = source.split('\n');
  const out: string[] = [];
  const lineMapOut: number[] = [];
  const records: TocDirectiveRecord[] = [];
  let fence: FenceState = { inFence: false, marker: '' };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const inputIdx = lineMapIn[i] ?? i;
    const t = fenceTransition(line, fence);
    fence = t.state;
    if (fence.inFence || t.isBoundary) {
      out.push(line);
      lineMapOut.push(inputIdx);
      i++;
      continue;
    }
    // `:::toc` or `:::toc{...}` を行頭(leading whitespace 許容)で検出
    const openMatch = /^[ \t]*:::toc(?:\{([^}]*)\})?\s*$/.exec(line);
    if (!openMatch) {
      out.push(line);
      lineMapOut.push(inputIdx);
      i++;
      continue;
    }
    // depth attr 抽出
    const attrs = openMatch[1] ?? '';
    const dm = /depth\s*=\s*"?(\d)"?/.exec(attrs);
    let depth = 3; // default
    if (dm) {
      const n = parseInt(dm[1]!, 10);
      if (Number.isFinite(n) && n >= 1 && n <= 6) depth = n;
    } else {
      // Q8 value-only 寛容パース(v4 §16):`:::toc{2}` → depth=2
      const inferred = inferQ8ValueOnlyKey('toc', attrs);
      if (inferred && inferred.key === 'depth') {
        const n = parseInt(inferred.value, 10);
        if (Number.isFinite(n) && n >= 1 && n <= 6) depth = n;
      }
    }
    // 🔴 **`:::toc` は 1 行で閉じる**(2026-08-05 に user 報告から判明)。
    //
    // 直す前は「次に現れる単独 `:::` まで」を探して**その間を全部 consume** していた。
    // 目次に content は無い(見出しから自動生成する)ので中身を捨てるのは正しいが、
    // **閉じ `:::` を書かない書き方**では「次の `:::`」が別のブロック
    // (`:::note` の閉じなど)に当たり、**その間の本文が丸ごと画面から消える**。
    // 閉じが 1 つも無ければ `:::toc` が literal 文字列として出る ──
    // `docs/manual.md` は閉じ無しで案内しているので、**書いたとおりに書くと出ない**。
    //
    // ⚠ 直し方は「探索範囲を狭める」ではなく「**探索をやめる**」。
    //    範囲を狭めた版は「どこまでなら飲んでよいか」という判定を新たに生み、
    //    同じ事故が別の距離で再発する(CLAUDE.md「判定を増やさない」)。
    //    後方互換として、**直後の行**が単独 `:::` のときだけ 2 行 consume する。
    const closer = lines[i + 1];
    const closesImmediately = closer !== undefined && /^[ \t]*:::[ \t]*$/.test(closer);
    const recordIdx = records.length;
    records.push({ depth });
    out.push(`${TOC_OPEN}${recordIdx}${TOC_SEP}${depth}${TOC_OPEN}`);
    lineMapOut.push(inputIdx);
    if (closesImmediately) {
      // 空行で line count を維持(source-line anchor が 1 行ずれない)
      out.push('');
      lineMapOut.push(lineMapIn[i + 1] ?? i + 1);
      i += 2;
    } else {
      i += 1;
    }
  }
  return { transformed: out.join('\n'), lineMap: lineMapOut, records };
}

/**
 * post-process:TOC sentinel を実 HTML に置換。
 * markdown-it が sentinel 行を `<p>SENTINEL</p>` で wrap するので、その paragraph 全体を
 * `<nav class="pkc-toc-formal pkc-toc-preview">` に書き換える。
 *
 * `tocHtmlByIdx` は同 render call 内の record idx → 実 HTML(`<nav>...`)map。
 * 順序保証のため processTocDirective の records と対応。
 */
/**
 * 出来上がった HTML から目次の nav を組む(`:::toc{depth=N}` 1 件につき 1 本)。
 *
 * 🔑 **読み手はここ 1 本**。本文の見出しに実際に付いた `id` をそのまま `href` に
 * 使うので、**「押しても飛ばない」が構造上つくれない**(原文をもう一度読む経路が
 * 無い)。書き出す HTML の目次(`features/export/pkc3-html.ts` の `headings()`)と
 * 同じ規則である。
 *
 * ⚠ **`id` を持たない見出しは載せない** ── 飛べない項目を目次に出さない
 *   (`heading_open` は本文が空の見出しに id を付けない)。
 * ⚠ **文字を再 escape しない** ── 拾うのは既に escape 済みの HTML である。
 *   もう一度掛けると `&amp;` が `&amp;amp;` になって画面に出る。
 * ⚠ **タグだけ落とす** ── 見出しの中の `<code>` や `<em>` は目次では素の字にする
 *   (`<a>` の中に入れ子のリンクや block を持ち込まない)。
 */
function buildTocNavsFromHtml(
  html: string,
  records: readonly { depth: number }[],
): string[] {
  if (records.length === 0) return [];
  const heads: { level: number; id: string; label: string }[] = [];
  const re = /<h([123])([^>]*)>([\s\S]*?)<\/h\1>/g;
  for (let m = re.exec(html); m !== null; m = re.exec(html)) {
    const id = /\bid="([^"]*)"/.exec(m[2] ?? '')?.[1];
    if (id === undefined || id === '') continue;
    const label = (m[3] ?? '').replace(/<[^>]*>/g, '');
    heads.push({ level: Number(m[1]), id, label });
  }
  return records.map((rec) => {
    const items = heads
      .filter((h) => h.level <= rec.depth)
      .map(
        (h) =>
          `<li class="pkc-toc-item" data-pkc-toc-kind="heading" data-pkc-toc-level="${h.level}">` +
          `<a class="pkc-toc-link" href="#${h.id}">${h.label}</a>` +
          `</li>`,
      )
      .join('');
    return (
      `<nav class="pkc-toc-formal pkc-toc-preview" data-pkc-region="toc-formal" data-pkc-toc-depth="${rec.depth}">` +
      `<span class="pkc-toc-label">Contents</span>` +
      `<ul class="pkc-toc-list">${items}</ul>` +
      `</nav>`
    );
  });
}

function postProcessTocSentinels(html: string, tocHtmlByIdx: readonly string[]): string {
  return html.replace(
    new RegExp(`<p[^>]*>${TOC_OPEN}(\\d+)${TOC_SEP}\\d+${TOC_OPEN}</p>`, 'g'),
    (_match, idxStr) => {
      const idx = parseInt(idxStr, 10);
      return tocHtmlByIdx[idx] ?? '';
    },
  );
}

// reform-2026-05 Phase 3 PR-2W(2026-05-12):`:::frontmatter` / `:::body`
// region marker を正式実装(deny list から除外)。
//
// 動作:
//   `:::frontmatter` ... `:::` → <aside class="pkc-region-frontmatter"
//     data-pkc-region="frontmatter">...content (markdown rendered)...</aside>
//   `:::body` ... `:::` → <section class="pkc-region-body"
//     data-pkc-region="body">...content (markdown rendered)...</section>
//
// 用途:AI / 機械生成 doc で region の semantic 構造化、IR migration
// (PR-2Y/2Z)で AST node `RegionNode { kind: 'frontmatter'|'body', children }`
// に migrate する entry point。`---YAML---` の document-level frontmatter とは
// 別物(あちらは metadata 抽出、本 directive は本文の region wrapper)。
//
// PUA sentinel:U+E16A / U+E16B(processSectionBlocks と同 pattern)。
// fence aware:fenced code 内 marker は無視。
// attrs:id / class / 任意 kv を受理、`data-pkc-region-*` に展開。
const REGION_SENTINEL_OPEN = '\u{E16A}';
const REGION_SENTINEL_SEP = '\u{E16B}';

const REGION_DIRECTIVE_NAMES: ReadonlySet<string> = new Set(['frontmatter', 'body']);

interface RegionEntry {
  kind: 'frontmatter' | 'body';
  attrs: _BlockDirectiveAttrs;
}

function processRegionBlocks(source: string, lineMapIn: number[]): {
  transformed: string;
  registry: Map<number, RegionEntry>;
  lineMap: number[];
} {
  return scanContainerDirective<RegionEntry>(
    source,
    lineMapIn,
    ':::',
    REGION_SENTINEL_OPEN,
    REGION_SENTINEL_SEP,
    (line) => {
      const open = parseBlockDirectiveOpen(line);
      if (!open || !REGION_DIRECTIVE_NAMES.has(open.name)) return null;
      return { kind: open.name as 'frontmatter' | 'body', attrs: open.attrs };
    },
  );
}

function postProcessRegionSentinels(
  html: string,
  registry: Map<number, RegionEntry>,
): string {
  // OPEN sentinel → <aside|section ...>
  html = html.replace(
    new RegExp(
      `<p([^>]*)>${REGION_SENTINEL_OPEN}(\\d+)${REGION_SENTINEL_SEP}OPEN${REGION_SENTINEL_OPEN}</p>`,
      'g',
    ),
    (_match, pAttrs: string, idStr: string) => {
      const id = parseInt(idStr, 10);
      const entry = registry.get(id);
      if (!entry) return '';
      const kind = entry.kind;
      const tag = kind === 'frontmatter' ? 'aside' : 'section';
      const attrs = entry.attrs;
      const classes = [`pkc-region-${kind}`, ...attrs.classes].join(' ');
      const idAttr = attrs.id ? ` id="${escapeAttrForHtml(attrs.id)}"` : '';
      const dataAttrs: string[] = [];
      for (const [k, v] of Object.entries(attrs.kvs)) {
        if (!/^[A-Za-z_][\w-]*$/.test(k)) continue;
        if (typeof v === 'boolean') {
          if (v) dataAttrs.push(`data-pkc-region-${k}="true"`);
        } else if (typeof v === 'string') {
          dataAttrs.push(`data-pkc-region-${k}="${escapeAttrForHtml(v)}"`);
        }
      }
      const dataStr = dataAttrs.length > 0 ? ' ' + dataAttrs.join(' ') : '';
      return `<${tag}${idAttr} class="${classes}" data-pkc-region="${kind}"${dataStr}${pAttrs}>`;
    },
  );
  // CLOSE sentinel → </aside> | </section>(closing tag は registry に lookup)
  html = html.replace(
    new RegExp(
      `<p[^>]*>${REGION_SENTINEL_OPEN}(\\d+)${REGION_SENTINEL_SEP}CLOSE${REGION_SENTINEL_OPEN}</p>`,
      'g',
    ),
    (_match, idStr: string) => {
      const id = parseInt(idStr, 10);
      const entry = registry.get(id);
      if (!entry) return '';
      return entry.kind === 'frontmatter' ? '</aside>' : '</section>';
    },
  );
  return html;
}

function processSectionBlocks(source: string, lineMapIn: number[]): {
  transformed: string;
  registry: Map<number, SectionEntry>;
  lineMap: number[];
} {
  return scanContainerDirective<SectionEntry>(
    source,
    lineMapIn,
    ':::section',
    SECTION_SENTINEL_OPEN,
    SECTION_SENTINEL_SEP,
    (line) => {
      const open = parseBlockDirectiveOpen(line);
      if (!open || open.name !== 'section') return null;
      // Q8 value-only 寛容パース(v4 §16):`:::section{intro}` → role=intro
      let role = typeof open.attrs.kvs.role === 'string' ? open.attrs.kvs.role : 'generic';
      if (role === 'generic') {
        const innerMatch = /\{([^}]*)\}/.exec(line);
        if (innerMatch) {
          const inferred = inferQ8ValueOnlyKey('section', innerMatch[1]!);
          if (inferred && inferred.key === 'role') role = inferred.value;
        }
      }
      return { role, attrs: open.attrs };
    },
  );
}

function postProcessSectionSentinels(
  html: string,
  registry: Map<number, SectionEntry>,
): string {
  // OPEN sentinel → <section data-pkc-role="…" class="pkc-section-callout pkc-section-<role>">
  html = html.replace(
    new RegExp(
      `<p([^>]*)>${SECTION_SENTINEL_OPEN}(\\d+)${SECTION_SENTINEL_SEP}OPEN${SECTION_SENTINEL_OPEN}</p>`,
      'g',
    ),
    (_match, pAttrs: string, idStr: string) => {
      const id = parseInt(idStr, 10);
      const entry = registry.get(id);
      if (!entry) return '';
      const role = entry.role;
      const safeRole = /^[A-Za-z][\w-]*$/.test(role) ? role : 'generic';
      // v4 §8.1.2(stack PR 7、Q8 with):8 known role + 任意 role 両方とも
      // `pkc-section-<role>` を CSS class として自動命名(AST 経路 render-html.ts:265 と
      // 動作統一、user は任意 role を user-side CSS で装飾可能)。
      const knownClass = ` pkc-section-${safeRole}`;
      void SECTION_KNOWN_ROLES; // 8 known set は将来 callout 専用処理識別用に保持
      const attrs = entry.attrs;
      const classes = ['pkc-section-callout' + knownClass, ...attrs.classes].join(' ');
      const idAttr = attrs.id ? ` id="${escapeAttrForHtml(attrs.id)}"` : '';
      // section の他 kv attrs を data-pkc-section-* に展開
      const dataAttrs: string[] = [];
      for (const [k, v] of Object.entries(attrs.kvs)) {
        if (k === 'role') continue; // role は class + data-pkc-role で扱い済
        if (!/^[A-Za-z_][\w-]*$/.test(k)) continue;
        if (typeof v === 'boolean') {
          if (v) dataAttrs.push(`data-pkc-section-${k}="true"`);
        } else if (typeof v === 'string') {
          dataAttrs.push(`data-pkc-section-${k}="${escapeAttrForHtml(v)}"`);
        }
      }
      const dataStr = dataAttrs.length > 0 ? ' ' + dataAttrs.join(' ') : '';
      return `<section${idAttr} class="${classes}" data-pkc-role="${escapeAttrForHtml(safeRole)}"${dataStr}${pAttrs}>`;
    },
  );
  // CLOSE sentinel → </section>
  html = html.replace(
    new RegExp(
      `<p[^>]*>${SECTION_SENTINEL_OPEN}\\d+${SECTION_SENTINEL_SEP}CLOSE${SECTION_SENTINEL_OPEN}</p>`,
      'g',
    ),
    '</section>',
  );
  return html;
}

// ── v4 §12:`:::format{...}` block 装飾箱 (stack PR 4、Tier 2 formal) ──
//
// Q1 で `format` directive 名確定。inline `:T:bold,red:`(catalog #9)の block
// 対応物として、複段落を任意 class / id / inline style / indent / align でくくる。
//
// 入力 sample:
//   :::format{.highlight .important #note-1 indent=2 align=center custom=value}
//   段落 1。
//
//   段落 2 も同 wrapper 内。
//   :::
//
// 出力(canonical attrs 順、§1.4):
//   <div class="pkc-format-block highlight important"
//        id="note-1"
//        data-pkc-format-block
//        data-pkc-indent="2"
//        data-pkc-align="center"
//        data-pkc-custom="value">
//     <p>段落 1。</p>
//     <p>段落 2 も同 wrapper 内。</p>
//   </div>
//
// PUA sentinel:U+E16C / U+E16D(SECTION_SENTINEL_OPEN/SEP の隣)。
const FORMAT_SENTINEL_OPEN = '\u{E16E}';
const FORMAT_SENTINEL_SEP = '\u{E16F}';

interface FormatBlockEntry {
  attrs: _BlockDirectiveAttrs;
  /** Tier 0 vocabulary form の style mapping(`color` / `background-color` / `font-size` 等)。 */
  styles?: Record<string, string>;
}

function processFormatBlocks(source: string, lineMapIn: number[]): {
  transformed: string;
  registry: Map<number, FormatBlockEntry>;
  lineMap: number[];
} {
  return scanContainerDirective<FormatBlockEntry>(
    source,
    lineMapIn,
    ':::',
    FORMAT_SENTINEL_OPEN,
    FORMAT_SENTINEL_SEP,
    (line) => {
      // v4 §12 stack PR 4-6:formal `:::format{...}` + Tier 1 class chain
      // `:::.cls.cls(#id)?` + Tier 0 vocabulary `:::red,bg-yellow,1.2em` を 3 形 accept。
      //
      // 優先順序(Q3 vocabulary priority、user direction 2026-05-25):
      //   1. formal `:::format{...}`(明示)
      //   2. Tier 0 vocabulary(全 token が valid vocab、inline と完全対称)
      //   3. Tier 1 class chain(`.cls` / brace / bare class)
      const formal = parseBlockDirectiveOpen(line);
      if (formal && formal.name === 'format') return { attrs: formal.attrs };
      const tier0 = parseTier0FormatOpen(line);
      if (tier0) {
        return { attrs: { id: undefined, classes: [], kvs: {} }, styles: tier0.styles };
      }
      const tier1 = parseTier1FormatOpen(line);
      if (tier1) return { attrs: tier1 };
      return null;
    },
  );
}

function postProcessFormatBlockSentinels(
  html: string,
  registry: Map<number, FormatBlockEntry>,
): string {
  // OPEN sentinel → <div class="pkc-format-block <classes>" id="<id>" data-pkc-format-block ...>
  html = html.replace(
    new RegExp(
      `<p([^>]*)>${FORMAT_SENTINEL_OPEN}(\\d+)${FORMAT_SENTINEL_SEP}OPEN${FORMAT_SENTINEL_OPEN}</p>`,
      'g',
    ),
    (_match, pAttrs: string, idStr: string) => {
      const id = parseInt(idStr, 10);
      const entry = registry.get(id);
      if (!entry) return '';
      const attrs = entry.attrs;
      // classes: pkc-format-block + ABC sorted user classes
      const sortedClasses = [...attrs.classes].sort((a, b) => a.localeCompare(b));
      const classStr = ['pkc-format-block', ...sortedClasses].join(' ');
      const idAttr = attrs.id ? ` id="${escapeAttrForHtml(attrs.id)}"` : '';
      const markerAttr = ' data-pkc-format-block';
      // indent / align は特殊解釈 key、data-pkc-indent / data-pkc-align に
      const indentRaw = attrs.kvs.indent;
      const indent = typeof indentRaw === 'string'
        ? Math.max(1, Math.min(10, parseInt(indentRaw, 10) || 0))
        : null;
      const indentAttr = indent && indent > 0 ? ` data-pkc-indent="${indent}"` : '';
      const alignRaw = attrs.kvs.align;
      /**
       * 🔴 **`:::paragraph` が受けるものは全部受ける**(2026-08-06)。直す前の
       * allowlist は `left|center|right|justify` だけで、`start` / `end` /
       * `top` / `bottom` を**黙って落としていた** ── 同じ `align` という語で
       * 受理集合が 2 か所に別々に生えており、`:::format{align=end}` は
       * `align=letterspacing` と同じ no-op だった。
       * ⚠ 規則は 1 つに寄せる(CLAUDE.md)── ここは `FORMAL_ALIGNS` を引く。
       *   `justify` は装飾箱だけの値(spec v4 §12 の `AstFormatBlock`)なので
       *   別に足す。parity は `markdown-user-reports.test.ts` が pin する。
       */
      const align =
        typeof alignRaw === 'string' &&
        (FORMAL_ALIGNS.has(alignRaw as AlignKind) || alignRaw === 'justify')
          ? alignRaw
          : null;
      const alignAttr = align ? ` data-pkc-align="${align}"` : '';
      // Tier 0 vocabulary styles(ABC sorted、`style="..."` として emit)
      let styleAttr = '';
      if (entry.styles) {
        const styleEntries = Object.entries(entry.styles).sort(([a], [b]) => a.localeCompare(b));
        if (styleEntries.length > 0) {
          const styleStr = styleEntries.map(([k, v]) => `${k}: ${v}`).join('; ');
          styleAttr = ` style="${escapeAttrForHtml(styleStr)}"`;
        }
      }
      // その他 kvs、ABC 順、boolean true は値なし
      const otherKvs: Array<[string, string | boolean]> = [];
      for (const [k, v] of Object.entries(attrs.kvs)) {
        if (k === 'indent' || k === 'align') continue;
        if (!/^[A-Za-z_][\w-]*$/.test(k)) continue;
        otherKvs.push([k, v]);
      }
      otherKvs.sort(([a], [b]) => a.localeCompare(b));
      let kvsStr = '';
      for (const [k, v] of otherKvs) {
        if (v === true) kvsStr += ` data-pkc-${k}`;
        else if (v === false) continue;
        else kvsStr += ` data-pkc-${k}="${escapeAttrForHtml(String(v))}"`;
      }
      return `<div class="${classStr}"${idAttr}${markerAttr}${styleAttr}${indentAttr}${alignAttr}${kvsStr}${pAttrs}>`;
    },
  );
  // CLOSE sentinel → </div>
  html = html.replace(
    new RegExp(
      `<p[^>]*>${FORMAT_SENTINEL_OPEN}\\d+${FORMAT_SENTINEL_SEP}CLOSE${FORMAT_SENTINEL_OPEN}</p>`,
      'g',
    ),
    '</div>',
  );
  return html;
}

// ── 領域 6:`:::details{summary="…"}` 折りたたみブロック方言 ──
//
// 任意位置の content を native <details> / <summary> で畳む方言。
//   :::details{summary="クリックで開く見出し"}
//   折りたたまれる本文。**markdown** 可。
//   :::
//
// HTML 出力(レンダラ生成 — ユーザーは生 HTML を書かない):
//   <details class="pkc-details"><summary class="pkc-details-summary">…
//     </summary>…content…</details>
// 既定は畳んだ状態(native <details> 準拠)、`{open}` で既定展開。
// summary 省略時は「詳細」。:::section と同じ PUA sentinel pattern で
// markdown-it `html: false` 制約を回避する。
const DETAILS_SENTINEL_OPEN = '\u{E16C}';
const DETAILS_SENTINEL_SEP = '\u{E16D}';

interface DetailsEntry {
  summary: string;
  open: boolean;
}

function processDetailsBlocks(source: string, lineMapIn: number[]): {
  transformed: string;
  registry: Map<number, DetailsEntry>;
  lineMap: number[];
} {
  return scanContainerDirective<DetailsEntry>(
    source,
    lineMapIn,
    ':::details',
    DETAILS_SENTINEL_OPEN,
    DETAILS_SENTINEL_SEP,
    (line) => {
      const open = parseBlockDirectiveOpen(line);
      if (!open || open.name !== 'details') return null;
      const rawSummary = open.attrs.kvs.summary;
      const summary =
        typeof rawSummary === 'string' && rawSummary.length > 0 ? rawSummary : '詳細';
      return { summary, open: open.attrs.kvs.open === true };
    },
  );
}

function postProcessDetailsSentinels(
  html: string,
  registry: Map<number, DetailsEntry>,
): string {
  // OPEN sentinel → <details class="pkc-details" [open]><summary>…</summary>
  html = html.replace(
    new RegExp(
      `<p([^>]*)>${DETAILS_SENTINEL_OPEN}(\\d+)${DETAILS_SENTINEL_SEP}OPEN${DETAILS_SENTINEL_OPEN}</p>`,
      'g',
    ),
    (_match, pAttrs: string, idStr: string) => {
      const id = parseInt(idStr, 10);
      const entry = registry.get(id);
      if (!entry) return '';
      const openAttr = entry.open ? ' open' : '';
      return `<details class="pkc-details"${openAttr}${pAttrs}>`
        + `<summary class="pkc-details-summary">${escapeAttrForHtml(entry.summary)}</summary>`;
    },
  );
  // CLOSE sentinel → </details>
  html = html.replace(
    new RegExp(
      `<p[^>]*>${DETAILS_SENTINEL_OPEN}\\d+${DETAILS_SENTINEL_SEP}CLOSE${DETAILS_SENTINEL_OPEN}</p>`,
      'g',
    ),
    '</details>',
  );
  return html;
}

function processQuoteBlocks(source: string, lineMapIn: number[]): {
  transformed: string;
  registry: Map<number, QuoteEntry>;
  lineMap: number[];
} {
  return scanContainerDirective<QuoteEntry>(
    source,
    lineMapIn,
    ':::quote',
    QUOTE_SENTINEL_OPEN,
    QUOTE_SENTINEL_SEP,
    (line) => {
      const open = parseBlockDirectiveOpen(line);
      if (!open || open.name !== 'quote') return null;
      // Q8 value-only 寛容パース(v4 §16):`:::quote{"夏目漱石"}` → author=夏目漱石
      let attrsForQuote = open.attrs;
      if (typeof attrsForQuote.kvs.author !== 'string') {
        const innerMatch = /\{([^}]*)\}/.exec(line);
        if (innerMatch) {
          const inferred = inferQ8ValueOnlyKey('quote', innerMatch[1]!);
          if (inferred && inferred.key === 'author') {
            attrsForQuote = {
              ...attrsForQuote,
              kvs: { ...attrsForQuote.kvs, author: inferred.value },
            };
          }
        }
      }
      return { attrs: attrsForQuote };
    },
  );
}

/** HTML attribute value に安全に埋め込む(`"` `<` `>` `&` を escape)。 */
function escapeAttrForHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function postProcessQuoteSentinels(
  html: string,
  registry: Map<number, QuoteEntry>,
): string {
  // OPEN sentinel → <blockquote class="pkc-quote-citation" data-pkc-quote-*="...">
  html = html.replace(
    new RegExp(
      `<p([^>]*)>${QUOTE_SENTINEL_OPEN}(\\d+)${QUOTE_SENTINEL_SEP}OPEN${QUOTE_SENTINEL_OPEN}</p>`,
      'g',
    ),
    (_match, pAttrs: string, idStr: string) => {
      const id = parseInt(idStr, 10);
      const entry = registry.get(id);
      if (!entry) return '';
      const attrs = entry.attrs;
      const dataAttrs: string[] = [];
      // kvs を data-pkc-quote-<key>="<value>" に展開
      for (const [k, v] of Object.entries(attrs.kvs)) {
        if (!/^[A-Za-z_][\w-]*$/.test(k)) continue;
        if (typeof v === 'boolean') {
          if (v) dataAttrs.push(`data-pkc-quote-${k}="true"`);
        } else if (typeof v === 'string') {
          dataAttrs.push(`data-pkc-quote-${k}="${escapeAttrForHtml(v)}"`);
        }
      }
      // class 追加
      const classes = ['pkc-quote-citation', ...attrs.classes].join(' ');
      const idAttr = attrs.id ? ` id="${escapeAttrForHtml(attrs.id)}"` : '';
      const dataStr = dataAttrs.length > 0 ? ' ' + dataAttrs.join(' ') : '';
      return `<blockquote${idAttr} class="${classes}"${dataStr}${pAttrs}>`;
    },
  );
  // CLOSE sentinel → </blockquote>
  html = html.replace(
    new RegExp(
      `<p[^>]*>${QUOTE_SENTINEL_OPEN}\\d+${QUOTE_SENTINEL_SEP}CLOSE${QUOTE_SENTINEL_OPEN}</p>`,
      'g',
    ),
    '</blockquote>',
  );
  return html;
}

function postProcessFigureSentinels(html: string): string {
  // <p>OPENkindidnum</p>
  // 各 sentinel 行は <p attrs> を持ちうる(sourceLineAnchors path)。attrs を
  // 保存して置換要素に転記、Split View block ↔ source line lookup を維持。
  html = html.replace(
    // ⚠ id の欄は**空でありうる**(2026-08-06 ── 参照しない図には id を要求しない)。
    //    `[\w-]+` のままだと id 無しの図の sentinel が置換されず、PUA の文字が
    //    そのまま画面に出る(sentinel 漏れ = 2026-05-08 に踏んだ形)
    new RegExp(`<p([^>]*)>${FIG_SENTINEL_OPEN}OPEN${FIG_SENTINEL_SEP}(figure|table|equation)${FIG_SENTINEL_SEP}([\\w-]*)${FIG_SENTINEL_SEP}(\\d+)${FIG_SENTINEL_OPEN}</p>`, 'g'),
    (_match, attrs, kind, id, num) =>
      `<figure${id === '' ? '' : ` id="${id}"`} class="pkc-fig pkc-fig-${kind}"` +
      ` data-pkc-fig-kind="${kind}" data-pkc-fig-num="${num}"${attrs}>`,
  );
  html = html.replace(
    new RegExp(`<p([^>]*)>${FIG_SENTINEL_OPEN}CAPTION${FIG_SENTINEL_SEP}(figure|table|equation)${FIG_SENTINEL_SEP}(\\d+)${FIG_SENTINEL_SEP}([^${FIG_SENTINEL_OPEN}]+)${FIG_SENTINEL_OPEN}</p>`, 'g'),
    (_match, attrs, kind, num, captionRaw) => {
      const prefix = FIG_LABEL_PREFIX[kind as FigKind];
      // caption は markdown-it が既に inline markup(<strong>等)を render 済。
      // 再 escape すると `&lt;strong&gt;` に化けるので raw のまま埋める。
      // raw HTML は markdown-it `html: false` で source 由来の `<` は escape 済。
      return `<figcaption class="pkc-fig-caption"${attrs}>${prefix} ${num}: ${captionRaw as string}</figcaption>`;
    },
  );
  html = html.replace(
    new RegExp(`<p[^>]*>${FIG_SENTINEL_OPEN}CLOSE${FIG_SENTINEL_OPEN}</p>`, 'g'),
    '</figure>',
  );
  // Inline references
  html = html.replace(
    new RegExp(`${FIG_REF_OPEN}([\\w-]+)${FIG_REF_SEP}([^${FIG_REF_CLOSE}]+)${FIG_REF_CLOSE}`, 'g'),
    (_match, id, label) => `<a href="#${id}" class="pkc-fig-ref">${label}</a>`,
  );
  return html;
}

/**
 * L-5 (2026-05-07、wave-10-2 Phase 1)+ reform-2026-05 PR-C(typo 寛容化):
 * 行頭 align prefix。
 *
 * **semantics**(user 裁定 2026-08-08、Issue #103 で確定):
 *
 *   - `||`                          → center(物理中央、書字方向 不変)
 *   - `|>` `<|` `|<` `>|`(全 4 形)→ **opposite**(グローバルの寄せの**反対側**)。
 *     裁定「**|> も<|も|<も意味は同じ、グローバルの文字の寄せを反対にする**」──
 *     宣言 align が無ければ flow の終端(LTR + horizontal なら右、RTL なら左、
 *     vertical なら下)。宣言 align が flow start と逆の文書では flow start 側
 *     (app.css の入れ替え規則が見え方を反転する ── この関数は関与しない)。
 *
 * **breaking change**(reform-2026-05):reform 前は `<|text` が "left explicit"
 * だったが、end に変わった。物理強制が必要な場合は formal
 * `:::paragraph{align=left}` 等を使う。Postel's law(受信寛容)で typo の
 * 4 形を全部受理。
 *
 * Algorithm:
 *  1. pre-process で line ごとに prefix 検出、strip + 行番号 → align map を記録
 *  2. md.parse 後、token を walk して paragraph_open の map[0] が map に
 *     あれば `data-pkc-align` 属性を付与
 *  3. CSS が `[data-pkc-align="..."]` を読んで text-align を適用
 *     (`end` / `start` は CSS logical value、`direction: rtl` で自動 flip。
 *      🔴 **反転が当たるのは `opposite` だけ**(= 象形的な形が出す専用値)。
 *      説明的な形の `end` / `start` には 1 本も当たらない ── 越境の理由は
 *      下の `AlignKind` の註記に書いてある。**ここに書き戻さないこと。**)
 */
// reform-2026-05 Phase 2 PR-2E:`:::paragraph{align=top|bottom}` の vertical
// writing-mode 用 align も追加(物理 align、formal-only)。
/**
 * 🔴 **`opposite` は象形的な形(行頭 prefix)だけが出す値**(user 指摘 2026-08-08)。
 *
 * 象形的な形 `|>` `<|` `|<` `>|` は**矢印の絵**であり、向きを描き間違えても意図が
 * 通るので 4 形が同義になる(= typo を意味に通せる)。その意味は裁定により
 * 「**グローバルの文字の寄せを反対にする**」であって、logical end ではない。
 *
 * ⚠ 説明的な形(`:::paragraph{align=end|start}`)は**値を言葉で書いている**ので
 * `align=strat` を意味に通すことはできない ── 寛容さが成立しない形である。
 * したがって `end` は logical end、`start` は logical start のままで、**反転しない**。
 *
 * 🔴 **この 2 つの形の境界は契約であり、越えてはならない**(user 指摘 2026-08-08:
 * 「説明的な形式に対して象形的な形式の考え方を持ち込み…思想的な破壊的変更」)。
 * ⚠ 直す前は両方が `data-pkc-align="end"` を出しており、CSS の入れ替えが
 *   **説明的な形にも当たっていた**。属性を潰したまま意味だけ分けようとしたのが誤り。
 * ⚠ したがって `FORMAL_ALIGNS` に `opposite` を入れてはならない ──
 *   説明的な形からは**書けない値**である(書けたら境界が消える)。
 */
type AlignKind = 'center' | 'opposite' | 'end' | 'start' | 'right' | 'left' | 'top' | 'bottom';

const PHYSICAL_ALIGNS: ReadonlySet<AlignKind> = new Set([
  'left', 'right', 'top', 'bottom', 'center',
] as const);

/**
 * 🔴 **formal 形は logical 値も受ける**(2026-08-06。曖昧記法の調査で判明)。
 *
 * 記法の正本は formal に logical 値(`start` / `end`)を認めている ──
 * `PKC2: docs/spec/pkc-markdown-complete-spec-v4.md` #33
 * 「`:::paragraph{align=center|end|start} T :::`」。
 * ⚠ **旧 canonicalization(`|> 本文` → `:::paragraph{align=end}`)は、裁定
 * 2026-08-08 で `|>` の意味が「グローバルの寄せの反対側」に変わった時点で
 * 成り立たなくなった** ── 2 つは別物であり、`|>` は `opposite` を出す。
 * この言い換えを根拠に「`end` も反転する」と考えないこと(user 指摘: 思想的な破壊的変更)。
 *
 * ⚠ にもかかわらず、判定は**物理値だけ**の allowlist を通っていたので、
 * `align=end` / `align=start` は `align=letterspacing` と同じ**黙った no-op**
 * だった(実測: left / right / center は効き、end / start / justify は適用なし)。
 * つまり「行頭マーカーの canonical な書き方」が**存在しないことになっていた**。
 * ⚠ CSS 側は最初から対応していた(`app.css` の `[data-pkc-align='end'|'start'|'justify']`)
 * ── 落ちていたのは受理側 1 か所だけである。
 * 🔑 物理と logical を**別の集合**で持つ:混ぜると「物理 align」という語が嘘になる。
 */
const LOGICAL_ALIGNS: ReadonlySet<AlignKind> = new Set(['start', 'end'] as const);

/**
 * formal 形(`:::paragraph{align=…}` / `:::format{align=…}`)が受ける align の全部。
 * 🔑 **受理集合は 1 つ**にする ── 直す前は `:::format` 側が
 * `left|center|right|justify` の独自 allowlist を持っており、`start` / `end` /
 * `top` / `bottom` を黙って落としていた(同じ語の受理集合が 2 か所)。
 */
const FORMAL_ALIGNS: ReadonlySet<AlignKind> = new Set([
  ...PHYSICAL_ALIGNS,
  ...LOGICAL_ALIGNS,
] as const);

/**
 * reform-2026-05 Phase 2 PR-2E:`:::paragraph{align=physical}` block directive。
 *
 *   :::paragraph{align=left}
 *   本文
 *   :::
 *
 * 物理 align(left / right / center / top / bottom)を強制する formal-only 形。
 * AI / serializer が emit、user は L-5 行頭 prefix で十分(simple は logical、
 * formal で物理強制が必要な場合のみ使う)。
 *
 * 動作:
 *   - `:::paragraph{align=left}` 開き行を consume
 *   - content 各行の output line に対し `alignMap` に物理 align を登録
 *   - `:::` 閉じ行を consume
 *   - 不正 align 値(letterspacing 等)は warning + skip
 *
 * processQuoteBlocks の後、preprocessAlignPrefix の前に走らせる。content 内に
 * 行頭 align prefix(`||` 等)があった場合は preprocessAlignPrefix が後段で
 * 処理(両方 alignMap に register され、後者(行頭 prefix)が上書き優先)。
 */
function processParagraphAlignDirective(
  source: string,
  lineMapIn: number[],
): {
  transformed: string;
  alignMap: Map<number, AlignKind>;
  lineMap: number[];
} {
  /**
   * 🔴 **本文に目印が無いなら段ごと素通りする**(2026-08-07)。出力は 1 バイトも
   * 変わらない ── この段は目印が 1 つも無ければ全行をそのまま流すだけである。
   * ⚠ 目印は**広い側**に取る(狭すぎるとその記法が黙って効かなくなる)。
   */
  if (!source.includes(':::paragraph')) return { transformed: source, alignMap: new Map(), lineMap: lineMapIn };
  const lines = source.split('\n');
  const alignMap = new Map<number, AlignKind>();
  const out: string[] = [];
  const lineMapOut: number[] = [];
  let fence: FenceState = { inFence: false, marker: '' };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const inputIdx = lineMapIn[i] ?? i;
    const t = fenceTransition(line, fence);
    fence = t.state;
    if (fence.inFence || t.isBoundary) {
      out.push(line);
      lineMapOut.push(inputIdx);
      i++;
      continue;
    }
    const open = parseBlockDirectiveOpen(line);
    if (!open || open.name !== 'paragraph') {
      out.push(line);
      lineMapOut.push(inputIdx);
      i++;
      continue;
    }
    const alignRaw = open.attrs.kvs.align;
    let align: AlignKind | null = null;
    // ⚠ 物理(left/right/top/bottom/center)と logical(start/end)の**両方**を受ける
    //    ── 規約が formal に logical 値を認めているため(2026-08-06)。
    // ⚠ ここは **`opposite` を受けない**(象形的な形の専用値)── 受けると、
    //    寛容さを持たない説明的な形に CSS の入れ替えが当たる(境界の踏み越え)
    if (typeof alignRaw === 'string' && FORMAL_ALIGNS.has(alignRaw as AlignKind)) {
      align = alignRaw as AlignKind;
    }
    // open 行は consume
    i++;
    while (i < lines.length && !isBlockDirectiveClose(lines[i]!)) {
      const inner = lines[i]!;
      const innerInputIdx = lineMapIn[i] ?? i;
      // align が valid なら content 行の output index に対し register
      if (align && inner.trim() !== '') {
        alignMap.set(out.length, align);
      }
      out.push(inner);
      lineMapOut.push(innerInputIdx);
      i++;
    }
    // close 行を consume
    if (i < lines.length) i++;
  }
  return { transformed: out.join('\n'), alignMap, lineMap: lineMapOut };
}

function preprocessAlignPrefix(source: string, lineMapIn: number[]): {
  stripped: string;
  alignMap: Map<number, AlignKind>;
  indentMap: Map<number, true>;
  lineMap: number[];
} {
  const lines = source.split('\n');
  const alignMap = new Map<number, AlignKind>();
  // L-9(2026-05-08):行頭の `__`(半角 _ × 2)or `＿`(全角 _、U+FF3F)は
  // 段落先頭 1 字下げマーカー。日本語文書の段落字下げ慣習を表現。indentMap は
  // OUTPUT line index → true。alignMap と orthogonal、両方適用も可。
  const indentMap = new Map<number, true>();
  const out: string[] = [];
  const lineMapOut: number[] = [];
  let currentAlign: AlignKind | null = null;
  // Detect prefix at line start. reform-2026-05 PR-C で 4 形の typo 寛容化:
  // `||` (center) + `|>` / `<|` / `|<` / `>|` (全 4 形 opposite) followed by optional space.
  // 行頭の空白系文字種は無視(2026-05-08 user 統一方針:行頭系シンプル記法は
  // leading whitespace を全部 strip)。`   |>` / `\t|<` 等もマーカーとして拾う。
  const prefixRe = /^\s*(\|\||\|>|<\||\|<|>\|)(?:\s)?(.*)$/;
  // L-9 indent prefix:`__` or `＿`(U+FF3F、全角アンダースコア)。`___`
  // 以上の連続(markdown horizontal rule)は捕まえないため `(?!_)` で除外、
  // また content 末尾が `__` で終わる場合は markdown bold 行と解釈して
  // skip(`__bold__` を indent 化しない)。
  const indentRe = /^\s*(?:__|＿)(?!_)\s?(.*)$/;
  // alignMap は **OUTPUT line index** に対する map(2026-05-07 hotfix で
  // input → output index へ移行)。prefix 行は前後で paragraph 分離されるため、
  // `breaks: true` で連続行が 1 paragraph に merge される問題を回避する。

  // fenced code block 内では align / indent prefix を marker と認識しない
  // (2026-05-08 hotfix)。fence 中は素通し、currentAlign も reset。
  let fence: FenceState = { inFence: false, marker: '' };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const inputIdx = lineMapIn[i] ?? i;
    const t = fenceTransition(line, fence);
    fence = t.state;
    if (fence.inFence || t.isBoundary) {
      currentAlign = null;
      out.push(line);
      lineMapOut.push(inputIdx);
      continue;
    }
    const trimmed = line.trim();
    // Blank line ends the aligned paragraph.
    if (trimmed === '') {
      currentAlign = null;
      out.push(line);
      lineMapOut.push(inputIdx);
      continue;
    }
    // Structural breaks(heading / list / blockquote / fence / hr / table)
    // also reset alignment — alignment applies to paragraphs only.
    const isStructural =
      /^#{1,6}\s/.test(line)
      || /^[-*+]\s/.test(line)
      || /^\d+\.\s/.test(line)
      || /^>/.test(line)
      || /^```/.test(line)
      || /^---+\s*$/.test(line)
      || /^\|/.test(line);  // table row(also catches `||` but prefix matches first)
    // Detect L-5 align prefix
    const m = prefixRe.exec(line);
    if (m) {
      const sym = m[1]!;
      const rest = m[2] ?? '';
      /**
       * reform-2026-05 PR-C:logical alignment へ移行。
       *   `||`                    → center(対称形。typo 少なく別形なし)
       *   `|>` `<|` `|<` `>|`     → **全 4 形が opposite**(typo 寛容)
       *
       * 🔴 **矢印の向きは意味を持たない**(user 裁定 2026-08-08、Issue #103):
       *
       * > **|> も<|も|<も意味は同じ、グローバルの文字の寄せを反対にする**(寛容なパーサー)
       *
       * 「反対」の基準は**文書全体の宣言**(frontmatter の `direction` / `align`。
       * `features/markdown/document-globals.ts` が `dir` / `data-pkc-doc-align` に写す)
       * であって、**行頭マーカーが物理方向を主張してはいけない**(「左」の行頭マーカーは
       * catalog §1.4.1 で廃止済み ── 左寄せ強制は formal `:::paragraph{align=left}`)。
       * simple 形が持つのは「中央」と「グローバルの寄せの反対側」の 2 つだけである。
       *
       * 🔴 **ここで出す値は `opposite`** ── 説明的な形(`:::paragraph{align=end}`)と
       * **別の値**でなければならない(user 指摘 2026-08-08)。同じ値にすると、
       * CSS の入れ替えが**寛容さを持たない説明的な形にまで漏れる**。
       * ⚠ かつてここは `end` を出しており、「renderer / goldens が 1 バイトも動かない」
       * ことを利点として掲げていた ── それは 2 つの形を潰していたことの裏返しだった。
       * 反転そのものは **app.css の入れ替え規則**(CSS)の仕事で、renderer は値を出すだけ
       * (規約の 2 通り ── ① draft §2.3.6「宣言した既定の流れの反対側」/
       *  ② canonical 3 本「logical end 固定」── は裁定で ① に決着した)。
       *
       * ⚠ **2026-08-06 に一度これを `start` へ変えて、user に誤りを指摘されて戻した**
       * (経緯は同日の調査 doc §3-1 m-2)── 「向き」を記号ごとに意味として読む変更は
       * 裁定後も誤りである(4 形は同値。catalog §1.4.2 と裁定引用の両方が言っている)。
       * 🔑 教訓: **記法の意味は「記号の見た目」ではなく正本(catalog / 裁定)で決まる**。
       */
      const align: AlignKind = sym === '||' ? 'center' : 'opposite';
      // **重要**:prefix 行は前段落から切り離して新 paragraph にする。
      // 挿入する空行も同じ inputIdx を指す(sync layer の lookup は閉じた区間で
      // 動くので副作用なし)。
      const prevOut = out.length > 0 ? out[out.length - 1]! : '';
      if (prevOut.trim() !== '') {
        out.push('');
        lineMapOut.push(inputIdx);
      }
      const outIdx = out.length;
      currentAlign = align;
      alignMap.set(outIdx, align);
      // L-9 indent も一緒に判定(align prefix 後の content が `__段落` の場合)
      const im0 = indentRe.exec(rest);
      if (im0 && !rest.endsWith('__')) {
        indentMap.set(outIdx, true);
        out.push(im0[1] ?? '');
      } else {
        out.push(rest);
      }
      lineMapOut.push(inputIdx);
      continue;
    }
    // Detect L-9 indent prefix(align なしの行)
    const im = indentRe.exec(line);
    if (im && !line.endsWith('__')) {
      const rest = im[1] ?? '';
      // 同じく前段落と paragraph merge されないよう前後を空行で囲む。
      const prevOut = out.length > 0 ? out[out.length - 1]! : '';
      if (prevOut.trim() !== '') {
        out.push('');
        lineMapOut.push(inputIdx);
      }
      const outIdx = out.length;
      indentMap.set(outIdx, true);
      currentAlign = null;
      out.push(rest);
      lineMapOut.push(inputIdx);
      continue;
    }
    // Continuation line: inherit current alignment unless structural break.
    if (isStructural) {
      currentAlign = null;
      out.push(line);
      lineMapOut.push(inputIdx);
      continue;
    }
    if (currentAlign) {
      // 2026-05-09 user バグレポ:`|>` prefix 行の直後に **prefix なし通常行** が
      // 来た場合、user 期待は「prefix 行 = 単独段落、次行 = default 段落」。
      // 直前 prefix 行と段落 merge されないよう blank 行を挿入して paragraph を
      // 分離し、currentAlign を reset。これで `|> A\nB\n|> C` が 3 paragraph
      // (A=end / B=default / C=end)に正しく分離される。
      // commonmark 的には A\nB\n は 1 段落だが、PKC2 は `breaks: true`(`\n`→`<br>`)
      // 設定下で「prefix は line scope」を user contract として採用する。
      out.push('');
      lineMapOut.push(inputIdx);
      currentAlign = null;
    }
    out.push(line);
    lineMapOut.push(inputIdx);
  }
  return { stripped: out.join('\n'), alignMap, indentMap, lineMap: lineMapOut };
}

function applyAlignAttrs(
  tokens: Token[],
  alignMap: Map<number, AlignKind>,
  indentMap: Map<number, true>,
): void {
  if (alignMap.size === 0 && indentMap.size === 0) return;
  for (const tok of tokens) {
    // align(L-5 行頭 prefix `||` = center / `|>` `<|` `|<` `>|` = opposite)は段落 + 見出し両方に
    // 適用する(`||## 見出し` 等)。indent(L-9 字下げ `__`)は段落専用
    // ── 見出しの 1 字下げは意味を成さないため除外する。
    if ((tok.type === 'paragraph_open' || tok.type === 'heading_open') && tok.map) {
      const startLine = tok.map[0];
      const align = alignMap.get(startLine);
      if (align) {
        tok.attrSet('data-pkc-align', align);
      }
      if (tok.type === 'paragraph_open' && indentMap.get(startLine)) {
        tok.attrSet('data-pkc-indent', '1');
      }
    }
  }
}

/**
 * L-4(2026-05-07、wave-10-2 Phase 1):Comments(`%%` inline / `%%%` block)。
 * spec doc §3.4:本文中に隠しメモを書ける、render では完全に削除。
 *
 *   %% inline comment、export では完全削除 %%
 *
 *   %%%
 *   block comment、複数行可
 *   %%%
 *
 *   :::comment{…}
 *   formal block comment(`%%%` 等価、AI / serializer が emit)
 *   :::
 *
 * PR-2X(2026-05-12、reform Phase 3):**LineMap thread 対応**。multi-line
 * block comment(`%%%...%%%` / `:::comment...:::`)が複数行に跨ぐとき、
 * 削除された行を skip しつつ output line → 原文 line index を保持。Split
 * View source-preview-sync が `data-pkc-source-line` で逆引きする contract
 * を maintain、source-line ズレ bug を構造的に防止。
 */
function stripComments(source: string, lineMapIn?: number[]): {
  transformed: string;
  lineMap: number[];
} {
  /**
   * 🔴 **本文に目印が無いなら段ごと素通りする**(2026-08-07)。出力は 1 バイトも
   * 変わらない ── この段は目印が 1 つも無ければ全行をそのまま流すだけである。
   * ⚠ 目印は**広い側**に取る(狭すぎるとその記法が黙って効かなくなる)。
   */
  if (!source.includes('%%') && !source.includes(':::comment')) {
    return {
      transformed: source,
      lineMap: lineMapIn ?? Array.from({ length: source.split('\n').length }, (_, i) => i),
    };
  }
  const lines = source.split('\n');
  const inMap = lineMapIn ?? Array.from({ length: lines.length }, (_, i) => i);
  const outLines: string[] = [];
  const outMap: number[] = [];
  let fence: FenceState = { inFence: false, marker: '' };
  let inBlockComment = false; // %%%...%%%
  let inCommentDirective = false; // :::comment...:::
  let pendingPrefix = '';
  let pendingSrcIdx = -1;
  // `:::comment` 系の unclosed 保護:open 行から close まで buffer、close 見つかれば
  // 捨てる、close 無く EOF なら restore(元 stripComments の挙動を維持)。
  const commentDirectiveBuffer: Array<{ line: string; srcIdx: number }> = [];
  const stripInline = (s: string) => s.replace(/%%[^\n]*?%%/g, '');
  // PR-2X hotfix(2026-05-12):inline code 内の `%%%` を block comment 開始と
  // 誤検出するバグ修正。`stripComments` の %%% scan の前に inline backtick
  // span を一時 sentinel に置換、scan 後に復元する。fence 行(``` 単独行)
  // とは別、行内 `code` の話。table cell に `%%%` を含めると表が崩れる症状の
  // root cause(2026-05-12 user バグレポ:「表が壊れてる」)。
  const INLINE_CODE_OPEN = '\u{E170}';
  const INLINE_CODE_CLOSE = '\u{E171}';
  function maskInlineCode(line: string): { masked: string; spans: string[] } {
    const spans: string[] = [];
    const masked = line.replace(/`+[^`\n]*?`+/g, (m) => {
      const idx = spans.length;
      spans.push(m);
      return `${INLINE_CODE_OPEN}${idx}${INLINE_CODE_CLOSE}`;
    });
    return { masked, spans };
  }
  function unmaskInlineCode(line: string, spans: readonly string[]): string {
    return line.replace(
      new RegExp(`${INLINE_CODE_OPEN}(\\d+)${INLINE_CODE_CLOSE}`, 'g'),
      (_m, idxStr) => spans[parseInt(idxStr, 10)] ?? '',
    );
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const srcIdx = inMap[i] ?? i;
    const t = fenceTransition(line, fence);
    const wasIn = fence.inFence;
    fence = t.state;
    const isFenceContent = wasIn || t.isBoundary;
    if (isFenceContent) {
      // Fenced code:passthrough(block comment 状態は維持しない、fence は優先)
      if (!inBlockComment && !inCommentDirective) {
        outLines.push(line);
        outMap.push(srcIdx);
      }
      continue;
    }
    if (inCommentDirective) {
      if (/^[ \t]*:::[ \t]*$/.test(line)) {
        inCommentDirective = false;
        commentDirectiveBuffer.length = 0; // close 見つかった、buffer 破棄
      } else {
        commentDirectiveBuffer.push({ line, srcIdx });
      }
      continue;
    }
    // PR-2JJ v2 hotfix(2026-05-13、CI smoke regression fix):
    // `%%%` block comment marker は spec 上 **行頭 anchor 必須**(`docs/spec/
    // markdown-dialect-for-ai-authors-v1.md` §checklist L-4「block comment
    // `%%%` が単独行で開閉しているか」)。mid-line `%%%` を block boundary
    // 扱いすると、heading 等で literal に `%%%` を書いた瞬間に後続 content
    // が全部 comment 内扱いで消える致命バグ(transclusion smoke regression、
    // user 報告:「## %% comment / %%% block comment」 heading が原因で
    // 終端 / 起案者 / 本文末尾の 3 行が render に出ない症状)。
    //
    // 修正 contract:line が **`%%%` で始まる場合のみ** block marker と認識:
    //   (a)`%%%`(余白のみ)                → open / close marker
    //   (b)`%%%text%%%`(両端で挟まれた form)→ 単一行 block コメント(strip)
    //   (c)`%%%text`(末尾 close 無し)      → open marker + 後続を pending に
    //   (d)`text %%%`(行中の `%%%`)        → literal text として通す
    //
    // (a)〜(c)は trimmed line が `%%%` で始まることが必要条件。
    const trimmedLine = line.replace(/^[ \t]+/, '');
    const startsWithBlockMarker = trimmedLine.startsWith('%%%');
    const isStandaloneBlockMarker = /^[ \t]*%%%[ \t]*$/.test(line);
    if (inBlockComment) {
      // 閉じは「行が `%%%` で終わる」または「単独 `%%%` line」のみ受理。
      // mid-line `%%%` は閉じ marker として扱わない(open と対称)。
      const trimmed = line.trimEnd();
      if (trimmed.endsWith('%%%')) {
        outLines.push(stripInline(pendingPrefix));
        outMap.push(pendingSrcIdx);
        pendingPrefix = '';
        pendingSrcIdx = -1;
        inBlockComment = false;
      }
      continue;
    }
    // `:::comment` open 検出(行頭、attrs 任意)。open 自体は buffer 起点として
    // 押す(close 無く EOF なら restore)。
    if (/^[ \t]*:::comment(?:\{[^}]*\})?[ \t]*$/.test(line)) {
      inCommentDirective = true;
      commentDirectiveBuffer.push({ line, srcIdx });
      continue;
    }
    if (startsWithBlockMarker) {
      if (isStandaloneBlockMarker) {
        // (a)単独 `%%%`:open marker
        pendingPrefix = '';
        pendingSrcIdx = srcIdx;
        inBlockComment = true;
        continue;
      }
      // 行が `%%%` で始まり、何らかの content を持つ(`%%%text...`)。
      // 末尾が `%%%` で終わるなら単一行 block コメント(b)、それ以外は
      // open marker + body 開始(c)。
      const innerAfterOpen = trimmedLine.slice(3); // %%% を除いた部分
      if (innerAfterOpen.replace(/[ \t]+$/, '').endsWith('%%%')) {
        // (b)単一行 `%%%text%%%`:literal strip(無視)、空行を 1 行 emit して
        // 段落区切りを保持。outMap は元 line を指す。
        outLines.push('');
        outMap.push(srcIdx);
        continue;
      }
      // (c)`%%%text` open marker:pendingPrefix は空(content は次行以降)。
      pendingPrefix = '';
      pendingSrcIdx = srcIdx;
      inBlockComment = true;
      continue;
    }
    // (d)`%%%` を含むが行頭から始まらない line(heading で literal mention
    // 等)は literal として通す。inline backtick code の mask は維持
    // (`%%` inline comment の strip は stripInline で行う)。
    const { masked: lineMasked, spans: lineSpans } = maskInlineCode(line);
    outLines.push(unmaskInlineCode(stripInline(lineMasked), lineSpans));
    outMap.push(srcIdx);
  }
  // Unclosed `%%%` / `:::comment` at EOF:挽回処理。
  if (inBlockComment) {
    outLines.push(stripInline(pendingPrefix));
    outMap.push(pendingSrcIdx >= 0 ? pendingSrcIdx : 0);
  }
  // `:::comment` 未閉じ:buffer を literal で restore(元 stripComments 挙動を維持)
  if (inCommentDirective) {
    for (const item of commentDirectiveBuffer) {
      outLines.push(stripInline(item.line));
      outMap.push(item.srcIdx);
    }
  }
  return { transformed: outLines.join('\n'), lineMap: outMap };
}

// ── L-1 (2026-05-07、wave-10-2 Phase 1):Section break(`+++ {role=...}`) ──
//
// Spec §2.3:`+++` line で page / slide break、`{role=...}` で role 指定。
// Phase 1 で対応する role:`auto`(default)/ `cover` / `section` / `body`。
// 他 role は spec §2.3 表参照(toc / landscape / appendix / bibliography /
// index)。本実装は role 文字列を data-pkc-role 属性で素通し、format export
// engine が消費する想定。
//
// HTML 出力:`<hr class="pkc-section-break" data-pkc-role="ROLE">`。
// CSS は role 別に少し見た目を変える(cover は強い区切り、section は弱め)。
//
// 実装:pre-process で `+++` line を sentinel 化、post-process で <hr> に置換。

const SECTION_OPEN = '\u{E120}';
const SECTION_SEP = '\u{E121}';

/**
 * reform-2026-05 Phase 2 PR-2H:`:::break{kind=page|rule role=…}` formal block。
 *
 * `+++` / `---` simple の formal 等価。AI / serializer が IR-driven で emit する
 * formal 形を spec 完全網羅。
 *
 *   :::break                       → +++(default kind=page)
 *   :::break{kind=page}            → +++
 *   :::break{kind=page role=cover} → +++ {role=cover}
 *   :::break{kind=rule}            → ---(commonmark hr)
 *
 * fenced code 内 marker は無視(下流の processSectionBreaks と同期)。
 * `:::break{...}` 行を simple 形に変換し、処理は既存 `+++` / `---` パイプに委譲。
 */
function processBreakDirective(source: string): string {
  /**
   * 🔴 **本文に目印が無いなら段ごと素通りする**(2026-08-07)。出力は 1 バイトも
   * 変わらない ── この段は目印が 1 つも無ければ全行をそのまま流すだけである。
   * ⚠ 目印は**広い側**に取る(狭すぎるとその記法が黙って効かなくなる)。
   */
  if (!source.includes(':::break')) return source;
  let fence: FenceState = { inFence: false, marker: '' };
  return source.split('\n').map((line) => {
    const t = fenceTransition(line, fence);
    fence = t.state;
    if (fence.inFence || t.isBoundary) return line;
    const m = /^[ \t]*:::break(?:\{([^}]*)\})?[ \t]*$/.exec(line);
    if (!m) return line;
    const attrs = m[1] ?? '';
    const km = /kind\s*=\s*"?(\w+)"?/.exec(attrs);
    const kind = km?.[1] ?? 'page';
    const rm = /role\s*=\s*"?(\w[\w-]*)"?/.exec(attrs);
    const role = rm?.[1];
    if (kind === 'rule') return '---';
    // page (default) → `+++` simple へ変換、processSectionBreaks に委譲
    return role ? `+++ {role=${role}}` : '+++';
  }).join('\n');
}

function processSectionBreaks(source: string): string {
  /**
   * 🔴 **本文に目印が無いなら段ごと素通りする**(2026-08-07)。出力は 1 バイトも
   * 変わらない ── この段は目印が 1 つも無ければ全行をそのまま流すだけである。
   * ⚠ 目印は**広い側**に取る(狭すぎるとその記法が黙って効かなくなる)。
   */
  if (!source.includes('+++')) return source;
  // fenced code block 内では `+++` を marker と認識しない(2026-05-08 hotfix)。
  let fence: FenceState = { inFence: false, marker: '' };
  return source.split('\n').map((line) => {
    const t = fenceTransition(line, fence);
    fence = t.state;
    if (fence.inFence || t.isBoundary) return line;
    // 行頭の空白系文字種(半角 / tab / 全角 U+3000 等)は無視(2026-05-08
    // user 統一方針:行頭系シンプル記法は leading whitespace を全部 strip)。
    const m = /^\s*\+\+\+\s*(?:\{([^}]*)\}\s*)?$/.exec(line);
    if (!m) return line;
    const attrs = m[1]?.trim() ?? '';
    let role = 'auto';
    if (attrs) {
      // `role=X` を抽出。他 attr は無視(Phase 1)。
      const rm = /role=(\w[\w-]*)/.exec(attrs);
      if (rm) role = rm[1]!;
    }
    return `${SECTION_OPEN}${role}${SECTION_SEP}`;
  }).join('\n');
}

/**
 * 🔴 **改頁の sentinel を段落から切り離す**(2026-08-07。実バグの修正)。
 *
 * `postProcessSectionBreaks` は sentinel が**単独の `<p>` に入っている**ことを
 * 前提に `<p …>SENT</p>` を `<hr>` へ置き換える。ところが前後に空行が無いと
 * markdown-it が隣の行と 1 つの段落に束ねてしまい、置換が当たらない ──
 * PUA は画面に出ないので、**role の文字列(既定は `auto`)だけが本文に残り、
 * 改頁は起きない**。
 *
 * ```
 * 前            →  <p>前<br>          ← 改頁が消え、`auto` という字が出る
 * +++              auto<br>
 * 後               後</p>
 * ```
 *
 * ⚠ **囲いの中だけの問題ではない**(2026-08-07 の実測)── 最上位でも、箇条書きの
 *   中でも、空行を書かなければ同じように壊れていた。user が `+++` を素直に
 *   書いた形(前後に空行を入れない)が、まさに壊れる形である。
 * ⚠ `:::` 側は `ensureBlankAroundColonBlocksWithLineMap` が同じことをしている ──
 *   **こちらだけ抜けていた**(CLAUDE.md「片側を直したら対称の反対側を疑う」)。
 */
const SECTION_BREAK_LINE_RE = new RegExp(`^${SECTION_OPEN}\\w[\\w-]*${SECTION_SEP}$`);

function ensureBlankAroundSectionBreaks(
  source: string,
  lineMapIn: number[],
): { transformed: string; lineMap: number[] } {
  const inLines = source.split('\n');
  const out: string[] = [];
  const map: number[] = [];
  for (let i = 0; i < inLines.length; i += 1) {
    const line = inLines[i]!;
    const inputIdx = lineMapIn[i] ?? i;
    if (!SECTION_BREAK_LINE_RE.test(line)) {
      out.push(line);
      map.push(inputIdx);
      continue;
    }
    const prev = out[out.length - 1];
    if (prev !== undefined && prev.trim() !== '') {
      out.push('');
      map.push(inputIdx);
    }
    out.push(line);
    map.push(inputIdx);
    const next = inLines[i + 1];
    if (next !== undefined && next.trim() !== '') {
      out.push('');
      map.push(inputIdx);
    }
  }
  return { transformed: out.join('\n'), lineMap: map };
}

function postProcessSectionBreaks(html: string): string {
  // `<p>` の attrs(`tagSourceLines` が付ける `data-pkc-source-line-*` 等)
  // を **保存** して置換要素に転記。Split View の source-preview-sync が
  // block ↔ source line lookup に使うため、attrs を捨てると同期が崩れる
  // (2026-05-08 user 報告)。`([^>]*)` で attrs 文字列を捕獲、置換後の
  // <hr> にそのまま付ける。
  return html.replace(
    new RegExp(`<p([^>]*)>${SECTION_OPEN}(\\w[\\w-]*)${SECTION_SEP}</p>`, 'g'),
    (_match, attrs, role) => `<hr class="pkc-section-break" data-pkc-role="${role}"${attrs}>`,
  );
}

// ── L-8(2026-05-07、wave-10-2 Phase 1):空行マーカー(`_` / `_<N>`) ──
//
// Spec §3.10:行頭 `_` 単独 → 1 空行ぶん、`_<N>` → N 空行ぶん。
// CommonMark は連続空行を 1 paragraph 区切りに collapse するため、本文中で
// 「ここに 2 行ぶん余白を入れたい」を素朴に表現できない。明示マーカーで
// vertical spacing 制御する。
//
// HTML 出力:`<div class="pkc-blank-line" data-pkc-blank-count="N" aria-hidden="true"></div>`。
// CSS で `--pkc-blank-line-h` × N の高さを取る。
//
// 実装:processSectionBreaks と同じ pre-process / post-process pattern。
//
// N の上限:1〜50 で clip(reform-2026-05 hotfix で 20→50 に raise、AI 生成
// 文書での実用例 / 印刷組版での page break 用途を考慮)。誤入力で 9999 行
// 余白等を作る事故を防ぐ。**clip された場合は visible warning を出す**
// (silent fail を避ける:`_100` 入力 → 50 行 + `data-pkc-blank-capped="100→50"`
// + title 属性で user に通知)。
//
// インデント付き `   _` はマーカーとして扱わない(段落継続 / コード扱い)。

const BLANK_OPEN = '\u{E130}';
const BLANK_SEP = '\u{E131}';
const BLANK_LINE_MAX = 50;

// ── reform-2026-05 Phase 2 PR-2K/2L:AI hallucination 形 寛容 parse + signaling ──
//
// spec v2 §1.6 deny list の formal 構文を AI(ChatGPT / Claude / Gemini)が
// Pandoc / RST / Bootstrap / Tailwind / JSX 知識から hallucinate して生成する
// 問題に対し、2 段階の対応をする:
//
//   PR-2K(2026-05-10):literal 残留 → visible marker + console.warn で signaling
//   PR-2L(2026-05-10):critical inline 4 件 + admonition alias 群を 寛容 parse へ
//                      格上げ、parse log に detected / interpretedAs / canonical の
//                      3 つ組を含めることで AI repair tool が round-trip 学習可能に
//
// PR-2L で寛容 parse する critical 群(HTML / CSS class / framework component 想起):
//   :lead:[content]            → <span class="pkc-lead">content</span> + PKC2005
//   :spacing:{size=N}          → blank-line N 個 + PKC2006
//   :align:{position=X}        → 次段落 align directive + PKC2007
//   :quote:{attribution=…}     → <small class="pkc-attribution">…</small> + PKC2008
//   :::note / :::warning / :::tip / :::info / :::caution / :::important /
//   :::danger / :::summary     → :::section{role=NAME} alias + PKC2009
//   :::callout{type=X}         → :::section{role=X} alias + PKC2010
//   :::admonition{type=X
//      title=Y}                → :::section{role=X} + emphasis title + PKC2011
//
// PR-2K で warning 据え置きの less-critical(structural、user が即気付ける):
//   :::toc / :::frontmatter / :::body  → marker + PKC1010
//   parser fall-through inline(:lead: 以外で形式不一致) → 何もしない

const HALLUCINATION_OPEN = '\u{E162}';
const HALLUCINATION_SEP = '\u{E163}';
const HALLUCINATION_FENCE_OPEN = '\u{E164}';
const HALLUCINATION_FENCE_SEP = '\u{E165}';

// PR-2L:tolerant alias sentinel(PUA、PR-2K の hallucination sentinel と区別)
const TOLERANT_OPEN = '\u{E166}';
const TOLERANT_SEP = '\u{E167}';

/**
 * PR-2L: tolerant alias parse log entry。
 *
 * preprocessor が hallucination 形を render path に変換した際の hint。
 * console.info で出力、`data-pkc-canonical=` attribute にも転記、Playwright
 * `page.on('console')` / DOM 走査で AI repair tool が拾える。
 */
interface TolerantInlinePattern {
  re: RegExp;
  /** 入力 directive 名(lead / spacing / align / quote)。 */
  name: 'lead' | 'spacing' | 'align' | 'quote';
  /** PKC<NNNN> code。 */
  code: string;
  /** parse log:render 上の分類。 */
  interpretedAs: string;
  /** parse log:推奨 simple 形。 */
  canonical: string;
}

/**
 * 🔑 **行頭 align の canonical を教える文言は 1 本**(2026-08-06)。
 * `:align:{position=X}` の 2 経路(表 / standalone)と、そこから流れる 3 面
 * (console.info / `data-pkc-canonical` / hover `title`)が同じ文を使う。
 */
/**
 * ⚠ **`|>` の canonical な言い換えとして `:::paragraph{align=end}` を案内しない**
 * (user 指摘 2026-08-08)。裁定で `|>` の意味が「グローバルの寄せを反対にする」に
 * 変わった時点で、logical end を表す `align=end` とは**別のもの**になった ──
 * 案内すると、寛容さを持たない説明的な形へ象形的な形の意味を持ち込ませてしまう。
 */
export const ALIGN_CANONICAL_HINT =
  '行頭 prefix `||`(center)/ `|>`(グローバルの寄せの反対側。`<|` `|<` `>|` も同じ)。' +
  '文書の流れを変えるなら frontmatter の `direction` / `align` 宣言、' +
  '位置を言葉で指定するなら formal `:::paragraph{align=left}`(right / center も可)';

const TOLERANT_INLINE_PATTERNS: ReadonlyArray<TolerantInlinePattern> = [
  {
    re: /:lead:\[([\s\S]*?)\]/g,
    name: 'lead',
    code: 'PKC2005',
    interpretedAs: 'lead-paragraph (large/styled first content)',
    canonical: '普通の段落として書く(`==content==` で強調も可)',
  },
  {
    re: /:spacing:\{([^}]*?)\}/g,
    name: 'spacing',
    code: 'PKC2006',
    interpretedAs: 'blank-line spacer',
    canonical: '`_<N>`(L-8 blank-line marker、`_2` = 2 行空ける)',
  },
  {
    re: /:align:\{([^}]*?)\}/g,
    name: 'align',
    code: 'PKC2007',
    interpretedAs: 'next-paragraph alignment hint',
    /**
     * 🔴 **`<|`(start)と書いてはいけない**(2026-08-06 に直した。user 指摘)。
     *
     * catalog(`PKC2: docs/development/notation-redesign-2026-05/01-notation-catalog.md`
     * §1.4.2)は「`|>` `<|` `|<` `>|` … **全 4 形が同じ**」、§1.4.1 は
     * 「`<|text` align prefix … ❌ **廃止**。default flow は frontmatter で declare」。
     * つまり**行頭マーカーに「左」は無い**。意味は user 裁定 2026-08-08(Issue #103)で
     * 「**グローバルの文字の寄せを反対にする**」に確定(属性は opposite、
     * 反転は app.css の入れ替え規則)。
     *
     * ⚠ この 1 文字列は **user に見える 3 面**へ同時に流れる ──
     * ① `console.info` の hint ② レンダ HTML の `data-pkc-canonical` 属性
     * (**書き出した HTML に焼かれる**)③ hover の `title`。
     * 誤ると**アプリが誤った記法を教える**(実際に出荷していた)。
     * ⚠ PKC2 側の同じ 2 か所(`markdown-render.ts:3285` / `:3365`)も誤っているが、
     *   PKC2 は read-only 参照専用なので直せない ── **引き写さないこと**。
     */
    canonical: ALIGN_CANONICAL_HINT,
  },
  {
    re: /:quote:\{([\s\S]*?)\}/g,
    name: 'quote',
    code: 'PKC2008',
    interpretedAs: 'attribution caption',
    canonical: 'block `:::quote{author="…"} content :::`',
  },
];

/** PR-2L:admonition alias の標準 role 集合(spec §1.6.y で alias 列挙)。 */
const ADMONITION_ALIASES: ReadonlySet<string> = new Set([
  'note', 'warning', 'tip', 'info', 'caution', 'important', 'danger', 'summary',
]);

/**
 * PR-2V(2026-05-12)で `:::toc` を、PR-2W(2026-05-12)で `:::frontmatter` /
 * `:::body` を正式実装(全て deny list から除外、formal feature 化)。
 * Set は空になったが、将来の deny list scenario(別 directive)用に
 * infrastructure は維持。
 */
/**
 * ⚠ **空集合 = この経路は起動しない**(2026-08-05 に確認)。
 * かつて対象だった `:::toc` / `:::frontmatter` / `:::body` は、いずれも
 * 正規の実装(`processTocDirective` / `processRegionBlocks`)へ移った。
 * 下の `processHallucinatedDirectives` は**現状 no-op** である ──
 * 「動いているつもり」で読まれないよう、ここに書いておく。
 */
const HALLUCINATION_BLOCK_DIRECTIVES: ReadonlySet<string> = new Set([]);

const HALLUCINATION_BLOCK_SUGGESTION: Record<string, string> = {};

/**
 * PR-2O(2026-05-10):standalone `:align:{position=X}` 行を line-based に検出、
 * **次の非空行に対応する出力行** の alignMap に register、directive 行は strip。
 *
 * PR-2L で `:align:{position=X}` は hint chip(青背景 `[align: end]`)で残して
 * いたが、user 報告(2026-05-10)で「画像みたいに見えないものがある = chip が
 * 余計」だったため、**実際に次段落を align させる** ように格上げ。inline form
 * (行中央の `:align:{…}`)は引き続き processTolerantInlineAliases の regex
 * 経由で hint chip(default 非表示、?pkc-debug=hallucination flag で visible)。
 *
 * fence-aware:fenced code 内の marker は無視。
 */
function processTolerantStandaloneAlign(
  source: string,
  lineMapIn: number[],
  silentWarnings = false,
): { transformed: string; alignMap: Map<number, AlignKind>; lineMap: number[] } {
  /**
   * 🔴 **本文に目印が無いなら段ごと素通りする**(2026-08-07)。出力は 1 バイトも
   * 変わらない ── この段は目印が 1 つも無ければ全行をそのまま流すだけである。
   * ⚠ 目印は**広い側**に取る(狭すぎるとその記法が黙って効かなくなる)。
   */
  if (!source.includes(':align:')) {
    void silentWarnings;
    return { transformed: source, alignMap: new Map(), lineMap: lineMapIn };
  }
  const alignMap = new Map<number, AlignKind>();
  const lines = source.split('\n');
  const out: string[] = [];
  const lineMapOut: number[] = [];
  let pendingAlign: AlignKind | null = null;
  let fence: FenceState = { inFence: false, marker: '' };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const inputIdx = lineMapIn[i] ?? i;
    const t = fenceTransition(line, fence);
    fence = t.state;
    if (fence.inFence || t.isBoundary) {
      out.push(line);
      lineMapOut.push(inputIdx);
      continue;
    }
    const m = /^[ \t]*:align:\{\s*position\s*=\s*"?([a-z]+)"?\s*\}\s*$/.exec(line);
    if (m) {
      const rawPos = m[1]!;
      /**
       * 🔴 **物理を logical へ潰さない**(2026-08-06)。直す前は
       * `left: 'start'` / `right: 'end'` と写していた ── `end` / `start` は
       * `direction` / `writing-mode` で反転するので、`direction: rtl` の文書で
       * **`position=left` と書いた段落が右へ行く**。
       * 規約は「物理(left / right / top / bottom)= **強制的に物理方向**」
       * (`PKC2: docs/spec/pkc-markdown-complete-spec-v4.md` §6.2)なので、
       * 物理はそのまま物理へ写す。CSS 側は最初から両方持っている
       * (`app.css` の `[data-pkc-align='left'|'right']` は `text-align` 直値)。
       * ⚠ 同じ「潰し」を CSS から取り除いた(logical と physical の同居)のに、
       *   parser 側に残っていた ── **判定を 2 か所に持つと片方だけ直る**。
       */
      /**
       * 🔴 **受理集合は `FORMAL_ALIGNS` 1 つに寄せる**(2026-08-08 の 4 巡目レビュー)。
       * 直す前はここに 7 値の literal map が独立して在り、**3 か所目の受理集合**に
       * なっていた ── `opposite` を 1 語足す変異が、`:::paragraph` / `:::format` を
       * 塞いだ pin をすり抜けて通った(`:align:{position=opposite}` が書けてしまう)。
       * ⚠ すぐ上の註記自身が「**判定を 2 か所に持つと片方だけ直る**」と書いている。
       * 🔑 値の集合は同一(物理 5 + logical 2 = 7)なので**出力は 1 バイトも変わらない**。
       */
      const align = FORMAL_ALIGNS.has(rawPos as AlignKind) ? (rawPos as AlignKind) : undefined;
      if (align) {
        pendingAlign = align;
        if (!silentWarnings && typeof console !== 'undefined' && console.info) {
          console.info(
            `[PKC2007] tolerant alias :align: accepted (line-based, applied to next paragraph). ` +
            `detected=":align:{position=${rawPos}}" ` +
            `interpretedAs="next-paragraph alignment (${align})" ` +
            // ⚠ **文言を 2 か所に書かない**(2026-08-06)── ここは表の canonical を
            //    参照する。直す前は同じ誤り(`<|`(start))が独立に埋まっていて、
            //    表を直しても**こちらだけ残った**
            `canonical="${ALIGN_CANONICAL_HINT}"`,
          );
        }
        out.push('');
        lineMapOut.push(inputIdx);
        continue;
      }
    }
    if (pendingAlign && line.trim() !== '') {
      alignMap.set(out.length, pendingAlign);
      pendingAlign = null;
    }
    out.push(line);
    lineMapOut.push(inputIdx);
  }

  return { transformed: out.join('\n'), alignMap, lineMap: lineMapOut };
}

/**
 * PR-2L:tolerant alias parser — critical inline 4 件を寛容 parse して
 * sentinel wrap、postprocess で正式 render に変換。AI が hallucinate しがちな
 * `:lead:[…]` / `:spacing:{…}` / `:align:{…}` / `:quote:{…}` を受理し、
 * 3 つ組(detected / interpretedAs / canonical)を parse log に emit。
 *
 * sentinel 形式:`<TOLERANT_OPEN>name<TOLERANT_SEP>content<TOLERANT_OPEN>`
 *
 * fence-aware:fenced code 内 marker は対象外(別 mask 経由)。
 */
function processTolerantInlineAliases(
  source: string,
  lineMapIn: number[],
  silentWarnings = false,
): { transformed: string; lineMap: number[] } {
  // fenced code mask(他 preprocessor と同等)
  const fenceRegions: string[] = [];
  const FENCE_HOLDER = (idx: number) =>
    `${HALLUCINATION_FENCE_OPEN}${idx}${HALLUCINATION_FENCE_SEP}`;
  let masked = source.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, (m) => {
    fenceRegions.push(m);
    return FENCE_HOLDER(fenceRegions.length - 1);
  });

  for (const pat of TOLERANT_INLINE_PATTERNS) {
    masked = masked.replace(pat.re, (matched, content) => {
      const trimmed = String(content ?? '').trim();
      if (!silentWarnings && typeof console !== 'undefined' && console.info) {
        console.info(
          `[${pat.code}] tolerant alias :${pat.name}: accepted. ` +
          `detected="${matched.replace(/\n/g, '\\n').slice(0, 80)}" ` +
          `interpretedAs="${pat.interpretedAs}" ` +
          `canonical="${pat.canonical}"`,
        );
      }
      // パラメータ系(spacing/align/quote)は preprocess で値抽出
      // (markdown-it が `"` → `&quot;` 化するので postprocess regex が崩れる)
      if (pat.name === 'spacing') {
        const m = /size\s*=\s*"?(\d+)"?/.exec(trimmed);
        const size = m ? m[1]! : '1';
        return `${TOLERANT_OPEN}spacing${TOLERANT_SEP}${size}${TOLERANT_OPEN}`;
      }
      if (pat.name === 'align') {
        const m = /position\s*=\s*"?([a-z]+)"?/.exec(trimmed);
        const pos = m ? m[1]! : 'start';
        return `${TOLERANT_OPEN}align${TOLERANT_SEP}${pos}${TOLERANT_OPEN}`;
      }
      if (pat.name === 'quote') {
        const m = /attribution\s*=\s*"([^"]*)"|attribution\s*=\s*([^\s}]+)/.exec(trimmed);
        const text = m ? (m[1] ?? m[2] ?? '') : trimmed;
        // HTML escape(markdown-it に渡す前に literal 化)
        const escaped = text
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;');
        return `${TOLERANT_OPEN}quote${TOLERANT_SEP}${escaped}${TOLERANT_OPEN}`;
      }
      // :lead: は content を markdown-it inline parser に渡す
      return `${TOLERANT_OPEN}${pat.name}${TOLERANT_SEP}${trimmed}${TOLERANT_OPEN}`;
    });
  }

  // fence restore
  const restored = masked.replace(
    new RegExp(`${HALLUCINATION_FENCE_OPEN}(\\d+)${HALLUCINATION_FENCE_SEP}`, 'g'),
    (_m, idx) => fenceRegions[parseInt(idx, 10)] ?? '',
  );
  return { transformed: restored, lineMap: lineMapIn };
}

/**
 * PR-2L:admonition alias rewriter — `:::note` `:::warning` `:::callout{type=X}`
 * `:::admonition{type=X title=Y}` を `:::section{role=X}` に rewrite して
 * 既存 PR-2F section processor に流す。fence-aware。
 *
 *   :::note               → :::section{role=note}
 *   :::warning{...}       → :::section{role=warning ...}
 *   :::callout{type=tip}  → :::section{role=tip}
 *   :::admonition{type=info title="..."}
 *                         → :::section{role=info}
 *                           ## ...
 *                           (本文)
 *                           :::
 */
function processAdmonitionAliases(
  source: string,
  lineMapIn: number[],
  silentWarnings = false,
): { transformed: string; lineMap: number[] } {
  /**
   * 🔴 **本文に目印が無いなら段ごと素通りする**(2026-08-07)。出力は 1 バイトも
   * 変わらない ── この段は目印が 1 つも無ければ全行をそのまま流すだけである。
   * ⚠ 目印は**広い側**に取る(狭すぎるとその記法が黙って効かなくなる)。
   */
  if (!source.includes(':::')) {
    void silentWarnings;
    return { transformed: source, lineMap: lineMapIn };
  }
  const lines = source.split('\n');
  const out: string[] = [];
  const lineMapOut: number[] = [];
  let fence: FenceState = { inFence: false, marker: '' };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const inputIdx = lineMapIn[i] ?? i;
    const t = fenceTransition(line, fence);
    fence = t.state;
    if (fence.inFence || t.isBoundary) {
      out.push(line);
      lineMapOut.push(inputIdx);
      continue;
    }
    // :::NAME{attrs?}  where NAME is in ADMONITION_ALIASES
    let m = /^([ \t]*):::([a-z]+)(\{([^}]*)\})?\s*$/.exec(line);
    if (m && ADMONITION_ALIASES.has(m[2]!)) {
      const indent = m[1] ?? '';
      const name = m[2]!;
      const attrs = m[4] ? ` ${m[4]}` : '';
      if (!silentWarnings && typeof console !== 'undefined' && console.info) {
        console.info(
          `[PKC2009] tolerant alias :::${name} accepted. ` +
          `detected=":::${name}${attrs}" ` +
          `interpretedAs="section callout role=${name}" ` +
          `canonical=":::section{role=${name}}"`,
        );
      }
      out.push(`${indent}:::section{role=${name}${attrs}}`);
      lineMapOut.push(inputIdx);
      continue;
    }
    // :::callout{type=NAME ...}
    m = /^([ \t]*):::callout(\{([^}]*)\})?\s*$/.exec(line);
    if (m) {
      const indent = m[1] ?? '';
      const attrs = m[3] ?? '';
      // type=X 抽出
      const tm = /type\s*=\s*"?([a-z]+)"?/.exec(attrs);
      const role = tm?.[1] ?? 'note';
      const otherAttrs = attrs.replace(/type\s*=\s*"?[a-z]+"?/, '').trim();
      const extraAttrs = otherAttrs ? ` ${otherAttrs}` : '';
      if (!silentWarnings && typeof console !== 'undefined' && console.info) {
        console.info(
          `[PKC2010] tolerant alias :::callout{type=${role}} accepted. ` +
          `detected=":::callout{${attrs}}" ` +
          `interpretedAs="section callout role=${role}" ` +
          `canonical=":::section{role=${role}}"`,
        );
      }
      out.push(`${indent}:::section{role=${role}${extraAttrs}}`);
      lineMapOut.push(inputIdx);
      continue;
    }
    // :::admonition{type=NAME title=Y}
    m = /^([ \t]*):::admonition(\{([^}]*)\})?\s*$/.exec(line);
    if (m) {
      const indent = m[1] ?? '';
      const attrs = m[3] ?? '';
      const tm = /type\s*=\s*"?([a-z]+)"?/.exec(attrs);
      const role = tm?.[1] ?? 'note';
      const titleM = /title\s*=\s*"([^"]*)"|title\s*=\s*([^\s}]+)/.exec(attrs);
      const title = titleM ? (titleM[1] ?? titleM[2] ?? '') : '';
      if (!silentWarnings && typeof console !== 'undefined' && console.info) {
        console.info(
          `[PKC2011] tolerant alias :::admonition accepted. ` +
          `detected=":::admonition{${attrs}}" ` +
          `interpretedAs="section callout role=${role} title=${title}" ` +
          `canonical=":::section{role=${role}}\\n## ${title}"`,
        );
      }
      out.push(`${indent}:::section{role=${role}}`);
      lineMapOut.push(inputIdx);
      if (title) {
        out.push(`## ${title}`);
        lineMapOut.push(inputIdx);
      }
      continue;
    }
    out.push(line);
    lineMapOut.push(inputIdx);
  }
  return { transformed: out.join('\n'), lineMap: lineMapOut };
}

/**
 * AI hallucination 形 less-critical block directive(`:::toc` `:::frontmatter`
 * `:::body`)を sentinel wrap + console.warn(PKC1010)。PR-2K で実装、PR-2L で
 * inline 4 件 + admonition alias 群を寛容 parse 化したため、本関数は block
 * structural 3 件のみを担当する。
 *
 * `silentWarnings` opts:vitest 等で console を汚さない用途。
 */
function processHallucinatedDirectives(
  source: string,
  lineMapIn: number[],
  silentWarnings = false,
): { transformed: string; lineMap: number[] } {
  // Step 1: fenced code block を placeholder mask。
  const fenceRegions: string[] = [];
  const FENCE_HOLDER = (idx: number) =>
    `${HALLUCINATION_FENCE_OPEN}${idx}${HALLUCINATION_FENCE_SEP}`;
  const masked = source.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, (m) => {
    fenceRegions.push(m);
    return FENCE_HOLDER(fenceRegions.length - 1);
  });

  // Step 3: block pattern を行 base で検出(masked 状態でも fence 内には
  // mask placeholder が残り、`:::` 行頭 match しないので安全)。
  const lines = masked.split('\n');
  const out: string[] = [];
  let inBlockHallucination: { name: string; startIdx: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    // open marker 検出(行頭 `:::name` で name が deny list block 名)
    const openMatch = /^[ \t]*:::([a-z][a-z0-9_-]*)\b[^\n]*$/.exec(line);
    if (
      !inBlockHallucination &&
      openMatch &&
      HALLUCINATION_BLOCK_DIRECTIVES.has(openMatch[1]!)
    ) {
      const name = openMatch[1]!;
      if (!silentWarnings && typeof console !== 'undefined' && console.warn) {
        console.warn(
          `[PKC1010] hallucinated block directive :::${name} detected. ` +
          `Use ${HALLUCINATION_BLOCK_SUGGESTION[name] ?? 'spec §1.6 推奨形'} instead.`,
        );
      }
      inBlockHallucination = { name, startIdx: out.length };
      // 開始 sentinel(block kind)
      out.push(`${HALLUCINATION_OPEN}block${HALLUCINATION_SEP}${name}${HALLUCINATION_SEP}${line}`);
      continue;
    }
    // close marker 検出(`:::` 単独行)
    if (inBlockHallucination && /^[ \t]*:::[ \t]*$/.test(line)) {
      out.push(`${line}${HALLUCINATION_OPEN}`);
      inBlockHallucination = null;
      continue;
    }
    out.push(line);
  }
  // 閉じられなかった block は openline まで戻して sentinel を剥がす
  // (markdown-it が `:::name` を literal として render するので signaling は失われるが、
  // 不正 markup の責任を user 側に戻すのが妥当)
  if (inBlockHallucination) {
    const startIdx = inBlockHallucination.startIdx;
    if (out[startIdx]) {
      out[startIdx] = out[startIdx].replace(
        new RegExp(`^${HALLUCINATION_OPEN}block${HALLUCINATION_SEP}[a-z0-9_-]+${HALLUCINATION_SEP}`),
        '',
      );
    }
  }

  // Step 4: fence region を復元。
  let restored = out.join('\n');
  restored = restored.replace(
    new RegExp(`${HALLUCINATION_FENCE_OPEN}(\\d+)${HALLUCINATION_FENCE_SEP}`, 'g'),
    (_m, idx) => fenceRegions[parseInt(idx, 10)] ?? '',
  );

  return { transformed: restored, lineMap: lineMapIn };
}

/**
 * Post-process:sentinel pair → `<div class="pkc-warning-hallucination-block">`(PR-2K)。
 * PR-2L で inline は tolerant alias 経路に移行したため、本関数は block 3 件のみ。
 */
function postProcessHallucinatedDirectives(html: string): string {
  html = html.replace(
    new RegExp(
      `${HALLUCINATION_OPEN}block${HALLUCINATION_SEP}([a-z][a-z0-9_-]*)${HALLUCINATION_SEP}([\\s\\S]*?)${HALLUCINATION_OPEN}`,
      'g',
    ),
    (_match, name, content) => {
      const suggestion = HALLUCINATION_BLOCK_SUGGESTION[name] ?? 'spec §1.6 推奨形';
      const title = `未実装の block directive :::${name}。spec §1.6 推奨形へ正規化してください(${suggestion})。`;
      return (
        `<div class="pkc-warning-hallucination-block pkc-warning-hallucination-block-${name}" ` +
        `data-pkc-warn-code="PKC1010" data-pkc-warn-name="${name}" ` +
        `title="${title.replace(/"/g, '&quot;')}">` +
        content +
        `</div>`
      );
    },
  );
  return html;
}

/**
 * PR-2L:tolerant alias sentinel(TOLERANT_OPEN/SEP)を実際の HTML に展開。
 *
 *   :lead → <span class="pkc-lead" data-pkc-warn-code="PKC2005"
 *                 data-pkc-canonical="…">content</span>
 *   :spacing → <div class="pkc-blank-line pkc-tolerant-spacing"
 *                   data-pkc-blank-count="N" data-pkc-warn-code="PKC2006">
 *                   (N 行の vertical space)</div>
 *   :align → <span class="pkc-align-hint" data-pkc-align-next="X"
 *                  data-pkc-warn-code="PKC2007">[align: X]</span>
 *   :quote → <small class="pkc-attribution" data-pkc-warn-code="PKC2008"
 *                   data-pkc-canonical="…">— attribution</small>
 *
 * 各要素は `data-pkc-canonical` attribute で AI repair tool が canonical 形を
 * DOM 走査で拾えるようにする(parse log の永続化 layer)。
 */
function postProcessTolerantSentinels(html: string): string {
  return html.replace(
    new RegExp(
      `${TOLERANT_OPEN}([a-z][a-z0-9_-]*)${TOLERANT_SEP}([\\s\\S]*?)${TOLERANT_OPEN}`,
      'g',
    ),
    (_match, name, content) => {
      const pat = TOLERANT_INLINE_PATTERNS.find((p) => p.name === name);
      if (!pat) return content;  // unknown — strip sentinel
      const canonical = pat.canonical.replace(/"/g, '&quot;');
      const titleSuffix = `(canonical: ${canonical})`;
      switch (name) {
        case 'lead': {
          // markdown-it inline-parsed content をそのまま中に入れる
          return (
            `<span class="pkc-lead" ` +
            `data-pkc-warn-code="${pat.code}" data-pkc-warn-name="lead" ` +
            `data-pkc-canonical="${canonical}" ` +
            `title="lead paragraph (寛容 parse)。${titleSuffix}">` +
            content +
            `</span>`
          );
        }
        case 'spacing': {
          // preprocess で size value 抽出済(content = "N")
          const sizeRaw = parseInt(content, 10);
          const size = Number.isFinite(sizeRaw)
            ? Math.max(1, Math.min(50, sizeRaw))
            : 1;
          return (
            `<div class="pkc-blank-line pkc-tolerant-spacing" ` +
            `style="--pkc-blank-count: ${size}" ` +
            `data-pkc-blank-count="${size}" aria-hidden="true" ` +
            `data-pkc-warn-code="${pat.code}" data-pkc-warn-name="spacing" ` +
            `data-pkc-canonical="${canonical}" ` +
            `title="${size} 行 spacing (寛容 parse)。${titleSuffix}"></div>`
          );
        }
        case 'align': {
          // preprocess で position value 抽出済(content = "end" 等)
          const rawPos = content || 'start';
          /**
           * 🔴 **ここでも物理へ潰さない**(2026-08-06。standalone 経路と同じ穴)。
           * 直す前は `start → left` / `end → right` と写しており、chip の説明文が
           * **「end → right」と読み手に教えていた** ── `direction: rtl` の文書では
           * end は左である。`data-pkc-align-next` は書かれた token をそのまま持つ。
           * ⚠ 未知の値は落とさず `start`(= 既定の寄せ)へ寄せる。
           */
          const ALIGN_NEXT: ReadonlySet<string> = new Set([
            'start', 'end', 'center', 'justify', 'left', 'right', 'top', 'bottom',
          ]);
          const alignNext = ALIGN_NEXT.has(rawPos) ? rawPos : 'start';
          return (
            `<span class="pkc-align-hint" ` +
            `data-pkc-align-next="${alignNext}" ` +
            `data-pkc-warn-code="${pat.code}" data-pkc-warn-name="align" ` +
            `data-pkc-canonical="${canonical}" ` +
            `title="align hint: ${alignNext} (寛容 parse)。${titleSuffix}">` +
            `[align: ${rawPos}]</span>`
          );
        }
        case 'quote': {
          // preprocess で attribution text 抽出 + HTML escape 済
          return (
            `<small class="pkc-attribution" ` +
            `data-pkc-warn-code="${pat.code}" data-pkc-warn-name="quote" ` +
            `data-pkc-canonical="${canonical}" ` +
            `title="attribution (寛容 parse)。${titleSuffix}">` +
            `— ${content}</small>`
          );
        }
        default:
          return content;
      }
    },
  );
}

function processBlankLineMarkers(source: string, lineMapIn: number[]): {
  transformed: string;
  lineMap: number[];
} {
  /**
   * 🔴 **本文に目印が無いなら段ごと素通りする**(2026-08-07)。出力は 1 バイトも
   * 変わらない ── この段は目印が 1 つも無ければ全行をそのまま流すだけである。
   * ⚠ 目印は**広い側**に取る(狭すぎるとその記法が黙って効かなくなる)。
   */
  // ⚠ 目印は `_` 1 文字 ── 語中の `_` でも素通りしないだけで、誤りにはならない
  if (!source.includes('_')) return { transformed: source, lineMap: lineMapIn };
  const lines = source.split('\n');
  const out: string[] = [];
  const lineMapOut: number[] = [];
  // fenced code block 内では `_` を marker と認識しない(2026-05-08 hotfix)。
  let fence: FenceState = { inFence: false, marker: '' };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const inputIdx = lineMapIn[i] ?? i;
    const t = fenceTransition(line, fence);
    fence = t.state;
    if (fence.inFence || t.isBoundary) {
      out.push(line);
      lineMapOut.push(inputIdx);
      continue;
    }
    // 行頭の空白系文字種(半角 / tab / 全角 U+3000 等)を許容(2026-05-08
    // user 統一方針)。`   _` / `\t_` 等もマーカーとして拾う。
    const m = /^\s*_(\d*)\s*$/.exec(line);
    if (!m) {
      out.push(line);
      lineMapOut.push(inputIdx);
      continue;
    }
    let count = 1;
    let requested = 1;
    if (m[1]) {
      const parsed = Number.parseInt(m[1], 10);
      if (Number.isFinite(parsed) && parsed >= 1) {
        requested = parsed;
        count = Math.min(parsed, BLANK_LINE_MAX);
      } else {
        out.push(line);
        lineMapOut.push(inputIdx);
        continue;
      }
    }
    // 前後を空行で囲んで標準形態の独立 paragraph にする(`breaks: true` 設定
    // 下の前後行 merge 回避)。挿入される空行の lineMap entry も同 inputIdx
    // を指しておく(sync layer は閉じた区間で lookup するので副作用なし)。
    const prevOut = out.length > 0 ? out[out.length - 1]! : '';
    if (prevOut.trim() !== '') {
      out.push('');
      lineMapOut.push(inputIdx);
    }
    // sentinel 形式:`<OPEN>count<SEP>requested<SEP>` で、cap 適用前後の値を埋め込む。
    // post-process で `data-pkc-blank-count` + cap 超過時 `data-pkc-blank-capped` 出力。
    out.push(`${BLANK_OPEN}${count}${BLANK_SEP}${requested}${BLANK_SEP}`);
    lineMapOut.push(inputIdx);
    out.push('');
    lineMapOut.push(inputIdx);
  }
  return { transformed: out.join('\n'), lineMap: lineMapOut };
}

function postProcessBlankLineMarkers(html: string): string {
  // attrs を保存して div に転記(Split View block ↔ source line lookup 維持)。
  // sentinel 形式 `<OPEN>count<SEP>requested<SEP>` を parse、cap 超過時は
  // `data-pkc-blank-capped="requested→count"` + title attr で visible 警告。
  return html.replace(
    new RegExp(`<p([^>]*)>${BLANK_OPEN}(\\d+)${BLANK_SEP}(\\d+)${BLANK_SEP}</p>`, 'g'),
    (_match, attrs, count, requested) => {
      const capped = parseInt(requested, 10) > parseInt(count, 10);
      const cappedAttr = capped
        ? ` data-pkc-blank-capped="${requested}→${count}" title="_${requested} 指定は上限 ${count} 行に cap されました(N≦${count} で再指定可能)"`
        : '';
      // 🔴 **高さの元になる値は `style` で渡す**(2026-08-05)。CSS 側の規則は
      //    `height: calc(1.45em * var(--pkc-blank-count, 1))` で、**この変数**を読む。
      //    直す前はここが `data-pkc-blank-count` しか書いておらず、規則は在るのに
      //    常に 1 行ぶんの高さだった(`_3` と `_1` が同じ)。
      //    ⚠ 「CSS が 0 行」を数える検査では**絶対に見つからない**型の欠陥である
      //    ── 規則も属性も在り、繋がっていないだけなので。
      //    ⚠ 寛容 parse 側(`pkc-tolerant-spacing`)は最初から style を出していた
      //    = **同じことを 2 か所でやって片方だけ正しい**状態だった
      return `<div class="pkc-blank-line" style="--pkc-blank-count: ${count}" data-pkc-blank-count="${count}" aria-hidden="true"${cappedAttr}${attrs}></div>`;
    },
  );
}

/**
 * Render markdown text to an HTML string.
 *
 * HTML tags in source are escaped (not rendered) for XSS safety.
 * Returns safe HTML suitable for innerHTML assignment.
 */

/**
 * 領域 8 Layer 3:見出しアウトライン番号(案 C)。opt-in 時、`#` / `##` /
 * `###` の行頭に `N.` / `N.M` / `N.M.L` を前置する(`####` 以降は無番号)。
 *
 * - `start` は L1 の開始値。
 * - 見出しテキストが既に手書き番号(`3. ` 等)で始まる行は尊重し前置しない
 *   (案 C「手書きも許容」)。カウンタは位置基準で全見出しを数えるため、
 *   auto / 手書き 混在でも順序が整合する。
 * - fenced code(``` / ~~~)内の `#` 行は見出し扱いしない。
 * - 行の挿入 / 削除はせず content を前置するのみ(lineMap 不変)。
 */
function preprocessHeadingNumbers(text: string, start: number): string {
  const lines = text.split('\n');
  const out: string[] = [];
  const counters = [0, 0, 0];
  let fenceChar = '';
  for (const line of lines) {
    const fenceM = /^\s*([`~]{3,})/.exec(line);
    if (fenceChar !== '') {
      out.push(line);
      if (fenceM && fenceM[1]![0] === fenceChar && /^\s*[`~]{3,}\s*$/.test(line)) {
        fenceChar = '';
      }
      continue;
    }
    if (fenceM) {
      fenceChar = fenceM[1]![0]!;
      out.push(line);
      continue;
    }
    const hM = /^(#{1,6})[ \t]+(.*)$/.exec(line);
    if (!hM) {
      out.push(line);
      continue;
    }
    const level = hM[1]!.length;
    if (level > 3) {
      out.push(line);
      continue;
    }
    // counter 更新(位置基準 ── 手書き / auto 問わず数える)。
    counters[level - 1]!++;
    for (let l = level; l < 3; l++) counters[l] = 0;
    const content = hM[2]!;
    // 手書き番号で始まる見出しは尊重(前置しない)。
    if (/^\d+(?:\.\d+)*\.?[ \t]+/.test(content)) {
      out.push(line);
      continue;
    }
    const parts: number[] = [];
    for (let l = 0; l < level; l++) {
      parts.push(l === 0 ? counters[0]! + start - 1 : counters[l]!);
    }
    const num = parts.join('.') + (level === 1 ? '.' : '');
    out.push(`${hM[1]} ${num} ${content}`);
  }
  return out.join('\n');
}

/**
 * この描画器が sentinel に使う私用領域の範囲。
 *
 * ⚠ **範囲で書く**(26 個を列挙しない)── 列挙すると sentinel を 1 つ足したときに
 *   ここへの追加を忘れ、その 1 個だけが素通りする(しかも**静かに**)。
 * ⚠ 実際に使っているのは U+E120〜U+E171 だが、**U+E110 から**取る ── 冒頭の
 *   コメントが「U+E110〜」と宣言しており、将来そこから使い始めても穴が空かない。
 */
const SENTINEL_RANGE = /[\u{E110}-\u{E17F}]/gu;

/** 本文由来の sentinel を無効化する(文字数は変えない ── LineMap と列を動かさない)。 */
export function neutralizeSentinels(text: string): string {
  // ⚠ `test` を使わない(`g` 付き正規表現は lastIndex を持ち回るので副作用になる)
  return text.replace(SENTINEL_RANGE, '\uFFFD');
}

export function renderMarkdown(
  text: string,
  opts: RenderMarkdownOptions = {},
): string {
  if (!text) return '';
  /**
   * 🔴 **本文由来の sentinel をここで無効化する**(2026-08-06。方向 doc §1 C5)。
   *
   * この描画器は `html: false`(生 HTML を通さない)を **PUA(U+E110〜U+E171)の
   * sentinel で意図的に迂回**している。ところが**入力側で本文の PUA を落として
   * いる場所が 1 か所も無く、test も 0 件**だった。実測(2026-08-06)で判ったこと:
   *
   * - 26 個の sentinel は**全部そのまま出力に漏れる**(不可視の私用領域文字として残る)
   * - タグは生えない(`:::section` の並びを真似ても block にはならない)── ここは健全
   * - 🔴 **`:::format` の並びを真似ると、その行が丸ごと消える**
   *   (`SENT0SEPOPENSENT` と書くと出力から**その段落が黙って消滅**した)
   *
   * つまり XSS ではなく **「書いた行が描画から静かに消える」** 実害である。
   * ⚠ **入口 1 か所で潰す**(各 sentinel の使用箇所で個別に防ぐと 26 通りの穴になる)。
   * ⚠ 落とすのではなく **U+FFFD(replacement character)へ写す** ── 消すと
   *   「打ったのに無くなった」になり、原文と描画の対応(LineMap)も 1 文字ずれる。
   *   置き換えなら**文字数が変わらない**ので LineMap も列も動かない。
   * ⚠ goldens 25 件に PUA は **0 文字**なので、この正規化で出力は 1 バイトも動かない
   *   (実地確認)。
   */
  text = neutralizeSentinels(text);
  // PKC3: IR migration scaffolding(markdown.use_ir)は持ち込まない ──
  // flag 予算(最大 15)と凍結方針(正本 doc §10)。legacy pipeline 一本。
  /**
   * ⚠ かつてここに `const originalText = text;` が在った(2026-08-07 に撤去)。
   * 目次が**前処理前の原文**を読み直すための保管で、それが「読み手が 2 つある」
   * という不具合の本体だった。目次を出来上がった HTML から組むようにして
   * 読む人がいなくなったので消した ── **原文をもう一度読む道を残さない**ことが、
   * 同じ食い違いを作らないための構造上の保証である。
   */
  // 入力 line 数を覚えておき、initial lineMap = identity。preprocess 各 step
  // が line を挿入 / 消費する度に lineMap を更新、最終 lineMap[outputIdx] は
  // user の textarea source(原文)の line index を返す。Split View の
  // source-preview-sync が caret line ↔ preview block lookup に使う
  // (2026-05-08 user 報告:Split View 行ズレ修正)。
  let lineMap: number[] = [];
  const initialLines = text.split('\n').length;
  for (let i = 0; i < initialLines; i++) lineMap.push(i);
  // L-4:comment strip + LineMap thread(PR-2X、reform Phase 3)。
  // multi-line `%%%...%%%` / `:::comment...:::` で削除された行を skip しつつ
  // output line → 原文 line index を保持、Split View source-preview-sync の
  // `data-pkc-source-line` 逆引き contract を maintain。
  const commentResult = stripComments(text, lineMap);
  text = commentResult.transformed;
  lineMap = commentResult.lineMap;
  // L-1:section break を sentinel 化(1:1 line 変換、lineMap 不変)
  // reform-2026-05 Phase 2 PR-2H:`:::break{kind=…}` formal を `+++` / `---`
  // simple に変換、processSectionBreaks に委譲。
  text = processBreakDirective(text);
  text = processSectionBreaks(text);
  // M-7:variables `{{vars.x}}` を pre-process で text 置換(fence 外、
  // 2026-05-08 hotfix で inline rule から切替、L-2/L-6 等の content 内も
  // 展開されるようになる)。未定義は U+E140/E141 sentinel で post-process まで残す。
  text = expandVarsInText(text, opts.vars ?? {});
  // reform-2026-05 PR-F:`:::if{format=X}` conditional block(format mismatch
  // 時に content を strip、line count は空行で維持。directive-aware nested 対応)。
  // figure / quote 等の他 directive より先に走らせる(:::if が outermost wrapper)。
  const ifResult = processIfBlocks(text, lineMap, opts.format ?? 'html');
  text = ifResult.transformed;
  lineMap = ifResult.lineMap;
  /**
   * PR-2V:`:::toc{depth=N}` block を sentinel 化、TOC HTML は post-process で展開。
   *
   * 🔴 **見出しの読み手を 1 本にした**(2026-08-07)。ここで
   * `extractHeadingsFromMarkdown(originalText)` を呼んで nav を組んでいたのを
   * やめ、**出来上がった HTML の `<h1-3 id=…>` から組む**ようにした
   * (`buildTocNavsFromHtml`。post 段の最後で当てる)。
   *
   * 直す前は読み手が 2 つあった ── 本文の id は markdown-it の token(前処理を
   * 全部通った文字列)から、目次は**原文の行の正規表現**から作られていた。
   * 目次側が通っていた前処理は 23 段中 3 段だけで、しかもその 3 段も別実装。
   * 実測で **13 類**の食い違いが出ていた(user 報告の 4 件を含む):
   *   - 採番を付けると本文の id は `1-第一` / 目次の href は `#第一` = **飛ばない**
   *   - `%%隠す%%` は本文からは消えるのに**目次には出る**(slug も不一致)
   *   - `%%%` ブロック / `:::comment` の中の見出しが**目次に出る**(幽霊)
   *   - `||## 中央見出し` / `__ 字下げ` の見出しが**目次から落ちる**
   *   - setext(`===`)/ リスト内 / 引用内の見出しが目次から落ちる
   *   - fence の判定が別実装(``` を ~~~ で閉じたことにする)ので中身が漏れる
   *   - `{{vars.x}}` の出所が違い、目次だけ生の `{{vars.x}}` が出る
   *   - `:::if` の受理方言が違い、消したはずの中身が目次に残る
   *   - 図参照 `[@f1]` が本文では「図 1」に展開されるのに目次では生
   *   - 上のどれか 1 件で同名見出しの衝突連番(`-1` / `-2`)が全部ずれる
   * ⚠ **採るべき形は既に製品の中で動いていた** ── 書き出す HTML の目次
   *   (`features/export/pkc3-html.ts` の `headings()`)は DOM の h1-h3 と実 id から
   *   作っており、13 類のどれも踏んでいない。そちらへ寄せた。
   */
  const tocResult = processTocDirective(text, lineMap);
  text = tocResult.transformed;
  lineMap = tocResult.lineMap;
  /**
   * 🔴 **描くたびに console へ書かない**(#710、2026-09-05)。
   *
   * ⚠ 既定は「書く」だった ── 実測(smoke を全量 1 回、`page.on('console')` を
   *   全種で採った):`:::note` / `:::danger` / `:align:{position=…}` を含む本文を
   *   描くと、**描画のたびに** `[PKC2009]` / `[PKC2007]` が
   *   `markdown-worker` の chunk から出ていた。
   * ⚠ これは**支えている記法**である(`:::note` は `layout.smoke` が地と罫まで
   *   pin している)── それを「tolerant alias accepted」と毎回書くのは、
   *   直す所の無い通知を積むだけである。
   * 🔴 しかも smoke の収集は `msg.type() !== 'error'` で**捨てている**ので、
   *   増えても誰にも見えない(`tests/smoke/helpers.ts`)── だから溜まった。
   * 🔑 **口は残す**(道具のための hint 出力)── 頼まれたときだけ書く。
   *   ⚠ 既に 2 つの test file が `vi.spyOn(console, …)` で黙らせていた
   *   (`markdown-golden.test.ts` / `markdown-user-reports.test.ts`)= **回避が
   *   先に生えていた**合図である。
   */
  const silentHints = opts.silentHallucinationWarnings ?? true;
  // reform-2026-05 Phase 2 PR-2O:standalone :align:{position=X} は次段落の
  // alignMap に register、行は strip(PR-2L hint chip より格上げ、actual align)。
  const tolerantAlignResult = processTolerantStandaloneAlign(
    text, lineMap, silentHints,
  );
  text = tolerantAlignResult.transformed;
  lineMap = tolerantAlignResult.lineMap;
  // reform-2026-05 Phase 2 PR-2L:AI hallucination 形 寛容 parse(critical 群)。
  // inline 4 件(:lead: / :spacing: / :align: / :quote:)を sentinel wrap、
  // postprocess で正式 HTML へ変換、console.info で canonical hint emit。
  // 注:standalone :align: は PR-2O で先に消費されるので、ここに到達する
  // :align: は inline form のみ(hint chip 経由、default 非表示)。
  const tolerantInlineResult = processTolerantInlineAliases(
    text, lineMap, silentHints,
  );
  text = tolerantInlineResult.transformed;
  lineMap = tolerantInlineResult.lineMap;
  // PR-2L:admonition alias(:::note / :::warning / :::callout / :::admonition)
  // を :::section{role=…} に rewrite。processSectionBlocks より先に走らせる。
  const admonitionResult = processAdmonitionAliases(
    text, lineMap, silentHints,
  );
  text = admonitionResult.transformed;
  lineMap = admonitionResult.lineMap;
  // Bug fix(2026-05-18 user 報告):CommonMark blockquote lazy continuation で
  // `> 引用テキスト\n:::section{...}` の `:::section` が blockquote 内に
  // 取り込まれて HTML 構造が崩れる問題を回避。`:::` 行の前後に blank line を
  // 強制挿入して structural separation を取る。AST 経路(`parse.ts`)では
  // PR-W24 v3 で既に同等処理を入れていたが、center pane / Viewer / Split View
  // 経路にも対称に適用するため `colon-block-normalize.ts` から共有 utility
  // を import。詳細 background は同 module のコメントを参照
  // (⚠ かつてここは PKC2 の調査 doc を指していたが、その doc は PKC2 にも
  //  残っていない ── 壊れた導線を置かない。事実は module 側に書いてある)。
  // **本 normalize は admonition alias rewrite(`:::note` → `:::section`)の
  // **後** に走らせる**:rewrite で新たに生まれた `:::` 行も対象にするため。
  // **本 normalize は processBlankLineMarkers / processFigureBlocks /
  // processQuoteBlocks / processSectionBlocks 等 directive 処理の **前** に
  // 走らせる**:lazy continuation で吸い込まれる前に分離する必要があるため。
  const colonNormResult = ensureBlankAroundColonBlocksWithLineMap(text, lineMap);
  text = colonNormResult.transformed;
  lineMap = colonNormResult.lineMap;
  // 🔴 改頁(`+++` / `:::break`)の sentinel も**段落から切り離す**(2026-08-07)
  const breakNormResult = ensureBlankAroundSectionBreaks(text, lineMap);
  text = breakNormResult.transformed;
  lineMap = breakNormResult.lineMap;
  // PR-2K:less-critical block 3 件(:::toc / :::frontmatter / :::body)を
  // sentinel wrap + console.warn(PKC1010)。寛容 parse はせず literal 残し。
  const hallResult = processHallucinatedDirectives(text, lineMap, silentHints);
  text = hallResult.transformed;
  lineMap = hallResult.lineMap;
  // L-8:`_` / `_<N>` 空行マーカー(挿入あり、lineMap 更新)
  const blankResult = processBlankLineMarkers(text, lineMap);
  text = blankResult.transformed;
  lineMap = blankResult.lineMap;
  // L-7:figure/table/equation block(sentinel 化、挿入あり、lineMap 更新)
  const figResult = processFigureBlocks(text, lineMap);
  text = figResult.transformed;
  lineMap = figResult.lineMap;
  text = processFigureRefs(text, figResult.registry);
  // reform-2026-05 PR-D:`:::quote{author=...}` block directive(sentinel 化、
  // 挿入あり、lineMap 更新)。複数 embed を 1 引用 block + 共通 attribution に纏める。
  const quoteResult = processQuoteBlocks(text, lineMap);
  text = quoteResult.transformed;
  lineMap = quoteResult.lineMap;
  // reform-2026-05 Phase 2 PR-2F:`:::section{role=…}` semantic / callout block。
  // PUA sentinel pattern で <section data-pkc-role="…" class="pkc-section-callout
  // pkc-section-<role>"> に変換。:::quote 後に処理(両者は orthogonal)。
  const sectionResult = processSectionBlocks(text, lineMap);
  text = sectionResult.transformed;
  lineMap = sectionResult.lineMap;
  // v4 §12 stack PR 4:`:::format{...}` block 装飾箱(Tier 2 formal)。
  // section と orthogonal、user-defined class / id / indent / align / kvs を attach、
  // <div class="pkc-format-block ..."> に変換。
  const formatResult = processFormatBlocks(text, lineMap);
  text = formatResult.transformed;
  lineMap = formatResult.lineMap;
  // 領域 6:`:::details{summary=…}` 折りたたみブロック(sentinel 化、挿入
  // あり、lineMap 更新)。:::section の後に処理(両者 orthogonal)。
  const detailsResult = processDetailsBlocks(text, lineMap);
  text = detailsResult.transformed;
  lineMap = detailsResult.lineMap;
  // reform-2026-05 Phase 3 PR-2W:`:::frontmatter` / `:::body` region marker
  // を sentinel 化、postProcessRegionSentinels で <aside> / <section> に展開。
  // section と orthogonal、後段 align や figure とも干渉しない passthrough。
  const regionResult = processRegionBlocks(text, lineMap);
  text = regionResult.transformed;
  lineMap = regionResult.lineMap;
  // reform-2026-05 Phase 2 PR-2E:`:::paragraph{align=physical}` block directive
  // を preprocessAlignPrefix の前に処理。content 行に物理 align(left/right/
  // top/bottom/center)を register、後段の applyAlignAttrs で `<p data-pkc-align>`
  // に変換される。L-5 行頭 prefix(logical)と orthogonal、後者が後勝ち。
  const paraAlignResult = processParagraphAlignDirective(text, lineMap);
  text = paraAlignResult.transformed;
  lineMap = paraAlignResult.lineMap;
  const env: {
    currentContainerId: string;
    allowExternalImages: boolean;
    interactiveTasks: boolean;
    interactiveCells: boolean;
    interactiveTags: boolean;
    taskLineOffset: number;
    lineMap?: number[];
    fenceAssets?: Readonly<Record<string, string>>;
  } = {
    // 🔴 添付から取った字(#444 段②)。⚠ 渡されないのが既定 = 器を置く
    ...(opts.fenceAssets !== undefined ? { fenceAssets: opts.fenceAssets } : {}),
    currentContainerId: opts.currentContainerId ?? '',
    // ⚠ 既定は**塞ぐ側**(`external-images.ts` の向きに従う)
    allowExternalImages: opts.allowExternalImages === true,
    // 🔴 チェックの印を押せる形で出すか(#277)。既定は押せない
    interactiveTasks: opts.interactiveTasks === true,
    // 🔴 表のセルを押せる形で出すか(#418 段①)。既定は押せない
    interactiveCells: opts.interactiveCells === true,
    // 🔴 本文中のタグを押せる形で出すか(#550 段③)。既定は押せない
    interactiveTags: opts.interactiveTags === true,
    // 🔴 剥がして描く面だけがずらす(既定 0)。理由は上の option の注記
    taskLineOffset: Number.isInteger(opts.taskLineOffset) ? (opts.taskLineOffset as number) : 0,
  };
  // L-5 align prefix + L-9 indent prefix を pre-process で strip(挿入あり)。
  const alignResult = preprocessAlignPrefix(text, lineMap);
  let stripped = alignResult.stripped;
  // 領域 8 Layer 3:見出しアウトライン番号(opt-in)。align prefix strip 後の
  // 行に番号を前置する(行の挿入なし → lineMap / alignMap は不変)。
  if (opts.headingNumber) {
    stripped = preprocessHeadingNumbers(stripped, opts.headingNumber.start);
  }
  // PR-2E paragraph directive で register された align も merge
  // (preprocessAlignPrefix で同 line に行頭 prefix もあれば後者が上書き)
  const alignMap = new Map<number, AlignKind>([
    ...tolerantAlignResult.alignMap,
    ...paraAlignResult.alignMap,
    ...alignResult.alignMap,
  ]);
  const indentMap = alignResult.indentMap;
  lineMap = alignResult.lineMap;
  /**
   * 🔴 **前処理で行がずれる**(#277)。`md.parse` に渡すのは前処理後の文字列なので、
   * token の `map` は**前処理後の行番号**である ── そのまま焼くと、行頭の寄せ記号
   * などが在るノートで**別の行を書き換える**。
   * ⚠ CLAUDE.md「preprocessor の行挿入は LineMap で原文 index に逆引き」。
   * 🔑 `sourceLineAnchors` / `collectRanges` は**描いた後**に逆引きするが、
   *   チェックの印は**描く途中**(core rule)で焼くので、ここで渡す。
   */
  env.lineMap = lineMap ?? undefined;
  let html: string;
  /**
   * 🔴 **行の対応表を「属性に焼かずに」受け取る**(2026-08-05。ライブエディタ S2。
   * 設計 doc `live-editor-design-2026-08.md` §7-1)。
   *
   * 焼くと、行数が変わる編集で**全塊の HTML が変わる** ── `apply-blocks.ts` は
   * 塊 HTML の完全一致で差分を取るので、行を 1 行足すだけで編集点から末尾まで
   * 全部作り直しになる(閲覧ペインで現に起きている)。だから
   * `collectRanges` を渡した場合も **HTML は anchors OFF と byte 一致**にする
   * ── そうすれば `sourceLineAnchors` は据え置きで goldens が 1 byte も動かない。
   */
  const wantsTokens =
    opts.sourceLineAnchors === true || opts.collectRanges !== undefined;
  if (!wantsTokens) {
    if (alignMap.size === 0 && indentMap.size === 0) {
      html = md.render(stripped, env);
    } else {
      const tokens = md.parse(stripped, env);
      applyAlignAttrs(tokens, alignMap, indentMap);
      html = md.renderer.render(tokens, md.options, env);
    }
  } else {
    // 領域 10-1 — opt-in source-line anchor stamping on block tokens。
    // lineMap で stripped output index → 原文 input index へ逆引き。
    const tokens = md.parse(stripped, env);
    applyAlignAttrs(tokens, alignMap, indentMap);
    // ⚠ **集めるのが先、焼くのが後**(順は結果に影響しないが、集める側が
    //    焼いた属性に依存していないことを読んで分かる形にしておく)
    if (opts.collectRanges !== undefined) {
      collectSourceRanges(tokens, lineMap, opts.collectRanges);
    }
    if (opts.sourceLineAnchors === true) tagSourceLines(tokens, lineMap);
    html = md.renderer.render(tokens, md.options, env);
  }
  // L-7:figure/table/equation sentinel → <figure>
  html = postProcessFigureSentinels(html);
  // reform-2026-05 PR-D:`:::quote{author=...}` sentinel → <blockquote class="pkc-quote-citation">
  html = postProcessQuoteSentinels(html, quoteResult.registry);
  html = postProcessSectionSentinels(html, sectionResult.registry);
  html = postProcessFormatBlockSentinels(html, formatResult.registry);
  // 領域 6:`:::details` sentinel → <details class="pkc-details">
  html = postProcessDetailsSentinels(html, detailsResult.registry);
  // PR-2W:`:::frontmatter` / `:::body` sentinel → <aside> / <section>
  html = postProcessRegionSentinels(html, regionResult.registry);
  // L-1:section break sentinel → <hr>
  html = postProcessSectionBreaks(html);
  // L-8:blank-line sentinel → <div class="pkc-blank-line">
  html = postProcessBlankLineMarkers(html);
  // M-7:undefined variable sentinel → <span class="pkc-variable-undefined">
  html = postProcessVariableUndefined(html);
  // PR-2L:tolerant alias sentinel → <span class="pkc-lead">/<small>/<div>
  html = postProcessTolerantSentinels(html);
  // PR-2K:hallucination block sentinel → <div class="pkc-warning-hallucination-block">
  html = postProcessHallucinatedDirectives(html);
  /**
   * 🔴 **目次は post 段のいちばん最後**(2026-08-07)。
   *
   * 見出しの文字を**出来上がった HTML から**採るので、ほかの sentinel が全部
   * 実体に変わった後でなければならない。1 段でも手前に置くと、目次の項目に
   * **私用領域の sentinel 文字(U+E110〜U+E17F)がそのまま載る**(不可視なので
   * 画面では気づけない)。`tests/features/toc-heading-parity.test.ts` がそこを pin する。
   */
  html = postProcessTocSentinels(html, buildTocNavsFromHtml(html, tocResult.records));
  return html;
}

/**
 * Check if text contains markdown syntax worth rendering.
 * Used to decide whether to show rendered markdown or plain text.
 *
 * Detects: headings, emphasis, code, lists, blockquotes, links,
 * tables, horizontal rules, fenced code blocks, task lists.
 */
export function hasMarkdownSyntax(text: string): boolean {
  if (!text) return false;
  if (/^#{1,6}\s|\*\*|__|\*[^*\s]|_[^_\s]|`[^`]+`|^\d+\.\s|^[-*+]\s|^>\s|^```|^---$|^[*]{3,}$|!?\[[^\]]*\]\([^)]+\)|^\|.+\||^[-*+]\s+\[[ xX]\]/m.test(text)) return true;
  // FI-08.x: bare URLs should flow through markdown-it linkify (D-FB1=B).
  if (/\b(?:https?|ftp):\/\/[^\s<>]/i.test(text)) return true;
  // wave-10-2 Phase 1 dialect extensions: L-1 / L-2 / L-3 / L-4 / L-5 / L-7 を
  // markdown render に通す。これがないと「`||` 等だけ」の body が plain-text 経路に
  // 流れて L-5 の align prefix も applied されない(2026-05-07 user 報告)。
  if (/^(?:\|\||\|>|<\||\|<|>\|)/m.test(text)) return true; // L-5 align prefix(reform-2026-05 PR-C で 4 形受理)
  if (/^\+\+\+\s*(?:\{[^}]*\})?\s*$/m.test(text)) return true; // L-1 section break
  if (/==[^=]+==|\[\[(?:ruby|em):/.test(text)) return true;     // L-2 highlight / ruby / em-dot
  if (/^:::(?:figure|table|equation)(?:\{[^}]*\})?\s*$/m.test(text)) return true;  // L-3 figure / table / equation block(reform-2026-05 で kv quoted 形も受理)
  if (/^:::(?:quote|if|section|details|format|comment|toc|paragraph|break|heading|list|code|figure|table|equation|blank|math)(?:\{[^}]*\})?\s*$/m.test(text)) return true;  // :::name{attrs}? formal directive(寛容 alias / Q8 value-only も同 regex で network)
  // v4 §12 stack PR hotfix:Tier 0 vocabulary `:::red,bg-yellow,1.2em` + Tier 1 class chain
  // `:::.cls.cls(#id)?` + 寛容 alias `:::note` 等 8 種 + `:::callout{type=X}` /
  // `:::admonition{type=X}` も markdown 経路へ流す。`hasMarkdownSyntax` が false を返すと
  // `detail-presenter.ts:153` の `<pre>` plain-text fallback に落ちて fence のような
  // 見た目になる(user bug 報告 2026-05-27)。
  if (/^:::(?:\.|[a-z])/m.test(text)) return true;  // :::name(任意 vocab / role / Tier 0/1)
  if (/^:::\s*\{/m.test(text)) return true;  // ::: {...} Pandoc brace form
  if (/^:::\s+[\w.#]/m.test(text)) return true;  // ::: <space-separated tokens>(Tier 1 variant 2 / 6)
  if (/%%[^\n]*?%%|%%%[\s\S]*?%%%/.test(text)) return true;     // L-4 comments
  if (/\[@[a-zA-Z0-9_-]+\]/.test(text)) return true;            // L-7 figure ref
  if (/^\s*_\d*\s*$/m.test(text)) return true;                  // L-8 blank-line marker
  if (/^\s*(?:__|＿)(?!_)/m.test(text)) return true;            // L-9 indent prefix
  return false;
}

/**
 * ⚠ **`getMarkdownInstance()` は削除した**(#78、2026-08-22。着地前レビューが拾った)。
 * 「adapter が boot で plugin を足せるように」という触れ込みだったが、
 * **呼び手は 5 年分の履歴を通して 1 件も無かった**(`grep` で定義行のみ)。
 * 🔑 生かしておくと `md` の**中身を外へ配る口**になり、
 * この file が持っている取り決め(安全な scheme の allowlist / linkify の絞り込み)を
 * 外から黙って崩せる。⚠ 本当に要るときは「何をしたいか」の名前で口を切り直す。
 */

/**
 * Render markdown as inline-only HTML (no <p> wrapper, no block-level
 * preprocessors). About entry / Card preview / tooltip 等の「短い inline 文字列」
 * を render するための軽量版(2026-05-10、PR-2Q、user 要望:「About も
 * PKC Markdown お披露目の場、しっかり markdown 表示」)。
 *
 * 含まれる:emphasis(`**bold**` `*em*`)、inline code(`` `x` ``)、links、
 * strikethrough、em-dot `^^X^^`、highlight `==X==`、ruby、L-6 simple inline、
 * autolinks。
 *
 * 含まれない:block-level preprocessor(:::section / :::figure / vars 展開 /
 * 寛容 parse 等)、`<p>` wrapper。block markup を含む文字列で呼んでも block
 * 構造は復元されない。
 */
export function renderMarkdownInline(text: string): string {
  if (!text) return '';
  return md.renderInline(text);
}
