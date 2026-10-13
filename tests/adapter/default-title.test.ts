/** @vitest-environment happy-dom */
/**
 * 🔴 **作ったノートの既定の題名が、既に在る題名と重ならない**(#1087 の見直し 2026-10-13)。
 *
 * 既定の題名は「日付 種類 n」で、n は「同じ種類の件数 + 1」。⚠ 古いノートを 1 件消すと件数が減り、
 * 今日作った既存の題名と同じ題名が出た(つながりを足すときに「題名を分けてください」で止まる)。
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
  it('🔴 件数 + 1 の題名が既に在れば、空いている番号まで進める', () => {
    const label = archetypeLabel('text');
    const d = new Dispatcher();
    // 件数は 1 なので、直す前は「… 2」を作り、既に在る「… 2」と重なった(… 1 を消した後の形)
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c', metas: [META('a', `${today()} ${label} 2`)], relations: [] });
    const stop = bindActions(root, d);
    createButton().click();
    stop();
    const titles = [...d.getState().entryMetas.values()].map((m) => m.title);
    expect(titles, '前提:1 件作れていない').toHaveLength(2);
    expect(new Set(titles).size, '同じ題名を作った').toBe(2);
    expect(titles).toContain(`${today()} ${label} 3`);
  });

  it('対照群:重ならなければ今までどおり「件数 + 1」', () => {
    const label = archetypeLabel('text');
    const d = new Dispatcher();
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c', metas: [META('a', '別の題名')], relations: [] });
    const stop = bindActions(root, d);
    createButton().click();
    stop();
    expect([...d.getState().entryMetas.values()].map((m) => m.title)).toContain(`${today()} ${label} 2`);
  });
});
