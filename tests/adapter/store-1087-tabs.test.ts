/** @vitest-environment happy-dom */
/**
 * 🔴 #1087 S1 / S2 / S4 / S5 ── 設定の store の「保存が使えない / 書けない / 別のタブが変えた」。
 *
 * 🔑 S4 / S5 は、2 つのインスタンスを**どちらも先に作ってから**変える(写しが両方とも古い状態)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  chooseOpenPlace,
  currentOpenPlace,
  resetOpenPlaceFallbackForTest,
} from '../../src/adapter/ui/render/open-place';
import {
  chooseAppOpenTarget,
  currentAppOpenTarget,
  resetAppOpenTargetFallbackForTest,
} from '../../src/adapter/ui/render/app-open-target';
import { ScheduleNotifyStore } from '../../src/adapter/ui/render/schedule-notify';
import { PasteSourceStore } from '../../src/adapter/ui/render/paste-source';
import { ExternalImagePolicy } from '../../src/adapter/ui/render/external-images';
import { NoticeStore, type NoticeStorage } from '../../src/adapter/platform/notice-store';
import {
  CopyHistoryStore,
  type CopyHistoryStorage,
} from '../../src/adapter/platform/copy-history-store';
import {
  SearchHistoryStore,
  type SearchHistoryStorage,
} from '../../src/adapter/platform/search-history-store';

type Mem = Pick<Storage, 'getItem' | 'setItem'> & { data: Map<string, string> };
function mem(): Mem {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
  };
}

beforeEach(() => {
  resetOpenPlaceFallbackForTest();
  resetAppOpenTargetFallbackForTest();
  localStorage.clear();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('S1: 開き場所 / アプリの出し先(関数の口)', () => {
  it('🔴 localStorage が無い端末:選んだ値がこの session で効く', () => {
    vi.stubGlobal('localStorage', undefined);
    chooseOpenPlace('here');
    expect(currentOpenPlace(), '押しても元へ戻る').toBe('here');
    chooseAppOpenTarget('window');
    expect(currentAppOpenTarget()).toBe('window');
  });

  it('🔴 書けない端末(setItem が投げる):選んだ値が元へ戻らない。書けるようになれば保存を読む', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });
    chooseOpenPlace('here');
    chooseAppOpenTarget('window');
    expect(currentOpenPlace()).toBe('here');
    expect(currentAppOpenTarget()).toBe('window');
    spy.mockRestore();
    chooseOpenPlace('window');
    expect(currentOpenPlace()).toBe('window');
    // 書けた後は保存が正 ── 外の書き手の値が見える(控えに固まっていない)
    localStorage.setItem('pkc3.open-place', 'here');
    expect(currentOpenPlace()).toBe('here');
  });
});

describe('S2: 予定の知らせ(書けない端末)', () => {
  function quota(): Mem & { fail: boolean } {
    const m = mem() as Mem & { fail: boolean };
    m.fail = true;
    const set = m.setItem;
    m.setItem = (k, v) => {
      if (m.fail) throw new DOMException('quota', 'QuotaExceededError');
      set(k, v);
    };
    return m;
  }

  it('🔴 lead / missed / 最後に開いた時刻:書けなくても書いた値が読める', () => {
    const st = quota();
    const s = new ScheduleNotifyStore(st);
    s.setLead(30);
    s.setMissedOn(false);
    s.stampOpen('c1', 1234);
    expect(s.lead(), '書けなかったとき、押した値が既定へ戻る').toBe(30);
    expect(s.missedOn()).toBe(false);
    expect(s.lastOpen('c1')).toBe(1234);
  });

  it('対照群:書けるようになれば保存を読む(控えに固まらない)', () => {
    const st = quota();
    const s = new ScheduleNotifyStore(st);
    s.setLead(30);
    st.fail = false;
    s.setLead(5);
    st.data.set('pkc3.schedule-lead', '60');
    expect(s.lead()).toBe(60);
  });
});

describe('S4: 別のタブが変えた設定が、開いているタブにも届く', () => {
  it('PasteSourceStore:A が変えた値を B が読む。B が同じ値を選んでも書く', () => {
    const st = mem();
    const a = new PasteSourceStore(st);
    const b = new PasteSourceStore(st);
    a.set('html');
    expect(b.get(), '別のタブの変更が届かない').toBe('html');
    // B は 'html' が見えているので、'auto' → 'html' と選び直す。同じ値の選び直しも書く
    b.set('auto');
    a.set('html');
    expect(st.data.get('pkc3.paste-source')).toBe('html');
    // 古い写しの B が、いま見えている値(A が書いた html)と同じ値を選んでも書く
    st.data.set('pkc3.paste-source', 'auto');
    const c = new PasteSourceStore(st);
    st.data.set('pkc3.paste-source', 'html');
    expect(c.set('html')).toBe(false);
    st.data.set('pkc3.paste-source', 'auto');
    c.set('auto');
    expect(st.data.get('pkc3.paste-source')).toBe('auto');
  });

  it('PasteSourceStore:同じ値を選び直しても書く(写しと同じだからと書かない形は不可)', () => {
    const st = mem();
    const a = new PasteSourceStore(st);
    a.set('html');
    st.data.clear(); // 外の書き手が消した
    a.set('html');
    expect(st.data.get('pkc3.paste-source'), '同じ値だからと書かなかった').toBe('html');
  });

  it('ExternalImagePolicy:A が変えた設定を B が読む。同じ値でも書く', () => {
    const st = mem();
    const a = new ExternalImagePolicy(st);
    const b = new ExternalImagePolicy(st);
    a.setMode('never');
    expect(b.getMode()).toBe('never');
    expect(b.allows('x')).toBe(false);
    st.data.clear();
    b.setMode('never');
    expect(st.data.get('pkc3.external-images')).toBe('never');
  });

  it('NoticeStore(お知らせの恒久オフ):A が切ったら B にも届く。書けないなら控え', () => {
    const data = new Map<string, string>();
    const st: NoticeStorage = {
      get: (k) => data.get(k) ?? null,
      set: (k, v) => void data.set(k, v),
      remove: (k) => void data.delete(k),
    };
    const a = new NoticeStore(st);
    const b = new NoticeStore(st);
    a.setEnabled(false);
    expect(b.enabled(), '別のタブの切替が届かない').toBe(false);
    b.setEnabled(true);
    expect(a.enabled()).toBe(true);

    // 書込が保存に届かない口(browserStorage は失敗を握り潰す)
    const dead: NoticeStorage = { get: () => null, set: () => undefined, remove: () => undefined };
    const c = new NoticeStore(dead);
    c.setEnabled(false);
    expect(c.enabled(), '書けなかったとき、押した切替が元へ戻る').toBe(false);
  });

  it('CopyHistoryStore:A が積んだ物が、先に作った B の items() に出る', () => {
    const data = new Map<string, string>();
    const st: CopyHistoryStorage = {
      get: (k) => data.get(k) ?? null,
      set: (k, v) => void data.set(k, v),
      remove: (k) => void data.delete(k),
    };
    const a = new CopyHistoryStore(st);
    const b = new CopyHistoryStore(st);
    a.push({ at: 1, text: 'x', html: '' });
    expect(b.items().map((i) => i.text), '別のタブの積みが届かない').toEqual(['x']);
    a.clear();
    expect(b.items()).toEqual([]);
  });
});

describe('S5: 検索履歴', () => {
  function store(): SearchHistoryStorage & { data: Map<string, string> } {
    const data = new Map<string, string>();
    return {
      data,
      get: (k) => data.get(k) ?? null,
      set: (k, v) => void data.set(k, v),
      remove: (k) => void data.delete(k),
    };
  }

  it('🔴 A が消した履歴が、先に作った B から戻らない・書き戻されない', () => {
    const st = store();
    const a = new SearchHistoryStore(st);
    a.push('foo');
    const b = new SearchHistoryStore(st); // foo を控えに持つ
    expect(b.list()).toEqual(['foo']);
    a.clear();
    expect(b.list(), '消した履歴が B の控えから戻る').toEqual([]);
    b.push('bar');
    expect(a.list(), '古い控えが書き戻されている').toEqual(['bar']);
  });

  it('対照群:自分の書込が届かない端末では、積んだ語が控えから出る', () => {
    const data = new Map<string, string>();
    const st: SearchHistoryStorage = {
      get: (k) => data.get(k) ?? null,
      set: () => undefined, // 溢れて書けない(握り潰す口)
      remove: (k) => void data.delete(k),
    };
    const s = new SearchHistoryStore(st);
    s.push('apple');
    s.push('berry');
    expect(s.list()).toEqual(['berry', 'apple']);
  });
});
