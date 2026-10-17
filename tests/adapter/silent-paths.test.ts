/** @vitest-environment happy-dom */
/**
 * 黙っていた経路に、知らせを足した(押しても何も起きなかった 5 件)。
 *
 * 🔑 守る向きは 2 つ:**黙っていた場面では言う** / **動く場面では言わない**(対照群)。
 *   動く場面で毎回言う実装は、字を `toContain` するだけの検査を通ってしまう。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { BrowseRouter } from '../../src/adapter/ui/render/browse';
import { DetailRenderer } from '../../src/adapter/ui/render/detail';
import {
  bindActions,
  NO_FORMAT_TARGET_TEXT,
  type BinderServices,
} from '../../src/adapter/ui/actions/binder';
import { resetAppDialogForTest } from '../../src/adapter/ui/render/app-dialog';
import { archetypeLabel } from '../../src/features/flavor/archetype-label';
import { renderPreviewCard } from '../../src/adapter/ui/render/link-preview';
import { importFiles } from '../../src/adapter/ui/actions/import-file';
import {
  dispatchRepeatMove,
  repeatMoveAction,
  REPEAT_MOVE_LOST_TEXT,
  type GrabbedTask,
} from '../../src/adapter/ui/render/schedule-drag';
import { MarkdownClient } from '../../src/adapter/platform/render/markdown-client';
import { RowSwap } from '../../src/adapter/ui/render/row-swap';
import { renderMarkdownWithRanges } from '../../src/features/markdown/source-ranges';
import { phaseBlockReason, type AppState } from '../../src/adapter/state/app-state';

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
const tick = (ms = 10): Promise<void> => new Promise((r) => setTimeout(r, ms));

function setup(lids: string[], services: BinderServices = {}) {
  const root = document.createElement('div');
  document.body.append(root);
  const d = new Dispatcher();
  const regions = buildShell(root);
  const detail = new DetailRenderer(regions.detail, null, undefined, (body) =>
    d.dispatch({ type: 'UPDATE_OPEN_BODY', body }),
  );
  d.onState((s) => detail.render(s));
  // 戻る・進むの押せる / 押せないは一覧の描画器が決める(本物の配線)
  const browse = new BrowseRouter(regions.sidebar, regions.browseHost, 'filer');
  d.onState((s) => browse.render(s, 'filer'));
  bindActions(root, d, services);
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: lids.map(meta), relations: [] });
  const q = <T extends HTMLElement>(s: string) => root.querySelector<T>(s);
  return { root, d, q };
}

beforeEach(() => {
  resetAppDialogForTest();
  document.body.innerHTML = '';
});
afterEach(() => {
  resetAppDialogForTest();
  localStorage.clear();
});

describe('A: 本文の行が開いていないとき、書式の帯・caret の道具は理由を言う', () => {
  const BUTTONS = [
    '[data-pkc-action="insert-date"]',
    '[data-pkc-action="insert-entry-link"]',
    '[data-pkc-action="insert-snippet"]',
    '[data-pkc-action="insert-diagram"]',
    '[data-pkc-action="insert-icon"]',
    '[data-pkc-format="bold"]',
  ];

  async function editing(mode: 'live' | 'split') {
    localStorage.setItem('pkc3.editor-mode', mode);
    const said: Array<[string, unknown]> = [];
    const s = setup(['a'], { showStatus: (t, o) => void said.push([t, o]) });
    s.d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    s.d.dispatch({ type: 'BODY_LOADED', lid: 'a', body: 'x-a' });
    await tick();
    s.q('[data-pkc-action="start-edit"]')!.click();
    return { ...s, said };
  }

  it('1 画面の編集で行を開いていない: 6 つの道具が全部、同じ知らせを注意の種類で出す', async () => {
    const { q, said } = await editing('live');
    expect(q('[data-pkc-field="row-source"]'), '前提: 行が開いていない').toBeNull();
    expect(q('[data-pkc-field="editor-body"]'), '前提: 2 列の欄でもない').toBeNull();
    for (const sel of BUTTONS) {
      const btn = q(sel);
      expect(btn, `前提: ${sel} が画面に在る`).not.toBeNull();
      said.length = 0;
      btn!.click();
      expect(said, sel).toEqual([[NO_FORMAT_TARGET_TEXT, { kind: 'caution' }]]);
    }
  });

  it('対照群: 書き込む欄が在る(2 列)なら、この知らせは出ない', async () => {
    const { q, said } = await editing('split');
    expect(q('[data-pkc-field="editor-body"]'), '前提: 欄が在る').not.toBeNull();
    q('[data-pkc-format="bold"]')!.click();
    q('[data-pkc-action="insert-diagram"]')!.click();
    expect(said.map(([t]) => t)).not.toContain(NO_FORMAT_TARGET_TEXT);
  });
});

describe('B: 編集中の「戻る」「進む」は、断った理由を言う', () => {
  function history() {
    const s = setup(['a', 'b', 'c']);
    for (const lid of ['a', 'b', 'c']) {
      s.d.dispatch({ type: 'SELECT_ENTRY', lid });
      s.d.dispatch({ type: 'BODY_LOADED', lid, body: 'x-' + lid });
    }
    return s;
  }

  it('編集中に戻る / 進むを押すと、前置きは phaseBlockReason と同じ 1 本で言う', () => {
    const { d, q } = history();
    d.dispatch({ type: 'NAV_HISTORY', dir: 'back' }); // いま b: 戻る先 a も進む先 c も在る
    d.dispatch({ type: 'BODY_LOADED', lid: 'b', body: 'x-b' });
    d.dispatch({ type: 'START_EDIT' });
    expect(d.getState().phase, '前提: 編集中').toBe('editing');
    expect(d.getState().selectionHistory.past.length, '前提: 戻れる').toBeGreaterThan(1);
    const before = d.getState().selectedLid;
    q('[data-pkc-action="nav-back"]')!.click();
    expect(d.getState().error).toBe(`${phaseBlockReason('editing')}戻ってください`);
    expect(d.getState().selectedLid, '動いていない').toBe(before);
    q('[data-pkc-action="nav-forward"]')!.click();
    expect(d.getState().error).toBe(`${phaseBlockReason('editing')}進んでください`);
  });

  it('対照群: 編集中でなければ動き、理由は出ない', () => {
    const { d, q } = history();
    q('[data-pkc-action="nav-back"]')!.click();
    expect(d.getState().selectedLid).toBe('b');
    expect(d.getState().error ?? null).toBeNull();
  });
});

describe('C: リンクの上に出るカードは、種類を画面の名前で言う', () => {
  it('フォルダ・添付・チェックリストなど、共有の名前表と同じ字で出る', () => {
    for (const a of ['folder', 'attachment', 'todo', 'textlog', 'text']) {
      const card = renderPreviewCard(document, { kind: 'entry', title: 'T', archetype: a });
      expect(card.querySelector('.pkc-link-preview-archetype')?.textContent).toBe(archetypeLabel(a));
    }
    const folder = renderPreviewCard(document, { kind: 'entry', title: 'T', archetype: 'folder' });
    expect(folder.querySelector('.pkc-link-preview-archetype')?.textContent).toBe('フォルダ');
  });
  it('対照群: 種類が無いときは今までどおり「ノート」', () => {
    const card = renderPreviewCard(document, { kind: 'entry', title: 'T' });
    expect(card.querySelector('.pkc-link-preview-archetype')?.textContent).toBe('ノート');
  });
});

describe('D: 2 つ選んだときの断りは、バックアップにも PKC2 の書き出しにも当てはまる', () => {
  it('バックアップを 2 つ選ぶと、バックアップのことも言う', async () => {
    const d = new Dispatcher();
    const files = [new File(['x'], 'a.pkc3-full.zip'), new File(['y'], 'b.pkc3-full.zip')];
    await importFiles(d, {} as never, files);
    const err = d.getState().error ?? '';
    expect(err).toContain('バックアップ');
    expect(err).toContain('PKC2 の書き出し');
    expect(err).toContain('1 つずつ');
  });
});

describe('E: 繰り返しの予定を「全部動かす」で手が作れないとき、黙らない', () => {
  const grabbed = { lid: 'e1', line: '0', repeat: '毎週', from: '2026-08-23' } as unknown as GrabbedTask;
  const emptyState = { taskScan: null } as unknown as AppState;
  const recorder = () => {
    const sent: unknown[] = [];
    return {
      sent,
      dispatcher: { dispatch: (a: unknown) => void sent.push(a) } as unknown as Dispatcher,
    };
  };

  it('「全部」を選んだのに規則の行が読めない → 理由を出す', () => {
    const { sent, dispatcher } = recorder();
    const action = repeatMoveAction(emptyState, grabbed, 0, '2026-08-23', '2026-08-27', 4, 'all');
    expect(action, '前提: 手が作れない').toBeNull();
    dispatchRepeatMove(dispatcher, action, 'all');
    expect(sent).toEqual([{ type: 'OP_FAILED', error: REPEAT_MOVE_LOST_TEXT }]);
  });

  it('対照群: 「やめた」(pick が null)は黙る', () => {
    const { sent, dispatcher } = recorder();
    dispatchRepeatMove(dispatcher, repeatMoveAction(emptyState, grabbed, 0, 'a', 'b', 1, null), null);
    expect(sent).toEqual([]);
  });

  it('対照群: 「この回だけ」は手をそのまま撃ち、理由は出ない', () => {
    const { sent, dispatcher } = recorder();
    // 規則の行の原文(`openLine`)を運べる = 札が走査に居る(#1087)
    const scanned = {
      taskScan: { cards: [{ lid: 'e1', line: 0, rawLine: '- [ ] 掃除 @2026-08-23 毎週' }] },
    } as unknown as AppState;
    const action = repeatMoveAction(scanned, grabbed, 0, '2026-08-23', '2026-08-27', 4, 'one');
    expect(action, '前提: 手が作れている').toMatchObject({ type: 'MOVE_REPEAT_OCCURRENCE' });
    dispatchRepeatMove(dispatcher, action, 'one');
    expect(sent).toEqual([action]);
  });

  it('🔴 「この回だけ」でも、札が走査に居なくて規則の行を運べないなら理由を出す(#1087)', () => {
    const { sent, dispatcher } = recorder();
    const action = repeatMoveAction(emptyState, grabbed, 0, '2026-08-23', '2026-08-27', 4, 'one');
    expect(action, '前提: 運べないので手が作れない').toBeNull();
    dispatchRepeatMove(dispatcher, action, 'one');
    expect(sent).toEqual([{ type: 'OP_FAILED', error: REPEAT_MOVE_LOST_TEXT }]);
  });
});

describe('F: 行の中の Ctrl+S / Ctrl+Enter は、行を確定したうえでノートを保存する(#1632)', () => {
  const key = (init: KeyboardEventInit) =>
    new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  function rig() {
    const host = document.createElement('div');
    document.body.append(host);
    const commits: string[] = [];
    const order: string[] = [];
    const swap = new RowSwap(host, {
      commit: (_s, _e, text) => {
        commits.push(text);
        order.push('commit');
      },
      saveNote: () => void order.push('save'),
      onInserted: () => {},
    });
    const { html, ranges } = renderMarkdownWithRanges('最初の段落。');
    swap.update('最初の段落。', html, ranges);
    const p = [...host.querySelectorAll('p')].find((e) => e.textContent === '最初の段落。')!;
    p.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
    const ta = host.querySelector<HTMLTextAreaElement>('[data-pkc-field="row-source"]')!;
    return { ta, commits, order };
  }

  it('Ctrl+S / Cmd+S / Ctrl+Enter: 確定してから、保存を呼ぶ(この順)', () => {
    for (const init of [
      { key: 's', ctrlKey: true },
      { key: 's', metaKey: true },
      { key: 'Enter', ctrlKey: true },
    ]) {
      const { ta, commits, order } = rig();
      ta.value = 'かえた';
      ta.dispatchEvent(key(init));
      expect(commits, JSON.stringify(init)).toEqual(['かえた']);
      expect(order, JSON.stringify(init)).toEqual(['commit', 'save']);
    }
  });

  it('対照群: Tab / Shift+Tab で確定しても保存はしない', () => {
    for (const init of [{ key: 'Tab' }, { key: 'Tab', shiftKey: true }]) {
      const { ta, commits, order } = rig();
      ta.value = 'かえた';
      ta.dispatchEvent(key(init));
      expect(commits).toEqual(['かえた']);
      expect(order).toEqual(['commit']);
    }
  });

  it('🔴 本物の配線: 1 画面の編集で行の中の Ctrl+S を押すと、編集が終わる', async () => {
    localStorage.setItem('pkc3.editor-mode', 'live');
    const root = document.createElement('div');
    document.body.append(root);
    const d = new Dispatcher();
    const regions = buildShell(root);
    const detail = new DetailRenderer(
      regions.detail,
      null,
      new MarkdownClient(),
      (body) => d.dispatch({ type: 'UPDATE_OPEN_BODY', body }),
    );
    d.onState((s) => detail.render(s));
    bindActions(root, d, {});
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('a')], relations: [] });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    d.dispatch({ type: 'BODY_LOADED', lid: 'a', body: '最初の段落。' });
    d.dispatch({ type: 'START_EDIT' });
    expect(d.getState().phase, '前提: 編集中').toBe('editing');
    const find = (): HTMLElement | undefined =>
      [...root.querySelectorAll<HTMLElement>('[data-pkc-region="editor-live"] p')].find(
        (e) => e.textContent === '最初の段落。',
      );
    for (let i = 0; i < 300 && find() === undefined; i++) await tick(10);
    const p = find();
    expect(p, '前提: 編集の面に段落が描かれている').toBeDefined();
    p!.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
    const ta = root.querySelector<HTMLTextAreaElement>('[data-pkc-field="row-source"]');
    expect(ta, '前提: 行が開いている').not.toBeNull();
    ta!.focus();
    ta!.value = 'かえた段落。';
    ta!.dispatchEvent(key({ key: 's', ctrlKey: true }));
    await tick();
    expect(d.getState().phase, '保存して編集が終わっている').not.toBe('editing');
  });
});

describe('スマホの「情報」「← 一覧へ戻る」は、編集中に行き先で言い分ける(#1087 の見直し 2026-10-13)', () => {
  it('🔴 「情報」は「開いてください」/ 一覧は「戻ってください」', () => {
    const { root, d } = setup(['a']);
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    d.dispatch({ type: 'BODY_LOADED', lid: 'a', body: 'x' });
    d.dispatch({ type: 'START_EDIT' });
    expect(d.getState().phase, '前提: 編集中').toBe('editing');
    const press = (page: string): void => {
      const b = document.createElement('button');
      b.setAttribute('data-pkc-action', 'phone-page');
      b.setAttribute('data-pkc-page', page);
      root.append(b);
      b.click();
    };
    press('info');
    expect(d.getState().error).toBe(`${phaseBlockReason('editing')}開いてください`);
    press('list');
    expect(d.getState().error).toBe(`${phaseBlockReason('editing')}戻ってください`);
  });
});
