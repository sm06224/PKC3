/**
 * 🔴 **種類で絞る**(#411)。
 *
 * ⚠ ここで守るのは 3 つ:①**空 = 全部**(0 件にしない)②**数える母集団**
 * (種類で絞る前・語で絞った後)③**知らない綴りを落とさない**。
 */
import { describe, it, expect } from 'vitest';
import { kindCounts, toggleKind } from '../../src/features/filter/kind-filter';
import {
  NO_KINDS,
  entryFilterOf,
  matchesEntry,
  type FilterTarget,
} from '../../src/features/filter/title-filter';

const t = (lid: string, title: string, archetype: string): FilterTarget => ({
  lid,
  title,
  archetype,
});

const SET: FilterTarget[] = [
  t('a', 'りんご', 'text'),
  t('b', '写真', 'attachment'),
  t('c', 'みかん', 'text'),
  t('d', '資料', 'folder'),
  t('e', 'りんご園', 'attachment'),
];

describe('種類の絞り(matchesEntry)', () => {
  it('🔴 **空 = 全部出す**(1 件も出さない、にしない)', () => {
    const f = entryFilterOf('', null, NO_KINDS);
    expect(SET.filter((m) => matchesEntry(m, f))).toHaveLength(5);
  });

  it('選んだ種類だけになる', () => {
    const f = entryFilterOf('', null, new Set(['attachment']));
    expect(SET.filter((m) => matchesEntry(m, f)).map((m) => m.lid)).toEqual(['b', 'e']);
  });

  it('🔴 **語が空でも種類は効く**(押しても何も変わらない、にしない)', () => {
    /**
     * ⚠ これが `query === ''` の早期 return より**後**に書かれていると、
     *   札を押しても行が 1 つも減らない ── 「絞りが壊れている」に見える。
     */
    const f = entryFilterOf('', null, new Set(['folder']));
    expect(SET.filter((m) => matchesEntry(m, f)).map((m) => m.lid)).toEqual(['d']);
  });

  it('語と種類は **AND**(どちらも満たすものだけ)', () => {
    const f = entryFilterOf('りんご', null, new Set(['attachment']));
    // 'a' は題名が当たるが text / 'b' は添付だが題名が当たらない
    expect(SET.filter((m) => matchesEntry(m, f)).map((m) => m.lid)).toEqual(['e']);
  });

  it('本文の当たりにも種類が効く(当たっていても種類が違えば出さない)', () => {
    const f = entryFilterOf('ぶどう', new Set(['a', 'b']), new Set(['attachment']));
    expect(SET.filter((m) => matchesEntry(m, f)).map((m) => m.lid)).toEqual(['b']);
  });

  it('2 つ選ぶと **どちらでもよい**(OR)', () => {
    const f = entryFilterOf('', null, new Set(['folder', 'attachment']));
    expect(SET.filter((m) => matchesEntry(m, f)).map((m) => m.lid)).toEqual(['b', 'd', 'e']);
  });
});

describe('札(kindCounts)', () => {
  it('その場に居る種類だけを、件数つきで返す', () => {
    expect(kindCounts(SET)).toEqual([
      { archetype: 'text', label: 'ノート', count: 2 },
      { archetype: 'folder', label: 'フォルダ', count: 1 },
      { archetype: 'attachment', label: '添付', count: 2 },
    ]);
  });

  it('🔴 **居ない種類の札は出さない**(押しても 0 件になる札を作らない)', () => {
    expect(kindCounts([t('a', 'x', 'text')]).map((k) => k.archetype)).toEqual(['text']);
  });

  it('並びは `ARCHETYPE_LABELS` の順(件数の多い順にしない ── 押し間違える)', () => {
    /** ⚠ 添付を先に入れても、出る順は名前の一覧の順である。 */
    const got = kindCounts([t('b', 'x', 'attachment'), t('a', 'y', 'text')]);
    expect(got.map((k) => k.archetype)).toEqual(['text', 'attachment']);
  });

  it('🔴 **知らない綴りも落とさない**(綴りをそのまま名前にする)', () => {
    const got = kindCounts([t('a', 'x', 'text'), t('z', 'y', 'generic')]);
    expect(got).toEqual([
      { archetype: 'text', label: 'ノート', count: 2 - 1 },
      { archetype: 'generic', label: 'generic', count: 1 },
    ]);
  });

  it('知らない綴りどうしは綴り順(数の順にすると札が飛び回る)', () => {
    const got = kindCounts([t('a', 'x', 'zeta'), t('b', 'y', 'zeta'), t('c', 'z', 'alpha')]);
    expect(got.map((k) => k.archetype)).toEqual(['alpha', 'zeta']);
  });

  it('🔴 数える母集団は「語で絞った後」── 押すと 0 件になる札を作らない', () => {
    /**
     * ⚠ 語で絞る**前**を数えると、「りんご」で 2 件しか無いのに札が
     *   「添付 2」と言い、`text` を押すと **1 件**ではなく別の数に見える。
     * 🔑 呼び手が渡す集合は、必ず**語で絞った後**である(sidebar もそうしている)。
     */
    const q = entryFilterOf('りんご', null, NO_KINDS);
    const afterQuery = SET.filter((m) => matchesEntry(m, q));
    expect(kindCounts(afterQuery)).toEqual([
      { archetype: 'text', label: 'ノート', count: 1 },
      { archetype: 'attachment', label: '添付', count: 1 },
    ]);
    // 札の件数どおりに減る(押してから驚かない)
    for (const k of kindCounts(afterQuery)) {
      const f = entryFilterOf('りんご', null, new Set([k.archetype]));
      expect(SET.filter((m) => matchesEntry(m, f))).toHaveLength(k.count);
    }
  });
});

describe('札を押す(toggleKind)', () => {
  it('押すと入り、もう一度押すと外れる', () => {
    const one = toggleKind(NO_KINDS, 'text');
    expect([...one]).toEqual(['text']);
    expect([...toggleKind(one, 'text')]).toEqual([]);
  });

  it('別の札は足される(1 つしか選べない、にしない)', () => {
    const two = toggleKind(toggleKind(NO_KINDS, 'text'), 'folder');
    expect([...two].sort()).toEqual(['folder', 'text']);
  });

  it('🔴 **元の集合を書き換えない**(state を直に触らない)', () => {
    const before = new Set(['text']);
    toggleKind(before, 'folder');
    expect([...before]).toEqual(['text']);
  });
});
