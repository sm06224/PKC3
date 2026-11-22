/**
 * 🔴 **端末間の同期(#2000)段 3 ── 色ラベル・ピン留めを同期の核に載せるためのキー(1 か所)**。
 *
 * 色ラベル・ピン留めは本文とは別の保存先(コレクションの `settings` 表の `note-label:<cid>` / `note-pin:<cid>`)にあり、
 * ノートの指紋(内容・親フォルダ)には入らない。だから**ノートとは別のキー**として三者比較に載せる:
 *
 * | キー | 指紋の内容 | 意味 |
 * |---|---|---|
 * | `pin:<lid>` | 定数 | ピン留めしている(在る / 無いだけ。並び順は端末ごと) |
 * | `lab:<lid>` | 色の番号から作る | 色ラベル(色を変えると内容が変わる) |
 *
 * - つながり(`rel:`)と同じく `place` を持たない。判定(`decideMerge`)はキーの種類を見ないので、そのまま通る。
 * - 競合(両方で違う色を付けた)はコピーを作れないので**こちらを残す**(`sync-plan.ts`)。相手が書き出す差分の `peerBase` で次の往復に収まる。
 * - ノート自体をゴミ箱へ移したときの印は消さない(ゴミ箱のノートのピン・色は残す作法。戻したら印も戻る)。
 * ⚠ pure module。
 */
import { isReservedSyncLid } from './sync-guard';

export const PIN_PREFIX = 'pin:';
export const LABEL_PREFIX = 'lab:';
const REL_PREFIX = 'rel:';

export const pinKey = (lid: string): string => `${PIN_PREFIX}${lid}`;
export const labelKey = (lid: string): string => `${LABEL_PREFIX}${lid}`;

/** 印(ピン留め・色ラベル)のキーか。 */
export function isAttrKey(key: string): boolean {
  return key.startsWith(PIN_PREFIX) || key.startsWith(LABEL_PREFIX);
}

/** つながりのキーか。 */
export function isRelKey(key: string): boolean {
  return key.startsWith(REL_PREFIX);
}

/** ノートのキーか(つながりでも印でもない = lid)。🔴 「ノートかどうか」の判定はここ 1 か所(各所で前置きを並べない)。 */
export function isNoteKey(key: string): boolean {
  return !isRelKey(key) && !isAttrKey(key);
}

/** 印のキーが指すノートの lid(印のキーでなければ `null`)。 */
export function attrLidOf(key: string): string | null {
  if (key.startsWith(PIN_PREFIX)) return key.slice(PIN_PREFIX.length);
  if (key.startsWith(LABEL_PREFIX)) return key.slice(LABEL_PREFIX.length);
  return null;
}

/** 印のキーが system 領域のノートを指すか(取り込まない)。 */
export function attrKeyTouchesReserved(key: string): boolean {
  const lid = attrLidOf(key);
  return lid !== null && (lid === '' || isReservedSyncLid(lid));
}

/** 色ラベルの指紋の材料(呼び手が SHA-256 する)。先頭の語は将来の形の変更を見分ける。 */
export function labelFingerprintText(color: number): string {
  return JSON.stringify(['pkc3-lab1', color]);
}

/** ピン留めの指紋の材料(定数)。 */
export function pinFingerprintText(): string {
  return 'pkc3-pin1';
}
