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

/**
 * 🔴 **実際にどちらで開くか**(#826 の着地前レビュー 欠陥 7)。
 *
 * ⚠ **電話の画面では、選ばれていても「この画面」にする。**
 *   🔑 理由は端末の**画面が 1 枚しかない**ことである ── 別の窓にしたときの取り柄は
 *   「**本文を見ながら選べる**」だが、画面が 1 枚なら**並べられない**ので取り柄が
 *   成立しない。そのうえ行き来の手間だけが増える(user が最初に困った
 *   「本文が 1 文字も見えない」に戻る)。
 * ⚠ **窓が開けたかどうかとは別の話**である ── 開けてしまうので、
 *   塞がれたときの退避(`null` で器へ落ちる)では拾えない。
 * ⚠ **保存は書き換えない** ── 電話で開いた日に、机の端末の好みまで変わってはいけない。
 */
export function effectiveOpenPlace(saved: OpenPlace, phone: boolean): OpenPlace {
  return phone ? 'here' : saved;
}

const IDS: readonly string[] = OPEN_PLACES.map((p) => p.id);

export function isOpenPlace(v: string): v is OpenPlace {
  return IDS.includes(v);
}
