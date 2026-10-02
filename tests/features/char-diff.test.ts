/**
 * #1231 段①: 入れ替わった行の中で、**変わった字だけ**を見つける(`charDiff`)。
 *
 * 🔑 観測点は 2 つ: ①**区切り**(どの字が same / add / del か)②**往復**(`same + del` = a、`same + add` = b)。
 *   ②は区切りの正解を 1 つも書かずに**どの入力でも**成り立つ不変量 ── 期待値を実装の綴りから作らない。
 */
import { describe, expect, it } from 'vitest';
import {
  CHAR_DIFF_MAX_CHARS,
  charDiff,
  charDiffCost,
  type CharSeg,
} from '../../src/features/revision/char-diff';

const join = (segs: CharSeg[], ...kinds: CharSeg['kind'][]): string =>
  segs
    .filter((s) => kinds.includes(s.kind))
    .map((s) => s.text)
    .join('');

function roundTrip(a: string, b: string): CharSeg[] {
  const segs = charDiff(a, b);
  expect(segs, `上限内なのに比べていない: ${JSON.stringify([a, b])}`).not.toBeNull();
  expect(join(segs!, 'same', 'del'), `a に戻らない: ${JSON.stringify(segs)}`).toBe(a);
  expect(join(segs!, 'same', 'add'), `b に戻らない: ${JSON.stringify(segs)}`).toBe(b);
  return segs!;
}

describe('#1231 charDiff: 字単位', () => {
  it('同じ行は 1 つの same(印を付ける所が無い)', () => {
    expect(roundTrip('牛乳を買う', '牛乳を買う')).toEqual([{ kind: 'same', text: '牛乳を買う' }]);
  });

  it('🔴 先頭だけ違う: 先頭の字だけが変わり、残りは same', () => {
    expect(roundTrip('いまの本文', 'むかしの本文')).toEqual([
      { kind: 'del', text: 'いま' },
      { kind: 'add', text: 'むかし' },
      { kind: 'same', text: 'の本文' },
    ]);
  });

  it('🔴 末尾だけ違う', () => {
    expect(roundTrip('牛乳を買う', '牛乳を買った')).toEqual([
      { kind: 'same', text: '牛乳を買' },
      { kind: 'del', text: 'う' },
      { kind: 'add', text: 'った' },
    ]);
    expect(roundTrip('会議は 10 時', '会議は 11 時')).toEqual([
      { kind: 'same', text: '会議は 1' },
      { kind: 'del', text: '0' },
      { kind: 'add', text: '1' },
      { kind: 'same', text: ' 時' },
    ]);
  });

  it('🔴 途中だけ違う(前後が同じ)', () => {
    expect(roundTrip('あいうえお', 'あいXXえお')).toEqual([
      { kind: 'same', text: 'あい' },
      { kind: 'del', text: 'う' },
      { kind: 'add', text: 'XX' },
      { kind: 'same', text: 'えお' },
    ]);
  });

  it('途中への差し込み / 途中の削除(片方の面にだけ出る)', () => {
    expect(roundTrip('あいえお', 'あいうえお')).toEqual([
      { kind: 'same', text: 'あい' },
      { kind: 'add', text: 'う' },
      { kind: 'same', text: 'えお' },
    ]);
    expect(roundTrip('あいうえお', 'あいえお')).toEqual([
      { kind: 'same', text: 'あい' },
      { kind: 'del', text: 'う' },
      { kind: 'same', text: 'えお' },
    ]);
  });

  it('全部違う: same が 1 つも無い', () => {
    const segs = roundTrip('あいう', 'かきく');
    expect(segs.some((s) => s.kind === 'same')).toBe(false);
  });

  it('空: 空 → 空 / 空 → 字 / 字 → 空', () => {
    expect(charDiff('', '')).toEqual([]);
    expect(roundTrip('', 'あ')).toEqual([{ kind: 'add', text: 'あ' }]);
    expect(roundTrip('あ', '')).toEqual([{ kind: 'del', text: 'あ' }]);
  });

  it('⚠ 絵文字を半分に割らない(コードポイント単位)', () => {
    expect(roundTrip('a😀b', 'a😁b')).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'del', text: '😀' },
      { kind: 'add', text: '😁' },
      { kind: 'same', text: 'b' },
    ]);
  });

  it('⚠ 前後が重なる形(aa → aaa)でも往復する(先頭と末尾を二重に数えない)', () => {
    roundTrip('aa', 'aaa');
    roundTrip('abab', 'ab');
    roundTrip('xyx', 'xx');
  });

  it('🔴 上限: 片方が CHAR_DIFF_MAX_CHARS 字ちょうどなら比べる / 1 字超えたら null(行ごと塗る側へ倒す)', () => {
    expect(CHAR_DIFF_MAX_CHARS).toBe(2000);
    const at = 'あ'.repeat(CHAR_DIFF_MAX_CHARS);
    expect(charDiff(at, at)).not.toBeNull();
    expect(charDiff(at, 'い' + at.slice(1))).not.toBeNull();
    const over = at + 'あ';
    expect(charDiff(over, at), '左が上限を超えているのに比べた').toBeNull();
    expect(charDiff(at, over), '右が上限を超えているのに比べた').toBeNull();
  });

  it('⚠ 上限の数え方は字(コードポイント)── 絵文字 2000 個は UTF-16 では 4000 だが比べる', () => {
    const emoji = '😀'.repeat(CHAR_DIFF_MAX_CHARS);
    expect(charDiff(emoji, emoji.slice(2))).not.toBeNull();
  });

  it('総当たり: 小さな字母で全組を作り、どの入力でも往復する', () => {
    const all: string[] = [''];
    let frontier: string[] = [''];
    for (let n = 1; n <= 5; n++) {
      frontier = frontier.flatMap((p) => [p + 'a', p + 'b']);
      all.push(...frontier);
    }
    for (const a of all) for (const b of all) roundTrip(a, b);
  });

  it('charDiffCost: 前後の同じ所を除いた中身の大きさ(同じ行は 0)', () => {
    expect(charDiffCost('あいう', 'あいう')).toBe(0);
    expect(charDiffCost('いまの本文', 'むかしの本文')).toBe(2 * 3);
  });
});
