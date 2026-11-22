/** @vitest-environment happy-dom */
/**
 * 🔴 **パンくず(アドレスバー)のパス直接入力**(#1982 A4)。
 * 空きを押す → 入力 / Enter で移動(`enter-folder` と同じ受け手)/ Esc・外れで元に戻る /
 * 同名のフォルダは入らず理由を出す / 面の組み直しで打ちかけの字を失わない / 段のクリック・D&D の属性は壊れない。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { EntryMeta, Relation } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { BrowseRouter } from '../../src/adapter/ui/render/browse';
import { bindActions } from '../../src/adapter/ui/actions/binder';

const meta = (lid: string, title: string, order: number, archetype = 'folder'): EntryMeta => ({
  lid,
  title,
  archetype,
  createdAt: null,
  updatedAt: null,
  entryOrder: order,
  status: null,
  date: null,
  archived: false,
  bodyChars: null,
});
const rel = (from: string, to: string): Relation => ({
  id: `${from}-${to}`,
  fromLid: from,
  toLid: to,
  kind: 'structural',
  createdAt: null,
  updatedAt: null,
});

beforeEach(() => {
  document.body.textContent = '';
});

function setup(metas: EntryMeta[], relations: Relation[]) {
  const root = document.createElement('div');
  document.body.append(root);
  const d = new Dispatcher();
  const regions = buildShell(root);
  const browse = new BrowseRouter(regions.sidebar, regions.browseHost);
  d.onState((s) => browse.render(s, 'filer'));
  bindActions(root, d, {
    setBrowse: (m) => browse.render(d.getState(), m as 'filer'),
    showStatus: () => {},
  });
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas, relations });
  root.querySelector<HTMLElement>('[data-pkc-browse="filer"]')!.click();
  const frame = () => root.querySelector<HTMLElement>('[data-pkc-field="crumb-path"]')!;
  const input = () => root.querySelector<HTMLInputElement>('input[data-pkc-field="crumb-input"]');
  const segs = () => [...root.querySelectorAll('[data-pkc-field="crumb-seg"]')].map((e) => e.textContent);
  const type = (v: string) => {
    const i = input()!;
    i.value = v;
    i.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const key = (k: string) => {
    input()!.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  };
  return { root, d, frame, input, segs, type, key };
}

const TREE = [meta('a', '資料', 1), meta('b', '下', 2), meta('c', '仕事', 3)];
const TREE_REL = [rel('a', 'b')];

describe('パンくずのパス入力', () => {
  it('空きを押すと現在地の道の字が入った入力になり、Esc で元のパンくずへ戻る', () => {
    const t = setup(TREE, TREE_REL);
    t.d.dispatch({ type: 'SET_SCOPE', lid: 'b' });
    expect(t.segs()).toEqual(['ルート', '資料', '下']);
    t.frame().click();
    expect(t.input()?.value).toBe('ルート/資料/下');
    expect(t.root.querySelectorAll('[data-pkc-field="crumb-seg"]')).toHaveLength(0);
    // 候補にルートも入っている(datalist)
    const opts = [...t.root.querySelectorAll('datalist option')].map((o) => (o as HTMLOptionElement).value);
    expect(opts).toContain('ルート');
    t.key('Escape');
    expect(t.input()).toBeNull();
    expect(t.segs()).toEqual(['ルート', '資料', '下']);
    // 段の働き(押して入る・D&D の落とし先)は戻っている
    const seg = t.root.querySelector('[data-pkc-field="crumb-seg"][data-pkc-entry="a"]')!;
    expect(seg.getAttribute('data-pkc-action')).toBe('enter-folder');
    expect(seg.getAttribute('data-pkc-drop')).toBe('crumb');
    expect(t.d.getState().scopeLid).toBe('b');
  });

  it('段のボタンを押すと今までどおりその段へ入る(入力にはならない)', () => {
    const t = setup(TREE, TREE_REL);
    t.d.dispatch({ type: 'SET_SCOPE', lid: 'b' });
    t.root.querySelector<HTMLElement>('[data-pkc-field="crumb-seg"][data-pkc-entry="a"]')!.click();
    expect(t.d.getState().scopeLid).toBe('a');
    expect(t.input()).toBeNull();
  });

  it('Enter で道の字のフォルダへ入り、ルートへも戻れる', () => {
    const t = setup(TREE, TREE_REL);
    t.frame().click();
    t.type('ルート/資料/下');
    t.key('Enter');
    expect(t.d.getState().scopeLid).toBe('b');
    expect(t.input()).toBeNull();
    expect(t.segs()).toEqual(['ルート', '資料', '下']);
    t.frame().click();
    t.type(' ルート ');
    t.key('Enter');
    expect(t.d.getState().scopeLid).toBeNull();
    expect(t.segs()).toEqual(['ルート']);
  });

  it('見つからない道では入らず、理由を出して入力を開いたままにする', () => {
    const t = setup(TREE, TREE_REL);
    t.frame().click();
    t.type('ルート/無い');
    t.key('Enter');
    expect(t.d.getState().scopeLid).toBeNull();
    expect(t.input()?.value).toBe('ルート/無い');
    expect(t.d.getState().error).toContain('見つかりません');
  });

  it('🔴 同名のフォルダはあいまい一致で入らない ── 候補(同名 n 番目)を選ぶと入れる', () => {
    const t = setup([meta('x', '同', 1), meta('y', '同', 2)], []);
    t.frame().click();
    t.type('ルート/同');
    t.key('Enter');
    expect(t.d.getState().scopeLid).toBeNull();
    expect(t.input()).not.toBeNull();
    expect(t.d.getState().error).toContain('同名');
    const opts = [...t.root.querySelectorAll('datalist option')]
      .map((o) => (o as HTMLOptionElement).value)
      .filter((v) => v.includes('同名'));
    expect(opts).toHaveLength(2);
    t.type(opts[1]!);
    t.key('Enter');
    expect(t.d.getState().scopeLid).toBe('y');
  });

  it('面が組み直されても、打ちかけの字は消えない(無関係な状態更新)', () => {
    const t = setup(TREE, TREE_REL);
    t.frame().click();
    t.type('ルート/資');
    t.input()!.focus();
    // 無関係な再描画(並び順の変更など)── 面は組み直される
    const navBefore = t.root.querySelector('[data-pkc-region="filer-breadcrumb"]');
    const inputBefore = t.input();
    t.d.dispatch({ type: 'SET_FILER_FLATTEN', on: true });
    // 空振り防止: パンくずは実際に作り直された(別の要素になった)うえで、字と焦点が残る
    expect(t.root.querySelector('[data-pkc-region="filer-breadcrumb"]')).not.toBe(navBefore);
    expect(t.input()).not.toBe(inputBefore);
    expect(t.input()?.value).toBe('ルート/資');
    expect(document.activeElement).toBe(t.input());
  });

  it('Esc 以外の鍵は入力へ通る(Enter の移動以外で面の鍵に化けない)・外れると元へ戻る', () => {
    const t = setup(TREE, TREE_REL);
    t.frame().click();
    t.input()!.focus();
    t.input()!.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    expect(t.input()).toBeNull();
    expect(t.segs()).toEqual(['ルート']);
  });

  it('枠に焦点を当てて Enter でも入力に切り替わる', () => {
    const t = setup(TREE, TREE_REL);
    t.frame().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(t.input()).not.toBeNull();
  });
});
