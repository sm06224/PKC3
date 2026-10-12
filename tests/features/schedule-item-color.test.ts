/** @vitest-environment node */
/**
 * 🔴 **予定の縦線の色の決め方**(#855。Gemini 裁定 = #1163 の依頼 20-A「両方」)。
 * 項目の行のタグの色 > ノートの色。ノートの色は id から自動で決まる(新しい設定は足さない)。
 */
import { describe, expect, it } from 'vitest';
import {
  NOTE_COLOR_COUNT,
  inlineTagsOf,
  noteColorIndex,
  noteColorVar,
  resolveItemColor,
} from '../../src/features/schedule/item-color';

const COLORS = [
  { tag: '仕事', color: '#aa3300' },
  { tag: 'Home', color: '#0033aa' },
];

describe('inlineTagsOf', () => {
  it('語頭の #タグを、書いた順に拾う', () => {
    expect(inlineTagsOf('打ち合わせ #仕事 資料 #急ぎ')).toEqual(['仕事', '急ぎ']);
    expect(inlineTagsOf('#仕事 先頭')).toEqual(['仕事']);
    // 全角空白の後ろも語頭
    expect(inlineTagsOf('会議　#仕事')).toEqual(['仕事']);
  });
  it('語の途中の # や、# だけの語はタグではない', () => {
    expect(inlineTagsOf('C# の勉強')).toEqual([]);
    expect(inlineTagsOf('https://x.example/a#frag')).toEqual([]);
    expect(inlineTagsOf('# だけ ## ふたつ')).toEqual([]);
  });
});

describe('noteColorIndex / noteColorVar', () => {
  it('同じ lid はいつも同じ番号で、範囲は 1〜NOTE_COLOR_COUNT', () => {
    for (const lid of ['e1', 'e2', 'abc', '日本語', '']) {
      const i = noteColorIndex(lid);
      expect(i).toBe(noteColorIndex(lid));
      expect(i).toBeGreaterThanOrEqual(1);
      expect(i).toBeLessThanOrEqual(NOTE_COLOR_COUNT);
      expect(noteColorVar(lid)).toBe(`var(--note-${i})`);
    }
  });
  it('lid が違えば色も散る(全部が同じ色に潰れない)', () => {
    const used = new Set<number>();
    for (let n = 0; n < 200; n++) used.add(noteColorIndex(`lid-${n}`));
    expect(used.size, '8 色のうち使われた色の数').toBe(NOTE_COLOR_COUNT);
  });
});

describe('resolveItemColor(タグ > ノート)', () => {
  it('色を決めたタグが行に在れば、そのタグの色', () => {
    expect(resolveItemColor({ lid: 'e1', text: '会議 #仕事' }, COLORS)).toEqual({
      color: '#aa3300',
      from: 'tag',
    });
  });
  it('タグが複数なら、色を持つ最初のタグ(色の無いタグは飛ばす)', () => {
    expect(resolveItemColor({ lid: 'e1', text: '#急ぎ #Home #仕事' }, COLORS).color).toBe('#0033aa');
  });
  it('大小違いのタグも同じタグとして引く(設定側と同じ鍵)', () => {
    expect(resolveItemColor({ lid: 'e1', text: '#home' }, COLORS).from).toBe('tag');
  });
  it('タグの無い行・色を決めていないタグだけの行は、ノートの色', () => {
    for (const text of ['会議', '会議 #急ぎ']) {
      expect(resolveItemColor({ lid: 'e1', text }, COLORS)).toEqual({
        color: noteColorVar('e1'),
        from: 'note',
      });
    }
  });
  it('対照群:タグの色の一覧が空なら、タグが在ってもノートの色(タグが勝つのは色があるときだけ)', () => {
    expect(resolveItemColor({ lid: 'e1', text: '会議 #仕事' }, []).from).toBe('note');
  });
});
