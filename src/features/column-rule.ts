/**
 * 🔴 **段の境界線の濃さ**(#525。user 報告 2026-08-28)。
 *
 * > 「**段組の境界線を見たい。今は境界がわかりにくい**」
 *
 * ## 実測 ── **基準を下回っていた**
 *
 * | | 実測 |
 * |---|---|
 * | 罫線の画素 | `205, 210, 217`(`--border` = `#cdd2d9`) |
 * | 地の画素 | `255, 255, 255` |
 * | **コントラスト** | 🔴 **1.52 : 1** |
 * | 文字以外の要素の下限(WCAG) | **3 : 1** |
 *
 * 🔴 そして**この線を守る検査は repo 全体で 0 件**だった(消しても何も鳴らない)。
 *
 * ## 🔑 なぜ「濃くする」ではなく「選べるようにする」か
 *
 * user 指示 2026-08-28(不可侵):
 * > 「**正直変更はユーザーに委ねて欲しい**」
 * > 🔑 **user が選べる形にできるなら、そちらを先に出す** ── 「私が決めた見え方」を
 * >    配るより「**user が変えられる設定**」を作るほうが、この裁定に沿う(#504)
 *
 * ⚠ **既定は `thin` = いまと 1 バイトも同じ**(`--border` そのまま)。
 *   選ばなければ見え方は変わらない ── #504(文字の大きさ)と同じ作法である。
 *
 * ## ⚠ `--border` を直接濃くしてはいけない
 *
 * この変数は `app.css` の **90 か所**で使われており、画面全体の 1px 境界も
 * 見出しの下線も同じものである。**段の罫線だけの色**を足すのが唯一安全な向き。
 *
 * 🔑 **pure module**。browser API を使わない(保存と DOM は adapter 側)。
 */

/** 境界線 1 つ。⚠ **値の正本はこの表 1 枚**(`app.css` に色を書かない)。 */
export interface ColumnRuleSpec {
  readonly id: ColumnRule;
  /** 設定画面に出す字。 */
  readonly label: string;
  /**
   * `column-rule` に入る値。
   * ⚠ **`none` は `0` ではなく `none`** ── 幅 0 の線を引くと、テーマによっては
   *   すき間の計算が 1px ずれる。
   */
  readonly rule: string;
}

export type ColumnRule = 'thin' | 'clear' | 'none';

/**
 * ⚠ **`thin` は現行そのまま**(`1px solid var(--border)`)── 既定を持ち込んでも
 *   見え方が 1 バイトも変わらない。
 *
 * 🔑 `clear` は **`--fg` を薄めた色**にする ── 新しい色を発明せず、
 *   すでにコントラストが pin されている前景色から作る(9 テーマぶんの表を作らない)。
 *   ⚠ `color-mix` は全テーマで同じ式が効くので、テーマごとの取りこぼしが出ない。
 */
export const COLUMN_RULES: readonly ColumnRuleSpec[] = [
  { id: 'thin', label: '細い(既定)', rule: '1px solid var(--border)' },
  { id: 'clear', label: 'はっきり', rule: '1px solid color-mix(in srgb, var(--fg) 45%, transparent)' },
  { id: 'none', label: '線なし', rule: 'none' },
] as const;

export const DEFAULT_COLUMN_RULE: ColumnRule = 'thin';

export function isColumnRule(v: unknown): v is ColumnRule {
  return typeof v === 'string' && COLUMN_RULES.some((s) => s.id === v);
}

/** 表から 1 つ引く。⚠ 知らない id は既定へ落ちる(呼び側で分岐させない)。 */
export function columnRuleSpec(id: ColumnRule): ColumnRuleSpec {
  return COLUMN_RULES.find((s) => s.id === id) ?? COLUMN_RULES[0]!;
}
