/**
 * P6c 段③後半: PKC2 の `textlog.csv` を TextlogBody へ**逆写像**する。
 *
 * PKC3 の `getFlavor('textlog').fromPkc2` は **PKC2 の TextlogBody JSON**
 * (`{entries:[{id,text,createdAt,flags}]}`)を取るので、CSV をそこまで戻せば
 * 以降は既存の変換経路にそのまま乗る ── textlog 専用の変換を二重に持たない。
 *
 * ## PKC2 の契約(`features/textlog/textlog-csv.ts` を実地確認、2026-08-01)
 * 列: `log_id, timestamp_iso, timestamp_display, important, text_markdown,
 *      text_plain, asset_keys, flags`
 * - UTF-8 / **CRLF**(RFC4180)/ **全フィールドを quote** / 内部の `"` は `""`
 * - 🔑 **header は「名前で」引く**(位置ではない)── 列の並び替え・追加列に強い
 * - 必須列は `log_id` / `timestamp_iso` / `text_markdown`(欠けたら throw)
 * - **並びは append 順**。`timestamp_iso` で並べ替えない(textlog の不変条件)
 * - `flags` 列があればそれが**正**(空 = flags 無し。`important` に戻らない)。
 *   無ければ legacy として `important === 'true'` から推定する
 * - 未知の flag token は落とす(allow-list ── 前方互換)
 *
 * ## PKC2 から変えた 1 点
 * PKC2 は `log_id` が空の行を**黙って skip** していた(best-effort)。
 * PKC3 は skip 自体は踏襲する(1 行の破損で残り全部を失う方が悪い)が、
 * **件数を返して呼び出し側が可視化できるようにする** ── 黙って落とさない。
 */

/** PKC2 の TextlogFlag(allow-list。未知 token は落とす)。 */
const KNOWN_FLAGS = new Set(['important']);

export interface TextlogCsvEntry {
  id: string;
  text: string;
  createdAt: string;
  flags: string[];
}

export interface TextlogCsvResult {
  entries: TextlogCsvEntry[];
  /** `log_id` が空で読み飛ばした行数(0 でなければ呼び出し側が warning にする)。 */
  skippedRows: number;
}

export class TextlogCsvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TextlogCsvError';
  }
}

/**
 * RFC4180 の行分割。quote の中では改行も `,` もフィールドの一部。
 * CRLF / 素の LF のどちらも record 区切りとして受ける(PKC2 と同じ寛容さ)。
 */
function parseRows(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;
  let sawField = false;

  const endField = (): void => {
    row.push(field);
    field = '';
    sawField = false;
  };
  const endRow = (): void => {
    endField();
    rows.push(row);
    row = [];
  };

  while (i < csv.length) {
    const ch = csv[i]!;
    if (quoted) {
      if (ch === '"') {
        if (csv[i + 1] === '"') {
          field += '"'; // 内部の `"` は `""`
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"' && !sawField) {
      quoted = true;
      sawField = true;
      i++;
      continue;
    }
    if (ch === ',') {
      endField();
      i++;
      continue;
    }
    if (ch === '\r' && csv[i + 1] === '\n') {
      endRow();
      i += 2;
      continue;
    }
    if (ch === '\n' || ch === '\r') {
      endRow();
      i++;
      continue;
    }
    field += ch;
    sawField = true;
    i++;
  }
  // 末尾に改行が無い場合の最終行(空文字だけの残りは行として数えない)
  if (field !== '' || row.length > 0) endRow();
  return rows;
}

const at = (row: readonly string[], i: number): string =>
  i >= 0 && i < row.length ? (row[i] ?? '') : '';

function parseFlags(raw: string): string[] {
  const trimmed = raw.trim();
  if (trimmed === '') return [];
  const out: string[] = [];
  for (const part of trimmed.split(',')) {
    const t = part.trim().toLowerCase();
    // 未知 token は落とす(前方互換 ── 将来の flag を知らない版でも読める)
    if (t !== '' && KNOWN_FLAGS.has(t) && !out.includes(t)) out.push(t);
  }
  return out;
}

/** `textlog.csv` → TextlogBody 相当。**形が違えば throw**(黙って 0 件にしない)。 */
export function parseTextlogCsv(csv: string): TextlogCsvResult {
  if (csv === '') throw new TextlogCsvError('textlog.csv が空です');
  const rows = parseRows(csv);
  if (rows.length === 0) throw new TextlogCsvError('textlog.csv に行がありません');

  // 🔑 header は名前で引く ── 位置で引くと、列が 1 本増えただけで全部ずれる
  const header = rows[0]!;
  const idxId = header.indexOf('log_id');
  const idxIso = header.indexOf('timestamp_iso');
  const idxText = header.indexOf('text_markdown');
  const idxFlags = header.indexOf('flags');
  const idxImportant = header.indexOf('important');
  if (idxId < 0 || idxIso < 0 || idxText < 0) {
    throw new TextlogCsvError(
      'textlog.csv の見出し行に必須列がありません(log_id / timestamp_iso / text_markdown)',
    );
  }

  const entries: TextlogCsvEntry[] = [];
  let skippedRows = 0;
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]!;
    // 完全な空行(末尾改行など)は「壊れた行」ではないので数えない
    if (row.length === 1 && row[0] === '') continue;
    const id = at(row, idxId);
    if (id === '') {
      // PKC2 と同じく skip するが、**件数は返す**(黙って落とさない)
      skippedRows++;
      continue;
    }
    entries.push({
      id,
      text: at(row, idxText),
      createdAt: at(row, idxIso),
      // flags 列があればそれが正。**空 = flags 無し**で、important には戻らない
      // ── 新しい writer が「この行に flags は無い」と宣言する手段だから
      flags:
        idxFlags >= 0
          ? parseFlags(at(row, idxFlags))
          : at(row, idxImportant).toLowerCase() === 'true'
            ? ['important']
            : [],
    });
  }
  // **並べ替えない** ── append 順が textlog の不変条件(PKC2 の serializer も
  // reader も re-sort しない)
  return { entries, skippedRows };
}
