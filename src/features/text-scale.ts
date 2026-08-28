/**
 * 🔴 **文字の大きさ**(#504。user 指示 2026-08-28)。
 *
 * > 「**文字のサイズ小さくなったけど なんかしました?**」
 * > 「**正直変更はユーザーに委ねて欲しい**」
 *
 * ⚠ 実測すると、配った側に**縮める変更は 1 つも無かった**(直近の `font-size` の
 *   変更は #486 の `h4`〜`h6` を `1em` へ = **大きくする側**と、#481 のパレットの
 *   説明 `11px` だけ)。🔑 それでも直す所は在った ── **文字の大きさを user が
 *   変える設定が 1 つも無かった**。原因がこちらに無くても、user にできることが
 *   1 つも無いなら、そこが直す所である(`CLAUDE.md` の④)。
 *
 * ## ⚠ 既定は「いまと 1 バイトも同じ」
 *
 * `standard` の `13px` は `app.css` の `body { font-size: 13px }` **そのまま**。
 * 選ばなければ見え方は変わらない ── **見え方を勝手に変えない**が今回の裁定である。
 *
 * ## 🔑 なぜ `rem` ではなく `px` で、`html` ではなく `body` に当てるか
 *
 * 読み幅(`--read-w`)は **`rem`**(= `html` の大きさが基準)である
 * (`features/page-format.ts` の表)。だから:
 *
 * - `html` を動かすと**読み幅も一緒に動く** ── 文字を大きくすると**段も広がる**ので、
 *   1 行に入る字数が変わらない = 「大きくしたのに情報量が同じ」に見える
 * - `body` を動かすと**段の幅はそのまま、字だけ大きくなる** ── ブラウザの
 *   「文字の大きさ」と同じ挙動で、user の予想と合う
 *
 * 🔑 副産物として**図を焼き直さなくてよい** ── ラスタの鍵は**器の幅**を含むが
 * (不可侵指示 2026-08-03)、`--read-w` が `rem` のままなので器は 1px も動かない。
 *
 * ⚠ **自由入力にしない**(4 段だけ)── 版面と読み幅の規則が壊れる幅を選ばせない。
 *
 * 🔑 **pure module**。browser API を使わない(保存と DOM は adapter 側)。
 */

/** 文字の大きさ 1 つ。⚠ **値の正本はこの表 1 枚**(`app.css` に数字を書かない)。 */
export interface TextScaleSpec {
  readonly id: TextScale;
  /** 設定画面に出す字。 */
  readonly label: string;
  /** `body` の `font-size` に入る値。 */
  readonly size: string;
}

export type TextScale = 'small' | 'standard' | 'large' | 'xlarge';

/**
 * ⚠ **`standard` は現行の既定そのまま**(`13px`)── 既定を持ち込んでも
 *   見え方が変わらない(`page-format.ts` の A4 縦 42rem と同じ作法)。
 */
export const TEXT_SCALES: readonly TextScaleSpec[] = [
  { id: 'small', label: '小', size: '12px' },
  { id: 'standard', label: '標準', size: '13px' },
  { id: 'large', label: '大', size: '15px' },
  { id: 'xlarge', label: '特大', size: '17px' },
] as const;

export const DEFAULT_TEXT_SCALE: TextScale = 'standard';

export function isTextScale(v: unknown): v is TextScale {
  return typeof v === 'string' && TEXT_SCALES.some((s) => s.id === v);
}

/** 表から 1 つ引く。⚠ 知らない id は既定へ落ちる(呼び側で分岐させない)。 */
export function textScaleSpec(id: TextScale): TextScaleSpec {
  return TEXT_SCALES.find((s) => s.id === id) ?? TEXT_SCALES[1]!;
}
