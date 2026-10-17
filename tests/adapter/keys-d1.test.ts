/** @vitest-environment happy-dom */
/**
 * 🔴 **キーの直し(台帳 #1852 束 D1 / #1163 の依頼 74-3・96・117・132・153・180・181・183・185・313)**。
 *
 * 守るもの(各 it の題が 1 つずつ主張):
 * - 180 文字を打っている間の `Alt+←/→` はノートの戻る / 進むにならない(mac は既定の動きに任せる)
 * - 181 mac では `⌘` だけが `Mod`(`Ctrl` は OS 標準へ返す)
 * - 183 `F12` はフラグの既定から外れた
 * - 185 探す欄で字が無いときの `Esc` は欄から出る(字が在るときは消すだけ)
 * - 132 `Ctrl+Z` がフォルダの表の行で「ゴミ箱へ移した直後の元に戻す」に当たる(本文の編集の `Ctrl+Z` とは別の場面)
 * - 313 / 117-3 割り当てを断る(ブラウザが先に取るキー / 文字を打つ欄の編集キー)
 * - 153 ノートの並べ替えを鍵と「操作を探す」から呼べる(既定のキーは置かない)
 *
 * ⚠ 守っていない物:実ブラウザでの `Alt+←` の挙動(mac の Option+← の単語移動)。happy-dom は既定の動きを持たないので、
 *   「`preventDefault` しない」までを見る。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { BrowseRouter } from '../../src/adapter/ui/render/browse';
import { bindActions, runGlobalCommand } from '../../src/adapter/ui/actions/binder';
import { KeymapStore } from '../../src/adapter/ui/render/keymap';
import { resetAppDialogForTest } from '../../src/adapter/ui/render/app-dialog';
import {
  KEY_COMMANDS,
  REFUSED,
  chordOf,
  findCommand,
  matchCommand,
  resolveUsableBindings,
  validateBinding,
  defaultBindings,
} from '../../src/features/keymap';

function meta(lid: string, order: number): EntryMeta {
  return {
    lid,
    title: 't-' + lid,
    archetype: 'text',
    createdAt: null,
    updatedAt: null,
    entryOrder: order,
    status: null,
    date: null,
    archived: false,
    bodyChars: null,
  };
}

function mounted() {
  const root = document.createElement('div');
  root.setAttribute('data-pkc-slot', 'root');
  document.body.append(root);
  const d = new Dispatcher();
  const regions = buildShell(root);
  const browse = new BrowseRouter(regions.sidebar, regions.browseHost);
  d.onState((s) => browse.render(s, 'filer'));
  const said: string[] = [];
  bindActions(root, d, { showStatus: (t) => void said.push(t) });
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('n1', 1), meta('n2', 2)], relations: [] });
  d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
  d.dispatch({ type: 'SELECT_ENTRY', lid: 'n2' });
  return { root, d, said };
}

function fire(target: EventTarget, init: KeyboardEventInit): KeyboardEvent {
  const ev = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(ev);
  return ev;
}

beforeEach(() => {
  document.body.textContent = '';
  resetAppDialogForTest();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('180: 文字を打っている間の Alt+← / Alt+→', () => {
  it('🔴 欄に打っている間は、ノートを戻らない。対照群:欄の外では戻る', () => {
    const { root, d } = mounted();
    // ⚠ 探す欄(entry-filter)は自分の鍵処理が先に受けて他へ流さないので、本文の欄と同じ「構造で打つ欄」の textarea を使う
    const field = document.createElement('textarea');
    root.append(field);
    field.focus();
    fire(field, { key: 'ArrowLeft', code: 'ArrowLeft', altKey: true });
    expect(d.getState().selectedLid, '打っている間に Alt+← でノートが戻った').toBe('n2');
    fire(field, { key: 'ArrowRight', code: 'ArrowRight', altKey: true });
    expect(d.getState().selectedLid).toBe('n2');
    // 対照群(空振り防止): 欄の外なら同じキーで戻る
    fire(document, { key: 'ArrowLeft', code: 'ArrowLeft', altKey: true });
    expect(d.getState().selectedLid, '対照群: 欄の外で Alt+← が効かない').toBe('n1');
  });

  it('🔴 mac では既定の動き(単語ごとのカーソル移動)を止めない。mac 以外はブラウザの「戻る」で画面を離れないよう止める', () => {
    const { root } = mounted();
    const field = document.createElement('textarea');
    root.append(field);
    field.focus();
    const nav = vi.spyOn(navigator, 'platform', 'get');
    nav.mockReturnValue('MacIntel');
    expect(fire(field, { key: 'ArrowLeft', code: 'ArrowLeft', altKey: true }).defaultPrevented, 'mac で止めている').toBe(false);
    nav.mockReturnValue('Win32');
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Windows NT 10.0; Win64; x64)');
    expect(fire(field, { key: 'ArrowLeft', code: 'ArrowLeft', altKey: true }).defaultPrevented, 'mac 以外で止めていない').toBe(true);
  });
});

describe('181: mac の Ctrl は Mod にしない', () => {
  const ev = (over: Partial<KeyboardEvent>) =>
    ({ key: 'b', code: 'KeyB', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...over }) as KeyboardEvent;

  it('🔴 mac: ⌘ だけが Mod。Ctrl+B は Mod ではない(= 太字に当たらない)', () => {
    expect(chordOf(ev({ metaKey: true }), true)?.mod).toBe(true);
    expect(chordOf(ev({ ctrlKey: true }), true)?.mod, 'mac の Ctrl が Mod になっている').toBe(false);
    expect(matchCommand(chordOf(ev({ ctrlKey: true }), true), 'editor', defaultBindings())).toBeNull();
    expect(matchCommand(chordOf(ev({ metaKey: true }), true), 'editor', defaultBindings()), '対照群: ⌘+B が太字に当たらない').not.toBeNull();
  });

  it('🔴 mac 以外: Ctrl も ⌘ も Mod(これまでどおり)', () => {
    expect(chordOf(ev({ ctrlKey: true }), false)?.mod).toBe(true);
    expect(chordOf(ev({ metaKey: true }), false)?.mod).toBe(true);
  });
});

describe('183: F12 は開発者ツールに返す', () => {
  it('🔴 フラグの既定は Alt+4 だけ。F12 はどの操作にも当たらない', () => {
    expect(findCommand('open-flags')!.defaults).toEqual(['Alt+4']);
    for (const c of KEY_COMMANDS) expect(c.defaults, `${c.id} が F12 を持っている`).not.toContain('F12');
  });
});

describe('185: 探す欄の Esc', () => {
  it('🔴 字が在れば消すだけ(欄に居続ける)/ 字が無ければ欄から出る', () => {
    const { root, d } = mounted();
    const field = root.querySelector<HTMLInputElement>('[data-pkc-field="entry-filter"]')!;
    field.focus();
    field.value = 'abc';
    fire(field, { key: 'Escape', code: 'Escape' });
    expect(field.value, '字が消えていない').toBe('');
    expect(document.activeElement, '字を消しただけなのに欄から出た').toBe(field);
    expect(d.getState().selectedLid, 'Esc でノートまで閉じた').toBe('n2');
    const ev = fire(field, { key: 'Escape', code: 'Escape' });
    expect(document.activeElement, '字が無いのに欄から出ない').not.toBe(field);
    expect(ev.defaultPrevented).toBe(true);
    expect(d.getState().selectedLid, '欄から出るだけのはずがノートまで閉じた').toBe('n2');
  });
});

describe('132: フォルダの表の Ctrl+Z = ゴミ箱へ移した直後の元に戻す', () => {
  it('🔴 既定の割り当て: フォルダの表と 2 ペインで当たり、本文の編集・全域には当たらない', () => {
    const b = defaultBindings();
    const z = chordOf({ key: 'z', code: 'KeyZ', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false }, false);
    expect(matchCommand(z, 'filer', b)).toBe('undo-trash');
    expect(matchCommand(z, 'dual', b)).toBe('undo-trash');
    expect(matchCommand(z, 'global', b), '全域に当たっている(1 画面の取り消しを奪う)').toBeNull();
    expect(matchCommand(z, 'live', b), '対照群: 1 画面の「取り消す」が Ctrl+Z でなくなった').toBe('undo');
  });

  it('🔴 行に焦点があるとき Ctrl+Z を押すと「元に戻す」が受ける(戻せる物が無ければ黙らず言う)。行の外では何も起きない', () => {
    const { root, said } = mounted();
    const pane = root.querySelector<HTMLElement>('[data-pkc-browse-pane="filer"]');
    root.querySelector<HTMLElement>('[data-pkc-browse="filer"]')?.click();
    const row = pane?.querySelector<HTMLElement>('[data-pkc-entry="n1"]') ?? null;
    expect(row, '前提: 行が描かれていない').not.toBeNull();
    // 対照群: 行の外(地)
    fire(root, { key: 'z', code: 'KeyZ', ctrlKey: true });
    expect(said, '行の外の Ctrl+Z に反応した').toEqual([]);
    row!.focus();
    const ev = fire(row!, { key: 'z', code: 'KeyZ', ctrlKey: true });
    expect(said.join('\n')).toContain('戻せるものがありません');
    expect(ev.defaultPrevented).toBe(true);
  });
});

describe('313 / 117-3: 割り当てを断る', () => {
  it('🔴 ブラウザやパソコンが先に取るキーは断る(「ノートを作る」の既定 Ctrl+N は断らない)', () => {
    for (const k of ['Mod+Shift+N', 'Mod+Shift+T', 'Mod+Shift+W', 'Mod+Shift+Q', 'Mod+Tab', 'Mod+Shift+Tab', 'Mod+PageUp', 'Mod+PageDown', 'Alt+F4']) {
      expect(REFUSED, `${k} が REFUSED に無い`).toContain(k);
      expect(validateBinding('add-tag', k, {})?.kind, `${k} を断っていない`).toBe('refused');
    }
    // 対照群: 届くキーは断らない / 自分の既定は断らない
    expect(validateBinding('add-tag', 'Alt+Shift+Y', {})).toBeNull();
    expect(REFUSED).not.toContain('Mod+N');
    expect(validateBinding('create-entry', 'Mod+N', {})).toBeNull();
  });

  it('🔴 文字を打つ欄の編集キーは、打つ欄で効く操作には割り当てられない(表の操作・自分の既定は別)', () => {
    for (const k of ['Mod+Backspace', 'Mod+ArrowLeft', 'Alt+Delete', 'Mod+Home', 'Mod+End', 'Alt+ArrowUp']) {
      const p = validateBinding('inline-calc', k, {});
      expect(p?.kind, `${k} を断っていない`).toBe('refused');
      expect(p?.message).toContain('文字を打つ欄の編集に使うキー');
    }
    // 打っている間も効く全域の操作も同じ
    expect(validateBinding('insert-date', 'Mod+Backspace', {})?.kind).toBe('refused');
    // 対照群: 打つ欄で効かない操作(フォルダの表)には割り当てられる / 欄の編集キーでない組は通る
    expect(validateBinding('filer-rename', 'Mod+Backspace', {})).toBeNull();
    expect(validateBinding('inline-calc', 'Mod+Alt+K', {})).toBeNull();
    // 自分の既定は断らない(1 画面の行の入れ替えの Alt+↑)
    const own = KEY_COMMANDS.find((c) => c.contexts.includes('row') && c.defaults.includes('Alt+ArrowUp'));
    expect(own, '前提: Alt+↑ を既定に持つ行の操作が無い').toBeDefined();
    expect(validateBinding(own!.id, 'Alt+ArrowUp', {})).toBeNull();
  });

  it('🔴 割り当て済みの人の割り当ては、後から「使えない」にしない(欄の編集キーの断りは新しく割り当てるときだけ)', () => {
    const { bindings, unusable } = resolveUsableBindings({ 'inline-calc': ['Mod+Backspace'] });
    expect(unusable.map((u) => u.chord), '保存してあった Ctrl+Backspace が使えない扱いになった').not.toContain('Mod+Backspace');
    expect(bindings['inline-calc']).toContain('Mod+Backspace');
    // 対照群: 新しく割り当てるときは断る
    expect(validateBinding('inline-calc', 'Mod+Backspace', {})?.kind).toBe('refused');
  });
});

describe('153: ノートの並べ替えを鍵と「操作を探す」から呼べる', () => {
  it('🔴 命令が表に在り、既定のキーは置かない(Alt+↑/↓ は本文の行の入れ替え)', () => {
    for (const id of ['move-order-up', 'move-order-down']) {
      const c = findCommand(id);
      expect(c, `${id} が表に無い`).not.toBeNull();
      expect(c!.defaults).toEqual([]);
    }
  });

  it('🔴 呼ぶと帯の押しボタンと同じに動く(隣と入れ替わる)。端では押せないと答える', () => {
    const { root, d } = mounted();
    root.querySelector<HTMLElement>('[data-pkc-browse="filer"]')?.click();
    const run = (id: string, dry: boolean): boolean =>
      runGlobalCommand(id, root, d, new KeymapStore(null), () => undefined, () => undefined, dry);
    const order = (): string[] =>
      [...d.getState().entryMetas.values()].sort((a, b) => a.entryOrder - b.entryOrder).map((m) => m.lid);
    expect(order(), '前提: 並びが n1, n2 でない').toEqual(['n1', 'n2']);
    expect(d.getState().entrySort, '前提: 自分で並べた順でない').toBe('manual');
    // n2(末尾)を選んでいる: 上へは動ける / 下へは動けない
    expect(run('move-order-up', true)).toBe(true);
    expect(run('move-order-down', true), '末尾なのに下へ動けると答えた').toBe(false);
    expect(order(), 'dry で動いてしまった').toEqual(['n1', 'n2']);
    expect(run('move-order-up', false)).toBe(true);
    expect(order(), '上へ動かしても並びが変わらない').toEqual(['n2', 'n1']);
    // 先頭になったので、もう上へは動けない
    expect(run('move-order-up', true)).toBe(false);
  });
});
