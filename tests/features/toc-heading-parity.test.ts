/** @vitest-environment happy-dom */
/**
 * 目次と本文の見出しが**同じ読み手**から出ていること(2026-08-07)。
 *
 * 🔴 直す前は読み手が **2 つ**あった ── 本文の id は markdown-it の token(前処理を
 * 23 段通った文字列)から、目次は**原文の行の正規表現**から作られていた。
 * 目次側が通っていた前処理は 3 段だけで、しかもその 3 段も別実装。結果、
 * **13 類**の食い違いが出ていた(押しても飛ばない / 隠したはずの見出しが目次に出る /
 * 中央寄せの見出しが目次から落ちる、など)。
 *
 * 🔑 この test が守るのは **1 つの不変**である:
 *   **目次の `href` は、本文に実在する見出しの `id` である。**
 * ⚠ それだけでは「目次が常に空」でも通るので、**逆向き**も見る ──
 *   深さの条件を満たす見出しは、**全部・文書順で**目次に出る。
 *
 * ⚠ **代表 1 件を並べる形にしない**(それでは 14 類目の食い違いを誰も捕まえない)。
 *   corpus を回して**全件**突合し、さらに goldens 25 件の本文にも `:::toc` を足して
 *   同じ不変を掛ける ── 実文書の幅は自分で書いた corpus では作れない。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';
import { parseFrontmatter, extractVars } from '../../src/features/markdown/frontmatter';

/** 私用領域の sentinel(U+E110〜U+E17F)。⚠ 不可視なので目で見ても気づけない。 */
const SENTINEL_RANGE = /[\u{E110}-\u{E17F}]/u;

interface Seen {
  /** 本文に実在する見出し(id を持つものだけ)。 */
  headings: { level: number; id: string; label: string }[];
  /** 目次の項目。 */
  items: { level: number; href: string; label: string; childTags: string[] }[];
  navs: number;
}

function look(html: string): Seen {
  const doc = document.createElement('div');
  doc.innerHTML = html;
  // ⚠ nav の中の見出しは拾わない(nav は h を持たないが、規則として書いておく)
  const headings = [...doc.querySelectorAll<HTMLElement>('h1[id], h2[id], h3[id]')]
    .filter((h) => h.closest('nav.pkc-toc-formal') === null)
    .map((h) => ({
      level: Number(h.tagName.slice(1)),
      id: h.id,
      label: h.textContent ?? '',
    }));
  const items = [...doc.querySelectorAll<HTMLAnchorElement>('a.pkc-toc-link')].map((a) => ({
    level: Number(a.parentElement?.getAttribute('data-pkc-toc-level') ?? '0'),
    href: (a.getAttribute('href') ?? '').replace(/^#/, ''),
    label: a.textContent ?? '',
    /**
     * 🔴 **`textContent` はタグを剥がしてしまう**(2026-08-07、変異試験で判明)。
     * だから「目次の字が合っている」だけを見ると、`<a>` の中に `<code>` や
     * `<span>` が**入り込んでいても素通り**する。要素の子は 0 でなければならない。
     */
    childTags: [...a.children].map((c) => c.tagName.toLowerCase()),
  }));
  return { headings, items, navs: doc.querySelectorAll('nav.pkc-toc-formal').length };
}

/**
 * 1 文書ぶんの不変を検める。
 * @param depth その `:::toc` の深さ(目次に出る見出しの上限)
 */
function assertParity(name: string, html: string, depth: number): Seen {
  const s = look(html);
  // ① 目次の行き先は**全部**実在する
  const ids = new Set(s.headings.map((h) => h.id));
  const dangling = s.items.filter((i) => !ids.has(i.href));
  expect(dangling.map((d) => d.href), `${name}: 飛べない目次の項目`).toEqual([]);

  // ② 逆向き ── 深さの条件を満たす見出しは、全部・文書順で目次に出る
  //    ⚠ これが無いと「目次が常に空」でも ① は通る
  const want = s.headings.filter((h) => h.level <= depth);
  expect(
    s.items.map((i) => `${i.level}:${i.href}`),
    `${name}: 目次の並びが本文と違う`,
  ).toEqual(want.map((h) => `${h.level}:${h.id}`));

  // ③ 見える字も一致する(href だけ合っていて字が別物、を通さない)
  expect(
    s.items.map((i) => i.label),
    `${name}: 目次の文字が本文の見出しと違う`,
  ).toEqual(want.map((h) => h.label));

  // ④ 🔴 目次の項目は **素の字だけ**(要素の子を持たない)。
  //    ⚠ これが `postProcessTocSentinels` を post 段の**最後**に置いていることの
  //      観測点である。手前へ戻すと nav が先に挿し込まれ、**後続の post 段が
  //      nav の中まで書き換える** ── `<a>` の中に `<span class="…">` が生える。
  //      ①②③ は `textContent` で見るので**全部素通りする**(実際に素通りした)。
  const withChild = s.items.filter((i) => i.childTags.length > 0);
  expect(
    withChild.map((i) => `${i.href}:${i.childTags.join(',')}`),
    `${name}: 目次の項目の中に要素が入っている`,
  ).toEqual([]);

  // ⑤ 不可視の sentinel も載っていない(④ と別の壊れ方 ── 変換されずに残る形)
  const withSentinel = s.items.filter((i) => SENTINEL_RANGE.test(i.label));
  expect(withSentinel.map((i) => i.href), `${name}: 目次の文字に sentinel が残っている`).toEqual([]);
  return s;
}

/**
 * 食い違いが出ていた 13 類の代表。⚠ **これは網羅ではない**(網羅は下の goldens 側)。
 * 記法を足したらここにも足す ── 足さないと、その記法は誰にも守られない。
 */
const CORPUS: ReadonlyArray<{
  name: string;
  body: string;
  depth: number;
  headingNumber?: { start: number };
  /** その case が「何を実際に出しているか」の空振り防止。 */
  expectIds?: string[];
}> = [
  {
    name: '採番(id は 1-第一 / 目次も同じ先を指す)',
    body: '# 第一\n\n## 第二\n\n:::toc{depth=2}\n',
    depth: 2,
    headingNumber: { start: 1 },
    expectIds: ['1-第一', '11-第二'],
  },
  {
    name: '行内コメント(本文から消えた字は目次からも消える)',
    body: '# 見出し %%隠す%% つき\n\n:::toc\n',
    depth: 3,
    expectIds: ['見出し-つき'],
  },
  {
    name: 'コメントブロック(中の見出しは目次にも出ない)',
    body: '%%%\n## 隠したはずの見出し\n%%%\n\n## 出る見出し\n\n:::toc\n',
    depth: 3,
    expectIds: ['出る見出し'],
  },
  {
    name: ':::comment(同上)',
    body: ':::comment\n## 消える見出し\n:::\n\n## 残る\n\n:::toc\n',
    depth: 3,
    expectIds: ['残る'],
  },
  {
    name: '行頭寄せの付いた見出し(目次から落ちない)',
    body: '||## 中央見出し\n\n## ふつう\n\n:::toc\n',
    depth: 3,
    expectIds: ['中央見出し', 'ふつう'],
  },
  {
    name: '字下げの付いた見出し',
    body: '__ ## 字下げ見出し\n\n## ふつう\n\n:::toc\n',
    depth: 3,
  },
  {
    name: 'setext 見出し(=== で作る形)',
    body: '見出し一\n===\n\n## atx\n\n:::toc\n',
    depth: 3,
    expectIds: ['見出し一', 'atx'],
  },
  {
    name: '引用の中の見出し',
    body: '> # 引用内見出し\n\n## 外\n\n:::toc\n',
    depth: 3,
    expectIds: ['引用内見出し', '外'],
  },
  {
    name: 'リストの中の見出し',
    body: '- # リスト内見出し\n\n## 外\n\n:::toc\n',
    depth: 3,
  },
  {
    name: 'fence の中の見出しは出ない(``` を ~~~ で閉じない)',
    body: '```\n# フェンス内見出し\n~~~\n```\n\n## 外\n\n:::toc\n',
    depth: 3,
    expectIds: ['外'],
  },
  {
    name: '変数(展開後の字で並ぶ)',
    body: '---\nvars:\n  site: サイト\n---\n\n# {{vars.site}} の話\n\n:::toc\n',
    depth: 3,
  },
  {
    name: '未定義の変数(本文と同じ見え方になる)',
    body: '# {{vars.nope}} の話\n\n:::toc\n',
    depth: 3,
  },
  {
    name: ':::if で消える見出し',
    body: ':::if{format=docx}\n## 出ない\n:::\n\n## 外\n\n:::toc\n',
    depth: 3,
    expectIds: ['外'],
  },
  {
    name: '同名の見出し(衝突の連番がずれない)',
    body: '||# 同じ\n\n# 同じ\n\n:::toc\n',
    depth: 3,
    expectIds: ['同じ', '同じ-1'],
  },
  {
    name: '深さで切る(depth=1 は h1 だけ)',
    body: '# 一\n\n## 二\n\n### 三\n\n:::toc{depth=1}\n',
    depth: 1,
    expectIds: ['一', '二', '三'],
  },
  {
    name: '見出しの中の記号は目次では素の字になる',
    body: '# `コード` と **強調**\n\n:::toc\n',
    depth: 3,
  },
  {
    // 🔴 中身がコメントで全部消えると `heading_open` は id を付けない ──
    //    飛べない見出しなので目次にも出さない(出すと押しても動かない項目になる)
    name: '中身が全部消えた見出しは目次に出ない(飛べないものを出さない)',
    body: '# %%全部%%\n\n## 残る\n\n:::toc\n',
    depth: 3,
    expectIds: ['残る'],
  },
  {
    // 🔴 拾うのは **escape 済みの HTML** ── もう一度 escape すると
    //    `&amp;` が `&amp;amp;` になって画面に出る
    name: '& を含む見出し(二重 escape しない)',
    body: '# A & B の話\n\n:::toc\n',
    depth: 3,
  },
];

describe('目次と本文の見出しは同じ読み手から出る', () => {
  for (const c of CORPUS) {
    it(c.name, () => {
      const fm = parseFrontmatter(c.body);
      const html = renderMarkdown(fm.body, {
        vars: extractVars(c.body),
        headingNumber: c.headingNumber ?? null,
      });
      const seen = assertParity(c.name, html, c.depth);
      // ⚠ **空振り防止**: この case が実際に目次を出していること
      expect(seen.navs, `${c.name}: 目次が 1 つも出ていない(何も検めていない)`).toBe(1);
      if (c.expectIds) {
        expect(seen.headings.map((h) => h.id), `${c.name}: 本文の見出しが想定と違う`).toEqual(
          c.expectIds,
        );
      }
    });
  }

  /**
   * 🔴 **実文書の幅は自分で書いた corpus では作れない**。goldens 25 件の本文の末尾に
   * `:::toc{depth=3}` を足して、同じ不変を掛ける。
   *
   * ⚠ goldens そのものは**この機構を 1 バイトも守っていない** ── `:::toc` を入力に
   *   持つのは 1 件だけで、それは fence / 散文の中なので nav が 1 つも出ない(実測)。
   *   だから「goldens が緑だから安全」は、この主題については成立しない。
   */
  it('🔴 goldens 25 件の本文でも不変が成り立つ(実文書の幅)', () => {
    const goldens = JSON.parse(
      readFileSync(join(__dirname, '../fixtures/markdown-goldens/goldens.json'), 'utf8'),
    ) as { cases: { name: string; input: string; options: { vars?: Record<string, string> } }[] };

    let withNav = 0;
    let totalItems = 0;
    for (const c of goldens.cases) {
      const fm = parseFrontmatter(c.input);
      // ⚠ 末尾に足す ── fence の途中で終わる本文では nav が出ないことがあるので、
      //   出た case にだけ不変を掛け、出た件数を下で assert する
      const html = renderMarkdown(`${fm.body}\n\n:::toc{depth=3}\n`, {
        vars: c.options.vars ?? extractVars(c.input),
      });
      const seen = look(html);
      if (seen.navs === 0) continue;
      withNav += 1;
      totalItems += seen.items.length;
      assertParity(c.name, html, 3);
    }
    // ⚠ **空振り防止は 2 段**。件数だけだと「nav は出たが項目 0」で満たせる
    expect(withNav, 'goldens から目次が出た件数が少なすぎる').toBeGreaterThanOrEqual(20);
    expect(totalItems, 'goldens の目次に項目が 1 つも無い').toBeGreaterThan(50);
  });
});
