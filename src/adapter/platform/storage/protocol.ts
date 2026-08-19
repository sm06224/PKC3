/**
 * storage worker ⇄ main thread の message 契約(設計 doc §4.4)。
 * メインスレッドは query/command を投げるだけで、sqlite は worker 内に閉じる。
 */
import type { EntryMetaRow, EntryStamps, EntryUpsert } from './schema';
import type {
  GroupResult as QueryGroupResult,
  KeyResult as QueryKeyResult,
} from '@features/query/group-by';

export type StorageRequest =
  | { op: 'init'; dbName: string; journalMode?: JournalMode }
  | { op: 'openContainer'; cid: string; title?: string }
  /**
   * 🔴 **この端末のコンテナ id を決める**(#260)。
   *
   * 直す前は `main.ts` が `'default'` という**全インストール共通の定数**を渡して
   * いた。`pkc://<cid>/entry/<lid>` の「自分のコンテナか」は**文字列の等値**で
   * 決まるので、**他人の PKC3 が書いた参照**が「自分のもの」と判定されていた。
   *
   * 🔑 **選ぶのと作るのを 1 回の op に閉じる。** 既に在ればそれを返し、
   * 無ければその場で採番して挿す ── worker は単一 queue なので、この 1 op の
   * 中では**割り込まれない**。分けて書くと(読んで、無ければ書く)、
   * 初回起動の 2 枚のタブが**別々の cid を挿して器が 2 つに割れる**
   * (follower も holder の worker を通るので、この形なら起きない)。
   *
   * ⚠ **既存の DB は `'default'` のまま返る** ── cid は全テーブルの区画鍵
   * (`WHERE cid = ?`)なので、採番し直すと**既存データがまるごと見えなくなる**。
   * 移行は「既存はそのまま、新規から実体を持つ」でよい(#260 の推薦)。
   */
  | { op: 'resolveContainer'; title?: string }
  /**
   * 生きている器の id を全部返す(#260)。
   * ⚠ **添付の掃除がこれを使う** ── IDB の key は `${cid}:${assetKey}` なので、
   *   「どの器にも属さない接頭辞」= 残骸である、と判定できるのはここだけ。
   *   現に器は 1 つしか作られないが、**`[cid]` で代用しない** ── 将来
   *   器が増えたときに、掃除が**他の器の bytes を消す**形になる。
   */
  | { op: 'listContainerIds' }
  | { op: 'listEntryMetas'; cid: string }
  /**
   * 🔴 **チェック項目を持つノートの lid だけ**を返す(#277 段②)。
   *
   * ⚠ カンバンが**全ノートの本文を読まない**ための門である ── 面を開くたびの
   *   全文走査を作らない(#212 と同じ穴を掘らない)。
   * 🔑 判定は保存時に書いた列(`task_total`)で、索引が効く。
   * ⚠ 列は**多めに数えた候補**なので、返った lid に項目が 0 件のことは在る
   *   (呼び側は本文を読んで、描く側の規則で数え直すこと)。
   */
  | { op: 'listTaskEntries'; cid: string }
  | { op: 'getBody'; cid: string; lid: string }
  /**
   * 指定した lid の本文だけを **1 往復で** 取る(P7b review L-7)。
   *
   * ⚠ `listBodies` とは用途が違う ── あちらは「全件を順に、バイト数で割って」で、
   * こちらは「**この数件だけ**」。ランチャーは添付の frontmatter しか要らないのに
   * `getBody` を添付の件数ぶん呼んでいて、単一 queue の store が
   * その回数ぶん待たされていた(本文読込・保存が後ろに並ぶ)。
   * ⚠ **無い lid は結果に出ない**(呼び側は「読めたものだけ」を受け取る)。
   * ⚠ 呼び側が上限を持つ ── ここは渡された分をそのまま返す
   */
  | { op: 'getBodies'; cid: string; lids: string[] }
  /**
   * 添付の key から**所有 entry** を引く(#100 段② ── 本文の
   * `pkc://<自分>/asset/<key>` を押したとき、所有ノートへ飛ぶための逆引き)。
   * ⚠ 判定は**狭く当てる**(`archetype='attachment'` かつ frontmatter の
   * `attachment.asset_key` が等値)── `scanAssetRefs`(GC の false-keep 側)を
   * 流用しない。本文に `asset:<key>` と**書いただけ**の text ノートへ飛ぶと、
   * 「所有者へ飛ぶ」が別ノートへ飛ぶ誤爆になる(Issue #100 の名指しの罠)。
   */
  | { op: 'findAssetOwner'; cid: string; assetKey: string }
  /**
   * 🔴 **本文の全文検索**(#181)。題名だけの絞り込みでは、ノートが増えると
   * 辿れない。⚠ **本文は主スレッドに常駐していない**ので、これは SQL 側の仕事。
   * ⚠ 引き方(FTS / LIKE)の規則は `features/filter/search-query.ts` が 1 か所で持つ
   * ── worker は決めない(2 か所に規則を生やさない)。
   */
  | { op: 'searchEntries'; cid: string; query: string; limit?: number }
  /**
   * 🔴 **frontmatter で束ねる**(#184 ── 集計の面)。
   *
   * ⚠ **本文を主スレッドへ運ばない**。束ねるには本文が要るが、`getBodies` で全件を
   * 渡すと不可侵指示(2026-07-27「ゼロコピー、生成物の速やかな破棄」)に正面から当たる
   * ── だから**全文検索と同じ型**にする:重い舐めは worker、返すのは**束ねた結果**だけ。
   * 題名は主スレッドの `entryMetas` に既に在るので、表を描くのに本文は要らない。
   *
   * ⚠ worker が読むのは**本文の先頭だけ**(`substr`)。frontmatter は定義上
   * 「本文の先頭の `---` 囲み」なので、全文を読む理由が無い。
   *
   * ⚠ **目録と表は 1 回の走査で返す**(`key` を渡せば表も付く)── 別々の op に
   * すると、面を開くたびに DB の全件走査が **2 回**走る(レビュー B-3)。
   */
  | { op: 'queryScan'; cid: string; key?: string }
  /**
   * 本文を **まとめて** 取る(P6d ── 書出し用)。
   *
   * ⚠ `getBody` を N 回呼ぶと 5000 entry の書出しが 5000 往復になる。
   * `after` で続きから読み、**1 メッセージの合計バイト数**で切る
   * (`importRevisionChains` の `REVISION_BATCH_BYTES` と同じ作法 ──
   * postMessage に全量を載せない)。
   * 🔑 **鎖と違って body は割ってよい**(1 entry = 1 独立単位)ので、
   * `batchChains` が持つ「割ると静かに落ちる」問題は無い。
   *
   * 🔴 **カーソルは並び順と同じ複合キー**(`entry_order` + `lid`)。
   * `entry_order` 単独では**取りこぼす** ── `entry_order` に UNIQUE は無く、
   * app-state 自身が「trash 復元と CREATE の並行採番は重複しうる」と明記している。
   * 境界の順序値を共有する残りの行が全部飛び、**バックアップの中身が減る**
   * (実証済み: 同じ entry_order の 5 件 → 1 件しか出ない)。
   * ⚠ lid だけを持ち回って worker 側で順序値を引き直すのも**駄目** ── その行が
   * 消えていると位置が解決できず、先頭から読み直して重複する。
   */
  | {
      op: 'listBodies';
      cid: string;
      after?: { entryOrder: number; lid: string };
      maxBytes: number;
    }
  | {
      op: 'upsertEntry';
      cid: string;
      entry: EntryUpsert;
      /** true = 変更前の body を履歴に 1 件積む(既定は amend ── 鎖の頭を張り替えるだけ)。 */
      checkpoint?: boolean;
      /** 生存 entry の保持上限(未指定は worker 既定)。 */
      keepLatest?: number;
      /**
       * 🔴 **同じ tx で居場所も張る**(#258)。⚠ 省略 = 辺に触らない(本文の保存)。
       *
       * 直す前は作成が **2 手**(行を書く → ack → 辺を書く)で、その隙にタブを閉じると
       * **ノートは残るのに親だけ飛んだ**(フォルダの中に作ったのにルートに現れる)。
       * ⚠ 「効果側で 1 回の enqueue にまとめる」では直らない ── `await` で窓が開く。
       * ⚠ 中身は `setEntryParent` と**同じ 1 本**(`writeParent`)を通す。
       */
      parent?: { parentLid: string | null; relationId: string };
    }
  | { op: 'bulkUpsertEntries'; cid: string; entries: EntryUpsert[] }
  | { op: 'deleteEntry'; cid: string; lid: string }
  | { op: 'listRelations'; cid: string }
  | { op: 'bulkUpsertRelations'; cid: string; relations: RelationUpsert[] }
  /**
   * 関係を 1 件消す(#185)。⚠ **id で消す** ── from/to/kind で消すと、
   * 同じ組の関係が複数あるとき**どれが消えるか決まらない**。
   */
  | { op: 'deleteRelation'; cid: string; id: string }
  | {
      /**
       * 🔴 **居場所を張り替える 1 op**(2026-08-05。フォルダ整理)。
       *
       * ⚠ 「外す」と「入れる」を 2 op に割らない ── 割ると、途中で落ちたときに
       * **親無しの宙ぶらりん**が残る。1 tx で「その子の structural 辺を全部落として、
       * 親が在れば 1 本張る」を行う。`parentLid: null` = ルートへ出す。
       * ⚠ 循環(自分の子孫へ移す)の判定は**呼び側(reducer)**が持つ ──
       * worker は木を知らない(metas を持たない)。
       */
      op: 'setEntryParent';
      cid: string;
      lid: string;
      parentLid: string | null;
      /** 張る辺の id(呼び側が採番 ── worker で乱数を作ると test が読めない)。 */
      relationId: string;
    }
  | {
      /**
       * 取込の履歴を**鎖として**積む(P5c の符号化 = tip は entries.body、
       * 履歴は逆向きパッチ)。全文で積む経路は持たない ── 持つと取込だけが
       * 設計から外れ、PKC2 と同じ「履歴が本文の N 倍」に戻る。
       */
      op: 'importRevisionChains';
      cid: string;
      chains: RevisionChainInput[];
      keepLatest?: number;
    }
  | {
      /**
       * 鎖を**保存形のまま**取り出す(P6e)。⚠ materialize しない ──
       * `getRevision` は要求駆動で全文へ復元するので、そちらで書き出すと
       * アーカイブが N×M に膨らみ、しかも `kind` が中身と食い違う。
       */
      op: 'exportRevisionChain';
      cid: string;
      entryLid: string;
    }
  | {
      /**
       * 保存形の鎖を**復元する**(P6e)。worker の中で decode して
       * `importRevisionChains` と**同じ書込経路**へ流す ── 移行専用の
       * 書込経路を作らない(PKC2 の教訓)。codec も 1 つのまま。
       */
      op: 'restoreRevisionChains';
      cid: string;
      chains: EncodedChainInput[];
      keepLatest?: number;
    }
  | { op: 'revisionCounts'; cid: string }
  | { op: 'getRevision'; cid: string; id: string }
  | { op: 'listRevisionMetas'; cid: string; entryLid: string }
  /** revisions が存在する entry_lid の集合(= 生存 + ゴミ箱)。取込の lid 衝突判定用。 */
  | { op: 'listRevisionLids'; cid: string }
  | { op: 'listTrash'; cid: string }
  | { op: 'purgeTrash'; cid: string }
  | { op: 'putAssetMeta'; cid: string; meta: AssetMetaPut }
  | { op: 'listAssetMetas'; cid: string }
  | { op: 'deleteAssetMeta'; cid: string; key: string }
  | { op: 'scanAssetRefs'; cid: string; candidates: string[] }
  | { op: 'counts'; cid: string }
  | { op: 'close' };

/** assets 表は meta のみ(bytes は AssetBlobStore ── §4.2)。hash は遅延計算可。 */
export interface AssetMetaPut {
  key: string;
  mime: string;
  size: number;
  hash?: string | null;
}

export interface AssetMetaRow {
  key: string;
  mime: string | null;
  size: number | null;
  hash: string | null;
}

/** relations の行(P3-6b: boot 配線)。 */
export interface RelationRow {
  id: string;
  from_lid: string;
  to_lid: string;
  kind: string;
  created_at: string | null;
  updated_at: string | null;
}

/** relations の一括書込(P6 import / 将来の relation 編集が使う)。 */
export interface RelationUpsert {
  id: string;
  fromLid: string;
  toLid: string;
  kind: string;
}

/**
 * 取込む履歴 1 本(entry 1 件ぶん)。snapshots は**古い → 新しい**の順の全文で、
 * worker が tip(entries.body)から遡る逆向きパッチへ符号化する。
 *
 * ⚠ **既に履歴を持つ entry には積まない**(worker が skip する)── 既存の鎖に
 * 割り込ませると符号化の前提(隣接する版の差分)が崩れる。
 */
export interface RevisionChainInput {
  entryLid: string;
  snapshots: Array<{ body: string; createdAt: string }>;
}

/**
 * 保存形のままの revision 1 行(P6e)。`kind='patch'` の `snapshot` は
 * **1 つ新しい版から遡るパッチ**であって全文ではない。
 */
export interface EncodedRevisionRow {
  revOrder: number;
  createdAt: string | null;
  title: string | null;
  archetype: string | null;
  /** `'patch'` = 逆向き差分 / `'full'` = 全文。⚠ **中身と一致していること**。 */
  kind: string;
  snapshot: string;
  /**
   * 🔴 その版の**復元後の本文**のハッシュ。復元時の噛み合わせ検査に使う。
   * ⚠ 無いと「鎖が tip とズレていても行数さえ合えば通る」= **誤った履歴が
   * 静かに書かれ、書いた側が hash を計算し直すので永久に自己証明される**。
   * v1 のアーカイブは持たない(`null`)── その場合は検査しない。
   */
  contentHash: string | null;
}

/** 復元する鎖 1 本。rows は **新しい → 古い**(rev_order の降順)。 */
export interface EncodedChainInput {
  entryLid: string;
  rows: EncodedRevisionRow[];
}

/** importRevisionChains の結果(何が入って何が落ちたかを可視化する)。 */
export interface ImportRevisionsResult {
  /** 実際に積んだ行数。 */
  added: number;
  /** 変更が無くて畳んだ版の数(PKC2 は無変更でも snapshot を作りうる)。 */
  skippedNoChange: number;
  /** 保持上限を超えて捨てた古い版の数。 */
  droppedOverLimit: number;
  /** entry が居ない / 既に履歴を持つ等で丸ごと見送った鎖の entry_lid。 */
  skippedEntries: string[];
  /**
   * 壊れていて復元できなかった鎖(`entry_lid: 理由`)。
   * ⚠ 1 本の破損で**全部**を巻き戻さないための出口 ── 黙って落とさず名指しする。
   */
  brokenChains: string[];
}

/** revision 一覧の行(snapshot は返さない ── 本文は getRevision で 1 行ずつ)。 */
export interface RevisionMetaRow {
  id: string;
  entry_lid: string;
  rev_order: number;
  created_at: string | null;
  title: string | null;
  archetype: string | null;
  /**
   * 保存形('patch' = 逆向き差分 / 'full' = 全文)。
   * P5c の設計そのもの ── 一覧に出しておくと「差分で持っている」が**観測可能**に
   * なる(出さないと、全文で積む実装に退化しても test が気づけない)。
   */
  kind: string | null;
}

/** getRevision の本文(P5 で JSON 包みを廃止 ── body 原文 + 列)。 */
export interface RevisionBody {
  body: string;
  title: string | null;
  archetype: string | null;
}

/** entry ごとの revision 件数(snapshot は読まない ── 常駐ゼロの根拠)。 */
export interface RevisionCountRow {
  entry_lid: string;
  n: number;
}

/** message 経由の値を PRAGMA に流すため allowlist で固定(injection 防止)。 */
export const JOURNAL_MODES = [
  'delete',
  'truncate',
  'persist',
  'memory',
  'wal',
] as const;
export type JournalMode = (typeof JOURNAL_MODES)[number];

export interface StorageOk<T = unknown> {
  id: number;
  ok: true;
  result: T;
}
export interface StorageErr {
  id: number;
  ok: false;
  error: string;
}
export type StorageResponse<T = unknown> = StorageOk<T> | StorageErr;

export interface InitResult {
  vfs: 'opfs-sahpool' | 'memory';
  libVersion: string;
  crossOriginIsolated: boolean;
  /** PRAGMA journal_mode の読み戻し値(要求と違う値になりうる ── 非対応時)。 */
  journalMode: string;
  /** memory fallback したときだけ入る、落ちた理由(観測可能性 ── review #1)。 */
  fallbackReason?: string;
}

export interface CountsResult {
  entries: number;
  relations: number;
  revisions: number;
  assets: number;
}

export type RequestFor<Op extends StorageRequest['op']> = Extract<
  StorageRequest,
  { op: Op }
>;

export interface ResultMap {
  init: InitResult;
  openContainer: null;
  /**
   * この端末のコンテナ id。`created` は**採番した回だけ** true
   * (⚠ test の空振り防止に使う ── 「既に在った」と見分けが付かないと、
   * 採番を消す変異が「既存を返しただけ」に見えて生き延びる)。
   */
  resolveContainer: { cid: string; created: boolean };
  /**
   * 生きている器(作られた順)。
   * ⚠ `createdAt` を返すのは**並びの前提を検めるため** ── `ORDER BY created_at`
   *   は「作成時刻が入っている」ことに乗っており、NULL は ASC の先頭に来るので、
   *   埋め忘れると**並びの主張が黙って壊れる**。返さないと test から見えない。
   */
  listContainerIds: { containers: Array<{ cid: string; createdAt: string | null }> };
  listEntryMetas: EntryMetaRow[];
  /** チェック項目を持つ**候補**の lid(entry_order 順)。⚠ 0 件のことも在る。 */
  listTaskEntries: string[];
  getBody: string | null;
  /** 読めたものだけ(要求順)。⚠ 無い lid は**黙って落ちる**。 */
  getBodies: Array<{ lid: string; body: string }>;
  /** 所有 entry の lid。見つからなければ null(呼び側が user へ断る)。 */
  findAssetOwner: { lid: string | null };
  /**
   * 当たった lid。⚠ **並びは entry_order**(一覧と同じ)── 関連度順にしない。
   * 一覧の並びが検索のたびに変わると、user は「どこへ行ったか」を見失う。
   */
  searchEntries: { lids: string[]; truncated: boolean };
  /**
   * 集計(#184)── **1 回の走査で目録と表を同時に返す**。
   * ⚠ **捨てた数を返す**(`omittedKeys` / `omittedGroups`)── 黙って切ると
   * user は「その項目は無い」と読む。
   * ⚠ `groups` は key を渡していないとき `null`(0 組ではない)。
   */
  queryScan: { keys: QueryKeyResult; groups: QueryGroupResult | null };
  /**
   * `done` = これ以上ない。`rows` は `entry_order, lid` 順(並びの正本)。
   * `next` = 続きのカーソル(呼び出し側はこれをそのまま渡す ── 自分で組まない)。
   */
  listBodies: {
    rows: Array<{ lid: string; body: string }>;
    done: boolean;
    next?: { entryOrder: number; lid: string };
  };
  /**
   * 🔑 **DB が刻んだ時刻**(P9 段①)。`datetime('now')` を打つのは worker だけなので、
   * 返さないと主スレッドは次の boot まで作成・更新を知らない。
   * ⚠ **null 許容にしているのは行が消えていた場合だけ** ── 通常は必ず値が入る
   * (`tests/adapter/entry-timestamps.test.ts` が「実際に届くこと」を pin している。
   * optional にすると writer が代入を落としても tsc が黙り、全件で無効化される)
   */
  upsertEntry: EntryStamps;
  bulkUpsertEntries: null;
  deleteEntry: null;
  listRelations: RelationRow[];
  bulkUpsertRelations: null;
  deleteRelation: null;
  setEntryParent: null;
  importRevisionChains: ImportRevisionsResult;
  exportRevisionChain: EncodedRevisionRow[];
  restoreRevisionChains: ImportRevisionsResult;
  revisionCounts: RevisionCountRow[];
  getRevision: RevisionBody | null;
  listRevisionMetas: RevisionMetaRow[];
  listRevisionLids: string[];
  listTrash: RevisionMetaRow[];
  purgeTrash: { purged: number };
  putAssetMeta: null;
  listAssetMetas: AssetMetaRow[];
  deleteAssetMeta: null;
  scanAssetRefs: { referenced: string[] };
  counts: CountsResult;
  close: null;
}
