/**
 * 🔴 **本文の csv の囲みを、SQL から引ける表にする**(#681 段③)。
 *
 * user の言葉(2026-09-03):
 * > **内蔵の sqlite を最大限活用したインスタントな csv や sqliteDB のクエリアプリ**
 *
 * 段①② で「打つ口」は配った。⚠ ところが **csv は引けなかった** ── 打てるのは
 * `entries` などの内部の表だけで、user が本文に書いた表は**字のまま**だった。
 *
 * ## 決め方(なぜこの形か)
 *
 * 🔑 **名前を付けた囲みだけが表になる。** ` ```csv name=売上 ` と書くと、
 * SQL から `SELECT * FROM 売上` で引ける。
 *
 * ⚠ **名前を必須にした理由**は 2 つ:
 * ① 名前が無いと**呼び名が無い**(「3 つ目のノートの 2 つ目の表」では打てない)
 * ② 名前で**選べる**ので、引かない表を組み立てずに済む(本文を全部読むのは重い)
 *
 * ⚠ **記法は 1 バイトも減らしていない** ── `name=` は**足しただけ**で、
 *   既に書いてある囲みの見え方は変わらない(`detectCsvLang` は 1 語目しか見ず、
 *   `isHeaderDisabled` は `noheader` しか見ない ── 実測で確かめた)。
 *
 * ## 同じ名前が複数あるとき ── **積む**(捨てない)
 *
 * 🔴 後から書いた方で**上書きしない**。同じ名前の囲みは 1 つの表に**積む**
 * (月ごとの表を同じ名前で書けば、そのまま合算できる)。
 * 🔑 だから列の頭に **`_note`(ノートの題名)と `_lid`** を必ず足す ── どの行が
 * どこから来たかを、user が SQL で分けられるようにするため。
 * ⚠ 列が食い違う囲みは**和集合**にし、無い所は `NULL` にする ── 列を落とすと
 *   「書いたのに引けない」になり、**その方が気づけない**。
 *
 * ## 値は全部 TEXT
 *
 * ⚠ csv の升は字である ── 数に見えるものを勝手に数へ直すと、`007` が `7` になり、
 *   `1-2` が日付になる端末差まで背負う。数えたい人は `CAST(x AS INTEGER)` と書く
 *   (それは SQL を打つ人の語彙の中に在る)。
 */
import { fenceInfo, quoteLead, type FenceSpan } from '@features/markdown/source-blocks';
import { fencesBelowFrontmatter } from '@features/markdown/table-convert';
import {
  DELIMITER,
  detectCsvLang,
  isHeaderDisabled,
  parseCsv,
} from '@features/markdown/csv-table';

/** 名前の長さの上限。⚠ SQL に打つ物なので、画面と口の両方で扱える長さにする。 */
export const CSV_TABLE_NAME_MAX = 40;

/**
 * 🔴 **組み立てる升の総数の上限**(#681 段③)。
 *
 * ⚠ ここが無いと、大きな csv を 1 つ書いただけで **worker が固まる**
 *   (組み立ては `query_only` を掛ける**前**に走るので、見張りが効かない)。
 * 🔑 超えたら**断る** ── 黙って切ると「行が足りない答え」が出て、
 *   それは 0 行より気づけない(§4「上流だけ見た『動いている』」と同じ向き)。
 */
export const CSV_TABLE_CELLS_MAX = 200_000;

/** どの行がどこから来たかの列(必ず先頭に付く)。 */
export const CSV_SOURCE_COLUMNS = ['_note', '_lid'] as const;

/** 名前つきの csv の囲み 1 つ。 */
export interface CsvTableBlock {
  readonly name: string;
  readonly lid: string;
  readonly noteTitle: string;
  readonly columns: readonly string[];
  readonly rows: readonly (readonly string[])[];
}

/** 同じ名前の囲みを積んだ、1 つの表。 */
export interface CsvTable {
  readonly name: string;
  /** `_note` / `_lid` を先頭に含む。 */
  readonly columns: readonly string[];
  readonly rows: readonly (readonly (string | null)[])[];
  /** 積んだ囲みの数(1 より大きければ、複数のノートから来ている)。 */
  readonly blocks: number;
}

/**
 * 見出しから表の名前を読む。
 *
 * @returns 名前(` ```csv name=売上 ` なら `売上`)。無ければ / 使えない字なら `null`。
 * ⚠ **`null` と空文字を分けない** ── どちらも「表にしない」である。
 */
export function csvTableNameOf(info: string | null | undefined): string | null {
  const raw = csvTableNameRaw(info);
  return raw !== null && validCsvTableName(raw) ? raw : null;
}

/**
 * 🔴 **書かれた字をそのまま返す**(受けられるかは見ない)。
 *
 * ⚠ これが要るのは**断った理由を言うため**である ── 受けない名前を黙って
 *   落とすと、user には「表が出てこない」しか見えず、**なぜ出ないのかが
 *   画面のどこにも無い**(CLAUDE.md §4「いちばん気づけない外し方」)。
 * 🔑 目録(`csv_tables`)は、この字を `why` 付きで並べる。
 */
export function csvTableNameRaw(info: string | null | undefined): string | null {
  if (typeof info !== 'string' || info === '') return null;
  for (const token of info.trim().split(/\s+/).slice(1)) {
    if (!token.toLowerCase().startsWith('name=')) continue;
    return token.slice('name='.length);
  }
  return null;
}

/**
 * 🔴 **受けられない理由を、画面の言葉で 1 行にする**(#681 段③)。
 * @returns 受けられるなら `''`。
 */
export function csvTableNameWhy(raw: string): string {
  if (raw === '') return '名前が空です(name= のあとに名前を書いてください)';
  if (raw.length > CSV_TABLE_NAME_MAX)
    return `名前が長すぎます(${String(CSV_TABLE_NAME_MAX)} 字まで)`;
  if (raw.toLowerCase().startsWith('sqlite_'))
    return 'sqlite_ で始まる名前は使えません(中の仕組みが使っています)';
  for (const ch of raw) {
    const code = ch.charCodeAt(0);
    if (code >= 0xff01 && code <= 0xff5e)
      return '全角の英数字は使えません(打つと半角に直るので引けなくなります)。半角で書くか、漢字・かなにしてください';
  }
  if (!validCsvTableName(raw))
    return '名前に使えるのは文字・数字・_ だけです(空白と記号は使えません)';
  return '';
}

/**
 * 🔴 **SQL に打てる名前か**。
 *
 * ⚠ 引用符と空白を弾くのは飾りではない ── 名前は `"…"` で括って
 *   `CREATE TEMP TABLE` に渡すので、`"` が混ざると**別の SQL になる**。
 * ⚠ `sqlite_` で始まる名前は engine の予約である(作れずに落ちる)。
 */
export function validCsvTableName(name: string): boolean {
  if (name === '' || name.length > CSV_TABLE_NAME_MAX) return false;
  if (name.toLowerCase().startsWith('sqlite_')) return false;
  /**
   * 🔴 **全角の英数字は名前にしない**(#681 段③、`sql-guard.ts` と噛み合わせる)。
   *
   * ⚠ 打った SQL は走らせる前に**全角 → 半角へ直される**(`normalizeSqlInput`。
   *   直すのは U+FF01〜U+FF5E)。だから ` ```csv name=ｓａｌｅｓ ` と書いた表は
   *   **どう打っても引けない** ── user が `ｓａｌｅｓ` と打っても `sales` に直り、
   *   `sales` と打っても名前が違う。⚠ そのとき出るのは「そんな表は無い」だけで、
   *   **なぜ無いのかは画面のどこにも出ない**(いちばん気づけない形)。
   * 🔑 だから**受けない** ── 受けなければ「名前を付けていない囲み」と同じ扱いになり、
   *   user は目録(`csv_tables`)に出ないことで気づける。
   * ⚠ 漢字・かなは直されないので**そのまま使える**(`売上` は通る)。
   */
  for (const ch of name) {
    const code = ch.charCodeAt(0);
    if (code >= 0xff01 && code <= 0xff5e) return false;
  }
  // ⚠ 引用符 / 括弧 / 記号 / 空白は入れない(打つときに括らずに済む字だけ)
  return /^[\p{L}\p{N}_][\p{L}\p{N}_]*$/u.test(name);
}

/**
 * 🔴 **升の見出しを列の名前に直す**。
 *
 * ⚠ 空の見出し・重なった見出しをそのまま使うと、engine が
 *   `duplicate column name` で落ちる ── そのとき user に出るのは
 *   **自分が打っていない SQL の文句**なので、ここで必ず直す。
 */
export function csvColumnNames(header: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>(CSV_SOURCE_COLUMNS);
  header.forEach((raw, i) => {
    const base = raw.trim().replace(/[^\p{L}\p{N}_]/gu, '_') || `col${String(i + 1)}`;
    let name = base;
    let n = 2;
    while (seen.has(name)) {
      name = `${base}_${String(n)}`;
      n += 1;
    }
    seen.add(name);
    out.push(name);
  });
  return out;
}

/** 囲みの中身(引用の前置きを剥がした字)。⚠ 剥がせない行は**この囲みの中身ではない**。 */
function fenceText(lines: readonly string[], span: FenceSpan): string {
  const last = span.open ? span.end : span.end - 1;
  const out: string[] = [];
  for (let i = span.start + 1; i <= last; i += 1) {
    const line = lines[i] ?? '';
    const lead = quoteLead(line, span.quote);
    if (lead === null) continue;
    out.push(line.slice(lead));
  }
  return out.join('\n');
}

/**
 * 本文から、名前つきの csv / tsv / psv の囲みを全部拾う。
 *
 * ⚠ **frontmatter の下から数える**(`fencesBelowFrontmatter`)── 起点を
 *   自前で決め直すと、升を打つ側と食い違う(§7)。
 */
/** 名前を書いたのに受けられなかった囲み(目録で理由を言うため)。 */
export interface CsvTableReject {
  readonly raw: string;
  readonly why: string;
  readonly lid: string;
  readonly noteTitle: string;
  readonly rows: number;
  readonly cols: number;
}

export function collectCsvTables(
  body: string,
  note: { readonly lid: string; readonly title: string },
  /** 受けられなかった囲みを積む先(渡さなければ数えない)。 */
  rejects?: CsvTableReject[],
): CsvTableBlock[] {
  const lines = body.split('\n');
  const out: CsvTableBlock[] = [];
  for (const span of fencesBelowFrontmatter(body)) {
    /**
     * ⚠ **開きの行も引用の前置きを剥がしてから読む**(#775 と同じ作法)──
     *   剥がさずに渡すと `fenceInfo` は `> ` で始まる行を**開きと認めず**、
     *   引用の中の名前つき csv が **1 つも表にならない**(実測で落ちた)。
     */
    const openRaw = lines[span.start] ?? '';
    const openLead = quoteLead(openRaw, span.quote);
    const info = fenceInfo(openLead === null ? openRaw : openRaw.slice(openLead));
    const lang = detectCsvLang(info);
    if (lang === null) continue;
    const raw = csvTableNameRaw(info);
    if (raw === null) continue;
    const grid = parseCsv(fenceText(lines, span), DELIMITER[lang]);
    /**
     * ⚠ **`grid.length === 0` は書かない** ── `parseCsv` は空の入力に `null` を返すので、
     *   0 行の配列は返ってこない(変異試験 C10b が SURVIVED で教えた no-op である)。
     */
    if (grid === null) continue;
    const noHeader = isHeaderDisabled(info);
    const why = csvTableNameWhy(raw);
    if (why !== '') {
      rejects?.push({
        raw,
        why,
        lid: note.lid,
        noteTitle: note.title,
        rows: noHeader ? grid.length : Math.max(0, grid.length - 1),
        cols: grid.reduce((w, r) => Math.max(w, r.length), 0),
      });
      continue;
    }
    const width = grid.reduce((w, r) => Math.max(w, r.length), 0);
    const header = noHeader
      ? Array.from({ length: width }, (_, i) => `col${String(i + 1)}`)
      : (grid[0] ?? []);
    const rows = noHeader ? grid : grid.slice(1);
    out.push({
      name: raw,
      lid: note.lid,
      noteTitle: note.title,
      columns: csvColumnNames(header),
      rows,
    });
  }
  return out;
}

/**
 * 同じ名前の囲みを 1 つの表へ積む。
 *
 * ⚠ **列は和集合**(出現順)。無い所は `null` ── 落とすと「書いたのに引けない」。
 * ⚠ 行の升が列より多い分は**捨てない** ── 名前の無い列(`col<N>`)として足す
 *   …のではなく、**見出しの数までで切る**。⚠ ここは切ってよい:見出しの外の升は
 *   csv としても「どの列か」を持たないので、名前の付けようが無い。
 */
export function mergeCsvTables(blocks: readonly CsvTableBlock[]): CsvTable[] {
  const byName = new Map<string, CsvTableBlock[]>();
  for (const b of blocks) {
    const list = byName.get(b.name);
    if (list === undefined) byName.set(b.name, [b]);
    else list.push(b);
  }
  const out: CsvTable[] = [];
  for (const [name, list] of byName) {
    const columns: string[] = [];
    for (const b of list) for (const c of b.columns) if (!columns.includes(c)) columns.push(c);
    const rows: Array<Array<string | null>> = [];
    for (const b of list) {
      const at = new Map(b.columns.map((c, i) => [c, i]));
      for (const r of b.rows) {
        rows.push([
          b.noteTitle,
          b.lid,
          ...columns.map((c) => {
            const i = at.get(c);
            return i === undefined ? null : (r[i] ?? null);
          }),
        ]);
      }
    }
    out.push({ name, columns: [...CSV_SOURCE_COLUMNS, ...columns], rows, blocks: list.length });
  }
  return out;
}

/**
 * 🔴 **打った SQL に名前が出てくる表だけを選ぶ**。
 *
 * ⚠ ここは**多めに拾ってよい**(組み立てが 1 つ増えるだけ)が、**少なく拾うと
 *   「そんな表は無い」**になる ── 誤差の向きはそちらへ倒さない(§7)。
 * 🔑 だから構文解析はしない ── **字が出てくるか**だけを見る。
 *   ⚠ 名前の前後が字や数字なら別の語である(`売上高` の中の `売上` で拾わない)。
 */
export function csvTablesMentioned(sql: string, names: readonly string[]): string[] {
  const word = /[\p{L}\p{N}_]/u;
  const out: string[] = [];
  for (const name of names) {
    let from = 0;
    for (;;) {
      const at = sql.indexOf(name, from);
      if (at < 0) break;
      const before = at === 0 ? '' : sql[at - 1] ?? '';
      const after = sql[at + name.length] ?? '';
      if (!word.test(before) && !word.test(after)) {
        out.push(name);
        break;
      }
      from = at + 1;
    }
  }
  return out;
}

/**
 * 🔴 **組み立てが重すぎないか**(#681 段③)。
 *
 * ⚠ 組み立ては `PRAGMA query_only` を掛ける**前**に走るので、進み具合の見張りは
 *   まだ張っていない ── つまり**ここで断らないと止められない**。
 * 🔑 **断る。切らない** ── 切ると「行が足りない答え」が出て、それは 0 行より
 *   気づけない(§4「上流だけ見た『動いている』」と同じ向き)。
 *
 * @returns 断る理由(user に見せる字)。組み立ててよければ `null`。
 */
export function csvCellsOverBudget(
  tables: readonly CsvTable[],
  budget = CSV_TABLE_CELLS_MAX,
): string | null {
  let cells = 0;
  for (const t of tables) {
    cells += t.rows.length * t.columns.length;
    if (cells > budget) {
      return `表「${t.name}」が大きすぎます(升 ${String(budget)} 個まで)。囲みを分けるか、名前を分けてください`;
    }
  }
  return null;
}
