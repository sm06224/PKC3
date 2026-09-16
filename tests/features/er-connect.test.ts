/**
 * 🔴 **ER の図で、自分でキーどうしを繋ぐ**(#918 段⑤d-1)。
 *
 * ⚠ **外部キーを 1 本も宣言していない DB** を fixture に必ず 1 つ持つ ──
 *   段⑤ の検査はここまで外部キー付きの DB でしか通っておらず、それが
 *   「繋ぐ手段が画面に無い」という穴を見逃した原因である(CLAUDE.md §2)。
 */
import { describe, expect, it } from 'vitest';
import { erZeroLinesWhy, pickErConnection } from '@features/query/er-connect';
import type { SchemaLink, SchemaModel } from '@features/query/schema-digest';

const link = (from: string, fromColumn: string, to: string, toColumn: string): SchemaLink => ({
  from,
  fromColumn,
  to,
  toColumn,
});

/** 🔴 繋がりが 1 つも宣言されていない DB(csv 取込 / FK 無しの .sqlite を想定)。 */
const NO_FK_MODEL: SchemaModel = {
  tables: [
    { name: '売上', kind: 'table', rows: 3, columns: [] },
    { name: '客', kind: 'table', rows: 2, columns: [] },
    { name: '在庫', kind: 'table', rows: 5, columns: [] },
  ],
  links: [],
};

describe('pickErConnection(#918 段⑤d-1)', () => {
  it('🔴 1 列目を押すと「ここから」になる(まだ何も繋がらない)', () => {
    const r = pickErConnection(NO_FK_MODEL, [], null, '売上', '客id');
    expect(r).toEqual({ kind: 'from', pendingFrom: { table: '売上', column: '客id' } });
  });

  it('🔴 別の表の列を押すと繋がりができる ── 宣言 0 件の DB でも繋げる', () => {
    const r = pickErConnection(NO_FK_MODEL, [], { table: '売上', column: '客id' }, '客', 'id');
    expect(r).toEqual({
      kind: 'linked',
      link: link('売上', '客id', '客', 'id'),
    });
  });

  it('🔴 同じ列をもう一度押すとやめられる(cancel)', () => {
    const r = pickErConnection(NO_FK_MODEL, [], { table: '売上', column: '客id' }, '売上', '客id');
    expect(r).toEqual({ kind: 'cancel' });
  });

  it('⚠ 空振り防止 ── 「同じ列」の判定は表と列の両方が一致したときだけ', () => {
    // 表は同じだが列が違う ── cancel ではなく「同じ表」denied のほうへ落ちる
    const r = pickErConnection(NO_FK_MODEL, [], { table: '売上', column: '客id' }, '売上', '金額');
    expect(r.kind).not.toBe('cancel');
  });

  it('🔴 同じ表の中では繋げない(denied)', () => {
    const r = pickErConnection(NO_FK_MODEL, [], { table: '売上', column: '客id' }, '売上', '金額');
    expect(r).toEqual({ kind: 'denied', why: '同じ表の中では繋げません' });
  });

  it('🔴 もう在る繋がりと同じ組み合わせは denied(宣言された FK と重複)', () => {
    const model: SchemaModel = { ...NO_FK_MODEL, links: [link('売上', '客id', '客', 'id')] };
    const r = pickErConnection(model, [], { table: '売上', column: '客id' }, '客', 'id');
    expect(r).toEqual({ kind: 'denied', why: 'その 2 つはもう繋がっています' });
  });

  it('🔴 もう在る繋がりと同じ組み合わせは denied(自分で引いた mine と重複)', () => {
    const mine = [link('売上', '客id', '客', 'id')];
    const r = pickErConnection(NO_FK_MODEL, mine, { table: '売上', column: '客id' }, '客', 'id');
    expect(r).toEqual({ kind: 'denied', why: 'その 2 つはもう繋がっています' });
  });

  it('🔴 向きを変えても同じ繋がりとして denied(逆向きの押し直しをすり抜けさせない)', () => {
    const mine = [link('売上', '客id', '客', 'id')];
    // 今度は「客.id」から「売上.客id」へ ── 向きは逆だが同じ関係
    const r = pickErConnection(NO_FK_MODEL, mine, { table: '客', column: 'id' }, '売上', '客id');
    expect(r.kind, '向きを変えると別の繋がりとして通ってしまっている').toBe('denied');
  });

  it('⚠ 空振り防止 ── 違う列どうしなら、もう 1 本繋げる', () => {
    const mine = [link('売上', '客id', '客', 'id')];
    const r = pickErConnection(NO_FK_MODEL, mine, { table: '売上', column: '担当id' }, '在庫', 'id');
    expect(r).toEqual({ kind: 'linked', link: link('売上', '担当id', '在庫', 'id') });
  });

  it('⚠ model が null(まだ採れていない)でも、mine だけで重複を見る', () => {
    const mine = [link('売上', '客id', '客', 'id')];
    const r = pickErConnection(null, mine, { table: '売上', column: '客id' }, '客', 'id');
    expect(r.kind).toBe('denied');
  });
});

/**
 * 🔴 **線が 0 本の画面で、理由と次の一手を言う**(#918 段⑤d-3)。
 *
 * ⚠ ここで見るのは「**それらしい字が出るか**」ではなく、**場合ごとに字が変わるか**である ──
 *   1 つの文言を返すだけの実装でも「字が出た」は満たせてしまう(CLAUDE.md §1「空振り」)。
 */
describe('erZeroLinesWhy(#918 段⑤d-3)', () => {
  const base = { boxes: 3, declared: 0, mine: 0, dropped: 0, connecting: false };

  it('🔴 外部キーが 0 本なら、理由と「繋ぐ」への誘いを両方言う', () => {
    const s = erZeroLinesWhy(base);
    expect(s, '理由を言っていない').toContain('宣言していません');
    expect(s, '次に何を押せばよいか言っていない').toContain('繋ぐ');
  });

  it('🔴 「繋ぐ」が既に入なら、次の一手は言わない(すぐ下の案内と二重になる)', () => {
    const on = erZeroLinesWhy({ ...base, connecting: true });
    expect(on, '理由は言い続ける').toContain('宣言していません');
    expect(on, '入のときまで「繋ぐを押せ」と言っている').not.toContain('押して列を 2 つ');
    // ⚠ 対照群 ── 切のときは言う(言わない実装でも上だけなら通ってしまう)
    expect(erZeroLinesWhy(base), '切のときに次の一手が消えている').toContain('押して列を 2 つ');
  });

  it('🔴 表が 1 つだけなら「繋ぐ」を勧めない(同じ表の中は繋げないので押せない道になる)', () => {
    const s = erZeroLinesWhy({ ...base, boxes: 1 });
    expect(s, '相手がいないことを言っていない').toContain('繋ぐ相手がいません');
    expect(s, '押せない道へ誘っている').not.toContain('押して列を 2 つ');
  });

  it('🔴 繋がりは在るのに全部落ちたときは、別の理由を言う(「宣言していません」は嘘になる)', () => {
    const s = erZeroLinesWhy({ ...base, declared: 2, dropped: 2 });
    expect(s, '落ちたことを言っていない').toContain('線にできませんでした');
    expect(s, '在る物を「無い」と言っている').not.toContain('宣言していません');
    expect(s, '次の一手が消えている').toContain('繋ぐ');
  });

  it('⚠ 四角が 1 つも無いときは何も言わない(呼ぶ側が別の字を出している)', () => {
    expect(erZeroLinesWhy({ ...base, boxes: 0 })).toBe('');
  });

  it('⚠ 起きない形(繋がりが在って落ちてもいない)には、それらしい字を置かない', () => {
    expect(erZeroLinesWhy({ ...base, declared: 1, dropped: 0 })).toBe('');
  });
});
