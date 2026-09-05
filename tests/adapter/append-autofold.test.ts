/** @vitest-environment happy-dom */
/**
 * 🔴 **低い窓では追記欄を最初から畳み、記録には書かない**(#701。user 裁定 2026-09-04 案 A)。
 *
 * ## 守る主張
 *
 * 1. 🔴 窓が低い(`(max-height: N)` が真)なら、開いた時点で追記欄は畳まれている
 * 2. 🔴 そのとき `localStorage['pkc3.panes']` には **1 度も書かない**
 * 3. 🔴 畳んだ所の帯(`data-pkc-append-autofold`)を押すと欄が出て、送ると元どおり畳む
 *    (= `peek` の作法。記録は動かない)
 * 4. 窓が高くなれば(`change`)追記欄は出る ── こちらの畳みは窓の高さと同じ寿命
 * 5. 対照群 ── 高い窓では何も畳まない / user が自分で畳んでいれば、こちらの印は付かない
 * 6. 小窓(`sessionOnly`)では畳まない ── 追記のための窓に打つ欄が無い、を作らない
 *
 * ⚠ 何 px で切れるか(実寸)は happy-dom では測れない ── そこは
 *   `tests/smoke/phone.smoke.spec.ts` の 844×390 / 360×640 が見る。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { installAppendAutofold } from '../../src/adapter/ui/render/append-autofold';
import { appPanes, applyPaneVisibility } from '../../src/adapter/ui/render/pane-visibility';
import { APPEND_AUTOFOLD_MAX_HEIGHT_PX } from '../../src/features/pane-visibility';
import { PHONE_MAX_HEIGHT_PX } from '../../src/features/phone-layout';

const KEY = 'pkc3.panes';

/** 高さの見張りの替え玉。⚠ `matches` を手で動かして `change` を撃つ。 */
class FakeMedia {
  matches: boolean;
  private readonly fns: (() => void)[] = [];
  asked = '';
  constructor(matches: boolean) {
    this.matches = matches;
  }
  addEventListener(_t: 'change', fn: () => void): void {
    this.fns.push(fn);
  }
  removeEventListener(_t: 'change', fn: () => void): void {
    const i = this.fns.indexOf(fn);
    if (i >= 0) this.fns.splice(i, 1);
  }
  set(v: boolean): void {
    this.matches = v;
    for (const fn of [...this.fns]) fn();
  }
}

let off: (() => void) | null = null;

beforeEach(() => {
  document.body.textContent = '';
  localStorage.clear();
});

afterEach(() => {
  off?.();
  off = null;
  // ⚠ 共有の 1 個に残る印を次の file へ持ち越さない
  appPanes.unpeek();
  appPanes.setAutoFold(null);
  appPanes.setHidden([]);
  vi.restoreAllMocks();
});

function mount(low: boolean) {
  const root = document.createElement('div');
  root.setAttribute('data-pkc-slot', 'root');
  document.body.append(root);
  buildShell(root);
  const d = new Dispatcher();
  bindActions(root, d);
  applyPaneVisibility(root, appPanes.getHidden());
  const media = new FakeMedia(low);
  const writes = vi.spyOn(localStorage, 'setItem');
  off = installAppendAutofold(root, (q) => {
    media.asked = q;
    return media;
  });
  const shell = root.querySelector<HTMLElement>('[data-pkc-region="shell"]')!;
  return {
    root,
    media,
    writes,
    shell,
    hidden: (): string => shell.getAttribute('data-pkc-hidden-panes') ?? '',
    band: (): boolean => shell.hasAttribute('data-pkc-append-autofold'),
    grip: () =>
      root.querySelector<HTMLButtonElement>(
        '[data-pkc-region="pane-grip"][data-pkc-axis="y"]',
      )!,
  };
}

describe('低い窓では追記欄を最初から畳む(#701)', () => {
  it('🔴 聞く高さは features の定数 1 つで、スマホ用画面の高さの境目と同じ数字', () => {
    const m = mount(true);
    expect(m.media.asked).toBe(`(max-height: ${APPEND_AUTOFOLD_MAX_HEIGHT_PX}px)`);
    // ⚠ 844×390 / 667×375 はどちらも内側、360×640 は外側 ── 実測の根拠は定数の docstring
    expect(APPEND_AUTOFOLD_MAX_HEIGHT_PX).toBe(PHONE_MAX_HEIGHT_PX);
  });

  it('🔴 低い窓で開くと追記欄が畳まれ、帯の印が付き、記録には 1 度も書かない', () => {
    const m = mount(true);
    expect(m.hidden(), '追記欄が畳まれていない').toContain('append');
    expect(m.band(), '「ここに追記する」の帯の印が無い').toBe(true);
    expect(m.grip().getAttribute('aria-pressed'), '読み上げに「畳んだ」が出ていない').toBe('false');
    expect(m.writes, '記録に書いた(PC の見え方まで変わる)').not.toHaveBeenCalledWith(
      KEY,
      expect.anything(),
    );
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('🔴 帯を押すと欄が出て(記録は動かない)、送り終えれば元どおり畳む', () => {
    const m = mount(true);
    m.grip().click();
    expect(m.hidden(), '押しても欄が出ない').not.toContain('append');
    expect(m.band(), '出している間は帯の印を外す(帯の字と欄が同時に出ない)').toBe(false);
    expect(appPanes.isPeeking(), '一時表示になっていない(送っても畳まれない形)').toBe(true);
    expect(localStorage.getItem(KEY), '押した瞬間に記録へ書いた').toBeNull();
    // 送り終えた = `refoldPeeked` と同じ口(`unpeek`)── 畳み直る
    appPanes.unpeek();
    applyPaneVisibility(m.root, appPanes.getHidden());
    expect(m.hidden(), '送った後に畳まれていない').toContain('append');
    expect(m.band()).toBe(true);
  });

  it('🔴 窓が高くなれば追記欄は出て、また低くなれば畳む(記録は終始 null)', () => {
    const m = mount(true);
    m.media.set(false);
    expect(m.hidden(), '高くしても追記欄が出ない').not.toContain('append');
    expect(m.band()).toBe(false);
    m.media.set(true);
    expect(m.hidden()).toContain('append');
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('⚠ 対照群: 高い窓では何も畳まない', () => {
    const m = mount(false);
    expect(m.hidden()).toBe('');
    expect(m.band()).toBe(false);
  });

  it('⚠ 対照群: user が自分で畳んでいる窓では、user の畳みが効き、帯の印は付けない', () => {
    // user の畳み(記録に在る)
    appPanes.setHidden(['append']);
    const m = mount(true);
    expect(m.hidden()).toContain('append');
    expect(m.band(), 'user の畳みなのに「ここに追記する」の帯を出した').toBe(false);
    // 帯(取っ手)を押す = user の「戻す」── 記録から外れ、一時表示にはならない
    m.grip().click();
    expect(m.hidden()).not.toContain('append');
    expect(appPanes.isPeeking()).toBe(false);
  });

  it('🔴 小窓(sessionOnly)では畳まない ── 追記のための窓に打つ欄が無い、を作らない', () => {
    const m = mount(true);
    expect(m.hidden(), '前提: 低い窓では畳まれている').toContain('append');
    applyPaneVisibility(m.root, appPanes.sessionOnly('append'));
    expect(m.hidden(), '小窓にしたのに追記欄が畳まれたまま').not.toContain('append');
    // ⚠ 小窓のまま高さが変わっても、こちらの畳みは戻ってこない
    m.media.set(false);
    m.media.set(true);
    expect(m.hidden(), '小窓で高さが変わった回に畳まれた').not.toContain('append');
  });
});
