/** @vitest-environment happy-dom */
/**
 * 🔴 **ログの日の行は、ログの読む面にだけ出る**(#1441)── `DetailRenderer` を通す。
 *
 * ⚠ 読む面の器(`bodyHost`)は**ノートが変わっても使い回す**。ログ → 同じ書き方の見出しを持つ
 *   普通のノートへ移ったとき、前のログの行が残る / 普通のノートにも出る、を見る。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { initialState, reduce, type AppState } from '../../src/adapter/state/app-state';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { DetailRenderer } from '../../src/adapter/ui/render/detail';

const meta = (lid: string, archetype: 'text' | 'textlog'): EntryMeta => ({
  lid,
  title: 't-' + lid,
  archetype,
  createdAt: null,
  updatedAt: null,
  entryOrder: 1,
  status: null,
  date: null,
  archived: false,
  bodyChars: null,
});

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const BODY = [
  '## 2026-10-09 09:00:00',
  '一件目',
  '## 2026-10-10 09:00:00',
  '二件目',
].join('\n\n');

const days = (root: HTMLElement): number => root.querySelectorAll('button[data-pkc-log-day]').length;

beforeEach(() => {
  document.body.textContent = '';
});

describe('ログの日の行(読む面) #1441', () => {
  it('ログには出る / 同じノートが普通のノートになると外れ / 戻ると出る(器は使い回される)', async () => {
    const root = document.createElement('div');
    document.body.append(root);
    const detail = new DetailRenderer(buildShell(root).detail);
    let s: AppState = reduce(initialState, {
      type: 'SYS_BOOTED',
      cid: 'c1',
      metas: [meta('n', 'textlog')],
      relations: [],
    }).state;
    s = reduce(s, { type: 'SELECT_ENTRY', lid: 'n' }).state;
    s = reduce(s, { type: 'BODY_LOADED', lid: 'n', body: BODY }).state;
    let round = 0;
    const kind = async (archetype: 'text' | 'textlog'): Promise<void> => {
      // ⚠ 指紋に種類は入っていない ── 本文も動かさないと描き直しが走らない(種類の変更は本文の書き換えと一緒に来る)
      round += 1;
      s = { ...s, entryMetas: new Map([['n', meta('n', archetype)]]) };
      s = reduce(s, { type: 'BODY_LOADED', lid: 'n', body: BODY + '\n\n'.repeat(1) + '末尾 ' + round }).state;
      detail.render(s);
      await settle();
    };

    await kind('textlog');
    expect(days(root), 'ログに日の行が出ていない(前提)').toBe(2);
    const host = root.querySelector('[data-pkc-field="detail-body"]')!;

    await kind('text');
    expect(root.querySelector('[data-pkc-field="detail-body"]'), '器が作り直された(前提が崩れている)').toBe(host);
    expect(days(root), '普通のノートに前のログの行が残った / 出た').toBe(0);

    await kind('textlog');
    expect(days(root)).toBe(2);
  });
});
