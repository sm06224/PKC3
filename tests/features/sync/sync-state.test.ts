import { describe, expect, it } from 'vitest';
import { extractChanges } from '@features/sync/change-set';
import { SYNC_INVENTORY } from '@features/sync/change-inventory';
import {
  TOMBSTONE_KEEP_DAYS,
  TOMBSTONE_MAX,
  addTombstone,
  advanceSeq,
  decodeBaseline,
  decodeTombstone,
  deviceIdFromBytes,
  dropRevived,
  encodeBaseline,
  encodeTombstone,
  isDeviceId,
  isSameDevice,
  nextSeq,
  parseSeq,
  pruneTombstones,
} from '@features/sync/sync-state';

const DEV = 'aaaaaaaaaaaaaaaa';
const t = (key: string, seq: number, lastHash = 'h') => ({ key, lastHash, device: DEV, seq });

describe('端末 id と連番', () => {
  it('8 バイトから 16 桁の 16 進を作る / 長さが違えば拒否', () => {
    const id = deviceIdFromBytes([0, 1, 255, 16, 171, 205, 239, 18]);
    expect(id).toBe('0001ff10abcdef12');
    expect(isDeviceId(id)).toBe(true);
    expect(isDeviceId('XYZ')).toBe(false);
    expect(() => deviceIdFromBytes([1, 2])).toThrow();
  });
  it('複製された DB(同じ id)を見分ける', () => {
    expect(isSameDevice(DEV, DEV)).toBe(true);
    expect(isSameDevice(DEV, 'bbbbbbbbbbbbbbbb')).toBe(false);
  });
  it('連番は時計が戻っても単調に進み、相手を見たら追い付く(戻さない)', () => {
    expect(nextSeq(0)).toBe(1);
    expect(nextSeq(nextSeq(5))).toBe(7);
    expect(advanceSeq(5, 9)).toBe(9);
    expect(advanceSeq(9, 5)).toBe(9);
  });
  it('壊れた連番は 0 から', () => {
    expect(parseSeq(null)).toBe(0);
    expect(parseSeq('abc')).toBe(0);
    expect(parseSeq('-3')).toBe(0);
    expect(parseSeq('42')).toBe(42);
  });
});

describe('墓標', () => {
  it('符号化して戻せる / 形が違う行は無かった物', () => {
    const enc = encodeTombstone(t('e1', 3, 'abc'), '2026-11-21T00:00:00.000Z');
    expect(decodeTombstone('e1', enc)).toEqual({ ...t('e1', 3, 'abc'), deletedAt: '2026-11-21T00:00:00.000Z' });
    expect(decodeTombstone('e1', '{"h":"x","d":"bad","s":1}')).toBeNull();
    expect(decodeTombstone('e1', 'not json')).toBeNull();
    expect(decodeTombstone('e1', null)).toBeNull();
    expect(decodeTombstone('e1', '[]')).toBeNull();
  });
  it('同じキーは連番の大きい方を残す', () => {
    expect(addTombstone([t('e1', 5)], t('e1', 2))).toEqual([t('e1', 5)]);
    expect(addTombstone([t('e1', 2)], t('e1', 5))).toEqual([t('e1', 5)]);
    expect(addTombstone([t('e1', 2)], t('e2', 1))).toHaveLength(2);
  });
  it('戻した(いま在る)キーの墓標は外す', () => {
    expect(dropRevived([t('e1', 1), t('e2', 2)], new Set(['e1']))).toEqual([t('e2', 2)]);
  });
  it('ゴミ箱を空にしても墓標は残り、まだ同期していない相手に削除が届く(復活の罠)', () => {
    // 端末 A: e1 を消してゴミ箱を空にした。合意(相手 C は未同期)は空 → 墓標だけが事実を持つ。
    const tombs = addTombstone([], t('e1', 1, 'old-hash'));
    const pruned = pruneTombstones(tombs, Date.parse('2026-11-21T00:00:00Z'));
    const cs = extractChanges([], {}, pruned);
    expect(cs.deleted).toEqual([{ key: 'e1', lastHash: 'old-hash' }]);
    // 墓標が無い場合は削除が届かない(= 罠の再現。墓標が要る理由)
    expect(extractChanges([], {}, []).deleted).toEqual([]);
  });
  it('期限を過ぎたものと件数の上限を超えたものを捨てる', () => {
    const now = Date.parse('2026-11-21T00:00:00Z');
    const old = new Date(now - (TOMBSTONE_KEEP_DAYS + 1) * 86_400_000).toISOString();
    const fresh = new Date(now - 86_400_000).toISOString();
    const out = pruneTombstones([{ ...t('old', 1), deletedAt: old }, { ...t('new', 2), deletedAt: fresh }, t('nodate', 3)], now);
    expect(out.map((x) => x.key).sort()).toEqual(['new', 'nodate']);
    const many = Array.from({ length: TOMBSTONE_MAX + 10 }, (_, i) => t(`k${i}`, i));
    const kept = pruneTombstones(many, now);
    expect(kept).toHaveLength(TOMBSTONE_MAX);
    expect(kept.some((x) => x.key === 'k0')).toBe(false);
  });
});

describe('前回の合意', () => {
  it('往復できる。壊れていれば空', () => {
    const b = { n1: 'a', 日本語のキー: 'b' };
    expect(decodeBaseline(encodeBaseline(b))).toEqual(b);
    expect(decodeBaseline('xx')).toEqual({});
    expect(decodeBaseline('[1]')).toEqual({});
    expect(decodeBaseline('{"a":1,"b":"ok"}')).toEqual({ b: 'ok' });
    expect(decodeBaseline(null)).toEqual({});
  });
});

describe('運ぶ物の全数表', () => {
  const ids = SYNC_INVENTORY.map((r) => r.id);
  it('種類の全数が名指しで載っている(増減したらここを更新する)', () => {
    expect(ids).toEqual([
      'body', 'title', 'kind', 'parent', 'tags', 'relations', 'labels', 'revisions', 'assets', 'settings', 'system-notes', 'trash', 'sync-state',
    ]);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it('運ばない行は段が null・理由と代わりの道を持つ。運ぶ行は段 2 か 3', () => {
    for (const r of SYNC_INVENTORY) {
      expect(r.why.length).toBeGreaterThan(5);
      expect(r.how.length).toBeGreaterThan(2);
      if (r.carry === 'no') expect(r.stage).toBeNull();
      else expect([2, 3]).toContain(r.stage);
    }
    expect(SYNC_INVENTORY.filter((r) => r.carry === 'no').map((r) => r.id)).toEqual(['revisions', 'settings', 'system-notes', 'sync-state']);
  });
  it('段 2 で運ぶ物 / 段 3 で足す物が決まっている', () => {
    expect(SYNC_INVENTORY.filter((r) => r.stage === 3).map((r) => r.id)).toEqual(['labels']);
    expect(SYNC_INVENTORY.filter((r) => r.stage === 2).length).toBe(8);
  });
});
