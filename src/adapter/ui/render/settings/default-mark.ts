/**
 * 🔴 **選択肢の「最初の値」に「(既定)」を付ける**(#1650 項目 4。Gemini 裁定 = #1163 の依頼 42-4 A)。
 *
 * ⚠ 直す前は、配色・ページ設定・文字の大きさなど 7 項目で、変えた後に元へ戻すには
 *   最初の値を思い出して選び直すしかなかった(どれが最初の値かは、選択肢の字から読めない)。
 *   本文の段組み・段の線・本文の置き場所・アプリの開き方などは、すでに字で「(既定)」と名乗っている。
 * 🔑 ボタンは増やさない ── 戻す先が選択肢の字で分かるようにするだけ。
 * ⚠ 字は**画面の選択肢にだけ**付ける(設定の値・保存・知らせの字には持ち込まない ── `plainChoiceLabel`)。
 */
export const DEFAULT_MARK = '(既定)';

/** 選択肢の列のうち、`defaultId` の 1 つにだけ「(既定)」を付けて返す(すでに名乗っている字には重ねない)。 */
export function markDefault<T extends { readonly id: string; readonly label: string }>(
  choices: readonly T[],
  defaultId: string,
): { readonly id: string; readonly label: string }[] {
  return choices.map((c) => ({
    id: c.id,
    label: c.id === defaultId && !c.label.includes('(既定') ? `${c.label}${DEFAULT_MARK}` : c.label,
  }));
}

/** 「(既定)」「(既定・…)」の末尾を外した字。知らせ(「…にしました」)に使う。 */
export function plainChoiceLabel(label: string): string {
  return label.replace(/\(既定[^)]*\)$/, '');
}
