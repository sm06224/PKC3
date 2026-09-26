/**
 * 設定のボタン列(`src/adapter/ui/render/choice-buttons.ts`)を test から読む
 * 共通の道具(#1038 段J)。プルダウンが「選ばれている物が濃く表示されるボタンの列」に
 * 変わった 7 項目(本文の置き場所 / 文字の大きさ / 本文の段組み / 段の境界線 /
 * 書庫を開く場所 / 保管件数 / 外部の画像)の test が、同じ形で選択肢と押されている
 * 値を読めるようにする(CLAUDE.md §7「同じ問いに答える口が 2 つあると、片方だけ
 * 壊れる」の test 側)。
 *
 * 🔴 **本文のタグの見せ方 / 編集の仕方 / アプリの開き方 は含まない**
 * (#1038 段J-2)── 実測(`TAB_SWEEP` 全幅 + スマホ幅 360 / 390px)で行が
 * 2 行以上に折れたため、doc §9 の覆る条件でプルダウンへ戻した(3 項目とも
 * 通常の `<select>`。この一覧の対象外)。
 */

/** その field に並ぶボタンの (value, label) を、並び順どおりに返す。 */
export function choiceRowValues(
  region: ParentNode,
  field: string,
  dataAttr: string,
): { value: string; label: string }[] {
  const row = region.querySelector(`[data-pkc-field="${field}"]`);
  if (!row) return [];
  return [...row.querySelectorAll<HTMLButtonElement>('button')].map((b) => ({
    value: b.getAttribute(dataAttr) ?? '',
    label: b.textContent ?? '',
  }));
}

/** 押されている(`aria-pressed="true"`)ボタンの値。無ければ `null`。 */
export function pressedChoiceValue(
  region: ParentNode,
  field: string,
  dataAttr: string,
): string | null {
  const row = region.querySelector(`[data-pkc-field="${field}"]`);
  if (!row) return null;
  const btn = row.querySelector<HTMLButtonElement>('button[aria-pressed="true"]');
  return btn?.getAttribute(dataAttr) ?? null;
}

/** 指定した値のボタンを実際に `click()` する(合成した要素を押さない)。 */
export function clickChoice(
  region: ParentNode,
  field: string,
  dataAttr: string,
  value: string,
): void {
  const row = region.querySelector(`[data-pkc-field="${field}"]`);
  const btn = [...(row?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find(
    (b) => b.getAttribute(dataAttr) === value,
  );
  if (!btn) throw new Error(`ボタンが見つからない: field=${field} ${dataAttr}=${value}`);
  btn.click();
}
