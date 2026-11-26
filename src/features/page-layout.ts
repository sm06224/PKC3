/**
 * 🔴 **ノート単位のページ設定(組版)と、印刷レイアウト表示の紙の寸法**(v4.0 Phase 1 / PR-03。ビジョン 3-A)。
 *
 * ノートの前書き(frontmatter)に次のキーを書くと、そのノートだけ紙面・余白・段組み・字体を変えられる:
 *
 * | キー | 値 | 正本 |
 * |---|---|---|
 * | `page_format` | `a4-portrait` 等 | `page-format.ts` の `PAGE_FORMATS` |
 * | `page_margin` | `narrow` / `normal` / `wide` | `page-margin.ts` の `PAGE_MARGINS` |
 * | `page_columns` | `1`〜`4`(数でも字でもよい) | `read-columns.ts` の `READ_COLUMN_CHOICES` |
 * | `page_font` | `standard` / `biz-ud` / `mincho` / `mono` | `appearance-choice.ts` の `FONTS` |
 *
 * 🔑 **書いていないキー・読めない値はアプリの設定に従う**(黙って無視する)── 書いていないノートの見た目・
 *   印刷・書き出しは 1 バイトも変わらない。
 * 🔑 **片道を作らない** ── `writeNoteLayout` に `null` を渡すとキーごと消える(情報ペインの「アプリの設定に従う」)。
 *   最後のキーを消すと、前書きの囲みごと畳まれる(`spliceFrontmatterKeys` の約束)。
 * ⚠ 値の表を**ここに写さない**(CLAUDE.md §7 の重複定義禁止)── 各正本の `is*` で検証する。
 * ⚠ **pure module**(browser API を使わない)。保存と DOM への適用は `adapter/ui/render/note-layout.ts`。
 */
import { FONTS, isFontChoice, type FontChoice } from './appearance-choice';
import { parseFrontmatter, spliceFrontmatterKeys, type FrontmatterValue } from './markdown/frontmatter';
import { isPageFormat, PAGE_FORMATS, pageFormatSpec, type PageFormat } from './page-format';
import { DEFAULT_PAGE_MARGIN, isPageMargin, PAGE_MARGINS, pageMarginSpec, type PageMargin } from './page-margin';
import { isReadColumns, READ_COLUMN_CHOICES, type ReadColumns } from './read-columns';
import { isReservedSyncLid } from './sync/sync-guard';

export {
  DEFAULT_PAGE_MARGIN,
  PAGE_MARGINS,
  isPageMargin,
  pageMarginSpec,
  type PageMargin,
  type PageMarginSpec,
} from './page-margin';

/**
 * 🔴 **ページ設定を出す・効かせるノートか**(1 か所の判定 ── reducer・情報ペイン・中央の本文が同じ関数を通る)。
 * user 領域の文書(フォルダ以外)だけ。system 領域(`sys-` で始まる lid・メッセージ集積地)は対象外。
 */
export function noteLayoutApplies(lid: string, archetype: string): boolean {
  return archetype !== 'folder' && !isReservedSyncLid(lid);
}

/** 前書きのキーの綴り。⚠ 画面・書き出し・test はここを引く(綴りを写さない)。 */
export const NOTE_LAYOUT_KEYS = {
  pageFormat: 'page_format',
  pageMargin: 'page_margin',
  pageColumns: 'page_columns',
  pageFont: 'page_font',
} as const;

export type NoteLayoutField = keyof typeof NOTE_LAYOUT_KEYS;

/** 情報ペインに並べる順(紙面 → 余白 → 段組み → 字体)。 */
export const NOTE_LAYOUT_FIELDS: readonly NoteLayoutField[] = ['pageFormat', 'pageMargin', 'pageColumns', 'pageFont'];

/** ノートに書かれているページ設定。`null` = 書いていない(または読めない)= アプリの設定に従う。 */
export interface NoteLayoutSpec {
  readonly pageFormat: PageFormat | null;
  readonly pageMargin: PageMargin | null;
  readonly pageColumns: ReadColumns | null;
  readonly pageFont: FontChoice | null;
}

/** 書き換えの指示。⚠ 書かない field はそのまま、`null` はキーを消す。 */
export type NoteLayoutPatch = { readonly [K in NoteLayoutField]?: NoteLayoutSpec[K] };

export const EMPTY_NOTE_LAYOUT: NoteLayoutSpec = Object.freeze({
  pageFormat: null,
  pageMargin: null,
  pageColumns: null,
  pageFont: null,
});

/**
 * 前書きの値を字へ寄せる。⚠ `page_columns: 2` / `page_format: 43` は数として読まれるので、字に戻して検証する。
 * 配列・真偽値・null は読めない値(無視)。
 */
function scalarText(v: FrontmatterValue | undefined): string | null {
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

function pick<T extends string>(v: FrontmatterValue | undefined, ok: (s: string) => s is T): T | null {
  const s = scalarText(v);
  return s !== null && ok(s) ? s : null;
}

/**
 * 🔑 **前書きを読む前の早道**。4 つのキーはどれも `page_` で始まる ── 本文にこの字が 1 つも無ければ、
 *   前書きを解析しない(ノートを開くたび・描き直すたびに通るので)。
 */
const NOTE_LAYOUT_KEY_PREFIX = 'page_';

/**
 * 前書きからノートのページ設定を読む。
 * ⚠ 前書きが無い・壊れている・値が読めないときは、その項目を `null`(アプリの設定に従う)にする。投げない。
 */
export function readNoteLayout(body: string): NoteLayoutSpec {
  if (!body.includes(NOTE_LAYOUT_KEY_PREFIX)) return EMPTY_NOTE_LAYOUT;
  const meta = parseFrontmatter(body).meta;
  const spec: NoteLayoutSpec = {
    pageFormat: pick(meta[NOTE_LAYOUT_KEYS.pageFormat], isPageFormat),
    pageMargin: pick(meta[NOTE_LAYOUT_KEYS.pageMargin], isPageMargin),
    pageColumns: pick(meta[NOTE_LAYOUT_KEYS.pageColumns], isReadColumns),
    pageFont: pick(meta[NOTE_LAYOUT_KEYS.pageFont], isFontChoice),
  };
  return hasNoteLayout(spec) ? spec : EMPTY_NOTE_LAYOUT;
}

/** 1 つ以上ノート個別の指定があるか(「すべてアプリの設定に戻す」を押せるか)。 */
export function hasNoteLayout(spec: NoteLayoutSpec): boolean {
  return spec.pageFormat !== null || spec.pageMargin !== null || spec.pageColumns !== null || spec.pageFont !== null;
}

/**
 * 書き換えの指示を、前書きのキーの書き換え表へ直す(`spliceFrontmatterKeys` / `REQUEST_BODY_REWRITE` の
 * `kind: 'frontmatter'` が受ける形)。⚠ `null` は `undefined`(= キーを消す)、段数は数で書く。
 * 🔑 アプリの書き込み(reducer)と `writeNoteLayout` が**同じ表**を使う ── 書き方を 2 か所に置かない。
 */
export function noteLayoutKeys(patch: NoteLayoutPatch): Record<string, FrontmatterValue | undefined> {
  const out: Record<string, FrontmatterValue | undefined> = {};
  for (const field of NOTE_LAYOUT_FIELDS) {
    if (!(field in patch)) continue;
    const v = patch[field];
    const key = NOTE_LAYOUT_KEYS[field];
    if (v === null || v === undefined) out[key] = undefined;
    else out[key] = field === 'pageColumns' ? Number(v) : v;
  }
  return out;
}

/** 「すべてアプリの設定に戻す」の指示(4 つのキーを全部消す)。 */
export const CLEAR_NOTE_LAYOUT: NoteLayoutPatch = Object.freeze({
  pageFormat: null,
  pageMargin: null,
  pageColumns: null,
  pageFont: null,
});

/**
 * 本文の前書きのページ設定を書き換える。
 * ⚠ 指定したキーだけを足す / 書き換える / 消す ── 他のキー・本文・改行コードは 1 バイトも動かさない
 *   (`spliceFrontmatterKeys` の約束)。最後のキーを消すと前書きの囲みごと畳む。
 */
export function writeNoteLayout(body: string, patch: NoteLayoutPatch): string {
  const keys = noteLayoutKeys(patch);
  if (Object.keys(keys).length === 0) return body;
  return spliceFrontmatterKeys(body, keys);
}

/** アプリ全体の設定(この端末の見方)。 */
export interface AppLayoutSettings {
  readonly pageFormat: PageFormat;
  readonly readColumns: ReadColumns;
  readonly font: FontChoice;
}

/** ノートの指定とアプリの設定を重ねた、実際に効く値。 */
export interface EffectiveLayout {
  readonly pageFormat: PageFormat;
  /**
   * `@page` に載せる余白。⚠ **ノートに書いてあるときだけ**値を持つ(無ければ `null` = ブラウザの既定の余白)
   * ── アプリ全体には余白の設定が無いので、書いていないノートの印刷は従来どおり。
   */
  readonly pageMargin: PageMargin | null;
  /** 印刷レイアウト表示の紙の内側の余白(ノートに無ければ標準)。 */
  readonly sheetMargin: PageMargin;
  readonly readColumns: ReadColumns;
  readonly font: FontChoice;
}

/** ノートの指定を優先し、書いていない項目はアプリの設定へ落とす。 */
export function resolveEffectiveLayout(note: NoteLayoutSpec, app: AppLayoutSettings): EffectiveLayout {
  return {
    pageFormat: note.pageFormat ?? app.pageFormat,
    pageMargin: note.pageMargin,
    sheetMargin: note.pageMargin ?? DEFAULT_PAGE_MARGIN,
    readColumns: note.pageColumns ?? app.readColumns,
    font: note.pageFont ?? app.font,
  };
}

/** 印刷レイアウト表示の紙 1 枚の寸法。 */
export interface PaperSheetSpec {
  readonly width: string;
  readonly minHeight: string;
  /** 画面用のフォーマット(紙を持たない)なので A4 縦を紙の基準にしたか。 */
  readonly fallbackToA4: boolean;
}

/** 紙の mm(縦置き)。⚠ 紙の名前は `PAGE_FORMATS` の `paper`(`A4 portrait` 等)から引く ── 紙面の表を写さない。 */
const PAPER_MM: Readonly<Record<string, readonly [number, number]>> = {
  A4: [210, 297],
  A3: [297, 420],
};

/**
 * 印刷レイアウト表示で描く紙 1 枚の寸法。
 * ⚠ 画面用のフォーマット(フル HD / 4:3 ── 紙を持たない)は **A4 縦**を紙の基準にする(`fallbackToA4: true`)。
 */
export function paperSheetSpec(fmt: PageFormat): PaperSheetSpec {
  const paper = pageFormatSpec(fmt).paper;
  const [size, orient] = paper === null ? ['', ''] : paper.split(' ');
  const mm = size === undefined ? undefined : PAPER_MM[size];
  if (paper === null || mm === undefined) return { width: '210mm', minHeight: '297mm', fallbackToA4: true };
  const [short, long] = mm;
  return orient === 'landscape'
    ? { width: `${long}mm`, minHeight: `${short}mm`, fallbackToA4: false }
    : { width: `${short}mm`, minHeight: `${long}mm`, fallbackToA4: false };
}

/** 印刷レイアウト表示の紙の内側の余白(CSS の値)。 */
export function sheetPadding(margin: PageMargin): string {
  return pageMarginSpec(margin).css;
}

/**
 * 情報ペインの選択欄の値から、書き換えの指示を作る(`''` = 「アプリの設定に従う」= キーを消す)。
 * ⚠ 知らない項目・読めない値は `null`(何もしない)── 画面の値を検証せずに前書きへ書かない。
 */
export function noteLayoutPatchFor(field: string, value: string): NoteLayoutPatch | null {
  if (!(NOTE_LAYOUT_FIELDS as readonly string[]).includes(field)) return null;
  const f = field as NoteLayoutField;
  if (value === '') return { [f]: null };
  const ok =
    f === 'pageFormat' ? isPageFormat(value) : f === 'pageMargin' ? isPageMargin(value) : f === 'pageColumns' ? isReadColumns(value) : isFontChoice(value);
  return ok ? { [f]: value } : null;
}

/** 印刷レイアウト表示を切り替えたときの知らせ。 */
export function printLayoutToggledText(on: boolean): string {
  return on ? '印刷レイアウト表示にしました' : '通常表示に戻しました';
}

/** 情報ペインに出す項目の名前。 */
export const NOTE_LAYOUT_LABELS: Readonly<Record<NoteLayoutField, string>> = {
  pageFormat: '用紙',
  pageMargin: '余白',
  pageColumns: '段組み',
  pageFont: '字体',
};

/**
 * 項目ごとの選択肢(id と字)。⚠ 各正本の表をそのまま返す ── 選択肢を写さない(CLAUDE.md §7)。
 */
export function noteLayoutChoices(field: NoteLayoutField): ReadonlyArray<{ readonly id: string; readonly label: string }> {
  if (field === 'pageFormat') return PAGE_FORMATS;
  if (field === 'pageMargin') return PAGE_MARGINS;
  if (field === 'pageColumns') return READ_COLUMN_CHOICES;
  return FONTS;
}
