/** @vitest-environment happy-dom */
/**
 * 🔴 **▼ で選んだ「作る種類」を、次の起動でも覚える**(C15 / #1045。
 * #1038 段 0 の落差表 N1 ── user の報告ではなく、こちらが見つけた物)。
 *
 * 守るのは 4 つ:
 * ① ▼ で選ぶと端末側に書かれる
 * ② 次の起動(shell を組み直す)でも選んだ種類のまま(select と本体が揃っている)
 * ③ 知らない値・封じられた値(いまの版で作れない種類)は既定(+ ノート)へ落ちる
 * ④ 保存が読めない / 書けない環境でも落ちない(既定へ)
 *
 * ⚠ 分割ボタンの形そのもの(P10)は動かさない ── ここは**覚える**ことだけを見る。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { createByUi } from '../helpers/create-entry';
import { CreateKindStore } from '../../src/adapter/ui/render/create-kind';
import { PORTABLE_KEYS, SKIPPED_KEYS } from '../../src/features/settings/settings-file';

const KEY = 'pkc3.create-kind';

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  document.body.textContent = '';
});

function shell(): HTMLElement {
  const root = document.createElement('div');
  document.body.append(root);
  buildShell(root);
  return root;
}

function bind(root: HTMLElement): void {
  bindActions(root, new Dispatcher());
}

const runButton = (root: HTMLElement): HTMLElement | null =>
  root.querySelector('[data-pkc-field="create-run"]');
const runLabel = (root: HTMLElement): string | null =>
  runButton(root)?.querySelector('[data-pkc-field="label"]')?.textContent ?? null;
const runArchetype = (root: HTMLElement): string | null =>
  runButton(root)?.getAttribute('data-pkc-archetype') ?? null;
const kindSelectValue = (root: HTMLElement): string | null =>
  root.querySelector<HTMLSelectElement>('[data-pkc-field="create-kind"]')?.value ?? null;

describe('既定(保存が無ければ)', () => {
  it('「+ ノート」(いまの既定と同じ)', () => {
    const root = shell();
    expect(runLabel(root)).toBe('+ ノート');
    expect(runArchetype(root)).toBe('text');
    expect(kindSelectValue(root), 'select と本体が食い違っている').toBe('text');
  });
});

describe('選ぶと端末側に書かれ、次の起動でも戻る', () => {
  it('🔴 ▼ で選ぶと localStorage に書かれる', () => {
    const root = shell();
    bind(root);
    createByUi(root, 'textlog');
    expect(localStorage.getItem(KEY), '選んだ種類が書かれていない').toBe('textlog');
  });

  it('🔴 次に起動しても(shell を組み直しても)選んだ種類のまま', () => {
    const first = shell();
    bind(first);
    createByUi(first, 'textlog');

    // 別の起動(器ごと作り直す ── main.ts が boot 直後に buildShell を呼ぶのと同じ形)
    document.body.textContent = '';
    const second = shell();
    expect(runLabel(second), '選んだ種類が次の起動で戻っていない').toBe('+ ログ');
    expect(runArchetype(second)).toBe('textlog');
    // ⚠ `pick-create-kind` と同じ理屈(shell.ts のコメント)── select と本体が
    //   食い違うと「押した種類と出来るものが別」になる
    expect(kindSelectValue(second), 'select と本体が食い違っている').toBe('textlog');
  });
});

describe('知らない値・封じられた値は既定(+ ノート)へ落ちる', () => {
  it('版に無い値(知らない archetype)', () => {
    localStorage.setItem(KEY, 'kaboom');
    const root = shell();
    expect(runLabel(root)).toBe('+ ノート');
    expect(runArchetype(root)).toBe('text');
    expect(kindSelectValue(root)).toBe('text');
  });

  it('封印中(SEALED_ARCHETYPES)の値 ── 版が変わって封じられた場合を想定', () => {
    // ⚠ UI からは選べない値(封印中は一覧にも select にも出ない)なので、
    //   直接 localStorage へ古い値を置いて「版違いで封じられた」を再現する
    localStorage.setItem(KEY, 'todo');
    const root = shell();
    expect(runLabel(root), '封印中の種類がそのまま出ている').toBe('+ ノート');
    expect(runArchetype(root)).toBe('text');
    expect(kindSelectValue(root)).toBe('text');
  });
});

describe('保存が読めない / 書けない環境でも落ちない', () => {
  it('🔴 getItem が例外を投げても既定(+ ノート)で組み立てが落ちない', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('私用モード');
    });
    let root: HTMLElement | undefined;
    expect(() => {
      root = shell();
    }, 'buildShell が落ちた').not.toThrow();
    expect(runLabel(root!)).toBe('+ ノート');
  });

  it('setItem が例外を投げても、選ぶ操作そのものは落ちない', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('いっぱいです');
    });
    const root = shell();
    bind(root);
    expect(() => createByUi(root, 'textlog'), '選ぶ操作で落ちた').not.toThrow();
    // 押した見た目は、この session の控え(fallback)で効く
    expect(runLabel(root)).toBe('+ ログ');
  });
});

describe('CreateKindStore(単体)', () => {
  it('壊れた値(長すぎ)は既定(null)へ落ちる', () => {
    localStorage.setItem(KEY, 'x'.repeat(300));
    expect(new CreateKindStore().get()).toBeNull();
  });

  it('null を書くと消える(空文字で「空という選択」を作らない)', () => {
    localStorage.setItem(KEY, 'textlog');
    new CreateKindStore().set(null);
    expect(localStorage.getItem(KEY)).toBeNull();
  });
});

describe('設定の持ち出し(#414)からは外れている', () => {
  it('🔴 SKIPPED_KEYS に理由つきで在り、PORTABLE_KEYS には無い', () => {
    expect(SKIPPED_KEYS.some((s) => s.key === KEY), 'SKIPPED_KEYS に無い').toBe(true);
    expect(PORTABLE_KEYS.some((p) => p.key === KEY), 'PORTABLE_KEYS に紛れている').toBe(false);
  });
});

/**
 * 🔴 **種類を選び直しても、絵の色は「作る」のまま**(#1054 段①-2 の着地前レビュー)。
 *
 * ⚠ 直す前は `pick-create-kind` が `setIcon` を直に呼び、**絵の既定 tone**
 *   (種類の絵は全部 `kind` = 無彩色)を書いていた ── 起動直後は緑なのに、
 *   ▼ で種類を 1 度選ぶと黙って色が消えた(起動の経路 `iconButton` と
 *   切り替えの経路が別々に tone を決めていた)。
 * 🔑 対照群を同じ it に置く:起動直後(切り替え前)も `create` であること ──
 *   置かないと「最初から緑でなかった」と区別できない。
 */
describe('種類を選び直しても、絵の色は変わらない', () => {
  const runTone = (root: HTMLElement): string | null =>
    runButton(root)?.querySelector('[data-pkc-icon]')?.getAttribute('data-pkc-tone') ?? null;

  it('🔴 起動直後も、▼ で別の種類を選んだ後も data-pkc-tone は create', () => {
    const root = shell();
    bind(root);
    expect(runTone(root), '起動直後から「作る」の色になっていない(前提が崩れている)').toBe(
      'create',
    );
    for (const archetype of ['folder', 'textlog', 'text']) {
      createByUi(root, archetype);
      expect(runArchetype(root), `${archetype} を選べていない(前提が崩れている)`).toBe(archetype);
      expect(runTone(root), `${archetype} を選んだら「作る」の色が消えた`).toBe('create');
    }
  });
});

/**
 * 🔴 **▼ は「作る」の合成メニュー**(#1054 段②)── 見出し + 種類 + 区切り +
 * 今日を開く + 区切り + 道具、という 1 つの並びになる。
 */
describe('▼ の合成メニュー(#1054 段②)', () => {
  function menuOf(root: HTMLElement): HTMLElement {
    return root.querySelector('[data-pkc-region="create-menu"]')!;
  }

  it('🔴 並びは 見出し → 種類 6 つ → 区切り → 今日 → 区切り → 道具 4 つ', () => {
    const root = shell();
    const menu = menuOf(root);
    const kids = [...menu.children];
    const shapeOf = (el: Element): string =>
      el.tagName === 'BUTTON' ? `button:${el.getAttribute('data-pkc-action')}` : 'field:' + el.getAttribute('data-pkc-field');
    expect(kids.map(shapeOf)).toEqual([
      'field:create-menu-heading',
      'button:pick-create-kind',
      'button:pick-create-kind',
      'button:pick-create-kind',
      'button:pick-create-kind',
      'button:pick-create-kind',
      'button:pick-create-kind',
      'field:create-menu-separator',
      'button:open-today',
      'field:create-menu-separator',
      'button:attach-file',
      'button:start-audio-capture',
      'button:start-screen-capture',
      'button:start-timer',
    ]);
    // 🔑 見出し・区切りはボタンを持たない(数える検査が拾わない)
    expect(menu.querySelector('[data-pkc-field="create-menu-heading"]')?.tagName).not.toBe(
      'BUTTON',
    );
    // 🔑 道具は「その場で動く」名前(タイルと違う ── #716 の既知の対)
    expect(
      menu.querySelector('[data-pkc-action="open-today"]')?.textContent,
    ).toBe('今日のノートを開く');
    expect(menu.querySelector('[data-pkc-action="attach-file"]')?.textContent).toBe('添付する');
  });

  it('🔴 種類を選ぶと、その場でちょうど 1 件だけ出来る', () => {
    const root = shell();
    const d = new Dispatcher();
    bindActions(root, d);
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [], relations: [] });
    const before = d.getState().entryMetas.size;
    createByUi(root, 'textlog');
    expect(d.getState().entryMetas.size, '選んだのに 1 件出来ていない').toBe(before + 1);
  });

  it('🔴 ArrowDown/ArrowUp/Home/End で焦点が動き、折り返す', () => {
    const root = shell();
    document.body.append(root);
    bindActions(root, new Dispatcher());
    root.querySelector<HTMLElement>('[data-pkc-field="create-pick"]')!.click();
    const items = [...menuOf(root).querySelectorAll<HTMLButtonElement>('button')];
    expect(items.length, '前提が崩れている').toBeGreaterThan(3);
    items[0]!.focus();
    // ⚠ 実物は「焦点の在る要素」から `keydown` が上がる ── `root` へ直接撃つと
    //   `ev.target` が `root` になり、`menu.contains(target)` が常に偽になる
    const fire = (key: string): void => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
      );
    };
    fire('ArrowDown');
    expect(document.activeElement, 'ArrowDown で次に移らない').toBe(items[1]);
    fire('ArrowUp');
    expect(document.activeElement, 'ArrowUp で前に戻らない').toBe(items[0]);
    fire('ArrowUp');
    expect(document.activeElement, '先頭で ArrowUp が末尾へ折り返さない').toBe(
      items[items.length - 1],
    );
    fire('Home');
    expect(document.activeElement, 'Home が先頭へ飛ばない').toBe(items[0]);
    fire('End');
    expect(document.activeElement, 'End が末尾へ飛ばない').toBe(items[items.length - 1]);
  });

  it('🔴 Escape で閉じ、▼ へ焦点を返す', () => {
    const root = shell();
    document.body.append(root);
    bindActions(root, new Dispatcher());
    const pick = root.querySelector<HTMLElement>('[data-pkc-field="create-pick"]')!;
    pick.click();
    const menu = menuOf(root);
    expect(menu.hidden, '前提が崩れている(開いていない)').toBe(false);
    const first = menu.querySelector<HTMLButtonElement>('button')!;
    first.focus();
    first.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    expect(menu.hidden, 'Escape で閉じない').toBe(true);
    expect(document.activeElement, '焦点が ▼ へ戻らない').toBe(pick);
  });

  it('🔴 メニューの外を押すと閉じる(▼ 自身の押しでは閉じ判定を二重にしない)', () => {
    const root = shell();
    document.body.append(root);
    bindActions(root, new Dispatcher());
    const pick = root.querySelector<HTMLElement>('[data-pkc-field="create-pick"]')!;
    pick.click();
    const menu = menuOf(root);
    expect(menu.hidden).toBe(false);
    root.querySelector<HTMLElement>('[data-pkc-region="collection-bar"]')!.click();
    expect(menu.hidden, '外を押しても閉じない').toBe(true);
  });
});
