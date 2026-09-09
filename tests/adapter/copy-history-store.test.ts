/** @vitest-environment node */
/**
 * コピーした物の置き場(#678)。
 *
 * 🔴 ここで守るのは **「積めなかった」を黙って飲み込まないこと**である ──
 * localStorage は quota を超えると投げる。⚠ 握り潰すと、user から見て
 * 「コピーしたのに履歴に無い」という**理由の分からない壊れ方**になる。
 */
import { describe, expect, it } from 'vitest';
import {
  CopyHistoryStore,
  type CopyHistoryStorage,
} from '../../src/adapter/platform/copy-history-store';
import type { CopiedItem } from '../../src/features/clipboard/history';

const item = (text: string, at = 1): CopiedItem => ({ at, text, html: '' });

/** 偽の置き場。⚠ **書込の回数と中身**まで観測する。 */
function fake(initial: string | null = null, opts: { full?: boolean } = {}) {
  const writes: string[] = [];
  let value = initial;
  const storage: CopyHistoryStorage = {
    get: () => value,
    set: (_k, v) => {
      if (opts.full === true) throw new DOMException('QuotaExceededError');
      writes.push(v);
      value = v;
    },
    remove: () => {
      value = null;
    },
  };
  return { storage, writes, read: () => value };
}

describe('積む・消す', () => {
  it('積むと、新しい順で持ち、読み直しても残る', () => {
    const f = fake();
    const s = new CopyHistoryStore(f.storage);
    expect(s.push(item('a'))).toBe(true);
    expect(s.push(item('b'))).toBe(true);
    expect(s.items().map((c) => c.text)).toEqual(['b', 'a']);
    // 🔑 **読み直し**(別の窓 / 起動し直し)でも同じ
    expect(new CopyHistoryStore(f.storage).items().map((c) => c.text)).toEqual(['b', 'a']);
  });

  it('🔴 置き場が受け取れなければ false を返す(黙って捨てない)', () => {
    const f = fake(null, { full: true });
    const s = new CopyHistoryStore(f.storage);
    expect(s.push(item('a')), '溢れたのに成功と言っている').toBe(false);
    // 🔴 **画面の物だけ先に進めない** ── 書けていないのに一覧へ出すと、
    //    読み直した瞬間に消えて「さっき在ったのに」になる
    expect(s.items(), '書けていないのに持っている').toEqual([]);
  });

  it('1 件消える / 全部消える', () => {
    const f = fake();
    const s = new CopyHistoryStore(f.storage);
    s.push(item('a'));
    s.push(item('b'));
    s.drop('a');
    expect(s.items().map((c) => c.text)).toEqual(['b']);
    s.clear();
    expect(s.items()).toEqual([]);
    expect(f.read(), '消したのに置き場に残っている').toBeNull();
  });

  it('⚠ 空は積まないし、書きにも行かない(無駄な書込をしない)', () => {
    const f = fake();
    const s = new CopyHistoryStore(f.storage);
    s.push(item('a'));
    const before = f.writes.length;
    s.push(item('   '));
    expect(f.writes.length, '空で書きに行っている').toBe(before);
  });
});

describe('壊れた中身を読んでも、画面ごと落ちない', () => {
  it('JSON でなければ空から始まる', () => {
    expect(new CopyHistoryStore(fake('{ oops').storage).items()).toEqual([]);
  });

  it('配列でなければ空から始まる', () => {
    expect(new CopyHistoryStore(fake('{"a":1}').storage).items()).toEqual([]);
  });

  it('🔴 中身が欠けた行は捨てる(text の無い行を一覧に出さない)', () => {
    const raw = JSON.stringify([{ text: 'ok', at: 1 }, { at: 2 }, { text: '' }, null, 5]);
    const s = new CopyHistoryStore(fake(raw).storage);
    expect(s.items().map((c) => c.text)).toEqual(['ok']);
    // ⚠ 欠けた field は埋める(undefined を画面へ出さない)
    expect(s.items()[0]).toEqual({ at: 1, text: 'ok', html: '' });
  });
});
