/**
 * 🔴 **リッチ編集のブロック挿入の一覧**(v4.0 Phase 1 / PR-06)── 12 種の結果が正しい PKC-Markdown になり、構造を壊さないこと。
 */
import { describe, expect, it } from 'vitest';
import {
  applyRichInsert,
  filterRichInsert,
  RICH_INSERT_ITEMS,
  slashQueryOf,
  type RichInsertId,
} from '../../../src/features/markdown/rich-insert';
import { renderMarkdown } from '../../../src/features/markdown/markdown-render';
import { prepareRichBlock } from '../../../src/features/markdown/rich-block';
import { DIAGRAM_TEMPLATES, SCENE_3D_BLOCK } from '../../../src/features/markdown/text-ops';
import { parse3dSceneSpec } from '../../../src/features/viewer3d/scene-spec';

/** 期待値は固定の字(実装と同じ規則で作らない)。 */
const EMPTY: Record<RichInsertId, { text: string; mode: 'rich' | 'source'; tag: RegExp }> = {
  h1: { text: '# ', mode: 'rich', tag: /<h1/ },
  h2: { text: '## ', mode: 'rich', tag: /<h2/ },
  h3: { text: '### ', mode: 'rich', tag: /<h3/ },
  ul: { text: '- ', mode: 'rich', tag: /<ul/ },
  ol: { text: '1. ', mode: 'rich', tag: /<ol/ },
  task: { text: '- [ ] ', mode: 'rich', tag: /<ul/ },
  quote: { text: '> ', mode: 'rich', tag: /<blockquote/ },
  codeblock: { text: '```\n\n```', mode: 'source', tag: /<pre/ },
  table: { text: '| 項目 | 値 |\n|---|---|\n|  |  |', mode: 'source', tag: /<table/ },
  callout: { text: ':::note\n\n:::', mode: 'source', tag: /pkc-section-note/ },
  pagebreak: { text: '+++', mode: 'source', tag: /<hr class="pkc-section-break"/ },
  mermaid: { text: '```mermaid\ngraph TD\n  A-->B\n```', mode: 'source', tag: /data-pkc-render-lang="mermaid"/ },
  scene3d: {
    text:
      '```3d\n{ "objects": [\n' +
      '    { "type": "box", "position": [0, 0.5, 0], "color": "#4a90d9", "label": "土台" },\n' +
      '    { "type": "sphere", "position": [0, 1.5, 0], "size": 0.6, "color": "#e0a030", "label": "上の段" }\n' +
      '  ],\n  "camera": { "position": [3, 3, 4] },\n  "grid": true }\n```',
    mode: 'source',
    tag: /data-pkc-render-lang="3d"/,
  },
};

describe('rich-insert の一覧', () => {
  it('13 種がこの順で並ぶ(見出し 1〜3・箇条書き・番号・チェック・引用・コード・表・注意書き・改ページ・図・3D シーン)', () => {
    expect(RICH_INSERT_ITEMS.map((i) => i.id)).toEqual([
      'h1', 'h2', 'h3', 'ul', 'ol', 'task', 'quote', 'codeblock', 'table', 'callout', 'pagebreak', 'mermaid', 'scene3d',
    ]);
    expect(new Set(RICH_INSERT_ITEMS.map((i) => i.label)).size).toBe(13);
  });

  it.each(RICH_INSERT_ITEMS.map((i) => i.id))('空の段落(/ で開いた)に %s を当てると決まった原文になり、描画でその要素になる', (id) => {
    const want = EMPTY[id];
    const r = applyRichInsert(id, '/', true);
    expect(r.text).toBe(want.text);
    expect(r.mode).toBe(want.mode);
    expect(r.start).toBeGreaterThanOrEqual(0);
    expect(r.end).toBeLessThanOrEqual(r.text.length);
    // 中身を入れて描くと、その種類の要素になる(構造を壊さない)
    const filled = want.mode === 'rich' ? `${want.text}字` : want.text;
    expect(renderMarkdown(filled, {})).toMatch(want.tag);
  });

  it('種類を変える項目は中身をそのまま新しい枠へ移し、リッチのまま開ける形になる', () => {
    const doc = new DOMParser();
    const parse = (html: string): Element => doc.parseFromString(`<div>${html}</div>`, 'text/html').body.firstElementChild!;
    const render = (md: string): string => renderMarkdown(md, {});
    for (const [id, want] of [
      ['h2', '## 本文 **太字**'],
      ['ul', '- 本文 **太字**'],
      ['ol', '1. 本文 **太字**'],
      ['task', '- [ ] 本文 **太字**'],
      ['quote', '> 本文 **太字**'],
    ] as const) {
      const r = applyRichInsert(id, '本文 **太字**', false);
      expect(r.text).toBe(want);
      expect(r.mode).toBe('rich');
      expect(prepareRichBlock(r.text, render, parse), `${id} がリッチで開けない`).not.toBeNull();
    }
    // 見出し → 箇条書き(記号ごと変わる。# が中身に残らない)
    expect(applyRichInsert('ul', '### 題', false).text).toBe('- 題');
  });

  it('差し込む項目は、中身があるブロックを保ったまま後ろに空行を挟んで足す(caret はテンプレートの中)', () => {
    const r = applyRichInsert('codeblock', '本文', false);
    expect(r.text).toBe('本文\n\n```\n\n```');
    expect(r.mode).toBe('source');
    expect(r.text.slice(0, r.start)).toBe('本文\n\n```\n');
    const t = applyRichInsert('table', '# 題', false);
    expect(t.text.startsWith('# 題\n\n| 項目 | 値 |')).toBe(true);
  });

  it('/ の後ろの字で絞り込む(日本語・英語・全角)', () => {
    expect(filterRichInsert('').length).toBe(13);
    expect(filterRichInsert('見出し').map((i) => i.id)).toEqual(['h1', 'h2', 'h3']);
    expect(filterRichInsert('code').map((i) => i.id)).toEqual(['codeblock']);
    expect(filterRichInsert('ｃｏｄｅ').map((i) => i.id)).toEqual(['codeblock']);
    expect(filterRichInsert('表').map((i) => i.id)).toEqual(['table']);
    expect(filterRichInsert('zzz')).toEqual([]);
    // 🔴 /3d・/立体 で 3D シーンに当たる(全角の ３ｄ も)
    expect(filterRichInsert('3d').map((i) => i.id)).toEqual(['scene3d']);
    expect(filterRichInsert('３Ｄ').map((i) => i.id)).toEqual(['scene3d']);
    expect(filterRichInsert('立体').map((i) => i.id)).toEqual(['scene3d']);
  });

  it('🔴 3D シーンの差し込みは、そのまま描ける JSON(誤り 0 件)で、「テンプレートを挿入」と同じ字', () => {
    const r = applyRichInsert('scene3d', '/3d', true);
    const inner = r.text.split('\n').slice(1, -1).join('\n');
    const parsed = parse3dSceneSpec(inner);
    expect(parsed.ok, parsed.ok ? '' : parsed.error).toBe(true);
    expect(`${r.text}\n`).toBe(SCENE_3D_BLOCK.text);
    expect(DIAGRAM_TEMPLATES.find((d) => d.id === '3d')?.block).toBe(SCENE_3D_BLOCK);
    // 中身のあるブロックの後ろには空行を挟んで足す
    expect(applyRichInsert('scene3d', '本文', false).text.startsWith('本文\n\n```3d\n')).toBe(true);
  });

  it('スラッシュの絞り込みの字か(/ か ／ で始まり、空白を含まない)', () => {
    expect(slashQueryOf('/')).toBe('');
    expect(slashQueryOf('／')).toBe('');
    expect(slashQueryOf('/見出し')).toBe('見出し');
    expect(slashQueryOf('a/')).toBeNull();
    expect(slashQueryOf('/ a')).toBeNull();
    expect(slashQueryOf('')).toBeNull();
  });
});
