/**
 * 🔴 **保存領域を縮める**(#999。Gemini 裁定 A、2026-10-01)── 押す前に言うこと・押せるかの判断・
 * 終わった後の字を、**この 1 file が持つ**。
 *
 * ## 裁定の中身(user ではなく Gemini の裁定である ── #999 のコメントに在る)
 *
 * - 縮める(`VACUUM`)は**自動では打たない**(途中で止まると DB が開けなくなった ── #1218。
 *   原因は塞いだが、自動で打つかは別の裁定)。**押した user だけ**が打つ。
 * - 押す前に**見込み**(いまの大きさ / 縮めた後 / 保存できない時間)を字で出す。
 * - **空きが足りないとき・縮む分が無いときは押せなくする**(理由を字で言う)。
 *
 * ## 数の根拠(`docs/development/storage-gauge-2026-10.md`)
 *
 * - 作業中に**いまの大きさと同じだけ**一時的に増える(OPFS の使用量が +192 MiB / 200 MiB 版)
 *   → 空きが `fileBytes` 未満なら走らせない。
 * - 所要: 20 MiB = 0.3 秒 / 100 MiB = 1〜2 秒 / 200 MiB = 2.3〜2.7 秒 / 1 GiB = 13〜18 秒。
 *   → 見込みの段は 50 MiB 以下 / 200 MiB 以下 / それ以上。⚠ **端末で変わる**ので幅で言う
 *   (秒を 1 つの値で言い切らない)。
 * - 縮む量の見込みは `freeBytes`(空いたまま抱えているページ)。⚠ **下限に近い** ──
 *   索引の古い段が残っていると、それは空きに数えられていない(optimize を先に打つと
 *   もっと返る。実測)。だから「約」と「見込み」で言う。
 *
 * ⚠ **pure module**(時計もブラウザも読まない)。空きの判定は
 * `write-quota.ts` の `quotaRoom` を通す(「読めない端末では断らない」を 2 か所に書かない)。
 */
import { humanBytes } from '../human-bytes';
import { secondsText } from './auto-optimize';
import { CORRUPT_REFUSAL } from './db-corruption';
import { DB_CHECK_LABEL } from './rescue-labels';
import { quotaRoom, WRITE_QUOTA_REFUSAL, type QuotaSample } from './write-quota';

/** 判断に要る数(`StorageGauge` の部分集合。⚠ features は adapter の型を import しない)。 */
export interface VacuumGauge {
  /** DB file の大きさ(byte)。 */
  readonly fileBytes: number;
  /** 空いたまま抱えている量(byte)。 */
  readonly freeBytes: number;
}

/** 縮める分がこれ未満なら押せない(1 MiB)。⚠ 数秒の停止に見合わない。 */
export const VACUUM_MIN_FREE_BYTES = 1024 * 1024;

/** 見込みの段(いまの大きさ)。 */
export const VACUUM_TIER_SMALL_BYTES = 50 * 1024 * 1024;
export const VACUUM_TIER_MIDDLE_BYTES = 200 * 1024 * 1024;

/** 押す口の字。⚠ 見出しは「保存領域の大きさ」(マニュアルの h4 と同じ ── `tests/docs-parity.test.ts`)。 */
export const VACUUM_HEADING = '保存領域の大きさ';
export const VACUUM_LABEL = '縮める';

/** 処理の記録に書く出所(固定の機能名。user の入力は含めない)。 */
export const VACUUM_SOURCE = 'storage-vacuum';

export const VACUUM_NOTHING_TEXT = '縮める分がありません';
export const VACUUM_NO_ROOM_TEXT =
  '空きが足りないので縮められません(縮めるには、いまの大きさと同じだけの空きが要ります)';

export type VacuumBlock =
  /** 縮める分が 1 MiB 未満。 */
  | 'nothing'
  /** ブラウザが言う空き(`quota − usage`)がいまの大きさに足りない。 */
  | 'no-room';

/**
 * 🔴 **押せない理由**(押せるなら `null`)。
 *
 * ⚠ 見る順番は「縮める分が在るか → 空きが足りるか」 ── 縮める分が無いときに
 *   「空きが足りない」と言うと、空きを作らせようとして**意味の無い手間**を負わせる。
 * ⚠ **空きが読めない端末では断らない**(`quotaRoom` が `null`)── 測れないことを理由に
 *   使えなくしない(増やす書き込みの門と同じ向き)。
 * 🔑 境界は**以上で通す**(空きがちょうど `fileBytes` なら押せる / `freeBytes` がちょうど
 *   1 MiB なら押せる)。
 */
export function vacuumBlock(gauge: VacuumGauge, quota: QuotaSample): VacuumBlock | null {
  if (gauge.freeBytes < VACUUM_MIN_FREE_BYTES) return 'nothing';
  const room = quotaRoom(quota);
  if (room !== null && room < gauge.fileBytes) return 'no-room';
  return null;
}

/** 保存できない時間の見込み(いまの大きさから段で言う)。 */
function waitText(fileBytes: number): string {
  if (fileBytes <= VACUUM_TIER_SMALL_BYTES) return '1 秒ほど';
  if (fileBytes <= VACUUM_TIER_MIDDLE_BYTES) return '1〜5 秒ほど';
  return '数秒〜十数秒';
}

/**
 * 🔴 **押す前に出す字**(1 か所)。
 *
 * - 押せるとき: 「いま 211.0 MB、縮めると約 180.0 MB になる見込み。1〜5 秒ほど保存できません。」
 * - 押せないとき: その理由(`VACUUM_NOTHING_TEXT` / `VACUUM_NO_ROOM_TEXT`)
 *
 * ⚠ 大きさは `humanBytes` ── 画面の大きさの綴りはあの 1 本(#454)。
 * ⚠ 引き算は `fileBytes − freeBytes`(縮んだ後の見込み)。逆にすると
 *   「縮めると大きくなる」と読める。
 */
export function vacuumEstimateText(gauge: VacuumGauge, quota: QuotaSample): string {
  const block = vacuumBlock(gauge, quota);
  if (block === 'nothing') return VACUUM_NOTHING_TEXT;
  if (block === 'no-room') return VACUUM_NO_ROOM_TEXT;
  return (
    `いま ${humanBytes(gauge.fileBytes)}、縮めると約 ${humanBytes(gauge.fileBytes - gauge.freeBytes)} になる見込み。` +
    `${waitText(gauge.fileBytes)}保存できません。`
  );
}

/**
 * 🔴 **処理の記録に積む字**(1 回につき 1 件)。「保存領域を縮めました(211.0 MB → 180.0 MB、2.1 秒)」。
 * ⚠ 数字しか入れない(本文・題名は 1 つも入らない ── メッセージは中身を漏らさない)。
 */
export function vacuumDoneText(beforeBytes: number, afterBytes: number, elapsedMs: number): string {
  return `保存領域を縮めました(${humanBytes(beforeBytes)} → ${humanBytes(afterBytes)}、${secondsText(elapsedMs)})`;
}

/**
 * 🔴 **縮められなかった理由**を、user が読める字へ。
 *
 * ⚠ **例外の字をそのまま出さない**(sqlite の文面が混じる)── 知っている 3 つだけ言い換え、
 *   それ以外は「保存領域に書けませんでした」と事実だけ言う。
 * ⚠ 壊れの断り(`CORRUPT_REFUSAL`)のときは、次の一手(点検)を字から引く(#996 と同じ作法)。
 */
export function vacuumFailReason(raw: string): string {
  if (raw.includes(WRITE_QUOTA_REFUSAL) || /SQLITE_FULL|disk is full/i.test(raw)) {
    return '空きが足りませんでした';
  }
  if (raw.includes(CORRUPT_REFUSAL)) {
    return `ノートの保存データに問題が見つかっているため。先に「${DB_CHECK_LABEL}」を押してください`;
  }
  return '保存領域に書けませんでした';
}

/** 縮められなかったときの字。「縮められませんでした(理由)」。 */
export function vacuumFailedText(raw: string): string {
  return `縮められませんでした(${vacuumFailReason(raw)})`;
}
