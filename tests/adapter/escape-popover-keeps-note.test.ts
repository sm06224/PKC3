/** @vitest-environment happy-dom */
/**
 * 🔴 **小さな重なり(目次・リンクのプレビュー・置き物の移動)を Escape で閉じても、
 * 開いているノートは閉じない**(#1087 K1)。
 *
 * ⚠ 直す前は、これらが `document` の keydown で Escape を受けるだけで止めなかったので、
 * 続けて近道の「ノートを閉じる」が走り、**重なりとノートが同時に消えた**。
 * 重なりが出ていない間の Escape は、従来どおり通る(ノートを閉じる)。
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { KeymapStore } from '../../src/adapter/ui/render/keymap';
import { installQuickToc } from '../../src/adapter/ui/render/quick-toc';
import { installPlaceDrag } from '../../src/adapter/ui/render/place-drag';

function meta(lid: string): EntryMeta {
  return { lid, title: 't', archetype: 'text', createdAt: null, updatedAt: null, entryOrder: 1, status: null, date: null, archived: false, bodyChars: 0 };
}

const offs: Array<() => void> = [];

function rig() {
  document.body.innerHTML = '';
  const root = document.createElement('div');
  document.body.append(root);
  buildShell(root);
  const d = new Dispatcher();
  offs.push(bindActions(root, d, {}, new KeymapStore(null)));
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c', metas: [meta('n1')], relations: [] });
  d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' } as never);
  return { root, d };
}

function esc(el: HTMLElement): void {
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
}

afterEach(() => {
  for (const off of offs) off();
  offs.length = 0;
  document.body.innerHTML = '';
});

describe('🔴 Escape は重なりだけを閉じる(#1087 K1)', () => {
  it('目次: 開いているときの Escape は目次だけ閉じ、ノートは開いたまま。閉じているときの Escape はノートを閉じる', () => {
    const { root, d } = rig();
    const host = document.createElement('div');
    root.append(host);
    const body = document.createElement('div');
    host.append(body);
    const h = installQuickToc(host, body);
    h.button.click();
    expect(h.popover.hidden, '前提: 目次が開いていない').toBe(false);
    esc(h.button);
    expect(h.popover.hidden, 'Escape で目次が閉じていない').toBe(true);
    expect(d.getState().selectedLid, '目次と一緒にノートまで閉じた').toBe('n1');
    // 対照群: 重なりが無ければ従来どおりノートが閉じる
    esc(h.button);
    expect(d.getState().selectedLid, '重なりが無いときの Escape が効かなくなった').toBeNull();
  });

  it('リンクのプレビュー: 出ているときの Escape はカードだけ閉じ、ノートは開いたまま', () => {
    const { root, d } = rig();
    const card = document.createElement('div');
    card.setAttribute('data-pkc-region', 'link-preview');
    root.append(card);
    esc(document.body);
    expect(root.querySelector('[data-pkc-region="link-preview"]'), 'カードが閉じていない').toBeNull();
    expect(d.getState().selectedLid, 'カードと一緒にノートまで閉じた').toBe('n1');
    esc(document.body);
    expect(d.getState().selectedLid, '重なりが無いときの Escape が効かなくなった').toBeNull();
  });

  it('置き物の矢印移動: 動かしている最中の Escape は取り消すだけで、ノートは開いたまま', () => {
    const { root, d } = rig();
    offs.push(installPlaceDrag(root, d));
    const blk = document.createElement('div');
    blk.className = 'pkc-format-block pkc-place';
    blk.setAttribute('data-pkc-x', '10');
    blk.setAttribute('data-pkc-y', '10');
    const grip = document.createElement('button');
    grip.setAttribute('data-pkc-field', 'place-grip');
    blk.append(grip);
    root.append(blk);
    grip.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', code: 'ArrowRight', bubbles: true, cancelable: true }));
    expect(blk.style.left, '前提: 動いていない').not.toBe('');
    esc(grip);
    expect(blk.style.left, '取り消しで元の位置へ戻っていない').toBe('10px');
    expect(d.getState().selectedLid, '取り消しと一緒にノートまで閉じた').toBe('n1');
    // 対照群: 動かしていないときの Escape は通る
    esc(grip);
    expect(d.getState().selectedLid, '動かしていないときの Escape が効かなくなった').toBeNull();
  });
});
