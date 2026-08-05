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
  containerAtLine,
  findOpenEnds,
  scanContainers,
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
