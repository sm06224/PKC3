import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  renderMarkdown,
  renderMarkdownInline,
  hasMarkdownSyntax,
} from '../../src/features/markdown/markdown-render';
import { parseFrontmatter, extractVars } from '../../src/features/markdown/frontmatter';

/**
 * PKC-Markdown 移植の parity pin(P3-3)。
 * golden は **PKC2 の renderMarkdown(markdown-it 14.3.0)から採取**した実出力
 * (manual ch12 全文 1,431 行 + fixture 3 種 + 方言の縁スニペット 20 種)。
 * 採取手順: tests/fixtures/markdown-goldens/harvest-from-pkc2.ts(手順は同ファイル冒頭)。
 * ⚠ markdown-it のバージョンを動かすと golden ごと再検証が必要(14.3.0 に固定中)。
 *
 * ⚠ **PKC2 と意図的に違えた点は golden 側を更新して記録する**(丸写し禁止 ──
 * user 指示 2026-07-30「流用 + 総合的見直し」)。現時点の差分は 2 つ:
 *
 *   1. タスクのチェック欄に `disabled` を付けた(P8 段⑳)。PKC2 は押せる形で
 *      出していたが、**押しても本文が 1 文字も変わらない** ── 移動 / 追記 /
 *      再読込で全部外れる「チェックしたのに消えた」だった。押せないものは
 *      押せない形にする。
 *   2. 空行マーカー(`_N`)に `style="--pkc-blank-count: N"` を足した(2026-08-05)。
 *      CSS の規則は `height: calc(1.45em * var(--pkc-blank-count, 1))` で**この変数**を
 *      読むのに、出力側は属性しか書いておらず、**`_3` と `_1` が同じ高さ**だった。
 *      PKC2 も同じ形なので、これは PKC2 のバグをそのまま引いていた箇所である。
 *
 * 🔴 **golden は「PKC2 と同じ」を守る道具であって、「正しい」を守る道具ではない。**
 * PKC2 のバグはそのまま期待値になる ── 実際、csv fence のセルに脚注が漏れる件
 * (`docs/development/user-reports-2026-08-05.md` §2-1)は**漏れた HTML が golden**に
 * なっており、直すとここが落ちる。落ちたら「壊した」ではなく
 * **「PKC2 と違えた」**を疑い、上の一覧に足してから golden を更新すること。
 */
interface GoldenCase {
  name: string;
  input: string;
  options: {
    vars?: Record<string, string>;
    sourceLineAnchors?: boolean;
  };
  html: string;
  hasSyntax: boolean;
}

/**
 * render ごとに変わる設計の一意 ID(checkbox/label 対・sandbox iframe)だけを
 * 安定トークンへ正規化する。**それ以外は byte 一致を要求**。
 *
 * - **逐次番号化**: 同一 ID は同一 alias に写す(初出順に 1, 2, …)。単一トークンへの
 *   置換だと checkbox `id` / label `for` の対応や ID の出現順の壊れを検出できない
 * - **負の先読み**: `pkc-html-render-id`(属性名)/ `pkc-html-render-resize`
 *   (postMessage 型)は乱数 ID ではなく固定トークン ── 正規化で潰すと
 *   これらの契約が変わっても test が通ってしまう
 */
function makeIdAliaser(prefix: string): (match: string) => string {
  const seen = new Map<string, string>();
  return (match) => {
    let alias = seen.get(match);
    if (!alias) {
      alias = `${prefix}${seen.size + 1}`;
      seen.set(match, alias);
    }
    return alias;
  };
}

function normalizeUniqueIds(html: string): string {
  return html
    .replace(/pkc-rv-(?!resize\b|id\b)[a-z0-9]+/g, makeIdAliaser('pkc-rv-'))
    .replace(
      /pkc-html-render-(?!resize\b|id\b)[a-z0-9]+/g,
      makeIdAliaser('pkc-html-render-'),
    );
}

const goldens = JSON.parse(
  readFileSync(
    join(__dirname, '../fixtures/markdown-goldens/goldens.json'),
    'utf8',
  ),
) as {
  cases: GoldenCase[];
  inlineGolden: { input: string; html: string };
};

beforeAll(() => {
  // 寛容 parse(PKC2005〜2011)の console 通知は仕様どおりの出力 ──
  // stderr 0 行規律のため test 中は黙らせる(挙動には影響しない)
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('PKC-Markdown golden parity vs PKC2 (25 cases)', () => {
  for (const c of goldens.cases) {
    it(`renders "${c.name}" byte-identically`, () => {
      const fm = parseFrontmatter(c.input);
      // 正準系列(PKC2 detail-presenter.ts:96 と同形): vars は raw 全文から抽出
      const vars = c.options.vars ?? extractVars(c.input);
      const html = renderMarkdown(fm.body, {
        vars,
        sourceLineAnchors: c.options.sourceLineAnchors,
      });
      expect(normalizeUniqueIds(html)).toBe(normalizeUniqueIds(c.html));
      expect(hasMarkdownSyntax(fm.body)).toBe(c.hasSyntax);
    });
  }

  it('renderMarkdownInline parity', () => {
    expect(renderMarkdownInline(goldens.inlineGolden.input)).toBe(
      goldens.inlineGolden.html,
    );
  });
});
