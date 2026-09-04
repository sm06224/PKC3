#!/usr/bin/env node
/**
 * 🔴 **受け手 1 件ごとの「何を引数に取るか」**(#582 の R1)。
 *
 * ## なぜ要るか
 *
 * `docs/development/operation-model-2026-08.md` §4 の推薦
 * (「操作表は 1 つ。面はその射影」)は、§7 の条件①に懸かっている ──
 * **「画面上の点を指さないと始められない操作」が過半なら、床はパレットではなく
 * 右クリックへ倒すべき**である。⚠ 起票時のこの数は**目測**だった。
 *
 * 🔑 ここが出すのは**その全数仕分け**である。実測は **P1 = 40 / 183 = 22%**、
 *    つまり過半ではない ── 推薦は覆らない(doc §7.1)。
 *
 * ## 種別
 *
 * | | 何が要るか |
 * |---|---|
 * | `P1` | 同時に見えている兄弟のうち**押した 1 つ**(表のセル / 予定の日 / タグ / 履歴の行 …) |
 * | `P2` | 点を取るが、**state に「いまのそれ」が在る**(`selectedLid` / `dual.focus`) |
 * | `E`  | 閉じた選択肢を 1 つ(面 / 書式 / 設定値) |
 * | `V`  | 欄の値そのもの |
 * | `N`  | 押した所から何も要らない |
 *
 * ## ⚠ この表は**手で割り当てている**
 *
 * だから機械には**両方向**を見張らせる ── ①割り当て漏れ ②実在しない受け手。
 * 🔴 片方だけだと、綴り違いが**静かに `N` へ落ちる**(= 点を取る操作が
 * 「名前だけで呼べる」に数えられ、条件①の判定が甘くなる)。
 *
 * ⚠ **`target` を読んでいるかの機械判定では代われない**(2 度踏んだ):
 *   ① `menuCarriedLine(target)` のように**助っ人の向こう側**で読む形は、
 *      `target.` を探す走査に 1 件も当たらない(実測 25 件が隠れていた)
 *   ② 逆に `rename-attachment` / `toggle-app-tile` / `set-app-group` /
 *      `set-app-icon` は `target` を読むが、**対象は `selectedLid`(state)**で
 *      `target` からは入力欄の値しか読まない ── 属性の見た目だけで仕分けると
 *      P1 が 4 件多く出る
 *
 *   node scripts/action-scope-survey.mjs
 */
import { receivers } from './action-outlets.mjs';

/** 🔴 同時に見えている兄弟のうち「押した 1 つ」が要る ── 名前だけでは呼べない。 */
export const P1 = `edit-cell shape-cell toggle-task unschedule-task schedule-pick-day schedule-quick-here
toc-jump toggle-heading-fold append-at-heading edit-from-heading copy-md-block view-big export-diagram
remove-relation untag-entry smart-cond-remove filter-by-tag
download-asset view-asset open-office copy-asset-ref navigate-asset-ref revoke-same-origin revoke-extension
preview-revision restore-revision restore-trash stop-timer discard-timer open-alarm dismiss-alarm
open-tile deliver-to-extension navigate-entry-ref navigate-card-ref
dual-bookmark-open dual-bookmark-remove dual-tab-activate unsplit-entry dual-crumb`.split(/\s+/);

/** 点を取るが、state の現在値(`selectedLid` / `dual.focus`)で代替できる。 */
export const P2 = `select-entry delete-entry enter-folder toggle-todo move-entry move-order-up move-order-down
adopt-external-images write-back-file export-entry export-entry-pdf export-entry-docx export-entry-pptx
export-entry-html export-folder copy-entry-ref open-note-window dual-row dual-focus dual-tab-add dual-tab-close
dual-rename-begin dual-back dual-forward dual-bookmark dual-mkdir dual-mknote dual-copy dual-delete`
  .split(/\s+/);

/** 閉じた選択肢から 1 つ ── パレットには**値ごとに 1 行**出せる。 */
export const E = `set-view set-browse format-text create-entry pick-create-kind toggle-kind-filter dual-sort
schedule-nav toggle-pane set-theme set-paste-source set-external-images set-page-format set-editor-mode
set-text-scale set-read-columns set-column-rule set-tag-badge set-flag`.split(/\s+/);

/** 欄の値そのもの ── パレットからは「その欄へ連れて行く」形になる。 */
export const V = `smart-field set-open-in-edit set-alarm-enabled set-notices-enabled
rename-attachment toggle-app-tile set-app-group set-app-icon`.split(/\s+/);

/**
 * 受け手 → 種別を組む**素の関数**。⚠ 割り当て漏れ / 実在しない名前は**投げる**
 * (黙って `N` にしない)── 🔴 **この 2 つの門は test から直接叩ける形にしてある**。
 * 表を読むだけの `classify()` からは、門が鳴る場面を作れないためである(§2 未実行の経路)。
 */
export function assign(all, groups) {
  const out = new Map();
  for (const [cls, list] of groups)
    for (const n of list) {
      if (out.has(n)) throw new Error(`二重に割り当てた: ${n}(${out.get(n)} と ${cls})`);
      out.set(n, cls);
    }
  const ghost = [...out.keys()].filter((n) => !all.includes(n));
  if (ghost.length > 0) throw new Error(`実在しない受け手を割り当てた: ${ghost.join(' ')}`);
  for (const n of all) if (!out.has(n)) out.set(n, 'N');
  return out;
}

export function classify() {
  return assign(receivers(), [
    ['P1', P1],
    ['P2', P2],
    ['E', E],
    ['V', V],
  ]);
}

/** 実物の受け手に上の表を当てる。 */
/** 種別ごとの件数。 */
export function counts() {
  const c = { P1: 0, P2: 0, E: 0, V: 0, N: 0 };
  for (const cls of classify().values()) c[cls] += 1;
  return c;
}

if (process.argv[1]?.endsWith('action-scope-survey.mjs')) {
  const c = counts();
  const total = Object.values(c).reduce((a, b) => a + b, 0);
  const pct = (n) => `${((n / total) * 100).toFixed(0)}%`;
  console.log(`受け手 ${total} 種`);
  console.log(`  P1 真の点       ${String(c.P1).padStart(3)} (${pct(c.P1)}) ← 指さないと始められない`);
  console.log(`  P2 現在地で代替 ${String(c.P2).padStart(3)}`);
  console.log(`  E  列挙         ${String(c.E).padStart(3)}`);
  console.log(`  V  値           ${String(c.V).padStart(3)}`);
  console.log(`  N  名詞         ${String(c.N).padStart(3)}`);
  console.log(`\n名前だけで呼べる ${c.P2 + c.E + c.V + c.N} / ${total} (${pct(c.P2 + c.E + c.V + c.N)})`);
}
