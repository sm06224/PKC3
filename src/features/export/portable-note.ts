/**
 * 🔴 **配る形(閲覧用 HTML・配布パッケージ)の、ノート 1 件の描き方**(v4.1 Phase 2 / PR-6、#2098 後半で `pkc3-html.ts` から切り出した)。
 *
 * 閲覧用 HTML(`pkc3-html.ts`)と配布パッケージ(`pkc3-site-zip.ts`)は、**同じ本文から同じ HTML を作る**。
 * 前書きの添付の走査・本文の添付参照・コードブロックの添付・vars と見出し番号・SQL の答え・図とグラフ・板の題名・
 * 文書属性・ウィジェットの「同じノートのデータ」は、すべてここを通す(2 本目を書かない ── CLAUDE.md §7)。
 *
 * ⚠ pure module(DOM を持たない)。描くのは呼び手が渡す `render`(アプリからは markdown ワーカー)。
 */
import { parseFrontmatter, extractVars, type FrontmatterValue } from '../markdown/frontmatter';
import { collectFenceAssetKeys, type RenderMarkdownOptions } from '../markdown/markdown-render';
import { bakeFigures, type FigureBakers } from './figure-bake';
import { bakeSqlEmbeds, type SqlEmbedAnswer } from '../markdown/sql-embed';
import { EXTERNAL_IMAGE_ATTR } from '../markdown/external-images';
import { ADOPT_IMAGES_LABEL } from '@features/entry-actions';
import { extractDocumentGlobals, extractHeadingNumberConfig, globalsToDataAttrs } from '../markdown/document-globals';
import { scanAssetRefsInto } from '@features/asset/asset-ref-scan';
import { readFenceAssets } from '@features/asset/fence-asset-read';
import { insertPlacedNoteTitles } from './placed-note-title';
import { WIDGET_FRAME_ATTR } from '../markdown/html-sandbox';
import { extractWidgetNoteContext, type WidgetNoteContext } from '../markdown/widget-context';
import type { ArchiveSource } from './pkc3-archive';
import type { WarnCollector } from './warn-cap';

/**
 * 閲覧側でノート間リンクを効かせるための名前(#1087 の見直し 2026-10-13)。
 * ⚠ 閲覧側の script は画面の字の検査に掛かる(日本語を含むリテラルなので)── 属性名と key は式で差す。
 */
/** 描いた本文の中のノート間リンク(閲覧側の `a[${NOTE_LINK_ATTR}]` と同じ物)。1 つ目の組がリンク先の lid。 */
export const NOTE_LINK_IN_HTML = /<a\b[^>]*\bdata-pkc-entry-ref="entry:([^"#]+)/g;
/**
 * 🔴 **`@[card](entry:…)` の札**(#1087)も、ノート間リンクと同じに数え、同じに効かせる。
 * 描いた本文の中の `<span data-pkc-card-target="entry:<lid>…">`。⚠ `pkc://<自分>/…` 宛の札は読まない
 * (閲覧側は入れ物の id を持たない ── 押せないままで、数にも入れない = 以前と同じ)。
 */
export const NOTE_CARD_IN_HTML = /<span\b[^>]*\bdata-pkc-card-target="entry:([^"#]+)/g;
/**
 * 🔴 **描いた本文にウィジェットの箱が在るか**(#2097 / #2098)── 在るノートにだけ「同じノートのデータ」(`ctx`)を焼く。
 * ⚠ 見るのは**本物のタグ**(`<iframe … data-pkc-widget-frame`)だけ ── 本文のコードに書いた字は `&lt;` になるので当たらない。
 */
export const WIDGET_FRAME_IN_HTML = new RegExp(`<iframe\\b[^>]*\\s${WIDGET_FRAME_ATTR}=`);


/**
 * 🔴 **開いた先で原文の字・空の枠になる物を数える**(#1087)。
 *
 * 閲覧側には mermaid / chart.js / KaTeX を積まない(上の script の注記)ので、図・グラフ・数式は
 * **打った原文の字**で出て、読み込んでいない外部画像は**空の枠**になる。渡す側には何も言っていなかった
 * (自分の画面では図が描けているので、気づけない)。⚠ **言うだけ** ── 図を焼き込むかは別の判断。
 * 🔑 数えるのは**描いた HTML の中の器**(閲覧側がそう扱う属性そのもの)。⚠ 器の属性名は
 * 閲覧側の script が拾う名前と**同じ文字列**(片方だけ変えると、数えた物と開いた先で起きることがずれる)。
 * ⚠ タグの中の属性だけを見る(コードの中に属性名を書いた文は `<` が `&lt;` になるので当たらない)。
 */
const COUNT_ATTRS = {
  mermaid: 'data-pkc-mermaid-src',
  chart: 'data-pkc-chart-src',
  plotly: 'data-pkc-plotly-src',
  /** React の囲み。⚠ 箱の中でランタイムごと動かす物なので、焼き込まず原文の字で出す(閲覧側に React を積まない)。 */
  react: 'data-pkc-react-src',
  math: 'data-pkc-math-src',
  /** 外部の画像。⚠ 焼いた(設定が「常にオン」の)ときは `src` が付き、この属性は付かない = 数えない。 */
  externalImage: EXTERNAL_IMAGE_ATTR,
  /** 別のノートの内容の埋め込み(`![説明](entry:…#h/…)`)。⚠ 開いた先には中身が無く、説明の字だけが出る(#1087)。 */
  embed: 'data-pkc-embed-ref',
} as const;
export type CountKind = keyof typeof COUNT_ATTRS;

export function countContainers(html: string): Record<CountKind, number> {
  const out: Record<CountKind, number> = { mermaid: 0, chart: 0, plotly: 0, react: 0, math: 0, externalImage: 0, embed: 0 };
  for (const kind of Object.keys(COUNT_ATTRS) as CountKind[]) {
    const re = new RegExp(`<[a-zA-Z][^>]*\\s${COUNT_ATTRS[kind]}="`, 'g');
    out[kind] = (html.match(re) ?? []).length;
  }
  return out;
}

/**
 * 数式が「打った字のまま」出ることの注意(0 件なら `null`)。
 * 🔑 閲覧用 HTML と Word / PowerPoint が**同じ文面**を使うよう 1 か所に置く(#1087)。
 */
export function mathSourceNotice(n: number): string | null {
  return n > 0 ? `数式 ${n} 件は、開いた先では打った字のまま出ます` : null;
}

/**
 * 別のノートの内容の埋め込み(`![説明](entry:…#h/…)`)が説明の字だけで出ることの注意(0 件なら `null`)。
 * 🔑 閲覧用 HTML と Word / PowerPoint が**同じ文面**を使うよう 1 か所に置く(#1648)。
 */
export function embedSourceNotice(n: number): string | null {
  return n > 0 ? `別のノートの内容の埋め込み ${n} 件は、開いた先では説明の字だけで出ます` : null;
}

/** 注意の文面(0 件の種類は出さない)。 */
export function openedAsSourceNotices(n: Record<CountKind, number>): string[] {
  const w: string[] = [];
  if (n.mermaid > 0) w.push(`図(mermaid)${n.mermaid} 件は、開いた先では原文の字で出ます`);
  if (n.chart > 0) w.push(`グラフ ${n.chart} 件は、開いた先では原文の字で出ます`);
  if (n.plotly > 0) w.push(`グラフ(plotly)${n.plotly} 件は、開いた先では原文の字で出ます`);
  if (n.react > 0) w.push(`React のコード ${n.react} 件は、開いた先では原文の字で出ます`);
  const math = mathSourceNotice(n.math);
  if (math !== null) w.push(math);
  const embed = embedSourceNotice(n.embed);
  if (embed !== null) w.push(embed);
  if (n.externalImage > 0) {
    w.push(
      `外部の画像 ${n.externalImage} 件は、開いた先では空の枠になります` +
        `(右のペインの「${ADOPT_IMAGES_LABEL}」で取り込んでから書き出すと入ります)`,
    );
  }
  return w;
}

const str = (v: FrontmatterValue | undefined): string => (typeof v === 'string' ? v : '');

/**
 * 本文が **markdown の外**で参照している添付(key と表示名)を集める。
 *
 * 🔴 添付 entry の body は **frontmatter だけ**(`attachment.asset_key: …`)で、
 * `asset:` 参照を**一切含まない**。本文を `asset:` で走査するだけの閲覧側は
 * 「添付が 1 個も無いノート」に見える ── 実際 smoke で踏んだ。
 * ⚠ 解決は**書き出し側**でやる:閲覧側(依存ゼロのインライン JS)に
 * frontmatter parser を持たせると、本物の parser と二重実装になって必ずずれる。
 *
 * ⚠ **判定を自前で持たない**(review M2)。`body.startsWith('---\n')` のような
 * 手軽なガードを置くと、本物より狭い**3 つめのルール**になる ── 開始 fence の
 * 末尾空白や CRLF を落とし、「アプリでは見えている添付が書出しでは消える」。
 * `parseFrontmatter` は fence 無しなら正規表現 1 発で返るので、ガードは何も買わない。
 *
 * `*asset_key` で終わる key を総なめするので、`attachment.app_icon_asset_key`
 * のような将来 field も archetype を知らずに拾える。表示名は同じ prefix の
 * `…name`(`attachment.asset_key` → `attachment.name`)を引く。
 */
export function frontmatterAssets(body: string): {
  /** frontmatter の文字数(閲覧側はここまで読み飛ばす)。 */
  skip: number;
  refs: Array<{ key: string; name: string }>;
} {
  const r = parseFrontmatter(body);
  const skip = body.length - r.body.length; // parseFrontmatter の残骸は常に suffix
  const refs: Array<{ key: string; name: string }> = [];
  for (const [k, v] of Object.entries(r.meta)) {
    if (!k.endsWith('asset_key')) continue;
    const key = str(v);
    if (key === '' || refs.some((x) => x.key === key)) continue;
    refs.push({ key, name: str(r.meta[`${k.slice(0, -'asset_key'.length)}name`]) });
  }
  return { skip, refs };
}

/** ノート 1 件を描くのに要る物(書き出し 1 回ぶんで共通)。 */
export interface PortableNoteDeps {
  readonly src: ArchiveSource;
  readonly render: (text: string, opts?: RenderMarkdownOptions) => string | Promise<string>;
  readonly allowExternalImages: boolean;
  readonly askSql?: (sql: string) => Promise<SqlEmbedAnswer>;
  readonly figures?: FigureBakers;
  /** 包含の判定の候補(この入れ物の添付の key 全部)。 */
  readonly assetKeys: readonly string[];
  /** 板に置いたノートの題名を引く(入っていなければ `null`)。 */
  readonly titleOf: (lid: string) => string | null;
  readonly warn: WarnCollector;
}

/** 描いた 1 件。 */
export interface PortableNote {
  readonly html: string;
  /** 文書属性(書字方向など)。無ければ空。 */
  readonly attrs: Record<string, string>;
  /** 前書きから参照している添付(key と表示名)。 */
  readonly attach: ReadonlyArray<{ key: string; name: string }>;
  /** 本文が参照している添付の key。 */
  readonly refs: readonly string[];
  /** コードブロックが指している添付の key(` ```html asset:… ` のウィジェットを含む)。 */
  readonly fenceKeys: readonly string[];
  /** ウィジェットの箱が在るときだけ、その箱が読む「同じノートのデータ」。 */
  readonly ctx: WidgetNoteContext | null;
  /** 本文の中のノート間リンク・札の行き先(lid)。 */
  readonly links: readonly string[];
  /** 開いた先で原文の字・空の枠になる物の数。 */
  readonly counts: Record<CountKind, number>;
}

/**
 * 🔴 **ノート 1 件を描く**(全文 = 前書き込みの body を受ける)。
 * 中身は `writePortableHtml` が 1 件ごとにやっていた手順そのもの(順番も同じ)。
 */
export async function renderPortableNote(body: string, deps: PortableNoteDeps): Promise<PortableNote> {
  const { skip, refs: attach } = frontmatterAssets(body);
  // 🔴 本文が参照している添付。**判定は正本 1 本**(P8 段㉑ ── `features/asset/asset-ref-scan.ts`)
  const refs: string[] = [];
  {
    const remaining = new Set(deps.assetKeys);
    scanAssetRefsInto(body, remaining, (k) => refs.push(k));
  }
  // 🔴 vars・見出し番号・文書属性は**全文**(前書き込み)から取る(user 報告 2-7)
  const globals = extractDocumentGlobals(body);
  // 🔴 コードブロックが指している添付を字として焼き込む(#444 段②)── この本文が指している鍵だけを読む
  const fenceKeys = collectFenceAssetKeys(body.slice(skip));
  const fenceAssets = await readFenceAssets(
    (k) => deps.src.getAssetBlob(k),
    fenceKeys,
    (k, why) =>
      deps.warn.add(
        'fence-asset',
        'コードブロックが指す添付の注意',
        `コードブロックが指している添付を埋め込めませんでした(${k}): ${why}`,
      ),
  );
  const rendered = await deps.render(body.slice(skip), {
    // 🔴 この入れ物の id を渡す(自分宛の pkc:// を外の参照として扱わせない)
    currentContainerId: deps.src.cid,
    vars: extractVars(body),
    headingNumber: extractHeadingNumberConfig(body),
    allowExternalImages: deps.allowExternalImages,
    ...(Object.keys(fenceAssets).length > 0 ? { fenceAssets } : {}),
  });
  // 🔴 本文に埋め込んだ SQL の答えを、書き出した時点の表にして焼く(#1223 Q3 = B)
  const sqlBaked = deps.askSql ? await bakeSqlEmbeds(rendered, deps.askSql) : rendered;
  // 🔴 図とグラフを絵にして焼く(#1648)。同じ原文の表はノートごとに捨てる
  const baked = deps.figures ? await bakeFigures(sqlBaked, deps.figures, new Map()) : sqlBaked;
  // 🔴 板に置いたノートは、空の枠ではなく題名を出す(#1163 依頼 278 = A)
  const html = insertPlacedNoteTitles(baked, deps.titleOf, 'html');
  const attrs = globalsToDataAttrs(globals);
  if (globals.direction) attrs['dir'] = globals.direction;
  const links: string[] = [];
  for (const hit of html.matchAll(NOTE_LINK_IN_HTML)) links.push(hit[1]!);
  for (const hit of html.matchAll(NOTE_CARD_IN_HTML)) links.push(hit[1]!);
  return {
    html,
    attrs,
    attach,
    refs,
    fenceKeys,
    // 🔴 ウィジェットの箱の在るノートにだけ焼く(#2097)── 正本は本体と同じ `extractWidgetNoteContext`
    ctx: WIDGET_FRAME_IN_HTML.test(html) ? extractWidgetNoteContext(body) : null,
    links,
    counts: countContainers(html),
  };
}

/** 数の入れ物(0 件)。 */
export function emptyCounts(): Record<CountKind, number> {
  return { mermaid: 0, chart: 0, plotly: 0, react: 0, math: 0, externalImage: 0, embed: 0 };
}
