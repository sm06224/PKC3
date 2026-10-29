/** @vitest-environment happy-dom */
/**
 * 🔴 **追記先の丸いバッジ**(台帳 #1443 の残り。Gemini 設計の 3)の印が、選びに合わせて付く・外れる。
 * 見た目の規則そのものは `append-box-frame-css.test.ts`。ここは印(`data-pkc-target-chosen`)の出し入れを見る。
 * ⚠ 枠の中に追記先・「元に戻す」・「本文に追記する」が入っていること(#1890)も一緒に守る(②④は枠の下段で満たしている)。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { AppendBoxRenderer } from '../../src/adapter/ui/render/append-box';

const meta = (lid: string): EntryMeta => ({
  lid,
  title: 't-' + lid,
  archetype: 'text',
  createdAt: null,
  updatedAt: null,
  entryOrder: 1,
  status: null,
  date: null,
  archived: false,
  bodyChars: null,
});

beforeEach(() => {
  document.body.textContent = '';
});

function setup(body: string) {
  const root = document.createElement('div');
  document.body.append(root);
  const d = new Dispatcher();
  const regions = buildShell(root);
  const box = new AppendBoxRenderer(regions.append);
  d.onState((s) => box.render(s));
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('n1')], relations: [] });
  d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
  d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body });
  const target = root.querySelector<HTMLSelectElement>('[data-pkc-field="append-target"]')!;
  return { root, target };
}

describe('追記先のバッジ (#1443)', () => {
  it('🔴 既定(末尾)では印が無く、見出しを選ぶと付き、末尾へ戻すと外れる', () => {
    const { target } = setup('# 決定事項\n本文\n\n## 次の一歩\n続き\n');
    expect(target.hidden, '見出しがあるのに畳まれている(前提)').toBe(false);
    expect(target.options.length, '見出しが並んでいない(前提)').toBeGreaterThan(1);
    expect(target.hasAttribute('data-pkc-target-chosen')).toBe(false);
    target.value = target.options[1]!.value;
    target.dispatchEvent(new Event('change', { bubbles: true }));
    expect(target.hasAttribute('data-pkc-target-chosen')).toBe(true);
    target.value = '';
    target.dispatchEvent(new Event('change', { bubbles: true }));
    expect(target.hasAttribute('data-pkc-target-chosen')).toBe(false);
  });

  it('枠の中(append-form)に、追記先・元に戻す・本文に追記するが入っている(②④)', () => {
    const { root } = setup('# 見出し\n本文\n');
    const form = root.querySelector('[data-pkc-field="append-form"]')!;
    expect(form.querySelector('[data-pkc-field="append-target"]')).not.toBeNull();
    expect(form.querySelector('[data-pkc-action="undo-append"]')).not.toBeNull();
    expect(form.querySelector('[data-pkc-action="append-entry"]')).not.toBeNull();
    expect(form.querySelector('[data-pkc-field="append-input"]')).not.toBeNull();
  });
});
