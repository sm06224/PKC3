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
import { SQLITE_EXTS, type SqlSource } from './sqlite-attachment';
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
export const SQLITE_READABLE_KINDS = ['csv', 'xlsx'] as const;

/** sqlite worker が受け取れる相手(上の一覧で切り出した形)。 */
export type SqliteReadableGuestSource = Extract<
  SqlGuestSource,
  { readonly kind: (typeof SQLITE_READABLE_KINDS)[number] }
>;

/**
 * 🔴 **DuckDB が中身を読める種類**(#682 段④c)。
 *
 * 🔑 **一覧をここに 1 つだけ持つ** ── ①どのエンジンを選べるか(`sqlEngineHint`)
 *   ②走らせる側が組む `FROM …`(`duckdb-runner.ts`)が、**同じ一覧から派生する**。
 * ⚠ 2 か所に書くと「**選び所は DuckDB を出すのに、押すと組み方が分からない**」
 *   (あるいはその逆で、読めるのに選べない)が生まれる ── CLAUDE.md §7。
 * ⚠ `.xlsx` は入れない(`excel` 拡張を同梱していない)/ `.sqlite` も入れない
 *   (`sqlite_scanner` を器の中で当てる段がまだ無い ── #682 の次の段)。
 */
export const DUCKDB_READABLE_KINDS = ['csv', 'parquet', 'json'] as const;

/** DuckDB へ渡せる相手(上の一覧で切り出した形)。 */
export type DuckDbReadableGuestSource = Extract<
  SqlGuestSource,
  { readonly kind: (typeof DUCKDB_READABLE_KINDS)[number] }
>;

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
 * 🔑 **`duckdb-runner.ts` も同じこの関数を呼ぶ** ── 画面が「表 ◯ 個」と言う名前と、
 *   器が実際に `CREATE TABLE` する名前が**同じ 1 か所**から出るので、
 *   「画面に出ている名前で引けない」が構造から消えている。
 */
export function guestTableNameOf(src: DuckDbReadableGuestSource): string {
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
 * @returns `null` = **`.sqlite` の image としてそのまま開く**(今までどおり)。
 *   ⚠ `.sqlite` を名指しで判定しない ── 判定するのは「ほかの読み方が要る物」だけで、
 *   それ以外は既定の道へ落ちる(拡張子の一覧を 2 か所で持たずに済む)。
 */
export function sqlGuestSourceOf(lid: string, name: string): SqlGuestSource | null {
  const lang = looksLikeCsvAttachmentName(name);
  if (lang !== null) return { kind: 'csv', lang, lid, name };
  if (looksLikeXlsxAttachmentName(name)) return { kind: 'xlsx', lid, name };
  if (looksLikeParquetName(name)) return { kind: 'parquet', lid, name };
  const json = looksLikeJsonName(name);
  if (json !== null) return { kind: 'json', lang: json, lid, name };
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
