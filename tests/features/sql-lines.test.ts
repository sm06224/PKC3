/**
 * 🔴 **打つ SQL を行ごとの色付き HTML に割る**(#918 段②c/②d)。
 *
 * ⚠ ここで守りたいのは 3 つ:
 *   ① **行数が `textarea` の見え方と一致する**(番号がずれない)
 *   ② **行をまたぐ囲み(`/* … *\/`)の色が 2 行目でも続く**
 *      ⚠ 文字列(`'…'`)は**またがない** ── 色付け器の綴りがそう決めている(下で検算する)
 *   ③ **素の字が escape されたまま**(層に生の `<` を流し込まない)
 */
import { describe, expect, it } from 'vitest';
import { sqlLineHtml } from '@features/query/sql-lines';

/** 色の印を落として、素の字だけ取り出す(行の中身を見るため)。 */
function plain(html: string): string {
  return html.replace(/<[^>]*>/g, '');
}

describe('sqlLineHtml ── 行ごとに割る(#918 段②c/②d)', () => {
  it('🔴 行数が、打った字の行数と一致する', () => {
    expect(sqlLineHtml('select 1').length, '1 行が 1 本にならない').toBe(1);
    expect(sqlLineHtml('select 1\nfrom t').length).toBe(2);
    // ⚠ 末尾の改行は**空の行を 1 本増やす**(textarea の見え方と同じ)
    expect(sqlLineHtml('select 1\n').length, '末尾の改行で行が増えていない').toBe(2);
    // ⚠ 空の字でも 1 本返す(升が 0 個だと層が畳まれる)
    expect(sqlLineHtml('').length, '空でも 1 本要る').toBe(1);
  });

  it('🔴 空振り防止 ── そもそも色が付いている', () => {
    // 🔑 ここが落ちるなら、下の 2 つは「色が無い」だけで緑になる
    const [one] = sqlLineHtml('select 1');
    expect(one, 'keyword に色が付いていない').toContain('pkc-tok-keyword');
    expect(one, '数に色が付いていない').toContain('pkc-tok-number');
  });

  it('🔴 行をまたぐ囲みの色が、2 行目でも続く', () => {
    const lines = sqlLineHtml('/* これは\nコメント */\nselect 1');
    expect(lines.length).toBe(3);
    expect(lines[0], '1 行目にコメントの色が無い').toContain('pkc-tok-comment');
    // 🔴 ここが本題 ── 1 行ずつ色を付ける実装では、この行から色が消える
    expect(lines[1], '2 行目でコメントの色が切れている').toContain('pkc-tok-comment');
    // ⚠ 対照群: 囲みが閉じた後の行には、コメントの色を引きずらない
    expect(lines[2], 'コメントの色が閉じた後まで漏れている').not.toContain('pkc-tok-comment');
    expect(lines[2], '閉じた後の行に色が付いていない').toContain('pkc-tok-keyword');
  });

  /**
   * ⚠ **前提の検算**(1 稿目はここを外した)── この色付け器では
   *   **文字列は行をまたがない**(`F_STRING_SQ` = `/'(?:[^'\\\n]|\\.)*'/` が `\n` を除く)。
   *   行をまたぐのは `/* … *\/` だけである。
   * 🔑 だからここで見るのは「**割っても、色付け器の答えを変えていない**」こと ──
   *   1 行に収まる文字列には色が付き、またいだ物には付かない(器の性質をそのまま通す)。
   */
  it('⚠ 1 行に収まる文字列には色が付く / またいだ物は色付け器が拾わない', () => {
    const [one] = sqlLineHtml("select 'あい' as x");
    expect(one, '1 行の文字列に色が無い').toContain('pkc-tok-string');

    const lines = sqlLineHtml("select 'あ\nい' as x");
    expect(lines.length).toBe(2);
    // ⚠ 色が付かないのは**この割り方のせいではない** ── 色付け器がそう決めている
    expect(lines[0], '色付け器の性質が変わった(またぐ文字列に色が付いた)').not.toContain(
      'pkc-tok-string',
    );
  });

  it('🔴 各行の `<span>` が、その行の中で閉じている', () => {
    // ⚠ 閉じずに渡すと、升の外へ色が漏れて**画面の残り全部が染まる**
    for (const line of sqlLineHtml('/* あ\nい\nう */')) {
      const open = (line.match(/<span/g) ?? []).length;
      const close = (line.match(/<\/span>/g) ?? []).length;
      expect(close, `開きと閉じの数が違う: ${line}`).toBe(open);
    }
  });

  it('🔴 素の字は escape されたまま出る(生の `<` を流さない)', () => {
    const [line] = sqlLineHtml('select * from t where a < 1 and b > 2 and c = "d&e"');
    expect(line, '生の < が残っている').not.toMatch(/<(?!\/?span)/);
    expect(line, '< が escape されていない').toContain('&lt;');
    expect(line, '& が escape されていない').toContain('&amp;');
  });

  it('⚠ 日本語を打っても行が崩れない(#764 の型 ── 半角だけで組まない)', () => {
    const lines = sqlLineHtml("-- 目的: 買い物を数える\nselect count(*) from entries where title like '%牛乳%'");
    expect(lines.length).toBe(2);
    expect(plain(lines[0]!), '1 行目の字が変わっている').toBe('-- 目的: 買い物を数える');
    expect(plain(lines[1]!), '2 行目の字が変わっている').toBe(
      "select count(*) from entries where title like '%牛乳%'",
    );
  });

  it('🔴 割っても字は 1 文字も増減しない(全数の不変量)', () => {
    // 🔑 実装の綴りを 1 行も参照しない観測 ── 「色を付けて割った物を戻すと元に戻る」
    for (const src of [
      'select 1',
      'select 1\nfrom t\nwhere a = 2',
      '/* あ\nい */\nselect 1',
      "select 'x\ny'",
      '',
      '\n\n',
      '  select  *  \n\tfrom t',
    ]) {
      const back = sqlLineHtml(src)
        .map(plain)
        .join('\n')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&');
      expect(back, `割って戻すと字が変わる: ${JSON.stringify(src)}`).toBe(src);
    }
  });
});
