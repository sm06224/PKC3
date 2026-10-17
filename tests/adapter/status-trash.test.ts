/** @vitest-environment happy-dom */
/**
 * 見つからないノートへのリンクを押したとき、知らせの隣に「ゴミ箱を開く」を出す(#1648 の 2)。
 *
 * 守るのは:
 * ① 器が押し口を持ち、受け手 `show-trash`(フォルダの「ゴミ箱を開く」と同じ口)へ繋がっている
 * ② 🔴 実際に出る「見つかりません」の知らせの間だけ出る(別の知らせが上書きしたら畳む ── 対照群つき)
 * ③ 🔴 押すと、左の列が「フォルダ」になり、ゴミ箱の一覧が頼まれる(別のタブに居ても見える)
 */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { paintStatusTrash } from '../../src/adapter/ui/render/status-open';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { bindActions, selectEntryOrExplain } from '../../src/adapter/ui/actions/binder';

afterEach(() => {
  document.body.textContent = '';
});

function missingLine(): string {
  const root = document.createElement('div');
  document.body.append(root);
  const d = new Dispatcher();
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [], relations: [] });
  selectEntryOrExplain(d, 'no-such-lid', 'リンク先のノート', root, {} as never);
  const st = d.getState();
  return `⚠ エラー: ${st.error ?? st.notice ?? ''}`;
}

describe('見つからないノートの知らせの隣の「ゴミ箱を開く」(#1648)', () => {
  it('① 器が押し口を持ち、受け手へ繋がっている(最初は畳んである)', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const regions = buildShell(root);
    const b = regions.statusTrash;
    expect(b.getAttribute('data-pkc-action'), '受け手の無い口').toBe('show-trash');
    expect(b.textContent).toBe('ゴミ箱を開く');
    expect(b.hidden, '知らせが無いのに出ている').toBe(true);
    expect(regions.status.contains(b), '状態の行の外に居る').toBe(true);
  });

  it('🔴 ② 実際に出る「見つかりません」の知らせの間だけ出る', () => {
    const line = missingLine();
    expect(line, '前提: 見つからない知らせが出ていない').toContain('見つかりません');
    const b = document.createElement('button');
    b.hidden = true;
    paintStatusTrash(b, line);
    expect(b.hidden, '見つからない知らせの隣に出ていない').toBe(false);
    // 対照群 ── 別の知らせが上書きしたら畳む
    paintStatusTrash(b, 'コピーしました');
    expect(b.hidden, '別の知らせの隣に残っている').toBe(true);
    paintStatusTrash(b, '⚠ エラー: リンク先のノートを開けません');
    expect(b.hidden, '手掛かりの無い別のエラーに出している').toBe(true);
    paintStatusTrash(b, '');
    expect(b.hidden).toBe(true);
  });

  it('🔴 ③ 押すと左の列が「フォルダ」になり、ゴミ箱の一覧が頼まれる', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const d = new Dispatcher();
    const tabs: string[] = [];
    const events: string[] = [];
    d.onEvent((e) => events.push(e.type));
    const regions = buildShell(root);
    bindActions(root, d, { setBrowse: (m) => void tabs.push(m) });
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [], relations: [] });
    regions.statusTrash.hidden = false;
    regions.statusTrash.click();
    expect(tabs, '別のタブに居るまま押しても、フォルダへ移らない').toEqual(['filer']);
    expect(events, 'ゴミ箱の一覧が頼まれていない').toContain('REQUEST_TRASH_LIST');
  });

  it('⚠ ④ main.ts が、状態の行へ出した字をそのまま押し口へ渡している(原文 pin)', () => {
    const code = readFileSync('src/main.ts', 'utf-8')
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n');
    expect(code).toContain('paintStatusTrash(regions.statusTrash, text);');
  });
});
