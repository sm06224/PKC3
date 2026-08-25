/** @vitest-environment happy-dom */
/**
 * #395 段③: **読んでいる本文の「この行」から編集に入る**。
 *
 * > user の物語: 長い議事録を読んでいて、この 1 行だけ直したい。
 * > いまは「編集」を押してから、もう一度その行を探して押す(2 手)。
 *
 * PKC2 に在った動線(`action-binder.ts:1329-1412`、2026-07-03 の user request)。
 *
 * ⚠ **素のクリックの意味は変えない** ── PKC3 は browse-first(2026-08-18 の裁定)。
 *   だから見るのは「修飾キーのときだけ効くか」と「**押せる物を奪っていないか**」。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { initialState, type AppState } from '../../src/adapter/state/app-state';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { bindActions } from '../../src/adapter/ui/actions/binder';

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

beforeEach(() => {
  document.body.textContent = '';
});

/**
 * 読む面を模す。⚠ **刻印は本物と同じ属性**(`data-pkc-source-line`)──
 *   別の名前で組むと、この test だけ通って実物では 1 度も効かない。
 */
function rig(html: string) {
  const root = document.createElement('div');
  document.body.append(root);
  const host = document.createElement('div');
  host.setAttribute('data-pkc-field', 'detail-body');
  host.innerHTML = html;
  root.append(host);
  const d = new Dispatcher(initialState);
  bindActions(root, d);
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('n1')], relations: [] });
  d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
  d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body: 'a\n\nb\n\nc\n' });
  const click = (sel: string, init: MouseEventInit = {}): void => {
    root
      .querySelector(sel)!
      .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...init }));
  };
  return { root, d, click, state: (): AppState => d.getState() };
}

const BODY = [
  '<p data-pkc-source-line="0">a</p>',
  '<p data-pkc-source-line="2" id="mid">b</p>',
  '<p data-pkc-source-line="4"><a href="https://example.com" id="lnk">c</a></p>',
].join('');

describe('#395 段③ 修飾クリックで、その行から編集に入る', () => {
  it('🔴 Alt クリックで編集に入り、押した行を持っていく', () => {
    const r = rig(BODY);
    r.click('#mid', { altKey: true });
    expect(r.state().phase, '編集に入っていない').toBe('editing');
    expect(r.state().editOpenAt, '押した行を持っていっていない').toBe(2);
  });

  it('🔴 素のクリックでは入らない(browse-first の裁定を変えない)', () => {
    const r = rig(BODY);
    r.click('#mid');
    expect(r.state().phase).toBe('ready');
  });

  it('🔴 Ctrl+Alt(AltGr)では入らない ── 記号が打てない配列の人を壊さない', () => {
    const r = rig(BODY);
    r.click('#mid', { altKey: true, ctrlKey: true });
    expect(r.state().phase).toBe('ready');
  });

  it('⚠ Alt+Shift でも入らない(選択の作法を奪わない)', () => {
    const r = rig(BODY);
    r.click('#mid', { altKey: true, shiftKey: true });
    expect(r.state().phase).toBe('ready');
  });

  it('🔴 リンクの上では奪わない(その場に自分の意味がある)', () => {
    const r = rig(BODY);
    r.click('#lnk', { altKey: true });
    expect(r.state().phase, 'リンクのクリックを奪った').toBe('ready');
  });

  it('🔴 刻印が無い所では何もしない ── 当てずっぽうで別の行を開かない', () => {
    const r = rig('<hr id="rule">');
    r.click('#rule', { altKey: true });
    expect(r.state().phase).toBe('ready');
  });

  it('⚠ 本文の外(一覧など)では効かない', () => {
    const r = rig(BODY);
    const outside = document.createElement('p');
    outside.setAttribute('data-pkc-source-line', '0');
    outside.id = 'out';
    r.root.append(outside);
    r.click('#out', { altKey: true });
    expect(r.state().phase).toBe('ready');
  });

  it('🔴 普通に「編集」を押したときは、前に押した行が開かない', () => {
    const r = rig(BODY);
    r.click('#mid', { altKey: true });
    expect(r.state().editOpenAt).toBe(2);
    r.d.dispatch({ type: 'CANCEL_EDIT' });
    r.d.dispatch({ type: 'START_EDIT' });
    expect(r.state().editOpenAt, '前に押した行が残っている').toBeNull();
  });
});
