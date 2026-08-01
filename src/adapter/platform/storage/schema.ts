/**
 * PKC3 storage schema v1(設計 doc §4.3)。
 *
 * 原則:
 * - entries.body は常に PKC-Markdown(設計 doc §3 ── JSON 文字列 body を作らない)
 * - フレーバー抽出列(status / date / archived)は保存時に body(frontmatter)から
 *   抽出して書く。kanban / calendar は body を読まずに SQL で引く
 * - assets は meta + ポインタのみ(bytes は Blob storage 側 ── §4.2)
 * - settings(正規設定)と flags(実験、上限 15)は別表(§6)
 */
export const DB_SCHEMA_VERSION = 2;

/**
 * v2(P5)で revisions に追加された列。snapshot(BLOB affinity)には body
 * 原文(markdown)をそのまま入れる ── PKC2 の「JSON.stringify(Entry) 包み +
 * 厳格 parse 契約」を構造ごと不要にする。
 *
 * ⚠ migration の適用判定は user_version では**なく列の実在**
 * (pragma_table_info)で行う(review P5a F1): version 刻印だけを信じると、
 * 「DDL 適用後・刻印前にクラッシュした DB」が列欠損のまま最新版と刻まれて
 * 恒久破損する。実在判定なら冪等で、半端状態の DB も次回 open で自己修復する。
 * 将来の migration も同じ原則で書くこと(判定 = あるべき状態の実在、
 * user_version = 未来 version の reject 用)。
 */
export const REVISIONS_V2_COLUMNS: readonly string[] = [
  'title',
  'archetype',
  'content_hash',
];

export const SCHEMA_DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS containers (
     cid TEXT PRIMARY KEY,
     title TEXT NOT NULL DEFAULT '',
     created_at TEXT,
     updated_at TEXT,
     schema_version INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS entries (
     cid TEXT NOT NULL,
     lid TEXT NOT NULL,
     title TEXT NOT NULL DEFAULT '',
     archetype TEXT NOT NULL DEFAULT 'text',
     created_at TEXT,
     updated_at TEXT,
     entry_order INTEGER NOT NULL DEFAULT 0,
     status TEXT,
     date TEXT,
     archived INTEGER NOT NULL DEFAULT 0,
     body TEXT NOT NULL DEFAULT '',
     PRIMARY KEY (cid, lid)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_entries_order ON entries (cid, entry_order)`,
  `CREATE INDEX IF NOT EXISTS idx_entries_status ON entries (cid, status)`,
  `CREATE INDEX IF NOT EXISTS idx_entries_date ON entries (cid, date)`,
  `CREATE TABLE IF NOT EXISTS relations (
     cid TEXT NOT NULL,
     id TEXT NOT NULL,
     from_lid TEXT NOT NULL,
     to_lid TEXT NOT NULL,
     kind TEXT NOT NULL,
     created_at TEXT,
     updated_at TEXT,
     PRIMARY KEY (cid, id)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_rel_from ON relations (cid, from_lid)`,
  `CREATE INDEX IF NOT EXISTS idx_rel_to ON relations (cid, to_lid)`,
  `CREATE TABLE IF NOT EXISTS revisions (
     cid TEXT NOT NULL,
     id TEXT NOT NULL,
     entry_lid TEXT NOT NULL,
     created_at TEXT,
     rev_order INTEGER NOT NULL DEFAULT 0,
     seg_id TEXT,
     snapshot BLOB,
     title TEXT,
     archetype TEXT,
     content_hash TEXT,
     PRIMARY KEY (cid, id)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_rev_by_entry ON revisions (cid, entry_lid)`,
  `CREATE TABLE IF NOT EXISTS assets (
     cid TEXT NOT NULL,
     key TEXT NOT NULL,
     mime TEXT,
     size INTEGER,
     hash TEXT,
     PRIMARY KEY (cid, key)
   )`,
  `CREATE TABLE IF NOT EXISTS settings (
     scope TEXT NOT NULL,
     k TEXT NOT NULL,
     v TEXT,
     PRIMARY KEY (scope, k)
   )`,
  `CREATE TABLE IF NOT EXISTS flags (k TEXT PRIMARY KEY, v TEXT)`,
  `CREATE TABLE IF NOT EXISTS workspaces (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL DEFAULT '',
     active_cid TEXT
   )`,
];

/** サイドバー・一覧ビューが常駐させる「リーン集約」の行(body を含まない)。 */
export interface EntryMetaRow {
  lid: string;
  title: string;
  archetype: string;
  created_at: string | null;
  updated_at: string | null;
  entry_order: number;
  status: string | null;
  date: string | null;
  archived: number;
}

/**
 * ⚠ 抽出列(status / date / archived)は body(frontmatter)と同一事実の二重表現。
 * 抽出の一元化(フレーバー extractor を唯一の書込経路にする)は P3 で行う ── それまで
 * caller 渡しだが、渡し忘れが型エラーになるよう **optional にしない**(review #2、
 * PKC2 #1022 サイドカー型乖離の予防)。
 */
export interface EntryUpsert {
  lid: string;
  title: string;
  archetype: string;
  body: string;
  entryOrder: number;
  status: string | null;
  date: string | null;
  archived: boolean;
}
