/** @vitest-environment happy-dom */
/**
 * 🔴 **画面の改善 ③-b / ③-d**(#1982。user 裁定 2026-11-22)。
 *
 * ③-b 作るボタンの行は「+ ノート ▼」「今日」「その他 ▾」の 3 点 ── 添付・録音・画面録画・時間は**いつも**「その他 ▾」の下。
 *     絞り込みの札・保存した検索・ピン留めの下の線をやめ、段差と余白で区切る。
 * ③-d ゴミ箱を縦のバーの下の群へ(既存の `show-trash`)。縦のバーから押すと、開いていればもう一度で閉じる。
 *
 * ⚠ happy-dom は版面を組まない(帯の幅が 0 なので `fitBar` は畳まない)── 畳んだ見た目と「その他 ▾」から押せることは
 *   `tests/smoke/layout.smoke.spec.ts`(③-b / ③-d の節)が実ブラウザで見る。ここは印と規則と受け手を見る。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { appPanes, applyPaneVisibility } from '../../src/adapter/ui/render/pane-visibility';
import { collectionBarItems } from '../../src/adapter/ui/render/collection-bar';
import { CREATE_MORE, CREATE_TOOL_ATTR, fitBar, makeBarMore } from '../../src/adapter/ui/render/bar-overflow';
import { COLLECTION_COMMANDS } from '../../src/adapter/ui/render/commands';
import { blocksFor, stripComments, withoutMedia } from '../helpers/css-blocks';

function mounted() {
  const root = document.createElement('div');
  root.setAttribute('data-pkc-slot', 'root');
  document.body.append(root);
  const d = new Dispatcher();
  buildShell(root);
  const setBrowse = vi.fn();
  bindActions(root, d, { setBrowse });
  applyPaneVisibility(root, appPanes.getHidden());
  return { root, d, setBrowse };
}

beforeEach(() => {
  document.body.innerHTML = '';
  localStorage.clear();
  appPanes.setHidden([]);
});

describe('③-b 作るボタンの行は 3 点', () => {
  it('🔴 添付・録音・画面録画・時間だけが「その他 ▾」へ回る印を持ち、+ ノート・▼・今日は持たない', () => {
    const { root } = mounted();
    const bar = root.querySelector('[data-pkc-region="create-bar"]')!;
    const tools = [...bar.querySelectorAll(`[${CREATE_TOOL_ATTR}]`)].map((b) => b.getAttribute('data-pkc-action'));
    expect(tools.sort()).toEqual(['attach-file', 'start-audio-capture', 'start-screen-capture', 'start-timer']);
    for (const sel of ['[data-pkc-field="create-run"]', '[data-pkc-field="create-pick"]', '[data-pkc-field="open-today"]']) {
      expect(bar.querySelector(sel)?.hasAttribute(CREATE_TOOL_ATTR), `${sel} が回される(1 クリックで押せなくなる)`).toBe(false);
    }
  });

  it('🔴 回す物があれば幅に関係なく畳み、「その他 ▾」を出す(幅が十分でも)', () => {
    const bar = document.createElement('div');
    document.body.append(bar);
    const mk = (tool: boolean) => {
      const b = document.createElement('button');
      b.setAttribute('data-pkc-bar-tile', '');
      if (tool) b.setAttribute(CREATE_TOOL_ATTR, '');
      bar.append(b);
      return b;
    };
    const keep = [mk(false), mk(false)];
    const tools = [mk(true), mk(true)];
    // 十分に広い帯(1 段に収まる)── 回す物以外は畳まない
    for (const b of [bar, ...keep, ...tools])
      vi.spyOn(b, 'getBoundingClientRect').mockReturnValue({ width: 400, height: 32, top: 0, left: 0, right: 400, bottom: 32, x: 0, y: 0, toJSON: () => ({}) } as DOMRect);
    const more = makeBarMore(CREATE_MORE);
    fitBar(bar, more, {
      candidates: (b) => [...b.querySelectorAll<HTMLElement>('button[data-pkc-bar-tile]')],
      forced: (el) => el.hasAttribute(CREATE_TOOL_ATTR),
    });
    expect(tools.every((b) => b.hasAttribute('data-pkc-overflow')), '道具が回っていない').toBe(true);
    expect(keep.some((b) => b.hasAttribute('data-pkc-overflow')), '回さない物まで畳んだ').toBe(false);
    expect(more.isConnected, '「その他 ▾」が出ていない').toBe(true);
    expect(more.textContent).toBe('その他 ▾');
    expect(more.getAttribute('aria-label')).not.toBe('');
  });

  it('🔴 絞り込みの札・保存した検索・ピン留めは、下の線ではなく余白で区切る', () => {
    const css = withoutMedia(stripComments(readFileSync(join(__dirname, '../../src/styles/app.css'), 'utf-8')));
    for (const r of ['kind-bar', 'saved-searches', 'note-pins']) {
      const rule = blocksFor(css, `[data-pkc-region='${r}']`).join('\n');
      expect(rule, `${r} の規則が読めない`).not.toBe('');
      expect(rule, `${r} に下の線が残っている`).not.toMatch(/border-bottom/);
      expect(rule, `${r} の下に余白が無い(隣と地がくっつく)`).toMatch(/margin-bottom:\s*var\(--s1\)/);
    }
  });
});

describe('③-d ゴミ箱を縦のバーの下の群へ', () => {
  it('🔴 下の群に 1 つだけ居る(取り込む・バックアップの次)。受け手は既存の show-trash', () => {
    const items = collectionBarItems();
    const at = items.findIndex((i) => i.action === 'show-trash');
    expect(at, 'ゴミ箱が一覧に無い').toBe(COLLECTION_COMMANDS.length);
    expect(items.filter((i) => i.action === 'show-trash')).toHaveLength(1);
    const { root } = mounted();
    expect(root.querySelectorAll('[data-pkc-region="rail"] [data-pkc-action="show-trash"]').length).toBe(1);
    const btn = root.querySelector<HTMLElement>('[data-pkc-region="rail"] [data-pkc-action="show-trash"]')!;
    expect(btn.getAttribute('aria-label')).toBe('ゴミ箱');
    expect(btn.title).toContain('もう一度押すと閉じます');
  });

  it('🔴 縦のバーから押すと開き、もう一度で閉じる。一覧の「ゴミ箱を開く」は開くだけ(対照群)', () => {
    const { root, d, setBrowse } = mounted();
    const rail = root.querySelector<HTMLElement>('[data-pkc-region="rail"] [data-pkc-action="show-trash"]')!;
    expect(d.getState().trashPanel, '前提: 開いている').toBeNull();
    const sent: string[] = [];
    const orig = d.dispatch.bind(d);
    vi.spyOn(d, 'dispatch').mockImplementation((a) => {
      sent.push(a.type);
      return orig(a);
    });
    rail.click();
    expect(sent, '縦のバーから開く要求を出さない').toContain('SHOW_TRASH');
    expect(setBrowse).toHaveBeenLastCalledWith('filer');
    // ⚠ 一覧は worker から届く(`SHOW_TRASH` は要求を出すだけ)── 届いたことにする
    d.dispatch({ type: 'TRASH_LIST_LOADED', items: [] });
    expect(d.getState().trashPanel, '前提: 一覧が届いても開かない').not.toBeNull();
    rail.click();
    expect(d.getState().trashPanel, 'もう一度押しても閉じない(片道)').toBeNull();
    // 対照群: バーの外の同じ action は閉じない
    const outside = document.createElement('button');
    outside.setAttribute('data-pkc-action', 'show-trash');
    root.querySelector('[data-pkc-region="center"]')!.append(outside);
    d.dispatch({ type: 'TRASH_LIST_LOADED', items: [] });
    outside.click();
    expect(d.getState().trashPanel, 'バーの外で押して閉じた').not.toBeNull();
  });
});
