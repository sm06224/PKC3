/** @vitest-environment happy-dom */
/**
 * 🔴 **編集中のプレビューでも `{{vars.x}}` が値になる**(#1087 N1)。
 *
 * 読む面は `readingRenderOptions` が `extractVars(全文)` を渡す。編集のプレビュー(1 面のライブ・2 列の右)は
 * `vars` を渡しておらず、設定の行で定義した変数が「未定義の変数」に見えていた。
 * 実物の `DetailRenderer` + 実物の reducer で、2 つの編集面を通す。
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { initialState, reduce } from '../../src/adapter/state/app-state';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { DetailRenderer } from '../../src/adapter/ui/render/detail';

const meta = (lid: string): EntryMeta =>
  ({ lid, title: 'N', archetype: 'text', createdAt: null, updatedAt: null, entryOrder: 1, status: null, date: null, archived: false, bodyChars: null }) as EntryMeta;

const BODY = '---\nvars:\n  proj: ALPHA-7\n---\n# {{vars.proj}} 計画\n\n担当 {{vars.proj}}\n';
const settle = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function editing(mode: 'live' | 'split'): Promise<HTMLElement> {
  localStorage.setItem('pkc3.editor-mode', mode);
  const root = document.createElement('div');
  document.body.append(root);
  const detail = new DetailRenderer(buildShell(root).detail);
  let s = reduce(initialState, { type: 'SYS_BOOTED', cid: 'c1', metas: [meta('host')], relations: [] }).state;
  s = reduce(s, { type: 'SELECT_ENTRY', lid: 'host' }).state;
  s = reduce(s, { type: 'BODY_LOADED', lid: 'host', body: BODY }).state;
  detail.render(s);
  await settle();
  s = reduce(s, { type: 'START_EDIT' } as never).state;
  detail.render(s);
  for (let i = 0; i < 6; i += 1) await settle(50);
  return root;
}

afterEach(() => {
  document.body.innerHTML = '';
  localStorage.clear();
});

describe('編集中のプレビューの {{vars}}', () => {
  for (const mode of ['live', 'split'] as const) {
    it(`🔴 ${mode}:設定の行で定義した変数が値になり、「未定義の変数」が 1 つも出ない`, async () => {
      const root = await editing(mode);
      const surface = root.querySelector<HTMLElement>(
        mode === 'live' ? '[data-pkc-region="editor-live"]' : '[data-pkc-region="editor-preview"]',
      )!;
      expect(surface, '編集の面が出ていない(前提)').not.toBeNull();
      expect(surface.querySelector('h1, p'), '描かれていない(前提)').not.toBeNull();
      expect(surface.querySelectorAll('.pkc-variable-undefined').length, '未定義の変数に見えている').toBe(0);
      expect(surface.textContent).toContain('ALPHA-7 計画');
      expect(surface.textContent).toContain('担当 ALPHA-7');
    });
  }
});
