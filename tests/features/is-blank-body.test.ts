/**
 * 🔴 **本文が「空」かの判定**(#215 段③ / #1266)。`isBlankBody` は書き戻しの門が使う 1 本。
 * ⚠ 空とみなすのは**空白・改行だけ** ── 本文が 1 字でも在れば**空ではない**。
 *   🔴 先頭の設定行(frontmatter)だけのノートも**空ではない**(#1266。書き戻すと設定行がファイルへ戻る)
 *   (対照群を同じ表に置く。置かないと「常に true」でも緑になる)。
 */
import { describe, expect, it } from 'vitest';
import { isBlankBody } from '../../src/features/markdown/frontmatter';

describe('isBlankBody', () => {
  it.each([
    ['空文字', ''],
    ['空白と改行', ' \n\t\n'],
    ['全角空白', '　\n　'],
  ])('空: %s', (_l, body) => {
    expect(isBlankBody(body)).toBe(true);
  });

  it.each([
    ['設定行だけ', '---\ntitle: a\n---'],
    ['設定行 + 空行', '---\ntitle: a\n---\n\n'],
    ['空の設定行', '---\n---\n'],
    ['CRLF の設定行だけ', '---\r\ntitle: a\r\n---\r\n'],
    ['1 字', 'a'],
    ['設定行 + 本文', '---\ntitle: a\n---\nx'],
    ['閉じの無い設定行(= ただの文書)', '---\ntitle: a\n'],
    ['水平線で始まる文書', '---\n本文\n'],
    ['記号だけでも字は字', '-'],
  ])('空ではない: %s', (_l, body) => {
    expect(isBlankBody(body)).toBe(false);
  });
});
