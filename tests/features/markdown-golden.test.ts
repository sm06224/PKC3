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
  /**
   * 🔴 **PKC2 と意図的に分岐した case**(2026-08-06)。
   *
   * golden は PKC2 の出力から採取したものなので、**PKC2 のバグごと固定**される
   * (この 2 件がそうだった)。バグを直すと golden が落ちるが、そこで
   * 「golden を採り直す」と PKC2 のバグが戻ってくる ── PKC2 は read-only なので
   * **PKC3 側の正しい出力で更新し、理由を残す**のが唯一の道である。
   * ⚠ `why` の無い分岐を作らせない(下の test が件数と理由を pin する)。
   */
  pkc3Diverges?: { since: string; why: string };
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

  /**
   * 🔴 **「golden を採り直して緑にする」を塞ぐ**(2026-08-06)。
   *
   * golden が落ちたとき、正しい対応は 2 つに 1 つ ── ①実装の後退なら実装を直す
   * ②PKC2 のバグを直したのなら **理由を書いて** golden を更新する。
   * ⚠ 理由なしで更新できると、後退を「PKC2 と違うから」で押し通せてしまう。
   * だから**分岐している件数と、その理由の実在**を pin する。
   */
  /**
   * ⚠ **2026-08-06 に一度 4 件へ増やして、2 件へ戻した**。増やした理由(行頭アライン
   * `<|` を start にする)が**記法の正本と食い違っていた**ためで、user の指摘で revert した
   * (経緯は `docs/development/user-reports-2026-08-05.md` §3-1 m-2)。
   * 🔑 この test が守っているのは件数ではなく「**理由なしに golden を採り直せない**」こと ──
   * 実際、私は理由を書いて採り直したが、その理由が誤りだった。件数だけでは止められない。
   */
  it('🔴 PKC2 と分岐した case は理由つきで 2 件だけ', () => {
    const diverged = goldens.cases.filter((c) => c.pkc3Diverges);
    expect(diverged.map((c) => c.name).sort()).toEqual([
      'full-pkc-fixture',
      'full-pkc-fixture-anchors',
    ]);
    for (const c of diverged) {
      expect(c.pkc3Diverges!.since, `${c.name} に分岐した日付が無い`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(c.pkc3Diverges!.why.length, `${c.name} に理由が無い`).toBeGreaterThan(40);
    }
  });

  it('renderMarkdownInline parity', () => {
    expect(renderMarkdownInline(goldens.inlineGolden.input)).toBe(
      goldens.inlineGolden.html,
    );
  });
});
