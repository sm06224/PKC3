/**
 * 🔴 **囲いの走査と開放終端**(2026-08-05。ライブエディタ S2 / S5b / S6。
 * 設計 doc §5.6 / §7)。
 *
 * ここは**原文の行だけ**を見る走査器。3 つの用途を 1 本で持つので、
 * どれか 1 つの都合で緩めると他の 2 つが静かに壊れる:
 *   ① S2 の分割(`:::` の囲いは描画の後処理で 1 塊に畳まれる)
 *   ② S5b の色変え(閉じ終端が来ていない行)
 *   ③ S6 の釣り合い検査(差し替えの確定時)
 *
 * ⚠ **fixture のゼロ件の次元**に注意した(1 巡目の変異試験で実際に踏んだ):
 * 「``` の中に ~~~ が在る」形が 1 件も無かったので、閉じ判定を丸ごと緩める変異が
 * 素通りした。
 */
import { describe, expect, it } from 'vitest';
import {
  allFences,
  quoteLead,
  quoteMarkLength,
  quotePrefix,
  blockSpanAt,
  containerAtLine,
  fenceAt,
  findOpenEnds,
  scanContainers,
  sliceLines,
} from '@features/markdown/source-blocks';

const at = (text: string, line: number) => containerAtLine(scanContainers(text), line);

describe('fence の範囲', () => {
  it('開きから閉じまでを 1 個の囲いにする', () => {
    const t = '前\n```js\nconst a = 1;\n```\n後\n';
    const spans = scanContainers(t);
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ start: 1, end: 3, kind: 'fence', open: false, name: 'js' });
  });

  it('🔴 中に**別の種類**の柵が在っても閉じない(fixture のゼロ件次元)', () => {
    // ``` の中の ~~~ で閉じてしまうと、囲いの範囲が短くなって
    // 「fence の中なのに装飾として数える」形になる
    const t = '```md\n~~~\nこれは中身\n~~~\n```\n後\n';
    const spans = scanContainers(t);
    expect(spans, `囲いが ${spans.length} 個になった(1 個であるべき)`).toHaveLength(1);
    expect(spans[0]).toMatchObject({ start: 0, end: 4, open: false });
    // 中の行は fence の中と判定される
    expect(at(t, 2)?.kind).toBe('fence');
  });

  it('🔴 短い柵では閉じない(```` の中の ``` は中身)', () => {
    const t = '````\n```\n中\n```\n````\n';
    const spans = scanContainers(t);
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ start: 0, end: 4 });
  });

  it('🔴 閉じの行に言語名が付いていたら閉じではない', () => {
    const t = '```js\nconst a = 1;\n```ts\n中\n```\n';
    const spans = scanContainers(t);
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ start: 0, end: 4 });
  });

  it('🔴 閉じ無しは末尾まで飲む + open:true(後続を巻き込む形の材料)', () => {
    const t = '前\n```js\nconst a = 1;\nまだ書いている\n';
    const spans = scanContainers(t);
    expect(spans).toHaveLength(1);
    expect(spans[0]!.open).toBe(true);
    expect(spans[0]!.end).toBe(t.split('\n').length - 1);
  });
});

describe('`:::` の範囲', () => {
  it('開きから閉じまでを 1 個の囲いにする', () => {
    const t = '前\n:::note\n中\n:::\n後\n';
    const spans = scanContainers(t);
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ start: 1, end: 3, kind: 'directive', name: 'note' });
  });

  it('🔴 入れ子は**外側の範囲**にまとめる(深さを数える)', () => {
    const t = ':::section\n外\n:::note\n中\n:::\n:::\n後\n';
    const spans = scanContainers(t);
    expect(spans, `囲いが ${spans.length} 個(外側 1 個であるべき)`).toHaveLength(1);
    expect(spans[0]).toMatchObject({ start: 0, end: 5, name: 'section', open: false });
  });

  it('🔴 `:::toc` は囲いではない(中を飲まない ── 実測)', () => {
    const t = '# 題\n\n:::toc\n\n本文\n';
    const spans = scanContainers(t);
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ start: 2, end: 2, name: 'toc', open: false });
    // 後続の本文が囲いの中に入っていない
    expect(at(t, 4)).toBeNull();
  });

  it('`:::toc` の直後に閉じが在ればそれも含める', () => {
    const t = ':::toc\n:::\n本文\n';
    expect(scanContainers(t)[0]).toMatchObject({ start: 0, end: 1 });
    expect(at(t, 2)).toBeNull();
  });

  it('🔴 `:::toc` の入れ子は深さに数えない(外側が早く閉じない)', () => {
    const t = ':::section\n外\n:::toc\n:::\n後\n';
    const spans = scanContainers(t);
    // `:::toc` の直後の `:::` は toc のものなので、外側はまだ閉じていない
    expect(spans[0]!.name).toBe('section');
    expect(spans[0]!.open).toBe(true);
  });

  it('🔴 閉じ無しは末尾まで飲む(実測: 後続の段落が中に入る)', () => {
    const t = ':::note\n中身\n\n後続の段落\n';
    const spans = scanContainers(t);
    expect(spans[0]).toMatchObject({ start: 0, open: true });
    expect(spans[0]!.end).toBe(t.split('\n').length - 1);
  });
});

describe('開放終端(S5b の材料)', () => {
  const kinds = (t: string) => findOpenEnds(t).map((o) => `${o.kind}:${o.what}@${o.line}`);

  it('🔴 ブロックの開放終端を出す(ここが本題 ── 後続を飲み込む)', () => {
    expect(kinds('```js\nconst a = 1;\n')).toEqual(['fence:```js@0']);
    expect(kinds(':::note\n中身\n')).toEqual(['directive::::note@0']);
  });

  it('行内の開放終端を出す', () => {
    expect(kinds('これは**太字')).toEqual(['inline:太字@0']);
    expect(kinds('これは`コード')).toEqual(['inline:コード@0']);
    expect(kinds('これは==印')).toEqual(['inline:強調印@0']);
    expect(kinds('これは~~打消')).toEqual(['inline:打消@0']);
    expect(kinds('これは[リンク')).toEqual(['inline:リンク@0']);
  });

  it('🔴 閉じていれば出さない(常時点灯にしない)', () => {
    expect(kinds('これは**太字**です')).toEqual([]);
    expect(kinds('```js\nconst a = 1;\n```\n')).toEqual([]);
    expect(kinds(':::note\n中身\n:::\n')).toEqual([]);
    expect(kinds('[リンク](url) と `コード`')).toEqual([]);
  });

  it('🔴 fence の中は数えない(コードの `**` は装飾ではない)', () => {
    // ⚠ 数えると、正しく閉じたコードブロックが常に「開放終端」に見える
    expect(kinds('```js\nconst a = 1 ** 2;\nconst s = "`";\n```\n')).toEqual([]);
  });

  it('`:::` の中身は数える(普通の本文なので)', () => {
    expect(kinds(':::note\nこれは**太字\n:::\n')).toEqual(['inline:太字@1']);
  });

  it('複数行の中で、開いている行だけを出す', () => {
    expect(kinds('閉じた**太字**\nこれは`打ちかけ\n普通の行\n')).toEqual(['inline:コード@1']);
  });
});

/**
 * 🔴 **開き行から `:::` の塊の範囲を引く**(#677。右クリック「この塊をコピー」の材料)。
 * ⚠ `scanContainers` は最上位しか返さない ── 入れ子の内側を頼まれたときに
 *   **外側を返してしまう**変異(降りない)を、入れ子の fixture で殺す。
 */
describe('`:::` の塊の範囲(blockSpanAt) #677', () => {
  const NESTED = [
    '前', // 0
    ':::note', // 1
    '囲みの中', // 2
    ':::section', // 3
    '入れ子の中', // 4
    ':::', // 5
    ':::', // 6
    '後', // 7
  ].join('\n');

  it('最上位の開き行 → 開きから閉じまで', () => {
    expect(blockSpanAt(NESTED, 1)).toEqual({ start: 1, end: 6, open: false });
  });

  it('🔴 入れ子の内側の開き行 → **内側**の範囲(外側を返さない)', () => {
    expect(blockSpanAt(NESTED, 3)).toEqual({ start: 3, end: 5, open: false });
  });

  it('`:::` の開きでない行は null(段落 / 閉じ / 範囲外)', () => {
    expect(blockSpanAt(NESTED, 0)).toBeNull();
    expect(blockSpanAt(NESTED, 2)).toBeNull();
    expect(blockSpanAt(NESTED, 4)).toBeNull();
    expect(blockSpanAt(NESTED, 6), '閉じの行を開きと読んだ').toBeNull();
    expect(blockSpanAt(NESTED, 99)).toBeNull();
    expect(blockSpanAt(NESTED, -1)).toBeNull();
  });

  it('🔴 fence の中の `:::` は塊ではない(コードの字である)', () => {
    const t = '```md\n:::note\n中\n:::\n```\n';
    expect(blockSpanAt(t, 1), 'fence の中の ::: を塊と読んだ').toBeNull();
    // ⚠ 対照群 ── fence の**外**の同じ字面は塊
    const u = '```md\nコード\n```\n:::note\n中\n:::\n';
    expect(blockSpanAt(u, 3)).toEqual({ start: 3, end: 5, open: false });
  });

  it('🔴 `:::` の中の fence の開き行は塊ではない(降りる途中で fence を見る)', () => {
    const t = ':::note\n```\nコード\n```\n:::\n';
    expect(blockSpanAt(t, 1), '囲みの中の fence の開きを塊と読んだ').toBeNull();
    expect(blockSpanAt(t, 0)).toEqual({ start: 0, end: 4, open: false });
    /**
     * ⚠ **守っていない形**(2026-09-04 に実測): 囲みの中の fence の**中**に `:::section` の
     *   字が在ると、`scanContainers` の深さ数え(directive 分岐の内側ループ)が fence を
     *   追跡していないので外側が `open: true` になる ── renderer は正しく閉じるので、
     *   走査器と描画の食い違いである。ここでは pin しない(別の主題)。
     */
  });

  it('閉じていなければ open:true(範囲は末尾まで)── 呼び側が断る材料', () => {
    const t = '前\n:::note\nまだ書いている\n';
    expect(blockSpanAt(t, 1)).toEqual({ start: 1, end: 3, open: true });
  });

  it('`:::toc` は自分の行(と直後の閉じ)だけ', () => {
    expect(blockSpanAt(':::toc\n:::\n本文', 0)).toEqual({ start: 0, end: 1, open: false });
  });

  it('板(`:::format{.pkc-place …}`)も同じ規則で引ける', () => {
    const t = '## 見出し\n\n:::format{.pkc-place x=40 y=40}\n### 買い出し\n- 牛乳\n:::\n';
    expect(blockSpanAt(t, 2)).toEqual({ start: 2, end: 5, open: false });
  });
});

describe('行範囲の切り出し(sliceLines) #677', () => {
  it('両端含む行を、原文のまま繋ぐ(末尾の改行は付けない)', () => {
    expect(sliceLines('a\nb\nc\nd', { start: 1, end: 2 })).toBe('b\nc');
    expect(sliceLines('a\nb\nc\nd', { start: 0, end: 3 })).toBe('a\nb\nc\nd');
    // 空行も 1 行として数える(落とすと貼った先で段落が繋がる)
    expect(sliceLines('a\n\nb', { start: 0, end: 2 })).toBe('a\n\nb');
  });
});

/**
 * 🔴 **入れ子まで含めた囲み**(#747 / #743)。
 *
 * ⚠ ここは**着地前レビューが「検査が 1 件も無い」と指摘して足した**節である ──
 *   `line - from` を `line` にする変異(= 添字を原文へ戻し忘れる)が **8 spec を
 *   素通り**し、2 段の板の中のコードが表として書き換わることを実測した。
 * 🔑 だから見るのは**深さ 2 以上**である ── 深さ 1 だけの台では `from` が 0 なので、
 *   添字を戻し忘れても答えが変わらない(= 何も守れない)。
 */
describe('入れ子の囲み(fenceAt / allFences)', () => {
  /** 板が 2 段。⚠ 深さ 1 の台では `from = 0` なので、この誤りは見えない。 */
  const D2 = ':::note\n:::section\n```txt\n| a | b |\n|---|---|\n| 1 | 2 |\n```\n:::\n:::\n';

  it('🔴 2 段の板の中の囲みを、原文の行番号で返す', () => {
    // 空振り防止 ── 台が本当に 2 段になっている(内側の板が最上位に出ていない)
    expect(scanContainers(D2), '台が 2 段になっていない').toHaveLength(1);
    expect(fenceAt(D2, 5), '2 段の板の中の囲みを見落とした').toEqual(
      expect.objectContaining({ start: 2, end: 6, kind: 'fence', name: 'txt' }),
    );
    // 🔑 中の 5 行(柵から柵まで)が全部その囲みに属する
    for (const l of [2, 3, 4, 5, 6]) expect(fenceAt(D2, l), `行 ${l}`).not.toBeNull();
  });

  it('🔴 板の開き行・閉じ行は囲みではない', () => {
    for (const l of [0, 1, 7, 8]) expect(fenceAt(D2, l), `行 ${l} を囲みと読んだ`).toBeNull();
  });

  it('⚠ 閉じの `:::` を中身として飲まない(範囲が 1 行伸びない)', () => {
    // 板の閉じの直前に囲みが在る形 ── 飲むと囲みの `end` が閉じの行まで伸びる
    const b = ':::note\n```txt\nq\n```\n:::\nそと\n';
    expect(fenceAt(b, 1)).toEqual(expect.objectContaining({ start: 1, end: 3 }));
    expect(fenceAt(b, 4), '板の閉じを囲みが飲んだ').toBeNull();
    expect(fenceAt(b, 5), '板の外まで飲んだ').toBeNull();
  });

  /**
   * 🔴 **板の閉じの `:::` を、囲みの中身に数えない**(変異 M1b)。
   * ⚠ 数えると、**閉じていない囲みの最後の行が「書ける升」に化ける** ──
   *   csv の側は `line < fence.end` で中身を切るので、`end` が 1 行伸びるだけで
   *   コードの字を表の行として書き換える。
   */
  it('🔴 閉じていない囲みは、板の閉じの手前で終わる', () => {
    const b = ':::note\n```csv\na,b\n1,2\n:::\nそと\n';
    expect(fenceAt(b, 3), '囲みが板の閉じまで伸びた').toEqual(
      expect.objectContaining({ start: 1, end: 3, open: true }),
    );
    expect(fenceAt(b, 4), '板の閉じを囲みが飲んだ').toBeNull();
  });

  it('⚠ 閉じていない板の中でも見つかる(末尾まで飲む)', () => {
    const b = ':::note\n```txt\nq\n```\nあと\n';
    expect(fenceAt(b, 2)).toEqual(expect.objectContaining({ start: 1, end: 3 }));
    expect(fenceAt(b, 4)).toBeNull();
  });

  it('⚠ 中を飲まない板(`:::toc`)の後ろへ降りない', () => {
    const b = ':::toc\n:::\n```txt\nq\n```\n';
    expect(fenceAt(b, 3), '飲まない板の後ろの囲みを見落とした').toEqual(
      expect.objectContaining({ start: 2, end: 4 }),
    );
    expect(fenceAt(b, 0), '飲まない板を囲みと読んだ').toBeNull();
  });

  it('⚠ 囲みの中の `:::` はコードの字(降りない)', () => {
    const b = '```txt\n:::note\n| a | b |\n:::\n```\n';
    for (const l of [0, 1, 2, 3, 4]) {
      expect(fenceAt(b, l), `行 ${l} が囲みの外に見えた`).not.toBeNull();
    }
  });

  it('⚠ 深さ 3 でも当たる', () => {
    const b = ':::note\n:::section\n:::details\n```txt\nq\n```\n:::\n:::\n:::\n';
    expect(fenceAt(b, 4)).toEqual(expect.objectContaining({ start: 3, end: 5 }));
  });

  it('⚠ 範囲の外・整数でない行は `null`', () => {
    expect(fenceAt(D2, -1)).toBeNull();
    expect(fenceAt(D2, 999)).toBeNull();
    expect(fenceAt(D2, 1.5)).toBeNull();
  });

  it('🔑 `allFences` は板の中も外も、文書順に全部返す', () => {
    const b = ':::note\n```x\nq\n```\n:::\n```y\nz\n```\n';
    expect(allFences(b).map((f) => [f.name, f.start, f.end])).toEqual([
      ['x', 1, 3],
      ['y', 5, 7],
    ]);
    // ⚠ 空振り防止 ── 最上位の走査は板 1 つと囲み 1 つしか返さない(= 入れ子を見ている)
    expect(scanContainers(b).map((c) => c.kind)).toEqual(['directive', 'fence']);
  });
});

/**
 * 🔴 **引用(`>`)の中の囲みも数える**(#775)。
 *
 * ⚠ 直す前はここが `[]` だったので、`> ```csv ` の升は**押せるのに書けなかった**
 *   (焼く側は markdown-it の答えを使うので印は焼かれる)。
 * 🔑 見るのは**深さ(`quote`)も**である ── 中身の行はこの数だけ前置きを剥がして
 *   読むので、深さを取り違えると引用の印を升の字として書き換える。
 */
describe('引用の中の囲み(fenceAt / allFences)#775', () => {
  it('🔴 引用の中の柵を見つけ、深さを 1 と言う', () => {
    const b = '> ```csv\n> a,b\n> ```\n';
    // ⚠ 空振り防止 ── 最上位の走査は 1 つも返さない(= 引用へ降りている)
    expect(scanContainers(b), '台が引用になっていない').toHaveLength(0);
    expect(fenceAt(b, 1)).toEqual(
      expect.objectContaining({ start: 0, end: 2, kind: 'fence', name: 'csv', quote: 1 }),
    );
  });

  it('🔴 引用の外の囲みは深さ 0(前置きを剥がさない印)', () => {
    expect(fenceAt('```csv\n> a,b\n```\n', 1)).toEqual(expect.objectContaining({ quote: 0 }));
  });

  it('🔴 深さは 1 段ずつ数える(`>>` は 2)', () => {
    expect(fenceAt('>> ```csv\n>> a,b\n>> ```\n', 1)).toEqual(
      expect.objectContaining({ quote: 2, start: 0, end: 2 }),
    );
  });

  /**
   * 🔴 **1 段だけ剥がす** ── 読み手も 1 段しか剥がさない。
   * ⚠ 全段まとめて剥がすと、`>> a,b` の中身が `a,b` に見えて
   *   **画面(`> a` が 1 つ目の升)と食い違う**。
   */
  it('🔴 中身が 1 段深くても、囲みの深さは開き行のまま', () => {
    expect(fenceAt('> ```csv\n>> a,b\n> ```\n', 1)).toEqual(
      expect.objectContaining({ quote: 1, start: 0, end: 2 }),
    );
  });

  it('⚠ 引用が切れた所で囲みも終わる(閉じが外に残るので `open`)', () => {
    const b = '> ```csv\n> a,b\nそと\n> ```\n';
    expect(fenceAt(b, 1)).toEqual(expect.objectContaining({ start: 0, end: 1, open: true }));
    expect(fenceAt(b, 2), '引用の外まで飲んだ').toBeNull();
  });

  it('⚠ 囲みの中の `>` はコードの字(降りない)', () => {
    // 🔴 降りると、素の csv に書いた `> a,b` の `> ` を前置きとして食う
    const b = '```txt\n> ```csv\n> a,b\n> ```\n';
    for (const l of [0, 1, 2, 3]) {
      expect(fenceAt(b, l), `行 ${l} が囲みの外に見えた`).toEqual(
        expect.objectContaining({ name: 'txt', quote: 0 }),
      );
    }
    /**
     * 🔴 **見るのは「返した集合」である**(変異 M5)。
     * ⚠ `fenceAt` は**いちばん先に始まる囲み**を返すので、中に潜り込んだ囲みが
     *   1 つ増えても**答えが変わらない** ── 降りない門を消しても鳴らなかった。
     * 🔑 だから件数で見る:降りていれば `csv` が 1 本増える。
     */
    expect(allFences(b).map((f) => f.name), '囲みの中へ降りた').toEqual(['txt']);
  });

  it('⚠ 板と引用は、どちらの順でも降りる', () => {
    expect(fenceAt(':::note\n> ```csv\n> a,b\n> ```\n:::\n', 2)).toEqual(
      expect.objectContaining({ name: 'csv', quote: 1, start: 1, end: 3 }),
    );
    expect(fenceAt('> :::note\n> ```csv\n> a,b\n> ```\n> :::\n', 2)).toEqual(
      expect.objectContaining({ name: 'csv', quote: 1, start: 1, end: 3 }),
    );
  });

  it('🔑 引用の中も外も、文書順に全部返す', () => {
    const b = '```x\nq\n```\n\n> ```y\n> z\n> ```\n';
    expect(allFences(b).map((f) => [f.name, f.start, f.end, f.quote])).toEqual([
      ['x', 0, 2, 0],
      ['y', 4, 6, 1],
    ]);
  });

  it('⚠ `>` の後ろに空白が無くても、3 字までの字下げがあっても数える', () => {
    expect(fenceAt('>```csv\n>a,b\n>```\n', 1)).toEqual(expect.objectContaining({ quote: 1 }));
    expect(fenceAt('   > ```csv\n   > a,b\n   > ```\n', 1)).toEqual(
      expect.objectContaining({ quote: 1 }),
    );
  });
});

/**
 * 🔴 **前置きを飲む規則は 1 本だけ**(#775。CLAUDE.md §7)。
 * ⚠ 直す前は同じ正規表現が `table-convert.ts` にも在り、**囲みの走査だけが
 *   それを知らなかった**。
 */
describe('引用の前置き(quoteMarkLength / quoteLead / quotePrefix)#775', () => {
  it('🔴 1 段だけ飲む(CommonMark と同じ)', () => {
    expect(quoteMarkLength('> a')).toBe(2);
    expect(quoteMarkLength('>a')).toBe(1);
    expect(quoteMarkLength('   > a'), '字下げ 3 字までは飲む').toBe(5);
    expect(quoteMarkLength('    > a'), '字下げ 4 字はコード').toBe(0);
    expect(quoteMarkLength('>> a'), '2 段目は飲まない').toBe(1);
    expect(quoteMarkLength('a')).toBe(0);
  });

  it('🔴 段が足りなければ `null`(0 と読み替えない)', () => {
    expect(quoteLead('>> a,b', 2)).toBe(3);
    expect(quoteLead('> a,b', 2), '足りないのに字数を返した').toBeNull();
    expect(quoteLead('a,b', 1)).toBeNull();
    expect(quoteLead('a,b', 0), '0 段は常に 0').toBe(0);
  });

  it('⚠ 深さと字数を数える', () => {
    expect(quotePrefix('>> a')).toEqual({ depth: 2, length: 3 });
    expect(quotePrefix('a')).toEqual({ depth: 0, length: 0 });
  });
});
