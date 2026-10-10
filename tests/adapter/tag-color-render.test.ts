/**
 * @vitest-environment happy-dom
 *
 * 🔴 タグの色を画面に当てる口(#1457)。
 *
 * 守るもの:①色を付けたタグの規則だけが `<style>` に入る ②空にすると `<style>` ごと消える(灰色に戻る)
 * ③「色を外す」ボタンは**色のあるタグでだけ**見える(押せない物を出さない)④色が変わったら
 * 既にある札の「色を外す」も出し分け直す。
 * 守っていないもの:計算後の色(happy-dom は属性選択子の `i` を解かない ── 実ブラウザの smoke が見る)。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  applyTagColors,
  currentTagColor,
  syncTagColorControls,
  tagColorControls,
} from '../../src/adapter/ui/render/tag-color';

const style = () => document.head.querySelector('style[data-pkc-field="tag-colors"]');

beforeEach(() => {
  applyTagColors(document, []);
  document.body.textContent = '';
});

describe('applyTagColors', () => {
  it('色を付けたタグの規則だけが入り、空にすると style ごと消える', () => {
    applyTagColors(document, [{ tag: '買い物', color: '#ff8800' }]);
    expect(style()?.textContent).toContain('data-pkc-tag-key="買い物"]');
    expect(style()?.textContent).not.toContain('急ぎ');
    expect(currentTagColor('買い物')).toBe('#ff8800');
    expect(currentTagColor('急ぎ')).toBeNull();
    applyTagColors(document, []);
    expect(style()).toBeNull();
    expect(currentTagColor('買い物')).toBeNull();
  });

  it('当て直しても style は 1 つのまま', () => {
    applyTagColors(document, [{ tag: 'a', color: '#111111' }]);
    applyTagColors(document, [{ tag: 'b', color: '#222222' }]);
    expect(document.head.querySelectorAll('style[data-pkc-field="tag-colors"]')).toHaveLength(1);
    expect(style()?.textContent).toContain('"b"]');
    expect(style()?.textContent).not.toContain('"a"]');
  });
});

describe('情報ペインの札の押し所', () => {
  it('🔑 「色を外す」は色の有るタグでだけ見え、色が変わると出し分け直す', () => {
    const wrap = document.createElement('div');
    wrap.append(...tagColorControls('買い物'), ...tagColorControls('急ぎ'));
    document.body.append(wrap);
    const clear = (tag: string) =>
      wrap.querySelector<HTMLElement>(
        `[data-pkc-action="tag-color-clear"][data-pkc-tag="${tag}"]`,
      )!;
    // 色が無い間は両方隠れている(押せない物を出さない)
    expect(clear('買い物').hidden).toBe(true);
    expect(clear('急ぎ').hidden).toBe(true);
    // 色を付けると、既にある札の「外す」が現れる(描き直しを待たない)
    applyTagColors(document, [{ tag: '買い物', color: '#ff8800' }]);
    expect(clear('買い物').hidden).toBe(false);
    expect(clear('急ぎ').hidden).toBe(true);
    // 外すと、また隠れる(付けられるなら外せて、外した後は何も残らない)
    applyTagColors(document, []);
    expect(clear('買い物').hidden).toBe(true);
    // 押し所は「付ける」側も常に在る
    expect(wrap.querySelectorAll('[data-pkc-action="tag-color-pick"]')).toHaveLength(2);
  });

  it('syncTagColorControls は大小違いの同じタグも同じに扱う', () => {
    applyTagColors(document, [{ tag: 'Work', color: '#123456' }]);
    const [, clear] = tagColorControls('work');
    document.body.append(clear!);
    syncTagColorControls(document);
    expect(clear!.hidden).toBe(false);
  });
});
