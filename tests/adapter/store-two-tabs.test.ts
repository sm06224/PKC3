/** @vitest-environment happy-dom */
/**
 * 🔴 **2 つのタブで別々に変えても、両方の分が残る**(#1087)。
 *
 * 直す前は、設定(flags)・お知らせの既読・クリップボードの履歴の 3 つが、**起動時に 1 度だけ読んだ写し**に
 * 足して全体を書き直していた。別のタブが後から保存した分は、こちらの保存で消えた
 * (お知らせは次の起動でまた出る / 履歴は積んだ物が無くなる)。
 *
 * 🔑 2 つのインスタンスを**どちらも先に作ってから**変える(= 写しが両方とも古い状態)。後から作ると、
 *   起動時の読みが救ってしまい、直す前でも緑になる。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineFlag } from '../../src/features/flags';
import { FlagStore } from '../../src/adapter/platform/flag-store';
import { NoticeStore, type NoticeStorage } from '../../src/adapter/platform/notice-store';
import {
  CopyHistoryStore,
  type CopyHistoryStorage,
} from '../../src/adapter/platform/copy-history-store';
import { COPY_HISTORY_MAX, type CopiedItem } from '../../src/features/clipboard/history';
import type { Notice } from '../../src/features/notice/notice-log';

const F1 = defineFlag('test.twoTabs1', { default: false, foldWhen: 'この test が消えるとき', summary: '見本 1' });
const F2 = defineFlag('test.twoTabs2', { default: false, foldWhen: 'この test が消えるとき', summary: '見本 2' });

describe('設定(FlagStore)', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it('A が F1、B が F2 を変えても、両方が残る(保存の中身も新しい読み手も)', () => {
    const a = new FlagStore('');
    const b = new FlagStore('');
    a.set(F1.name, true);
    b.set(F2.name, true);
    const saved = JSON.parse(localStorage.getItem('pkc3.flags') ?? '{}') as Record<string, boolean>;
    expect(saved[F1.name], 'A の分が B の保存で消えた').toBe(true);
    expect(saved[F2.name]).toBe(true);
    const c = new FlagStore('');
    expect(c.isOn(F1.name)).toBe(true);
    expect(c.isOn(F2.name)).toBe(true);
  });

  it('対照群:同じキーを両方が変えたら、あとから書いた方が勝つ(キーごとの上書き)', () => {
    const a = new FlagStore('');
    const b = new FlagStore('');
    a.set(F1.name, true);
    b.set(F1.name, false);
    expect(new FlagStore('').isOn(F1.name)).toBe(false);
  });

  it('保存が使えない端末:この session の中では、前に変えた分が消えない(今までの作法)', () => {
    // 読めて書けない(容量超過) ── 読み直した保存には前の変更が無いので、控えに足す枝が要る
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('容量超過');
    });
    const a = new FlagStore('');
    a.set(F1.name, true);
    a.set(F2.name, true);
    expect(a.isOn(F1.name), '書けなかった変更が、次の変更で消えた').toBe(true);
    expect(a.isOn(F2.name)).toBe(true);
  });

  it('読めない端末(localStorage が投げる)でも落ちず、この session では効く', () => {
    vi.spyOn(localStorage, 'getItem').mockImplementation(() => {
      throw new Error('使えない');
    });
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('使えない');
    });
    const a = new FlagStore('');
    a.set(F1.name, true);
    a.set(F2.name, true);
    expect(a.isOn(F1.name)).toBe(true);
    expect(a.isOn(F2.name)).toBe(true);
  });
});

describe('お知らせの既読(NoticeStore)', () => {
  const n = (id: string): Notice => ({ id, title: id, items: ['x'] });
  const registry = [n('2026-10-14-a'), n('2026-10-14-b'), n('2026-10-14-c')];
  function shared(): NoticeStorage & { data: Record<string, string> } {
    const data: Record<string, string> = {};
    return {
      data,
      get: (k) => data[k] ?? null,
      set: (k, v) => {
        data[k] = v;
      },
      remove: (k) => {
        delete data[k];
      },
    };
  }

  it('A が a、B が b を既読にしても、両方が残る', () => {
    const st = shared();
    const a = new NoticeStore(st);
    const b = new NoticeStore(st);
    a.markSeen(['2026-10-14-a'], registry);
    b.markSeen(['2026-10-14-b'], registry);
    const saved = JSON.parse(st.data['pkc3.notices.seen'] ?? '[]') as string[];
    expect(saved.slice().sort(), 'A の既読が B の保存で消えた').toEqual(['2026-10-14-a', '2026-10-14-b']);
    expect(new NoticeStore(st).seenIds()).toHaveLength(2);
    expect(b.seenIds(), 'B の写しも A の分を持つ').toContain('2026-10-14-a');
  });

  it('対照群:すでに保存に在るものを見ても、書き直さない', () => {
    const st = shared();
    const a = new NoticeStore(st);
    a.markSeen(['2026-10-14-a'], registry);
    const writes = vi.spyOn(st, 'set');
    const b = new NoticeStore(st);
    b.markSeen(['2026-10-14-a'], registry);
    expect(writes).not.toHaveBeenCalled();
  });
});

describe('クリップボードの履歴(CopyHistoryStore)', () => {
  const item = (text: string): CopiedItem => ({ at: 1, text, html: '' });
  function shared(): CopyHistoryStorage {
    let v: string | null = null;
    return {
      get: () => v,
      set: (_k, s) => {
        v = s;
      },
      remove: () => {
        v = null;
      },
    };
  }

  it('A が積んだ物が、B の積みで消えない(新しい順)', () => {
    const st = shared();
    const a = new CopyHistoryStore(st);
    const b = new CopyHistoryStore(st);
    expect(a.push(item('aaa'))).toBe(true);
    expect(b.push(item('bbb'))).toBe(true);
    expect(new CopyHistoryStore(st).items().map((c) => c.text)).toEqual(['bbb', 'aaa']);
    expect(b.items().map((c) => c.text), 'B 自身の写しも両方を持つ').toEqual(['bbb', 'aaa']);
  });

  it('B が 1 件消しても、A が積んだ別の物は消えない', () => {
    const st = shared();
    const a = new CopyHistoryStore(st);
    const b = new CopyHistoryStore(st);
    b.push(item('bbb'));
    a.push(item('aaa'));
    expect(b.drop('bbb')).toBe(true);
    expect(new CopyHistoryStore(st).items().map((c) => c.text)).toEqual(['aaa']);
  });

  it('件数の上限は、両方の分を足した後の一覧に掛かる', () => {
    const st = shared();
    const a = new CopyHistoryStore(st);
    const b = new CopyHistoryStore(st);
    for (let i = 0; i < COPY_HISTORY_MAX; i++) a.push(item(`a${i}`));
    for (let i = 0; i < 3; i++) b.push(item(`b${i}`));
    const texts = new CopyHistoryStore(st).items().map((c) => c.text);
    expect(texts).toHaveLength(COPY_HISTORY_MAX);
    expect(texts.slice(0, 3)).toEqual(['b2', 'b1', 'b0']);
  });
});
