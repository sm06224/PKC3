/**
 * 🔴 **端末間の同期(#2000)── 差分ファイルから取り込んでよい lid・つながりの種類の門(1 か所)**。
 *
 * 差分ファイルは他の端末が作った入力で、細工されていても次を許さない:
 * - system 領域のノート(`sys-messages` / `sys-jobs` など)を上書き・移動・ゴミ箱へ移すこと
 * - フォルダの親子(`structural`)や知らない種類のつながりを、居場所の門(輪・1 親)を通さずに足すこと
 * 読む側(`diff-file.ts` の `readDiffZip`)と書く側(worker の `applySync`)が**同じ関数**を通る(片側だけ直して穴が残らない)。
 * ⚠ pure module。
 */
import { isSystemMessageLid } from '../message/message-log';
import { isRelationKind, STRUCTURAL } from '../relation/kinds';

/** 取り込まない lid(system 領域のノート)。`sys-` で始まる lid もまとめて除く(system 領域のノートが増えても守れる)。 */
export function isReservedSyncLid(lid: string): boolean {
  return isSystemMessageLid(lid) || lid.startsWith('sys-');
}

/** 同期で運んでよいつながりの種類(`kinds.ts` の一覧のうち `structural` 以外)。 */
export function isSyncRelationKind(kind: string): boolean {
  return isRelationKind(kind) && kind !== STRUCTURAL;
}
