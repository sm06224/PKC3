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
 * 構造を **markdown 1 枚**にする。
 *
 * ⚠ **AI にそのまま貼れること**が目的なので、飾りではなく**情報の密度**で書く ──
 *   表ごとに 1 つの塊、列は 1 行 1 列、繋がりは矢印で。
 * 🔑 **行数を先に書く**(AI は「どれが本体か」をそれで当てる)。
 */
export function renderSchemaDigest(input: SchemaDigestInput): string {
  const cols = asMaps(input.columns);
  const fks = asMaps(input.fks);
  const counts = input.counts ? asMaps(input.counts) : null;
  const countOf = new Map<string, Cell>();
  for (const c of counts ?? []) countOf.set(text(c['tbl']), c['n'] ?? null);

  const order: string[] = [];
  const byTable = new Map<string, Record<string, Cell>[]>();
  const kindOf = new Map<string, string>();
  for (const c of cols) {
    const t = text(c['tbl']);
    if (!byTable.has(t)) {
      byTable.set(t, []);
      order.push(t);
      kindOf.set(t, text(c['kind']));
    }
    byTable.get(t)!.push(c);
  }

  const out: string[] = [];
  out.push(`# ${input.source} の構造`);
  out.push('');
  if (order.length === 0) {
    // ⚠ **空でも 1 枚を出す** ── 押して無反応にしない(理由を字で言う)
    out.push('表もビューも 1 つもありません。');
    return out.join('\n');
  }
  out.push(`表 / ビュー: ${order.length} 件`);
  out.push('');

  for (const t of order) {
    const kind = kindOf.get(t) === 'view' ? 'ビュー' : '表';
    const n = countOf.get(t);
    const head = n === undefined || n === null ? `## ${t}(${kind})` : `## ${t}(${kind}・${n} 行)`;
    out.push(head);
    out.push('');
    out.push('| 列 | 型 | 空を許すか | 鍵 |');
    out.push('|---|---|---|---|');
    for (const c of byTable.get(t) ?? []) {
      const typ = text(c['typ']) === '' ? '(型なし)' : text(c['typ']);
      const nn = String(c['nn']) === '1' ? '不可' : '可';
      const pk = String(c['pk']) !== '0' && text(c['pk']) !== '' ? '主キー' : '';
      out.push(`| ${text(c['col'])} | ${typ} | ${nn} | ${pk} |`);
    }
    out.push('');
  }

  const mine = fks.filter((f) => text(f['tbl']) !== '');
  if (mine.length > 0) {
    out.push('## 表どうしの繋がり');
    out.push('');
    for (const f of mine) {
      const to = text(f['refcol']) === '' ? text(f['ref']) : `${text(f['ref'])}.${text(f['refcol'])}`;
      out.push(`- ${text(f['tbl'])}.${text(f['col'])} → ${to}`);
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
  if (counts === null) out.push('⚠ 行数は採れませんでした。');
  return out.join('\n');
}
