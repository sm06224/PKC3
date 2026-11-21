/**
 * 🔴 **端末間の同期(#2000)段 3 ── 色ラベル・ピン留め(ノートの「印」)の指紋とキー(1 か所)**。
 *
 * 色ラベルとピン留めは、ノートの本文・更新日時に触れない別の保存先(`settings` 表)にある。だからノートの指紋には入らない。
 * 段 3 では、**1 ノート 1 件**を「キー + 指紋」にして、ノート・つながりと同じ三者比較(`change-set.ts`)に載せる:
 *
 * - 色ラベル: キー `lbl:<lid>`、指紋 = 色の番号のハッシュ(別の色に変えると指紋が変わる)。
 * - ピン留め: キー `pin:<lid>`、指紋 = 定数(留めた / 外したの 2 値)。⚠ 留めた**順番**は端末ごとの並びなので運ばない(足すときは末尾へ)。
 * - 生きているノートの分だけが「いまの状態」(ゴミ箱のノートの印は、戻したときのために残すだけで運ばない)。
 *
 * ⚠ 時計は見ない。判定は他のキーと同じ(同じ欄が両方で違う色になったときだけ競合 = こちらを残し、次の書き出しで相手へ送る)。
 * ⚠ pure module。
 */
import type { Fp } from './change-set';
import { sha256Hex } from './sha256';

export const LABEL_KEY_PREFIX = 'lbl:';
export const PIN_KEY_PREFIX = 'pin:';
const REL_PREFIX = 'rel:';

export const labelKey = (lid: string): string => `${LABEL_KEY_PREFIX}${lid}`;
export const pinKey = (lid: string): string => `${PIN_KEY_PREFIX}${lid}`;

export const isLabelKey = (key: string): boolean => key.startsWith(LABEL_KEY_PREFIX);
export const isPinKey = (key: string): boolean => key.startsWith(PIN_KEY_PREFIX);
export const isMarkKey = (key: string): boolean => isLabelKey(key) || isPinKey(key);

/** ノート(= 本文を持つ物)のキーか(つながり・印ではない)。 */
export const isNoteKey = (key: string): boolean => !key.startsWith(REL_PREFIX) && !isMarkKey(key);

/** 印のキーが指すノートの lid(印のキーでなければ `null`)。 */
export function markKeyLid(key: string): string | null {
  if (isLabelKey(key)) return key.slice(LABEL_KEY_PREFIX.length);
  if (isPinKey(key)) return key.slice(PIN_KEY_PREFIX.length);
  return null;
}

/** 色ラベルの指紋(色の番号が違えば値が違う)。 */
export function labelFp(color: number): Fp {
  return { content: sha256Hex(`label\n${color}`) };
}

/** ピン留めの指紋(定数)。 */
export function pinFp(): Fp {
  return { content: sha256Hex('pin') };
}
