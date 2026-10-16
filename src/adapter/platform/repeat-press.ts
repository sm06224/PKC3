/**
 * 🔴 **「前に出して」と頼んだ直後の 2 度目の押下は、新しく開く**(#855 の動線レビュー → #1087)。
 *
 * 開いている窓へ「前に出て」と頼んでも、前に出るかは保証できない(最小化 / 別のモニタ)。
 * 台帳は窓が生きているかぎり「そこに在る」と答え続けるので、**2 度目を新しく開く規則が無いと、
 * 探しても見つからない窓を前にして、何度押しても開けない**。
 * 週・月の窓(`schedule-deep-link.ts`)とノートの窓(`note-window-registry.ts`)が同じ規則で
 * 動くよう、記憶と判定をここ 1 か所に置く(別々に書くと、片方だけ体裁が変わっても誰も気づかない)。
 */

/** この秒数のうちの 2 度目の押下は、新しく開く。 */
export const REPEAT_PRESS_MS = 10_000;

export interface RepeatPressGate {
  /**
   * 押した、と記録して答える。
   * @returns `'again'` = 直前の押下から `ms` 以内の 2 度目(記憶は捨てる ── 3 度目はまた最初から)/
   *   `'first'` = 最初の押下(記憶する)
   */
  press(key: string, now: number): 'first' | 'again';
  /** 記憶を空にする(test が差す)。 */
  reset(): void;
}

export function createRepeatPressGate(ms: number = REPEAT_PRESS_MS): RepeatPressGate {
  const pressedAt = new Map<string, number>();
  return {
    press: (key, now) => {
      const at = pressedAt.get(key);
      if (at !== undefined && now - at <= ms) {
        pressedAt.delete(key);
        return 'again';
      }
      pressedAt.set(key, now);
      return 'first';
    },
    reset: () => pressedAt.clear(),
  };
}
