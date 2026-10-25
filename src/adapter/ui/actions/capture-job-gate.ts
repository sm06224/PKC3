/**
 * 🔴 **録ったものへの重い仕事を 1 本ずつにする門**(#952 着地前レビュー ④)。
 *
 * 切り出し(`capture-trim`)・取り出し(`capture-extract`)・文字起こし(`capture-transcribe`)・仕上げ(`capture-process`)は、
 * どれも大きな PCM や動画を読み、ワーカーを起こす。**どれか 1 つが走っている間は、ほかの 3 つも断る**(両方向)。
 * 直す前は、仕上げと取り出しが切り出しの `captureTrimBusy` を読むだけで、切り出し・文字起こしの側は仕上げを知らなかった
 * (仕上げ中に切り出しを押すと 2 本同時に走り、メモリが重なった)。
 *
 * ⚠ 取るのは**検証を済ませた直後・重い仕事を始める直前**の 1 か所(同期)。断った回が門を握ったままにならない。
 * ⚠ 必ず `release()` する(`finally`)── 解かないと、1 度失敗しただけで以後ずっと断る。
 */
export interface CaptureJobGate {
  /** 取れたら解く関数、他が走っていれば `null`。 */
  tryEnter(label: string): (() => void) | null;
  /** いま走っている仕事の名前(`null` = 無い)。 */
  readonly current: string | null;
}

export function createCaptureJobGate(): CaptureJobGate {
  let current: string | null = null;
  return {
    get current(): string | null {
      return current;
    },
    tryEnter(label: string): (() => void) | null {
      if (current !== null) return null;
      current = label;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        current = null;
      };
    },
  };
}

/** 断りの字。 */
export const captureBusyText = (current: string | null): string =>
  `いま${current ?? '別の仕事'}をしています。終わるまで待ってください。`;
