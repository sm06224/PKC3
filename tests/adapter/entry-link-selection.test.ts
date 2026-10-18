/** @vitest-environment happy-dom */
/**
 * 台帳 #1852 束 R1(依頼 352): 語を選んで「ノートへのリンク」を入れると、選んだ語がリンクの字になる。
 * 選んでいないときは今までどおり相手の題名。
 */
import { describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { KeymapStore } from '../../src/adapter/ui/render/keymap';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { resetAppDialogForTest } from '../../src/adapter/ui/render/app-dialog';

function meta(lid: string, title: string): EntryMeta {
  return {
    lid,
    title,
    archetype: 'text',
    createdAt: null,
    updatedAt: null,
    entryOrder: 1,
    status: null,
    date: null,
    archived: false,
    bodyChars: null,
  };
}

const tick = (ms = 20): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function pickWith(value: string, start: number, end: number): Promise<HTMLTextAreaElement> {
  document.body.innerHTML = '';
  resetAppDialogForTest();
  const root = document.createElement('div');
  document.body.append(root);
  buildShell(root);
  const d = new Dispatcher();
  bindActions(root, d, {}, new KeymapStore());
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('n1', 'めも'), meta('n2', '議事録')], relations: [] });
  d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
  const detail = document.createElement('div');
  detail.setAttribute('data-pkc-region', 'detail');
  const ta = document.createElement('textarea');
  ta.setAttribute('data-pkc-field', 'editor-body');
  ta.value = value;
  detail.append(ta);
  const btn = document.createElement('button');
  btn.setAttribute('data-pkc-action', 'insert-entry-link');
  detail.append(btn);
  root.append(detail);
  ta.focus();
  ta.setSelectionRange(start, end);
  btn.click();
  await tick();
  const row = document.querySelector<HTMLElement>('[data-pkc-field="entry-pick-row"][data-pkc-lid="n2"]');
  expect(row, '前提: 選ぶ窓が開いている').not.toBeNull();
  row!.click();
  await tick();
  return ta;
}

describe('ノートへのリンク: 選んだ語がリンクの字になる(依頼 352)', () => {
  it('🔴 語を選んでいるとき: 選んだ語がリンクの字。相手の題名で置き換わらない', async () => {
    const ta = await pickWith('先週の 打ち合わせ 資料', 4, 9);
    expect(ta.value).toBe('先週の [打ち合わせ](entry:n2) 資料');
    expect(ta.value).not.toContain('議事録');
  });

  it('対照群: 選んでいない(カーソルだけ)ときは今までどおり相手の題名', async () => {
    const ta = await pickWith('hello world', 5, 5);
    expect(ta.value).toBe('hello[議事録](entry:n2) world');
  });
});
