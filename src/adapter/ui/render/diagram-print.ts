/**
 * 🔴 **紙に出すときの図の色**(#1163 依頼 232 / 349。Gemini の裁定:印刷するときだけ、図とグラフを明るい配色で描き直して紙に出す)。
 *
 * > 画面の物語:ダークの配色で「PDF で書き出す」を押した。本文は白い紙に濃い字で出るのに、図とグラフだけは
 * > 暗い地の四角のまま紙に出ていた(本文は紙の配色で刷っているので、図だけ揃っていなかった)。
 * > いまは刷る間だけ図を明るい配色で描き直して紙に出し、刷り終えたら画面の配色に戻す。
 *
 * ## なぜテーマの属性を書き換えないか
 *
 * `<html data-pkc-theme>` を `light` にすれば図は勝手に描き直されるが、**画面全体が刷っている間だけ明るくなる**
 * (印刷の画面の裏で点滅する)。画面の見え方は変えない約束なので、**図の描画器が読む配色だけ**をここで差し替える。
 *
 * ## 配色の出どころ
 *
 * `tokens.css` の `:root`(= 明るい配色の既定)と同じ 6 色。⚠ CSS を読まず定数で持つ(ダークの最中は CSS 変数が
 * ダークの値を返すので、読んでも明るい色は取れない)。ずれたら `tests/adapter/diagram-print.test.ts` が落ちる。
 *
 * ⚠ このモジュールは `mermaid-raster` を **型としてだけ**読む(値の import を足すと、配色を差す unit の mock が
 *   このモジュールの値まで欠く)。
 */
import type { DiagramPalette } from './mermaid-raster';

/** 図の鍵に入る配色の名前(`themeOf()` が返す `light` と同じ ── 画面が明るい配色のときの絵と、鍵が一致して使い回せる)。 */
export const PRINT_THEME = 'light';

/** `tokens.css` の `:root` の 6 色。 */
export const PRINT_PALETTE: DiagramPalette = {
  bg: '#ffffff',
  alt: '#f5f6f8',
  fg: '#16191d',
  line: '#59616b',
  border: '#cdd2d9',
  accent: '#14663c',
  dark: false,
};

let active = false;

/** 刷るために図を明るい配色で描いている間か。 */
export function printLightActive(): boolean {
  return active;
}

/** 立てる / 外す。⚠ 描き直しの引き金は呼び側が引く(`mermaid-hydrate.ts` の `renderDiagramsLightForPrint`)。 */
export function setPrintLight(on: boolean): void {
  active = on;
}
