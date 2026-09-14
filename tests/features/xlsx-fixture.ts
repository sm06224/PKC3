/**
 * test 用の **最小の `.xlsx`**(合成 fixture)。
 *
 * ⚠ **読み手と実装を共有しない** ── zip を組むのは `zip-fixture.ts`、
 *   XML は**ここで手書きする**。読み手(`xlsx-sheet.ts` / `xlsx-book.ts`)が
 *   「自分が書いたものしか読めない」状態を避ける。
 * ⚠ 本物の Excel が書く形に合わせてある:枚の並びは `workbook.xml` にしか無く、
 *   zip の中の file 名とは**一致しない**(`sheetsOf` がそこを 2 段辿る)。
 */
import { buildZip, bytesOf } from './zip-fixture';

export interface FixtureSheet {
  /** 画面に出る枚の名前。 */
  readonly name: string;
  /** 行 × 列。`null` は空の升。⚠ 値は**全部そのまま inline の字**として書く。 */
  readonly rows: readonly (readonly (string | null)[])[];
  /** zip の中の file 名(既定は `sheetN.xml`)。⚠ 並びと一致させない形も作れる。 */
  readonly file?: string;
}

const COL = (i: number): string => {
  let n = i + 1;
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - r) / 26);
  }
  return s;
};

function sheetXml(rows: FixtureSheet['rows']): string {
  const body = rows
    .map((cells, r) => {
      const cs = cells
        .map((v, c) =>
          v === null
            ? ''
            : `<c r="${COL(c)}${String(r + 1)}" t="inlineStr"><is><t>${v
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')}</t></is></c>`,
        )
        .join('');
      return `<row r="${String(r + 1)}">${cs}</row>`;
    })
    .join('');
  return `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`;
}

/**
 * `.xlsx` を 1 冊組む。
 *
 * @param opts.omit 入れない file(壊れた本を作る ── `xl/workbook.xml` など)
 */
export async function buildXlsx(
  sheets: readonly FixtureSheet[],
  opts: { readonly omit?: readonly string[] } = {},
): Promise<Uint8Array> {
  const omit = new Set(opts.omit ?? []);
  const paths = sheets.map((s, i) => s.file ?? `sheet${String(i + 1)}.xml`);
  const wb =
    `<?xml version="1.0"?><workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>` +
    sheets
      .map((s, i) => `<sheet name="${s.name}" sheetId="${String(i + 1)}" r:id="rId${String(i + 1)}"/>`)
      .join('') +
    `</sheets></workbook>`;
  const rels =
    `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    paths.map((p, i) => `<Relationship Id="rId${String(i + 1)}" Target="worksheets/${p}"/>`).join('') +
    `</Relationships>`;
  const files: { name: string; bytes: Uint8Array }[] = [
    { name: 'xl/workbook.xml', bytes: bytesOf(wb) },
    { name: 'xl/_rels/workbook.xml.rels', bytes: bytesOf(rels) },
    ...sheets.map((s, i) => ({
      name: `xl/worksheets/${paths[i]!}`,
      bytes: bytesOf(sheetXml(s.rows)),
    })),
  ];
  const zip = await buildZip(files.filter((f) => !omit.has(f.name)).map((f) => ({ ...f, method: 8 })));
  return new Uint8Array(await zip.arrayBuffer());
}
