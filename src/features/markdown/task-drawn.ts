/**
 * 🔴 **画面に描かれるチェック欄の数**(#1163 依頼 316。Gemini の裁定 A:右のペインの数は画面と同じ数え方にする)。
 *
 * ## 何が食い違っていたか
 *
 * 右のペインの「チェック項目 N / M 完了」は `listTaskItems`(行を走る数え方)で数えていた。あれは
 * **かんばんが「候補を落とさない」ための多めの数え方**で、画面に出るチェック欄とは割れる ──
 * たとえば `- - [ ] a` は画面にチェックが出るのに数えず、段落のすぐ後ろの字下げした `- [ ] x` は画面に
 * 出ないのに数える(6000 通りの比較で約 3%)。
 *
 * ## 直し方
 *
 * 数えるのを**描く側**(`renderMarkdown` が焼くチェック欄)にする ── 規則を第 2 の綴りで書かない(§7)。
 * 🔑 **チェックの印が 1 つも無いノートは描かない**(印が無ければ画面にも無い)。
 *   ほとんどのノートはここで終わるので、右のペインを選ぶたびに全文を描き直すことにはならない。
 * ⚠ かんばん・予定表の「見落とさない」ための多めの数え方は、そのまま残す(ここだけが描く側へ寄る)。
 */
import { bodyBelowFrontmatter } from './frontmatter';
import { renderMarkdown } from './markdown-render';

export interface DrawnTasks {
  readonly total: number;
  readonly done: number;
}

/** チェックの印(`[ ]` / `[x]`)が 1 つも無い本文は、描かずに 0 件(`- - [ ] a` のように行頭の形が違う物も印は持つ)。 */
const TASK_MARK = /\[[ xX]\]/;
const CHECKBOX = /<input type="checkbox" class="pkc-task-checkbox"[^>]*>/g;

export function countDrawnTasks(body: string): DrawnTasks {
  if (!TASK_MARK.test(body)) return { total: 0, done: 0 };
  let total = 0;
  let done = 0;
  const html = renderMarkdown(bodyBelowFrontmatter(body), { interactiveTasks: true });
  for (const m of html.matchAll(CHECKBOX)) {
    total += 1;
    if (m[0].endsWith(' checked>')) done += 1;
  }
  return { total, done };
}
