/**
 * PDF の窓で選んだ字を「ノートへ引く」ときの規則(#275 段①)。
 *
 * 守るもの:①頁番号と添付名が**必ず**出典として付く(落とすと原典へ戻れない)②複数行は各行が引用になる
 * ③引く先は**結びついたノート**(追記できる種類だけ)、無ければ添付自身 ④長さの数え方は UTF-8 で、
 * 上限の境目を 1 byte 単位で見る(窓側の数え方 `public/pdf/reader-wire.js` と同じ答えを返す)。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  PDF_QUOTE_MAX_BYTES,
  PDF_QUOTE_TOO_LONG,
  formatPdfQuote,
  resolveQuoteTarget,
  utf8Length,
} from '../../src/features/pdf/pdf-quote';
import type { EntryMeta, Relation } from '../../src/core/model/entry-meta';

function meta(lid: string, archetype: string): EntryMeta {
  return {
    lid,
    title: `t-${lid}`,
    archetype,
    createdAt: null,
    updatedAt: null,
    entryOrder: 1,
    status: null,
    date: null,
    archived: false,
    bodyChars: null,
  };
}
function rel(id: string, fromLid: string, toLid: string, kind: string): Relation {
  return { id, fromLid, toLid, kind, createdAt: null, updatedAt: null };
}

describe('formatPdfQuote', () => {
  it('頁番号と添付名が、最後の行の末尾に付く', () => {
    expect(formatPdfQuote('結論はこうである', 3, '報告書.pdf')).toBe('> 結論はこうである (p.3、報告書.pdf)');
  });

  it('複数行は各行が引用になり、出典は最後の行だけに付く', () => {
    expect(formatPdfQuote('一行目\n二行目\n三行目', 12, 'a.pdf')).toBe(
      '> 一行目\n> 二行目\n> 三行目 (p.12、a.pdf)',
    );
  });

  it('空行・前後の空白は落とす / 空白だけなら引かない(null)', () => {
    expect(formatPdfQuote('  a  \n\n  b ', 1, 'x')).toBe('> a\n> b (p.1、x)');
    expect(formatPdfQuote('  \n \n', 1, 'x')).toBeNull();
    expect(formatPdfQuote('', 1, 'x')).toBeNull();
  });

  it('頁が 1 未満・非数でも頁番号は落とさない(1 に丸める)', () => {
    expect(formatPdfQuote('a', 0, 'x')).toBe('> a (p.1、x)');
    expect(formatPdfQuote('a', Number.NaN, 'x')).toBe('> a (p.1、x)');
    expect(formatPdfQuote('a', 2.9, 'x')).toBe('> a (p.2、x)');
  });

  it('名前が空なら頁だけを出す / 名前の中の改行・制御文字は 1 行に潰す', () => {
    expect(formatPdfQuote('a', 4, '')).toBe('> a (p.4)');
    expect(formatPdfQuote('a', 4, 'x\ny\u0007z')).toBe('> a (p.4、x yz)');
  });

  it('選びの中の制御文字は落とす(ノートへ不可視の字を書かない)', () => {
    expect(formatPdfQuote('a\u0000b\u007fc\td', 1, 'x')).toBe('> abc\td (p.1、x)');
  });
});

describe('utf8Length / 上限の境目', () => {
  it('1〜4 byte の字と、対のサロゲートを正しく数える', () => {
    expect(utf8Length('a')).toBe(1);
    expect(utf8Length('é')).toBe(2);
    expect(utf8Length('あ')).toBe(3);
    expect(utf8Length('\u{1F600}')).toBe(4); // 絵文字 = 対のサロゲート
    expect(utf8Length('\ud800')).toBe(3); // 対にならない上位は 3 byte
  });

  it('上限は 64KB で、窓の側の定数・断りの字と同じ値を指している(原文で突合)', () => {
    expect(PDF_QUOTE_MAX_BYTES).toBe(65536);
    const wire = readFileSync('public/pdf/reader-wire.js', 'utf-8');
    expect(wire).toContain('var QUOTE_MAX_BYTES = 64 * 1024;');
    expect(wire).toContain(`var QUOTE_TOO_LONG = '${PDF_QUOTE_TOO_LONG}';`);
  });

  it('日本語は 3 byte なので、21845 字がちょうど上限・もう 1 字で超える(境目を 1 単位で)', () => {
    const edge = 'あ'.repeat(21845); // 65535 byte
    expect(utf8Length(edge)).toBe(65535);
    expect(utf8Length(edge) <= PDF_QUOTE_MAX_BYTES).toBe(true);
    expect(utf8Length(edge + 'a')).toBe(65536);
    expect(utf8Length(edge + 'a') > PDF_QUOTE_MAX_BYTES).toBe(false);
    expect(utf8Length(edge + 'aa') > PDF_QUOTE_MAX_BYTES).toBe(true);
  });
});

describe('resolveQuoteTarget ── どのノートへ引くか', () => {
  const metas = new Map<string, EntryMeta>([
    ['att', meta('att', 'attachment')],
    ['note', meta('note', 'text')],
    ['log', meta('log', 'textlog')],
    ['dir', meta('dir', 'folder')],
    ['att2', meta('att2', 'attachment')],
    ['todo', meta('todo', 'todo')],
  ]);

  it('結びついたノートがあればそれ(どちら向きの関係でも)', () => {
    expect(resolveQuoteTarget('att', metas, [rel('r1', 'note', 'att', 'semantic')])).toBe('note');
    expect(resolveQuoteTarget('att', metas, [rel('r1', 'att', 'log', 'provenance')])).toBe('log');
  });

  it('無ければ添付のノート自身(説明の末尾へ)', () => {
    expect(resolveQuoteTarget('att', metas, [])).toBe('att');
  });

  it('居場所(フォルダ)は結びつきではない / 追記できない種類(フォルダ・別の添付・todo)は選ばない', () => {
    expect(resolveQuoteTarget('att', metas, [rel('r1', 'dir', 'att', 'structural')])).toBe('att');
    expect(resolveQuoteTarget('att', metas, [rel('r1', 'dir', 'att', 'semantic')])).toBe('att');
    expect(resolveQuoteTarget('att', metas, [rel('r1', 'att2', 'att', 'semantic')])).toBe('att');
    expect(resolveQuoteTarget('att', metas, [rel('r1', 'todo', 'att', 'semantic')])).toBe('att');
  });

  it('複数あれば関係の並びが先のもの / 追記できない相手を飛ばして次へ', () => {
    const rels = [
      rel('r0', 'dir', 'att', 'semantic'),
      rel('r1', 'log', 'att', 'categorical'),
      rel('r2', 'note', 'att', 'semantic'),
    ];
    expect(resolveQuoteTarget('att', metas, rels)).toBe('log');
  });

  it('別の添付の関係は拾わない', () => {
    expect(resolveQuoteTarget('att', metas, [rel('r1', 'note', 'att2', 'semantic')])).toBe('att');
  });
});
