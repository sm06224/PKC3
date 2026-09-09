/**
 * 🔴 **「別の窓で開く」か「この画面で開く」か**(#826。user 指摘 2026-09-09)。
 *
 * > 「**zipの一覧をその場の器にするのはなんで？/ 別窓にはできないの？/
 * > 普通に別窓で開くとここで開くは共存で、デフォをどちらとするかはユーザー設定では？**」
 *
 * ## なぜ選べる必要があるか
 *
 * ⚠ どちらか片方だけにはできない ── **両方に理由がある**:
 * - **別の窓**:本文を見ながら選べる(その場の器は `showModal()` なので、
 *   開いている間は本文が 1 文字も見えない)。裁定「アプリの基本は別窓」(2026-09-04)
 * - **この画面**:ポップアップを止めている user は、そもそも別の窓が開けない ──
 *   🔑 だから**塞がれたときの退避先**としても要る(設定のためだけではない)
 *
 * ⚠ **flag ではない**(15 枠とは別。user 指示 2026-07-30「正規設定と分離」)──
 *   恒久の user 設定で、畳む予定が無い。⚠ URL パラメータも作らない。
 *
 * ⚠ **pure module**。browser API を持たない(保存は `adapter/ui/render/open-place.ts`)。
 */

export interface OpenPlaceSpec {
  readonly id: string;
  /** 設定画面に出る名前。⚠ ここを変えたらマニュアルも直す。 */
  readonly label: string;
}

/**
 * 選べる開き場所。
 * ⚠ **並びは「既定が先」** ── 選択肢の 1 つ目が既定であることを、見ただけで分かるようにする。
 */
export const OPEN_PLACES = [
  { id: 'window', label: '別の窓(既定)' },
  { id: 'here', label: 'この画面' },
] as const satisfies readonly OpenPlaceSpec[];

export type OpenPlace = (typeof OPEN_PLACES)[number]['id'];

/**
 * 🔴 **既定は別の窓**(裁定「予定表も連絡先も別窓、アプリの基本は別窓」2026-09-04)。
 * ⚠ 「別の窓は塞がれることがある」は既定を変える理由にならない ── 塞がれた回は
 *   この画面へ落ちるので、**どちらの user も詰まらない**。
 */
export const DEFAULT_OPEN_PLACE: OpenPlace = 'window';

const IDS: readonly string[] = OPEN_PLACES.map((p) => p.id);

export function isOpenPlace(v: string): v is OpenPlace {
  return IDS.includes(v);
}
