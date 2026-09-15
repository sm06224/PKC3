/**
 * 🔴 **ER の四角をどこに置くか**(#918 段⑤b)。
 *
 * ⚠ ここで守るのは 4 つ:
 * ① **決定的**(同じ構造なら毎回同じ絵 ── 押し所が回ごとに動かない)
 * ② **並び順**(指されている数 → 行数 → 名前。本体らしい表が左上へ来る)
 * ③ **幅が字から出ている**(全角を 1 と数えると、日本語の表名で必ず溢れる)
 * ④ **引けない線を黙って捨てない**(理由を持って返る)
 */
import { describe, expect, it } from 'vitest';
import {
  ER_COLUMNS_SHOWN,
  cellsOf,
  erLayout,
  erOrder,
  erHeadLabel,
} from '@features/query/er-layout';
import type { SchemaColumn, SchemaLink, SchemaModel, SchemaTable } from '@features/query/schema-digest';

const col = (name: string, type = 'TEXT'): SchemaColumn => ({
  name,
  type,
  notNull: false,
  primaryKey: false,
});

const tbl = (
  name: string,
  columns: readonly SchemaColumn[],
  rows: number | null = null,
  kind: 'table' | 'view' = 'table',
): SchemaTable => ({ name, kind, rows, columns });

const link = (from: string, fromColumn: string, to: string, toColumn: string): SchemaLink => ({
  from,
  fromColumn,
  to,
  toColumn,
});

const model = (tables: readonly SchemaTable[], links: readonly SchemaLink[] = []): SchemaModel => ({
  tables,
  links,
});

const BASE = model(
  [tbl('売上', [col('id'), col('客id'), col('金額', 'INTEGER')], 30), tbl('客', [col('id'), col('名前')], 4)],
  [link('売上', '客id', '客', 'id')],
);

describe('字の幅を数える', () => {
  it('🔴 全角は 2、半角は 1(空振り防止つき)', () => {
    expect(cellsOf('abc'), '半角が数えられていない').toBe(3);
    expect(cellsOf('売上'), '全角を 1 と数えている').toBe(4);
    expect(cellsOf('客id')).toBe(4);
    expect(cellsOf('')).toBe(0);
  });

  it('⚠ 半角カナは 1(全角と同じ扱いにすると、幅が倍に見積もられる)', () => {
    expect(cellsOf('ｱｲｳ')).toBe(3);
  });
});

describe('並べる順(#918 段⑤b)', () => {
  it('🔴 ① 指されている数が多い順', () => {
    const m = model(
      [tbl('a', [col('x')]), tbl('b', [col('x')]), tbl('c', [col('x')])],
      [link('a', 'x', 'c', 'x'), link('b', 'x', 'c', 'x')],
    );
    expect(erOrder(m).map((t) => t.name), '指されている表が先頭に来ていない').toEqual(['c', 'a', 'b']);
  });

  it('🔴 ② 同点なら行数が多い順。採れていない表はいちばん後ろ', () => {
    const m = model([tbl('a', [col('x')], null), tbl('b', [col('x')], 0), tbl('c', [col('x')], 9)]);
    expect(erOrder(m).map((t) => t.name)).toEqual(['c', 'b', 'a']);
  });

  it('🔴 ③ そこも同点なら名前順', () => {
    const m = model([tbl('z', [col('x')], 1), tbl('a', [col('x')], 1)]);
    expect(erOrder(m).map((t) => t.name)).toEqual(['a', 'z']);
  });

  it('🔴 採ってきた順を変えても、同じ並びになる(決定的)', () => {
    const a = erOrder(BASE).map((t) => t.name);
    const flipped = erOrder(model([...BASE.tables].reverse(), BASE.links)).map((t) => t.name);
    expect(flipped, '入力の順で絵が変わる').toEqual(a);
  });
});

describe('四角を並べる(#918 段⑤b)', () => {
  it('🔴 同じ構造なら、2 回組んでも 1 ビットも違わない', () => {
    expect(erLayout(BASE)).toEqual(erLayout(BASE));
  });

  it('🔴 四角の幅は全部同じ(揃っていないと線が読めない)', () => {
    const d = erLayout(BASE);
    expect(d.boxes.length).toBe(2);
    expect(d.boxes[0]!.rect.w).toBe(d.boxes[1]!.rect.w);
  });

  it('🔴 長い日本語の名前があると、四角が広くなる', () => {
    const narrow = erLayout(model([tbl('a', [col('x')])]));
    const wide = erLayout(model([tbl('とてもながいなまえのひょう', [col('x')])]));
    expect(wide.boxes[0]!.rect.w, '全角の名前で広がっていない').toBeGreaterThan(
      narrow.boxes[0]!.rect.w,
    );
  });

  it('⚠ ただし上限で止まる(器を横に突き抜けない)', () => {
    const huge = erLayout(model([tbl('あ'.repeat(200), [col('x')])]));
    expect(huge.boxes[0]!.rect.w).toBeLessThanOrEqual(280);
  });

  it('🔴 列が多い表は畳む(先頭 8 件 + ほか N 件)', () => {
    const many = Array.from({ length: 11 }, (_, i) => col(`c${String(i)}`));
    const d = erLayout(model([tbl('t', many)]));
    const box = d.boxes[0]!;
    expect(box.columns.length, '畳んでいない').toBe(ER_COLUMNS_SHOWN);
    expect(box.hidden, '畳んだ数が合わない').toBe(3);
    // ⚠ 畳んだ表は「ほか N 列」の 1 行ぶん背が高い(その行の場所が要る)
    const eight = erLayout(model([tbl('t', many.slice(0, 8))]));
    expect(box.rect.h, '「ほか N 列」の行ぶんの高さが無い').toBeGreaterThan(
      eight.boxes[0]!.rect.h,
    );
  });

  it('🔴 格子に並ぶ(1 行に ceil(sqrt(N)) 個)', () => {
    const tables = Array.from({ length: 5 }, (_, i) => tbl(`t${String(i)}`, [col('x')]));
    const d = erLayout(model(tables));
    const xs = d.boxes.map((b) => b.rect.x);
    const ys = d.boxes.map((b) => b.rect.y);
    // 5 件 → 1 行に 3 個 → 2 行
    expect(new Set(xs).size, '横の位置が 3 通りでない').toBe(3);
    expect(new Set(ys).size, '縦の位置が 2 通りでない').toBe(2);
    expect(ys[0]).toBe(ys[2]);
    expect(ys[3]).toBeGreaterThan(ys[0]!);
  });

  it('⚠ 四角どうしが重ならない', () => {
    const tables = Array.from({ length: 7 }, (_, i) => tbl(`t${String(i)}`, [col('x'), col('y')]));
    const d = erLayout(model(tables));
    for (let i = 0; i < d.boxes.length; i += 1) {
      for (let j = i + 1; j < d.boxes.length; j += 1) {
        const a = d.boxes[i]!.rect;
        const b = d.boxes[j]!.rect;
        const apart =
          a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
        expect(apart, `${String(i)} と ${String(j)} が重なっている`).toBe(true);
      }
    }
  });

  it('⚠ 器の大きさは、いちばん右下の四角まで届く', () => {
    const d = erLayout(BASE);
    for (const b of d.boxes) {
      expect(d.width).toBeGreaterThanOrEqual(b.rect.x + b.rect.w);
      expect(d.height).toBeGreaterThanOrEqual(b.rect.y + b.rect.h);
    }
  });

  it('⚠ 表が 1 つも無いと、空の絵を返す(例外を投げない)', () => {
    const d = erLayout(model([]));
    expect(d.boxes).toEqual([]);
    expect(d.width).toBe(0);
  });
});

describe('線を引く(#918 段⑤b)', () => {
  it('🔴 繋がりが線になる(両端が四角の辺に載る)', () => {
    const d = erLayout(BASE);
    expect(d.lines.length, '線が引けていない').toBe(1);
    const { line } = d.lines[0]!;
    const rects = d.boxes.map((b) => b.rect);
    const onEdge = (x: number, y: number): boolean =>
      rects.some(
        (r) =>
          (x === r.x || x === r.x + r.w || x === r.x + r.w / 2) &&
          (y === r.y || y === r.y + r.h || y === r.y + r.h / 2),
      );
    expect(onEdge(line.x1, line.y1), '始点が四角の辺に載っていない').toBe(true);
    expect(onEdge(line.x2, line.y2), '終点が四角の辺に載っていない').toBe(true);
  });

  it('🔴 相手が図に居ない繋がりは、理由を持って落ちる', () => {
    const m = model([tbl('売上', [col('客id')])], [link('売上', '客id', '客', 'id')]);
    const d = erLayout(m);
    expect(d.lines, '引けないのに線が出ている').toEqual([]);
    expect(d.dropped.length).toBe(1);
    expect(d.dropped[0]!.why, '理由に相手の名前が無い').toContain('客');
  });

  it('🔴 自分自身を指す繋がりは、点になるので線にしない(理由つき)', () => {
    const m = model([tbl('社員', [col('id'), col('上司id')])], [link('社員', '上司id', '社員', 'id')]);
    const d = erLayout(m);
    expect(d.lines).toEqual([]);
    expect(d.dropped[0]!.why).toContain('自分自身');
  });

  it('⚠ 空振り防止 ── 見出しの字に、表かビューかと行数が出ている', () => {
    expect(erHeadLabel(tbl('売上', [], 30))).toBe('売上(表・30 行)');
    expect(erHeadLabel(tbl('recent', [], null, 'view'))).toBe('recent(ビュー)');
  });
});
