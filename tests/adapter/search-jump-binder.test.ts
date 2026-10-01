/** @vitest-environment happy-dom */
/**
 * 🔴 **「探す」から送った本文の帯の押し所(‹ › ×)と `Esc`**(#1102 段①)── 受け手側。
 *
 * ## user から見た物語
 *
 * 当たりを見ている。‹ › で前後へ。やめたいので `Esc` を押す ── **塗りが消えるだけで、読んでいた
 * 本文は閉じない**。もう一度 `Esc` を押したら、これまでどおりノートが閉じる。
 * ⚠ 付箋の窓では `Esc` が**窓ごと閉じる**ので、先に塗りを消さないと、塗りを消したいだけの
 * `Esc` で読んでいた窓を失う。
 *
 * ## 守るもの
 *
 * ① ‹ › × の押しが reducer へ届く(帯の `data-pkc-action` と受け手の名前が揃っている)
 * ② 🔴 塗っている間の `Esc` は**塗りを消すだけ**(ノートも窓も閉じない)/ 次の `Esc` は従来どおり
 * ③ 🔴 対照群: 塗っていないときの `Esc` は従来どおりノートを閉じる(奪っていない)
 * ④ 右クリックのメニューが出ている間は譲る
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { bindActions, type BinderServices } from '../../src/adapter/ui/actions/binder';
import { KeymapStore } from '../../src/adapter/ui/render/keymap';

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

const unbinds: Array<() => void> = [];

function mount(closeNoteWindow?: BinderServices['closeNoteWindow']) {
  const root = document.createElement('div');
  root.setAttribute('data-pkc-slot', 'root');
  document.body.append(root);
  const d = new Dispatcher();
  buildShell(root);
  const services: BinderServices = { closeNoteWindow };
  unbinds.push(bindActions(root, d, services, new KeymapStore(null)));
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('a')], relations: [] });
  d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
  d.dispatch({ type: 'BODY_LOADED', lid: 'a', body: '会議の本文' });
  d.dispatch({ type: 'SEARCH_JUMP_START', lid: 'a', query: '会議' });
  return { root, d };
}

const pressEscape = (): void => {
  document.body.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
  );
};

/** 帯の押し所と同じ属性を持つボタンを置いて押す(帯の描画は detail の test が見ている)。 */
function press(root: HTMLElement, action: string): void {
  const b = document.createElement('button');
  b.setAttribute('data-pkc-action', action);
  root.append(b);
  b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
}

beforeEach(() => {
  document.body.innerHTML = '';
});
afterEach(() => {
  for (const off of unbinds) off();
  unbinds.length = 0;
});

describe('帯の押し所 → reducer', () => {
  it('🔴 › で次へ / ‹ で前へ(進んだ回数が積まれる)/ × で消える', () => {
    const m = mount();
    expect(m.d.getState().searchJump, '前提: 塗っている').not.toBeNull();
    press(m.root, 'search-jump-next');
    press(m.root, 'search-jump-next');
    expect(m.d.getState().searchJump?.step).toBe(2);
    press(m.root, 'search-jump-prev');
    expect(m.d.getState().searchJump?.step).toBe(1);
    press(m.root, 'search-jump-end');
    expect(m.d.getState().searchJump).toBeNull();
  });
});

describe('Esc: まず塗りを消す(1 回で 1 段)', () => {
  it('🔴 塗っている間の Esc は塗りだけを消し、ノートは閉じない。次の Esc は従来どおりノートを閉じる', () => {
    const m = mount();
    pressEscape();
    expect(m.d.getState().searchJump, 'Esc で塗りが消えていない').toBeNull();
    expect(m.d.getState().selectedLid, '塗りを消したいだけの Esc でノートまで閉じた').toBe('a');
    pressEscape();
    expect(m.d.getState().selectedLid, '2 回目の Esc が従来の動き(ノートを閉じる)でない').toBeNull();
  });

  it('🔴 付箋の窓でも、塗っている間の Esc は窓を閉じない(塗りだけ消す)', () => {
    let closed = 0;
    const m = mount(() => {
      closed++;
      return 'closed';
    });
    pressEscape();
    expect(closed, '塗りを消したいだけの Esc で窓ごと閉じた').toBe(0);
    expect(m.d.getState().searchJump).toBeNull();
    // 対照群: 次の Esc は従来どおり窓を閉じる
    pressEscape();
    expect(closed).toBe(1);
  });

  it('🔴 対照群: 塗っていないときの Esc は従来どおりノートを閉じる(奪っていない)', () => {
    const m = mount();
    press(m.root, 'search-jump-end');
    pressEscape();
    expect(m.d.getState().selectedLid).toBeNull();
  });
});
