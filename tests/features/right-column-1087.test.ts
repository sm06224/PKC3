/** @vitest-environment happy-dom */
/**
 * #1087 右の列の直し ── 目次の見出しの集合 / 添付の数え上げが「描かれる物」と一致すること。
 *
 * 🔑 期待値は renderMarkdown が実際に出した見出しの id(描く側の読み手)から取る ── 目次側の正規表現を写さない。
 */
import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';
import { extractHeadingsFromMarkdown } from '../../src/features/markdown/markdown-toc';
import { listAppendTargets } from '../../src/features/markdown/append-target';
import { listAssetUses } from '../../src/features/asset/asset-refs-in-body';

const renderedIds = (body: string): string[] => {
  const doc = document.createElement('div');
  doc.innerHTML = renderMarkdown(body);
  return [...doc.querySelectorAll<HTMLElement>('h1[id], h2[id], h3[id]')].map((h) => h.id);
};

describe('見出しの `#` の後ろは半角の空白・タブだけ(全角空白・NBSP は見出しではない)', () => {
  const BODY = '#　全角\n\n本文\n\n## 次';
  it('全角空白: 描画の見出しは「次」だけ ── 目次・追記先も同じ', () => {
    const rendered = renderedIds(BODY);
    expect(rendered, '前提: 描画は全角空白の行を見出しにしない').toEqual(['次']);
    for (const blockForms of [false, true]) {
      expect(extractHeadingsFromMarkdown(BODY, { blockForms }).map((h) => h.slug)).toEqual(rendered);
    }
    expect(listAppendTargets(BODY).map((t) => t.slug)).toEqual(rendered);
  });
  it('NBSP も同じ。対照群: 半角空白・タブは見出し', () => {
    const nb = '#\u00a0nb\n\n## 次';
    expect(extractHeadingsFromMarkdown(nb, { blockForms: true }).map((h) => h.slug)).toEqual(renderedIds(nb));
    expect(listAppendTargets(nb).map((t) => t.slug)).toEqual(renderedIds(nb));
    const ok = '# a\n\n#\tb\n';
    expect(extractHeadingsFromMarkdown(ok, { blockForms: true }).map((h) => h.slug)).toEqual(['a', 'b']);
    expect(listAppendTargets(ok).map((t) => t.slug)).toEqual(['a', 'b']);
  });
});

describe('番号つきの箇条書きの中の見出し(`1. ## n`)も目次に出る', () => {
  it.each(['1. ## n\n\n## n', '1) ## n\n\n## n', '1. - ## n\n\n## n'])('%j', (body) => {
    const rendered = renderedIds(body);
    expect(rendered, '前提: 描画は 2 つとも見出しにする').toEqual(['n', 'n-1']);
    expect(extractHeadingsFromMarkdown(body, { blockForms: true }).map((h) => h.slug)).toEqual(rendered);
  });
  it('対照群: 桁が多すぎる番号(10 桁)は箇条書きではないので見出しにならない', () => {
    const body = '1234567890. ## n\n\n## m';
    expect(extractHeadingsFromMarkdown(body, { blockForms: true }).map((h) => h.slug)).toEqual(renderedIds(body));
  });
});

describe('listAssetUses は描かれない部分の参照を数えない', () => {
  it.each([
    ['行内の %%…%%', '%%![x](asset:k1)%%'],
    ['%%% の塊', '%%%\n![x](asset:k1)\n%%%'],
    [':::comment', ':::comment\n![x](asset:k1)\n:::'],
    ['合わない :::if', ':::if{format=docx}\n![x](asset:k1)\n:::'],
  ])('%s の中は一覧に出ない', (_n, hidden) => {
    expect(listAssetUses(hidden)).toEqual([]);
    // 対照群: 外に出した同じ参照は出る
    expect(listAssetUses(`${hidden}\n\n![v](asset:k2)`).map((u) => u.key)).toEqual(['k2']);
  });
  it('隠れた塊の後ろの参照は、原文の行番号のまま', () => {
    const body = ['%%%', '隠し', '隠し', '%%%', '', '![v](asset:k2)'].join('\n');
    expect(listAssetUses(body)).toEqual([{ key: 'k2', label: 'v', line: 6, kind: 'image', count: 1 }]);
    const withIf = [':::if{format=docx}', 'x', ':::', '', '[l](asset:k3)'].join('\n');
    expect(listAssetUses(withIf).map((u) => [u.key, u.line])).toEqual([['k3', 5]]);
  });
  it('対照群: 合う :::if(html)の中は出る', () => {
    expect(listAssetUses(':::if{format=html}\n![x](asset:k1)\n:::').map((u) => u.key)).toEqual(['k1']);
  });
});
