/**
 * 🔴 **配布パッケージ(`*.pkc3-site.zip`)** ── 複数のノートと HTML のツールを 1 つの zip にまとめ、
 * **展開して `index.html` を開くだけ**(ローカルのサーバ不要・`file://` のまま)で読める形(v4.1 Phase 2 / PR-6、#2098 後半)。
 *
 * ⚠ **可逆ではない**(取り込み直せない)。バックアップは `.pkc3-full.zip` / `.pkc3-notes.zip`。
 *
 * ## zip の中身
 *
 * ```text
 * index.html          軽量シェル(目次・横断検索・複数タブ・ツール一覧・テーマ切替・portable-widget-bridge)
 * manifest.js         window.__PKC_SITE_MANIFEST__ = { format, version, title, exportedAt, notes, tools, assets }
 * data/note-<n>.js    ノート 1 件(開いたときだけ読む ── window.__PKC_SITE_NOTE__(n, payload))
 * data/asset-<n>.js   ウィジェットの在るノートが参照する 10 MB 以下の添付だけ(window.__PKC_SITE_ASSET__(key, base64))
 * tools/<slug>.html   同梱した HTML のツール(単体でも、index.html のタブの中でも動く)
 * assets/<n>-<名前>   添付の生ファイル(base64 にしない)
 * ```
 *
 * ## 🔴 `file://` で動かすための急所
 *
 * 1. **`fetch` を使わない** ── `file://` では CORS で止まる。ノートと添付の中身は `<script src>` で読み、読んだら `<script>` を外す
 *    (動的 `<script>` は同じ制限を受けない)。`<script>` に入れる JSON は `escapeForScriptData`(`<` を退避)を通す。
 * 2. **添付は生ファイル**で置き、相対パス(`./assets/…`)で直に参照する(base64 の 33% 膨張なし・常駐なし)。
 *    ウィジェットの「このノートの添付から選ぶ」だけは bytes が要るので、`data/asset-<n>.js` を**必要な物にだけ**作る。
 * 3. **ツールは `sandbox="allow-scripts"` だけ**の `<iframe src="./tools/…">`(`allow-same-origin` / `allow-downloads` は付けない)。
 *    確認つきの保存・読み込みは閲覧用 HTML と**同じ親**(`portable-widget-bridge.ts`)を通す(2 本目の親を書かない)。
 *
 * ## 🔴 安全の既定
 *
 * - 添付 HTML のウィジェットに PKC3 で許していた追加権限(外部スクリプト・外部通信)は**引き継がない**(既定の厳格な CSP)。
 * - ツールのタブは**どのノートのデータも読めない**(`getFrameContext` は空、`getFrameAssets` は空 ── PC との入出力だけ)。
 *
 * ## ゼロコピー・省メモリ
 *
 * ノート 1 件ずつ描いて zip へ流し、文字列は手放す。添付の `Blob` は `ZipWriter.add` へそのまま渡す。
 * base64 は 3 バイト境界で 1 チャンクずつ `Blob` にする(`base64Chunks` ── 閲覧用 HTML と同じ 1 本)。
 */
import BODY_CSS from 'virtual:pkc-body-css';
import { renderMarkdown, type RenderMarkdownOptions } from '../markdown/markdown-render';
import type { FigureBakers } from './figure-bake';
import type { SqlEmbedAnswer } from '../markdown/sql-embed';
import { createWarnCollector } from './warn-cap';
import { PHONE_MAX_PX } from '../phone-layout';
import { assetPreviewKind } from '@features/asset/asset-preview-kind';
import { DEFAULT_PAGE_FORMAT, pageFormatCss, type PageFormat } from '../page-format';
import { DEFAULT_PROSE_ALIGN, proseAlignCss, type ProseAlign } from '../prose-align';
import type { ArchiveSource } from './pkc3-archive';
import { buildPortableWidgetBridgeScript, portableWidgetBridgeCss } from './portable-widget-bridge';
import { portableHydrateJs } from './portable-hydrate';
import {
  emptyCounts,
  openedAsSourceNotices,
  renderPortableNote,
  type CountKind,
  type PortableNoteDeps,
} from './portable-note';
import { base64Chunks, escapeForScriptData } from './pkc3-html';
import { ZipWriter } from './zip-writer';
import { safeName } from './file-name';
import { readTags } from '../flavor/tags';
import { isAppMime } from '../launcher/tiles';
import { buildStandaloneWidgetHtml, widgetExportFileName, widgetIdFromFileName } from '../markdown/widget-export';
import type { WidgetTheme } from '../markdown/widget-bridge';
import { WIDGET_FRAME_ATTR } from '../markdown/html-sandbox';

export const SITE_FORMAT = 'pkc3-site';
export const SITE_VERSION = 1;
/** 🔴 `data/asset-<n>.js` を作る上限(これより大きい添付は生ファイルだけ ── zip を太らせない)。 */
export const SITE_INLINE_ASSET_MAX_BYTES = 10 * 1024 * 1024;
/** ツールのタブの箱の名乗りの頭(`tools/*.html` の prelude と `index.html` の `<iframe>` で同じ字)。 */
export const SITE_TOOL_FRAME_PREFIX = 'pkc-site-tool-';
/** ノート 1 件を受ける窓口関数の名前(`data/note-<n>.js` が呼ぶ)。 */
export const SITE_NOTE_CALLBACK = '__PKC_SITE_NOTE__';
/** 添付の bytes を受ける関数の名前(`data/asset-<n>.js` が呼ぶ)。 */
export const SITE_ASSET_CALLBACK = '__PKC_SITE_ASSET__';
/** 目録の変数名(`manifest.js` が置く)。 */
export const SITE_MANIFEST_VAR = '__PKC_SITE_MANIFEST__';
/** 1 バッチで取る本文の目安。 */
const BODY_BATCH_BYTES = 4 * 1024 * 1024;
/** 横断検索に使う本文の抜き出しの長さ(本文そのものは開くまで読まない)。 */
const EXCERPT_CHARS = 400;
/** ツールにする HTML の上限(これより大きい HTML はツールにせず、添付のまま置く)。 */
const TOOL_MAX_BYTES = 20 * 1024 * 1024;

export interface SiteOptions {
  /** 本文 1 件を HTML にする(アプリからは markdown ワーカー)。省略するとその場で描く。 */
  readonly render?: (text: string, opts?: RenderMarkdownOptions) => string | Promise<string>;
  /** 外部の画像を焼くか(設定が「常にオン」のときだけ true)。 */
  readonly allowExternalImages?: boolean;
  readonly pageFormat?: PageFormat;
  readonly proseAlign?: ProseAlign;
  readonly askSql?: (sql: string) => Promise<SqlEmbedAnswer>;
  readonly figures?: FigureBakers;
  /** ツールを単体で開いたときの配色(書き出した時点の画面の配色)。省略すると明るい既定。 */
  readonly toolTheme?: WidgetTheme;
}

export interface SiteResult {
  blob: Blob;
  warnings: string[];
  counts: { entries: number; assets: number; tools: number; inlineAssets: number };
}

/** 目録の 1 ノート(検索に使う軽い字だけ。本文は入れない)。 */
interface SiteNoteMeta {
  i: number;
  lid: string;
  title: string;
  archetype: string;
  headings: string[];
  tags: string[];
  excerpt: string;
}

interface SiteAssetMeta {
  key: string;
  name: string;
  mime: string;
  size: number;
  kind?: string;
  /** zip の中の置き場所(`assets/<n>-<名前>`)。 */
  path: string;
  /** `data/asset-<n>.js` が在るとき、その名前。 */
  inline?: string;
}

interface SiteToolMeta {
  i: number;
  name: string;
  path: string;
  frameId: string;
}

const j = (v: unknown): string => escapeForScriptData(JSON.stringify(v));
/** ⚠ 閲覧側の script は画面の字の検査に掛かる(日本語を含むリテラル)── ノートの id の key は式で差す(閲覧用 HTML と同じ作法)。 */
const LID = 'lid';

/** HTML の字だけ(タグを外し、よく出る実体参照を戻す)。検索の抜き出しと見出しに使う。 */
export function htmlToPlainText(html: string): string {
  return html
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<iframe\b[\s\S]*?<\/iframe>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 描いた本文の見出し(h1〜h3)の字。 */
export function headingTexts(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1>/gi)) {
    const t = htmlToPlainText(m[2]!);
    if (t !== '') out.push(t);
  }
  return out;
}

/** 名前に拡張子が無ければ空。 */
function extOf(name: string): string {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(name);
  return m ? m[1]!.toLowerCase() : '';
}

/**
 * 添付の置き場所(`assets/<n>-<名前>`)。番号を頭に付けるので同名でもぶつからない。
 * ⚠ 名前の無害化は `safeName` の 1 本(拡張子は残す)。
 */
export function siteAssetFileName(index: number, name: string, key: string): string {
  const base = name.trim() !== '' ? name : key;
  const ext = extOf(base);
  const stem = ext === '' ? base : base.slice(0, -(ext.length + 1));
  const safe = safeName(stem);
  return `assets/${index}-${safe}${ext === '' ? '' : `.${ext}`}`;
}

/** HTML のツールとして同梱する添付か。⚠ 種類が分からない添付は、名前が `.html` のときだけ。 */
function isToolAsset(mime: string | undefined, name: string): boolean {
  if (mime === undefined || mime === '') return /\.x?html?$/i.test(name);
  return isAppMime(mime);
}

/**
 * 🔴 **明暗の切り替え用のトークン**(焼いた `BODY_CSS` の明るい層と暗い層を、`[data-pkc-tone]` でも当たる形に写す)。
 * ⚠ 値は書き写さない(焼いた分から抜く ── 正本は `tokens.css`)。抜けなければ空(OS に合わせるだけになる)。
 */
export function toneOverrideCss(css: string): string {
  const darkHead = '@media (prefers-color-scheme:dark){:root{';
  const di = css.indexOf(darkHead);
  const li = css.indexOf(':root{--surface:');
  if (di < 0 || li < 0) return '';
  const dark = css.slice(di + darkHead.length, css.indexOf('}', di + darkHead.length));
  const light = css.slice(li + ':root{'.length, css.indexOf('}', li));
  if (dark === '' || light === '') return '';
  return `:root[data-pkc-tone=light]{${light};color-scheme:light}:root[data-pkc-tone=dark]{${dark};color-scheme:dark}`;
}

/**
 * 配布パッケージを書く。
 * @throws ノートが 1 件も無いときは断る(「書き出したつもりで空」を作らない)
 */
export async function writePortableSiteZip(
  src: ArchiveSource,
  exportedAt: string,
  opts: SiteOptions = {},
): Promise<SiteResult> {
  const warnings: string[] = [];
  const warn = createWarnCollector(warnings);
  const metas = await src.listEntryMetas();
  if (metas.length === 0) throw new Error('書き出せるノートが 1 件もありません');
  const metaOf = new Map(metas.map((m) => [m.lid, m]));

  const allAssets = await src.listAssetMetas();
  const assetKeys = allAssets.map((a) => a.key).filter((k) => k !== '');
  const render = opts.render ?? ((text: string, o?: RenderMarkdownOptions) => renderMarkdown(text, o));
  const noteDeps: PortableNoteDeps = {
    src,
    render,
    allowExternalImages: opts.allowExternalImages === true,
    ...(opts.askSql ? { askSql: opts.askSql } : {}),
    ...(opts.figures ? { figures: opts.figures } : {}),
    assetKeys,
    titleOf: (id) => metaOf.get(id)?.title ?? null,
    warn,
  };

  const zip = new ZipWriter();
  const used = new Set<string>();
  const nameOf = new Map<string, string>();
  /** ウィジェットの在るノートが参照する添付(`data/asset-<n>.js` の候補)。 */
  const widgetAssets = new Set<string>();
  /** ツールの候補(前書きの添付と、コードブロックが指す添付)。 */
  const toolCandidates: string[] = [];
  const notes: SiteNoteMeta[] = [];
  const exportedLids = new Set<string>();
  const linkTargets: string[] = [];
  const opened: Record<CountKind, number> = emptyCounts();

  let after: { entryOrder: number; lid: string } | undefined;
  for (;;) {
    const { rows, done, next } = await src.listBodies(after, BODY_BATCH_BYTES);
    for (const r of rows) {
      const m = metaOf.get(r.lid);
      if (!m) {
        warn.add('orphan-body', '一覧に無いノートの注意', `本文はあるが一覧に無いノートを飛ばしました: ${r.lid}`);
        continue;
      }
      const note = await renderPortableNote(r.body, noteDeps);
      for (const ref of note.attach) {
        used.add(ref.key);
        if (ref.name !== '' && !nameOf.has(ref.key)) nameOf.set(ref.key, ref.name);
        toolCandidates.push(ref.key);
      }
      for (const k of note.refs) used.add(k);
      for (const k of note.fenceKeys) if (assetKeys.includes(k)) toolCandidates.push(k);
      if (note.ctx !== null) {
        for (const ref of note.attach) widgetAssets.add(ref.key);
        for (const k of note.refs) widgetAssets.add(k);
      }
      const i = notes.length;
      const payload = {
        i,
        lid: m.lid,
        title: m.title,
        archetype: m.archetype,
        html: note.html,
        ...(Object.keys(note.attrs).length > 0 ? { attrs: note.attrs } : {}),
        ...(note.attach.length > 0 ? { attach: note.attach.map((x) => x.key) } : {}),
        ...(note.refs.length > 0 ? { refs: note.refs } : {}),
        ...(note.ctx !== null ? { ctx: note.ctx } : {}),
      };
      // 🔑 1 件ずつ zip へ流す(全ノートの HTML を heap に溜めない)
      await zip.add(`data/note-${i}.js`, [`window.${SITE_NOTE_CALLBACK}(${i},${j(payload)});\n`]);
      notes.push({
        i,
        lid: m.lid,
        title: m.title,
        archetype: m.archetype,
        headings: headingTexts(note.html),
        tags: readTags(r.body),
        excerpt: htmlToPlainText(note.html).slice(0, EXCERPT_CHARS),
      });
      exportedLids.add(m.lid);
      // ⚠ 1 件ずつ足す(引数展開はリンクが極端に多いノートで上限に当たる)
      for (const l of note.links) linkTargets.push(l);
      for (const k of Object.keys(note.counts) as CountKind[]) opened[k] += note.counts[k];
    }
    if (done || !next) break;
    if (
      after !== undefined &&
      !(next.entryOrder > after.entryOrder || (next.entryOrder === after.entryOrder && next.lid > after.lid))
    ) {
      throw new Error('本文の読み出しが進みません(カーソルが前進していません)');
    }
    after = next;
  }
  if (notes.length === 0) throw new Error('書き出せるノートが 1 件もありません');

  const outside = linkTargets.filter((lid) => !exportedLids.has(lid)).length;
  if (outside > 0) {
    warnings.push(`このパッケージに入っていないノートへのリンク ${outside} 件は、押せない字だけになります`);
  }
  warnings.push(...openedAsSourceNotices(opened));
  const assetRows = allAssets.filter((a) => used.has(a.key));
  const skipped = allAssets.length - assetRows.length;
  if (skipped > 0) warnings.push(`どの本文からも参照されていない添付 ${skipped} 件は含めませんでした`);

  // ── 添付(生ファイル)と、ウィジェットのための小さな添付の読み込み用 script
  const assets: SiteAssetMeta[] = [];
  const blobOf = new Map<string, Blob>();
  let inlineCount = 0;
  for (const a of assetRows) {
    const blob = await src.getAssetBlob(a.key);
    if (!blob) {
      warn.add('missing-asset', '中身の見つからない添付', `添付の中身が見つかりませんでした: ${a.key}`);
      continue;
    }
    const idx = assets.length;
    const name = nameOf.get(a.key) ?? '';
    const mime = a.mime ?? 'application/octet-stream';
    const kind = assetPreviewKind(mime, name);
    const path = siteAssetFileName(idx, name, a.key);
    // 🔑 Blob をそのまま渡す(コピーしない)
    await zip.add(path, [blob]);
    const meta: SiteAssetMeta = {
      key: a.key,
      name: name !== '' ? name : a.key,
      mime,
      size: blob.size,
      ...(kind ? { kind } : {}),
      path,
    };
    if (widgetAssets.has(a.key) && blob.size <= SITE_INLINE_ASSET_MAX_BYTES) {
      const inline = `data/asset-${idx}.js`;
      const parts: Array<string | Blob> = [`window.${SITE_ASSET_CALLBACK}(${j(a.key)},"`];
      // ⚠ 1 チャンクずつ Blob にする(文字列で積むと heap に常駐する ── 閲覧用 HTML と同じ規律)
      for await (const p of base64Chunks(blob)) parts.push(new Blob([p]));
      parts.push('");\n');
      await zip.add(inline, parts);
      meta.inline = inline;
      inlineCount++;
    }
    assets.push(meta);
    if (isToolAsset(a.mime ?? undefined, name)) blobOf.set(a.key, blob);
  }

  // ── 同梱するツール(HTML の添付)。単体の 1 枚(`buildStandaloneWidgetHtml`)にして置く
  const tools: SiteToolMeta[] = [];
  const toolFiles = new Set<string>();
  const theme: WidgetTheme = opts.toolTheme ?? { tone: 'light', tokens: {} };
  for (const key of toolCandidates) {
    if (tools.some((t) => t.name === key) || !blobOf.has(key)) continue;
    const blob = blobOf.get(key)!;
    const assetName = nameOf.get(key) ?? key;
    if (blob.size > TOOL_MAX_BYTES) {
      warnings.push(`HTML の添付「${assetName}」は大きすぎるので、ツールにせず添付のまま入れました`);
      continue;
    }
    const n = tools.length;
    const frameId = `${SITE_TOOL_FRAME_PREFIX}${n}`;
    // ⚠ ぶつかりは大文字小文字を区別せずに見る(Windows / mac で展開すると `A.html` と `a.html` は同じファイル)
    let file = `tools/${widgetExportFileName({ assetName })}`;
    for (let k = 2; toolFiles.has(file.toLowerCase()); k++) {
      file = `tools/${widgetExportFileName({ assetName: `${assetName.replace(/\.x?html?$/i, '')}-${k}` })}`;
    }
    toolFiles.add(file.toLowerCase());
    const html = buildStandaloneWidgetHtml({
      content: await blob.text(),
      title: assetName.replace(/\.x?html?$/i, ''),
      widgetId: widgetIdFromFileName(assetName),
      seed: {},
      theme,
      frameId,
      allowExternalImages: opts.allowExternalImages === true,
      // 🔴 追加権限は引き継がない(既定の厳格な CSP)── `permissions` を渡さない
    });
    await zip.add(file, [html]);
    // ⚠ `name` は重複判定のために key を置き、表示名は別に持つ
    tools.push({ i: n, name: key, path: file, frameId });
  }
  const toolList = tools.map((t) => ({
    i: t.i,
    key: t.name,
    name: (nameOf.get(t.name) ?? t.name).replace(/\.x?html?$/i, ''),
    path: t.path,
    frameId: t.frameId,
  }));

  const manifest = {
    format: SITE_FORMAT,
    version: SITE_VERSION,
    title: src.title,
    exportedAt,
    notes,
    tools: toolList,
    assets,
  };
  await zip.add('manifest.js', [`window.${SITE_MANIFEST_VAR}=${j(manifest)};\n`]);
  await zip.add(
    'index.html',
    [
      siteIndexHtml(
        src.title,
        opts.pageFormat ?? DEFAULT_PAGE_FORMAT,
        opts.proseAlign ?? DEFAULT_PROSE_ALIGN,
        opts.allowExternalImages === true,
      ),
    ],
  );
  warn.finish();
  return {
    blob: new Blob([zip.finish()], { type: 'application/zip' }),
    warnings,
    counts: { entries: notes.length, assets: assets.length, tools: tools.length, inlineAssets: inlineCount },
  };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * 軽量シェル(`index.html`)。データは持たない(`manifest.js` と `data/*.js` を読む)。
 * ⚠ ここは template literal の中 ── バックティックを書かない。閲覧側の JS は ES5。
 */
export function siteIndexHtml(
  title: string,
  pageFormat: PageFormat,
  proseAlign: ProseAlign,
  allowExternalImages: boolean = false,
): string {
  const name = title.trim() === '' ? 'PKC3' : title.trim();
  /**
   * 🔴 **シェル自身の CSP**(外への通信を開けない)。読めるのは同じ場所(展開した先)の物だけ。
   * ⚠ 外部の画像は、書き出した人の設定が「常にオン」で焼いたときだけ許す(閲覧用 HTML と同じ規則)。
   */
  const img = allowExternalImages ? "'self' data: blob: https:" : "'self' data: blob:";
  const csp =
    `default-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; ` +
    `img-src ${img}; media-src 'self' data: blob:; object-src 'self' blob:; frame-src 'self'; ` +
    `connect-src 'self' data: blob:; base-uri 'none'; form-action 'none'`;
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>${escapeHtml(name)}</title>
<style>
:root{color-scheme:light dark;--bg:var(--surface);--font:system-ui,sans-serif}
html,body{height:100%}
body{margin:0;font:14px/1.6 system-ui,sans-serif;background:var(--surface-2,#f0f1f3);color:var(--fg,#16191d);
  display:grid;grid-template-rows:auto minmax(0,1fr);grid-template-columns:260px minmax(0,1fr)}
header{grid-column:1/-1;display:flex;align-items:center;gap:8px;padding:6px 12px;background:var(--surface,#fff);
  border-bottom:1px solid var(--hairline,#8883)}
header h1{flex:1 1 auto;min-width:0;margin:0;font-size:15px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
button{font:inherit;color:inherit}
.btn{padding:3px 10px;border:1px solid var(--border,#8886);border-radius:6px;background:var(--surface,#fff);cursor:pointer;font-size:12px}
.btn:hover{background:var(--surface-2,#8881)}
.btn:focus-visible,#pkc-q:focus-visible,nav li button:focus-visible,.tab button:focus-visible{outline:2px solid var(--accent,#14663c);outline-offset:1px}
#pkc-side{overflow:auto;padding:8px;background:var(--surface-2,#f0f1f3);border-right:1px solid var(--hairline,#8883)}
#pkc-q{width:100%;box-sizing:border-box;padding:5px 8px;border:1px solid var(--border,#8886);border-radius:6px;
  background:var(--surface,#fff);color:inherit;font:inherit}
#pkc-side h2{font-size:12px;font-weight:600;opacity:.75;margin:12px 4px 4px}
nav ul{list-style:none;margin:0;padding:0}
nav li button{display:block;width:100%;text-align:left;padding:4px 8px;border:0;border-left:3px solid transparent;
  background:transparent;cursor:pointer;border-radius:0 6px 6px 0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
nav li button:hover{background:var(--surface-hover,#8882)}
nav li button[aria-current=true]{border-left-color:var(--accent,#14663c);font-weight:600}
nav li small{display:block;opacity:.65;font-size:11px;white-space:normal}
#pkc-empty{opacity:.7;font-size:12px;margin:6px 4px}
main{display:grid;grid-template-rows:auto minmax(0,1fr);min-width:0;min-height:0}
#pkc-tabs{display:flex;gap:2px;overflow-x:auto;padding:4px 8px 0;background:var(--surface-2,#f0f1f3);border-bottom:1px solid var(--hairline,#8883)}
.tab{display:flex;align-items:center;max-width:16rem;border-radius:6px 6px 0 0;background:transparent}
.tab[aria-selected=true]{background:var(--surface,#fff);box-shadow:inset 0 2px 0 var(--accent,#14663c)}
.tab .t{border:0;background:transparent;padding:5px 6px 5px 10px;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tab[aria-selected=true] .t{font-weight:600}
.tab .x{border:0;background:transparent;padding:2px 8px;cursor:pointer;opacity:.6;font-size:14px;line-height:1}
.tab .x:hover{opacity:1}
#pkc-panels{overflow:auto;background:var(--surface,#fff);min-height:0}
.panel{padding:20px 28px}
/* ⚠ !important が要る ── .panel.tool{display:flex} と詳細度が同じで後に来るので、無いと隠したツールのパネルが手順書の下に出る(実ブラウザで実測) */
.panel[hidden]{display:none!important}
.panel h2.nt{margin:0 0 14px}
.panel.tool{padding:0;display:flex;flex-direction:column;height:100%}
.toolbar{display:flex;gap:8px;align-items:center;padding:6px 10px;border-bottom:1px solid var(--hairline,#8883)}
.toolbar .nm{flex:1 1 auto;font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.toolbar a{font-size:12px;color:inherit}
.panel.tool iframe{display:block;width:100%;flex:1 1 auto;min-height:calc(100vh - 140px);border:0;background:var(--surface,#fff)}
#pkc-welcome{padding:28px;opacity:.8}
img{max-width:100%;height:auto}
a[data-pkc-img-open]{cursor:zoom-in;display:block;width:fit-content;max-width:100%}
.b>*:first-child{margin-top:0}
.b p,.b ul,.b ol{margin:0 0 1em}
.b li{margin:.2em 0}
.b pre{white-space:pre-wrap;word-break:break-word;margin:0 0 1em}
.b blockquote{opacity:.85}
.b hr{margin:1.5em 0}
.b pre.d{font-size:.9em;opacity:.85}
.b [data-pkc-figure-baked] img{max-width:100%;height:auto}
.b [data-pkc-asset-missing]{opacity:.75}
.b [data-pkc-outside-note]{opacity:.6;text-decoration:underline dotted}
.b [data-pkc-title-ref][role=link]{text-decoration:underline;cursor:pointer}
.b>*{max-width:100%}
a.f{display:inline-block;margin:8px 0;padding:6px 10px;border:1px solid #8884;border-radius:6px;color:inherit;text-decoration:none}
p.m3{margin:8px 0 0;opacity:.8;font-size:.9em}
object.p{display:block;width:100%;height:calc(100vh - 14rem);min-height:320px;border:1px solid #8884;border-radius:6px;margin:8px 0}
#pkc-fail{display:block;margin:24px;white-space:pre-wrap}
@media screen and (max-width:${PHONE_MAX_PX}px){
  body{grid-template-columns:minmax(0,1fr);grid-template-rows:auto auto minmax(0,1fr)}
  #pkc-side{max-height:40vh;border-right:0;border-bottom:1px solid var(--hairline,#8883)}
  #pkc-side[data-collapsed=true]{display:none}
  .panel{padding:14px}
}
@media screen and (min-width:${PHONE_MAX_PX + 1}px){#pkc-side-toggle{display:none}}
@media print{
  :root{color-scheme:light}
  body{display:block;height:auto;background:#fff}
  header,#pkc-side,#pkc-tabs,.toolbar,.panel[hidden],.panel.tool{display:none!important}
  #pkc-panels{overflow:visible}
  .panel{padding:0}
  .b a{text-decoration:none}
  .b .pkc-render-toggle{display:none}
}
${pageFormatCss(pageFormat, null)}
${proseAlignCss(proseAlign)}
${portableWidgetBridgeCss()}
${BODY_CSS}
${toneOverrideCss(BODY_CSS)}
.b a.f{color:inherit}
.b .pkc-render-toggle{right:2px}
</style>
</head>
<body data-pkc-page-format="${pageFormat}" data-pkc-prose-align="${proseAlign}">
<header>
  <button id="pkc-side-toggle" class="btn" type="button" aria-controls="pkc-side" aria-expanded="true">一覧</button>
  <h1 id="pkc-t">${escapeHtml(name)}</h1>
  <button id="pkc-tone" class="btn" type="button" data-pkc-field="site-tone" title="配色を切り替えます(OS に合わせる → ライト → ダーク)">配色: OS に合わせる</button>
  <button id="pkc-print" class="btn" type="button" data-pkc-field="site-print" title="いま開いているノートを印刷します">印刷</button>
</header>
<nav id="pkc-side" aria-label="ノートとツール">
  <input id="pkc-q" type="search" placeholder="ノートを検索(題名・見出し・タグ・本文の冒頭)" aria-label="ノートを検索" data-pkc-field="site-search" autocomplete="off">
  <h2 id="pkc-nh">ノート</h2>
  <ul id="pkc-notes" data-pkc-field="site-notes"></ul>
  <p id="pkc-empty" hidden>当てはまるノートがありません</p>
  <div id="pkc-toolbox" hidden><h2 id="pkc-th">ツール</h2><ul id="pkc-tools" data-pkc-field="site-tools"></ul></div>
</nav>
<main>
  <div id="pkc-tabs" role="tablist" aria-label="開いているタブ" data-pkc-field="site-tabs"></div>
  <div id="pkc-panels"><p id="pkc-welcome">左の一覧からノートまたはツールを選ぶと、タブで開きます。</p></div>
</main>
<noscript><p id="pkc-fail">このページは JavaScript で中身を表示します。有効にして開き直してください。</p></noscript>
<script src="./manifest.js"></script>
<script>
(function(){
'use strict';
function fail(msg){
  var p=document.createElement('p');p.id='pkc-fail';
  p.textContent='このページを表示できませんでした: '+msg+'\\nzip をすべて展開してから index.html を開いてください。';
  document.body.textContent='';document.body.appendChild(p);
}
var d=window.${SITE_MANIFEST_VAR};
if(!d||!d.notes){fail('ノートの一覧(manifest.js)が見つかりません');return;}
try{
  document.title=d.title||'PKC3';
  var mimes={},names={},kinds={},paths={},inlines={},sizes={};
  d.assets.forEach(function(a){
    mimes[a.key]=a.mime||'application/octet-stream';
    names[a.key]=a.name||a.key;
    if(a.kind)kinds[a.key]=a.kind;
    paths[a.key]=a.path;sizes[a.key]=typeof a.size==='number'?a.size:0;
    if(a.inline)inlines[a.key]=a.inline;
  });
  var has=function(k){return Object.prototype.hasOwnProperty.call(paths,k)};
  /* 🔑 添付は展開した先の生ファイル(相対パス)── ObjectURL を作らないので手放す物も無い */
  /* 🔴 zip の中の置き場所を相対 URL にする(名前の部分は encodeURIComponent ── # や % を含む名前でも別のファイルを指さない)。
     添付(assets/)とツール(tools/)で同じ 1 本を使う */
  function relUrl(p){
    var i=p.indexOf('/');
    return './'+p.slice(0,i+1)+encodeURIComponent(p.slice(i+1));
  }
  function urlFor(key,sink){return relUrl(paths[key]||'')}
  var httpServed=String(location.protocol).indexOf('http')===0;
  function release(){}
  /* ── 動的 script で読む(ローカルで直に開いても CORS に掛からない)。読んだら外す */
  function loadScript(src){
    return new Promise(function(res,rej){
      var s=document.createElement('script');s.src=src;s.async=true;
      s.onload=function(){if(s.parentNode)s.parentNode.removeChild(s);res()};
      s.onerror=function(){if(s.parentNode)s.parentNode.removeChild(s);rej(new Error('読み込めませんでした: '+src))};
      document.head.appendChild(s);
    });
  }
  var noteWait={};
  window.${SITE_NOTE_CALLBACK}=function(i,p){var w=noteWait[i];if(w){delete noteWait[i];w(p)}};
  function loadNote(i){
    return new Promise(function(res,rej){
      noteWait[i]=res;
      loadScript('./data/note-'+i+'.js').then(function(){
        if(noteWait[i]){delete noteWait[i];rej(new Error('ノートの中身が空でした'))}
      },function(e){delete noteWait[i];rej(e)});
    });
  }
  var assetWait={};
  window.${SITE_ASSET_CALLBACK}=function(k,b64){var w=assetWait[k];if(w){delete assetWait[k];w(b64)}};
  /* 🔴 ウィジェットの「このノートの添付から選ぶ」── data/asset-n.js があればそれを、無ければ fetch(http(s) で配ったとき)を試す */
  function assetBytes(k){
    if(!has(k))return Promise.resolve(null);
    if(inlines[k]){
      return new Promise(function(res){
        assetWait[k]=function(b64){
          var b=atob(b64),u=new Uint8Array(b.length);
          for(var i=0;i<b.length;i++)u[i]=b.charCodeAt(i);
          b64=null;b=null;res(u.buffer);
        };
        loadScript('./'+inlines[k]).then(function(){if(assetWait[k]){delete assetWait[k];res(null)}},function(){delete assetWait[k];res(null)});
      });
    }
    /* ⚠ http(s) で配ったときだけ fetch を試す(ローカルで直に開いたときは CORS で止まるので試さない) */
    if(typeof fetch!=='function'||!httpServed)return Promise.resolve(null);
    return fetch(urlFor(k)).then(function(r){return r.ok?r.arrayBuffer():null},function(){return null});
  }

  var notesEl=document.getElementById('pkc-notes'),toolsEl=document.getElementById('pkc-tools');
  var tabsEl=document.getElementById('pkc-tabs'),panelsEl=document.getElementById('pkc-panels');
  var welcome=document.getElementById('pkc-welcome');
  var noteAt={},titleAt={},noteBtns=[],toolBtns=[];
  d.notes.forEach(function(n){
    if(n.${LID})noteAt[n.${LID}]=n.i;
    if(n.title&&!Object.prototype.hasOwnProperty.call(titleAt,n.title))titleAt[n.title]=n.i;
  });
  function eiOf(e){return e&&typeof e.i==='number'?e.i:-1}
  function titleOfAt(at){var n=d.notes[at];return n?n.title:''}

  /* ── タブ。⚠ 閉じないかぎりパネルの DOM を持ち続ける(ツールの入力・作業途中を消さない) */
  var tabs=[],active=null,seqT=0;
  function tabOf(kind,i){for(var k=0;k<tabs.length;k++)if(tabs[k].kind===kind&&tabs[k].i===i)return tabs[k];return null}
  function payloadOfFrame(f){
    var b=f&&f.closest?f.closest('[data-pkc-ei]'):null;if(!b)return null;
    var t=tabOf('note',Number(b.getAttribute('data-pkc-ei')));return t?t.payload:null;
  }
  function frameAssets(f){
    var e=payloadOfFrame(f),out=[],sn={};if(!e)return out;
    (e.attach||[]).concat(e.refs||[]).forEach(function(k){
      if(sn[k]||!has(k))return;sn[k]=1;
      /* ⚠ ローカルで直に開いたときは、data/asset-n.js の在る添付だけを候補にする(無い物は読めない ── 選んでから失敗させない) */
      if(!httpServed&&!inlines[k])return;
      out.push({key:k,name:names[k]||k,mime:mimes[k]||'application/octet-stream',size:sizes[k]||0});
    });
    return out;
  }
  /* 🔴 ツールのタブ(data-pkc-ei の外)はどのノートのデータも読めない ── 答えは空、添付の候補も空 */
  var hooks={getFrameContext:function(f){var e=payloadOfFrame(f);return e&&e.ctx?e.ctx:null},
    getFrameAssets:frameAssets,readAssetBytes:assetBytes};
  var bridge=${buildPortableWidgetBridgeScript({ hooks: 'hooks' })};
  ${portableHydrateJs()}

  function markCurrent(){
    noteBtns.forEach(function(b,i){var t=active&&active.kind==='note'&&active.i===i;b.setAttribute('aria-current',t?'true':'false')});
    toolBtns.forEach(function(b,i){var t=active&&active.kind==='tool'&&active.i===i;b.setAttribute('aria-current',t?'true':'false')});
  }
  function activate(t){
    active=t;
    tabs.forEach(function(x){
      var on=x===t;x.panel.hidden=!on;
      x.el.setAttribute('aria-selected',on?'true':'false');x.btn.tabIndex=on?0:-1;
    });
    welcome.hidden=tabs.length>0;
    markCurrent();
    if(t&&t.el.scrollIntoView)try{t.el.scrollIntoView({block:'nearest',inline:'nearest'})}catch(_e){}
  }
  function closeTab(t){
    var k=tabs.indexOf(t);if(k<0)return;
    tabs.splice(k,1);
    if(t.panel.parentNode)t.panel.parentNode.removeChild(t.panel);
    if(t.el.parentNode)t.el.parentNode.removeChild(t.el);
    t.payload=null;
    /* 🔴 閉じた箱の確認バーと預かった bytes を手放す */
    bridge.sweep();
    if(active===t)activate(tabs[Math.min(k,tabs.length-1)]||null);
    else activate(active);
  }
  function makeTab(kind,i,label){
    seqT++;
    var el=document.createElement('div');el.className='tab';el.setAttribute('role','presentation');
    el.setAttribute('data-pkc-tab-kind',kind);el.setAttribute('data-pkc-tab-index',String(i));
    var b=document.createElement('button');b.type='button';b.className='t';b.setAttribute('role','tab');
    b.id='pkc-tab-'+seqT;b.textContent=label;b.title=label;
    var x=document.createElement('button');x.type='button';x.className='x';x.textContent='\\u00d7';
    x.title='このタブを閉じます';x.setAttribute('aria-label','「'+label+'」のタブを閉じる');x.setAttribute('data-pkc-field','site-tab-close');
    el.appendChild(b);el.appendChild(x);tabsEl.appendChild(el);
    var panel=document.createElement('section');panel.className='panel'+(kind==='tool'?' tool':'');
    panel.setAttribute('role','tabpanel');panel.setAttribute('aria-labelledby',b.id);
    panel.setAttribute('data-pkc-panel-kind',kind);
    panelsEl.appendChild(panel);
    var t={kind:kind,i:i,el:el,btn:b,panel:panel,payload:null};
    b.onclick=function(){activate(t)};
    x.onclick=function(ev){ev.stopPropagation();closeTab(t)};
    el.addEventListener('auxclick',function(ev){if(ev.button===1){ev.preventDefault();closeTab(t)}});
    tabs.push(t);
    return t;
  }
  function scrollToHeading(box,hid){
    if(!hid)return;
    var want=hid;try{want=decodeURIComponent(hid)}catch(_x){}
    var hl=box.querySelectorAll('h1,h2,h3,h4,h5,h6');
    for(var k=0;k<hl.length;k++){if(hl[k].id===want){hl[k].scrollIntoView();break}}
  }
  /* 🔴 ノートを開く道はこの 1 本(一覧・本文のリンク・札・[[題名]])。開いていればそのタブへ切り替える */
  function go(at,hid){
    var n=d.notes[at];if(!n)return;
    var t=tabOf('note',at);
    if(t){activate(t);if(t.box)scrollToHeading(t.box,hid||'');return}
    t=makeTab('note',at,n.title||'(無題)');
    var h=document.createElement('h2');h.className='nt';h.textContent=n.title||'(無題)';
    var box=document.createElement('div');box.className='b pkc-md-rendered';
    box.setAttribute('data-pkc-field','detail-body');box.setAttribute('data-pkc-prose','');
    box.textContent='読み込んでいます…';
    t.panel.appendChild(h);t.panel.appendChild(box);t.box=box;
    activate(t);
    loadNote(at).then(function(p){
      if(tabs.indexOf(t)<0)return;
      p.i=at;t.payload=p;box.textContent='';
      hydrate(box,p,[],'');
      /* 🔑 この添付ノートの HTML が同梱のツールなら、ツールとしてタブで開くボタンを先頭に置く */
      (d.tools||[]).forEach(function(tl){
        if((p.attach||[]).indexOf(tl.key)<0)return;
        var ob=document.createElement('button');ob.type='button';ob.className='btn';
        ob.textContent='ツールとして開く: '+tl.name;ob.setAttribute('data-pkc-field','site-open-tool');
        ob.onclick=function(){openTool(tl.i)};
        box.insertBefore(ob,box.firstChild);
      });
      panelsEl.scrollTop=0;
      scrollToHeading(box,hid||'');
    },function(err){
      box.textContent='このノートを読み込めませんでした('+(err&&err.message?err.message:String(err))+')。zip をすべて展開したか確かめてください。';
    });
  }
  function openTool(i){
    var tl=d.tools[i];if(!tl)return;
    var t=tabOf('tool',i);
    if(t){activate(t);return}
    t=makeTab('tool',i,tl.name);
    var bar=document.createElement('div');bar.className='toolbar';
    var nm=document.createElement('span');nm.className='nm';nm.textContent=tl.name;
    var re=document.createElement('button');re.type='button';re.className='btn';re.textContent='再読み込み';
    re.title='ツールを読み込み直します(入力中の内容は消えます)';re.setAttribute('data-pkc-field','site-tool-reload');
    var op=document.createElement('a');op.href=relUrl(tl.path);op.target='_blank';op.rel='noopener';
    op.textContent='別のタブで単独で開く';op.setAttribute('data-pkc-field','site-tool-open');
    bar.appendChild(nm);bar.appendChild(re);bar.appendChild(op);
    function makeFrame(){
      var f=document.createElement('iframe');
      f.setAttribute('data-pkc-html-render-id',tl.frameId);
      f.setAttribute('${WIDGET_FRAME_ATTR}','');
      f.setAttribute('sandbox','allow-scripts');
      f.setAttribute('referrerpolicy','no-referrer');
      f.title=tl.name;f.src=relUrl(tl.path);
      return f;
    }
    var f=makeFrame();
    /* 🔴 再読み込みは箱を作り直す ── 古い箱の確認バーだけを sweep で手放す(reset は他のノートの確認バーまで閉じる) */
    re.onclick=function(){var nf=makeFrame();t.panel.replaceChild(nf,f);f=nf;bridge.sweep()};
    t.panel.appendChild(bar);t.panel.appendChild(f);
    activate(t);
  }

  /* ── 一覧(ノート・ツール)と横断検索(manifest.js の軽い字だけを見る ── 本文は読まない) */
  var countEl=document.getElementById('pkc-nh');
  d.notes.forEach(function(n){
    var li=document.createElement('li');
    var b=document.createElement('button');b.type='button';b.textContent=n.title||'(無題)';b.title=n.title||'';
    b.setAttribute('data-pkc-note-index',String(n.i));
    b.onclick=function(){
      go(n.i,'');
      if(window.matchMedia&&window.matchMedia('(max-width:${PHONE_MAX_PX}px)').matches)setSide(false);
    };
    li.appendChild(b);notesEl.appendChild(li);noteBtns.push(b);
  });
  (d.tools||[]).forEach(function(tl){
    var li=document.createElement('li');
    var b=document.createElement('button');b.type='button';b.textContent=tl.name;b.title=tl.name;
    b.setAttribute('data-pkc-tool-index',String(tl.i));
    b.onclick=function(){openTool(tl.i)};
    li.appendChild(b);toolsEl.appendChild(li);toolBtns.push(b);
  });
  document.getElementById('pkc-toolbox').hidden=!(d.tools&&d.tools.length>0);
  var hay=d.notes.map(function(n){
    return [n.title||'',(n.headings||[]).join(' '),(n.tags||[]).join(' '),n.excerpt||''].join('\\n').toLowerCase();
  });
  function setCount(shown){countEl.textContent='ノート('+(shown===d.notes.length?d.notes.length+' 件':shown+' / '+d.notes.length+' 件')+')'}
  var q=document.getElementById('pkc-q'),emptyEl=document.getElementById('pkc-empty');
  function filter(){
    var words=String(q.value||'').toLowerCase().split(/\\s+/).filter(function(w){return w!==''});
    var shown=0;
    noteBtns.forEach(function(b,i){
      var ok=true;for(var k=0;k<words.length;k++){if(hay[i].indexOf(words[k])<0){ok=false;break}}
      b.parentNode.hidden=!ok;
      var sm=b.querySelector('small');if(sm)b.removeChild(sm);
      if(ok&&words.length>0){
        var n=d.notes[i],w=words[0],hit='';
        var hs=(n.headings||[]);for(var h=0;h<hs.length;h++){if(hs[h].toLowerCase().indexOf(w)>=0){hit=hs[h];break}}
        if(!hit&&n.excerpt){var at=n.excerpt.toLowerCase().indexOf(w);if(at>=0)hit=n.excerpt.slice(Math.max(0,at-20),at+40)}
        if(hit&&(n.title||'').toLowerCase().indexOf(w)<0){var s=document.createElement('small');s.textContent=hit;b.appendChild(s)}
      }
      if(ok)shown++;
    });
    emptyEl.hidden=shown>0;setCount(shown);
  }
  q.addEventListener('input',filter);
  q.addEventListener('keydown',function(ev){
    if(ev.key!=='Enter')return;
    for(var i=0;i<noteBtns.length;i++){if(!noteBtns[i].parentNode.hidden){noteBtns[i].click();break}}
  });
  setCount(d.notes.length);

  /* ── 配色(OS に合わせる → ライト → ダーク)。⚠ 箱の配色は親の見張り(MutationObserver)が配り直す */
  var toneBtn=document.getElementById('pkc-tone');
  var TONES=['','light','dark'],TONE_LABEL={'':'OS に合わせる',light:'ライト',dark:'ダーク'};
  var tone='';
  function applyTone(){
    if(tone==='')document.documentElement.removeAttribute('data-pkc-tone');
    else document.documentElement.setAttribute('data-pkc-tone',tone);
    toneBtn.textContent='配色: '+TONE_LABEL[tone];
  }
  toneBtn.onclick=function(){tone=TONES[(TONES.indexOf(tone)+1)%TONES.length];applyTone()};
  document.getElementById('pkc-print').onclick=function(){if(typeof window.print==='function')window.print()};

  /* ── スマホの幅では一覧を畳める */
  var side=document.getElementById('pkc-side'),sideBtn=document.getElementById('pkc-side-toggle');
  function setSide(open){side.setAttribute('data-collapsed',open?'false':'true');sideBtn.setAttribute('aria-expanded',open?'true':'false')}
  sideBtn.onclick=function(){setSide(side.getAttribute('data-collapsed')==='true')};

  /* ── タブバーのキーボード操作(左右で移る) */
  tabsEl.addEventListener('keydown',function(ev){
    if(ev.key!=='ArrowLeft'&&ev.key!=='ArrowRight')return;
    var k=tabs.indexOf(active);if(k<0)return;
    var nx=tabs[(k+(ev.key==='ArrowRight'?1:tabs.length-1))%tabs.length];
    ev.preventDefault();activate(nx);nx.btn.focus();
  });

  /* 🔴 ノートの中の #見出し・脚注へのリンクは、そのノートの本文の中で探す(複数のタブを開くと同じ id が document に並ぶ ──
     ブラウザ任せだと最初の 1 つ = 別のノートの隠れた見出しへ飛ぶ) */
  panelsEl.addEventListener('click',function(ev){
    var a=ev.target&&ev.target.closest?ev.target.closest('a[href^="#"]'):null;
    if(!a||a.hasAttribute('data-pkc-entry-ref'))return;
    var box=a.closest('.b');if(!box)return;
    var f=(a.getAttribute('href')||'').slice(1);if(f==='')return;
    var want=f;try{want=decodeURIComponent(f)}catch(_x){}
    var all=box.querySelectorAll('[id]'),hit=null;
    for(var k=0;k<all.length;k++){if(all[k].id===want||all[k].id===f){hit=all[k];break}}
    if(!hit)return;
    ev.preventDefault();hit.scrollIntoView();
  });

  window.__pkcSite={hooks:hooks,go:go,openTool:openTool,tabs:function(){return tabs.length},close:function(){if(active)closeTab(active)}};
  if(d.notes.length>0)go(0,'');
}catch(err){fail(err&&err.message?err.message:String(err))}
})();
</script>
</body>
</html>
`;
}
