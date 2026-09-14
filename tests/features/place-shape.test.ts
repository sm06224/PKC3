/**
 * 🔴 **板の形**(#530 案 A。user 裁定 2026-09-14)。
 *
 * 綴りの表は `src/features/markdown/place-shape.ts` の 1 本で、読む所が 4 つある
 * (記法 / 画面の CSS / 書き出しの読み取り / PowerPoint の図形名)。
 * ⚠ **型が効くのは 3 つだけ** ── CSS は字なので、ここで**全数**突き合わせる
 * (CLAUDE.md §7「同じ値が複数の場所にある」)。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  PLACE_SHAPES,
  PLACE_SHAPE_LABELS,
  isPlaceShape,
  placeShapeOf,
  type PlaceShape,
} from '../../src/features/markdown/place-shape';
import { placeShapeAt, setPlaceShape } from '../../src/features/markdown/place-notation';

const OPEN = ':::format{.pkc-place x=10 y=20 w=240 h=120}';
const body = (open: string): string => `${open}\nメモ\n:::\n`;
const target = (open: string) => ({ line: 0, openLine: open });

describe('綴りの表(place-shape.ts)', () => {
  it('🔴 既定は四角 ── 札が無い・知らない字は rect', () => {
    expect(placeShapeOf(undefined)).toBe('rect');
    expect(placeShapeOf('')).toBe('rect');
    // ⚠ **素通しにしない**(PowerPoint の XML へ知らない図形名が漏れる)
    expect(placeShapeOf('wedgeRoundRectCallout')).toBe('rect');
    expect(placeShapeOf(42)).toBe('rect');
  });

  it('許す綴りだけ true', () => {
    for (const sh of PLACE_SHAPES) expect(isPlaceShape(sh), sh).toBe(true);
    expect(isPlaceShape('circle')).toBe(false);
    expect(isPlaceShape(null)).toBe(false);
  });

  it('⚠ 呼び名が全部の形に在る(足したのに名前が無い形を作らない)', () => {
    for (const sh of PLACE_SHAPES) {
      expect(PLACE_SHAPE_LABELS[sh], sh).toBeTruthy();
      // ⚠ 内部の綴りを画面に出さない(user は `ellipse` を読まない)
      expect(PLACE_SHAPE_LABELS[sh], `${sh} の呼び名が内部の綴りのまま`).not.toContain(sh);
    }
  });
});

describe('記法へ書く(setPlaceShape)', () => {
  it('🔴 開き行に shape= を足す ── ほかの札は 1 つも動かさない', () => {
    const next = setPlaceShape(body(OPEN), target(OPEN), 'diamond');
    expect(next?.split('\n')[0]).toBe(
      ':::format{.pkc-place x=10 y=20 w=240 h=120 shape=diamond}',
    );
    // ⚠ 中身と閉じは無傷
    expect(next?.split('\n').slice(1)).toEqual(['メモ', ':::', '']);
  });

  it('もう一度変えると、札は 1 つのまま差し替わる(2 つ目を作らない)', () => {
    const once = setPlaceShape(body(OPEN), target(OPEN), 'ellipse')!;
    const open2 = once.split('\n')[0]!;
    const twice = setPlaceShape(once, target(open2), 'arrow')!;
    const line = twice.split('\n')[0]!;
    expect(line).toContain('shape=arrow');
    expect(line.match(/shape=/g), '札が 2 つできた').toHaveLength(1);
  });

  it('🔴 四角へ戻すのは shape=rect を書く(札を消す経路を作らない)', () => {
    const once = setPlaceShape(body(OPEN), target(OPEN), 'diamond')!;
    const open2 = once.split('\n')[0]!;
    const back = setPlaceShape(once, target(open2), 'rect')!;
    expect(back.split('\n')[0]).toContain('shape=rect');
    expect(placeShapeAt(back.split('\n')[0]!)).toBe('rect');
  });

  it('同じ形をもう一度選んだら body をそのまま返す(更新日時を動かさない)', () => {
    const once = setPlaceShape(body(OPEN), target(OPEN), 'round')!;
    const open2 = once.split('\n')[0]!;
    expect(setPlaceShape(once, target(open2), 'round')).toBe(once);
  });

  it('🔴 開き行がずれていたら断る(別の窓が書いた板を動かさない)', () => {
    expect(setPlaceShape(body(OPEN), target(':::format{.pkc-place x=99 y=99}'), 'round')).toBeNull();
  });

  it('🔴 知らない綴りは断る(PowerPoint へ漏らさない)', () => {
    // ⚠ 型では止まらない経路(境界を越えてきた値)を模す
    const bogus = 'wedgeEllipseCallout' as unknown as PlaceShape;
    expect(setPlaceShape(body(OPEN), target(OPEN), bogus)).toBeNull();
  });

  it('板でない行は null(placeShapeAt)', () => {
    expect(placeShapeAt('## 見出し')).toBeNull();
    expect(placeShapeAt(':::format{.pkc-note}')).toBeNull();
  });
});

/**
 * 🔴 **画面の規則は字なので、型が守れない**(§7)── ここが唯一の門である。
 * ⚠ **注釈を落としてから見る** ── 解説コメントに綴りを書くと、
 *   **自分の説明に満たされて**規則が無くても緑になる(CLAUDE.md §1 の 5 度目・10 度目)。
 */
describe('画面の規則(app.css)と、綴りの表が揃っている', () => {
  const cssNoComments = readFileSync('src/styles/app.css', 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '');

  it('🔴 四角でない形は、全部 app.css に規則が在る', () => {
    const shaped = PLACE_SHAPES.filter((s) => s !== 'rect');
    expect(shaped.length, '形が 1 つも無い(空振り)').toBeGreaterThan(0);
    for (const sh of shaped) {
      expect(
        cssNoComments,
        `${sh} の規則が app.css に無い ── 選んでも見た目が 1 ドットも変わらない`,
      ).toContain(`[data-pkc-shape='${sh}']`);
    }
  });

  it('⚠ 空振り防止 ── 在りもしない形は当たらない', () => {
    expect(cssNoComments).not.toContain("[data-pkc-shape='circle']");
  });

  it('🔴 四角(既定)には規則を足さない ── 既に置いてある板の見え方を変えない', () => {
    expect(
      cssNoComments,
      "shape='rect' の規則を足すと、札の無い板と見え方が分かれる",
    ).not.toContain("[data-pkc-shape='rect']");
  });
});
