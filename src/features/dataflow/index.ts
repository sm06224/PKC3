/**
 * 🔴 **ノート内データフロー(#2115)の純関数コア** ── 公開の口。
 *
 * 1 つのノートの本文から、名前付きのデータセット(csv / tsv / psv の囲み・名前のコメント付きの Markdown の表・
 * 添付の csv)と SQL の仮想ビュー(` ```sql view=名前 `)を拾い、依存の DAG・循環・最小の評価計画・
 * 入力の指紋を返す。評価(SQLite)と画面は adapter 層(PR-3)。
 *
 * ⚠ pure module ── DOM / `window` / Worker / adapter 層を import しない(`tests/features/dataflow/purity.test.ts`)。
 */
export type {
  DataflowDiagnostic,
  DataflowDiagnosticKind,
  DatasetColumnType,
  NoteAssetDataset,
  NoteDataflowGraph,
  NoteDataset,
  NoteInlineDataset,
  NoteSqlView,
  NoteSqlViewDef,
  ViewEvaluationPlan,
  ViewEvaluationPlanError,
  ViewEvaluationPlanOk,
} from './types';
export {
  assetKeyWhy,
  collectExplicitDatasets,
  collectImplicitAssetDatasets,
  extractNoteDatasets,
  type NoteDatasetExtraction,
} from './note-datasets';
export { extractNoteSqlViews, parseSqlViewInfo, type NoteSqlViewExtraction, type SqlViewInfo } from './sql-views';
export { cteNames, findMissingRefs, sqlFromTables, sqlMentions, sqlReferenceText } from './sql-refs';
export {
  DATAFLOW_HASH_VERSION,
  buildNoteDataflow,
  computeDataflowHash,
  formatMissingSourceError,
  planViewEvaluation,
  type DataflowNames,
} from './dataflow-dag';
export { foldName } from './names';
