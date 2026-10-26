/**
 * 🔴 **差分マージの核**(#1231)。期待値は手で書いた固定の字と、「全部そろえたら左右が一致する」という独立の不変量で守る。
 */
import { describe, expect, it } from 'vitest';
import {
  buildMergeSegs,
  countHunks,
  isMerged,
  MERGE_MAX_LINES,
  MergeSession,
  mergeRows,
  mergeText,
  resolveAll,
  resolveHunk,
} from '../../src/features/revision/merge-hunks';

const L = 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n';
const R = 'a\nB\nc\nd\ne\nf\ng\nh\nI\nj\nk\n';

describe('塊の作り方', () => {
  it('同じ文章は、ちがいの塊が 0', () => {
    const segs = buildMergeSegs(L, L)!;
    expect(countHunks(segs)).toBe(0);
    expect(isMerged(segs)).toBe(true);
    expect(mergeText(segs, 'a')).toBe(L);
  });
  it('変わった所ごとに 1 つの塊(続く削除と追加は 1 つ)', () => {
    const segs = buildMergeSegs(L, R)!;
    // b→B / i→I / k の追加 の 3 か所
    expect(countHunks(segs)).toBe(3);
    const first = segs.find((s) => s.kind === 'change');
    expect(first).toEqual({ kind: 'change', a: ['b\n'], b: ['B\n'] });
  });
  it('どちらの全文も、塊から元どおりに戻る', () => {
    const segs = buildMergeSegs(L, R)!;
    expect(mergeText(segs, 'a')).toBe(L);
    expect(mergeText(segs, 'b')).toBe(R);
  });
  it('行末(CRLF・末尾の改行の有無)まで保つ', () => {
    const segs = buildMergeSegs('a\r\nb', 'a\r\nc\r\n')!;
    expect(mergeText(segs, 'a')).toBe('a\r\nb');
    expect(mergeText(segs, 'b')).toBe('a\r\nc\r\n');
    // 末尾の改行の有無だけが違う行も、塊として見える
    expect(countHunks(buildMergeSegs('x', 'x\n')!)).toBe(1);
  });
  it('空の文章との比較(全部が追加 / 全部が削除)', () => {
    expect(mergeText(buildMergeSegs('', 'a\nb\n')!, 'a')).toBe('');
    expect(countHunks(buildMergeSegs('', 'a\nb\n')!)).toBe(1);
    expect(countHunks(buildMergeSegs('a\nb\n', '')!)).toBe(1);
    expect(countHunks(buildMergeSegs('', '')!)).toBe(0);
  });
  it('行が多すぎるときは作らない(null)', () => {
    const big = 'x\n'.repeat(MERGE_MAX_LINES + 1);
    expect(buildMergeSegs(big, '')).toBeNull();
    expect(buildMergeSegs('', big)).toBeNull();
    // 対照: 上限ちょうどは作れる
    expect(buildMergeSegs('x\n'.repeat(MERGE_MAX_LINES), '')).not.toBeNull();
  });
});

describe('取り込む', () => {
  it('右の内容を左へ(from=b): その塊だけ左が右と同じになり、他の塊は動かない', () => {
    const segs = buildMergeSegs(L, R)!;
    const next = resolveHunk(segs, 0, 'b')!;
    expect(mergeText(next, 'a')).toBe('a\nB\nc\nd\ne\nf\ng\nh\ni\nj\n');
    expect(mergeText(next, 'b')).toBe(R);
    expect(countHunks(next)).toBe(2);
  });
  it('左の内容を右へ(from=a): その塊だけ右が左と同じになる', () => {
    const segs = buildMergeSegs(L, R)!;
    const next = resolveHunk(segs, 1, 'a')!;
    expect(mergeText(next, 'b')).toBe('a\nB\nc\nd\ne\nf\ng\nh\ni\nj\nk\n');
    expect(mergeText(next, 'a')).toBe(L);
  });
  it('末尾に足された行を左へ取り込む / 右から消す', () => {
    const segs = buildMergeSegs(L, R)!;
    expect(mergeText(resolveHunk(segs, 2, 'b')!, 'a')).toBe(`${L}k\n`);
    expect(mergeText(resolveHunk(segs, 2, 'a')!, 'b')).toBe(R.replace('k\n', ''));
  });
  it('範囲の外の塊は何もしない(null)', () => {
    const segs = buildMergeSegs(L, R)!;
    expect(resolveHunk(segs, 3, 'a')).toBeNull();
    expect(resolveHunk(segs, -1, 'a')).toBeNull();
  });
  it('🔴 不変量: 全部を左へそろえれば左右は一致する(右へも同じ)── 多様な入力で', () => {
    const cases: [string, string][] = [
      [L, R],
      ['', 'あ\nい\n'],
      ['あ\nい\nう\n', 'あ\nう\n'],
      ['x', 'x\ny'],
      ['1\n2\n3\n4\n5\n6\n', '6\n5\n4\n3\n2\n1\n'],
      ['同じ\n', '同じ\n'],
      ['a\r\nb\r\n', 'a\nb\n'],
    ];
    for (const [a, b] of cases) {
      const segs = buildMergeSegs(a, b)!;
      const toLeft = resolveAll(segs, 'b');
      expect(mergeText(toLeft, 'a'), JSON.stringify([a, b])).toBe(b);
      expect(mergeText(toLeft, 'b')).toBe(b);
      expect(countHunks(toLeft)).toBe(0);
      const toRight = resolveAll(segs, 'a');
      expect(mergeText(toRight, 'b')).toBe(a);
      expect(mergeText(toRight, 'a')).toBe(a);
    }
  });
});

describe('取り消しの控え', () => {
  it('取り込み → 元に戻す → やり直す → 読み込んだ状態に戻す', () => {
    const m = new MergeSession(buildMergeSegs(L, R)!);
    expect(m.canUndo).toBe(false);
    expect(m.take(0, 'b')).toBe(true);
    expect(countHunks(m.segs)).toBe(2);
    expect(m.canUndo).toBe(true);
    expect(m.undoOne()).toBe(true);
    expect(countHunks(m.segs)).toBe(3);
    expect(m.canRedo).toBe(true);
    expect(m.redoOne()).toBe(true);
    expect(countHunks(m.segs)).toBe(2);
    m.take(0, 'a');
    m.reset();
    expect(countHunks(m.segs)).toBe(3);
    expect(m.canUndo).toBe(false);
    expect(m.canRedo).toBe(false);
  });
  it('新しく取り込むと、やり直しの控えは捨てる。空の控えを戻しても何も起きない', () => {
    const m = new MergeSession(buildMergeSegs(L, R)!);
    expect(m.undoOne()).toBe(false);
    expect(m.redoOne()).toBe(false);
    m.take(0, 'b');
    m.undoOne();
    expect(m.canRedo).toBe(true);
    m.take(1, 'b');
    expect(m.canRedo).toBe(false);
  });
  it('残りを全部そろえる。ちがいが無ければ何もしない(控えも積まない)', () => {
    const m = new MergeSession(buildMergeSegs(L, R)!);
    expect(m.takeAll('b')).toBe(true);
    expect(mergeText(m.segs, 'a')).toBe(R);
    expect(m.takeAll('b')).toBe(false);
    m.undoOne();
    expect(countHunks(m.segs)).toBe(3);
  });
});

describe('画面の行', () => {
  it('変わった塊の前後 2 行だけ残して、同じ行の長い並びを畳む', () => {
    const rows = mergeRows(buildMergeSegs(L, R)!);
    expect(rows.map((r) => r.kind)).toEqual(['same', 'change', 'same', 'same', 'gap', 'same', 'same', 'change', 'same', 'change']);
    const gap = rows.find((r) => r.kind === 'gap');
    // c d e f g h のうち前後 2 行ずつ(c d / g h)を残して、真ん中の e f の 2 行
    expect(gap).toEqual({ kind: 'gap', skipped: 2 });
  });
  it('「同じ行も全部出す」では畳まない', () => {
    const rows = mergeRows(buildMergeSegs(L, R)!, true);
    expect(rows.some((r) => r.kind === 'gap')).toBe(false);
    expect(rows.filter((r) => r.kind === 'same')).toHaveLength(8);
  });
  it('全部同じ文章は、畳まずにそのまま全部出す', () => {
    const rows = mergeRows(buildMergeSegs('a\nb\nc\n', 'a\nb\nc\n')!);
    expect(rows.map((r) => r.kind)).toEqual(['same', 'same', 'same']);
  });
  it('行が入れ替わった塊は、変わった字だけに印が付く(字単位の強調)', () => {
    const rows = mergeRows(buildMergeSegs('東京都新宿区\n', '東京都渋谷区\n')!);
    const change = rows.find((r) => r.kind === 'change');
    expect(change?.kind).toBe('change');
    if (change?.kind !== 'change') return;
    expect(change.hunk).toBe(0);
    expect(change.pairs).toHaveLength(1);
    const left = change.pairs[0]!.left!;
    expect(left.kind).toBe('del');
    expect(left.parts?.filter((p) => p.changed).map((p) => p.text)).toEqual(['新宿']);
    expect(change.pairs[0]!.right!.parts?.filter((p) => p.changed).map((p) => p.text)).toEqual(['渋谷']);
  });
  it('削除だけ・追加だけの塊は、反対側が空の升', () => {
    const rows = mergeRows(buildMergeSegs('a\nb\n', 'a\n')!);
    const change = rows.find((r) => r.kind === 'change');
    if (change?.kind !== 'change') throw new Error('塊が無い');
    expect(change.pairs[0]!.left?.text).toBe('b');
    expect(change.pairs[0]!.right).toBeNull();
  });
  it('塊の番号は上から 0 始まりで、取り込み後は番号が詰める', () => {
    const segs = buildMergeSegs(L, R)!;
    const hunks = (s: typeof segs): number[] =>
      mergeRows(s, true).flatMap((r) => (r.kind === 'change' ? [r.hunk] : []));
    expect(hunks(segs)).toEqual([0, 1, 2]);
    expect(hunks(resolveHunk(segs, 0, 'a')!)).toEqual([0, 1]);
  });
});
