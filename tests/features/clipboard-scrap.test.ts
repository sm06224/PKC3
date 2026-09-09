/**
 * 🔴 **溜めてから貼る**(#679)の純粋な層。
 *
 * ⚠ ここが守るのは 3 つ:①**並びは user が決める**(コピー順ではない)
 * ②**履歴から消えた物の印は落ちる**(押せない印を並べない / 空行を増やさない)
 * ③**繋ぎは空行 1 つ**(`\n` 1 つだと `breaks: true` で 1 段落に潰れる)。
 */
import { describe, expect, it } from 'vitest';
import type { CopiedItem } from '../../src/features/clipboard/history';
import {
  joinCopied,
  moveMark,
  pickMarked,
  pruneMarks,
  toggleMark,
} from '../../src/features/clipboard/scrap';

const item = (text: string, at = 0): CopiedItem => ({ at, text, html: '' });
const LIST: CopiedItem[] = [item('あ', 3), item('い', 2), item('う', 1)];

describe('印を付ける / 外す', () => {
  it('付けた順に後ろへ積む(選んだ順が既定の並び)', () => {
    expect(toggleMark(toggleMark([], 'う'), 'あ')).toEqual(['う', 'あ']);
  });

  it('もう一度押すと外れる', () => {
    expect(toggleMark(['う', 'あ'], 'う')).toEqual(['あ']);
  });

  /** ⚠ 選び直したら「いちばん新しい意思」なので末尾へ回る。 */
  it('外して付け直すと末尾へ回る', () => {
    expect(toggleMark(toggleMark(['う', 'あ'], 'う'), 'う')).toEqual(['あ', 'う']);
  });
});

describe('並べ替える', () => {
  it('掴んで動かせる', () => {
    expect(moveMark(['あ', 'い', 'う'], 2, 0)).toEqual(['う', 'あ', 'い']);
  });

  /** 🔴 範囲の外は動かさない ── 端へ丸めると「勝手に先頭へ飛んだ」と見える。 */
  it.each([
    ['下へ外した', 1, 5],
    ['上へ外した', 1, -1],
    ['掴んだ所が無い', 9, 0],
  ])('%s ときは動かさない', (_name, from, to) => {
    expect(moveMark(['あ', 'い', 'う'], from as number, to as number)).toEqual(['あ', 'い', 'う']);
  });
});

describe('取り出す', () => {
  it('🔴 印の並びで返る(履歴の並びではない)', () => {
    expect(pickMarked(LIST, ['う', 'あ']).map((c) => c.text)).toEqual(['う', 'あ']);
  });

  /** 🔴 別のタブが消した物は落ちる ── 残すと貼った本文に空行だけが増える。 */
  it('履歴から消えた物は落ちる', () => {
    expect(pickMarked([item('あ')], ['う', 'あ']).map((c) => c.text)).toEqual(['あ']);
  });

  it('印そのものも、生きている物だけへ揃えられる', () => {
    expect(pruneMarks([item('あ')], ['う', 'あ'])).toEqual(['あ']);
  });
});

describe('まとめて 1 本の字にする', () => {
  it('🔴 空行 1 つで繋ぐ(`\\n` 1 つだと 1 段落に潰れる)', () => {
    expect(joinCopied([item('あ'), item('い')])).toBe('あ\n\nい');
  });

  /** ⚠ 端の空白は落とすが、**中の形は 1 バイトも変えない**(表・コード塊が壊れる)。 */
  it('端は整えるが、中の改行や空白は残す', () => {
    expect(joinCopied([item('\n| a | b |\n| - | - |\n')])).toBe('| a | b |\n| - | - |');
  });

  it('空になった物は落とす(空行だけを増やさない)', () => {
    expect(joinCopied([item('あ'), item('   \n '), item('い')])).toBe('あ\n\nい');
  });

  it('0 件なら空 ──「貼る物が無い」は呼び側が言う', () => {
    expect(joinCopied([])).toBe('');
  });
});
