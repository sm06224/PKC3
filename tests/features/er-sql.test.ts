/**
 * 🔴 **図で押した所から `SELECT` を組む**(#918 段⑤c)。
 *
 * ⚠ ここで守るのは 4 つ:
 * ① **打ちかけの字を捨てない**(足すだけ。捨てて書き直さない)
 * ② 🔴 **読めない字には足さず、理由を言う**(黙って書き換えない / 黙って何もしない、の両方を避ける)
 * ③ **`where` 以降を持ち越す**(絞り込みを書いた後でも列を足せる)
 * ④ **組んだ字が、いまの門をそのまま通る**(構造を採るのに門を緩めない、と同じ向き)
 */
import { describe, expect, it } from 'vitest';
import { erQuote, erSql, parseErSql } from '@features/query/er-sql';
import { checkReadOnlySql } from '@features/query/sql-guard';
import type { SchemaLink } from '@features/query/schema-digest';

const LINK: SchemaLink = { from: '売上', fromColumn: '客id', to: '客', toColumn: 'id' };
const table = (t: string) => ({ kind: 'table', table: t }) as const;
const column = (t: string, c: string) => ({ kind: 'column', table: t, column: c }) as const;
const linkAct = (l: SchemaLink = LINK) => ({ kind: 'link', link: l }) as const;

/** 足せたときだけ字を返す(足せなければ test をそこで落とす)。 */
function sql(current: string, action: Parameters<typeof erSql>[1]): string {
  const r = erSql(current, action);
  if (!r.ok) throw new Error(`足せなかった: ${r.why}`);
  return r.sql;
}

/** 足せなかったときの理由(足せてしまったら落とす)。 */
function why(current: string, action: Parameters<typeof erSql>[1]): string {
  const r = erSql(current, action);
  if (r.ok) throw new Error(`足さないはずが足した: ${r.sql}`);
  return r.why;
}

describe('名前を SQL に書ける形にする', () => {
  it('🔴 日本語は裸のまま(囲うと読みにくいだけ)', () => {
    expect(erQuote('売上')).toBe('売上');
    expect(erQuote('客id')).toBe('客id');
  });

  it('🔴 予約語と記号つきの名前は囲う', () => {
    expect(erQuote('order'), '予約語を裸で書いている').toBe('"order"');
    expect(erQuote('my table')).toBe('"my table"');
    expect(erQuote('a-b')).toBe('"a-b"');
    // ⚠ 名前の中の `"` は 2 つ重ねる(sqlite の決まり)
    expect(erQuote('a"b')).toBe('"a""b"');
  });

  it('⚠ 数で始まる名前も囲う(裸だと数として読まれる)', () => {
    expect(erQuote('1st')).toBe('"1st"');
  });
});

describe('こちらが組んだ形かどうかを読む', () => {
  it('読める形', () => {
    const s = parseErSql('select * from 売上');
    expect(s, '素直な形が読めていない').not.toBeNull();
    expect(s!.columnsRaw).toBe('*');
    expect(s!.tables).toEqual(['売上']);
  });

  it('🔴 読めない形は null(= 足さない)', () => {
    for (const bad of [
      'update t set a = 1',
      'select 1',
      /**
       * 🔴 **先頭が `select` かどうかを、本当に見ているか**(変異試験 S2 が SURVIVED で教えた)。
       * ⚠ ほかの 7 つは**別の門**(`from` が無い / 列が空 / 閉じていない引用符 / `join` の
       *   相手や `on` が無い)で先に落ちるので、**先頭語の判定を丸ごと外しても緑**だった
       *   ── 守っているつもりの物と、実際に守られている物が違う形である(CLAUDE.md §1)。
       * 🔑 だから「**先頭だけが違って、後ろは正しい `… from …` の形**」を 1 つ置く。
       */
      'foo bar from t',
      'select * from t junk 2',
      'select * from t join u',
      'select * from t join u on',
      'select * from "t',
      'delete from t',
      '',
    ]) {
      expect(parseErSql(bad), `読めないはずの字を読んだ: ${bad}`).toBeNull();
    }
  });

  it('⚠ 引用符の中の空白で切らない', () => {
    const s = parseErSql('select * from "my table"');
    expect(s!.tables, '引用符の中で切っている').toEqual(['my table']);
  });

  it('⚠ 副問い合わせの中の from に当たらない', () => {
    const s = parseErSql('select (select 1 from x) as a from 売上');
    expect(s!.tables).toEqual(['売上']);
    expect(s!.columnsRaw).toBe('(select 1 from x) as a');
  });

  it('⚠ where 以降は「絞り込み」として丸ごと持つ', () => {
    const s = parseErSql('select * from 売上 where 金額 > 100 order by 金額');
    expect(s!.trailerRaw).toBe('where 金額 > 100 order by 金額');
  });

  /**
   * ⚠ **絞り込みの中身は読まない**(1 稿目はここを「読めない字」に数えていて落ちた)。
   * 🔑 こちらは絞り込みを **1 バイトも触らない**ので、正しいかどうかを見る立場に無い ──
   *   壊れていれば sqlite がそう言う。⚠ ここで断ると、打ちかけの絞り込みがあるだけで
   *   **図が丸ごと効かなくなる**(そちらのほうが害が大きい)。
   */
  it('⚠ 絞り込みが打ちかけでも、そこから先は読まずに持ち越す', () => {
    const s = parseErSql('select * from t group');
    expect(s, '絞り込みが打ちかけだと図ごと効かなくなる').not.toBeNull();
    expect(s!.trailerRaw).toBe('group');
    expect(s!.tables).toEqual(['t']);
  });
});

describe('押した所から足す(#918 段⑤c)', () => {
  it('🔴 空の欄 + 表 → その表から全部取る', () => {
    expect(sql('', table('売上'))).toBe('select * from 売上');
  });

  it('🔴 `*` のときに列を押すと、`*` が退く', () => {
    expect(sql('select * from 売上', column('売上', '金額'))).toBe('select 金額 from 売上');
  });

  it('🔴 2 つ目の列は後ろに足す(打った字はそのまま)', () => {
    expect(sql('select 金額 from 売上', column('売上', '客id'))).toBe('select 金額, 客id from 売上');
  });

  it('🔴 線を押すと JOIN が付く(相手の列で繋ぐ)', () => {
    expect(sql('select * from 売上', linkAct())).toBe(
      'select * from 売上\n  join 客 on 客.id = 売上.客id',
    );
  });

  it('🔴 どちら側から始めても繋がる', () => {
    expect(sql('select * from 客', linkAct())).toBe(
      'select * from 客\n  join 売上 on 客.id = 売上.客id',
    );
  });

  it('🔴 表が 2 つになったら、列は「表.列」で足す(どちらの列か分かるように)', () => {
    const joined = 'select * from 売上\n  join 客 on 客.id = 売上.客id';
    expect(sql(joined, column('客', '名前'))).toBe(
      'select 客.名前 from 売上\n  join 客 on 客.id = 売上.客id',
    );
  });

  it('🔴 `where` を書いた後でも列を足せる(絞り込みは 1 バイトも触らない)', () => {
    expect(sql('select * from 売上 where 金額 > 100', column('売上', '金額'))).toBe(
      'select 金額 from 売上\nwhere 金額 > 100',
    );
  });

  it('🔴 `where` の後に JOIN を入れても、絞り込みは後ろに残る', () => {
    expect(sql('select * from 売上 where 金額 > 100', linkAct())).toBe(
      'select * from 売上\n  join 客 on 客.id = 売上.客id\nwhere 金額 > 100',
    );
  });

  it('⚠ 大文字で打っている人には大文字で返す(綴りを勝手に変えない)', () => {
    expect(sql('SELECT * FROM 売上', linkAct())).toBe(
      'SELECT * FROM 売上\n  JOIN 客 ON 客.id = 売上.客id',
    );
  });

  it('⚠ 予約語の名前は、組んだ字でも囲われる', () => {
    const l: SchemaLink = { from: 'order', fromColumn: 'id', to: 'group', toColumn: 'id' };
    expect(sql('', table('order'))).toBe('select * from "order"');
    expect(sql('select * from "order"', linkAct(l))).toBe(
      'select * from "order"\n  join "group" on "group".id = "order".id',
    );
  });
});

describe('🔴 足さないとき ── 必ず理由を言う(無言の dead click を作らない)', () => {
  it('空の欄で列や線を押したら、先に表を押すよう言う', () => {
    expect(why('', column('売上', '金額'))).toContain('表の名前');
    expect(why('   \n ', linkAct())).toContain('表の名前');
  });

  it('🔴 読めない字には足さない ── そして「空にすれば組める」と言う', () => {
    const w = why('update t set a = 1', table('売上'));
    expect(w, '読めない理由を言っていない').toContain('足せません');
    expect(w, 'どうすればよいか言っていない').toContain('空に');
  });

  it('もう入っている表 / もう選んだ列 / もう繋がっている線は、そう言う', () => {
    expect(why('select * from 売上', table('売上'))).toContain('もう入っています');
    expect(why('select 金額 from 売上', column('売上', '金額'))).toContain('もう選んでいます');
    const joined = 'select * from 売上\n  join 客 on 客.id = 売上.客id';
    expect(why(joined, linkAct())).toContain('もう繋がっています');
  });

  it('⚠ 取っていない表の列を押したら、先に表か線を押すよう言う', () => {
    expect(why('select * from 売上', column('客', '名前'))).toContain('先に押してください');
  });

  it('⚠ 繋ぎ先の表がどちらも入っていなければ、そう言う', () => {
    expect(why('select * from 別表', linkAct())).toContain('先に');
  });

  it('⚠ 繋ぐ列が分からない外部キーでは繋がない', () => {
    const l: SchemaLink = { from: '売上', fromColumn: '客id', to: '客', toColumn: '' };
    expect(why('select * from 売上', linkAct(l))).toContain('どの列で繋ぐか');
  });

  it('🔴 足さなかったとき、元の字は 1 文字も変わらない', () => {
    const before = 'update t set a = 1';
    const r = erSql(before, table('売上'));
    expect(r.ok).toBe(false);
    // 🔑 `erSql` は字を返さない ── 呼び側が書き換える材料を持たない形にしてある
    expect('sql' in r, '足さないのに字を返している').toBe(false);
  });
});

/**
 * 🔴 **組んだ字が、いまの門をそのまま通る**。
 * ⚠ ここが落ちたら、図から組んだ SQL が**走らせる前に断られる**(押せて効かない)。
 */
describe('組んだ字が門を通る', () => {
  it('🔴 表 → 列 → 線 と押して組んだ字が、読み取り専用の門を通る', () => {
    let s = sql('', table('売上'));
    s = sql(s, column('売上', '金額'));
    s = sql(s, linkAct());
    s = sql(s, column('客', '名前'));
    expect(s).toBe('select 金額, 客.名前 from 売上\n  join 客 on 客.id = 売上.客id');
    const c = checkReadOnlySql(s);
    expect(c.ok, `組んだ字が門で断られた: ${c.why}`).toBe(true);
  });

  it('⚠ 対照群 ── 書き込む字はちゃんと断られる(門が生きている)', () => {
    expect(checkReadOnlySql('drop table 売上').ok).toBe(false);
  });
});
