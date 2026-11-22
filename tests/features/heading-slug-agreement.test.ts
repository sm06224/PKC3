/**
 * 🔴 **見出しの印(slug)は本文・目次・追記先の 3 つで同じ**(#2018。user 裁定 2026-11-22 の必須ガード)。
 *
 * 追記先の一覧は `######` まで数えるようになった(ログの入れ子の追記が `####` 以下に入るため)。
 * ⚠ 連番(`makeSlugCounter`)は**出会った順**に `-1` `-2` を振るので、どれか 1 つだけ数える段が違うと、
 *   `#### 概要` の後ろの `## 概要` が、こちらでは `概要`、向こうでは `概要-1` になる(右ペインの目次で押しても
 *   別の見出しへ飛ぶ / 追記先で選んだ節と別の節へ入る)。
 * 🔑 3 つとも 1〜6 段を通して連番を振り、**目次は表示だけ** 3 段までに絞る。
 */
import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';
import { extractHeadingsFromMarkdown } from '../../src/features/markdown/markdown-toc';
import { listAppendTargets } from '../../src/features/markdown/append-target';

/** 描いた本文の見出しを出会った順に(段・字・id)。 */
function renderedHeadings(md: string): { level: number; text: string; id: string }[] {
  const html = renderMarkdown(md, {});
  return [...html.matchAll(/<h([1-6])([^>]*)>([^<]*)/g)].map((m) => ({
    level: Number(m[1]),
    text: m[3]!.trim(),
    id: /\sid="([^"]*)"/.exec(m[2]!)?.[1] ?? '',
  }));
}

const DOC = ['# 前置き', '', '#### 概要', '', '深い節', '', '## 概要', '', '浅い節', '', '###### 概要', '', '一番深い', '', '### 概要', '', '最後', ''].join('\n');

describe('見出しの印は 1〜6 段を通して揃う', () => {
  it('🔴 同じ字の見出しが `####` と `##` に混ざる文書で、本文の id・目次・追記先の印が一致する', () => {
    const rendered = renderedHeadings(DOC);
    // 前提: 描画は 5 つ全部に id を刻む(h4・h6 にも)
    expect(rendered.map((h) => h.level)).toEqual([1, 4, 2, 6, 3]);
    expect(rendered.every((h) => h.id !== ''), 'id の無い見出しがある').toBe(true);
    // 🔑 期待値は実装の関数ではなく固定の字で書く(実装と同じ盲点を持たない)
    expect(rendered.map((h) => h.id)).toEqual(['前置き', '概要', '概要-1', '概要-2', '概要-3']);

    const targets = listAppendTargets(DOC);
    expect(targets.map((t) => [t.level, t.slug])).toEqual(rendered.map((h) => [h.level, h.id]));

    const toc = extractHeadingsFromMarkdown(DOC);
    // 目次は 3 段まで(表示は変えない)── ただし印は本文の同じ見出しの id と同じ
    expect(toc.map((t) => [t.level, t.slug])).toEqual([
      [1, '前置き'],
      [2, '概要-1'],
      [3, '概要-3'],
    ]);
    for (const t of toc) expect(rendered.some((h) => h.level === t.level && h.id === t.slug), `目次の ${t.slug} が本文に無い`).toBe(true);
  });

  /**
   * 🔴 **引用・リストの中の見出し / 下線の見出しも連番を進める**(着地前レビュー ⚠2)── 追記先には選べず、目次も
   *   (並べない呼び手では)並べないが、描画は id を刻むので、数えないと後ろの同じ字の見出しの印がずれる。
   */
  it('🔴 引用の中の `####`・リストの中の `###`・下線の見出しが混ざっても、後ろの `## 概要` の印は 3 者で同じ', () => {
    const md = ['> #### 概要', '', '- ### 概要', '', '概要', '---', '', '## 概要', '', '本文', ''].join('\n');
    const rendered = renderedHeadings(md);
    // 描画は 4 つとも見出しにし、出会った順に連番を振る
    expect(rendered.map((h) => [h.level, h.id])).toEqual([
      [4, '概要'],
      [3, '概要-1'],
      [2, '概要-2'],
      [2, '概要-3'],
    ]);
    const last = rendered[3]!.id;
    // 追記先: 平の ATX だけを並べる(引用・リスト・下線の… は選べない/下線は選べる)が、印は描画と同じ
    const targets = listAppendTargets(md);
    expect(targets.find((t) => t.text === '概要' && t.level === 2 && t.slug === last), '追記先の `## 概要` の印が描画とずれた').toBeDefined();
    // 目次(並べない呼び手 / 並べる呼び手)のどちらでも、`## 概要` の印は描画と同じ
    expect(extractHeadingsFromMarkdown(md).at(-1)?.slug, '目次(既定)の印が描画とずれた').toBe(last);
    expect(extractHeadingsFromMarkdown(md, { blockForms: true }).map((t) => t.slug)).toEqual(['概要-1', '概要-2', '概要-3']);
  });

  it('対照群: 深い見出しが無ければ連番は飛ばない', () => {
    const md = '## 概要\n\n本文\n\n## 概要\n';
    expect(extractHeadingsFromMarkdown(md).map((t) => t.slug)).toEqual(['概要', '概要-1']);
    expect(listAppendTargets(md).map((t) => t.slug)).toEqual(['概要', '概要-1']);
  });
});
