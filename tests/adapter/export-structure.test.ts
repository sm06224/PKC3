/** @vitest-environment happy-dom */
/**
 * 🔴 **「構成をコピー」を押したら届くか**(#429 段①)。
 *
 * ⚠ 組み立ての規則は `tests/features/structure-text.test.ts`。
 *   ここが見るのは**繋がり**である ── 押した所からクリップボードまで。
 */
import { describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { buildSettingsCommands } from '../../src/adapter/ui/render/commands';

function meta(lid: string, title: string, order: number, archetype = 'text'): EntryMeta {
  return {
    lid, title, archetype,
    createdAt: null, updatedAt: null, entryOrder: order,
    status: null, date: null, archived: false, bodyChars: 0,
  };
}

function setup(metas: EntryMeta[]) {
  document.body.innerHTML = '';
  const root = document.createElement('div');
  document.body.append(root);
  buildShell(root);
  // ⚠ この口は**設定の面**に在る ── 器を足さないと押す先が無い
  root.append(buildSettingsCommands());
  const d = new Dispatcher();
  const copied: string[] = [];
  const status: string[] = [];
  const errors: string[] = [];
  d.onEvent?.(() => {});
  bindActions(root, d, {
    copyText: (t: string) => copied.push(t),
    showStatus: (t: string) => status.push(t),
  });
  d.onState(() => {
    const e = d.getState().error;
    if (e && !errors.includes(e)) errors.push(e);
  });
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas, relations: [] });
  const press = (): void =>
    root.querySelector<HTMLElement>('[data-pkc-action="export-structure"]')!.click();
  return { root, d, copied, status, errors, press };
}

describe('構成をコピー(#429 段①)', () => {
  it('🔴 押す口が設定の面に在る', () => {
    const { root } = setup([meta('a', 'めも', 1)]);
    expect(
      root.querySelector('[data-pkc-action="export-structure"]'),
      '押す口が無い',
    ).not.toBeNull();
  });

  it('🔴 押すと、貼れる 1 枚がクリップボードに入る', () => {
    const { copied, press } = setup([meta('a', 'めも', 1), meta('b', '別のめも', 2)]);
    press();
    expect(copied, 'コピーされていない').toHaveLength(1);
    // ⚠ 中身は**両方**要る ── lid だけでも説明だけでも使えない
    expect(copied[0], 'lid が入っていない').toContain('a');
    expect(copied[0], '題名が入っていない').toContain('めも');
    expect(copied[0], 'コマンドの書き方が入っていない').toContain('mv ');
  });

  it('🔴 何件出したかを知らせる(黙ってコピーしない)', () => {
    const { status, press } = setup([meta('a', 'x', 1), meta('b', 'y', 2)]);
    press();
    expect(status.join(' / '), '件数を知らせていない').toContain('2 件');
  });

  it('🔴 押した合図が出る(押せたのか分からない、を作らない)', () => {
    const { root, press } = setup([meta('a', 'x', 1)]);
    press();
    expect(
      root.querySelector('[data-pkc-action="export-structure"]')?.getAttribute('data-pkc-flash'),
      'コピーの合図が出ていない',
    ).toBe('true');
  });

  /**
   * 🔴 **1 件も無ければ断る**。⚠ 説明だけの紙を渡しても使えないし、
   *   user は「コピーできた」と読んでしまう(黙って成功する形が最悪)。
   */
  it('🔴 ノートが 1 件も無ければ、コピーせずに断る', () => {
    const { copied, errors, press } = setup([]);
    press();
    expect(copied, '空なのにコピーした').toEqual([]);
    expect(errors.join(' / '), '断っていない').toContain('ノートがまだありません');
  });
});
