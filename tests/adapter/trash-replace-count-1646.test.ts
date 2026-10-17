/** @vitest-environment happy-dom */
/**
 * 🔴 **ゴミ箱の見つけ方 / 置換の件数**(#1646 の 1 と 2。Gemini 裁定 = #1163 の依頼 40 の推薦どおり ── 1 = C(A + B)/ 2 = A)。
 *
 * ① 「ゴミ箱へ移しました」の知らせに、ゴミ箱の場所を書く(7 秒の「元に戻す」を過ぎたあと探せるように)
 * ② 右の列 / 右クリックの「ゴミ箱を開く」(`open-trash`)は、左の列を「フォルダ」へ移してからゴミ箱を開く
 * ③ 置換の帯に、探す語が当たる件数を出す(「すべて置換」と同じ数え方 ── 食い違うと嘘になる)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { CenterRouter } from '../../src/adapter/ui/render/center';
import { resetAppDialogForTest } from '../../src/adapter/ui/render/app-dialog';
import { TRASH_PLACE, trashMessage } from '../../src/adapter/ui/render/trash-undo';
import { ENTRY_ACTION_LABELS } from '../../src/features/entry-actions';

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

describe('① 知らせにゴミ箱の場所を書く', () => {
  it('1 件・複数・中のノート・リンクのどの知らせにも、場所が最後に付く', () => {
    expect(TRASH_PLACE).toBe('ゴミ箱はフォルダの一覧のいちばん下にあります');
    expect(trashMessage(['猫'])).toBe(`「猫」をゴミ箱へ移しました(${TRASH_PLACE})`);
    expect(trashMessage(['猫', '犬'])).toBe(`2 件をゴミ箱へ移しました(${TRASH_PLACE})`);
    expect(trashMessage(['フォルダ'], 3, '2 件')).toBe(
      `「フォルダ」をゴミ箱へ移しました(中のノート 3 件は消えずにルートに出ています / 2 件のノートからのリンクは、戻すまで開けません / ${TRASH_PLACE})`,
    );
  });
});

describe('② 「ゴミ箱を開く」は左の列をフォルダへ移してからゴミ箱を開く', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });
  it('字は「ゴミ箱を開く」で、押すと「フォルダ」へ移したあとに、ゴミ箱の一覧を求める', () => {
    expect(ENTRY_ACTION_LABELS['open-trash']).toBe('ゴミ箱を開く');
    const root = document.createElement('div');
    root.setAttribute('data-pkc-slot', 'root');
    const btn = document.createElement('button');
    btn.setAttribute('data-pkc-action', 'open-trash');
    root.append(btn);
    document.body.append(root);
    const d = new Dispatcher();
    const order: string[] = [];
    d.onEvent((e) => {
      if (e.type === 'REQUEST_TRASH_LIST') order.push('trash');
    });
    const setBrowse = vi.fn((m: string) => {
      order.push(`browse:${m}`);
    });
    bindActions(root, d, { setBrowse });
    btn.click();
    expect(order, 'フォルダへ移してから、ゴミ箱の一覧を求める').toEqual(['browse:filer', 'trash']);
  });
});

describe('③ 置換の帯に当たる件数を出す', () => {
  function editingWith(body: string) {
    document.body.innerHTML = '';
    resetAppDialogForTest();
    const root = document.createElement('div');
    root.setAttribute('data-pkc-slot', 'root');
    document.body.append(root);
    const d = new Dispatcher();
    const regions = buildShell(root);
    const center = new CenterRouter(regions.detail, undefined, null, undefined, (b) =>
      d.dispatch({ type: 'UPDATE_OPEN_BODY', body: b }),
    );
    d.onState((st) => center.render(st));
    bindActions(root, d);
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('n1')], relations: [] });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body });
    d.dispatch({ type: 'START_EDIT' });
    return { root, d };
  }
  const count = (root: HTMLElement): string =>
    root.querySelector('[data-pkc-field="replace-count"]')?.textContent ?? '(欄が無い)';
  const typeFind = (root: HTMLElement, v: string): void => {
    const f = root.querySelector<HTMLInputElement>('[data-pkc-field="replace-find"]')!;
    f.value = v;
    f.dispatchEvent(new Event('input', { bubbles: true }));
  };

  it('探す語を打つと「N 件」が出て、空にすると消える(0 件とは言わない)', () => {
    const { root } = editingWith('aa Aa bb');
    expect(count(root), '何も打っていない間は空').toBe('');
    typeFind(root, 'aa');
    expect(count(root)).toBe('2 件');
    typeFind(root, 'zz');
    expect(count(root), '当たらないときは 0 件').toBe('0 件');
    typeFind(root, '');
    expect(count(root)).toBe('');
  });

  it('「大文字と小文字を区別」を切り替えると数え直す。件数は「すべて置換」の結果と一致する', async () => {
    const { root, d } = editingWith('aa Aa bb');
    typeFind(root, 'aa');
    const box = root.querySelector<HTMLInputElement>('[data-pkc-field="replace-case"]')!;
    box.checked = true;
    box.dispatchEvent(new Event('change', { bubbles: true }));
    expect(count(root)).toBe('1 件');
    root.querySelector<HTMLInputElement>('[data-pkc-field="replace-with"]')!.value = 'X';
    root.querySelector<HTMLButtonElement>('[data-pkc-action="replace-all"]')!.click();
    await new Promise<void>((r) => setTimeout(r, 30));
    expect(d.getState().notice, '出ていた件数と置き換えた件数が違う').toBe('1 件を置き換えました');
    expect(count(root), '置き換えたあとは当たらない').toBe('0 件');
  });

  it('本文を打つと数え直す(古い件数を残さない)/ 編集を終えたら消える', () => {
    const { root, d } = editingWith('aa');
    typeFind(root, 'aa');
    expect(count(root)).toBe('1 件');
    d.dispatch({ type: 'UPDATE_OPEN_BODY', body: 'aa aa aa' });
    expect(count(root)).toBe('3 件');
    d.dispatch({ type: 'CANCEL_EDIT' });
    expect(count(root), '編集中でないと置換は効かない ── 件数も出さない').toBe('');
  });
});
