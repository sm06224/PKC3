/** @vitest-environment happy-dom */
/**
 * 🔴 **本文の `[[題名]]` を押すと、その題名のノートが開く / 無ければ作る案内が出る**(#1174 段②)。
 *
 * 描画は `tests/features/markdown-title-link.test.ts`。ここは**繋がり**を見る:
 * 印(ある / 無い)の当て方・押したときの開く / 聞く・「作る」を押したときだけ作る。
 */
import { describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import type { Dispatchable } from '../../src/adapter/state/app-state';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { paintStatusCreate } from '../../src/adapter/ui/render/status-open';
import {
  applyTitleLinks,
  TITLE_LINK_MISSING_HINT,
} from '../../src/adapter/ui/render/title-links';

function meta(lid: string, title: string, over: Partial<EntryMeta> = {}): EntryMeta {
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
    bodyChars: 0,
    ...over,
  };
}

function anchor(title: string): HTMLElement {
  const el = document.createElement('span');
  el.className = 'pkc-title-link';
  el.setAttribute('data-pkc-action', 'open-title-note');
  el.setAttribute('data-pkc-title', title);
  el.textContent = title;
  return el;
}

describe('印を当てる(applyTitleLinks)', () => {
  it('🔴 ノートが無い題名にだけ「まだ無い」が付く / 作ると消える / ゴミ箱の中は無い扱い', () => {
    const host = document.createElement('div');
    const a = anchor('在る');
    const b = anchor('無い');
    const c = anchor('捨てた');
    host.append(a, b, c);
    const metas = [meta('1', '在る'), meta('2', '捨てた', { archived: true })];
    applyTitleLinks(host, metas);
    expect(a.hasAttribute('data-pkc-link-missing'), '在るのに印').toBe(false);
    expect(b.hasAttribute('data-pkc-link-missing'), '無いのに印が無い').toBe(true);
    expect(b.getAttribute('title')).toBe(TITLE_LINK_MISSING_HINT);
    expect(c.hasAttribute('data-pkc-link-missing'), 'ゴミ箱の中は無い扱い').toBe(true);
    // 作った(題名のノートが増えた)→ 描き直さずに印だけ消える。user の title は潰さない
    c.setAttribute('title', '自分の案内');
    applyTitleLinks(host, [...metas, meta('3', '無い'), meta('4', '捨てた')]);
    expect(b.hasAttribute('data-pkc-link-missing')).toBe(false);
    expect(b.hasAttribute('title'), '自分の字だけ消す').toBe(false);
    expect(c.hasAttribute('data-pkc-link-missing')).toBe(false);
    expect(c.getAttribute('title')).toBe('自分の案内');
  });
});

function setup(metas: EntryMeta[]) {
  const root = document.createElement('div');
  document.body.append(root);
  const regions = buildShell(root);
  const d = new Dispatcher();
  const sent: Dispatchable[] = [];
  const raw = d.dispatch.bind(d);
  d.dispatch = ((a: Dispatchable) => {
    sent.push(a);
    return raw(a);
  }) as typeof d.dispatch;
  let line = '';
  const repaint = (): void => void paintStatusCreate(regions.statusCreate, d.getState(), line);
  d.onState((st) => {
    if (st.notice !== null && st.notice !== line) line = st.notice;
    repaint();
  });
  bindActions(root, d, {
    showStatus: (t) => {
      line = t;
      repaint();
    },
  });
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas, relations: [] });
  sent.length = 0;
  const link = (title: string): HTMLElement => {
    const el = anchor(title);
    root.append(el);
    return el;
  };
  return { root, regions, d, sent, link };
}

const created = (sent: Dispatchable[]): Array<Extract<Dispatchable, { type: 'CREATE_ENTRY' }>> =>
  sent.filter((a): a is Extract<Dispatchable, { type: 'CREATE_ENTRY' }> => a.type === 'CREATE_ENTRY');

describe('[[題名]] を押す(open-title-note)', () => {
  it('🔴 在れば開く(作らない・聞かない)', () => {
    const { d, sent, link } = setup([meta('t', '設計の背景')]);
    link('設計の背景').click();
    expect(d.getState().selectedLid).toBe('t');
    expect(created(sent)).toEqual([]);
    expect(sent.some((a) => a.type === 'OP_NOTICE')).toBe(false);
  });

  it('🔴 無ければ作らず、「作る」を出す。それを押したときだけ、題名で作って開く', () => {
    const { d, sent, link, regions } = setup([meta('x', 'ほか')]);
    link('新しい題名').click();
    expect(created(sent), '押しただけで作った').toEqual([]);
    expect(d.getState().noticeCreate).toBe('新しい題名');
    expect(regions.statusCreate.hidden).toBe(false);
    expect(regions.statusCreate.textContent).toBe('新しい題名 のノートを作る');
    regions.statusCreate.click();
    const made = created(sent);
    expect(made).toHaveLength(1);
    expect(made[0]!.title).toBe('新しい題名');
    expect(made[0]!.archetype).toBe('text');
    expect(d.getState().selectedLid, '作ったノートが開いていない').toBe(made[0]!.lid);
  });

  it('🔴 編集中は黙らず理由を言い、作らない', () => {
    const { d, sent, link } = setup([meta('other', 'ほか')]);
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'other' });
    d.dispatch({ type: 'BODY_LOADED', lid: 'other', body: '本文' });
    d.dispatch({ type: 'START_EDIT' });
    sent.length = 0;
    link('新しい題名').click();
    expect(created(sent)).toEqual([]);
    expect(d.getState().error, '黙って終わった').toContain('新しい題名 のノート');
  });

  it('🔴 題名が空・長すぎ(属性が書き換わった)は作らず理由を言う', () => {
    const { d, sent, link } = setup([]);
    link('').click();
    expect(created(sent)).toEqual([]);
    expect(d.getState().error).toBe('ノートの題名が読めません');
    link('あ'.repeat(201)).click();
    expect(created(sent)).toEqual([]);
  });
});
