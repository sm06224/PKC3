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
 * | **ブラウザのタブ** | 大きさを渡さない | いまと同じ ── タブが 1 枚増える |
 * | **別の窓**(既定) | `popup` と大きさを渡す | 独立した窓が 1 つ開く。⚠ アプリとして入れているときは、その窓が**PKC の仲間**として並ぶ(実機で確かめる ── #884 段③) |
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
  /** アプリとして入れていないと効かない出し先か(#884 段③)。⚠ 効かない選択肢を、効くように見せない。 */
  readonly needsInstalled?: boolean;
}

/**
 * 選べる出し先。
 * ⚠ **並びは「既定が先」**(`features/open-place.ts` と同じ作法)── 1 つ目が既定で
 *   あることを、見ただけで分かるようにする。
 */
export const APP_OPEN_TARGETS = [
  { id: 'window', label: '別のウィンドウ(既定)' },
  { id: 'tab', label: 'ブラウザのタブ' },
] as const satisfies readonly AppOpenTargetSpec[];

export type AppOpenTarget = (typeof APP_OPEN_TARGETS)[number]['id'];

/**
 * 🔴 **既定は別のウィンドウ**(#1442 段①。user 承認「Go」2026-11-23 ── CLAUDE.md §2-10
 * 「組み込みアプリの基本は別ウィンドウ」に合わせる。旧い既定は #884 のときのこちらの推薦の「ブラウザのタブ」)。
 *
 * ⚠ **選び直せる**(設定の「アプリの開き方」で「ブラウザのタブ」へ戻せる ── 片道にしない)。
 *   すでに選んである人の値は変えない(保存値が優先)。
 * ⚠ ポップアップが遮られたときの退避先は**左のペインのタブ**(`hasPaneHome` / `openInPane`)── 中央ではない。
 */
export const DEFAULT_APP_OPEN_TARGET: AppOpenTarget = 'window';

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

/**
 * 🔴 **アプリの開き方の選択肢のうち、いま効くものだけ**(#884 段③)。
 *
 * ⚠ 隠すのは**「アプリとして入れていないと効かない」選択肢だけ**(`needsInstalled`)。ブラウザで実際に効く
 *   「ブラウザのタブ」「別のウィンドウ」はブラウザで使う人にも出す ── 別のウィンドウは大きさを渡した
 *   `window.open` で、ブラウザでも独立したウィンドウとして開く。
 * ⚠ いま選んである値は、隠す側でも**必ず出す**(選んだ値を自分で戻せない片道にしない)。
 * 🔑 いまのところ `needsInstalled` を持つ選択肢は無い(2 つとも効く)。#884 の本文(段①〜③)が求めた出し先は「ブラウザのタブ」と
 *   「PKC の窓の仲間(別のウィンドウ)」の **2 つだけ**で、アプリとして入れていないと効かない第 3 の出し先は書かれていない。入れていないと効かない出し先を足す日は、
 *   その行に `needsInstalled: true` を付けるだけで、設定の選択欄と右クリックの項目が同じ 1 本で絞られる。
 *
 * ⚠ pure。`installed` は `adapter/platform/installed-app.ts` が決める。
 */
export function appOpenOptions(
  installed: boolean,
  current: string,
  targets: readonly AppOpenTargetSpec[] = APP_OPEN_TARGETS,
): readonly AppOpenTargetSpec[] {
  return targets.filter((c) => !c.needsInstalled || installed || c.id === current);
}
