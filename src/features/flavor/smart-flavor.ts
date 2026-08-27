/**
 * 🔴 **スマートフォルダのフレーバー**(#421 段①。user 要望 2026-08-26)。
 *
 * 本文はいつもどおり **PKC-Markdown** で、条件は frontmatter の `smart-tags:`
 * (規約は `features/smart/smart-spec.ts`)。⚠ 中身は**条件で決まる**ので、
 * この入れ物に手で子を入れることはできない。
 *
 * ## ⚠ なぜ `folder` に兼ねさせないか
 *
 * フォルダに条件を持たせると、中身が **2 種類**(手で入れた子 + 条件で当たった物)
 * になり、「**消したのに残る / 移したのに戻る**」が起きる ── どちらの規則で
 * 動いているのかが画面から読めない。🔑 PKC3 のアーキタイプは「見せ方・編集の
 * 仕方」(founding)なので、**別に 1 本立てるほうが安い**。
 *
 * ## 🔴 **期日と状態は書ける**(2026-08-27。#283 の (B))
 *
 * > user 指示 2026-08-19「**エントリやエントリグループをタスクとして扱えるように
 * > するんです**」
 *
 * ⚠ 1 稿目は「スマートフォルダは予定ではないので `date` / `status` を写さない」と
 *   書いていたが、**それは 2026-08-20 に否決された理屈**である ──
 *   founding 裁定「アーキタイプ = フレーバー(見せ方・編集の仕方)」に照らすと、
 *   **`date` の意味が archetype で変わるほうが誤り**であり、同型の 4 つを直した
 *   (`spreadsheet-flavor.ts` の docstring)。⚠ このフレーバーは**その直しの後に
 *   生まれた**ので、否決済みの理屈を引き継いでいた。
 * 🔴 症状:`date:` と書いても**予定の面に出ない**(`agenda.ts` は列
 *   `meta.date` を読む)── しかも**理由がどこにも出ない**。
 * 🔑 **グループ = 表紙を持つタグ**(`docs/development/group-and-task-model-2026-08.md`
 *   §9 Q2)なので、スマートフォルダの表紙に期日と状態が付けば
 *   「グループをタスクとして扱う」が成立する。
 * ⚠ `archived` は写さない ── 理由は `extractSchedule` の docstring。
 */
import { type FlavorSpec } from './flavor-spec';
import { extractSchedule } from '@features/schedule/schedule-keys';
import { SMART_ARCHETYPE, SMART_TAGS_KEY } from '@features/smart/smart-spec';

export const smartFlavor: FlavorSpec = {
  archetype: SMART_ARCHETYPE,
  extract: (body) => ({ ...extractSchedule(body), archived: false }),
  /** PKC2 に対応する archetype は無い ── 恒等で通す(取り込みで落とさない)。 */
  fromPkc2: (body) => body,
  /**
   * 🔑 **条件は空で置く**(規約が見える最小形)。
   * ⚠ 空は「全部集める」ではなく「**何も集めない**」である ── 作った直後に
   *   全件が並ぶと「壊れている」と読まれる。画面には「条件を選んでください」と出す。
   */
  seed: () =>
    `---\n${SMART_TAGS_KEY}: \n---\n\n` +
    `右の「条件」でタグを選ぶと、そのタグが付いたノートがここに集まります。\n` +
    `ここに書いた文は説明として残ります(集めるものには影響しません)。\n`,
};
