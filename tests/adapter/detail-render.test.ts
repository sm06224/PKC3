/** @vitest-environment happy-dom */
import { describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { initialState, reduce } from '../../src/adapter/state/app-state';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { DetailRenderer } from '../../src/adapter/ui/render/detail';

function meta(lid: string): EntryMeta {
  return {
    lid,
    title: 't-' + lid,
    archetype: 'text',
    createdAt: null,
    updatedAt: null,
    entryOrder: 1,
    status: null,
    date: null,
    archived: false,
  };
}

function stateWithBody(body: string) {
  let s = reduce(initialState, {
    type: 'SYS_BOOTED',
    cid: 'c1',
    metas: [meta('a')],
    relations: [],
  }).state;
  s = reduce(s, { type: 'SELECT_ENTRY', lid: 'a' }).state;
  s = reduce(s, { type: 'BODY_LOADED', lid: 'a', body }).state;
  return s;
}

describe('detail: PKC-Markdown text presenter (P3-3)', () => {
  it('renders PKC-Markdown body (dialect included) as HTML', () => {
    const root = document.createElement('div');
    const detail = new DetailRenderer(buildShell(root).detail);
    detail.render(stateWithBody('# 見出し\n\n==ハイライト== と **強調**'));
    const rendered = root.querySelector('[data-pkc-field="detail-body"]');
    expect(rendered?.querySelector('h1')?.textContent).toContain('見出し');
    expect(rendered?.querySelector('mark')?.textContent).toBe('ハイライト');
    expect(rendered?.querySelector('h1')?.hasAttribute('data-pkc-source-line')).toBe(
      true,
    ); // Split View 用 anchor 契約
  });

  it('falls back to <pre> for plain text (hasMarkdownSyntax gate)', () => {
    const root = document.createElement('div');
    const detail = new DetailRenderer(buildShell(root).detail);
    detail.render(stateWithBody('ただのテキスト 1234'));
    const body = root.querySelector('[data-pkc-field="detail-body"]');
    expect(body?.tagName).toBe('PRE');
    expect(body?.textContent).toBe('ただのテキスト 1234');
  });

  it('applies document globals (attrs + dir) and heading numbers from frontmatter', () => {
    const root = document.createElement('div');
    const detail = new DetailRenderer(buildShell(root).detail);
    detail.render(
      stateWithBody(
        '---\nwriting: vertical\ndirection: rtl\nheading-number: true\n---\n# 序\n\n## 本',
      ),
    );
    const rendered = root.querySelector('[data-pkc-field="detail-body"]');
    expect(rendered?.getAttribute('data-pkc-writing')).toBe('vertical');
    expect(rendered?.getAttribute('dir')).toBe('rtl');
    // heading-number: true → 見出しにアウトライン番号が前置される(text レベル)
    expect(rendered?.querySelector('h1')?.textContent).toMatch(/^1\.?\s*序|^1\s/);
    expect(rendered?.querySelector('h2')?.textContent).toMatch(/1\.1/);
  });

  it('strips frontmatter and expands vars from it', () => {
    const root = document.createElement('div');
    const detail = new DetailRenderer(buildShell(root).detail);
    detail.render(
      stateWithBody('---\nvars.name: PKC3\n---\n\n# {{vars.name}} の見出し'),
    );
    const rendered = root.querySelector('[data-pkc-field="detail-body"]');
    expect(rendered?.querySelector('h1')?.textContent).toContain('PKC3 の見出し');
    expect(rendered?.textContent).not.toContain('vars.name:');
  });
});
