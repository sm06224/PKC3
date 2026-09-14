/**
 * 🔴 **xlsx の 1 枚を、格子(行 × 升)にする**(#854 段③)。
 *
 * ## なぜ「Office に変換させる」をやめたか(2026-09-14、#854 のコメントに理由)
 *
 * 起票時の案は「**Office のひとそろいが入っている端末では**変換できる」だった。
 * 🔴 **決め手は「誰が使えるか」である** ── Office の一式は **97MB の opt-in** なので、
 * その案だと「表のデータを持っている人」の大半が使えない。SQL で調べる道具は
 * まさにその人のための物なので、**入れていなくても使える**ほうを採った。
 * ⚠ そして `--convert-to` はこの箱で**対照群ごと動かなかった**(#225 の実測)ので、
 * 変換に頼る形は**通る保証もまだ無い**。
 *
 * ## ⚠ この module は **pure**(zip も Blob も触らない)
 *
 * 受けるのは**もう解いた XML の字**である。🔑 zip を開くのは呼び側
 * (`import/zip-reader.ts` の `readZipText`)── ここへ I/O を混ぜると、
 * **格子の作り方を fixture だけで検められなくなる**。
 *
 * ## 読む物は 3 つ
 *
 * | file | 何のために |
 * |---|---|
 * | `xl/worksheets/sheet*.xml` | 升そのもの |
 * | `xl/sharedStrings.xml` | 🔴 **字は升に入っていない** ── `t="s"` の升は**番号**で、実体はこちら |
 * | `xl/styles.xml` | 🔴 **日付かどうかは升に書いていない** ── 書式の側にしか無い |
 *
 * ## 🔴 日付は「連番」で入っている
 *
 * `2026-09-14` は升の中では **`45914`** のような数である。⚠ 「値は全部 TEXT」の
 * 規則をそのまま当てると、**user の目に `45914` が出る** ── 「9 月の売上を出す」が
 * 書けなくなるので、機能として成り立たない(#854 でそう判断した)。
 * 🔑 だから**書式を読んで、日付の升だけ `YYYY-MM-DD` に直す**。
 *
 * ⚠ **1900 年の閏日の穴**:xlsx は互換のため **1900-02-29 という存在しない日**を
 * 連番 60 に持っている。だから **60 より大きい連番は 1 日ぶん余計に進んでいる**。
 * 🔑 基準を **1899-12-30** に置くと 61 以降がそのまま合い、60 以下だけ 1 日戻せばよい。
 * ⚠ ここを素通りさせると、**1900 年 2 月までの日付だけ 1 日ずれる**(誰も気づかない形)。
 */
import { parseXml, textOf, walk, type XmlNode } from '@features/export/xml-lite';

/** 升の中身。⚠ 空の升は `null`(空文字と区別する ── 空文字は「空と書いてある」)。 */
export type XlsxCell = string | null;

/**
 * 🔴 **`xl/sharedStrings.xml` を読む**。
 *
 * ⚠ 1 つの `<si>` が **`<t>` を複数持つ**ことがある(升の中で書体を変えると
 *   `<r>` に割れる)── 連結しないと「太字にした所だけ落ちた字」になる。
 * 🔑 `textOf` は子孫の字を全部繋ぐので、`<si>` ごと渡せばそれで足りる。
 */
export function sharedStringsOf(xml: string): string[] {
  const out: string[] = [];
  let root: XmlNode;
  try {
    root = parseXml(xml);
  } catch {
    // ⚠ 共有文字列が壊れていても**表そのものは出す** ── 番号の升が空になるだけ
    return out;
  }
  for (const { node } of walk(root)) {
    if (node.tag === 'si') out.push(textOf(node));
  }
  return out;
}

/**
 * 組み込みの「日付の書式」番号。
 *
 * ⚠ **数え上げで持つ**(範囲で書かない)── `23`〜`44` は数や通貨なので、
 *   `14..47` のような範囲にすると**金額が日付になる**。
 * 🔑 出どころは ECMA-376 の既定の書式表(14〜22 が日付と時刻、45〜47 が経過時間)。
 */
const BUILTIN_DATE_FORMATS: ReadonlySet<number> = new Set([
  14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47,
]);

/**
 * その書式の字は、日付を出す形か。
 *
 * ⚠ **色と条件と引用符を先に落とす** ── `[Red]`・`[$-409]` の中や `"年"` の中の
 *   `d` / `y` を数えると、**ただの数を日付だと読む**。
 * 🔑 残った字に `y` / `m` / `d` / `h` / `s` が在れば日付か時刻である
 *   (⚠ `m` は「月」と「分」の両方だが、どちらでも日付側に倒してよい ──
 *   TEXT のまま出すよりは必ず読める字になる)。
 */
export function looksLikeDateFormat(code: string): boolean {
  const bare = code.replace(/\[[^\]]*\]/g, '').replace(/"[^"]*"/g, '');
  return /[ymdhs]/i.test(bare);
}

/**
 * 🔴 **`xl/styles.xml` を読み、「日付を出す書式」を使っている升の style 番号を返す**。
 *
 * ⚠ 升が持っているのは `s="5"` という**`cellXfs` の何番目か**であって、書式そのもの
 *   ではない ── そこから `numFmtId` を引き、さらに独自書式(164 以上)なら
 *   `numFmts` の字を読む、と **2 段**辿る必要がある。
 * ⚠ **`cellXfs` の中の `<xf>` だけ**を数える ── `cellStyleXfs` にも同じ `<xf>` が
 *   並んでおり、混ぜると番号が丸ごとずれる(**全部の日付が別の升のものになる**)。
 */
export function dateStyleIndexesOf(xml: string): ReadonlySet<number> {
  const out = new Set<number>();
  let root: XmlNode;
  try {
    root = parseXml(xml);
  } catch {
    return out;
  }
  // ① 独自の書式(164 以上)── 番号 → 字
  const custom = new Map<number, string>();
  for (const { node } of walk(root)) {
    if (node.tag !== 'numFmt') continue;
    const id = Number(node.attrs['numFmtId']);
    const code = node.attrs['formatCode'] ?? '';
    if (Number.isInteger(id)) custom.set(id, code);
  }
  // ② `cellXfs` の中の `<xf>` だけを、**並び順**で数える
  for (const { node, chain } of walk(root)) {
    if (node.tag !== 'cellXfs') continue;
    let index = 0;
    for (const xf of node.children) {
      if (xf.tag !== 'xf') continue;
      const id = Number(xf.attrs['numFmtId'] ?? '0');
      const code = custom.get(id);
      const isDate = Number.isInteger(id)
        ? code === undefined
          ? BUILTIN_DATE_FORMATS.has(id)
          : looksLikeDateFormat(code)
        : false;
      if (isDate) out.add(index);
      index += 1;
    }
    // ⚠ `cellXfs` は 1 つだけ ── 見つけたら止める(`chain` は使わないが、
    //    入れ子の `cellXfs` を拾わないことを明示するために先頭だけを採る)
    void chain;
    break;
  }
  return out;
}

/**
 * 🔴 **連番を `YYYY-MM-DD` に直す**(上の docstring の 1900 年の穴)。
 *
 * ⚠ 時刻だけの升(`0.5` = 正午)は**日付にしない** ── `1899-12-30` と出しても
 *   意味が無いので、`HH:MM` で返す。
 * @returns 直せないものは `null`(呼び側が生の数を出す)
 */
export function serialToText(serial: number): string | null {
  if (!Number.isFinite(serial) || serial < 0) return null;
  const whole = Math.floor(serial);
  const frac = serial - whole;
  // ⚠ 1 日に満たないものは「時刻だけ」── 日付を作らない
  if (whole === 0) return clockText(frac);
  // 🔑 61 以降は 1899-12-30 起点でそのまま合う。60 以下は閏日の穴のぶん 1 日戻す
  const days = whole >= 61 ? whole : whole + 1;
  const ms = Date.UTC(1899, 11, 30) + days * 86_400_000;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  const date = `${String(d.getUTCFullYear()).padStart(4, '0')}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  const clock = frac > 0 ? clockText(frac) : null;
  return clock === null ? date : `${date} ${clock}`;
}

function clockText(frac: number): string {
  // ⚠ 秒で丸める(浮動小数の端数で 23:59:60 を作らない)
  const secs = Math.round(frac * 86_400) % 86_400;
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * 🔴 **`A1` のような番地から、列の番号(0 始まり)を採る**。
 *
 * ⚠ **これが要るのは、xlsx が空の升を書かないから**である ── `A1` の次が `C1` の
 *   ことがあり、番地を読まないと**2 列目に 3 列目の値が入る**(黙って全部ずれる)。
 * @returns 読めない番地は `null`
 */
export function columnIndexOf(ref: string): number | null {
  const m = /^([A-Za-z]+)/.exec(ref.trim());
  if (m === null) return null;
  let n = 0;
  for (const ch of m[1]!.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** 行番号(1 始まり)。⚠ 行も飛ぶので、こちらも番地から採る。 */
export function rowNumberOf(ref: string): number | null {
  const m = /(\d+)$/.exec(ref.trim());
  return m === null ? null : Number(m[1]);
}

/**
 * 🔴 **シート 1 枚を格子にする**。
 *
 * ⚠ **升の種類で読む場所が変わる**:
 * - `t="s"` ── `<v>` は**共有文字列の番号**(字そのものではない)
 * - `t="inlineStr"` ── 字は `<is>` の中(`<v>` は無い)
 * - `t="b"` ── `0` / `1` を `FALSE` / `TRUE` にする
 * - `t="e"` ── エラー(`#DIV/0!` 等)。**そのまま出す**(隠すと user が気づけない)
 * - 無印 ── 数。⚠ **style が日付なら日付に直す**
 *
 * ⚠ **行も列も飛ぶ**ので、番地から埋める(上の `columnIndexOf` の理由)。
 * ⚠ 升の数で切るのは**呼び側**の仕事 ── ここは file の姿をそのまま返す。
 */
export function xlsxSheetGrid(
  sheetXml: string,
  shared: readonly string[],
  dateStyles: ReadonlySet<number>,
): XlsxCell[][] {
  let root: XmlNode;
  try {
    root = parseXml(sheetXml);
  } catch {
    return [];
  }
  const byRow = new Map<number, XlsxCell[]>();
  let widest = 0;
  let fallbackRow = 0;
  for (const { node } of walk(root)) {
    if (node.tag !== 'row') continue;
    fallbackRow += 1;
    const rowNo = Number(node.attrs['r'] ?? '') || fallbackRow;
    const cells: XlsxCell[] = [];
    let fallbackCol = 0;
    for (const c of node.children) {
      if (c.tag !== 'c') continue;
      const ref = c.attrs['r'] ?? '';
      const col = columnIndexOf(ref) ?? fallbackCol;
      fallbackCol = col + 1;
      cells[col] = cellText(c, shared, dateStyles);
      widest = Math.max(widest, col + 1);
    }
    byRow.set(rowNo, cells);
  }
  const rowNos = [...byRow.keys()].sort((a, b) => a - b);
  // ⚠ **飛んだ行は空行として詰める** ── 詰めないと「10 行目の値が 2 行目に見える」
  const out: XlsxCell[][] = [];
  const last = rowNos[rowNos.length - 1] ?? 0;
  for (let r = 1; r <= last; r += 1) {
    const cells = byRow.get(r) ?? [];
    const row: XlsxCell[] = [];
    for (let i = 0; i < widest; i += 1) row.push(cells[i] ?? null);
    out.push(row);
  }
  return out;
}

function cellText(
  c: XmlNode,
  shared: readonly string[],
  dateStyles: ReadonlySet<number>,
): XlsxCell {
  const kind = c.attrs['t'] ?? '';
  if (kind === 'inlineStr') {
    const is = c.children.find((n) => n.tag === 'is');
    return is === undefined ? null : textOf(is);
  }
  const v = c.children.find((n) => n.tag === 'v');
  // ⚠ `<v>` が無い升は**空**(書式だけ付いた升は実在する)
  if (v === undefined) return null;
  const raw = textOf(v);
  if (kind === 's') {
    const at = Number(raw);
    // ⚠ 番号が表の外なら `null` ── 壊れた file で別の字を出さない
    return Number.isInteger(at) && at >= 0 && at < shared.length ? (shared[at] ?? null) : null;
  }
  if (kind === 'b') return raw === '1' ? 'TRUE' : 'FALSE';
  // ⚠ `str`(式の答えの字)と `e`(エラー)は**そのまま**
  if (kind === 'str' || kind === 'e') return raw;
  const style = Number(c.attrs['s'] ?? '');
  if (Number.isInteger(style) && dateStyles.has(style)) {
    const asDate = serialToText(Number(raw));
    // ⚠ 直せなければ**生の数を出す**(黙って空にしない)
    if (asDate !== null) return asDate;
  }
  return raw;
}
