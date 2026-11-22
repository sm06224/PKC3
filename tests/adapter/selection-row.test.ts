/** @vitest-environment happy-dom */
/**
 * 🔴 **選択操作の行**(#1982 ③-c。user 裁定 2026-11-22)── 0 件 / 1 件 / 2 件以上で中身が替わる 1 行。
 *
 * 守る主張:
 * 1. 選択操作は**行 1 本**(`filer-action-row`)に入る ── 数・上へ / 下へ・書き出す・ゴミ箱へ・移す・タグ・解除
 * 2. 既存の 3 条件は変えない:「中まで全部出す」の間は上へ / 下へを出さない / 2 件以上なら出さない / 自分で並べた順でないと押せない
 * 3. 図案だけのボタンは名前(`aria-label` + `title`)を持つ
 * 4. 「タグ ▾」で行の中身がタグの欄へ入れ替わり、「戻る」で戻る ── 組み直しても開いたまま。選択が無くなれば閉じる
 * 5. 案内の文は見えない字 + 行の `title` へ / ふつうのフォルダの作る先はパンくずの `title` /
 *    スマートフォルダの「ここには作れません」は**見える字**で行に残す
 *
 * ⚠ 1 行に収まることは実ブラウザで見る(`tests/smoke/layout.smoke.spec.ts` の ③-c の節)。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { EntryMeta, Relation } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { BrowseRouter } from '../../src/adapter/ui/render/browse';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { BULK_TAG_MODE_ATTR, HINT_ONLY_ATTR } from '../../src/adapter/ui/render/filer';

function meta(lid: string, order: number, archetype = 'text'): EntryMeta {
  return { lid, title: 't-' + lid, archetype, createdAt: null, updatedAt: null, entryOrder: order, status: null, date: null, archived: false, bodyChars: null };
}
const rel = (id: string, from: string, to: string): Relation => ({ id, fromLid: from, toLid: to, kind: 'structural', createdAt: null, updatedAt: null });

function setup(metas: EntryMeta[] = [meta('a', 1), meta('b', 2), meta('c', 3)], relations: Relation[] = []) {
  const root = document.createElement('div');
  document.body.append(root);
  const d = new Dispatcher();
  const regions = buildShell(root);
  const browse = new BrowseRouter(regions.sidebar, regions.browseHost);
  d.onState((s) => browse.render(s, 'filer'));
  bindActions(root, d, { setBrowse: () => browse.render(d.getState(), 'filer') });
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas, relations });
  const q = <T extends HTMLElement>(s: string): T | null => root.querySelector<T>(s);
  const row = () => q('[data-pkc-field="filer-action-row"]');
  const inRow = (sel: string) => row()?.querySelector<HTMLElement>(sel) ?? null;
  return { root, d, q, row, inRow };
}

beforeEach(() => {
  document.body.innerHTML = '';
  localStorage.clear();
});

describe('行 1 本に入る', () => {
  it('🔴 何も選んでいない: 見える物が無ければ行ごと出さない(案内は見えない字 + title)', () => {
    const { row, inRow } = setup();
    expect(row(), '行が無い').not.toBeNull();
    expect(row()!.hidden, '見える物が無いのに行が出ている').toBe(true);
    const hint = inRow('[data-pkc-field="filer-move-empty"]')!;
    expect(hint.hasAttribute(HINT_ONLY_ATTR), '案内が見える字のまま').toBe(true);
    expect(row()!.title).toBe(hint.textContent);
  });

  it('🔴 1 件(開いたノート + 印 1): 数・上へ / 下へ・書き出す・タグ・解除が同じ行。ゴミ箱へ・移すは出さない', () => {
    const { d, row, inRow } = setup();
    // ⚠ 開くと印も 1 つ付く(`SELECT_ENTRY` が選択を開いた 1 件にする)
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'b' });
    expect(row()!.hidden).toBe(false);
    for (const sel of [
      '[data-pkc-field="filer-bulk-count"]',
      '[data-pkc-action="move-order-up"]',
      '[data-pkc-action="move-order-down"]',
      '[data-pkc-field="bulk-export-menu"]',
      '[data-pkc-field="bulk-tag-toggle"]',
      '[data-pkc-action="clear-selection"]',
    ])
      expect(inRow(sel), `${sel} が行に無い`).not.toBeNull();
    expect(inRow('[data-pkc-action="delete-selected"]'), '1 件でゴミ箱へが出た').toBeNull();
    expect(inRow('[data-pkc-field="bulk-move"]'), '1 件で移すが出た').toBeNull();
    // 上へ / 下へは数の隣
    expect(inRow('[data-pkc-field="filer-bulk-count"]')!.nextElementSibling?.getAttribute('data-pkc-field')).toBe('order-nudge');
    expect(row()!.querySelectorAll('[data-pkc-field="filer-action-row"]').length, '行が入れ子になった').toBe(0);
  });

  it('🔴 2 件以上: ゴミ箱へ・移すが出て、上へ / 下へは出ない(既存の条件)', () => {
    const { d, inRow } = setup();
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'b' });
    d.dispatch({ type: 'TOGGLE_SELECT', lid: 'a' });
    expect(inRow('[data-pkc-field="filer-bulk-count"]')!.textContent).toBe('2 件');
    expect(inRow('[data-pkc-field="filer-bulk-count"]')!.title).toBe('2 件を選んでいます');
    expect(inRow('[data-pkc-action="delete-selected"]')).not.toBeNull();
    expect(inRow('[data-pkc-field="bulk-move"]')).not.toBeNull();
    expect(inRow('[data-pkc-field="order-nudge"]'), '2 件で上へ / 下へが出た').toBeNull();
  });

  it('🔴 自分で並べた順でないと上へ / 下へは押せない・端では押せない(理由は title)', () => {
    const { d, inRow } = setup();
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    const up = inRow('[data-pkc-action="move-order-up"]') as HTMLButtonElement;
    expect(up.disabled, '先頭なのに押せる').toBe(true);
    expect(up.title).toBe('すでに先頭です');
    const downBefore = inRow('[data-pkc-action="move-order-down"]') as HTMLButtonElement;
    expect(downBefore.disabled, '対照群: 自分で並べた順・先頭なら下へは押せる').toBe(false);
    d.dispatch({ type: 'SET_ENTRY_SORT', sort: 'title' } as never);
    const down = inRow('[data-pkc-action="move-order-down"]') as HTMLButtonElement;
    expect(down, '並び順を変えたら下へが消えた').not.toBeNull();
    expect(down.disabled).toBe(true);
    expect(down.title).toBe('並び順が「自分で並べた順」のときだけ動かせます');
  });

  it('🔴 図案だけのボタンは名前と説明を持つ', () => {
    const { d, row } = setup();
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'b' });
    d.dispatch({ type: 'TOGGLE_SELECT', lid: 'a' });
    const icons = [...row()!.querySelectorAll<HTMLElement>('button[data-pkc-icon-only]')];
    expect(icons.length, '図案だけのボタンが無い(台の空振り)').toBeGreaterThanOrEqual(3);
    for (const b of icons) {
      expect(b.getAttribute('aria-label') ?? '', `${b.getAttribute('data-pkc-action')} に名前が無い`).not.toBe('');
      expect(b.title, `${b.getAttribute('data-pkc-action')} に説明が無い`).not.toBe('');
    }
  });
});

describe('「タグ ▾」で行を入れ替える', () => {
  it('🔴 開く → 欄に焦点 → 組み直しても開いたまま → 戻る → 選択が無くなれば閉じる', () => {
    const { d, inRow, q } = setup();
    d.dispatch({ type: 'TOGGLE_SELECT', lid: 'a' });
    const bulk = () => q('[data-pkc-field="filer-bulk"]')!;
    expect(bulk().hasAttribute(BULK_TAG_MODE_ATTR), '前提: 最初から開いている').toBe(false);
    inRow('[data-pkc-field="bulk-tag-toggle"]')!.click();
    expect(bulk().hasAttribute(BULK_TAG_MODE_ATTR), '開かない').toBe(true);
    expect(inRow('[data-pkc-field="bulk-tag-toggle"]')!.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement, '開いても欄に焦点が来ない').toBe(inRow('input[data-pkc-field="bulk-tag"]'));
    // 同じ選択のまま組み直す(並び順を変える)── 開いたまま
    d.dispatch({ type: 'SET_ENTRY_SORT', sort: 'title' } as never);
    expect(bulk().hasAttribute(BULK_TAG_MODE_ATTR), '同じ選択で組み直したら閉じた').toBe(true);
    inRow('[data-pkc-field="bulk-tag-back"]')!.click();
    expect(bulk().hasAttribute(BULK_TAG_MODE_ATTR), '戻るで戻らない(片道)').toBe(false);
    // 開いたまま印を足す(選び直す)── 選択操作へ戻る(ゴミ箱へ などが隠れたままにならない)
    inRow('[data-pkc-field="bulk-tag-toggle"]')!.click();
    expect(bulk().hasAttribute(BULK_TAG_MODE_ATTR)).toBe(true);
    d.dispatch({ type: 'TOGGLE_SELECT', lid: 'b' });
    expect(bulk().hasAttribute(BULK_TAG_MODE_ATTR), '選び直したのに開いたまま').toBe(false);
  });
});

describe('作る先の案内', () => {
  it('🔴 ふつうのフォルダ: 行では見えない字 + パンくずの現在地の title', async () => {
    const { d, inRow, q } = setup([meta('f1', 1, 'folder'), meta('n', 2)], [rel('r', 'f1', 'n')]);
    d.dispatch({ type: 'SET_SCOPE', lid: 'f1' });
    const where = inRow('[data-pkc-field="filer-create-target"]')!;
    expect(where.textContent).toBe('新しく作るものは「t-f1」に入ります');
    expect(where.hasAttribute(HINT_ONLY_ATTR)).toBe(true);
    const seg = q('[data-pkc-region="filer-breadcrumb"] [data-pkc-entry="f1"]')!;
    expect(seg.title).toBe('新しく作るものは「t-f1」に入ります');
  });

  it('🔴 スマートフォルダ: 「ここには作れません」は見える字で行に残す(全文は title)', () => {
    const { d, inRow, row } = setup([meta('s1', 1, 'smart'), meta('n', 2)]);
    d.dispatch({ type: 'SET_SCOPE', lid: 's1' });
    const where = inRow('[data-pkc-field="filer-create-target"]')!;
    expect(where.textContent).toBe('ここには作れません');
    expect(where.hasAttribute(HINT_ONLY_ATTR), '断りが見えない字になっている').toBe(false);
    expect(where.title).toContain('条件で集まる場所');
    expect(row()!.hidden, 'スマートフォルダなのに行が出ていない').toBe(false);
  });
});
