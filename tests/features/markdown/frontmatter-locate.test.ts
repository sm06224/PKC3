/**
 * #1381 ── frontmatter の位置決めを「閉じの行まで読む」形にした。出力は 1 バイトも変えない。
 *
 * 期待値は**旧い算法を丸ごと写した参照**(本文全体を `split` する版)から作る。
 * 実装を参照しない別の観測なので、実装が間違える形で期待値も同じく間違うことは無い。
 */
import { describe, it, expect } from 'vitest';
import {
  frontmatterLineCount,
  bodyBelowFrontmatter,
  parseFrontmatter,
  extractVars,
} from '@features/markdown/frontmatter';

const OPEN_FENCE = /^---\s*\r?\n/;
const CLOSE_FENCE_LINE = /^---\s*$/;

interface Ref {
  count: number;
  below: string;
  inner: string[] | null;
  remainder: string | null;
}

/** 旧い算法(#1381 より前)。 */
function reference(body: string): Ref {
  if (!body) return { count: 0, below: body, inner: null, remainder: null };
  const open = OPEN_FENCE.exec(body);
  if (open === null) return { count: 0, below: body, inner: null, remainder: null };
  const openLines = (open[0].match(/\n/g) ?? []).length;
  const lines = body.replace(OPEN_FENCE, '').split(/\r?\n/);
  let closeIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (CLOSE_FENCE_LINE.test(lines[i] ?? '')) {
      closeIdx = i;
      break;
    }
  }
  if (closeIdx === -1) return { count: 0, below: body, inner: null, remainder: null };
  const count = openLines + closeIdx + 1;
  const remainder = lines.slice(closeIdx + 1).join('\n');
  return {
    count,
    below: body.split('\n').slice(count).join('\n'),
    inner: lines.slice(0, closeIdx),
    remainder: remainder.startsWith('\n') ? remainder.slice(1) : remainder,
  };
}

const CORPUS: Array<[string, string]> = [
  ['LF 普通', '---\ntags: [a, b]\ntitle: T\n---\n本文\n2 行目\n'],
  ['CRLF 普通', '---\r\ntags: [a, b]\r\ntitle: T\r\n---\r\n本文\r\n2 行目\r\n'],
  ['CRLF 混在', '---\ntags: [a]\r\ntitle: T\n---\r\n本文\r\n次\n'],
  ['閉じが無い(frontmatter 風)', '---\ntags: [a]\n本文\n'],
  ['閉じが無い(水平線)', '---\n\n本文だけ\n'],
  ['開きだけ', '---\n'],
  ['開きだけ(CRLF)', '---\r\n'],
  ['開きの直後が閉じ(空の frontmatter)', '---\n---\n本文\n'],
  ['空の frontmatter・閉じが最終行(改行なし)', '---\n---'],
  ['空の frontmatter・CRLF', '---\r\n---\r\n本文'],
  ['開きの直後が空行', '---\n\ntags: [あ]\n---\n本文\n'],
  ['開きの後ろに空白', '---   \ntags: [a]\n---\n本文'],
  ['閉じの後ろに空白', '---\ntags: [a]\n---   \n本文'],
  ['閉じが最終行・改行なし', '---\ntags: [a]\n---'],
  ['閉じが最終行・改行あり', '---\ntags: [a]\n---\n'],
  ['閉じの直後が空行', '---\ntags: [a]\n---\n\n本文\n'],
  ['閉じの直後が空行(CRLF)', '---\r\ntags: [a]\r\n---\r\n\r\n本文\r\n'],
  ['本文に --- が在る', '---\ntags: [a]\n---\n本文\n---\n水平線の後\n---\n'],
  ['frontmatter の中に空行', '---\ntags: [a]\n\ntitle: T\n---\n本文'],
  ['最終行が \\r で終わる', '---\ntags: [a]\n---\n本文\r'],
  ['BOM つき', '\uFEFF---\ntags: [a]\n---\n本文'],
  ['先頭が空行', '\n---\ntags: [a]\n---\n本文'],
  ['タブ', '---\n\ttags: [a]\n\ttitle:\tT\n---\t\n\t本文\n'],
  ['vars ブロック', '---\nvars:\n  x: 1\n  y: "two"\n---\n{{x}} {{y}}\n'],
  ['vars ブロック(CRLF)', '---\r\nvars:\r\n  x: 1\r\n  y: two\r\n---\r\n{{x}}\r\n'],
  ['frontmatter 無し', '本文だけ\n---\ntags: [a]\n---\n'],
  ['空文字', ''],
  ['--- だけ(改行なし)', '---'],
  ['改行だけ', '\n\n\n'],
  ['---- は閉じではない', '---\ntags: [a]\n----\n本文\n---\n後ろ'],
  ['\\r が行の途中に在る', '---\ntags: [a]\rb\n---\n本文\rx\n'],
  ['改行 3 連続で閉じ', '---\na: 1\n\n\n---\n\n\n本文'],
];

describe('frontmatter の位置決め(#1381)── 旧い算法と出力が一致する', () => {
  it('コーパスに「閉じが在る形」「閉じが無い形」「CRLF」が実際に含まれている(空振り防止)', () => {
    const refs = CORPUS.map(([, b]) => reference(b));
    expect(refs.filter((r) => r.inner !== null).length).toBeGreaterThanOrEqual(15);
    expect(refs.filter((r) => r.inner === null).length).toBeGreaterThanOrEqual(8);
    expect(CORPUS.filter(([, b]) => b.includes('\r\n') && reference(b).inner !== null).length).toBeGreaterThanOrEqual(4);
    expect(refs.filter((r) => r.count > 0 && r.below === '').length).toBeGreaterThanOrEqual(2);
  });

  for (const [name, body] of CORPUS) {
    it(`一致: ${name}`, () => {
      const ref = reference(body);
      expect(frontmatterLineCount(body)).toBe(ref.count);
      expect(bodyBelowFrontmatter(body)).toBe(ref.below);

      const parsed = parseFrontmatter(body);
      if (ref.inner === null) {
        expect(parsed.found).toBe(false);
        expect(parsed.body).toBe(body);
        expect(extractVars(body)).toEqual({});
      } else {
        expect(parsed.found).toBe(true);
        expect(parsed.body).toBe(ref.remainder);
        // 中身の行は、参照が切り出した行から組み直した本文を読ませた結果と一致する。
        const rebuilt = `---\n${ref.inner.join('\n')}\n---\n`;
        const rebuiltParsed = parseFrontmatter(rebuilt);
        expect(parsed.meta).toEqual(rebuiltParsed.meta);
        expect(parsed.warnings).toEqual(rebuiltParsed.warnings);
        expect(extractVars(body)).toEqual(extractVars(rebuilt));
      }
    });
  }

  it('総当たり: 行の断片を並べた 4 行までの全形で一致する', () => {
    const frag = ['---', '--- ', 'a: 1', '', '\r', 'x\r', '----', '  b: 2'];
    const eols = ['\n', '\r\n'];
    let checked = 0;
    let withClose = 0;
    const walk = (parts: string[], depth: number): void => {
      for (const eol of eols) {
        for (const tail of [true, false]) {
          const body = parts.join(eol) + (tail ? eol : '');
          const ref = reference(body);
          expect(frontmatterLineCount(body)).toBe(ref.count);
          expect(bodyBelowFrontmatter(body)).toBe(ref.below);
          const p = parseFrontmatter(body);
          expect(p.found).toBe(ref.inner !== null);
          expect(p.body).toBe(ref.inner === null ? body : ref.remainder);
          checked++;
          if (ref.inner !== null) withClose++;
        }
      }
      if (depth === 4) return;
      for (const f of frag) walk([...parts, f], depth + 1);
    };
    for (const f of frag) walk([f], 1);
    expect(checked).toBeGreaterThan(10000);
    expect(withClose).toBeGreaterThan(1000);
  }, 30000);
});
