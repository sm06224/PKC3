/** @vitest-environment happy-dom */
/**
 * 🔴 **別のウィンドウで開いた面は、左の一覧・右の情報・左端のバーを畳んで始める**(#1442 段①)。
 *
 * 守るもの:
 * - 判断は `panesHiddenFor` の 1 か所(面の窓 = 3 つ / ふつうの本文・付箋・本体 = 畳まない)
 * - 畳みは**その窓の session だけ** ── 本体の窓の `pkc3.panes` へ 1 byte も書かない(書込を数える)
 * - 窓の中で戻せる(列の帯 / バーの帯)。戻しても記録へ書かない
 * - スマホ幅では何も畳まれない(列が無い)
 *
 * ⚠ `appPanes`(module 共有)は `sessionOnly` で戻せなくなる ── このファイルは 1 つの窓の一生を
 *   上から順に追う(別ファイルなら別の module なので他の test を汚さない)。
 */
import { describe, expect, it } from 'vitest';
import { nextWindowCollapse, panesHiddenFor } from '../../src/adapter/platform/deep-link';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import {
  PaneVisibilityStore,
  appPanes,
  applyPaneVisibility,
} from '../../src/adapter/ui/render/pane-visibility';
import { buildShell } from '../../src/adapter/ui/render/shell';

const KEY = 'pkc3.panes';

function memStorage(seed: string | null) {
  const m = new Map<string, string>();
  if (seed !== null) m.set(KEY, seed);
  const writes: string[] = [];
  const store: Pick<Storage, 'getItem' | 'setItem'> = {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => {
      m.set(k, v);
      writes.push(v);
    },
  };
  return { store, writes };
}

describe('panesHiddenFor(判断の 1 か所)', () => {
  it('🔴 面の窓は 3 つとも畳む', () => {
    for (const v of ['schedule', 'query', 'dual'] as const) {
      expect([...panesHiddenFor(v, false, true)].sort(), v).toEqual(['inspector', 'rail', 'sidebar']);
    }
  });
  it('ふつうの本文(detail)・付箋・本体の窓(null)は畳まない', () => {
    expect(panesHiddenFor('detail', false, true)).toEqual([]);
    expect(panesHiddenFor('schedule', true, true), '付箋は従来どおり').toEqual([]);
    expect(panesHiddenFor(null, false, true)).toEqual([]);
    expect(panesHiddenFor('schedule', false, false), '写した URL のふつうのタブは畳まない').toEqual([]);
  });
});

describe('nextWindowCollapse(当てる / 戻す / 1 回だけ ── onHold の判断)', () => {
  it('🔴 PKC が開いた窓で面を開くと畳む(1 回だけ ── applied が立つ)', () => {
    const r = nextWindowCollapse(false, 'schedule', false, true);
    expect(r.step).toEqual({ kind: 'collapse', panes: ['sidebar', 'inspector', 'rail'] });
    expect(r.applied).toBe(true);
  });
  it('🔴 面から面へ移っても畳み直さない(user が戻した物を奪い返さない)', () => {
    const r = nextWindowCollapse(true, 'query', false, true);
    expect(r.step).toEqual({ kind: 'none' });
    expect(r.applied).toBe(true);
  });
  it('🔴 面を離れたら戻す(applied を倒す)。もう一度面へ入れば畳む', () => {
    const r = nextWindowCollapse(true, null, false, true);
    expect(r.step).toEqual({ kind: 'release' });
    expect(r.applied).toBe(false);
    expect(nextWindowCollapse(false, 'schedule', false, true).step.kind).toBe('collapse');
  });
  it('🔴 PKC が開いていない窓(写した URL のタブ)は畳まず、applied も立てない', () => {
    const r = nextWindowCollapse(false, 'schedule', false, false);
    expect(r.step).toEqual({ kind: 'none' });
    expect(r.applied).toBe(false);
    expect(nextWindowCollapse(false, null, false, false).step.kind, '何も畳んでいないのに戻さない').toBe('none');
  });
});

describe('PaneVisibilityStore.sessionOnly(collapse)', () => {
  it('🔴 畳んで始めても、端末の記録へは 1 byte も書かない(戻す操作も)', () => {
    const { store, writes } = memStorage('append');
    const s = new PaneVisibilityStore(store);
    const hidden = s.sessionOnly(null, ['sidebar', 'inspector', 'rail']);
    expect(hidden).toEqual(['sidebar', 'inspector', 'append']);
    expect(s.isRailHidden()).toBe(true);
    expect(s.hasRailToggle()).toBe(true);
    s.toggle('sidebar'); // 窓の中で戻す
    expect(s.getHidden()).toEqual(['inspector', 'append']);
    expect(s.toggleRail()).toBe(true);
    expect(s.isRailHidden(), 'バーを戻せない').toBe(false);
    expect(writes, '本体の窓の記録へ書いた').toEqual([]);
  });
  it('🔴 本体の窓(sessionOnly を通っていない)ではバーを畳めない', () => {
    const { store, writes } = memStorage(null);
    const s = new PaneVisibilityStore(store);
    expect(s.toggleRail()).toBe(false);
    expect(s.isRailHidden()).toBe(false);
    expect(s.hasRailToggle()).toBe(false);
    expect(writes).toEqual([]);
  });
  it('🔴 面を離れたら、窓のために畳んだ物だけ戻す(user が元から畳んでいた物は残す)', () => {
    const s = new PaneVisibilityStore(memStorage('inspector append').store);
    s.sessionOnly(null, ['sidebar', 'inspector', 'rail']);
    expect(s.getHidden()).toEqual(['sidebar', 'inspector', 'append']);
    expect(s.releaseWindowCollapse()).toEqual(['inspector', 'append']);
    expect(s.isRailHidden()).toBe(false);
    expect(s.hasRailToggle()).toBe(false);
    expect(s.releaseWindowCollapse(), '2 回目は何もしない').toBeNull();
  });
  it('🔴 面の窓は、面を離れて戻したあとも低い窓での追記欄の自動の畳みが効く(付箋は効かない)', () => {
    const v = new PaneVisibilityStore(memStorage(null).store);
    v.sessionOnly(null, ['sidebar', 'inspector', 'rail']);
    v.releaseWindowCollapse();
    v.setAutoFold('append');
    expect(v.getHidden(), '面の窓で自動の畳みが死んでいる').toContain('append');
    const n = new PaneVisibilityStore(memStorage(null).store);
    n.sessionOnly('append');
    n.setAutoFold('append');
    expect(n.getHidden(), '付箋で追記欄が畳まれた').not.toContain('append');
  });
  it('付箋(collapse なし)はバーを畳まない', () => {
    const s = new PaneVisibilityStore(memStorage(null).store);
    s.sessionOnly('append');
    expect(s.isRailHidden()).toBe(false);
    expect(s.toggleRail()).toBe(false);
  });
});

describe('画面(別のウィンドウの一生)', () => {
  it('🔴 畳んで始まり、窓の中で戻せ、本体の記録は動かない', () => {
    localStorage.clear();
    localStorage.setItem(KEY, 'append');
    const root = document.createElement('div');
    document.body.append(root);
    buildShell(root);
    bindActions(root, new Dispatcher());
    const shell = root.querySelector<HTMLElement>('[data-pkc-region="shell"]')!;
    const toggle = root.querySelector<HTMLElement>('[data-pkc-region="rail-toggle"]')!;
    expect(toggle, 'バーの帯が建っていない').not.toBeNull();
    // 本体の窓 ── 帯の印は無い
    expect(shell.hasAttribute('data-pkc-rail-toggle')).toBe(false);

    applyPaneVisibility(root, appPanes.sessionOnly(null, panesHiddenFor('schedule', false, true)));
    const tokens = (): string[] => (shell.getAttribute('data-pkc-hidden-panes') ?? '').split(/\s+/);
    expect(tokens().sort()).toEqual(['append', 'inspector', 'rail', 'sidebar']);
    expect(shell.hasAttribute('data-pkc-rail-toggle')).toBe(true);
    expect(toggle.getAttribute('aria-pressed')).toBe('false');

    // 窓の中で戻す: 列の帯(既存)とバーの帯(新規)
    root.querySelector<HTMLElement>('[data-pkc-action="toggle-pane"][data-pkc-pane="sidebar"]')!.click();
    expect(tokens()).not.toContain('sidebar');
    toggle.click();
    expect(tokens(), 'バーを戻せない').not.toContain('rail');
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    toggle.click();
    expect(tokens(), 'バーを畳み直せない').toContain('rail');

    expect(localStorage.getItem(KEY), '本体の窓の記録が動いた').toBe('append');
  });
});
