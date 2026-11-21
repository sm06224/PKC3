import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { extractChanges, seedBaseline, type Tombstone } from '@features/sync/change-set';
import { SYNC_INVENTORY } from '@features/sync/change-inventory';
import {
  SYNC_SCOPE,
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
  syncScope,
} from '@features/sync/sync-state';

const DEV = 'aaaaaaaaaaaaaaaa';
const DEV2 = 'bbbbbbbbbbbbbbbb';
const t = (key: string, seq: number, content = 'h', deletedAt?: string, device = DEV): Tombstone => ({
  key,
  lastFp: { content },
  device,
  seq,
  ...(deletedAt === undefined ? {} : { deletedAt }),
});
const NOW = Date.parse('2026-11-21T00:00:00Z');
const DAY = 86_400_000;
const daysAgo = (d: number): string => new Date(NOW - d * DAY).toISOString();

describe('端末 id と連番と置き場', () => {
  it('8 バイトから 16 桁の 16 進を作る / 長さが違えば拒否', () => {
    const id = deviceIdFromBytes([0, 1, 255, 16, 171, 205, 239, 18]);
    expect(id).toBe('0001ff10abcdef12');
    expect(isDeviceId(id)).toBe(true);
    expect(isDeviceId('XYZ')).toBe(false);
    expect(() => deviceIdFromBytes([1, 2])).toThrow();
  });
  it('複製された DB(同じ id)を見分ける', () => {
    expect(isSameDevice(DEV, DEV)).toBe(true);
    expect(isSameDevice(DEV, DEV2)).toBe(false);
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
  it('🔴2 ワークスペースごとの区画は `__sync__:<cid>`(端末の区画 `__sync__` と別・cid ごとに別)', () => {
    expect(SYNC_SCOPE).toBe('__sync__');
    expect(syncScope('c1')).toBe('__sync__:c1');
    expect(syncScope('c1')).not.toBe(syncScope('c2'));
    expect(syncScope('c1')).not.toBe(SYNC_SCOPE);
  });
});

describe('墓標', () => {
  it('符号化して戻せる(指紋は 2 欄・日時つき)/ 形が違う行は無かった物', () => {
    const tb = { ...t('e1', 3, 'abc', '2026-11-21T00:00:00.000Z'), lastFp: { content: 'abc', place: 'pp' } };
    expect(decodeTombstone('e1', encodeTombstone(tb))).toEqual(tb);
    expect(decodeTombstone('e2', encodeTombstone(t('e2', 1)))).toEqual(t('e2', 1));
    expect(decodeTombstone('e1', '{"f":{"c":"x"},"d":"bad","s":1}')).toBeNull();
    expect(decodeTombstone('e1', '{"f":{"c":""},"d":"aaaaaaaaaaaaaaaa","s":1}')).toBeNull();
    expect(decodeTombstone('e1', 'not json')).toBeNull();
    expect(decodeTombstone('e1', null)).toBeNull();
    expect(decodeTombstone('e1', '[]')).toBeNull();
  });
  it('読めない日時は「日時不明」(deletedAt が付かない)', () => {
    const enc = JSON.stringify({ f: { c: 'x' }, d: DEV, s: 1, t: 'yesterday' });
    expect(decodeTombstone('e1', enc)).toEqual(t('e1', 1, 'x'));
    expect('deletedAt' in (decodeTombstone('e1', enc) as object)).toBe(false);
  });
  it('⚠3 同じ端末の同じキーは連番の大きい方を残す', () => {
    expect(addTombstone([t('e1', 5)], t('e1', 2))).toEqual([t('e1', 5)]);
    expect(addTombstone([t('e1', 2)], t('e1', 5))).toEqual([t('e1', 5)]);
    expect(addTombstone([t('e1', 2)], t('e2', 1))).toHaveLength(2);
  });
  it('⚠3 別の端末の記録どうしは連番を比べず、あとから足した方を残す(連番が小さくても)', () => {
    const out = addTombstone([t('e1', 900, 'old', undefined, DEV)], t('e1', 2, 'new', undefined, DEV2));
    expect(out).toEqual([t('e1', 2, 'new', undefined, DEV2)]);
  });
  it('戻した(いま在る)キーの墓標は外す', () => {
    expect(dropRevived([t('e1', 1), t('e2', 2)], new Set(['e1']))).toEqual([t('e2', 2)]);
  });
  it('ゴミ箱を空にしても墓標は残り、まだ同期していない相手に削除が届く(復活の罠)', () => {
    const tombs = addTombstone([], t('e1', 1, 'old-hash', daysAgo(1)));
    const pruned = pruneTombstones(tombs, NOW);
    const cs = extractChanges([], {}, pruned);
    expect(cs.deleted).toEqual([{ key: 'e1', lastFp: { content: 'old-hash' } }]);
    expect(extractChanges([], {}, []).deleted).toEqual([]);
  });
});

describe('⚠3 古い墓標の整理(時計は整理にだけ使う)', () => {
  it('期限の境界: 179 日・ちょうど 180 日は残り、181 日は捨てる', () => {
    expect(TOMBSTONE_KEEP_DAYS).toBe(180);
    const out = pruneTombstones(
      [t('d179', 1, 'h', daysAgo(179)), t('d180', 2, 'h', daysAgo(180)), t('d181', 3, 'h', daysAgo(181)), t('d400', 4, 'h', daysAgo(400))],
      NOW,
    );
    expect(out.map((x) => x.key).sort()).toEqual(['d179', 'd180']);
  });
  it('日時が無い / 読めない物は期限では捨てない(古さ不明)', () => {
    const bad: Tombstone = { ...t('bad', 1), deletedAt: 'xx' };
    expect(pruneTombstones([t('nodate', 1), bad], NOW).map((x) => x.key).sort()).toEqual(['bad', 'nodate']);
  });
  it('件数の境界: ちょうど上限は全部残り、超えた分は deletedAt の古い順に捨てる(連番ではない)', () => {
    const at = (i: number): string => new Date(NOW - (TOMBSTONE_MAX + 10 - i) * 60_000).toISOString();
    // 連番は日時と逆(古い物ほど大きい)。連番で整理すると新しい物が落ちる
    const make = (n: number) => Array.from({ length: n }, (_, i) => t(`k${i}`, 100_000 - i, 'h', at(i)));
    expect(pruneTombstones(make(TOMBSTONE_MAX), NOW)).toHaveLength(TOMBSTONE_MAX);
    const kept = pruneTombstones(make(TOMBSTONE_MAX + 10), NOW);
    expect(kept).toHaveLength(TOMBSTONE_MAX);
    const keys = new Set(kept.map((x) => x.key));
    for (let i = 0; i < 10; i++) expect(keys.has(`k${i}`), `古い k${i} が残っている`).toBe(false);
    expect(keys.has('k10')).toBe(true);
    expect(keys.has(`k${TOMBSTONE_MAX + 9}`)).toBe(true);
  });
  it('件数の整理では、日時の無い物がいちばん古い扱いで先に捨てられる', () => {
    const dated = Array.from({ length: TOMBSTONE_MAX }, (_, i) => t(`d${i}`, i, 'h', daysAgo(1)));
    const out = pruneTombstones([t('nodate', 999_999), ...dated], NOW);
    expect(out).toHaveLength(TOMBSTONE_MAX);
    expect(out.some((x) => x.key === 'nodate')).toBe(false);
    // 1 つ空きがあれば残る
    expect(pruneTombstones([t('nodate', 1), ...dated.slice(1)], NOW).some((x) => x.key === 'nodate')).toBe(true);
  });
  it('日時が同じ・不明どうしはキーの昇順で決まる(入力の順に依らない)', () => {
    const items = Array.from({ length: TOMBSTONE_MAX + 2 }, (_, i) => t(`u${String(i).padStart(5, '0')}`, i));
    const a = pruneTombstones(items, NOW).map((x) => x.key);
    const b = pruneTombstones([...items].reverse(), NOW).map((x) => x.key);
    expect(a).toEqual(b);
    expect(a).toHaveLength(TOMBSTONE_MAX);
  });
});

describe('前回の合意', () => {
  it('往復できる(指紋 2 欄)。壊れていれば空', () => {
    const b = { n1: { content: 'a', place: 'p' }, 日本語のキー: { content: 'b' } };
    expect(decodeBaseline(encodeBaseline(b))).toEqual(b);
    expect(decodeBaseline('xx')).toEqual({});
    expect(decodeBaseline('[1]')).toEqual({});
    expect(decodeBaseline('{"a":1,"b":{"c":"ok"},"c":{"c":""}}')).toEqual({ b: { content: 'ok' } });
    expect(decodeBaseline(null)).toEqual({});
  });
  it('🔴 空の place は行ごと捨てない(往復できる)。空の content は従来どおり捨てる', () => {
    const b = { n1: { content: 'a', place: '' }, n2: { content: 'b', place: 'p' } };
    expect(decodeBaseline(encodeBaseline(b))).toEqual(b);
    // seedBaseline が作った物も、書いて読み直して同じ(種が読み込みで欠けない)
    const seed = seedBaseline([{ key: 'n1', content: 'a', place: '' }]);
    expect(seed).toEqual({ n1: { content: 'a', place: '' } });
    expect(decodeBaseline(encodeBaseline(seed))).toEqual(seed);
    expect(decodeBaseline('{"x":{"c":"","p":""}}')).toEqual({});
    expect(decodeBaseline('{"x":{"c":"a","p":3}}')).toEqual({});
  });
});

describe('運ぶ物の全数表', () => {
  const ids = SYNC_INVENTORY.map((r) => r.id);
  it('種類の全数が名指しで載っている(増減したらここを更新する)', () => {
    expect(ids).toEqual([
      'body', 'title', 'kind', 'parent', 'tags', 'relations', 'labels', 'pins', 'revisions', 'assets', 'settings', 'system-notes', 'trash', 'sync-state',
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
  it('段 2 で運ぶ物 / 段 3 で足す物が決まっている(id で固定)', () => {
    expect(SYNC_INVENTORY.filter((r) => r.stage === 3).map((r) => r.id)).toEqual(['labels', 'pins']);
    expect(SYNC_INVENTORY.filter((r) => r.stage === 2).map((r) => r.id)).toEqual([
      'body', 'title', 'kind', 'parent', 'tags', 'relations', 'assets', 'trash',
    ]);
  });
  it('⚠5 設計 doc の全数表は、行の id と順が SYNC_INVENTORY と一致する(1 id に 1 行)', () => {
    const doc = readFileSync('docs/development/pkc3-major-upgrade-design-2026-07.md', 'utf8');
    const start = doc.indexOf('### 運ぶ物の全数表');
    expect(start, '全数表の見出しが無い').toBeGreaterThan(-1);
    const rest = doc.slice(start);
    const end = rest.indexOf('\n\n段 2 で運ぶのは');
    expect(end, '全数表の終わり(段 2 で運ぶのは…)が見つからない: 節が文末まで広がり、別の表の行を拾う').toBeGreaterThan(-1);
    const section = rest.slice(0, end);
    const rows = section.split('\n').filter((l) => l.startsWith('| `'));
    const docIds = rows.map((l) => /^\| `([^`]+)`/.exec(l)?.[1]);
    expect(docIds).toEqual(ids);
    // 段の列も突き合わせる(本文の段と食い違わない)
    const docStages = rows.map((l) => l.split('|')[4]?.trim());
    expect(docStages).toEqual(SYNC_INVENTORY.map((r) => (r.stage === null ? '-' : String(r.stage))));
    // 「運ぶか」の列も突き合わせる(明示の対応表。行の carry を変えたら doc の字も変える)
    const carryText: Record<(typeof SYNC_INVENTORY)[number]['carry'], readonly string[]> = {
      yes: ['運ぶ', '運ぶ(削除の記録だけ)'],
      'part-of': ['運ぶ(指紋の一部)'],
      derived: ['本文から導かれる'],
      no: ['運ばない'],
    };
    const docCarry = rows.map((l) => l.split('|')[3]?.trim() ?? '');
    SYNC_INVENTORY.forEach((r, i) => {
      expect(carryText[r.carry], `${r.id}: doc の「運ぶか」が carry=${r.carry} と食い違う(doc: ${docCarry[i]})`).toContain(docCarry[i]);
    });
  });
});
