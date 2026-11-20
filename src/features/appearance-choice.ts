/**
 * 🔴 **見た目の好み 2 つ: アクセントの色 / 字体**(#1982 段 4)。
 *
 * - アクセント色 = 配色(`THEMES`)とは**独立に**、主の操作・フォーカスの色(`--accent` 系 4 トークン)だけを差し替える。
 *   値は `tokens.css` の `:root[data-pkc-tone='light|dark'][data-pkc-accent='…']`(明るい地向け / 暗い地向けの 2 組)が正本で、
 *   ここは **id と画面の字**だけを持つ。全配色 × 全アクセントのコントラストは `tests/adapter/accent-matrix.test.ts` が計算して落とす。
 *   `theme` = 配色どおり(属性を立てない)。
 * - 字体 = `--font` / `--font-mono` を `<html>` の style で差し替える(`app.css` は 1 行も分岐しない)。
 *   ⚠ **字体は同梱しない**(端末に入っているものを使い、無ければ次の候補へ落ちる)。
 *   書き出す HTML は既定のまま(端末に無い字体を相手の画面で指定しない)。
 *
 * 🔑 **pure module**。browser API を使わない(保存と DOM は adapter 側)。
 */

export type AccentChoice = 'theme' | 'green' | 'blue' | 'brown' | 'purple';

export interface AccentSpec {
  readonly id: AccentChoice;
  readonly label: string;
}

export const ACCENTS: readonly AccentSpec[] = [
  { id: 'theme', label: '配色どおり' },
  { id: 'green', label: '緑' },
  { id: 'blue', label: '青' },
  { id: 'brown', label: '茶' },
  { id: 'purple', label: '紫' },
] as const;

export const DEFAULT_ACCENT: AccentChoice = 'theme';

export function isAccentChoice(v: string): v is AccentChoice {
  return ACCENTS.some((a) => a.id === v);
}

export type FontChoice = 'standard' | 'biz-ud' | 'mincho' | 'mono';

export interface FontSpec {
  readonly id: FontChoice;
  readonly label: string;
  /** `--font`(画面の字)に入る値。 */
  readonly ui: string;
  /** `--font-mono`(コード・数値)に入る値。 */
  readonly mono: string;
}

const MONO_STACK = "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Noto Sans Mono', monospace";

/** ⚠ `standard` は `tokens.css` の既定そのまま(選ばなければ 1 バイトも変わらない)。 */
export const FONTS: readonly FontSpec[] = [
  {
    id: 'standard',
    label: '標準(OS の字体)',
    ui: "system-ui, -apple-system, 'Segoe UI', 'Hiragino Sans', 'Hiragino Kaku Gothic ProN', 'Noto Sans JP', 'Yu Gothic UI', Meiryo, sans-serif",
    mono: MONO_STACK,
  },
  {
    id: 'biz-ud',
    label: 'BIZ UD ゴシック',
    ui: "'BIZ UDGothic', 'BIZ UD Gothic', 'BIZ UDPGothic', 'Noto Sans JP', 'Hiragino Sans', 'Yu Gothic UI', Meiryo, sans-serif",
    mono: MONO_STACK,
  },
  {
    id: 'mincho',
    label: '明朝',
    ui: "'BIZ UDMincho', 'BIZ UD Mincho', 'Hiragino Mincho ProN', 'Yu Mincho', 'Noto Serif JP', 'MS PMincho', serif",
    mono: MONO_STACK,
  },
  {
    id: 'mono',
    label: '等幅',
    ui: "ui-monospace, SFMono-Regular, Menlo, Consolas, 'BIZ UDGothic', 'Noto Sans Mono', monospace",
    mono: MONO_STACK,
  },
] as const;

export const DEFAULT_FONT: FontChoice = 'standard';

export function isFontChoice(v: string): v is FontChoice {
  return FONTS.some((f) => f.id === v);
}

export function fontSpec(id: FontChoice): FontSpec {
  return FONTS.find((f) => f.id === id) ?? FONTS[0]!;
}
