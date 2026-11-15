/** @vitest-environment happy-dom */
/**
 * #1163 依頼 361(推薦 A): 編集を保存する・やめると、キーボードの位置をそのノートの「ノートを編集する」へ戻す。
 * ⚠ 戻すのは位置がどこにも無いときだけ(user が別の所へ移っていたら奪わない)。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { DetailRenderer } from '../../src/adapter/ui/render/detail';

function meta(lid: string, title: string): EntryMeta {
  return { lid, title, archetype: 'text', createdAt: null, updatedAt: null, entryOrder: 1, status: null, date: null, archived: false, bodyChars: null };
}

function mount(): { root: HTMLElement; d: Dispatcher } {
  const root = document.createElement('div');
  document.body.append(root);
  const d = new Dispatcher();
  const regions = buildShell(root);
  const detail = new DetailRenderer(regions.detail);
  d.onState((s) => detail.render(s));
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('n1', 'あ')], relations: [] });
  d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
  d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body: '本文\n' });
  return { root, d };
}

const editBtn = (root: HTMLElement): HTMLButtonElement | null =>
  root.querySelector<HTMLButtonElement>('[data-pkc-region="detail"] [data-pkc-action="start-edit"]');

/** 編集に入って、編集欄(または題名欄)に位置を置く。 */
function enterEditing(root: HTMLElement, d: Dispatcher): void {
  d.dispatch({ type: 'START_EDIT' });
  expect(d.getState().phase, '前提: 編集に入っていない').toBe('editing');
  const field = root.querySelector<HTMLElement>('[data-pkc-region="detail"] textarea, [data-pkc-region="detail"] input');
  expect(field, '前提: 編集欄が無い').not.toBeNull();
  field!.focus();
  expect(document.activeElement).toBe(field);
}

beforeEach(() => {
  document.body.textContent = '';
});

describe('編集を抜けたら「ノートを編集する」へ位置を戻す(依頼 361)', () => {
  it('🔴 やめると、「ノートを編集する」に位置が来る', () => {
    const { root, d } = mount();
    enterEditing(root, d);
    d.dispatch({ type: 'CANCEL_EDIT' });
    expect(d.getState().phase).toBe('ready');
    expect(document.activeElement, '位置がページの先頭へ落ちた').toBe(editBtn(root));
  });

  it('🔴 保存しても、「ノートを編集する」に位置が来る', () => {
    const { root, d } = mount();
    enterEditing(root, d);
    d.dispatch({ type: 'COMMIT_EDIT' });
    expect(d.getState().phase).toBe('ready');
    expect(document.activeElement, '位置がページの先頭へ落ちた').toBe(editBtn(root));
  });

  it('⚠ 対照群 ── user が既に別の所へ移っていたら奪わない', () => {
    const { root, d } = mount();
    enterEditing(root, d);
    const elsewhere = document.createElement('input');
    document.body.append(elsewhere);
    elsewhere.focus();
    d.dispatch({ type: 'CANCEL_EDIT' });
    expect(document.activeElement, '別の所にいたのに奪った').toBe(elsewhere);
  });

  it('⚠ 対照群 ── 編集していない描き直しでは動かさない', () => {
    const { root, d } = mount();
    (document.activeElement as HTMLElement | null)?.blur();
    d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body: '本文 2\n' });
    expect(document.activeElement, '編集していないのに位置を動かした').not.toBe(editBtn(root));
  });
});
