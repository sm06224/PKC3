import { describe, expect, it } from 'vitest';
import { splitLabelQuery } from '@features/filter/label-query';
import { jumpTerms } from '@features/filter/search-hits';
import { entryFilterOf, matchesEntry } from '@features/filter/title-filter';
import { noteLabelColorOf } from '@features/note-label';
import {
  EMPTY_SMART,
  isSmartEmpty,
  needsRescan,
  readSmartSpec,
  smartQueryOf,
  withSmartField,
  writeSmartSpec,
  countUnreadSmartConds,
} from '@features/smart/smart-spec';

describe('色ラベルの語(#1982 段 4)', () => {
  it('色の名前・内部の名前・番号・全角を同じ色として読む', () => {
    expect(noteLabelColorOf('緑')).toBe(3);
    expect(noteLabelColorOf('Green')).toBe(3);
    expect(noteLabelColorOf('３')).toBe(3);
    expect(noteLabelColorOf('グレー')).toBe(8);
    expect(noteLabelColorOf('grey')).toBe(8);
    expect(noteLabelColorOf('青')).toBe(5);
    expect(noteLabelColorOf('青緑')).toBe(4);
    expect(noteLabelColorOf('あ')).toBeNull();
    expect(noteLabelColorOf('9')).toBeNull();
  });
  it('色の語を取り出し、残りはふつうの語', () => {
    expect(splitLabelQuery('色:緑 請求')).toEqual({ rest: '請求', colors: [3] });
    expect(splitLabelQuery('label:green')).toEqual({ rest: '', colors: [3] });
    expect(splitLabelQuery('色：青 COLOR:5')).toEqual({ rest: '', colors: [5] });
    expect(splitLabelQuery('色:あ x')).toEqual({ rest: '色:あ x', colors: [] });
  });
  it('残りの語は 1 字も変えない(① ㈱ ㌘ が NFKC で化けない)。色の語が無ければ問い合わせそのまま', () => {
    expect(splitLabelQuery('色:緑 ①㈱ ㌘x').rest).toBe('①㈱ ㌘x');
    expect(splitLabelQuery('a①  ㈱').rest, '色の語が無いのに空白を畳んだ・変えた').toBe('a①  ㈱');
    expect(splitLabelQuery('①㈱ label:3').rest).toBe('①㈱');
  });
  it('色が読めない語は字のまま(label:foo / 色:9)。引用符で囲めば色の語でも字として探す', () => {
    expect(splitLabelQuery('label:foo')).toEqual({ rest: 'label:foo', colors: [] });
    expect(splitLabelQuery('色:9 x')).toEqual({ rest: '色:9 x', colors: [] });
    expect(splitLabelQuery('"label:green"')).toEqual({ rest: 'label:green', colors: [] });
    expect(splitLabelQuery('"色:1" 色:2 y')).toEqual({ rest: '色:1 y', colors: [2] });
    // 色の語でない引用語は今までどおり(引用符ごと字)
    expect(splitLabelQuery('"a b"').rest).toBe('"a b"');
  });
  it('塗る語・移る語(jumpTerms)に色の語を入れない。引用符で囲んだ物は字として入る', () => {
    expect(jumpTerms('色:緑 請求', 'filter')).toEqual(['請求']);
    expect(jumpTerms('label:green', 'filter')).toEqual([]);
    expect(jumpTerms('"label:green" x', 'filter')).toEqual(['label:green', 'x']);
    expect(jumpTerms('label:foo', 'filter')).toEqual(['label:foo']);
  });
  it('matchesEntry: 色の語は語が空でも効き、ボタンの色と AND', () => {
    const labels = new Map([
      ['a', 3],
      ['b', 5],
    ]);
    const f = entryFilterOf('色:緑', null, new Set(), { color: null, labels });
    const t = (lid: string) => ({ lid, title: lid, archetype: 'text' });
    expect(matchesEntry(t('a'), f)).toBe(true);
    expect(matchesEntry(t('b'), f)).toBe(false);
    expect(matchesEntry(t('c'), f)).toBe(false);
    const both = entryFilterOf('色:緑', null, new Set(), { color: 5, labels });
    expect(matchesEntry(t('a'), both)).toBe(false);
    expect(matchesEntry(t('b'), both)).toBe(false);
    const withWord = entryFilterOf('色:緑 a', null, new Set(), { color: null, labels });
    expect(matchesEntry(t('a'), withWord)).toBe(true);
    expect(matchesEntry(t('b'), entryFilterOf('色:青 a', null, new Set(), { color: null, labels }))).toBe(false);
  });
});

describe('スマートフォルダの色の条件', () => {
  it('書いて読める(名前・内部の名前・番号)', () => {
    for (const v of ['緑', 'green', '3']) {
      expect(readSmartSpec(`---\nsmart-label: ${v}\n---\n`).label).toBe(3);
    }
    expect(readSmartSpec('---\nsmart-label: ほげ\n---\n').label).toBeNull();
  });
  it('条件が色だけでも空ではなく、集め直しが要る', () => {
    const s = { ...EMPTY_SMART, label: 3 };
    expect(isSmartEmpty(s)).toBe(false);
    expect(needsRescan(s)).toBe(true);
    expect(smartQueryOf(s, 0).label).toBe(3);
    expect(smartQueryOf(EMPTY_SMART, 0).label).toBeNull();
  });
  it('withSmartField: 選ぶ / 外す / 不正', () => {
    const on = withSmartField(EMPTY_SMART, 'label', '3');
    expect(on).toMatchObject({ ok: true, spec: { label: 3 } });
    if (!on.ok) throw new Error('unreachable');
    expect(withSmartField(on.spec, 'label', '3')).toEqual({ ok: false, reason: 'unchanged' });
    expect(withSmartField(on.spec, 'label', 'x')).toEqual({ ok: false, reason: 'invalid' });
    expect(withSmartField(on.spec, 'label', '')).toMatchObject({ ok: true, spec: { label: null } });
    const body = writeSmartSpec('', on.spec);
    expect(body).toContain('smart-label: 緑');
    expect(readSmartSpec(body).label).toBe(3);
    expect(countUnreadSmartConds('---\nsmart-label: ほげ\n---\n')).toBe(1);
    expect(countUnreadSmartConds(body)).toBe(0);
  });
});
