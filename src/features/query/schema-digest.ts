/**
 * 🔴 **いま調べている相手の「構造 1 枚」を組む**(#918 段①。user 要望 2026-09-14)。
 *
 * user 要望(こちらの解釈):**AI に渡す用に、DB の構造を吐き出したい。**
 *
 * ## 🔑 中身は 1 文字も出さない
 *
 * ⚠ 出すのは**表の名前・列と型・鍵・繋がり・行数**だけで、
 *   **user が書いた本文は 1 文字も入れません**。
 * 🔑 これは礼儀ではなく**用途に合っている** ── AI に渡したいのは
 *   「どう問い合わせればよいか」であって、中身ではない。
 *
 * ## ⚠ 新しい口を作らない ── ぜんぶ `select` で採れる
 *
 * 🔴 `PRAGMA` は打てません(門の白名簿は `select` / `with` / `values` / `explain`)。
 * 🔑 ですが sqlite は **`pragma_table_info(...)` という表の形**を持っているので、
 *   **ふつうの `select` として**引けます ── だから
 *   **worker にも門にも 1 行も足さずに**構造が採れます。
 * ⚠ これは「抜け道」ではありません:読むだけの問い合わせであり、
 *   `PRAGMA query_only` の下でも通ります(engine の境は 1 ミリも緩めていない)。
 */

/**
 * 表と列を 1 回で採る。
 * ⚠ **`sqlite_` で始まる物は外す**(sqlite 自身の作業表。user の構造ではない)。
 * ⚠ `notnull` / `from` / `to` は予約語なので **`"` で囲う**。
 */
export const SCHEMA_COLUMNS_SQL = [
  'select m.type as kind, m.name as tbl, p.cid as cid, p.name as col,',
  '       p.type as typ, p."notnull" as nn, p.pk as pk',
  '  from sqlite_master m join pragma_table_info(m.name) p',
  " where m.type in ('table','view') and m.name not like 'sqlite_%'",
  ' order by m.type, m.name, p.cid',
].join('\n');

/** 表どうしの繋がり(外部キー)。⚠ 無い DB では 0 行が返る(それでよい)。 */
export const SCHEMA_FK_SQL = [
  'select m.name as tbl, f."table" as ref, f."from" as col, f."to" as refcol',
  '  from sqlite_master m join pragma_foreign_key_list(m.name) f',
  " where m.type = 'table' and m.name not like 'sqlite_%'",
  ' order by m.name, f.id, f.seq',
].join('\n');

/**
 * 🔴 **本文の名前つき csv を、つながり図と構造 1 枚に出す**(#918 段⑤d-2)。
 *
 * ⚠ 本文の csv は **temp の表**なので `sqlite_master` に出ない ── だから
 *   `SCHEMA_COLUMNS_SQL` では**一生見つからない**(箱が 1 つも出てこなかった)。
 * 🔑 worker が毎回組む目録(`csv_tables` / `csv_columns`)から読む。
 * ⚠ **`sqlite_temp_master` は読まない** ── 名前を修飾しない `pragma_table_info` は
 *   **temp を先に解決する**ので、本表と混ざって同じ名前が二重に出る(CLAUDE.md §7)。
 * ⚠ 受けられなかった囲み(`why` が空でない行)は**表ではない**ので外す。
 */
export const SCHEMA_CSV_SQL = [
  'select c.tbl as tbl, c.cid as cid, c.col as col,',
  "       (select sum(t.rows) from csv_tables t where t.name = c.tbl and t.why = '') as n",
  '  from csv_columns c',
  ' order by c.tbl, c.cid',
].join('\n');

/**
 * 行数を 1 回で採る問い合わせを組む。⚠ 表が 0 件なら `null`
 * (**空の `select` を打たない** ── 構文エラーになる)。
 */
export function countsSql(tables: readonly string[]): string | null {
  if (tables.length === 0) return null;
  const parts = tables.map((t) => {
    // ⚠ 名前の中の `"` は **2 つ重ねて**逃がす(sqlite の決まり)
    const q = `"${t.replace(/"/g, '""')}"`;
    // ⚠ 名前そのものも**値として**出す ── 文字列なので `'` を 2 つ重ねる
    const lit = `'${t.replace(/'/g, "''")}'`;
    return `select ${lit} as tbl, count(*) as n from ${q}`;
  });
  return parts.join('\nunion all\n') + '\n order by tbl';
}

/**
 * ノートの題名。⚠ **どこの構造かを題名にも残す**(#837 K3 と同じ理由)──
 * 画面では名札が出ていても、**いちばん長く残るノート**からそれが落ちると、
 * 1 週間後に「何の構造だったか」が読めない。
 */
export function schemaNoteTitle(now: Date, where: string | null = null): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  const stamp =
    `${String(now.getFullYear())}-${p(now.getMonth() + 1)}-${p(now.getDate())}` +
    ` ${p(now.getHours())}:${p(now.getMinutes())}`;
  return where === null || where === ''
    ? `DB の構造 ${stamp}`
    : `DB の構造 ${stamp}(${where})`;
}

/** 1 行ぶんの値。⚠ `runReadOnlySql` が返す形(列名の配列 + 値の配列)に合わせる。 */
export type Cell = string | number | null;
export interface Grid {
  readonly columns: readonly string[];
  readonly rows: readonly (readonly Cell[])[];
}

export interface SchemaDigestInput {
  /** 調べている相手の名前(画面に出ている字)。 */
  readonly source: string;
  readonly columns: Grid;
  readonly fks: Grid;
  /** ⚠ **省略可** ── 行数が採れなかった回は、行数の欄を出さない(嘘を書かない)。 */
  readonly counts?: Grid;
  /**
   * 🔴 **本文の名前つき csv の目録**(#918 段⑤d-2)。⚠ **省略可** ──
   *   客の DB(取り込んだ `.sqlite` / `.csv`)には本文の表が無いので渡らない。
   */
  readonly csv?: Grid;
}

/** `Grid` を「列名 → 値」の連想に開く。⚠ 列の順に依存しない(問い合わせを直しても壊れない)。 */
function asMaps(g: Grid): Record<string, Cell>[] {
  return g.rows.map((r) => {
    const o: Record<string, Cell> = {};
    g.columns.forEach((c, i) => {
      o[c] = r[i] ?? null;
    });
    return o;
  });
}

/** ⚠ 添字で引いた値は `undefined` になりうる(`noUncheckedIndexedAccess`)── 同じ扱いにする。 */
const text = (v: Cell | undefined): string => (v === null || v === undefined ? '' : String(v));

/**
 * 行数を**数**にする。⚠ 数として読めない字は `null`(= 採れなかった扱い)にする ──
 * `count(*)` は必ず整数なので普通は起きないが、**読めない字を「N 行」と書くのは嘘**である。
 */
function rowCount(v: Cell | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * 表 1 つぶんの列。
 * ⚠ **飾らない** ── `type` は採れた字のまま(空なら空)。「(型なし)」のような
 *   **見せ方は読み手が決める**(markdown と ER で違ってよい)。
 */
export interface SchemaColumn {
  readonly name: string;
  readonly type: string;
  readonly notNull: boolean;
  readonly primaryKey: boolean;
}

/**
 * 表の種類。🔴 **`csv` は本文の名前つき csv**(#918 段⑤d-2)── DB の中の表ではなく、
 * 引くたびに組み立てられる temp の表である(だから鍵も型も持たない)。
 */
export type SchemaKind = 'table' | 'view' | 'csv';

/**
 * 🔑 **種類を画面の言葉にするのは、ここ 1 か所**(CLAUDE.md §7)──
 * つながり図と markdown で別の字を出さない。
 */
export function schemaKindLabel(kind: SchemaKind): string {
  if (kind === 'view') return 'ビュー';
  if (kind === 'csv') return '本文の表';
  return '表';
}

/** 表(またはビュー)1 つ。 */
export interface SchemaTable {
  readonly name: string;
  readonly kind: SchemaKind;
  /** ⚠ 採れなかった回は `null`。**0 と区別する** ── `0` は「採れて 0 行」である。 */
  readonly rows: number | null;
  readonly columns: readonly SchemaColumn[];
}

/** 外部キー 1 本。⚠ `toColumn` は空のことがある(相手の主キーを指す書き方)。 */
export interface SchemaLink {
  readonly from: string;
  readonly fromColumn: string;
  readonly to: string;
  readonly toColumn: string;
}

export interface SchemaModel {
  readonly tables: readonly SchemaTable[];
  readonly links: readonly SchemaLink[];
}

/**
 * 🔴 **採ってきた 3 枚の表を「構造そのもの」へ畳む**(#918 段⑤a)。
 *
 * ⚠ **markdown も ER も、ここから作る** ── 同じ問いに答える口を 2 つ作らないため
 *   (CLAUDE.md §7「同じ値・同じ判定が複数の場所にある」)。
 *   `renderSchemaDigest` は**この値を読むだけ**にしてある。
 *
 * ⚠ 並びは**採ってきた順のまま**(`SCHEMA_COLUMNS_SQL` の
 *   `order by m.type, m.name, p.cid` が決めている)── ここでは並べ替えない。
 * 🔑 ER の並べ替えは**この値を受け取ってから**やる(`erLayout()`、段⑤b)。
 */
export function schemaModel(input: SchemaDigestInput): SchemaModel {
  const countOf = new Map<string, number | null>();
  for (const c of input.counts ? asMaps(input.counts) : []) {
    countOf.set(text(c['tbl']), rowCount(c['n']));
  }

  const order: string[] = [];
  const byTable = new Map<string, SchemaColumn[]>();
  const kindOf = new Map<string, 'table' | 'view'>();
  for (const c of asMaps(input.columns)) {
    const t = text(c['tbl']);
    if (!byTable.has(t)) {
      byTable.set(t, []);
      order.push(t);
      // ⚠ `view` 以外は全部「表」へ寄せる(綴りの正規化はここ 1 か所でやる)
      kindOf.set(t, text(c['kind']) === 'view' ? 'view' : 'table');
    }
    byTable.get(t)!.push({
      name: text(c['col']),
      type: text(c['typ']),
      notNull: String(c['nn']) === '1',
      primaryKey: String(c['pk']) !== '0' && text(c['pk']) !== '',
    });
  }

  /**
   * 🔴 **本文の csv の表を、後ろに足す**(#918 段⑤d-2)。
   * ⚠ **本表と同じ名前は足さない** ── temp は本表を隠すので、図に 2 つ出すと
   *   「いま押しているのはどちらか」が読めなくなる(`CSV_TABLE_RESERVED` が
   *   この PKC の表名を断っているので、普通は起きない ── 起きたときに備える)。
   * ⚠ 型も鍵も持たせない ── csv の見出しには型が書けない。**無い物を書かない**。
   */
  const csvOrder: string[] = [];
  const csvCols = new Map<string, SchemaColumn[]>();
  const csvRows = new Map<string, number | null>();
  for (const c of input.csv ? asMaps(input.csv) : []) {
    const t = text(c['tbl']);
    if (t === '' || byTable.has(t)) continue;
    if (!csvCols.has(t)) {
      csvCols.set(t, []);
      csvOrder.push(t);
      csvRows.set(t, rowCount(c['n']));
    }
    csvCols.get(t)!.push({ name: text(c['col']), type: '', notNull: false, primaryKey: false });
  }

  return {
    tables: [
      ...order.map((t) => ({
        name: t,
        kind: kindOf.get(t) ?? ('table' as SchemaKind),
        rows: countOf.get(t) ?? null,
        columns: byTable.get(t) ?? [],
      })),
      ...csvOrder.map((t) => ({
        name: t,
        kind: 'csv' as SchemaKind,
        rows: csvRows.get(t) ?? null,
        columns: csvCols.get(t) ?? [],
      })),
    ],
    // ⚠ 相手の名前が空の行は落とす(繋がりとして読めない)
    links: asMaps(input.fks)
      .filter((f) => text(f['tbl']) !== '')
      .map((f) => ({
        from: text(f['tbl']),
        fromColumn: text(f['col']),
        to: text(f['ref']),
        toColumn: text(f['refcol']),
      })),
  };
}

/**
 * 構造を **markdown 1 枚**にする。
 *
 * ⚠ **AI にそのまま貼れること**が目的なので、飾りではなく**情報の密度**で書く ──
 *   表ごとに 1 つの塊、列は 1 行 1 列、繋がりは矢印で。
 * 🔑 **行数を先に書く**(AI は「どれが本体か」をそれで当てる)。
 */
export function renderSchemaDigest(input: SchemaDigestInput): string {
  // 🔑 組み立ては `schemaModel()` 1 か所。ここは**見せ方だけ**を持つ
  const model = schemaModel(input);

  const out: string[] = [];
  out.push(`# ${input.source} の構造`);
  out.push('');
  if (model.tables.length === 0) {
    // ⚠ **空でも 1 枚を出す** ── 押して無反応にしない(理由を字で言う)
    out.push('表もビューも 1 つもありません。');
    return out.join('\n');
  }
  out.push(`表 / ビュー / 本文の表: ${model.tables.length} 件`);
  out.push('');

  for (const t of model.tables) {
    const kind = schemaKindLabel(t.kind);
    const head = t.rows === null ? `## ${t.name}(${kind})` : `## ${t.name}(${kind}・${t.rows} 行)`;
    out.push(head);
    out.push('');
    out.push('| 列 | 型 | 空を許すか | 鍵 |');
    out.push('|---|---|---|---|');
    for (const c of t.columns) {
      const typ = c.type === '' ? '(型なし)' : c.type;
      const nn = c.notNull ? '不可' : '可';
      const pk = c.primaryKey ? '主キー' : '';
      out.push(`| ${c.name} | ${typ} | ${nn} | ${pk} |`);
    }
    out.push('');
  }

  if (model.links.length > 0) {
    out.push('## 表どうしの繋がり');
    out.push('');
    for (const f of model.links) {
      const to = f.toColumn === '' ? f.to : `${f.to}.${f.toColumn}`;
      out.push(`- ${f.from}.${f.fromColumn} → ${to}`);
    }
    out.push('');
  }

  /**
   * ⚠ **何が入っていないかを書く** ── AI は「書いていない = 無い」と読むので、
   *   **中身を出していないこと**を明示しないと、空の DB と区別できない。
   */
  out.push('---');
  out.push('');
  out.push('⚠ ここに在るのは構造だけです(中身は 1 行も含まれていません)。');
  // ⚠ 見るのは**渡されたか**であって、模型の `rows` ではない ── 表が 0 件の DB でも
  //    「採れなかった」とは書かない(採れて 0 件と、採れなかったのは別の話である)
  if (!input.counts) out.push('⚠ 行数は採れませんでした。');
  return out.join('\n');
}
