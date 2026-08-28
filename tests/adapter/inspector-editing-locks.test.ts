/** @vitest-environment happy-dom */
/**
 * 🔴 **編集中、右ペインの口が「押せるのに無言で捨てる」形にならないこと**(#513)。
 *
 * 直す前:操作の帯(`this.buttons`)だけが disabled になり、**関係を足す帯・
 * 日付・関係の ×** は押せる見た目のまま ── reducer が `phase !== 'ready'` で
 * 黙って捨て、add-relation は**欄まで空にして成功と同じ見た目**になっていた。
 *
 * ## 守る主張
 *
 * 1. 編集中は口が **disabled** になり、**理由が title に出る**(帯と同じ答え)
 * 2. 🔴 それでも押された回(stale な DOM / 別経路)は**声に出して断り、打った字を残す**
 * 3. 編集を終えれば口は戻る(片道にしない)
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { InspectorRenderer } from '../../src/adapter/ui/render/inspector';
import { bindActions } from '../../src/adapter/ui/actions/binder';

function meta(lid: string, title: string, date: string | null = null): EntryMeta {
  return {
    lid,
    title,
    archetype: 'text',
    createdAt: null,
    updatedAt: null,
    entryOrder: 1,
    status: null,
    date,
    archived: false,
    bodyChars: null,
  };
}

beforeEach(() => {
  document.body.textContent = '';
});

function mounted(opts: { date?: string | null; withRelation?: boolean } = {}) {
  const root = document.createElement('div');
  root.setAttribute('data-pkc-slot', 'root');
  document.body.append(root);
  const d = new Dispatcher();
  const regions = buildShell(root);
  const inspector = new InspectorRenderer(regions.inspector);
  d.onState((s) => inspector.render(s));
  bindActions(root, d);
  d.dispatch({
    type: 'SYS_BOOTED',
    cid: 'c1',
    metas: [meta('n1', 'あ', opts.date ?? null), meta('n2', 'い')],
    relations: opts.withRelation
      ? [{ id: 'r1', fromLid: 'n1', toLid: 'n2', kind: 'semantic', createdAt: null, updatedAt: null }]
      : [],
  });
  d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
  d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body: '本文\n' });
  const q = <T extends HTMLElement>(sel: string): T => root.querySelector<T>(sel)!;
  return { root, d, q };
}

const REASON = '編集中は使えません';

describe('編集中の右ペインの口(#513)', () => {
  it('⚠ 対照群 ── ready では口が全部生きている', () => {
    const s = mounted({ date: '2026-08-28', withRelation: true });
    expect(s.q<HTMLButtonElement>('[data-pkc-action="add-relation"]').disabled).toBe(false);
    expect(s.q<HTMLInputElement>('[data-pkc-field="relation-target"]').disabled).toBe(false);
    expect(s.q<HTMLSelectElement>('[data-pkc-field="relation-kind"]').disabled).toBe(false);
    expect(s.q<HTMLButtonElement>('[data-pkc-action="set-entry-date"]').disabled).toBe(false);
    expect(s.q<HTMLButtonElement>('[data-pkc-action="clear-entry-date"]').disabled).toBe(false);
    expect(s.q<HTMLButtonElement>('[data-pkc-action="remove-relation"]').disabled).toBe(false);
  });

  it('🔴 編集中は口が押せなくなり、理由が title に出る', () => {
    const s = mounted({ date: '2026-08-28', withRelation: true });
    s.d.dispatch({ type: 'START_EDIT' });
    const add = s.q<HTMLButtonElement>('[data-pkc-action="add-relation"]');
    expect(add.disabled, '関係を足すが押せる').toBe(true);
    expect(add.title, '理由が出ていない').toContain(REASON);
    expect(s.q<HTMLInputElement>('[data-pkc-field="relation-target"]').disabled).toBe(true);
    expect(s.q<HTMLSelectElement>('[data-pkc-field="relation-kind"]').disabled).toBe(true);
    const set = s.q<HTMLButtonElement>('[data-pkc-action="set-entry-date"]');
    expect(set.disabled, '日付を付けるが押せる').toBe(true);
    expect(set.title).toContain(REASON);
    const clear = s.q<HTMLButtonElement>('[data-pkc-action="clear-entry-date"]');
    expect(clear.disabled, '日付を外すが押せる').toBe(true);
    expect(clear.title).toContain(REASON);
    const del = s.q<HTMLButtonElement>('[data-pkc-action="remove-relation"]');
    expect(del.disabled, '関係の × が押せる').toBe(true);
    expect(del.title).toContain(REASON);
  });

  it('編集を終えれば口は戻る(片道にしない)', () => {
    const s = mounted({ date: '2026-08-28', withRelation: true });
    s.d.dispatch({ type: 'START_EDIT' });
    s.d.dispatch({ type: 'CANCEL_EDIT' });
    expect(s.q<HTMLButtonElement>('[data-pkc-action="add-relation"]').disabled).toBe(false);
    expect(s.q<HTMLButtonElement>('[data-pkc-action="set-entry-date"]').disabled).toBe(false);
    expect(s.q<HTMLButtonElement>('[data-pkc-action="remove-relation"]').disabled).toBe(false);
  });

  /**
   * 🔴 **それでも押された回は、黙って捨てず理由を言い、打った字を残す。**
   *
   * ⚠ disabled は DOM の話 ── stale な DOM・キーボード・将来の別経路から
   *   届く形は残る。直す前はここで**欄だけ空になり、成功と同じ見た目**だった。
   */
  it('🔴 編集中に関係を足そうとしても、字を捨てず理由を言う', () => {
    const s = mounted();
    s.d.dispatch({ type: 'START_EDIT' });
    const input = s.q<HTMLInputElement>('[data-pkc-field="relation-target"]');
    const add = s.q<HTMLButtonElement>('[data-pkc-action="add-relation"]');
    input.value = 'い';
    add.disabled = false; // stale な DOM を再現(disabled が効かない経路)
    add.click();
    expect(s.d.getState().error ?? '', '理由が出ていない').toContain('編集を終了');
    // ⚠ 文言は押した場所と対で pin する(取り違え変異を殺す)
    expect(s.d.getState().error ?? '', '押した場所と文言が合っていない').toContain('関係を足');
    expect(s.d.getState().relations, '編集中に関係が作られた').toHaveLength(0);
    expect(input.value, '打った字が捨てられた(成功と同じ見た目になる)').toBe('い');
  });

  it('🔴 編集中に日付を付けようとしても、ピッカーを開かず理由を言う', () => {
    const s = mounted();
    s.d.dispatch({ type: 'START_EDIT' });
    const set = s.q<HTMLButtonElement>('[data-pkc-action="set-entry-date"]');
    set.disabled = false;
    set.click();
    expect(s.d.getState().error ?? '').toContain('編集を終了');
    expect(s.d.getState().error ?? '', '押した場所と文言が合っていない').toContain('日付を付け');
    // ⚠ 直す前はピッカーの全手順を完走させてから捨てていた ── 開かないことまで見る
    expect(document.querySelector('dialog'), '編集中なのにピッカーが開いた').toBeNull();
    expect(s.d.getState().entryMetas.get('n1')!.date, '日付が変わった').toBeNull();
  });

  it('🔴 編集中に関係の × を押しても、消さずに理由を言う', () => {
    const s = mounted({ withRelation: true });
    s.d.dispatch({ type: 'START_EDIT' });
    const del = s.q<HTMLButtonElement>('[data-pkc-action="remove-relation"]');
    del.disabled = false;
    del.click();
    expect(s.d.getState().error ?? '').toContain('編集を終了');
    expect(s.d.getState().error ?? '', '押した場所と文言が合っていない').toContain('関係を消');
    expect(s.d.getState().relations, '編集中に関係が消えた').toHaveLength(1);
  });

  it('🔴 編集中に日付を外そうとしても、外さずに理由を言う', () => {
    const s = mounted({ date: '2026-08-28' });
    s.d.dispatch({ type: 'START_EDIT' });
    const clear = s.q<HTMLButtonElement>('[data-pkc-action="clear-entry-date"]');
    clear.disabled = false;
    clear.click();
    expect(s.d.getState().error ?? '').toContain('編集を終了');
    expect(s.d.getState().error ?? '', '押した場所と文言が合っていない').toContain('日付を外');
    expect(s.d.getState().entryMetas.get('n1')!.date, '日付が外れた').toBe('2026-08-28');
  });
});
