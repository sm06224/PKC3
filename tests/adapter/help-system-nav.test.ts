/** @vitest-environment happy-dom */
/**
 * 🔴 **ヘルプ ⇄ システムの行き来と、Office の添付からシステムへの 1 手**(依頼 67-1 / 61-2。Gemini 裁定 2026-10-13 = 推薦どおり)。
 *
 * ⚠ 守る主張:
 *  ① ヘルプで「お知らせを開く」を押して来たときだけ、お知らせの見出しの隣に「← ヘルプへ戻る」が出る
 *  ② 押すとヘルプへ戻り、読んでいた位置(外側の転がり)を書き戻す
 *  ③ ヘルプ以外から来た回には出ない(対照群)/ システムを離れたら畳む
 *  ④ 「システムを開く」(Office の添付の画面)で、システムの Office 表示の節が開く
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { CenterRouter } from '../../src/adapter/ui/render/center';
import { bindActions } from '../../src/adapter/ui/actions/binder';

let root: HTMLElement;
let d: Dispatcher;

function boot(): void {
  document.body.textContent = '';
  root = document.createElement('div');
  document.body.append(root);
  d = new Dispatcher();
  // 実物と同じ入れ子:押しを受ける根の中に、中央の器(`detail`)が居る
  const detail = document.createElement('div');
  detail.setAttribute('data-pkc-region', 'detail');
  root.append(detail);
  const center = new CenterRouter(detail);
  d.onState((s) => center.render(s));
  bindActions(root, d, {});
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [], relations: [] });
}

const backBtn = (): HTMLButtonElement | null =>
  root.querySelector<HTMLButtonElement>('[data-pkc-action="back-to-help"]');

beforeEach(() => {
  boot();
});

describe('ヘルプから「お知らせを開く」で来たとき(依頼 67-1)', () => {
  it('🔴 来たときだけ「← ヘルプへ戻る」が出て、見出しの隣に居る', () => {
    d.dispatch({ type: 'SET_VIEW_MODE', mode: 'help' });
    root.querySelector<HTMLElement>('[data-pkc-action="open-system-notices"]')!.click();
    expect(d.getState().viewMode, '前提:システムが開いていない').toBe('settings');
    const b = backBtn();
    expect(b, '戻る口が器に無い').not.toBeNull();
    expect(b!.hidden, 'ヘルプから来たのに出ていない').toBe(false);
    expect(b!.textContent).toBe('← ヘルプへ戻る');
    // 見出しの隣(見出しを包む行の中)に居る
    const row = b!.closest('[data-pkc-field="settings-heading-row"]');
    expect(row, '見出しの行の外に置いている').not.toBeNull();
    expect(row!.querySelector('h3')?.textContent).toBe('お知らせ');
  });

  it('🔴 対照群:ヘルプ以外から開いた回は出ない', () => {
    d.dispatch({ type: 'SET_VIEW_MODE', mode: 'help' });
    root.querySelector<HTMLElement>('[data-pkc-action="open-system-notices"]')!.click();
    expect(backBtn()!.hidden, '前提:ヘルプから来た回に出ていない').toBe(false);
    // ヘルプへ戻らず、別の画面を経由してシステムを開き直す
    d.dispatch({ type: 'SET_VIEW_MODE', mode: 'sql' });
    d.dispatch({ type: 'SET_VIEW_MODE', mode: 'settings' });
    expect(backBtn()!.hidden, 'ヘルプから来ていないのに古い「戻る」が残っている').toBe(true);
  });

  it('🔴 押すとヘルプへ戻り、読んでいた位置を書き戻す', () => {
    d.dispatch({ type: 'SET_VIEW_MODE', mode: 'help' });
    const outer = root.querySelector<HTMLElement>('[data-pkc-region="detail"]')!;
    outer.scrollTop = 420;
    const manual = root.querySelector<HTMLElement>('[data-pkc-region="help-manual"]')!;
    manual.scrollTop = 77;
    root.querySelector<HTMLElement>('[data-pkc-action="open-system-notices"]')!.click();
    // システムを開いている間に転がりが失われる(隠れた面は転がりを持たない)
    outer.scrollTop = 0;
    manual.scrollTop = 0;
    backBtn()!.click();
    expect(d.getState().viewMode, 'ヘルプへ戻っていない').toBe('help');
    expect(outer.scrollTop, '外側の読んでいた位置が戻っていない').toBe(420);
    expect(manual.scrollTop, 'マニュアルの読んでいた位置が戻っていない').toBe(77);
    expect(backBtn()!.hidden, '戻った後も口が残っている').toBe(true);
  });

  it('🔴 マニュアルを入れ直している最中に戻っても、描き終えた後に位置が戻る(5 分離れて手放した回)', async () => {
    // 描き終えるのを手元で止められるマークダウンの口(手放した本文の入れ直しは非同期)
    let finish: (html: string) => void = () => undefined;
    const markdown = {
      render: () => new Promise<string>((r) => (finish = r)),
    } as unknown as ConstructorParameters<typeof CenterRouter>[3];
    document.body.textContent = '';
    root = document.createElement('div');
    document.body.append(root);
    d = new Dispatcher();
    const detail = document.createElement('div');
    detail.setAttribute('data-pkc-region', 'detail');
    root.append(detail);
    const center = new CenterRouter(detail, undefined, null, markdown);
    d.onState((st) => center.render(st));
    bindActions(root, d, {});
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [], relations: [] });
    d.dispatch({ type: 'SET_VIEW_MODE', mode: 'help' });
    const manual = root.querySelector<HTMLElement>('[data-pkc-region="help-manual"]')!;
    manual.scrollTop = 77;
    root.querySelector<HTMLElement>('[data-pkc-action="open-system-notices"]')!.click();
    expect(manual.hasAttribute('data-pkc-manual-loading'), '前提:入れ直しの最中になっていない').toBe(true);
    backBtn()!.click();
    // 本文がまだ 1 行しか無い間は、ブラウザが位置を 0 に丸める
    manual.scrollTop = 0;
    finish('<p>本文</p>');
    await new Promise((r) => setTimeout(r, 0));
    expect(manual.hasAttribute('data-pkc-manual-loading'), '描き終えた印が残っている').toBe(false);
    expect(manual.scrollTop, '描き終えた後に位置を戻していない').toBe(77);
  });

  it('システムを離れたら畳む(開き直しても残らない)', () => {
    d.dispatch({ type: 'SET_VIEW_MODE', mode: 'help' });
    root.querySelector<HTMLElement>('[data-pkc-action="open-system-notices"]')!.click();
    d.dispatch({ type: 'SET_VIEW_MODE', mode: 'sql' });
    expect(backBtn()!.hidden).toBe(true);
  });
});

describe('Office の添付の画面から「システムを開く」(依頼 61-2)', () => {
  it('🔴 押すとシステムが開き、Office 表示の節へ送られる', () => {
    d.dispatch({ type: 'SET_VIEW_MODE', mode: 'settings' });
    const office = root.querySelector<HTMLElement>('[data-pkc-region="settings-office"]')!;
    expect(office, '前提:Office 表示の節が無い').not.toBeNull();
    const scroll = vi.fn();
    office.scrollIntoView = scroll;
    d.dispatch({ type: 'SET_VIEW_MODE', mode: 'sql' });
    const go = document.createElement('button');
    go.setAttribute('data-pkc-action', 'open-system-office');
    root.append(go);
    go.click();
    expect(d.getState().viewMode, 'システムが開いていない').toBe('settings');
    expect(scroll, 'Office 表示の節へ送っていない').toHaveBeenCalledTimes(1);
  });
});
