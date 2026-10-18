/**
 * 🔴 **スマートフォルダを開いたときの「いまの状態」の字 ── 左の列と 2 ペインで同じ字を出す**
 * (台帳 #1852 N1 / 依頼 322 A。Gemini 回答 = 推薦どおり)。
 *
 * ⚠ 直す前は左の列だけが「集めています」「条件を選んでください」「集められませんでした」を言い分けていて、
 *   2 ペインは**4 つとも「ここには何もありません」**だった。「集められませんでした」を「何もない」と言うのは事実と違う。
 *   500 件を超えて切ったときも総数が見えなかった。
 * 🔑 字はここ 1 か所 ── 同じスマートフォルダが、開く場所によって違うことを言わない(§7)。
 *
 * ⚠ 画面に出る字なので features には置かない(層規約)。`SmartHitState` は state の型だが、ここは**読むだけ**。
 */
import type { SmartHitState } from '@adapter/state/app-state';
import { isSmartEmpty } from '@features/smart/smart-spec';

/** まだ当たりが届いていない。 */
export const SMART_COLLECTING = 'フォルダの中身を集めています…';

/** 集めるのに失敗した。⚠ 「何もない」と言わない。 */
export const SMART_FAILED =
  '集められませんでした。画面を再読み込みして、もう一度開いてください(それでも出るときは、PKC3 を閉じて開き直してください)';

/** 条件がまだ無い(条件を足す欄は「フォルダ」タブにしか無いので、場所を言う)。 */
export const SMART_NO_CONDITION =
  'このスマートフォルダにはまだ条件がありません(「フォルダ」タブでこのフォルダを開いて、条件を選んでください)';

/** 条件はあるが 1 件も当たらない。 */
export const SMART_NO_MATCH = '条件に合うノートがありません(「フォルダ」タブで条件を外すか、別のタグにしてみてください)';

/**
 * 表が 0 行のときに言う字。`null` = スマートフォルダの話ではない(呼び側がふつうの空の字を出す)。
 * ⚠ 集めている間・失敗・条件なしは、**絞り込みの語があっても**それを先に言う(語に当たらないのではなく、そもそも集まっていない)。
 */
export function smartEmptyText(hit: SmartHitState | null, filtered: boolean): string | null {
  if (hit === null) return SMART_COLLECTING;
  if (hit.failed) return SMART_FAILED;
  if (isSmartEmpty(hit.spec)) return SMART_NO_CONDITION;
  return filtered ? null : SMART_NO_MATCH;
}

/**
 * 件数の行に添える、500 件で切った知らせ。切っていなければ空。
 * ⚠ 黙って切ると「これで全部」と読まれる(左の列の条件バーと同じ字)。
 */
export function smartTruncatedText(hit: SmartHitState | null): string {
  if (hit === null || hit.failed) return '';
  const shown = hit.lids.length;
  return hit.total > shown ? `${String(hit.total)} 件中 ${String(shown)} 件を出しています` : '';
}
