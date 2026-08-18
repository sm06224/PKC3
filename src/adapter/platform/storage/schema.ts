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
export const DB_SCHEMA_VERSION = 3;

/**
 * revisions の後付け列(v2: title / archetype / content_hash、v3: kind)。
 * snapshot(BLOB affinity)には **kind='full' なら body 原文、'patch' なら
 * 行パッチ JSON** が入る(P5c ── 逆向き差分チェーン)。PKC2 の
 * 「JSON.stringify(Entry) 包み + 厳格 parse 契約」は構造ごと不要のまま。
 *
 * ⚠ migration の適用判定は user_version では**なく列の実在**
 * (pragma_table_info)で行う(review P5a F1): version 刻印だけを信じると、
 * 「DDL 適用後・刻印前にクラッシュした DB」が列欠損のまま最新版と刻まれて
 * 恒久破損する。実在判定なら冪等で、半端状態の DB も次回 open で自己修復する。
 * 将来の migration も同じ原則で書くこと(判定 = あるべき状態の実在、
 * user_version = 未来 version の reject 用)。
 * NULL の kind は 'full' 扱い ── v2 までの既存行はすべて全文なので互換で正しい。
 */
export const REVISION_ADDED_COLUMNS: readonly string[] = [
  'title',
  'archetype',
  'content_hash',
  'kind',
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
     kind TEXT,
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
  /**
   * 🔴 **本文の全文検索**(#181 / 台帳 #180 の A-1)。題名しか探せないと、
   * ノートが増えた時点で辿れなくなる ── 北極星の「必要十分」に届いていない欠け。
   *
   * ## なぜ trigram か(2026-08-15 に実測して決めた。推測ではない)
   *
   * 同梱 sqlite は `ENABLE_FTS5` 入り。ただし **日本語は既定 / unicode61 では
   * 1 語に潰れて引けない**(`全文検索` を入れて `全文` で MATCH → 0 件)。
   * trigram なら引ける ── ただし **3 文字以上**(実測: `全文検索` HIT /
   * `本語の` HIT / `りんご` HIT / `全文`(2 字)は 0 件)。
   * ⇒ **3 文字以上は FTS、2 文字以下は LIKE** で拾う(worker 側の分岐)。
   *
   * ## external content(`content='entries'`)にした理由
   *
   * 本文を**二重に持たない**。同期は trigger に閉じるので、**書込側が索引の更新を
   * 忘れる**型の欠陥(§1 の「材料が届いていない」)が原理的に起きない。
   */
  `CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
     title, body, content='entries', content_rowid='rowid', tokenize='trigram'
   )`,
  `CREATE TRIGGER IF NOT EXISTS entries_fts_ai AFTER INSERT ON entries BEGIN
     INSERT INTO entries_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
   END`,
  `CREATE TRIGGER IF NOT EXISTS entries_fts_ad AFTER DELETE ON entries BEGIN
     INSERT INTO entries_fts(entries_fts, rowid, title, body)
       VALUES ('delete', old.rowid, old.title, old.body);
   END`,
  `CREATE TRIGGER IF NOT EXISTS entries_fts_au AFTER UPDATE ON entries BEGIN
     INSERT INTO entries_fts(entries_fts, rowid, title, body)
       VALUES ('delete', old.rowid, old.title, old.body);
     INSERT INTO entries_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
   END`,
];

/**
 * trigram が引ける最小の文字数(実測値)。これ未満の問い合わせは LIKE で拾う。
 * ⚠ 「3」は仕様ではなく**測った値**なので、tokenizer を変えたら測り直す。
 */
export const FTS_MIN_CHARS = 3;

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

/**
 * 書込のときに **DB が刻んだ** 時刻(P9 段①)。
 *
 * 🔑 **主スレッドで作らない**。`datetime('now')` を打つのは worker の `UPSERT_SQL`
 * だけなので、主スレッドが自分で now を作ると **DB に無い値を画面に出す**ことになる。
 * ⚠ 形は sqlite の `datetime('now')`(`YYYY-MM-DD HH:MM:SS`、UTC)。
 */
export interface EntryStamps {
  createdAt: string | null;
  updatedAt: string | null;
  /**
   * 🔴 **同じ tx で居場所も書いたか**(#258 の着地前レビュー ⚠-2)。
   *
   * ⚠ **旧ビルドのタブが本体(holder)のことがある** ── 版が配られても、押した
   * タブしか読み込み直さない(`update-prompt.ts`)。旧 worker は `parent` を
   * **知らないので黙って無視する**(未知の op ではないので拒否も返らない)ので、
   * 呼び側から見ると「成功したのに居場所が付いていない」になる ── 2 手だった頃は
   * 旧 holder でも書けていたので、**これは新しく開く穴**である。
   * 🔑 だから **書いたときだけ名乗る**。名乗らなければ呼び側が `setEntryParent` で
   * 追い撃ちする(旧 holder では自動で 2 手へ落ちる = 互換は双方向、CLAUDE.md)。
   */
  parentWritten?: boolean;
}
