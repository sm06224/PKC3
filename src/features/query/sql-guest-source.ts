/**
 * 🔴 **「この添付は何の file か」を決める、たった 1 か所**(#854 段① / 段③)。
 *
 * ⚠ 見分けは**題名の拡張子だけ**(中身で見分けるには全部読むしかなく、選ぶ前に
 *   何十 MB も heap へ載せることになる ── 不可侵指示 2026-07-27 の逆)。
 *
 * ## なぜ features 層に置くのか
 *
 * 🔑 読む側(`storage-worker.ts`)と、選ぶ側(`store-effects.ts`)と、
 *   選び所を描く側(`ui/render/sql.ts`)が**同じ答え**を使う必要がある ──
 *   §7「同じ問いに答える口を 2 つ作らない」。⚠ 判定が 2 か所に分かれると、
 *   **選び所には並ぶのに開くと断られる**(あるいはその逆)という、
 *   user から見て理由の分からない形になる。
 */
import { CSV_ATTACHMENT_TABLE_NAME, looksLikeCsvAttachmentName } from './csv-attachment';
import { SQLITE_EXTS, looksLikeSqliteName, type SqlSource } from './sqlite-attachment';
import { looksLikeXlsxAttachmentName } from './xlsx-attachment';

/**
 * 🔴 **`openSqlGuest` に渡す「これは何の file か」**。
 *
 * ⚠ `lid` / `name` は**どの種類でも要る**(表の `_note` / `_lid` 列に入る)ので
 *   `kind` の外に置く ── 中に入れると、種類を足す人が写し忘れる。
 */
export type SqlGuestSource = {
  /** 元のノートの lid(表の `_lid` 列に入る)。 */
  readonly lid: string;
  /** 元のノートの題名(表の `_note` 列に入る)。 */
  readonly name: string;
} & (
  | { readonly kind: 'csv'; readonly lang: 'csv' | 'tsv' }
  /** 🔴 枚(シート)ごとに 1 つの表になる ── 表の名前は `sheet1` / `sheet2` …。 */
  | { readonly kind: 'xlsx' }
  /**
   * 🔴 **DuckDB でしか読めない相手**(#682 段④c)。
   * ⚠ 内蔵の sqlite はこの中身を解釈できない ── だから
   *   `SQLITE_READABLE_KINDS` に**入れない**(型で渡せなくしてある)。
   */
  | { readonly kind: 'parquet' }
  | { readonly kind: 'json'; readonly lang: 'json' | 'ndjson' }
  /**
   * 🔴 **取り込んだ `.sqlite`**(#682 段④d)。⚠ 内蔵の sqlite は画像をそのまま開く(変換しない)ので
   *   `SqliteConvertGuestSource` には入らない。DuckDB は**表を NDJSON に写して**引く
   *   (`ATTACH` は器の中で bytes を読めない ── 実測)。⚠ 表の名前は**中身を読むまで分からない**。
   */
  | { readonly kind: 'sqlite' }
);

/**
 * 🔴 **内蔵の sqlite が中身を読める種類**(#682 段④c)。
 *
 * 🔑 **一覧をここに 1 つだけ持つ** ── これを使って
 * `SqliteReadableGuestSource` を型で切り出すので、
 * **DuckDB でしか読めない相手を sqlite worker へ渡す道が、型から消える**
 * (CLAUDE.md §7「検出するより起こらなくする」)。
 * ⚠ 「渡ってきたら投げる」枝を書くのではない ── その枝は**誰も通らない死んだ枝**になり、
 *   鳴らない検査が 1 つ増えるだけである。
 */
export const SQLITE_READABLE_KINDS = ['csv', 'xlsx', 'sqlite'] as const;

/** 内蔵の sqlite が読める相手(上の一覧で切り出した形)。 */
export type SqliteReadableGuestSource = Extract<
  SqlGuestSource,
  { readonly kind: (typeof SQLITE_READABLE_KINDS)[number] }
>;

/**
 * 🔴 **sqlite worker へ「変換して開け」と渡す相手**(`.csv` / `.xlsx`)。
 *
 * ⚠ **`.sqlite` は入らない** ── 画像そのものなので、worker へは `source` を**渡さない**
 *   (省略 = 画像として開く。後方互換の既定)。🔑 型から外してあるので、
 *   worker の `switch` に「`sqlite` が来たら…」という誰も通らない枝が要らない。
 */
export type SqliteConvertGuestSource = Exclude<
  SqliteReadableGuestSource,
  { readonly kind: 'sqlite' }
>;

/**
 * worker へ渡す `source` を決める。⚠ `undefined` = **画像として開く**(`.sqlite` / 判定なし)。
 * 🔑 判定は**ここ 1 か所**(`store-effects.ts` が呼ぶ)── 呼び側で `kind` を見直さない。
 */
export function sqliteConvertSourceOf(
  src: SqliteReadableGuestSource | null,
): SqliteConvertGuestSource | undefined {
  return src === null || src.kind === 'sqlite' ? undefined : src;
}

/**
 * 🔴 **DuckDB が中身を読める種類**(#682 段④c)。
 *
 * 🔑 **一覧をここに 1 つだけ持つ** ── ①どのエンジンを選べるか(`sqlEngineHint`)
 *   ②走らせる側が組む `FROM …`(`duckdb-runner.ts`)が、**同じ一覧から派生する**。
 * ⚠ 2 か所に書くと「**選び所は DuckDB を出すのに、押すと組み方が分からない**」
 *   (あるいはその逆で、読めるのに選べない)が生まれる ── CLAUDE.md §7。
 * ⚠ `.xlsx` は入れない(`excel` 拡張を同梱していない)。
 * 🔴 `.sqlite` は入れた(#682 段④d)── ただし `sqlite_scanner` の `ATTACH` では**なく**、
 *   表を NDJSON に写して引く(`sqlite-ndjson.ts`。`ATTACH` は器の中で bytes を読めない ── 実測)。
 */
export const DUCKDB_READABLE_KINDS = ['csv', 'parquet', 'json', 'sqlite'] as const;

/** DuckDB へ渡せる相手(上の一覧で切り出した形)。 */
export type DuckDbReadableGuestSource = Extract<
  SqlGuestSource,
  { readonly kind: (typeof DUCKDB_READABLE_KINDS)[number] }
>;

/**
 * 🔴 **「1 つの file = 1 つの表」で DuckDB が読む相手**(`.csv` / `.parquet` / `.json`)。
 *
 * 🔑 `.sqlite` は**何枚の表になるか中身を読むまで分からない**ので、表の名前を 1 つ答える関数
 *   (`guestTableNameOf` / `duckDbReadFrom` / `duckDbLoadSql`)の引数には**入れない**
 *   (`xlsx` が `guestTableNameOf` に入っていないのと同じ作法)。型で外してあるので、
 *   「`sqlite` が来たら null を返す」という誰も通らない枝が要らない。
 */
export type DuckDbFileGuestSource = Exclude<DuckDbReadableGuestSource, { readonly kind: 'sqlite' }>;

/** その相手は DuckDB で読めるか。 */
export function isDuckDbReadableSource(src: SqlGuestSource | null): src is DuckDbReadableGuestSource {
  return src !== null && (DUCKDB_READABLE_KINDS as readonly string[]).includes(src.kind);
}

/**
 * 題名から、DuckDB へ渡せる相手を組む。⚠ 読めない相手は `null`。
 * 🔑 呼び側(`store-effects.ts`)は `null` を**既に在る「引けません」の断り**へ畳む
 *   ── 新しい枝を作らない。
 */
export function duckDbReadableSourceOf(
  lid: string,
  name: string,
): DuckDbReadableGuestSource | null {
  const src = sqlGuestSourceOf(lid, name);
  return isDuckDbReadableSource(src) ? src : null;
}

/**
 * 🔴 **この相手は DuckDB でしか読めないか**(#682 段④c)。
 *
 * 🔑 **判定はここ 1 か所** ── 選び所(`sqlEngineHint`)も、開く経路
 * (`store-effects.ts`)も、同じ答えを見る。⚠ 2 か所に書くと
 * 「選び所は DuckDB だけと言うのに、開くときは sqlite worker へ送る」が起きる。
 */
export function isDuckDbOnlySource(src: SqlGuestSource | null): src is DuckDbOnlyGuestSource {
  if (src === null) return false;
  return !(SQLITE_READABLE_KINDS as readonly string[]).includes(src.kind);
}

/**
 * 🔴 **選んだ直後に言う 1 文**(#992 ①。Gemini の裁定 2026-10-01 = 答え A)。
 *
 * ⚠ 直す前は「SQL を走らせる」を押して**初めて**「DuckDB の一式を取ってこられませんでした」と
 *   分かった。`.parquet` / `.json` には内蔵の sqlite へ逃げる道が無いので、
 *   **電波が無い場所で選んだ人は、打ち終えてから行き止まる**。
 * 🔑 **判定は `isDuckDbOnlySource` 1 か所**(選び所の薄い字・開く経路と同じ答えを見る)── 2 本目を作らない。
 * ⚠ `.csv` は内蔵の sqlite で引けるので**言わない**(DuckDB を選んだ人にだけ初回の読み込みが要る)。
 */
export const DUCKDB_NETWORK_NOTE = 'このファイルは DuckDB で調べます。初回はネットワークにつながっている必要があります';

/** 題名(file の名前)から、選んだ直後に出す知らせを引く。⚠ 言うことが無ければ `null`。 */
export function duckDbNetworkNoteOf(name: string): string | null {
  return isDuckDbOnlySource(sqlGuestSourceOf('', name)) ? DUCKDB_NETWORK_NOTE : null;
}

/**
 * 内蔵の sqlite が読めない相手。
 * 🔑 **`SqliteReadableGuestSource` の裏返しとして組む**(`Exclude`)── 一覧を
 *   もう 1 つ書くと、種類を足した日に**片方だけ増える**(CLAUDE.md §7)。
 * 🔑 これを型の述語(`is`)にしてあるので、**振り分けた後の枝では
 *   `SqliteReadableGuestSource` に絞り込まれる** ── sqlite worker へ渡す口が、
 *   振り分けを飛ばした日に tsc で落ちる。
 */
export type DuckDbOnlyGuestSource = Exclude<SqlGuestSource, SqliteReadableGuestSource>;

/**
 * 🔴 **その相手で user が打つ表の名前**(#682 段④c)。
 *
 * 🔑 **既存の決まりをそのまま伸ばした** ── この repo は表を「**その相手が何か**」で
 * 名付けている(`.csv` → `csv`)。好みではなく、**実装を読めば決まる**側だった。
 * だから `.parquet` → `parquet`、`.json` → `json`。
 *
 * ⚠ **`.xlsx` は引数の型に入っていない** ── あちらは **1 file = 何枚でも**なので、
 *   表の名前は枚ごとに `sheet1` / `sheet2` …(`xlsxTableName`)である。
 *   🔑 「1 つに決まる相手」だけを型で受けることで、**`null` を返す枝が消えた**
 *   (返していた頃は、呼び側に「`null` のときどうするか」という
 *   **誰も通らない枝**を書かせていた ── CLAUDE.md §7)。
 *
 * 🔑 **読み手は 2 つとも、この関数を呼ぶ** ── 器が実際に `CREATE TABLE` する名前
 *   (`duckdb-runner.ts`)と、**画面の案内・薄字の手本・消えない例文**(`sql-tip.ts`)が
 *   同じ 1 か所から出るので、「**画面に出ている名前で引けない**」が構造から消えている。
 * ⚠ **1 稿目はここが嘘だった** ── 画面の側は `csv` を直書きしていて、この関数を
 *   1 度も呼んでいなかった(`.parquet` を選ぶと**手本をそのまま打って英語で断られる**)。
 *   着地前レビューと動線レビューが、独立に同じ 1 件を挙げた。
 */
export function guestTableNameOf(src: DuckDbFileGuestSource): string {
  switch (src.kind) {
    case 'csv':
      return CSV_ATTACHMENT_TABLE_NAME;
    case 'parquet':
      return 'parquet';
    case 'json':
      return 'json';
    default: {
      const never: never = src;
      throw new Error(`知らない開き方です: ${JSON.stringify(never)}`);
    }
  }
}

/**
 * その題名は `.parquet` か。⚠ 比べる前に小文字へ落とす(ほかの判定と同じ作法)。
 */
export function looksLikeParquetName(name: string): boolean {
  return name.trim().toLowerCase().endsWith('.parquet');
}

/**
 * その題名は json 系か。
 * 🔑 **`.ndjson` / `.jsonl` も受ける** ── 1 行 1 件の形は DuckDB が
 * `read_json_auto` でそのまま読む(段④a の実測で `json` 拡張が要ることは確定済み)。
 */
export function looksLikeJsonName(name: string): 'json' | 'ndjson' | null {
  const lower = name.trim().toLowerCase();
  if (lower.endsWith('.ndjson') || lower.endsWith('.jsonl')) return 'ndjson';
  if (lower.endsWith('.json')) return 'json';
  return null;
}

/**
 * 題名から、開き方を決める。
 *
 * @returns `null` = **どれでもない**(取り込めない題名)。
 * 🔴 **2026-10-02(#682 段④d)に変わった**:以前は `.sqlite` も `null`(「画像としてそのまま開く」
 *   既定の道)だったが、DuckDB が `.sqlite` を読めるようになり、**選び所が `null` と
 *   「取り込めない題名」を見分けられない**のが障害になった。いまは `.sqlite` は
 *   `{ kind: 'sqlite' }` を返す(⚠ 内蔵の sqlite へ渡すときは `sqliteConvertSourceOf` が
 *   `undefined` = 画像として開く、へ畳む)。
 */
export function sqlGuestSourceOf(lid: string, name: string): SqlGuestSource | null {
  const lang = looksLikeCsvAttachmentName(name);
  if (lang !== null) return { kind: 'csv', lang, lid, name };
  if (looksLikeXlsxAttachmentName(name)) return { kind: 'xlsx', lid, name };
  if (looksLikeParquetName(name)) return { kind: 'parquet', lid, name };
  const json = looksLikeJsonName(name);
  if (json !== null) return { kind: 'json', lang: json, lid, name };
  // 🔴 最後に当てる ── 拡張子の見分けが上の 4 つと重ならない順(`.db` は他と重ならないが、念のため末尾)
  if (looksLikeSqliteName(name)) return { kind: 'sqlite', lid, name };
  return null;
}

/**
 * 🔴 **「手持ちのファイルを開く…」で選ばせてよい拡張子**(`accept` に出す字)。
 *
 * ⚠ ここと `sqlGuestSourceOf` が食い違うと、user から見て 2 通りの事故になる ──
 *   ①**選べるのに必ず断られる**(accept に在って、判定が知らない)
 *   ②**開けるのに file 選択画面に出てこない**(判定は知っているが、accept に無い)。
 * 🔑 食い違っていないことは `tests/adapter/sql-source-parity.test.ts` が見る。
 */
export const SQL_GUEST_EXTS: readonly string[] = [
  ...SQLITE_EXTS,
  '.csv',
  '.tsv',
  '.xlsx',
  // 🔴 DuckDB でしか読めない相手(#682 段④c)
  '.parquet',
  '.json',
  '.ndjson',
  '.jsonl',
];

/**
 * 🔴 **添付のノートから、DuckDB でしか読めない相手を拾う**(#682 段④c)。
 *
 * ⚠ **`sqlSourcesOf` / `csvAttachmentSourcesOf` / `xlsxAttachmentSourcesOf` と
 *   同じ形**で返す(選び所は 1 つの `<select>` に並べるので、器を分けない)。
 * 🔑 **見分けは `sqlGuestSourceOf` と `isDuckDbOnlySource` を通す** ── ここで
 *   `.parquet` を自前に書き直すと、判定がまた 2 つに割れる(§7)。
 *   だから拡張子を 1 つ足すのは `looksLike…` の側だけで済み、
 *   選び所は**何もしなくても追随する**。
 * ⚠ 並びは題名順(ほかの 3 本と同じ理由 ── 入れ直すたびに場所が変わらない)。
 */
export function duckDbOnlySourcesOf(
  metas: Iterable<{ readonly lid: string; readonly title: string; readonly archetype: string }>,
): SqlSource[] {
  const out: SqlSource[] = [];
  for (const m of metas) {
    if (m.archetype !== 'attachment') continue;
    if (!isDuckDbOnlySource(sqlGuestSourceOf(m.lid, m.title))) continue;
    out.push({ lid: m.lid, name: m.title });
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
