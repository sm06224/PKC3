/** @vitest-environment happy-dom */
/**
 * 🔴 章の欄・コード枠の欄で `Ctrl+S` / `Ctrl+Enter` が「保存する」ボタンと同じに効く(#1087)。
 * 直す前は受けず `preventDefault` もしなかったので、ブラウザの「ページを保存」が開いた。
 * あわせて、本文の下の追記欄を空のまま押したときは黙らず、欄へ焦点を戻して次にすることを言う。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { SECTION_SAVE_MISMATCH_NOTE, CODE_SAVE_MISMATCH_NOTE } from '../../src/adapter/state/app-state';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { bindActions, type BinderServices } from '../../src/adapter/ui/actions/binder';
import { SECTION_BOX_REGION, SECTION_BOX_INPUT_FIELD } from '../../src/adapter/ui/render/section-box';
import { CODE_BOX_REGION, CODE_BOX_INPUT_FIELD } from '../../src/adapter/ui/render/code-box';

const meta = (lid: string): never =>
  ({ lid, title: lid, archetype: 'text', created_at: null, updated_at: null, entry_order: 1, status: null, date: null, archived: 0 }) as never;

function box(region: string, field: string, action: string) {
  document.body.textContent = '';
  const root = document.createElement('div');
  root.setAttribute('data-pkc-slot', 'root');
  const r = document.createElement('div');
  r.setAttribute('data-pkc-region', region);
  const ta = document.createElement('textarea');
  ta.setAttribute('data-pkc-field', field);
  const btn = document.createElement('button');
  btn.setAttribute('data-pkc-action', action);
  r.append(ta, btn);
  root.append(r);
  document.body.append(root);
  bindActions(root, new Dispatcher(), { showStatus: () => {} } as Partial<BinderServices> as BinderServices);
  const pressed = vi.fn();
  btn.addEventListener('click', pressed);
  return { ta, btn, pressed };
}

const key = (ta: HTMLElement, init: KeyboardEventInit): KeyboardEvent => {
  const ev = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  ta.dispatchEvent(ev);
  return ev;
};

describe.each([
  ['章の欄', SECTION_BOX_REGION, SECTION_BOX_INPUT_FIELD, 'save-section-draft'],
  ['コード枠の欄', CODE_BOX_REGION, CODE_BOX_INPUT_FIELD, 'save-code-draft'],
])('%s', (_n, region, field, action) => {
  it.each([
    ['Ctrl+S', { key: 's', ctrlKey: true }],
    ['Ctrl+Enter', { key: 'Enter', ctrlKey: true }],
    ['Cmd+S', { key: 's', metaKey: true }],
  ])('%s で保存ボタンを押したのと同じになり、ブラウザの既定は止まる', (_k, init) => {
    const t = box(region, field, action);
    const ev = key(t.ta, init);
    expect(ev.defaultPrevented, 'ブラウザの「ページを保存」が開く').toBe(true);
    expect(t.pressed).toHaveBeenCalledTimes(1);
  });
  it('修飾キー無しの S / Enter は握らない(打つ字を奪わない)', () => {
    const t = box(region, field, action);
    expect(key(t.ta, { key: 's' }).defaultPrevented).toBe(false);
    expect(key(t.ta, { key: 'Enter' }).defaultPrevented).toBe(false);
    expect(t.pressed).not.toHaveBeenCalled();
  });
  it('保存中(ボタンが disabled)は二重に撃たない', () => {
    const t = box(region, field, action);
    t.btn.disabled = true;
    key(t.ta, { key: 's', ctrlKey: true });
    expect(t.pressed).not.toHaveBeenCalled();
  });
});

describe('別の場所で書き換えられたときの断り文(#1087)', () => {
  it.each([
    ['章', SECTION_SAVE_MISMATCH_NOTE, '章の編集をやめる', 'この章を編集する', 'src/adapter/ui/render/section-box.ts', 'src/features/entry-actions.ts'],
    ['コード', CODE_SAVE_MISMATCH_NOTE, 'コードの編集をやめる', 'このコードを編集する', 'src/adapter/ui/render/code-box.ts', 'src/features/markdown/markdown-render.ts'],
  ])('%s: 押す物を、画面に実在するボタンの字で順に言う', (_n, note, cancel, open, cancelFile, openFile) => {
    expect(note).toContain(`「${cancel}」を押し`);
    expect(note).toContain(`もう一度「${open}」で開いてください`);
    expect(note, 'やめる前にコピーする順').toMatch(/コピーしてから.*やめる/);
    // ⚠ 案内する字が画面に実在する(手で書いた字どうしを比べない)
    expect(readFileSync(cancelFile, 'utf8')).toContain(`'${cancel}'`);
    expect(readFileSync(openFile, 'utf8')).toContain(open);
  });
});

describe('追記欄を空のまま押す', () => {
  it('黙らず、欄へ焦点を戻して次にすることを出す(エラーにはしない)', () => {
    document.body.textContent = '';
    const root = document.createElement('div');
    root.setAttribute('data-pkc-slot', 'root');
    const input = document.createElement('textarea');
    input.setAttribute('data-pkc-field', 'append-input');
    const btn = document.createElement('button');
    btn.setAttribute('data-pkc-action', 'append-entry');
    root.append(input, btn);
    document.body.append(root);
    const d = new Dispatcher();
    const said: string[] = [];
    bindActions(root, d, { showStatus: (t: string) => void said.push(t) } as Partial<BinderServices> as BinderServices);
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('n1')], relations: [] });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body: '本文' });
    input.value = '  \n ';
    btn.click();
    expect(said).toContain('追記する内容を打ってから、もう一度押してください');
    expect(document.activeElement).toBe(input);
    expect(d.getState().error, '注意であってエラーではない').toBeNull();
  });
});
