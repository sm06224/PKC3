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
 * ## 値は字。ただし「列の全部が素直な数」の列だけは数の列にする
 *
 * ⚠ csv の升は字である ── 数に見えるものを勝手に数へ直すと、`007` が `7` になり、
 *   `1-2` が日付になる端末差まで背負う。
 * 🔴 **例外は 1 つだけ**(#1163 依頼 221。user 裁定 2026-11-15 = 原文の中身)── 列の**全部の**升が、数にして字へ戻しても
 *   **同じ字になる**素直な数(`120` / `-3.5` / `0`)のときだけ、その列を数の列にする。字のままだと「金額」を大きい順に
 *   並べると `9` が `100` より前に来る。⚠ `007` / `1.50` / `+3` / `1e3` / `1,200` が 1 つでも混ざる列は字のまま
 *   (数にすると見える字が変わる ── 表示を変えないことを優先する)。判定は {@link numericColumns} の 1 本。
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


/**
 * 🔴 **この名前は取らせない**(#681 段③、着地前の自己レビューで見つけた)。
 *
 * ⚠ temp の表は**同じ名前の本表を隠す** ── ` ```csv name=entries ` と書いた人が
 *   `SELECT * FROM entries` を打つと、**ノートではなく自分の csv が出る**。
 *   本人は「ノートを数えたつもり」なので、⚠ **答えが違うことに気づけない**。
 * ⚠ `csv_tables` も同じ ── 取られると**名前を知る道が消える**(目録が上書きされる)。
 * 🔑 だから**名前の側で断る**(理由は `csv_tables` の `why` に出る)。
 *
 * ⚠ **この一覧は `schema.ts` と揃っていなければならない** ── 揃っているかは
 *   `tests/adapter/csv-table-reserved.test.ts` が**両方を読んで**検める(§7)。
 *   features 層から adapter 層は import できないので、写しをここに置く形になる。
 */
export const CSV_TABLE_RESERVED: readonly string[] = [
  'csv_tables',
  // ⚠ 列の名前の目録(#918 段⑤d-2)── 取られると、つながり図が本文の表を見失う
  'csv_columns',
  'containers',
  'entries',
  'entries_fts',
  // ⚠ 本文検索が「索引に入れる字」を読む視点(台帳 #1852 の束 B2)── 取られると、索引を作り直す `rebuild` が別の物を読む
  'entries_fts_src',
  'relations',
  'revisions',
  'assets',
  'settings',
  'flags',
  'workspaces',
];

/**
 * 🔑 **名前を付けていない囲みの既定の表名**(#681 の残り「`name=` を付けなくても引ける案」)。
 *
 * 名前を付けていない csv / tsv / psv の囲みは、全ノート分まとめて `csv` という 1 つの表に積まれる
 * (`SELECT * FROM csv`)。出所は `_note` / `_lid` で分かる。⚠ 打った SQL に `csv` が出る回だけ組み立てる
 * (名前を付けた表と同じ「引く物だけ作る」規律)。名前を付けた囲みが `name=csv` を名乗れば同じ表に積まれる。
 */
export const CSV_DEFAULT_TABLE = 'csv';

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
  if (CSV_TABLE_RESERVED.includes(raw.toLowerCase()))
    return `${raw} は中の仕組みが使っている名前です(同じ名前にすると、その表が隠れて別の結果が出ます)。別の名前にしてください`;
  for (const ch of raw) {
    const code = ch.charCodeAt(0);
    if (code >= 0xff01 && code <= 0xff5e)
      return '全角の英数字は使えません(打つと半角に直るので実行できなくなります)。半角で書くか、漢字・かなにしてください';
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
  if (CSV_TABLE_RESERVED.includes(name.toLowerCase())) return false;
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
 *
 * @param reserved 🔴 **こちらが先に使う列の名前**(`_note` / `_lid` …)。
 *   見出しがこれに当たったら `_note_2` のように逃がす。
 *   ⚠ **省略可にしない** ── 呼び手ごとに先取りする列が違う(xlsx は `_sheet` も
 *   持つ)ので、既定を置くと**足した人が渡し忘れた面だけ静かにぶつかる**
 *   (`duplicate column name` は user の SQL の文句として出る)。
 */
export function csvColumnNames(
  header: readonly string[],
  reserved: readonly string[],
): string[] {
  const out: string[] = [];
  // 🔴 大文字小文字を区別せずに重なりを見る(`ID` と `id` は sqlite では同じ列名 ── 区別すると
  //   `duplicate column name` で落ちる)。⚠ 畳むのは ASCII だけ(sqlite の照合と同じ。`É` と `é` は別の名前)
  const fold = (s: string): string => s.replace(/[A-Z]/g, (c) => c.toLowerCase());
  const seen = new Set<string>(reserved.map(fold));
  header.forEach((raw, i) => {
    const base = raw.trim().replace(/[^\p{L}\p{N}_]/gu, '_') || `col${String(i + 1)}`;
    let name = base;
    let n = 2;
    while (seen.has(fold(name))) {
      name = `${base}_${String(n)}`;
      n += 1;
    }
    seen.add(fold(name));
    out.push(name);
  });
  return out;
}

/**
 * 🔴 **見出しより升の多い行の余りを、捨てずに「列3」「列4」の列にする**(台帳 #1852 束 R1、依頼 263 A)。
 *
 * 見出しが `a,b` の csv に `1,2,3,4` の行があると、3 と 4 は表に出ず、何も知らされなかった。
 * 字を 1 つも捨てないよう、余った位置に `列<位置>` の名前の列を追加する。見出しより升の少ない行は今までどおり空(`null`)。
 * ⚠ 名前の重なりは `csvColumnNames` が `_2` で逃がす(見出しに「列3」があっても壊れない)。
 */
export function widenHeader(header: readonly string[], width: number): string[] {
  if (header.length >= width) return [...header];
  const out = [...header];
  for (let i = header.length; i < width; i++) out.push(`列${String(i + 1)}`);
  return out;
}

/**
 * 列の名前の重なりを `_2` `_3` で逃がす(大文字小文字は区別しない)。
 * 🔑 `csvColumnNames` は見出しを整える所までやる ── 整えずに重なりだけを直したい面
 *   (JSON の書き出し)はこちら。
 */
export function dedupeColumnNames(names: readonly string[]): string[] {
  const seen = new Set<string>();
  return names.map((base) => {
    let name = base;
    let n = 2;
    while (seen.has(name.replace(/[A-Z]/g, (c) => c.toLowerCase()))) {
      name = `${base}_${String(n)}`;
      n += 1;
    }
    seen.add(name.replace(/[A-Z]/g, (c) => c.toLowerCase()));
    return name;
  });
}

/** 囲みの中身(引用の前置きを剥がした字)。⚠ 剥がせない行は**この囲みの中身ではない**。🔑 ノート内データフロー(`features/dataflow/`)も同じ 1 本で読む。 */
export function fenceText(lines: readonly string[], span: FenceSpan): string {
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
  /** 🔑 名前の無い囲みを既定の表名(`CSV_DEFAULT_TABLE`)で拾うか(既定は拾わない)。 */
  options?: { readonly unnamed?: boolean },
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
    const named = csvTableNameRaw(info);
    if (named === null && options?.unnamed !== true) continue;
    const raw = named ?? CSV_DEFAULT_TABLE;
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
      : widenHeader(grid[0] ?? [], width);
    const rows = noHeader ? grid : grid.slice(1);
    out.push({
      name: raw,
      lid: note.lid,
      noteTitle: note.title,
      columns: csvColumnNames(header, CSV_SOURCE_COLUMNS),
      rows,
    });
  }
  return out;
}

/**
 * 同じ名前の囲みを 1 つの表へ積む。
 *
 * ⚠ **列は和集合**(出現順)。無い所は `null` ── 落とすと「書いたのに引けない」。
 * 🔴 行の升が見出しより多い分は**捨てない**(依頼 263 A)── 読む側(`widenHeader`)が
 *   `列3` `列4` の名前の列として足している。以前は「どの列か分からない」と切っていた。
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
    /**
     * 🔴 **列の重複除去は `Set` で見る**(#968。2026-09-16)。
     *
     * ⚠ 直す前は `columns.includes(c)` を列ごとに回しており、**列数の 2 乗**だけ
     *   比べていた。実測(データ行 0 行・列だけの表):
     *
     * | 列 | 直す前 |
     * |---|---|
     * | 8,000 | **200.4 ms** |
     * | 16,000 | 554.5 ms |
     * | 32,000 | 🔴 **2,510.1 ms** |
     *
     * 🔴 これは**その本文を書いた後、どんな軽い問い合わせを打っても毎回**掛かる
     *   (`buildCsvTables` は打った SQL に関係なく走る)── user には
     *   「SQL の面が重い」としか見えない。
     * 🔑 **出る結果は 1 バイトも変わらない** ── 同じ順で、同じ列が並ぶ
     *   (`Set` は「見たかどうか」だけに使い、並びは `columns` が持つ)。
     */
    const columns: string[] = [];
    const seen = new Set<string>();
    for (const b of list) {
      for (const c of b.columns) {
        if (seen.has(c)) continue;
        seen.add(c);
        columns.push(c);
      }
    }
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
    // 🔴 #968: 行が 0 でも「1 行ぶん」と数える ── 見出しだけの広い表が `0 × 列数 = 0` で素通りしていた
    cells += Math.max(1, t.rows.length) * t.columns.length;
    if (cells > budget) {
      return `表「${t.name}」が大きすぎます(セル ${String(budget)} 個まで)。ブロックを分けるか、名前を分けてください`;
    }
  }
  return null;
}

/**
 * 🔴 **添付の 1 枚(file / 枚)の幅が、升の上限そのものを超えていないか**(#968)。
 *
 * ⚠ 添付は行を `cellBudget / 列数` 件で切るが、**列数が上限を超えると 1 行も載らない上に、
 *   データ行 0 行なら切る対象が無く素通りする**。1 行ぶんすら入らない幅は、切らずに**断る**。
 * 🔑 判断は `csvCellsOverBudget`(行 0 でも 1 行と数える)と同じ向き ── 呼び側 3 経路で 1 本にする。
 *
 * @throws 幅が上限を超えるとき(user に見せる字)
 */
export function assertCsvWidthWithinBudget(columnCount: number, budget: number): void {
  if (columnCount > budget) {
    throw new Error(
      `列が多すぎて大きすぎます(${String(columnCount)} 列。セル ${String(budget)} 個まで)。列を分けてください`,
    );
  }
}

/**
 * 🔴 **入れる値**(#1163 依頼 221 の着地前レビュー 🔴1)── 数の列の空の升は `NULL` にする。
 * ⚠ 字の `''` のまま数の列に入れると、SQLite では字が数より大きいので、`max()` が空・`> 50` に空の行が混ざる・
 *   大きい順の先頭が空になる。字の列はそのまま(空は空の字)。
 */
export function rowForInsert(row: readonly (string | null)[], numeric: readonly boolean[]): (string | null)[] {
  return row.map((v, i) => (numeric[i] === true && (v === '' || v === undefined) ? null : (v ?? null)));
}

/**
 * 🔴 **数の列にしてよい列か**(#1163 依頼 221)── 空でない升が 1 つ以上あり、空でない升が全部「数にして字へ戻しても同じ字」。
 * ⚠ 空の升(`''` / `null`)は判定から外す(空のセルを含む数の列はよくある)。
 * @returns 列ごとに `true`(数の列)/ `false`(字の列)
 */
export function numericColumns(
  columns: readonly string[],
  rows: readonly (readonly (string | null)[])[],
): boolean[] {
  return columns.map((name, c) => {
    // ⚠ 出所の列(`_note` / `_lid` / 枚の名前)はいつも字 ── 題名が `2026` のノートで数にしない(着地前レビュー ⚠2)
    if (name.startsWith('_')) return false;
    let seen = false;
    for (const row of rows) {
      const v = row[c];
      if (v === null || v === undefined || v === '') continue;
      if (!isCanonicalNumber(v)) return false;
      seen = true;
    }
    return seen;
  });
}

/** 数にして字へ戻しても同じ字になる素直な 10 進数か(`007` / `1.50` / `+3` / `1e3` / 前後の空白は違う)。 */
export function isCanonicalNumber(v: string): boolean {
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(v)) return false;
  // ⚠ 有効数字 15 桁まで(着地前レビュー ⚠3)── それより長い字は SQLite の数の書き戻し(`json_quote` など)で字が変わる
  if (v.replace(/^-/, '').replace('.', '').replace(/^0+/, '').length > 15) return false;
  const n = Number(v);
  return Number.isFinite(n) && String(n) === v;
}

