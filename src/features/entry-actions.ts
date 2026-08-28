/**
 * 🔴 **ノート 1 件に対してできること**(#426 段①)── **字の正本**。
 *
 * ## なぜ表に抜き出したか
 *
 * これらの操作は**情報ペイン**に在り、字は `inspector.ts` の中に**直書き**されていた。
 * ⚠ 右クリックのメニューにも同じ操作を出すので、**そこでもう一度書くと
 * 字の出どころが 2 つ**になる ── 次に文言を直した人は**片方だけ**直し、
 * 「情報ペインでは『書き出す』、右クリックでは『エクスポート』」が生まれる
 * (CLAUDE.md §7。この repo が何度も踏んでいる形)。
 *
 * 🔑 だから**字はここ 1 か所**。情報ペインも右クリックも、ここから引く。
 *
 * ## ⚠ ここに在るのは「右クリックにも出す物」だけである
 *
 * 情報ペインは**ほかにも操作を持つ**(`Word` / `PowerPoint` / `PDF` /
 * `フォルダを書き出す` / `外部の画像を取り込む` / `書き戻す`)。
 * ⚠ **それらは抜き出していない** ── 条件つきで畳む物が混ざっており、
 * 全部をここへ移すと**畳む判定まで持ち込む**ことになる(主題が 2 つになる)。
 * 🔑 右クリックに出す物が増えたら、そのときここへ足す。
 *
 * ⚠ **pure module**。browser API を持たない。
 */

/** 操作 1 つ。`action` は `data-pkc-action` の値と**同じ綴り**である。 */
export interface EntryAction {
  readonly action: string;
  readonly label: string;
}

/**
 * 🔴 **右クリックで出す順**。
 *
 * ⚠ **消す物をいちばん下**に置く ── 上から順に押していく人が、
 *   勢いで `削除` に当たらないため(危ない物を端に置くのは業務画面の作法)。
 * ⚠ 情報ペインの並びとは**別である** ── あちらは書き出し系がまとまっており、
 *   ここは「よく使う順」。🔑 **並びが違ってよい**のは、字が同じだからである。
 */
export const ENTRY_MENU_ACTIONS: readonly EntryAction[] = [
  { action: 'copy-entry-ref', label: '参照をコピー' },
  { action: 'copy-plain-markdown', label: '素の Markdown' },
  { action: 'export-entry', label: '書き出す' },
  /**
   * 🔴 **相手に渡せる 1 枚**(#491。user 報告 2026-08-27
   *   「右クリックで気づきましたが、**書き出しに閲覧配布用HTMLがないのは残念**ですね」)。
   *
   * ⚠ 隣の `書き出す` と**別の物**である ── あちらは取り込み直せる
   *   `.pkc3.zip`(PKC3 を持っている人にしか開けない)、こちらは
   *   **ブラウザで開くだけで読める片道の HTML** である。
   * 🔑 **字は設定画面の同名ボタンと揃えた**(`commands.ts` の `export-html`)──
   *   あちらは全部、こちらは 1 件。**同じ形の物に 2 つの呼び名を作らない**。
   */
  { action: 'export-entry-html', label: '閲覧用 HTML' },
  { action: 'show-history', label: '履歴' },
  { action: 'delete-entry', label: '削除' },
];

/** 綴り → 字。⚠ 情報ペインはこちらを引く(並びは向こうが決める)。 */
export const ENTRY_ACTION_LABELS: Readonly<Record<string, string>> = Object.fromEntries(
  ENTRY_MENU_ACTIONS.map((a) => [a.action, a.label]),
);
