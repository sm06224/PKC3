/** @vitest-environment happy-dom */
/**
 * 🔴 **作ったノートの既定の題名が、既に在る題名と重ならない**(#1087 の見直し 2026-10-13)。
 *
 * 既定の題名は「日付 種類 n」で、n は「その日の通し番号」(1 から。使われている番号は飛ばす)。
 * ⚠ 古いノートを 1 件消すと件数が減り、今日作った既存の題名と同じ題名が出た(つながりを足すときに
 * 「題名を分けてください」で止まる)。さらに #1657(依頼 45 の 4)までは番号が「同じ種類の件数 + 1」で、
 * 今日 1 件目でも「ノート 347」のような大きな数が付いた。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { archetypeLabel } from '../../src/features/flavor/archetype-label';
import type { EntryMeta } from '../../src/core/model/entry-meta';

const META = (lid: string, title: string): EntryMeta => ({
  lid,
  title,
  archetype: 'text',
  createdAt: null,
  updatedAt: null,
  entryOrder: 0,
  status: null,
  date: null,
  archived: false,
  bodyChars: null,
});

const today = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

let root: HTMLElement;
beforeEach(() => {
  document.body.textContent = '';
  root = document.createElement('div');
  document.body.append(root);
});

function createButton(): HTMLButtonElement {
  const b = document.createElement('button');
  b.setAttribute('data-pkc-action', 'create-entry');
  b.setAttribute('data-pkc-archetype', 'text');
  root.append(b);
  return b;
}

describe('既定の題名', () => {
  it('🔴 今日の通し番号の題名が既に在れば、空いている番号まで進める', () => {
    const label = archetypeLabel('text');
    const d = new Dispatcher();
    // 今日の「… 1」「… 2」が在る(間の番号が空いている形も含む)── 次は「… 3」
    d.dispatch({
      type: 'SYS_BOOTED',
      cid: 'c',
      metas: [META('a', `${today()} ${label} 2`), META('b', `${today()} ${label} 1`)],
      relations: [],
    });
    const stop = bindActions(root, d);
    createButton().click();
    stop();
    const titles = [...d.getState().entryMetas.values()].map((m) => m.title);
    expect(titles, '前提:1 件作れていない').toHaveLength(3);
    expect(new Set(titles).size, '同じ題名を作った').toBe(3);
    expect(titles).toContain(`${today()} ${label} 3`);
  });

  it('🔴 同じ種類のノートが何百件あっても、今日 1 件目は「1」(件数を番号にしない。#1657)', () => {
    const label = archetypeLabel('text');
    const d = new Dispatcher();
    const metas = Array.from({ length: 346 }, (_, i) => META(`n${String(i)}`, `別の題名 ${String(i)}`));
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c', metas, relations: [] });
    const stop = bindActions(root, d);
    createButton().click();
    stop();
    const titles = [...d.getState().entryMetas.values()].map((m) => m.title);
    expect(titles, '前提:1 件作れていない').toHaveLength(347);
    expect(titles).toContain(`${today()} ${label} 1`);
  });

  it('対照群:重ならなければ「1」から', () => {
    const label = archetypeLabel('text');
    const d = new Dispatcher();
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c', metas: [META('a', '別の題名')], relations: [] });
    const stop = bindActions(root, d);
    createButton().click();
    stop();
    expect([...d.getState().entryMetas.values()].map((m) => m.title)).toContain(`${today()} ${label} 1`);
  });
});
