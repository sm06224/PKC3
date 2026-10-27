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
 * - 記録へ積む 1 行(`postMaintenanceDone` / `postMaintenanceFailed`)。⚠ 失敗は**アプリが組んだ固定の理由**なので
 *   `fixedHead` に同じ字を渡す(案内のボタン名を括弧で潰さない ── #1087)。
 *
 * ⚠ この file は `vacuum-run.ts` / `auto-optimize.ts` のどちらも import しない
 *   (縮める係は押し口だけ、自動の係は縮めない ── 互いを知らない構造を保つ)。
 */

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

/** 終わったことを記録へ積む。 */
export function postMaintenanceDone(
  post: MaintenanceBaseDeps['post'],
  source: string,
  text: string,
): void {
  post({ kind: 'job', source, text });
}

/** 失敗を記録へ積む。⚠ `text` はアプリが組んだ固定の理由(例外の字をそのまま渡さない)。 */
export function postMaintenanceFailed(
  post: MaintenanceBaseDeps['post'],
  source: string,
  text: string,
): void {
  post({ kind: 'job', source, text, fixedHead: text });
}
