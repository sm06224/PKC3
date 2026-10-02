/**
 * #1231 段①: 差分を**左右に並べる**対応付け(`sideRows`)。左 = 相手 / 右 = この版。
 */
import { describe, expect, it } from 'vitest';
import { diffRows, type DiffRow } from '../../src/features/revision/diff-view';
import {
  CHAR_DIFF_TOTAL_BUDGET,
  sideRows,
  type SideRow,
} from '../../src/features/revision/diff-side';
import { CHAR_DIFF_MAX_CHARS } from '../../src/features/revision/char-diff';

const row = (kind: DiffRow['kind'], text = ''): DiffRow => ({ kind, text });

function pair(r: SideRow | undefined) {
  expect(r?.kind, '行ではなく畳みだった').toBe('pair');
  return r as Extract<SideRow, { kind: 'pair' }>;
}

describe('#1231 sideRows: 左右の対応', () => {
  it('🔴 del の直後に add が同じ数 → 同じ行に並ぶ(左に del、右に add)', () => {
    const out = sideRows([row('del', 'いまの本文'), row('add', 'むかしの本文')]);
    expect(out).toHaveLength(1);
    const p = pair(out[0]);
    expect(p.left?.kind).toBe('del');
    expect(p.left?.text).toBe('いまの本文');
    expect(p.right?.kind).toBe('add');
    expect(p.right?.text).toBe('むかしの本文');
  });

  it('🔴 2 行ずつ入れ替わったら、前から順に 2 組(1 本目どうし・2 本目どうし)', () => {
    const out = sideRows([row('del', 'a1'), row('del', 'b1'), row('add', 'a2'), row('add', 'b2')]);
    expect(out).toHaveLength(2);
    expect([pair(out[0]).left?.text, pair(out[0]).right?.text]).toEqual(['a1', 'a2']);
    expect([pair(out[1]).left?.text, pair(out[1]).right?.text]).toEqual(['b1', 'b2']);
  });

  it('🔴 消えた行だけ: 右は空の升(null)', () => {
    const p = pair(sideRows([row('del', '消えた')])[0]);
    expect(p.left?.text).toBe('消えた');
    expect(p.right).toBeNull();
  });

  it('🔴 足した行だけ: 左は空の升(null)', () => {
    const p = pair(sideRows([row('add', '足した')])[0]);
    expect(p.left).toBeNull();
    expect(p.right?.text).toBe('足した');
  });

  it('同じ行は両列に同じ字で出る', () => {
    const p = pair(sideRows([row('same', '変わらない')])[0]);
    expect([p.left?.kind, p.left?.text]).toEqual(['same', '変わらない']);
    expect([p.right?.kind, p.right?.text]).toEqual(['same', '変わらない']);
  });

  it('🔴 畳み(gap)は両列にまたがる 1 行(畳んだ行数を持つ)', () => {
    const out = sideRows([row('same', 'x'), { kind: 'gap', text: '', skipped: 7 }, row('same', 'y')]);
    expect(out).toHaveLength(3);
    expect(out[1]).toEqual({ kind: 'gap', skipped: 7 });
  });

  it('⚠ 数が違う塊(2 本消えて 1 本足した)は、行は並べるが字単位の強調はしない(推測で対にしない)', () => {
    const out = sideRows([row('del', 'あ1'), row('del', 'い1'), row('add', 'あ2')]);
    expect(out).toHaveLength(2);
    expect(pair(out[0]).left?.text).toBe('あ1');
    expect(pair(out[0]).right?.text).toBe('あ2');
    expect(pair(out[1]).left?.text).toBe('い1');
    expect(pair(out[1]).right).toBeNull();
    for (const r of out) {
      expect(pair(r).left?.parts ?? null).toBeNull();
      expect(pair(r).right?.parts ?? null).toBeNull();
    }
  });

  it('⚠ 対になる行が無い(片側だけ)行には字単位の強調を付けない', () => {
    expect(pair(sideRows([row('del', '消えた')])[0]).left?.parts).toBeNull();
    expect(pair(sideRows([row('add', '足した')])[0]).right?.parts).toBeNull();
  });
});

describe('#1231 sideRows: 字単位の強調', () => {
  it('🔴 入れ替わった対は、変わった字だけ changed(同じ字は changed でない)', () => {
    const p = pair(sideRows([row('del', 'いまの本文'), row('add', 'むかしの本文')])[0]);
    expect(p.left?.parts).toEqual([
      { text: 'いま', changed: true },
      { text: 'の本文', changed: false },
    ]);
    expect(p.right?.parts).toEqual([
      { text: 'むかし', changed: true },
      { text: 'の本文', changed: false },
    ]);
  });

  it('🔴 長い行(上限超え)は字単位をやめる(parts = null = 行ごと塗る)', () => {
    const long = 'あ'.repeat(CHAR_DIFF_MAX_CHARS + 1);
    const p = pair(sideRows([row('del', long), row('add', 'い' + long.slice(1))])[0]);
    expect(p.left?.parts).toBeNull();
    expect(p.right?.parts).toBeNull();
    // 対照: 上限ちょうどなら付く
    const at = 'あ'.repeat(CHAR_DIFF_MAX_CHARS);
    const q = pair(sideRows([row('del', at), row('add', 'い' + at.slice(1))])[0]);
    expect(q.left?.parts, '上限ちょうどで字単位が外れている').not.toBeNull();
  });

  it('🔴 総量の予算: 長い行が大量に入れ替わっても、予算を超えた対から行ごと塗りに落ちる(主スレッドを止めない)', () => {
    // 1 対あたりの見積もり(全部違う → 中身 = 1000 × 1000)
    const mid = 1000;
    const a = 'あ'.repeat(mid);
    const b = 'い'.repeat(mid);
    const fit = Math.floor(CHAR_DIFF_TOTAL_BUDGET / (mid * mid));
    const pairs = fit + 3;
    const rows: DiffRow[] = [];
    for (let i = 0; i < pairs; i++) rows.push(row('del', a));
    for (let i = 0; i < pairs; i++) rows.push(row('add', b));
    const out = sideRows(rows);
    const withParts = out.filter((r) => pair(r).left?.parts != null).length;
    expect(withParts, '予算の分だけ字単位で比べている').toBe(fit);
    expect(withParts).toBeLessThan(pairs);
  });

  it('本物の diffRows(相手, この版)から: 左右の字が往復する', () => {
    const other = '見出し\nいまの本文\n共通\n';
    const mine = '見出し\nむかしの本文\n共通\n追加\n';
    const out = sideRows(diffRows(other, mine));
    const lefts = out.flatMap((r) => (r.kind === 'pair' && r.left ? [r.left.text] : []));
    const rights = out.flatMap((r) => (r.kind === 'pair' && r.right ? [r.right.text] : []));
    expect(lefts).toEqual(['見出し', 'いまの本文', '共通']);
    expect(rights).toEqual(['見出し', 'むかしの本文', '共通', '追加']);
  });
});
