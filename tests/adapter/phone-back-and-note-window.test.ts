/** @vitest-environment happy-dom */
/**
 * 別のウィンドウとスマートフォンの手数 3 点(#1659。Gemini 裁定 = 推薦どおり)。
 *
 * 1. スマホで端末の「戻る」= 一覧へ(`actions/phone-back.ts`)。PC・タブレットでは履歴に触らない
 * 2. スマホの「別のウィンドウで開く」は、押したとき何が起きるかを 1 行で言う
 * 3. ノートの小窓に「× 閉じる」(門は Esc と同じ)
 */
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { CenterRouter } from '../../src/adapter/ui/render/center';
import {
  PHONE_NOTE_WINDOW_NOTICE,
  bindActions,
  type BinderServices,
} from '../../src/adapter/ui/actions/binder';
import { installPhoneBack, PHONE_BACK_BLOCKED_TAIL } from '../../src/adapter/ui/actions/phone-back';
import { appPhone } from '../../src/adapter/ui/render/phone-layout';
import { CLOSE_NOTE_WINDOW_REFUSED, type CloseViewWindowResult } from '../../src/adapter/platform/view-window';
import { KeymapStore } from '../../src/adapter/ui/render/keymap';
import type { PhonePage } from '../../src/features/phone-layout';

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

const offs: Array<() => void> = [];
afterEach(() => {
  document.body.innerHTML = '';
  for (const off of offs) off();
  offs.length = 0;
});

/** 履歴と popstate の替え玉。`back()` は積んだ項目を 1 つ消費して popstate を撃つ(本物と同じ向き)。 */
function fakeHistory() {
  const listeners: Array<() => void> = [];
  let depth = 0;
  const log: string[] = [];
  let deferred = false;
  const pending: Array<() => void> = [];
  return {
    defer: (on: boolean) => void (deferred = on),
    flush: () => void pending.splice(0).forEach((f) => f()),
    depth: () => depth,
    log,
    win: {
      addEventListener: (_t: string, fn: () => void) => void listeners.push(fn),
      removeEventListener: (_t: string, fn: () => void) => {
        const i = listeners.indexOf(fn);
        if (i >= 0) listeners.splice(i, 1);
      },
      setTimeout: (() => 0) as unknown as Window['setTimeout'],
    } as never,
    hist: {
      pushState: () => {
        depth += 1;
        log.push('push');
      },
      back: () => {
        depth -= 1;
        log.push('back');
        // 本物の popstate は非同期 ── `defer` の間は溜めて、あとで撃つ
        if (deferred) pending.push(() => listeners.forEach((fn) => fn()));
        else for (const fn of [...listeners]) fn();
      },
    } as never,
    /** 端末の「戻る」を押した。 */
    deviceBack: () => {
      if (depth <= 0) return; // 積んだ物が無ければ PKC3 の外へ出る(ここでは何も起きない)
      depth -= 1;
      log.push('device-back');
      for (const fn of [...listeners]) fn();
    },
  };
}

function backSetup(blocked: string | null = null) {
  const h = fakeHistory();
  const subs: Array<(p: PhonePage | null) => void> = [];
  const calls: string[] = [];
  let page: PhonePage | null = null;
  const setPage = (p: PhonePage | null): void => {
    page = p;
    for (const f of subs) f(p);
  };
  const off = installPhoneBack({
    onPageChange: (cb) => {
      subs.push(cb);
      return () => subs.splice(subs.indexOf(cb), 1);
    },
    blockReason: () => blocked,
    notifyBlocked: (m) => calls.push(`blocked:${m}`),
    showNote: () => {
      calls.push('showNote');
      setPage('note');
    },
    showList: () => {
      calls.push('showList');
      setPage('list');
    },
    win: h.win,
    hist: h.hist,
  });
  offs.push(off);
  return { h, calls, setPage, page: () => page };
}

describe('🔴 スマホで端末の「戻る」= 一覧へ(#1659 ①)', () => {
  it('ノートを読む画面に入ると履歴を 1 つ足し、端末の「戻る」で一覧へ戻る', () => {
    const s = backSetup();
    s.setPage('list');
    expect(s.h.depth(), '一覧では履歴を足さない').toBe(0);
    s.setPage('note');
    expect(s.h.depth(), 'ノートに入ったのに履歴が足されていない').toBe(1);
    s.h.deviceBack();
    expect(s.calls, '端末の「戻る」で一覧へ戻っていない').toEqual(['showList']);
    expect(s.page()).toBe('list');
    expect(s.h.depth(), '消費した項目が残っている').toBe(0);
  });

  it('ノートを読み直すたびに履歴を積まない(note → info → note で 1 つのまま)', () => {
    const s = backSetup();
    s.setPage('note');
    s.setPage('info');
    s.setPage('note');
    expect(s.h.depth(), '行き来するたびに積んでいる').toBe(1);
  });

  it('画面上の「← 一覧へ戻る」で一覧へ出たら、足した項目を畳む(積み上げない)', () => {
    const s = backSetup();
    s.setPage('note');
    s.setPage('list');
    expect(s.h.depth(), '足した項目が残っている(端末の戻るが空振りする)').toBe(0);
    expect(s.calls, '自分で畳んだ popstate を「戻る」と読んで二重に動いた').toEqual([]);
  });

  it('自分で畳んだ直後(popstate がまだ届かない間)にノートを開き直しても、その popstate を「戻る」と読まない', () => {
    const s = backSetup();
    s.h.defer(true);
    s.setPage('note');
    s.setPage('list'); // 畳む(back() を呼ぶが popstate は後で届く)
    s.setPage('note'); // すぐ開き直す(armed = true)
    s.h.flush(); // 遅れて届いた、自分の back() の popstate
    expect(s.calls, '自分で畳んだ popstate を端末の「戻る」と読んで一覧へ飛ばした').toEqual([]);
    expect(s.page()).toBe('note');
  });

  it('情報ページでの「戻る」はノートへ(画面の「← ノートへ戻る」と同じ)。もう一度で一覧へ', () => {
    const s = backSetup();
    s.setPage('note');
    s.setPage('info');
    s.h.deviceBack();
    expect(s.calls).toEqual(['showNote']);
    expect(s.h.depth(), 'ノートに残るので、次の「戻る」のために足し直す').toBe(1);
    s.h.deviceBack();
    expect(s.calls).toEqual(['showNote', 'showList']);
  });

  it('編集中は戻らず、理由を出し、項目を足し直す(2 度目の「戻る」で PKC3 の外へ出さない)', () => {
    const s = backSetup('編集を保存するか、編集をやめてから');
    s.setPage('note');
    s.h.deviceBack();
    expect(s.calls).toEqual([`blocked:編集を保存するか、編集をやめてから${PHONE_BACK_BLOCKED_TAIL}`]);
    expect(s.page(), '編集中なのに一覧へ移った').toBe('note');
    expect(s.h.depth(), '足し直していない').toBe(1);
  });

  it('スマホ以外(page が null)では履歴に触らない', () => {
    const s = backSetup();
    s.setPage(null);
    expect(s.h.log, 'PC・タブレットで履歴に触った').toEqual([]);
  });

  it('本物の PhoneLayout.onPageChange が、ページが変わったときだけ伝える', () => {
    const got: Array<PhonePage | null> = [];
    const off = appPhone.onPageChange((p) => got.push(p));
    offs.push(off);
    const root = document.createElement('div');
    document.body.append(root);
    buildShell(root);
    // スマホの見張りだけが `max-height` を持つ(対応外の幅は `max-width` のみ / タブレットは `min-*`)
    const mm = (q: string) => ({ matches: q.includes('max-height') });
    offs.push(appPhone.install(root, mm as never));
    offs.push(() => appPhone.install(document.createElement('div'), () => ({ matches: false }) as never));
    got.length = 0;
    appPhone.render({ selectedLid: 'a', viewMode: 'detail', editing: false, title: 'a' });
    appPhone.render({ selectedLid: 'a', viewMode: 'detail', editing: false, title: 'a2' });
    expect(got, '同じページを 2 度伝えた / 伝えていない').toEqual(['note']);
    appPhone.showList();
    expect(got).toEqual(['note', 'list']);
  });

  it('main.ts が installPhoneBack を配線している(原文 pin)', () => {
    const code = readFileSync('src/main.ts', 'utf8');
    expect(code).toMatch(/installPhoneBack\(\{/);
    expect(code).toMatch(/onPageChange:\s*\(cb\)\s*=>\s*appPhone\.onPageChange\(cb\)/);
  });
});

function mountApp(services: BinderServices, phone: boolean) {
  const root = document.createElement('div');
  document.body.append(root);
  const d = new Dispatcher();
  const regions = buildShell(root);
  const center = new CenterRouter(regions.detail);
  d.onState((st) => center.render(st));
  offs.push(bindActions(root, d, services, new KeymapStore(null)));
  const mm = (q: string) => ({ matches: phone && q.includes('max-height') });
  offs.push(appPhone.install(root, mm as never));
  offs.push(() => appPhone.install(document.createElement('div'), () => ({ matches: false }) as never));
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('a')], relations: [] });
  d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
  return { root, d, center };
}

describe('🔴 スマホの「別のウィンドウで開く」は何が起きるかを言う(#1659 ②)', () => {
  const press = (root: HTMLElement): void => {
    const b = document.createElement('button');
    b.setAttribute('data-pkc-action', 'open-note-window');
    root.append(b);
    b.click();
  };

  it('スマホ: 開く前に 1 行出す。窓は開く', () => {
    const opened: string[] = [];
    const m = mountApp({ openNoteWindow: (lid) => void opened.push(lid) }, true);
    expect(appPhone.isPhone(), '前提: スマホになっていない').toBe(true);
    press(m.root);
    expect(m.d.getState().notice).toBe(PHONE_NOTE_WINDOW_NOTICE);
    expect(opened, 'できることは残す(窓は開く)').toEqual(['a']);
  });

  it('PC: 何も言わない(対照群)', () => {
    const opened: string[] = [];
    const m = mountApp({ openNoteWindow: (lid) => void opened.push(lid) }, false);
    expect(appPhone.isPhone()).toBe(false);
    press(m.root);
    expect(m.d.getState().notice ?? '').not.toBe(PHONE_NOTE_WINDOW_NOTICE);
    expect(opened).toEqual(['a']);
  });

  it('字: 何が起きるかを言う', () => {
    expect(PHONE_NOTE_WINDOW_NOTICE).toBe('この端末では、新しいタブで PKC3 がもう 1 つ開きます');
  });
});

describe('🔴 ノートの小窓の「× 閉じる」(#1659 ③)', () => {
  const closeBtn = (root: HTMLElement): HTMLButtonElement =>
    root.querySelector<HTMLButtonElement>('[data-pkc-action="close-note-window"]')!;

  function mount(closed: CloseViewWindowResult = 'closed', isNote = true) {
    let closeCalls = 0;
    const m = mountApp(
      {
        closeNoteWindow: () => {
          closeCalls += 1;
          return closed;
        },
        isNoteWindow: () => isNote,
      },
      false,
    );
    return { ...m, closeCalls: () => closeCalls };
  }

  it('帯はふつうは隠れ、小窓のときだけ出る(ふつうのタブに閉じるボタンを出さない)', () => {
    const m = mount();
    const bar = m.root.querySelector<HTMLElement>('[data-pkc-region="note-window-bar"]')!;
    expect(bar.hidden, 'ふつうのタブに出ている').toBe(true);
    m.center.setNoteWindowBar(true);
    expect(bar.hidden).toBe(false);
    expect(closeBtn(m.root).textContent).toBe('× 閉じる');
    expect(bar.closest('[data-pkc-view-pane], [data-pkc-region]')).not.toBeNull();
  });

  it('押すと窓を閉じる', () => {
    const m = mount('closed');
    m.center.setNoteWindowBar(true);
    closeBtn(m.root).click();
    expect(m.closeCalls(), '閉じる口を呼んでいない').toBe(1);
    expect(m.d.getState().error ?? '').toBe('');
  });

  it('ブラウザが閉じなかったら理由を出す', () => {
    const m = mount('refused');
    closeBtn(m.root).click();
    expect(m.d.getState().error).toBe(CLOSE_NOTE_WINDOW_REFUSED);
  });

  it('編集中は閉じない(Esc と同じ門)', () => {
    const m = mount('closed');
    m.d.dispatch({ type: 'BODY_LOADED', lid: 'a', body: '本文' });
    m.d.dispatch({ type: 'START_EDIT' });
    expect(m.d.getState().phase, '前提: 編集中になっていない').toBe('editing');
    closeBtn(m.root).click();
    expect(m.closeCalls(), '編集中なのに閉じた').toBe(0);
    expect(m.d.getState().error ?? '').toMatch(/閉じてください$/);
  });

  it('追記欄に字が残っている間は閉じない(Esc と同じ門)', () => {
    const m = mount('closed');
    const ta = document.createElement('textarea');
    ta.setAttribute('data-pkc-field', 'append-input');
    ta.value = '書きかけ';
    m.root.append(ta);
    closeBtn(m.root).click();
    expect(m.closeCalls(), '書きかけがあるのに閉じた').toBe(0);
    expect(m.d.getState().error ?? '').not.toBe('');
  });

  it('小窓でない窓では何もしない', () => {
    const m = mount('closed', false);
    closeBtn(m.root).click();
    expect(m.closeCalls()).toBe(0);
  });

  it('main.ts が小窓になったとき帯を出す(原文 pin)', () => {
    const code = readFileSync('src/main.ts', 'utf8');
    expect(code).toMatch(/app\.setNoteWindowBar\(heldNoteWindow\)/);
    expect(code).toMatch(/setNoteWindowBar:\s*\(shown\)\s*=>\s*center\.setNoteWindowBar\(shown\)/);
  });
});
