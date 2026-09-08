/**
 * 🔴 **本文の置き場所**(#722 P2-11 の続き。2026-09-08)。
 *
 * > user 指示 2026-08-28:「**正直変更はユーザーに委ねて欲しい**」
 * > user 裁定 2026-09-06(#722 P2-11):読み幅を列の**中央**に置く
 *
 * ## なぜ「戻す口」が要るのか
 *
 * 中央寄せを配ったあと、**戻す道が 1 つも無かった** ── 左寄せに戻すには紙面を
 * 「フル HD」(上限なし)にするしかなく、そうすると**読み幅の上限ごと外れる**。
 * つまり「**上限は欲しいが左寄せがよい**」人の行き場が無い。
 * 🔑 だから user が選べる形にする(2026-08-28「私が決めた見え方を配るより、
 *   user が変えられる設定を作る」)。⚠ **既定は中央 = いまのまま**なので、
 *   選ばなければ 1px も変わらない。
 *
 * ## ⚠ トークン 2 つで表す(規則を二重に書かない)
 *
 * 中央寄せは `app.css` の **2 か所**で成り立っている ──
 * ① 散文の塊の `margin-inline: auto` ② 表・図・コードの `margin-inline-start`。
 * 🔑 どちらも**トークンを 1 つずつ**読む形にしてあるので、ここは値を差し替えるだけ。
 * ⚠ `--prose-indent` の中の `100%` は**使う側の包含ブロック**で解決される
 *   (カスタムプロパティは字句のまま置換される)── だから `:root` に置ける。
 *
 * ## ⚠ ここは純関数だけ(features 層)
 *
 * 保存(localStorage)と DOM への適用は `adapter/ui/render/prose-align.ts`。
 * `page-format.ts` / `external-images.ts` と同じ分け方である。
 */

export interface ProseAlignSpec {
  readonly id: string;
  /** 設定画面に出る名前。⚠ ここを変えたらマニュアルも直す(`docs-parity`)。 */
  readonly label: string;
  /** 散文の塊の `margin-inline` の**始まり側**(`auto` = 中央)。 */
  readonly lead: string;
  /** 表・図・コードの `margin-inline-start`。 */
  readonly indent: string;
}

/**
 * 選べる置き場所。⚠ **id は `tokens.css` の `[data-pkc-prose-align='…']` と 1 対 1**。
 *
 * ⚠ `center` の値は**いまの規則そのまま**(既定を持ち込んでも見え方が変わらない)。
 * ⚠ `start` の `indent` を `0` ではなく `0px` にするのは、`margin-inline-start` が
 *   **単位なしの 0 でも通る**一方、突き合わせの test が値を字面で比べるためである
 *   (`0` と `0px` で割れると、片方だけ直す日が来る)。
 */
export const PROSE_ALIGNS = [
  {
    id: 'center',
    label: '中央(既定)',
    lead: 'auto',
    indent: 'max(0px, calc((100% - var(--read-w)) / 2))',
  },
  { id: 'start', label: '左', lead: '0', indent: '0px' },
] as const satisfies readonly ProseAlignSpec[];

export type ProseAlign = (typeof PROSE_ALIGNS)[number]['id'];

/** 既定は **中央**(user 裁定 2026-09-06)── 選ばなければ見え方は動かない。 */
export const DEFAULT_PROSE_ALIGN: ProseAlign = 'center';

/** 画面・書き出しの器に付ける印。⚠ CSS 側の綴りと 1 対 1。 */
export const PROSE_ALIGN_ATTR = 'data-pkc-prose-align';

const IDS: readonly string[] = PROSE_ALIGNS.map((a) => a.id);

export function isProseAlign(v: string): v is ProseAlign {
  return IDS.includes(v);
}

/** ⚠ 引き当てられない値では**既定へ落ちる**(壊れた設定で起動不能にしない)。 */
export function proseAlignSpec(align: string): ProseAlignSpec {
  return PROSE_ALIGNS.find((a) => a.id === align) ?? PROSE_ALIGNS[0];
}

/**
 * 書き出す HTML に焼く分。
 *
 * ⚠ **`:root` を前置きしない** ── 書き出した HTML では器(`<body>`)に印が付く。
 *   属性の付いた要素そのものに宣言が乗り、継承で配下へ届くので、
 *   焼き込みの `:root{--prose-lead:auto}` とは**別の要素**の話になる
 *   (`readWidthRule` と同じ作法 ── 順序も詳細度も争わない)。
 * ⚠ **既定でも空文字にしない** ── 空にすると「書き出したときの設定を焼く」という
 *   約束が既定の人だけ成り立たず、`:root` の値に**当たり前に**依存してしまう。
 *   焼いた側が正本である、を 1 通りに保つ。
 */
export function proseAlignCss(align: ProseAlign): string {
  const spec = proseAlignSpec(align);
  return `[${PROSE_ALIGN_ATTR}='${spec.id}']{--prose-lead:${spec.lead};--prose-indent:${spec.indent}}`;
}
