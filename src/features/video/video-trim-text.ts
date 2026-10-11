/**
 * 🔴 **動画の切り出しで、始まりが手前へ戻るときの確認**(#683 段②b-1 → ②b-2。設計 doc §1.1)。
 *
 * ## 確認が出るのは「細かく切れない環境」だけ(段②b-2 から)
 *
 * WebCodecs で押した所ぴったりに切れる環境(Chrome / Edge など)では**確認を出さない**(始まりが戻らない)。
 * 切れない環境(WebCodecs が無い / 実際に 1 枚通して動かない / 切っている途中で符号化が落ちた)だけが
 * 手前の区切りへ戻り、そのとき**裁定の文言**(`ruled`)で確認する。
 *
 * ## 文面は 2 通り、切り替えは 1 か所(`SNAP_CONFIRM_VARIANT`)
 *
 * | | いつ使うか | 文面 |
 * |---|---|---|
 * | `ruled`(**いまの既定**) | 細かく切れない環境が手前の区切りへ戻るとき | 裁定の文言: 「お使いのブラウザでは先頭を細かく切れません。一番近い区切りから切り出します」 |
 * | `interim` | 段②b-1 の間だけ使った文(**いまは使わない**。切り替えの口として残す) | 「始まりを一番近い区切りに合わせて切り出します。始まりが約 N 秒早くなります(M:SS → M:SS)」 |
 *
 * 🔑 `ruled` には「始まりが約 N 秒早くなります」を足す(`SNAP_SECONDS_IN_RULED`。🟣 依頼 8 で採択 ── #1163。
 *   字は裁定のまま:「…切り出します。始まりが約 N 秒早くなります」。押した所と実際の始まりの時刻は足さない)。
 * ボタンはどちらも [切り出す] [やめる]。
 *
 * ⚠ 文の組み立ては**この file だけ**にする。
 */
import { elapsedText } from '../elapsed-text';

export type SnapConfirmVariant = 'interim' | 'ruled';

/** 確認の文面の切り替え(1 か所)。 */
export const SNAP_CONFIRM_VARIANT: SnapConfirmVariant = 'ruled';
/** `ruled` の文面に「約 N 秒早くなります」の行を足すか。 */
export const SNAP_SECONDS_IN_RULED = true;

/** 裁定の文言(`ruled`)。 */
export const SNAP_CONFIRM_RULED_TEXT = 'お使いのブラウザでは先頭を細かく切れません。一番近い区切りから切り出します';

/**
 * 早くなる長さ(秒)の字。10 秒未満は小数 1 桁、以上は整数。
 * ⚠ 戻る(0 より大きい)のに「0.0」と出さない(最小 0.1)。
 */
export function snapSecondsText(snapBackMs: number): string {
  const sec = snapBackMs / 1000;
  if (sec < 10) return Math.max(0.1, Math.round(sec * 10) / 10).toFixed(1);
  return String(Math.round(sec));
}

export interface SnapConfirm {
  /** 確認を出すか(始まりが押した所と違うときだけ)。 */
  readonly needed: boolean;
  readonly message: string;
  readonly okLabel: string;
  readonly cancelLabel: string;
  /** 始まりが早くなる長さ(秒)。 */
  readonly snapBackSec: number;
}

export interface SnapConfirmOptions {
  readonly variant?: SnapConfirmVariant;
  readonly secondsInRuled?: boolean;
}

/**
 * @param snapBackMs 始まりが手前へ戻る長さ(ミリ秒)
 * @param pressedMs  user が押した時刻(ミリ秒)
 */
export function snapConfirm(
  snapBackMs: number,
  pressedMs: number,
  opts: SnapConfirmOptions = {},
): SnapConfirm {
  const variant = opts.variant ?? SNAP_CONFIRM_VARIANT;
  const secondsInRuled = opts.secondsInRuled ?? SNAP_SECONDS_IN_RULED;
  const n = snapSecondsText(snapBackMs);
  const snappedMs = Math.max(0, Math.round(pressedMs) - snapBackMs);
  const range = `${elapsedText(pressedMs)} → ${elapsedText(snappedMs)}`;
  const interim = `始まりを一番近い区切りに合わせて切り出します。始まりが約 ${n} 秒早くなります(${range})`;
  const ruled = secondsInRuled
    ? ruledWithSeconds(snapBackMs)
    : SNAP_CONFIRM_RULED_TEXT;
  return {
    needed: snapBackMs > 0,
    message: variant === 'interim' ? interim : ruled,
    okLabel: '切り出す',
    cancelLabel: 'やめる',
    snapBackSec: snapBackMs / 1000,
  };
}

/** 裁定の文言 + 秒の行(🟣 依頼 8 の字そのまま)。 */
export function ruledWithSeconds(snapBackMs: number): string {
  return `${SNAP_CONFIRM_RULED_TEXT}。始まりが約 ${snapSecondsText(snapBackMs)} 秒早くなります`;
}

/** 切り出しが済んだときの状態の行に足す一言(戻らなかったら空)。 */
export function snapDoneNote(snapBackMs: number): string {
  return snapBackMs > 0 ? `。押した所より約 ${snapSecondsText(snapBackMs)} 秒早く始まります` : '';
}
