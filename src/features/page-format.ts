/**
 * 紙面フォーマット(2026-08-08。user 裁定)。
 *
 * > 「**読み幅は A4 と A3、フル HD と 4:3 の縦横を選べるようにし、デフォは A4 縦、
 * > 任意設定可能にし画面での閲覧に適した形式を作ることも可能にしたい。PKC2 は
 * > A4 タテしかなくて、フル HD の画面で使いにくかった。**」
 *
 * 🔑 **フォーマット = 「散文の読み幅 R」+「印刷の紙の幾何(`@page`)」の組**である。
 * **器の幅では実装しない**(設計 doc `page-format-design-2026-08.md` §2)──
 * 器に上限を掛けると
 * ① 表・図・コードが全幅を使える今の作りが死ぬ(PKC2 の「フル HD で 41% しか
 *    使わない」に戻る)
 * ② 図のラスタ幅は器の親の `clientWidth` から決まるので、**全図が焼き直され
 *    キャッシュ鍵も変わる**。ブロック側の値を差し替えるだけなら図は 1 枚も動かない。
 *
 * ⚠ **ここは純関数だけ**(features 層)。保存(localStorage)と DOM への適用は
 *   `adapter/ui/render/page-format.ts` が持つ ── `features/markdown/external-images.ts`
 *   と `adapter/ui/render/external-images.ts` の分け方に揃えてある。
 * ⚠ **値の正本はこの表 1 枚**。画面側の `--read-w` の差し替えは `styles/tokens.css`
 *   にも同じ値が書いてあるので(CSS を JS から書かない)、
 *   `tests/features/page-format.test.ts` が**表と CSS を突き合わせる**
 *   (`theme.ts` と `tokens.css` を突き合わせている `docs-parity` と同じ作法)。
 */

export interface PageFormatSpec {
  readonly id: string;
  /** 設定画面に出る名前。⚠ ここを変えたらマニュアルも直す(`docs-parity`)。 */
  readonly label: string;
  /**
   * 散文の読み幅の上限(`--read-w` の値)。
   * ⚠ `none` = **上限なし** ── 「画面での閲覧に適した形式」の本体である。
   */
  readonly readWidth: string;
  /** 印刷の紙(`@page { size: … }` の値)。null = ブラウザの既定紙に任せる。 */
  readonly paper: string | null;
}

/**
 * 選べるフォーマット。⚠ **id は `tokens.css` の `[data-pkc-page-format='…']` と 1 対 1**。
 *
 * 値は「使って調整する」前提の初期値である(設計 doc §2 の表)。
 * A4 縦の 42rem は**現行の既定そのまま** ── 既定を持ち込んでも見え方が変わらない。
 */
export const PAGE_FORMATS = [
  { id: 'a4-portrait', label: 'A4 縦', readWidth: '42rem', paper: 'A4 portrait' },
  { id: 'a4-landscape', label: 'A4 横', readWidth: '62rem', paper: 'A4 landscape' },
  // A3 縦の紙幅(297mm)は A4 横と同じ ── だから読み幅も同じ値になる
  { id: 'a3-portrait', label: 'A3 縦', readWidth: '62rem', paper: 'A3 portrait' },
  { id: 'a3-landscape', label: 'A3 横', readWidth: '91rem', paper: 'A3 landscape' },
  { id: 'fullhd', label: 'フル HD(16:9 横)', readWidth: 'none', paper: null },
  { id: 'fullhd-portrait', label: 'フル HD 縦(9:16)', readWidth: '64rem', paper: null },
  { id: '43', label: '4:3 横', readWidth: '60rem', paper: null },
  { id: '43-portrait', label: '4:3 縦', readWidth: '45rem', paper: null },
] as const;

export type PageFormat = (typeof PAGE_FORMATS)[number]['id'];

/** 既定は **A4 縦**(user 裁定)。⚠ 現行の 42rem と同じなので、既存 user の見え方は動かない。 */
export const DEFAULT_PAGE_FORMAT: PageFormat = 'a4-portrait';

/** 画面・書き出しの器に付ける印。⚠ CSS 側の綴りと 1 対 1。 */
export const PAGE_FORMAT_ATTR = 'data-pkc-page-format';

const IDS: readonly string[] = PAGE_FORMATS.map((f) => f.id);

export function isPageFormat(v: string): v is PageFormat {
  return IDS.includes(v);
}

/** ⚠ 引き当てられない値では**既定へ落ちる**(壊れた設定で起動不能にしない)。 */
export function pageFormatSpec(fmt: string): PageFormatSpec {
  return PAGE_FORMATS.find((f) => f.id === fmt) ?? PAGE_FORMATS[0];
}

/**
 * 読み幅の差し替え規則。
 *
 * ⚠ **`:root` を前置きしない** ── 書き出した HTML では器(`<body>`)に印が付く。
 * 属性の付いた要素そのものに宣言が乗り、カスタムプロパティの継承で配下へ届くので、
 * 焼き込みの `:root{--read-w:42rem}` とは**別の要素**の話になる = 順序も詳細度も争わない。
 */
export function readWidthRule(fmt: PageFormat): string {
  return `[${PAGE_FORMAT_ATTR}='${fmt}']{--read-w:${pageFormatSpec(fmt).readWidth}}`;
}

/**
 * 紙の幾何。⚠ `@page` は**セレクタで絞れない**(文書に 1 つ)ので、
 * アプリ側は選んだ 1 つだけを `<style>` に載せ替える。画面用のフォーマットでは空文字
 * ── 空を返したときに**古い紙が残らない**ことは適用側の責務である。
 */
export function paperRule(fmt: PageFormat): string {
  const paper = pageFormatSpec(fmt).paper;
  return paper === null ? '' : `@page{size:${paper}}`;
}

/** 書き出す HTML に焼く分(読み幅 + 紙)。 */
export function pageFormatCss(fmt: PageFormat): string {
  return `${readWidthRule(fmt)}${paperRule(fmt)}`;
}
