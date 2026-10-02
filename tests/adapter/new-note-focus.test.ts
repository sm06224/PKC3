/** @vitest-environment happy-dom */
/**
 * 🔴 **新しいノートを作った直後の焦点と、空の本文の案内**(#1221)。
 *
 * 画面で起きること(守る 5 つ):
 * ① 作った**直後だけ**、題名に焦点が当たり既定の題名が全選択される
 *    (「編集」で入る既存ノートには当てない ── 開いただけで題名が選ばれると事故になる)
 * ② 触るだけの端末(`isTouchOnly`)では**当てない**(ソフトキーボードが本文を隠す)
 * ③ 題名で `Enter` = 本文の最初の行へ(空なら書き足す行)。修飾キー・変換中は取らない
 * ④ 本文が空のとき薄い案内の字が出て(触る端末では「押して」)、書き始めると消える
 * ⑤ 2 列でも同じ(題名 / Enter / placeholder)
 *
 * ⚠ 案内を出すのは CSS の `:empty::before`(happy-dom は疑似要素を持たない)なので、
 *   unit が見るのは **①属性の字 ②「子が 1 つも無い」という `:empty` の前提**である。
 *   実際に画面へ出ることは smoke(`tests/smoke/live-editor.smoke.spec.ts`)が見る。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { initialState, reduce, type AppState } from '../../src/adapter/state/app-state';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { DetailRenderer } from '../../src/adapter/ui/render/detail';
import { MarkdownClient } from '../../src/adapter/platform/render/markdown-client';
import { TOUCH_ONLY_QUERY } from '../../src/adapter/ui/render/touch-device';

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
    bodyChars: null,
  };
}

const TITLE = '2026-10-01 ノート 3';

/** 「+ ノート」と同じ `CREATE_ENTRY` で作った直後(`freshLid` が立つ)。 */
function fresh(): AppState {
  const s = reduce(initialState, {
    type: 'SYS_BOOTED',
    cid: 'c1',
    metas: [meta('a')],
    relations: [],
  }).state;
  return reduce(s, { type: 'CREATE_ENTRY', archetype: 'text', lid: 'n1', title: TITLE }).state;
}

/** 既存ノートの「編集」ボタンで入った状態(`freshLid` は立たない)。 */
function editing(body: string): AppState {
  let s = reduce(initialState, {
    type: 'SYS_BOOTED',
    cid: 'c1',
    metas: [meta('a')],
    relations: [],
  }).state;
  s = reduce(s, { type: 'SELECT_ENTRY', lid: 'a' }).state;
  s = reduce(s, { type: 'BODY_LOADED', lid: 'a', body }).state;
  s = reduce(s, { type: 'START_EDIT' }).state;
  return s;
}

function setLive(on: boolean): void {
  localStorage.setItem('pkc3.editor-mode', on ? 'live' : 'split');
}
function touch(on: boolean): void {
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: on && q === TOUCH_ONLY_QUERY }));
}

afterEach(() => {
  localStorage.removeItem('pkc3.editor-mode');
  vi.unstubAllGlobals();
  document.body.textContent = '';
});

async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

function rig(state: AppState): HTMLElement {
  const root = document.createElement('div');
  // ⚠ document へ繋ぐ(焦点は繋がっていない要素には当たらない / follower が isConnected を見る)
  document.body.append(root);
  const detail = new DetailRenderer(buildShell(root).detail, null, new MarkdownClient(), () => {});
  detail.render(state);
  return root;
}

const q = <T extends HTMLElement>(root: HTMLElement, sel: string): T | null =>
  root.querySelector<T>(`[data-pkc-field="${sel}"]`);

function press(el: HTMLElement, init: KeyboardEventInit): KeyboardEvent {
  const ev = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  el.dispatchEvent(ev);
  return ev;
}

describe('① 作った直後だけ、題名へ焦点と全選択(1 面)', () => {
  it('作った直後: 題名に焦点が在り、既定の題名が全選択されている', async () => {
    touch(false);
    setLive(true);
    const root = rig(fresh());
    await settle();
    const title = q<HTMLInputElement>(root, 'editor-title')!;
    // 前提(空振り防止): 既定の題名が入っている
    expect(title.value).toBe(TITLE);
    expect(document.activeElement).toBe(title);
    expect(title.selectionStart).toBe(0);
    expect(title.selectionEnd).toBe(TITLE.length);
  });

  it('対照群: 「編集」で入った既存ノートでは題名に焦点を当てない', async () => {
    touch(false);
    setLive(true);
    const root = rig(editing('本文'));
    await settle();
    const title = q<HTMLInputElement>(root, 'editor-title')!;
    expect(title.value).toBe('t-a');
    expect(document.activeElement).not.toBe(title);
    expect(title.selectionEnd! - title.selectionStart!).toBe(0);
  });

  it('② 触るだけの端末では焦点を当てない(案内の字だけ出る)', async () => {
    touch(true);
    setLive(true);
    const root = rig(fresh());
    await settle();
    const title = q<HTMLInputElement>(root, 'editor-title')!;
    expect(document.activeElement).not.toBe(title);
    expect(title.selectionEnd! - title.selectionStart!).toBe(0);
    const pane = root.querySelector('[data-pkc-region="editor-live"]')!;
    expect(pane.getAttribute('data-pkc-empty-hint')).toBe('ここを押して書き始めます');
  });
});

describe('③ 題名で Enter = 本文へ(1 面)', () => {
  it('空の本文: 書き足す行が開いて、そこに焦点が移る', async () => {
    touch(false);
    setLive(true);
    const root = rig(fresh());
    await settle();
    const title = q<HTMLInputElement>(root, 'editor-title')!;
    expect(q(root, 'row-source')).toBeNull(); // 前提: まだ開いていない
    const ev = press(title, { key: 'Enter' });
    expect(ev.defaultPrevented).toBe(true);
    const row = q<HTMLTextAreaElement>(root, 'row-source');
    expect(row).not.toBeNull();
    expect(document.activeElement).toBe(row);
  });

  it('描き終える前の Enter も取りこぼさない(予約して、描いた後に開く)', async () => {
    touch(false);
    setLive(true);
    const root = rig(fresh());
    // ⚠ settle しない ── 最初の描き直しはまだ着弾していない
    const title = q<HTMLInputElement>(root, 'editor-title')!;
    press(title, { key: 'Enter' });
    await settle();
    const row = q<HTMLTextAreaElement>(root, 'row-source');
    expect(row).not.toBeNull();
    expect(document.activeElement).toBe(row);
  });

  it('本文が在って描き終える前の Enter も、最初の行を開く(空と読み違えない)', async () => {
    touch(false);
    setLive(true);
    const root = rig(editing(['# 題', '', '最初の段落。'].join('\n')));
    // ⚠ settle しない ── 塊の表はまだ空。ここで「空の本文」と読むと書き足す行が開き、
    //    着弾した描き直しが「外から本文が変わった」と閉じてしまう
    press(q(root, 'editor-title')!, { key: 'Enter' });
    await settle();
    const row = q<HTMLTextAreaElement>(root, 'row-source');
    expect(row).not.toBeNull();
    expect(row!.value).toBe('# 題');
    expect(document.activeElement).toBe(row);
  });

  it('本文が在る: 最初の行の先頭に caret を置いて開く', async () => {
    touch(false);
    setLive(true);
    const root = rig(editing(['# 題', '', '最初の段落。'].join('\n')));
    await settle();
    press(q(root, 'editor-title')!, { key: 'Enter' });
    const row = q<HTMLTextAreaElement>(root, 'row-source')!;
    expect(row.value).toBe('# 題');
    expect(document.activeElement).toBe(row);
    expect(row.selectionStart).toBe(0);
    expect(row.selectionEnd).toBe(0);
  });

  it('保存の近道・変換中・Shift では取らない(本文へ移らない)', async () => {
    touch(false);
    setLive(true);
    const root = rig(fresh());
    await settle();
    const title = q<HTMLInputElement>(root, 'editor-title')!;
    for (const init of [
      { key: 'Enter', ctrlKey: true },
      { key: 'Enter', metaKey: true },
      { key: 'Enter', shiftKey: true },
      { key: 'Enter', isComposing: true },
      { key: 'Enter', keyCode: 229 },
      { key: 'a' },
    ] as KeyboardEventInit[]) {
      const ev = press(title, init);
      expect(ev.defaultPrevented).toBe(false);
    }
    expect(q(root, 'row-source')).toBeNull();
    expect(document.activeElement).toBe(title);
  });
});

describe('④ 本文が空のときの案内(1 面)', () => {
  it('空: 案内の字を持ち、子が 1 つも無い(= `:empty` が当たる)/ 書き始めると子が入って消える', async () => {
    touch(false);
    setLive(true);
    const root = rig(fresh());
    await settle();
    const pane = root.querySelector<HTMLElement>('[data-pkc-region="editor-live"]')!;
    expect(pane.getAttribute('data-pkc-empty-hint')).toBe('ここをクリックして書き始めます');
    expect(pane.childNodes.length).toBe(0);
    // 余白(= 空の紙)を押すと行の欄が開く ── 案内の「押すと書き始められる」の実体
    pane.click();
    expect(q(root, 'row-source')).not.toBeNull();
    expect(pane.childNodes.length).toBeGreaterThan(0); // `:empty` が外れる = 案内が消える
  });

  it('本文が在る: 子が在る(案内は出ない)', async () => {
    touch(false);
    setLive(true);
    const root = rig(editing('本文あり'));
    await settle();
    const pane = root.querySelector<HTMLElement>('[data-pkc-region="editor-live"]')!;
    expect(pane.childNodes.length).toBeGreaterThan(0);
  });
});

describe('⑤ 2 列でも同じ', () => {
  it('作った直後: 題名に焦点 + 全選択。Enter で本文の欄へ。placeholder に案内', async () => {
    touch(false);
    setLive(false);
    const root = rig(fresh());
    await settle();
    const title = q<HTMLInputElement>(root, 'editor-title')!;
    const ta = q<HTMLTextAreaElement>(root, 'editor-body')!;
    expect(ta.placeholder).toBe('ここをクリックして書き始めます');
    expect(document.activeElement).toBe(title);
    expect(title.selectionEnd! - title.selectionStart!).toBe(TITLE.length);
    const ev = press(title, { key: 'Enter' });
    expect(ev.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(ta);
  });

  it('対照群: 既存ノートの「編集」では題名へ当てず、これまでどおり本文の欄へ', async () => {
    touch(false);
    setLive(false);
    const root = rig(editing('本文'));
    await settle();
    expect(document.activeElement).toBe(q(root, 'editor-body'));
  });

  it('触るだけの端末: placeholder は「押して」。題名へは当てない', async () => {
    touch(true);
    setLive(false);
    const root = rig(fresh());
    await settle();
    expect(q<HTMLTextAreaElement>(root, 'editor-body')!.placeholder).toBe(
      'ここを押して書き始めます',
    );
    expect(document.activeElement).not.toBe(q(root, 'editor-title'));
  });
});
