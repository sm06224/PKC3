/** @vitest-environment happy-dom */
/**
 * 🔴 **パンくず(アドレスバー)のパス直接入力**(#1982 A4)。
 * 空きを押す → 入力 / Enter で移動(`enter-folder` と同じ受け手)/ Esc・外れで元に戻る /
 * 同名のフォルダは入らず理由を出す / 面の組み直しで打ちかけの字を失わない / 段のクリック・D&D の属性は壊れない。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EntryMeta, Relation } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { BrowseRouter } from '../../src/adapter/ui/render/browse';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { openCrumbInput } from '../../src/adapter/ui/render/crumb-path-input';

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
afterEach(() => {
  vi.restoreAllMocks();
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

const down = (el: Element): MouseEvent => {
  const ev = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
  el.dispatchEvent(ev);
  return ev;
};
const enterKey = (i: HTMLInputElement, init: KeyboardEventInit = {}) =>
  i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...init }));

describe('パンくずのパス入力 ── レビュー指摘の修正', () => {
  it('1: 段のボタンの上で押して枠の余白で離しても(click は枠に落ちる)入力は開かない。空きで押して空きで離すと開く', () => {
    const t = setup(TREE, TREE_REL);
    t.d.dispatch({ type: 'SET_SCOPE', lid: 'b' });
    const seg = t.root.querySelector<HTMLElement>('[data-pkc-field="crumb-seg"][data-pkc-entry="a"]')!;
    down(seg);
    t.frame().click(); // 押したのはボタン・離したのは余白 → 共通の祖先の枠へ落ちる
    expect(t.input()).toBeNull();
    expect(t.d.getState().scopeLid).toBe('b');
    // 区切りの › で押して枠で離す → 空きどうしなので開く
    down(t.root.querySelector('[data-pkc-field="crumb-sep"]')!);
    t.frame().click();
    expect(t.input()).not.toBeNull();
  });

  it('1: 枠内の字をドラッグで選んで離した(選択範囲が残っている)ときは開かない。選択が無ければ開く', () => {
    const t = setup(TREE, TREE_REL);
    t.d.dispatch({ type: 'SET_SCOPE', lid: 'b' });
    const seg = t.root.querySelector('[data-pkc-field="crumb-seg"]')!;
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    const range = document.createRange();
    range.selectNodeContents(seg);
    sel.addRange(range);
    expect(sel.isCollapsed).toBe(false); // 空振り防止: 選択は実際に残っている
    down(t.frame());
    t.frame().click();
    expect(t.input()).toBeNull();
    sel.removeAllRanges();
    down(t.frame());
    t.frame().click();
    expect(t.input()).not.toBeNull();
  });

  it('2: 初期値(現在地)のまま Enter は閉じるだけ ── 選択は変わらず、中央ペインは切り替わらず、焦点は枠へ戻る', () => {
    const t = setup(TREE, TREE_REL);
    t.d.dispatch({ type: 'SET_SCOPE', lid: 'a' });
    t.d.dispatch({ type: 'SELECT_ENTRY', lid: 'b' });
    expect(t.d.getState().selectedLid).toBe('b');
    expect(t.d.getState().scopeLid).toBe('a');
    t.frame().click();
    expect(t.input()?.value).toBe('ルート/資料');
    t.key('Enter');
    expect(t.input()).toBeNull();
    expect(t.d.getState().scopeLid).toBe('a');
    expect(t.d.getState().selectedLid).toBe('b');
    expect(document.activeElement).toBe(t.frame());
  });

  it('2: 空欄の Enter は何もしない(ルートへ飛ばない・入力は開いたまま)。移動できたときも焦点は枠へ戻る', () => {
    const t = setup(TREE, TREE_REL);
    t.d.dispatch({ type: 'SET_SCOPE', lid: 'b' });
    t.frame().click();
    t.type('');
    t.key('Enter');
    expect(t.d.getState().scopeLid).toBe('b');
    expect(t.input()).not.toBeNull();
    t.type(' / ');
    t.key('Enter');
    expect(t.d.getState().scopeLid).toBe('b');
    expect(t.input()).not.toBeNull();
    t.type('ルート/仕事');
    t.key('Enter');
    expect(t.d.getState().scopeLid).toBe('c');
    expect(document.activeElement).toBe(t.frame());
  });

  it('4: 入力中に枠の余白を押しても焦点を奪わせず(blur しない)、続く click で開き直さない ── 打ちかけの字が残る', () => {
    const t = setup(TREE, TREE_REL);
    t.frame().click();
    t.type('ルート/資');
    t.input()!.focus();
    t.input()!.setSelectionRange(5, 5); // 打ちかけの続きに caret がある(開き直すと全選択になり、次の字で置き換わる)
    const before = t.input();
    const ev = down(t.frame());
    expect(ev.defaultPrevented).toBe(true); // 焦点を奪わせない
    t.frame().click();
    expect(t.input()).toBe(before);
    expect(t.input()?.value).toBe('ルート/資');
    expect([t.input()!.selectionStart, t.input()!.selectionEnd]).toEqual([5, 5]);
    expect(document.activeElement).toBe(t.input());
  });

  it('4: ウィンドウ自体が非アクティブになった focusout では閉じない(戻ると打ちかけが残る)。アクティブなままの外れは閉じる', () => {
    const t = setup(TREE, TREE_REL);
    t.frame().click();
    t.type('ルート/資');
    const has = vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    t.input()!.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: null }));
    expect(t.input()?.value).toBe('ルート/資');
    has.mockReturnValue(true);
    t.input()!.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    expect(t.input()).toBeNull();
  });

  it('5: 枠に role と aria-label が付く', () => {
    const t = setup(TREE, TREE_REL);
    expect(t.frame().getAttribute('role')).toBe('group');
    expect(t.frame().getAttribute('aria-label')).toBe('パンくず。押すとパスを入力できます');
  });

  it('6 M1: IME 変換中の Enter(isComposing / keyCode 229)では移動も失敗表示もしない', () => {
    const t = setup(TREE, TREE_REL);
    t.frame().click();
    t.type('ルート/仕事');
    enterKey(t.input()!, { isComposing: true });
    enterKey(t.input()!, { keyCode: 229 });
    expect(t.d.getState().scopeLid).toBeNull();
    expect(t.input()?.value).toBe('ルート/仕事');
    // 空振り防止: 変換中でなければ同じ入力で移動する
    enterKey(t.input()!);
    expect(t.d.getState().scopeLid).toBe('c');
  });

  it('6 M2/M4: 入力中に別の操作で filer が描き直されても、打ちかけの字と焦点が残る(古い入力の focusout にも閉じられない)', () => {
    const t = setup(TREE, TREE_REL);
    t.frame().click();
    t.type('ルート/資');
    const old = t.input()!;
    old.focus();
    // 描き直しの最中に focusout が root へ届く経路を再現する: 捕まえる段(root の capture)で再描画を起こす ──
    // 経路は発火時点で決まっているので、古い入力(外れた節点)の focusout が bubble で root の受け手へ届く
    const rerender = () => t.d.dispatch({ type: 'SET_FILER_FLATTEN', on: true });
    t.root.addEventListener('focusout', rerender, { capture: true, once: true });
    old.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    expect(old.isConnected).toBe(false); // 空振り防止: 実際に描き直されて古い入力は外れた
    expect(t.input()).not.toBe(old);
    expect(t.input()?.value).toBe('ルート/資');
    expect(document.activeElement).toBe(t.input());
    // 描き直しをもう 1 回(焦点を持ったままの再描画 = filer の焦点の戻しが奪い返さない)
    t.d.dispatch({ type: 'SET_FILER_FLATTEN', on: false });
    expect(t.input()?.value).toBe('ルート/資');
    expect(document.activeElement).toBe(t.input());
  });

  it('8: 候補一覧の id は枠ごとに一意(2 つ出しても重複しない)', () => {
    const mk = () => {
      const f = document.createElement('span');
      document.body.append(f);
      return openCrumbInput(f, { entryMetas: new Map(), relations: [], scopeLid: null });
    };
    const a = mk();
    const b = mk();
    expect(a.getAttribute('list')).not.toBe(b.getAttribute('list'));
    expect(a.parentElement!.querySelector('datalist')!.id).toBe(a.getAttribute('list'));
    expect(b.parentElement!.querySelector('datalist')!.id).toBe(b.getAttribute('list'));
  });
});

