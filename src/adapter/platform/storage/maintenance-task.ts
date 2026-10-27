/**
 * 🔴 **保存領域の片づけ(縮める / 索引 / 添付)に共通の約束**(#1385)。
 *
 * 片づけは 3 本ある ── 走る条件(自動か押したときか)・握る lease・記録の形がそれぞれ違うので、
 * 1 つの orchestrator には寄せない(各 file の冒頭の「やってはいけない条件」の置き場が曖昧になる)。
 * ここに置くのは、**3 本が同じ形で持っている部分だけ**:
 *
 * - 配線の共通部(`MaintenanceBaseDeps`): lease を握っているか / 書込の列に載せる / 処理の記録へ積む。
 *   `vacuum-run.ts` と `auto-optimize.ts` の `*Deps` はこれを継ぐ(同じ 3 口を 2 か所に書かない)。
 * - 処理の記録へ積む 1 件の形(`MaintenanceJobPost`)と、結果の種類(`MaintenanceOutcomeKind`)。
 * - 記録へ積む 1 本の口(`reportMaintenance`)。完了 / 失敗 / 断りの違いはここで吸収する。
 *   `asset-gc.ts`(添付の整理)もここを通る。
 *
 * ⚠ この file は `vacuum-run.ts` / `auto-optimize.ts` のどちらも import しない
 *   (縮める係は押し口だけ、自動の係は縮めない ── 互いを知らない構造を保つ)。
 */

import { messageSourceLabel } from '@features/message/message-log';

/** 処理の記録(メッセージの種類「処理」)へ 1 件積む形。 */
export interface MaintenanceJobPost {
  kind: 'job';
  /** 固定の機能名(user の入力は含めない)。 */
  source: string;
  text: string;
  /** アプリが組んだ固定の理由のときだけ渡す(括弧の整形を掛けない)。 */
  fixedHead?: string;
}

/** 片づけの 1 回の結果の種類。 */
export type MaintenanceOutcomeKind = 'done' | 'failed' | 'refused';

/** 片づけの 1 回の結果。`text` は画面と処理の記録に出す、アプリが組んだ固定の文。 */
export interface MaintenanceResult {
  kind: MaintenanceOutcomeKind;
  text: string;
}

/** 3 本の片づけが共通に受け取る口。 */
export interface MaintenanceBaseDeps {
  /** 書込の lease を握っているか(`main.ts` の `writerHolder`)。 */
  holdsWriterLease(): boolean;
  /** 書込の列に載せて走らせる(`StoreEffects.run`)。 */
  run<T>(job: () => Promise<T>): Promise<T>;
  /** 処理の記録へ積む(`appMessagePost.post`)。 */
  post(input: MaintenanceJobPost): void;
}

/** 片づけを名乗る(処理の記録の出所と、画面に出す呼び名)。 */
export interface MaintenanceTaskIdentity {
  readonly source: string;
  readonly name: string;
}

/**
 * 出所から名乗りを組む。⚠ 呼び名は**処理の記録の見出しに出る字と同じ表**(`MESSAGE_SOURCE_LABEL`)から引く ──
 * 画面の呼び名を 2 か所に書かない。表に無い出所は出所そのものになる(test が空振りを見張る)。
 */
export function maintenanceIdentity(source: string): MaintenanceTaskIdentity {
  return { source, name: messageSourceLabel(source) };
}

/**
 * 片づけの結果を処理の記録へ報告する(3 本の片づけが通る 1 本の口)。
 *
 * - `done`: 終わったことを 1 件積む。
 * - `failed`: 失敗を 1 件積む。⚠ `text` はアプリが組んだ固定の理由なので `fixedHead` に同じ字を渡す
 *   (案内のボタン名を括弧で潰さない ── #1087)。
 * - `refused`: **積まない**(何も起きていない。断った理由は呼び側が画面に言う)。
 *   記録を積まない片づけ(添付の整理が途中で止まった回など)との形の違いは、この 1 点で吸収する。
 */
export function reportMaintenance(
  post: MaintenanceBaseDeps['post'],
  task: MaintenanceTaskIdentity,
  result: MaintenanceResult,
): void {
  if (result.kind === 'refused') return;
  if (result.kind === 'done') post({ kind: 'job', source: task.source, text: result.text });
  else post({ kind: 'job', source: task.source, text: result.text, fixedHead: result.text });
}
