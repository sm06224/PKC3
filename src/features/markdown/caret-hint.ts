import { blockSpanAtCaret, scanBlockSpans, type BlockSpan } from './block-spans';
import { frontmatterLineCount } from './frontmatter';
import { lineStart } from './line-start';
import { parseRenderableFence, type RenderableFenceLang } from './markdown-render';
import { isPlaceOpen } from './place-notation';
import { scanContainers } from './source-blocks';
import { tableRowAt } from './table-assist';

/**
 * 🔴 **いまの caret がどの記法の中に居るか**(#1451。編集の帯の右端の案内の材料)。
 *
 * 表(行が `|` で始まる)・コード/図/表の囲み(```)・数式(`$$`)・先頭の frontmatter(`---`)・板の付箋(`:::format{.pkc-place …}`)。
 * 🔑 判定は既存の規則を**そのまま引く**(第二の正本を作らない):表 = `tableRowAt`(Tab が実際にセルを移す行)/
 *   囲み・数式 = `block-spans.ts`(`code-context.ts` と同じ開閉の部品)/ frontmatter = `frontmatterLineCount` /
 *   板 = `isPlaceOpen`(描画と同じ受理)+ `scanContainers`。
 * 🔑 **索引は本文が変わったときだけ作り直す**(`createCaretBlockResolver`)。打鍵(caret の行が変わる)ごとに
 *   全文をなぞらない ── 囲みの位置は二分探索で引く(大きいノートで案内が long task を増やさない)。
 * 🔑 答えには**行の範囲 `[from, to]`**を添える ── 呼び側は caret が同じ行に居るあいだ本文を読み直さない。
 * ⚠ 開き・閉じの案内の字は**実際に書いてある記号**(```` ~~~ ```` / 4 個の逆引用符 など)から作る。
 * ⚠ 閉じの行・frontmatter の閉じの行は案内しない(閉じ方を教える場所ではない)。
 */
export type CaretBlock = 'table' | 'code' | 'math' | 'frontmatter' | 'board' | null;

export interface CaretBlockAt {
  readonly from: number;
  readonly to: number;
  readonly block: CaretBlock;
  /** 帯に出す字(`block` が `null` なら `null`)。 */
  readonly hint: string | null;
}

export const TABLE_HINT = 'Tab で次のセル';

/** 解釈される囲み(`parseRenderableFence` の言語)の呼び名。 */
const FENCE_NAMES: Readonly<Record<RenderableFenceLang, string>> = {
  csv: '表(csv)',
  tsv: '表(tsv)',
  psv: '表(psv)',
  mermaid: '図(mermaid)',
  chart: 'グラフ(chart)',
  plotly: 'グラフ(plotly)',
  react: 'React コンポーネント',
  html: 'html の埋め込み',
  svg: 'svg の図',
};

function fenceHint(span: BlockSpan): string {
  const lang = parseRenderableFence(span.info);
  if (lang === null) return `コード内: 記法は働きません(閉じは ${span.marker})`;
  return `${FENCE_NAMES[lang.lang]}の中: 閉じは ${span.marker}`;
}

const MATH_HINT = '数式内: TeX で書きます(閉じは $$)';
const FRONTMATTER_HINT = 'frontmatter 内: 閉じは ---';
const BOARD_HINT = '板の付箋内: x= y= w= h=(閉じは :::)';

interface Region {
  readonly from: number;
  readonly closeFrom: number;
}

interface CaretIndex {
  readonly spans: BlockSpan[];
  /** frontmatter の閉じ行の頭(無ければ -1)。 */
  readonly frontmatterClose: number;
  readonly boards: Region[];
}

function buildIndex(value: string): CaretIndex {
  const spans = scanBlockSpans(value);
  let frontmatterClose = -1;
  const n = value.startsWith('---') ? frontmatterLineCount(value) : 0;
  if (n > 0) {
    let at = 0;
    for (let k = 1; k < n; k++) at = value.indexOf('\n', at) + 1;
    frontmatterClose = at;
  }
  const boards: Region[] = [];
  if (value.includes(':::')) {
    const starts: number[] = [0];
    for (let i = value.indexOf('\n'); i !== -1; i = value.indexOf('\n', i + 1)) starts.push(i + 1);
    const lines = value.split(/\r?\n/);
    for (const c of scanContainers(value)) {
      if (c.kind !== 'directive' || !isPlaceOpen(lines[c.start] ?? '')) continue;
      boards.push({ from: starts[c.start] ?? 0, closeFrom: c.open ? -1 : (starts[c.end] ?? -1) });
    }
  }
  return { spans, frontmatterClose, boards };
}

function resolve(index: CaretIndex, value: string, caret: number, range: { from: number; to: number }): CaretBlockAt {
  const ls = lineStart(value, caret);
  if (index.frontmatterClose > 0 && ls < index.frontmatterClose)
    return { ...range, block: 'frontmatter', hint: FRONTMATTER_HINT };
  const span = blockSpanAtCaret(index.spans, value, caret);
  if (span !== null) {
    // 開きの柵の行は、caret が記号の前か後ろかで答えが変わる ── 範囲を caret 1 点にして控えを使わせない
    const r = ls === span.from ? { from: caret, to: caret } : range;
    return span.kind === 'math'
      ? { ...r, block: 'math', hint: MATH_HINT }
      : { ...r, block: 'code', hint: fenceHint(span) };
  }
  for (const b of index.boards) {
    if (ls >= b.from && (b.closeFrom === -1 || ls < b.closeFrom)) return { ...range, block: 'board', hint: BOARD_HINT };
  }
  return { ...range, block: null, hint: null };
}

export interface CaretBlockResolver {
  at(value: string, caret: number): CaretBlockAt;
}

/** 索引を持ち回る解決器。本文が変わるまで(`value` が同じ字のあいだ)索引を作り直さない。 */
export function createCaretBlockResolver(): CaretBlockResolver {
  let cached: { value: string; index: CaretIndex } | null = null;
  return {
    at(value, caret) {
      const row = tableRowAt(value, caret);
      const range = { from: row.from, to: row.to };
      if (row.table) return { ...range, block: 'table', hint: TABLE_HINT };
      if (cached === null || cached.value !== value) cached = { value, index: buildIndex(value) };
      return resolve(cached.index, value, caret, range);
    },
  };
}

/** 1 回きりの解決(索引は使い捨て)。 */
export function caretBlockAt(value: string, caret: number): CaretBlockAt {
  return createCaretBlockResolver().at(value, caret);
}
