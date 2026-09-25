/**
 * 🔴 **画面いちばん下の行の先頭に「いま何をしているか」の 1 語を出す**
 * (C4 / #1038 台帳③ 段 D。設計 `docs/development/touch-and-unity-design-2026-09.md`
 * §1 P3 / §11 Q2 の裁定 A)。
 *
 * ## 何が変わるか
 *
 * PKC2 は画面の左上に、読んでいるだけか編集しているかを常に一言で出していた
 * (証拠は設計 doc §1.1 P3)。PKC3 は言わずに部品(書式のボタン・追記欄の注意文)を
 * 増やして示していた ── user 指示 2026-08-15「中央の上を潰しすぎ / ボタンがボタン
 * すぎる」と同じ根である。
 *
 * 🔑 **状態を言う場所は 1 つ**(#1017 §3.1「ステータスバー = いま起きていること」)。
 * だから状態の 1 語も、既存のステータスバーの合成へ**先頭**として差し込む。
 *
 * ## ⚠ 保存に失敗して止まったときは、新しい語を作らない
 *
 * 「編集中」に対応する短い語が error phase には無い(止まっている理由が一様でない)。
 * `blockedActionNote('error')` は既に C11(#1045)で 1 か所へ寄せた断り文なので、
 * **そのまま**先頭語として使う ── 新しい言い回しを増やすと、右の列の上の 1 行と
 * 画面の下の 1 行で**また 2 通りの字**に戻る(CLAUDE.md §7「同じ値が複数の場所」)。
 *
 * ## ⚠ なぜ main.ts に書かないか
 *
 * `main.ts` は**どの test からも実行されない**(CLAUDE.md §2)。判断はここに置き、
 * `main.ts` は値を渡すだけにする(`storage-notice.ts` / `status-open.ts` と同じ作法)。
 */
import { blockedActionNote, type AppPhase } from '@adapter/state/app-state';

/**
 * 編集中の状態語。⚠ **追記欄の注意文と同じ字**にする ── 中央のステータスバーと
 * 追記欄が別の言葉で「編集中」を言うと、user は別の状態だと読む
 * (`append-box.ts` がここから import する)。
 */
export const EDITING_STATE_WORD = '編集中';

/**
 * phase から、ステータスバーの先頭に出す語を決める。
 *
 * | phase | 語 |
 * |---|---|
 * | `editing` | `EDITING_STATE_WORD`(短い語 ── 編集はいちばん頻度が高い状態なので、
 * |            | 専用の短い言い方を持つ価値がある)|
 * | `error` | `blockedActionNote('error')` の全文(短い語を作らず、既存の断り文をそのまま)|
 * | `ready` / `initializing` | `''`(読んでいるだけのときは今までどおり ── 何も言わない)|
 *
 * ⚠ **`editing` でも `blockedActionNote(phase)` を呼び直さない** ── あちらは
 * 「押せない理由」(`EDITING_NOTE` の長い文)であって、ここが要るのは状態を指す
 * 短い語である。同じ字を求めているわけではない。
 */
export function editingStateWord(phase: AppPhase): string {
  if (phase === 'editing') return EDITING_STATE_WORD;
  if (phase === 'error') return blockedActionNote('error') ?? '';
  return '';
}

/** `composeStatusLine` への入力。⚠ **状態語以外は main.ts が組んだ字のまま**渡す。 */
export interface StatusLineParts {
  readonly phase: AppPhase;
  /** 保存先の注意(`storage-notice.ts`)。 */
  readonly statusBase: string;
  /** 複数タブ / follower のバッジ。 */
  readonly sync: string;
  readonly portableAssetNote: string;
  readonly persistState: string;
  /** `SavingIndicator.line()`。 */
  readonly savingLine: string;
  /** 一時の知らせ(コピーした・取り込んだ)。 */
  readonly noticeLine: string;
  readonly errorLine: string;
}

/**
 * 🔴 **ステータスバーの 1 行を組む**(`main.ts` の `paint` から取り出した)。
 *
 * ⚠ 順は**状態語が先頭**(見本 3「編集中 — 保存先の注意 …」)。並びそのものは
 * 直す前と同じ(状態語を足しただけ)── 優先順位は変えていない。
 */
export function composeStatusLine(parts: StatusLineParts): string {
  return [
    editingStateWord(parts.phase),
    parts.statusBase,
    parts.sync,
    parts.portableAssetNote,
    parts.persistState,
    parts.savingLine,
    parts.noticeLine,
    parts.errorLine,
  ]
    .filter((t) => t !== '')
    .join(' — ');
}
