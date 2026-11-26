/**
 * 紙面の余白(v4.0 Phase 1 / PR-03)。
 *
 * 🔑 **値の正本はこの表 1 枚**。`page-format.ts` の `paperRule`(`@page` の margin)と
 *   `page-layout.ts`(ノート単位のページ設定・印刷レイアウト表示の紙の内側の余白)の両方がここを引く。
 * ⚠ `page-layout.ts` に直接置かないのは、`page-format.ts` → `page-layout.ts` → `page-format.ts` の
 *   循環 import を作らないため(`page-layout.ts` が再 export するので、使う側はそちらから引いてよい)。
 * ⚠ **pure module**(browser API を使わない)。
 */

export type PageMargin = 'narrow' | 'normal' | 'wide';

export interface PageMarginSpec {
  readonly id: PageMargin;
  /** 情報ペインの選択肢に出す字。 */
  readonly label: string;
  /** 余白の mm(数で扱いたい呼び手のため)。 */
  readonly mm: number;
  /** CSS に入れる値(`@page{margin:…}` と紙の内側の余白)。 */
  readonly css: string;
}

export const PAGE_MARGINS: readonly PageMarginSpec[] = [
  { id: 'narrow', label: '狭い (12mm)', mm: 12, css: '12mm' },
  { id: 'normal', label: '標準 (20mm)', mm: 20, css: '20mm' },
  { id: 'wide', label: '広い (30mm)', mm: 30, css: '30mm' },
] as const;

/** 既定は標準(20mm)。⚠ ノートに指定が無いときの印刷レイアウト表示の紙の内側の余白に使う。 */
export const DEFAULT_PAGE_MARGIN: PageMargin = 'normal';

export function isPageMargin(v: unknown): v is PageMargin {
  return typeof v === 'string' && PAGE_MARGINS.some((m) => m.id === v);
}

/** 表から 1 つ引く。⚠ 知らない id は既定へ落ちる。 */
export function pageMarginSpec(id: PageMargin): PageMarginSpec {
  return PAGE_MARGINS.find((m) => m.id === id) ?? PAGE_MARGINS.find((m) => m.id === DEFAULT_PAGE_MARGIN)!;
}
