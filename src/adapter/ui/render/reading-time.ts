/**
 * 🔴 **ノート詳細画面の読了目安時間バッジの描画** (#1137)。
 *
 * 読了目安時間（例: "読了 約 3 分"）を算出して要素に反映する。文字数は右のペインだけに出す（依頼 86-3 B）。
 * 閾値（200文字）未満または本文無しの場合は非表示 (hidden = true) とする。
 */
import { estimateReadingTime } from '@features/markdown/reading-time';

export function paintReadingTime(el: HTMLElement, body: string | null): void {
  if (body === null) {
    el.hidden = true;
    el.textContent = '';
    return;
  }
  const estimate = estimateReadingTime(body);
  if (estimate.label === null) {
    el.hidden = true;
    el.textContent = '';
    return;
  }
  el.hidden = false;
  el.className = 'pkc-reading-time';
  el.textContent = estimate.label;
}
