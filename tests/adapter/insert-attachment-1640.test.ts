/** @vitest-environment happy-dom */
/**
 * 🔴 **書式の帯の「添付を入れる」**(#1640 ④。🟣 Gemini 依頼 37 の答え = A)。
 * 題名で探して選ぶと、画像は画像の行・ほかのファイルはリンクの行が、打っている場所に入る。
 */
import { describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { resetAppDialogForTest } from '../../src/adapter/ui/render/app-dialog';
import { KeymapStore } from '../../src/adapter/ui/render/keymap';
import { buildFormatBar } from '../../src/adapter/ui/render/format-bar';

function meta(lid: string, title: string, archetype: EntryMeta['archetype'] = 'text'): EntryMeta {
  return {
    lid,
    title,
    archetype,
    createdAt: null,
    updatedAt: null,
    entryOrder: 1,
    status: null,
    date: null,
    archived: false,
    bodyChars: 0,
  };
}
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const att = (name: string, mime: string, key: string): string =>
  `---\nattachment.name: ${name}\nattachment.mime: ${mime}\nattachment.asset_key: ${key}\n---\n`;

function boot(bodies: Record<string, string>) {
  document.body.innerHTML = '';
  resetAppDialogForTest();
  const root = document.createElement('div');
  document.body.append(root);
  buildShell(root);
  const d = new Dispatcher();
  bindActions(
    root,
    d,
    { readBodies: async (lids) => new Map(lids.filter((l) => l in bodies).map((l) => [l, bodies[l]!])) },
    new KeymapStore(),
  );
  d.dispatch({
    type: 'SYS_BOOTED',
    cid: 'c1',
    metas: [
      meta('n1', 'めも'),
      meta('a1', '写真', 'attachment'),
      meta('a2', '仕様書', 'attachment'),
      meta('t1', '写真の話'),
    ],
    relations: [],
  });
  d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
  const detail = document.createElement('div');
  detail.setAttribute('data-pkc-region', 'detail');
  const ta = document.createElement('textarea');
  ta.setAttribute('data-pkc-field', 'editor-body');
  ta.value = 'hello world';
  detail.append(ta, buildFormatBar());
  root.append(detail);
  ta.focus();
  ta.setSelectionRange(5, 5);
  return { root, d, ta };
}

describe('添付を入れる(書式の帯)', () => {
  it('🔴 帯にボタンが在り、字は「添付を入れる」', () => {
    const { root } = boot({});
    const b = root.querySelector('[data-pkc-action="insert-attachment"] [data-pkc-field="label"]');
    expect(b?.textContent).toBe('添付を入れる');
  });

  it('🔴 候補は添付のノートだけ(同じ語を題名に持つふつうのノートは出ない)', async () => {
    const { root } = boot({});
    root.querySelector<HTMLElement>('[data-pkc-action="insert-attachment"]')!.click();
    await tick();
    const lids = [...document.querySelectorAll('[data-pkc-field="entry-pick-row"]')].map((r) =>
      r.getAttribute('data-pkc-lid'),
    );
    expect(lids.sort()).toEqual(['a1', 'a2']);
  });

  it('🔴 画像は画像の行、ほかのファイルはリンクの行が、カーソルの位置に入る', async () => {
    const { root, ta } = boot({
      a1: att('photo.png', 'image/png', 'k1'),
      a2: att('spec.pdf', 'application/pdf', 'k2'),
    });
    root.querySelector<HTMLElement>('[data-pkc-action="insert-attachment"]')!.click();
    await tick();
    document.querySelector<HTMLElement>('[data-pkc-field="entry-pick-row"][data-pkc-lid="a1"]')!.click();
    await tick();
    expect(ta.value).toBe('hello![photo.png](asset:k1) world');

    ta.setSelectionRange(0, 0);
    root.querySelector<HTMLElement>('[data-pkc-action="insert-attachment"]')!.click();
    await tick();
    document.querySelector<HTMLElement>('[data-pkc-field="entry-pick-row"][data-pkc-lid="a2"]')!.click();
    await tick();
    expect(ta.value.startsWith('[spec.pdf](asset:k2)hello')).toBe(true);
  });

  it('🔴 添付の中身を読めなかったときは、黙らず理由を言う', async () => {
    const { root, d, ta } = boot({});
    root.querySelector<HTMLElement>('[data-pkc-action="insert-attachment"]')!.click();
    await tick();
    document.querySelector<HTMLElement>('[data-pkc-field="entry-pick-row"][data-pkc-lid="a1"]')!.click();
    await tick();
    expect(ta.value).toBe('hello world');
    expect(d.getState().error).toContain('添付を読めませんでした');
  });
});
