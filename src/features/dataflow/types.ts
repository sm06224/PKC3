/**
 * 🔴 **ノート内データフローの型**(#2115 Phase 1 / PR-2)。
 *
 * 1 つのノートの本文(PKC-Markdown)から、名前付きのデータセット(表)と SQL の仮想ビューを拾い、
 * 依存の DAG に組む。ここは**型だけ**を置く(読む・組む関数は隣の file)。
 *
 * ⚠ pure module ── DOM / `window` / Worker / adapter 層を import しない。
 * ⚠ 行番号はすべて**原文の行番号・0 始まり**(`FenceSpan` と同じ数え方)。
 */

/** 列の型。⚠ 既存の csv の表と同じ判定(`numericColumns`)── 素直な数だけの列が `REAL`、ほかは `TEXT`。 */
export type DatasetColumnType = 'REAL' | 'TEXT';

/** 本文の中に値を持つデータセット(csv / tsv / psv の囲み、Markdown の表)。 */
export interface NoteInlineDataset {
  readonly kind: 'csv' | 'tsv' | 'psv' | 'markdown';
  readonly name: string;
  /** 囲みの開き行 / 表の見出し行(原文・0 始まり)。 */
  readonly line: number;
  /** SQL で引ける列の名前(`csvColumnNames` で整えた後)。 */
  readonly columns: readonly string[];
  /** 列ごとの型(`columns` と同じ並び)。 */
  readonly types: readonly DatasetColumnType[];
  /** データ行(見出しを除く)。⚠ 升の字は原文のまま(式や `\|` の解釈は描く側の仕事)。 */
  readonly rows: readonly (readonly string[])[];
  readonly implicit: false;
}

/** 添付(csv / tsv)を中身とするデータセット。⚠ 実バイトは adapter 層(PR-3)が読む ── ここは鍵と名前だけ。 */
export interface NoteAssetDataset {
  readonly kind: 'asset';
  readonly name: string;
  readonly line: number;
  readonly assetKey: string;
  /** 区切り字の見当(リンクの拡張子 / 囲みの言語。明示コメントは `csv`)。 */
  readonly format: 'csv' | 'tsv' | 'psv';
  /** ⚠ 囲みの `noheader` を運ぶ(コメント / リンクは常に `false`)。 */
  readonly noHeader: boolean;
  /** 添付リンクからの自動候補なら `true`(明示宣言に静かに譲る側)。 */
  readonly implicit: boolean;
}

export type NoteDataset = NoteInlineDataset | NoteAssetDataset;

/** 診断の種類。⚠ `why` は画面にそのまま出せる日本語にする(黙って捨てない ── 正直な劣化)。 */
export type DataflowDiagnosticKind =
  /** 名前が SQL に打てない(予約語・全角英数字・記号・長さ)。 */
  | 'invalid-name'
  /** 同じノートの中で、同じ名前を 2 度以上名乗った(後の方を採らない)。 */
  | 'duplicate-name'
  /** 升の数が上限(`CSV_TABLE_CELLS_MAX`)を超えた(切らずに断る)。 */
  | 'too-large'
  /** 囲みが空、または表として読めない。 */
  | 'empty'
  /** 添付の鍵が書かれていない / 読めない。 */
  | 'invalid-asset'
  /** 名前のコメントの直後に表が無い。 */
  | 'orphan-label'
  /** ビューの SQL が読み取り専用の門を通らない。 */
  | 'not-read-only'
  /** ビューが循環して参照している。 */
  | 'cycle'
  /** 上流のビューが循環しているため評価できない。 */
  | 'blocked'
  /** ビューが、このノートに無い名前を FROM / JOIN で引いている。 */
  | 'missing-ref';

export interface DataflowDiagnostic {
  readonly kind: DataflowDiagnosticKind;
  /** 対象の名前(書かれたままの字。名前が無い場面では空文字)。 */
  readonly name: string;
  /** 原文の行番号(0 始まり)。 */
  readonly line: number;
  readonly why: string;
}

/** SQL の仮想ビューの定義(本文から読んだまま。依存はまだ解いていない)。 */
export interface NoteSqlViewDef {
  readonly name: string;
  readonly line: number;
  /** 読み取り専用の門を通った、実際に打つ字(全角 → 半角を直した後・前後の空白を落とした字)。 */
  readonly sql: string;
  /** 結果の表も本文に出すか(` ```sql view=x embed `)。 */
  readonly embed: boolean;
}

/** 依存を解いたビュー。 */
export interface NoteSqlView extends NoteSqlViewDef {
  /** このノートのデータセット / ビューのうち、SQL が参照している名前(正規の綴り・出現順でなく定義順)。 */
  readonly deps: readonly string[];
  /** FROM / JOIN に書かれているが、ノート内のどこにも無い名前(書かれたままの字)。 */
  readonly missingRefs: readonly string[];
}

export interface NoteDataflowGraph {
  /** 有効なデータセット(定義順)。キーは書かれたままの名前。 */
  readonly datasets: ReadonlyMap<string, NoteDataset>;
  /** 有効なビュー(定義順)。⚠ 循環しているビューもここには入る(`order` には入らない)。 */
  readonly views: ReadonlyMap<string, NoteSqlView>;
  /** 評価できるビューのトポロジカル順(同順位は定義順)。 */
  readonly order: readonly string[];
  /** 循環の鎖(先頭と末尾が同じ名前 ── `['a', 'b', 'a']`)。 */
  readonly cycles: readonly (readonly string[])[];
  readonly diagnostics: readonly DataflowDiagnostic[];
}

export interface ViewEvaluationPlanOk {
  readonly ok: true;
  /** 評価する対象(正規の綴り)。 */
  readonly target: string;
  readonly targetKind: 'dataset' | 'view';
  /** 推移的に要る上流のデータセット(定義順)。対象がデータセットならそれ 1 つ。 */
  readonly datasets: readonly NoteDataset[];
  /** 推移的に要る上流のビュー(評価順。対象がビューなら末尾が対象)。 */
  readonly views: readonly NoteSqlView[];
}

export interface ViewEvaluationPlanError {
  readonly ok: false;
  readonly error: string;
}

export type ViewEvaluationPlan = ViewEvaluationPlanOk | ViewEvaluationPlanError;
