/**
 * 🔴 **アプリをどこに出すか**(#884 段①、2026-09-13)。
 *
 * ## user が何を求めたか(こちらの解釈。user 要望 2026-09-13)
 *
 * アプリを押すと**別のブラウザタブ**で開く。アプリとして入れている(PWA)ときは、
 * **ブラウザ側で開く**か、**PKC の窓の仲間として別の窓で開く**かを**選びたい**。
 * 🟢 裁定は「**設定で**」── こちらで片方に固定せず、選べる形にする。
 *
 * ## ⚠ 変わるのは「窓の指定」1 つだけ
 *
 * | 選んだもの | `window.open` の 3 つ目 | 画面で起きること |
 * |---|---|---|
 * | **ブラウザのタブ**(既定) | 大きさを渡さない | いまと同じ ── タブが 1 枚増える |
 * | **別の窓** | `popup` と大きさを渡す | 独立した窓が 1 つ開く。⚠ アプリとして入れているときは、その窓が**PKC の仲間**として並ぶ(実機で確かめる ── #884 段③) |
 *
 * 🔴 **`noopener,noreferrer` は外さない。** 外部サイトを開く側に付いている
 *   この 2 つは **user への約束**である(`adapter/ui/launch-tile.ts` の注記)──
 *   大きさを足すときも、**足すだけ**で引かない。
 *
 * ⚠ **pure module**。`window` も保存も知らない(保存は
 *   `adapter/ui/render/app-open-target.ts`、使うのは `adapter/ui/launch-tile.ts`)。
 */

export interface AppOpenTargetSpec {
  readonly id: string;
  /** 設定画面に出る名前。⚠ ここを変えたらマニュアルも直す。 */
  readonly label: string;
}

/**
 * 選べる出し先。
 * ⚠ **並びは「既定が先」**(`features/open-place.ts` と同じ作法)── 1 つ目が既定で
 *   あることを、見ただけで分かるようにする。
 */
export const APP_OPEN_TARGETS = [
  { id: 'tab', label: 'ブラウザのタブ(既定)' },
  { id: 'window', label: '別の窓' },
] as const satisfies readonly AppOpenTargetSpec[];

export type AppOpenTarget = (typeof APP_OPEN_TARGETS)[number]['id'];

/**
 * 🔴 **既定はブラウザのタブ**(= いまの挙動)。
 *
 * ⚠ これは**こちらの推薦**であって user の指示ではない(#884 ⑤)──
 *   既に使っている人の手触りを、頼まれていないのに変えないため。
 *   新しい出し方は**選んだ人にだけ**効く。
 * ⚠ **これが分かったら覆る**:実機で「別の窓」のほうが明らかに扱いやすいと分かったとき、
 *   または user から「入れている人は最初から別の窓で」と指示があったとき。
 */
export const DEFAULT_APP_OPEN_TARGET: AppOpenTarget = 'tab';

export function isAppOpenTarget(v: string): v is AppOpenTarget {
  return APP_OPEN_TARGETS.some((t) => t.id === v);
}

/**
 * 別の窓のときの大きさ。
 *
 * ⚠ **画面より大きければブラウザが縮める**ので、上限を自前で計算しない
 *   (計算すると「小さい画面でだけ違う大きさ」という**面ごとの分岐**が生える)。
 * ⚠ この値は**見え方**である ── 変えるときは user に見せる。
 */
export const APP_WINDOW_SIZE = { width: 1100, height: 800 } as const;

/**
 * `window.open` の 3 つ目を組む。
 *
 * ⚠ **`base` を必ず残す**(`noopener,noreferrer` の約束)── 足すだけで引かない。
 * ⚠ `popup` を名乗るのは**大きさを渡すときだけ** ── タブのときに `popup` を
 *   渡すと、**選んでいないのに窓になる**。
 */
export function appWindowFeatures(target: AppOpenTarget, base: string): string {
  if (target !== 'window') return base;
  const size = `popup=yes,width=${String(APP_WINDOW_SIZE.width)},height=${String(APP_WINDOW_SIZE.height)}`;
  return base === '' ? size : `${base},${size}`;
}
