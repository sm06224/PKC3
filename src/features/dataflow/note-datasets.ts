/**
 * 🔴 **1 つのノートの本文から、名前付きのデータセットを拾う**(#2115 Phase 1 / PR-2)。
 *
 * 拾う形は 3 つ(どれも原文は 1 バイトも変えない・描いた見た目も変わらない):
 *
 * 1. **csv / tsv / psv の囲み** ── 既存の ` ```csv name=売上 `(`noheader` も)。
 *    見出しに `asset:<key>` があれば中身は添付なので、添付のデータセットになる(`fence-asset.ts` の読み方)。
 * 2. **Markdown の表** ── 表の直前(空行 0〜1 行)に `<!-- dataset: 売上 -->` か `<!-- name=売上 -->`。
 *    PKC-Markdown の隠しメモ `%% dataset: 売上 %%`(`%% name=売上 %%`)も同じ意味に読む。
 *    🔴 **見た目が 0 変化なのは `%%` の方だけ**(2026-11-28 実測)── PKC の描画は `html: false` なので、
 *    `<!-- … -->` は**字のまま本文に出る**。HTML コメントを描画で隠すのは描画層を触る PR-3 の仕事
 *    (いまの見え方は `tests/features/dataflow/note-datasets.test.ts` が名指しで pin している)。
 * 3. **添付の csv** ── `<!-- dataset: 売上=asset:<key> -->`(明示)と、
 *    本文の `[売上.csv](asset:<key>)`(自動の候補。名前がぶつかれば**静かに譲る**)。
 *
 * ## 既存の正本を通す(2 本目の読み方を作らない)
 *
 * - 囲みの走査は `fencesBelowFrontmatter`、中身は `fenceText`、升は `parseCsv`(csv の表と同じ 1 本)
 * - Markdown の表は `mdTableAtGate`(升を打つ側・形を作り変える側と同じ門)
 * - 名前は `validCsvTableName` / `csvTableNameWhy`、列は `widenHeader` + `csvColumnNames` + `numericColumns`
 * - 升の上限は `csvCellsOverBudget`(切らずに断る)
 *
 * ## ⚠ 既存の csv の表との違い(意図した差)
 *
 * - 列の頭に `_note` / `_lid` を**足さない**(1 つのノートの中で閉じるので出所の列は要らない)。
 * - 同じ名前を 2 度名乗ったら**積まずに断る**(後の方を診断に出す)── ノートの中で同じ名前が 2 つ在るのは、
 *   ビューがどちらを引くか読めない形なので、黙って合算しない。全ノートの `name=` を積む既存の SQL の口は変えない。
 * - 名前の無い囲み・コメントの無い表は拾わない(呼び名が無い)。
 *
 * ⚠ pure module ── DOM / `window` / Worker / adapter 層を import しない。
 */
import { frontmatterLineCount } from '@features/markdown/frontmatter';
import {
  containerAtLine,
  fenceInfo,
  quoteLead,
  quotePrefix,
  splitLines,
  type FenceSpan,
} from '@features/markdown/source-blocks';
import { fencesBelowFrontmatter, mdCellGate, mdTableAtGate } from '@features/markdown/table-convert';
import { DELIMITER, detectCsvLang, isHeaderDisabled, parseCsv } from '@features/markdown/csv-table';
import { takeFenceAsset } from '@features/markdown/fence-asset';
import {
  csvCellsOverBudget,
  csvColumnNames,
  csvTableNameRaw,
  csvTableNameWhy,
  fenceText,
  numericColumns,
  validCsvTableName,
  widenHeader,
} from '@features/query/csv-tables';
import { NameBook, foldName } from './names';
import type {
  DataflowDiagnostic,
  DatasetColumnType,
  NoteAssetDataset,
  NoteDataset,
  NoteInlineDataset,
} from './types';

/**
 * 名前のコメント。`<!-- dataset: 売上 -->` / `<!-- name=売上 -->` と、隠しメモの `%% dataset: 売上 %%` /
 * `%% name=売上 %%`(前後の空白は許す・語は大小を問わない)。
 * ⚠ 1 行で閉じる形だけを読む(複数行のコメント・`%%%` の塊のメモは名前ではない)。
 * ⚠ `\%%`(字のままの `%%`)は先頭が `\` なので当たらない(`inline-comment.ts` の読み方と同じ向き)。
 */
const LABEL_RE = /^\s*(?:<!--\s*(dataset\s*:|name\s*=)\s*(.*?)\s*-->|%%(?!%)\s*(dataset\s*:|name\s*=)\s*(.*?)\s*%%)\s*$/i;
/** 明示の添付宣言の中身 `売上=asset:<key>`。⚠ `asset:` の綴りは本文の `asset:` リンクと同じく大小を区別する。 */
const ASSET_DECL_RE = /^([^\s=]*)\s*=\s*asset:(.*)$/;
/**
 * 添付の鍵として受ける字。⚠ 本文の `asset:<key>` を数える側(`body-remap.ts` の `[A-Za-z0-9_-]+`)に
 * PKC2 由来の `.` を足した字(`ast-1.v2`)。
 */
const ASSET_KEY_RE = /^[A-Za-z0-9_.-]{1,200}$/;
/** 本文の添付リンク `[売上.csv](asset:<key>)`。⚠ 画像(`![…]`)は数えない。 */
const ASSET_LINK_RE = /(^|[^!\\])\[([^\]\n]+)\]\(asset:([^)\s]+)\)/g;
/** 自動の候補にする拡張子。 */
const LINK_EXT_RE = /\.(csv|tsv)$/i;

export interface NoteDatasetExtraction {
  /** 有効なデータセット(定義順 = 行の順)。 */
  readonly datasets: readonly NoteDataset[];
  readonly diagnostics: readonly DataflowDiagnostic[];
}

/** 名前の候補 1 つ(行の順に並べてから名乗らせる)。 */
interface Candidate {
  readonly line: number;
  readonly name: string;
  /** 名乗れたら作る(升の組み立てはここで初めて走る)。診断を返せば断る。 */
  readonly build: () => NoteDataset | Omit<DataflowDiagnostic, 'name' | 'line'>;
}

/** 本文の地図(1 回だけ組む)。 */
interface BodyMap {
  readonly lines: readonly string[];
  readonly fm: number;
  readonly fences: readonly FenceSpan[];
}

function mapBody(body: string): BodyMap {
  return { lines: splitLines(body), fm: frontmatterLineCount(body), fences: fencesBelowFrontmatter(body) };
}

/** その行は本文の地の行か(frontmatter の中でも囲みの中でもない)。 */
function isProse(map: BodyMap, line: number): boolean {
  return line >= map.fm && containerAtLine(map.fences, line) === null;
}

/** 添付の鍵を検める。@returns 受けられなければ理由。 */
export function assetKeyWhy(key: string): string {
  if (key === '') return 'asset: の後ろに添付の名前がありません';
  if (!ASSET_KEY_RE.test(key)) return `添付の名前「${key}」は読めません(英数字と - _ . だけの名前です)`;
  return '';
}

/**
 * 🔴 **升を組んでデータセットにする**(囲みと Markdown の表の共通の 1 本)。
 * ⚠ 見出しより升の多い行の余りは捨てず `列3` の列にする(`widenHeader`)。足りない升は空の字で埋める。
 */
function inlineDataset(
  kind: NoteInlineDataset['kind'],
  name: string,
  line: number,
  head: readonly string[] | null,
  body: readonly (readonly string[])[],
): NoteInlineDataset | Omit<DataflowDiagnostic, 'name' | 'line'> {
  const width = Math.max(head?.length ?? 0, ...body.map((r) => r.length));
  if (width === 0) return { kind: 'empty', why: `表「${name}」に列がありません` };
  const header =
    head === null ? Array.from({ length: width }, (_, i) => `col${String(i + 1)}`) : widenHeader(head, width);
  const rows = body.map((r) => Array.from({ length: width }, (_, c) => r[c] ?? ''));
  const columns = csvColumnNames(header, []);
  // 🔴 切らずに断る(黙って切ると「行が足りない答え」が出る ── 0 行より気づけない)
  const over = csvCellsOverBudget([{ name, columns, rows, blocks: 1 }]);
  if (over !== null) return { kind: 'too-large', why: over };
  const types = numericColumns(columns, rows).map((n): DatasetColumnType => (n ? 'REAL' : 'TEXT'));
  return { kind, name, line, columns, types, rows, implicit: false };
}

/** csv / tsv / psv の囲みの候補。 */
function fenceCandidates(map: BodyMap, out: Candidate[], diags: DataflowDiagnostic[]): void {
  for (const span of map.fences) {
    // ⚠ 開き行も引用の前置きを剥がしてから読む(`collectCsvTables` と同じ作法)
    const openRaw = map.lines[span.start] ?? '';
    const openLead = quoteLead(openRaw, span.quote);
    const info = fenceInfo(openLead === null ? openRaw : openRaw.slice(openLead));
    const lang = detectCsvLang(info);
    if (lang === null || info === null) continue;
    const name = csvTableNameRaw(info);
    if (name === null) continue;
    const line = span.start;
    const asset = takeFenceAsset(info.trim().split(/\s+/).slice(1).join(' '));
    if (asset.kind === 'invalid') {
      diags.push({ kind: 'invalid-asset', name, line, why: asset.why });
      continue;
    }
    const noHeader = isHeaderDisabled(info);
    if (asset.kind === 'one') {
      out.push({
        line,
        name,
        build: () => {
          const why = assetKeyWhy(asset.key);
          if (why !== '') return { kind: 'invalid-asset', why };
          const ds: NoteAssetDataset = {
            kind: 'asset',
            name,
            line,
            assetKey: asset.key,
            format: lang,
            noHeader,
            implicit: false,
          };
          return ds;
        },
      });
      continue;
    }
    out.push({
      line,
      name,
      build: () => {
        const grid = parseCsv(fenceText(map.lines, span), DELIMITER[lang]);
        if (grid === null) return { kind: 'empty', why: `表「${name}」のブロックが空です` };
        return noHeader
          ? inlineDataset(lang, name, line, null, grid)
          : inlineDataset(lang, name, line, grid[0] ?? [], grid.slice(1));
      },
    });
  }
}

/** 名前のコメントを読む。@returns 名前のコメントでなければ `null`。 */
function readLabel(text: string): { readonly name: string; readonly assetKey: string | null } | null {
  const m = LABEL_RE.exec(text);
  if (m === null) return null;
  const isDataset = (m[1] ?? m[3] ?? '').toLowerCase().startsWith('dataset');
  const content = m[2] ?? m[4] ?? '';
  if (isDataset) {
    const a = ASSET_DECL_RE.exec(content);
    if (a !== null) return { name: a[1] ?? '', assetKey: (a[2] ?? '').trim() };
  }
  return { name: content, assetKey: null };
}

/** 引用の前置きを剥がした字と深さ。 */
function unquote(line: string): { readonly depth: number; readonly rest: string } {
  const q = quotePrefix(line);
  return { depth: q.depth, rest: line.slice(q.length) };
}

/** Markdown の表と、名前のコメント(表の名前・添付の宣言)の候補。 */
function proseCandidates(map: BodyMap, body: string, out: Candidate[], diags: DataflowDiagnostic[]): void {
  const { lines, fm } = map;
  /** 表の名前に使ったコメントの行。⚠ 使われなかった名前のコメントは「直後に表が無い」と言う。 */
  const used = new Set<number>();
  const gate = mdCellGate(lines);
  gate.body = body;
  gate.fm = fm;
  gate.fences = map.fences;

  /**
   * ⚠ ここで「囲みの中か / frontmatter の中か」は見ない ── **到達しない条件**である(変異試験 M11 が SURVIVED で教えた)。
   *   囲みの外の表の 1〜2 行上が囲みの中身になることは無い(間に必ず閉じの柵が立つ)し、frontmatter の直下の表の
   *   1 行上は閉じの `---` である。囲みの中の名前のコメントが表に付かないことは test が名指しで守る。
   */
  const labelAt = (j: number, depth: number): { readonly name: string } | null => {
    const u = unquote(lines[j] ?? '');
    if (u.depth !== depth) return null;
    const label = readLabel(u.rest);
    return label === null || label.assetKey !== null ? null : label;
  };
  const isBlank = (j: number, depth: number): boolean => {
    if (j < fm) return false;
    const u = unquote(lines[j] ?? '');
    return u.depth <= depth && u.rest.trim() === '';
  };

  for (let i = fm; i < lines.length; ) {
    if (!(lines[i] ?? '').includes('|')) {
      i += 1;
      continue;
    }
    const run = mdTableAtGate(gate, i);
    if (run === null || run.start !== i) {
      i += 1;
      continue;
    }
    const depth = unquote(lines[run.start] ?? '').depth;
    // 🔑 直前(空行 0〜1 行)の名前のコメント
    let labelLine = run.start - 1;
    let label = labelAt(labelLine, depth);
    if (label === null && isBlank(run.start - 1, depth)) {
      labelLine = run.start - 2;
      label = labelAt(labelLine, depth);
    }
    if (label !== null) {
      used.add(labelLine);
      const name = label.name;
      const line = run.start;
      const rows = run.rows;
      out.push({
        line,
        name,
        build: () => {
          const head = rows[0]?.head === true ? rows[0].cells : null;
          const data = (head === null ? rows : rows.slice(1)).map((r) => r.cells);
          return inlineDataset('markdown', name, line, head, data);
        },
      });
    }
    i = run.end + 1;
  }

  // 添付の宣言と、表に付かなかった名前のコメント
  for (let j = fm; j < lines.length; j += 1) {
    if (!isProse(map, j)) continue;
    const label = readLabel(unquote(lines[j] ?? '').rest);
    if (label === null) continue;
    if (label.assetKey === null) {
      if (!used.has(j)) {
        diags.push({
          kind: 'orphan-label',
          name: label.name,
          line: j,
          why: `名前「${label.name}」のコメントの直後(空行 1 行まで)に Markdown の表がありません`,
        });
      }
      continue;
    }
    const key = label.assetKey;
    const name = label.name;
    out.push({
      line: j,
      name,
      build: () => {
        const why = assetKeyWhy(key);
        if (why !== '') return { kind: 'invalid-asset', why };
        const ds: NoteAssetDataset = {
          kind: 'asset',
          name,
          line: j,
          assetKey: key,
          format: 'csv',
          noHeader: false,
          implicit: false,
        };
        return ds;
      },
    });
  }
}

/**
 * 🔴 **明示されたデータセットを拾う**(囲み・名前のコメント付きの表・添付の宣言)。
 *
 * 行の順に名乗らせる ── 名前が使えなければ `invalid-name`、先に同じ名前があれば `duplicate-name`。
 * ⚠ 後の方で上書きしない(どちらを引くか読めない形を黙って片付けない)。
 */
export function collectExplicitDatasets(body: string): NoteDatasetExtraction {
  const map = mapBody(body);
  const candidates: Candidate[] = [];
  const diagnostics: DataflowDiagnostic[] = [];
  fenceCandidates(map, candidates, diagnostics);
  proseCandidates(map, body, candidates, diagnostics);
  candidates.sort((a, b) => a.line - b.line);
  const book = new NameBook();
  const datasets: NoteDataset[] = [];
  for (const c of candidates) {
    const why = csvTableNameWhy(c.name);
    if (why !== '') {
      diagnostics.push({ kind: 'invalid-name', name: c.name, line: c.line, why });
      continue;
    }
    const owner = book.owner(c.name);
    if (owner !== undefined) {
      diagnostics.push({
        kind: 'duplicate-name',
        name: c.name,
        line: c.line,
        why: `名前「${c.name}」はこのノートで既に使われています(「${owner}」)。後の方は使いません。別の名前にしてください`,
      });
      continue;
    }
    const built = c.build();
    if ('why' in built) {
      diagnostics.push({ ...built, name: c.name, line: c.line });
      continue;
    }
    book.claim(c.name);
    datasets.push(built);
  }
  diagnostics.sort((a, b) => a.line - b.line);
  return { datasets, diagnostics };
}

/** インラインのコード(`` `…` ``)を空白で塗る(長さは保つ)── その中のリンクは字であってリンクではない。 */
function maskInlineCode(line: string): string {
  return line.replace(/(`+)[^`]*?\1/g, (m) => ' '.repeat(m.length));
}

/**
 * 🔑 **添付リンクからの自動の候補**(`[売上.csv](asset:<key>)`)。
 *
 * 名前は表示名から拡張子(`.csv` / `.tsv`)を除いた字。次のどれかなら**静かに譲る**(診断を出さない ──
 * user が名前のつもりで書いた物ではないので):
 * - 名前が SQL に打てない(`validCsvTableName` が通さない)/ 鍵が読めない
 * - `taken`(明示のデータセット・ビュー)と同じ名前
 * - 別の鍵を指す同じ名前のリンクがある(どちらか決められない)── 同じ鍵なら 1 つとして数える
 */
export function collectImplicitAssetDatasets(
  body: string,
  taken: Iterable<string> = [],
): readonly NoteAssetDataset[] {
  const map = mapBody(body);
  const takenFold = new Set<string>();
  for (const t of taken) takenFold.add(foldName(t));
  const byName = new Map<string, NoteAssetDataset[]>();
  for (let j = map.fm; j < map.lines.length; j += 1) {
    if (!isProse(map, j)) continue;
    const text = maskInlineCode(map.lines[j] ?? '');
    for (const m of text.matchAll(ASSET_LINK_RE)) {
      const label = (m[2] ?? '').trim();
      const key = m[3] ?? '';
      const ext = LINK_EXT_RE.exec(label);
      if (ext === null) continue;
      const name = label.slice(0, label.length - ext[0].length);
      if (!validCsvTableName(name) || assetKeyWhy(key) !== '') continue;
      const k = foldName(name);
      if (takenFold.has(k)) continue;
      const ds: NoteAssetDataset = {
        kind: 'asset',
        name,
        line: j,
        assetKey: key,
        format: (ext[1] ?? 'csv').toLowerCase() === 'tsv' ? 'tsv' : 'csv',
        noHeader: false,
        implicit: true,
      };
      const list = byName.get(k);
      if (list === undefined) byName.set(k, [ds]);
      else list.push(ds);
    }
  }
  const out: NoteAssetDataset[] = [];
  for (const list of byName.values()) {
    const first = list[0];
    if (first === undefined) continue;
    if (list.some((d) => d.assetKey !== first.assetKey)) continue;
    out.push(first);
  }
  return out.sort((a, b) => a.line - b.line);
}

/**
 * 🔴 **1 つのノートの名前付きデータセットを全部拾う**(明示 → 自動の候補の順に名乗る)。
 * @param options.taken 自動の候補が譲る相手の名前(ビューの名前など)。明示のデータセットには効かない。
 */
export function extractNoteDatasets(
  body: string,
  options?: { readonly taken?: Iterable<string> },
): NoteDatasetExtraction {
  const explicit = collectExplicitDatasets(body);
  const taken = [...explicit.datasets.map((d) => d.name), ...(options?.taken ?? [])];
  const implicit = collectImplicitAssetDatasets(body, taken);
  const datasets = [...explicit.datasets, ...implicit].sort((a, b) => a.line - b.line);
  return { datasets, diagnostics: explicit.diagnostics };
}
