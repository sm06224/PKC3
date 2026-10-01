/** @vitest-environment happy-dom */
/**
 * 🔴 **表の列幅を揃える**(#1171)。
 *
 * ## 🔑 期待値は「別の観測」から作る(CLAUDE.md §1)
 *
 * ⚠ 実装は `mdTableAt` / `mdCellSpan`(markdown-it と突き合わせ済み)を借りて
 *   升を読むので、**升の字が 1 文字も変わっていない**ことを実装の綴りで検めても
 *   同じ盲点を共有する。だから主張の本体は **実物の読み手(`renderMarkdown`)が
 *   描いた `<td>` / `<th>` の字を、揃える前後で見比べる**ことに置く。
 *   幅の期待値は `displayWidth` ではなく**手で数えた**桁(全角 = 2)で書く。
 */
import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';
import { alignMdTable, displayWidth } from '../../src/features/markdown/table-align';

/** 描いた表の升(表ごと・行ごと)。⚠ **実物の読み手**から採る観測点である。 */
function grid(body: string): string[][][] {
  const host = document.createElement('div');
  host.innerHTML = renderMarkdown(body, {});
  return [...host.querySelectorAll('table')].map((t) =>
    [...t.querySelectorAll('tr')].map((tr) =>
      [...tr.children].map((c) => (c.textContent ?? '').trim()),
    ),
  );
}

/** 本文に埋めた `^` をカーソルの位置として取り出して、揃える。 */
function run(src: string) {
  const at = src.indexOf('^');
  expect(at).toBeGreaterThanOrEqual(0);
  const body = src.slice(0, at) + src.slice(at + 1);
  return { body, res: alignMdTable(body, at) };
}

function done(src: string) {
  const { body, res } = run(src);
  if (!('text' in res)) throw new Error(`揃わなかった: ${res.reason}`);
  return { body, ...res };
}

describe('displayWidth ── 全角 = 2 / 半角 = 1 / 結合 = 0', () => {
  it('手で数えた桁と一致する', () => {
    expect(displayWidth('abc')).toBe(3);
    expect(displayWidth('りんご')).toBe(6);
    expect(displayWidth('りんごA')).toBe(7);
    expect(displayWidth('ＡＢ')).toBe(4); // 全角英字
    expect(displayWidth('ｱｲ')).toBe(2); // 半角カナ
    expect(displayWidth('𠮷')).toBe(2); // サロゲートペアの漢字は 1 字
    expect(displayWidth('🍎')).toBe(2);
    expect(displayWidth('é')).toBe(1); // 結合アクセント
    expect(displayWidth('α→')).toBe(2); // 曖昧幅は 1
    expect(displayWidth('')).toBe(0);
  });
});

describe('alignMdTable ── 揃える', () => {
  it('ASCII の表', () => {
    const r = done('| a | bbb |\n|---|---|\n| cccc^ | d |');
    expect(r.text).toBe('| a    | bbb |\n| ---- | --- |\n| cccc | d   |');
  });

  it('日本語は 2 桁で数える(全角 3 字の升に、半角 6 字ぶんが揃う)', () => {
    const r = done('| 名前 | 価格 |\n|---|---|\n| りんご^ | 100 |');
    expect(r.text).toBe(
      ['| 名前   | 価格 |', '| ------ | ---- |', '| りんご | 100  |'].join('\n'),
    );
  });

  it('半角と全角が混ざる(「A りんご」= 1 + 1 + 6 = 8 桁)', () => {
    const r = done('| 品名 | memo |\n|---|---|\n| A りんご^ | ok |');
    expect(r.text).toBe(
      ['| 品名     | memo |', '| -------- | ---- |', '| A りんご | ok   |'].join('\n'),
    );
  });

  it('区切りの行の寄せの印を残して横線を伸ばす', () => {
    const r = done('| a | bbbbbb | c | dd |\n|:--|:-:|--:|---|\n| x^ | y | z | w |');
    const delim = r.text.split('\n')[1]!;
    const cells = delim
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim());
    // 1 列目は 1 桁 → 最小の 3 桁(`:--`)/ 2 列目は「bbbbbb」で 6 桁(`:----:`)
    expect(cells).toEqual([':--', ':----:', '--:', '---']);
  });

  it('`\\|` は区切りではなく升の字(原文では 2 桁ぶん)', () => {
    const r = done('| a\\|b | c |\n|---|---|\n| x^ | y |');
    expect(r.text).toBe('| a\\|b | c   |\n| ---- | --- |\n| x    | y   |');
    expect(grid(r.text)).toEqual(grid(r.body));
  });

  it('引用の前置きを残す', () => {
    const r = done('> | あ | b |\n> |---|---|\n> | cc^ | dddd |');
    expect(r.text).toBe(['> | あ  | b    |', '> | --- | ---- |', '> | cc  | dddd |'].join('\n'));
  });

  it('升の数が違う行はそのまま(足さない・削らない)', () => {
    const r = done('| a | b | c |\n|---|---|---|\n| 1^ |\n| 2 | 3 | 4 | 5 |');
    const counts = r.text
      .split('\n')
      .map((l) => l.split('|').filter((_, i, a) => i > 0 && i < a.length - 1).length);
    expect(counts).toEqual([3, 3, 1, 4]);
    expect(grid(r.text)).toEqual(grid(r.body));
  });

  it('前後の `|` を省いた書き方は、省いたまま揃える', () => {
    const r = done('a | bb\n---|---\nccc^ | d');
    expect(r.text).toBe('a   | bb\n--- | ---\nccc | d');
    expect(grid(r.text)).toEqual(grid(r.body));
  });

  it('改行が CRLF でも崩さない', () => {
    const r = done('| a | b |\r\n|---|---|\r\n| ccc^ | d |\r\n\r\nafter');
    expect(r.text).toBe('| a   | b   |\r\n| --- | --- |\r\n| ccc | d   |\r\n\r\nafter');
  });

  it('表の外の行は 1 文字も動かない', () => {
    const r = done('前の段落\n\n| a | b |\n|---|---|\n| ccc^ | d |\n\n後ろの段落\n');
    expect(r.text.slice(0, r.from)).toBe(r.body.slice(0, r.from));
    expect(r.text.slice(r.from + r.insert.length)).toBe(r.body.slice(r.to));
    expect(r.text.startsWith('前の段落\n\n')).toBe(true);
    expect(r.text.endsWith('\n\n後ろの段落\n')).toBe(true);
  });
});

describe('alignMdTable ── 冪等・断り', () => {
  const samples = [
    '| 名前 | 価格 |\n|:--|--:|\n| りんご^ | 100 |\n| みかん | 20 |',
    '> | a | bb |\n> |---|:-:|\n> | ccc^ | d |',
    '| a\\|b | c |\n|---|---|\n| x^ | y |',
    'a | bb\n---|---\nccc^ | d',
  ];
  for (const s of samples) {
    it(`2 回揃えても同じ: ${JSON.stringify(s).slice(0, 30)}`, () => {
      const r = done(s);
      expect(alignMdTable(r.text, r.caret)).toEqual({ reason: 'already' });
    });
  }

  it('表の外では何もしない', () => {
    expect(run('ただの文^です').res).toEqual({ reason: 'outside' });
    expect(run('| a | b |\n|---|---|\n| 1 | 2 |\n\n文^').res).toEqual({ reason: 'outside' });
  });

  it('区切りの行が無い 2 行は表ではない', () => {
    expect(run('| a | b |\n| c^ | d |').res).toEqual({ reason: 'outside' });
  });

  it('もう揃っていれば `already`', () => {
    expect(run('| a   | b   |\n| --- | --- |\n| c^   | d   |').res).toEqual({
      reason: 'already',
    });
  });

  it('囲み(```)の中の表は表として扱わない', () => {
    expect(run('```\n| a | b |\n|---|---|\n| cccc^ | d |\n```').res).toEqual({
      reason: 'outside',
    });
  });

  it('囲みに接した表は、囲みの行に触らない', () => {
    const r = done('```\ncode\n```\n| a | b |\n|---|---|\n| ccc^ | d |\n```\nx\n```');
    const lines = r.text.split('\n');
    expect(lines.slice(0, 3)).toEqual(['```', 'code', '```']);
    expect(lines.slice(-3)).toEqual(['```', 'x', '```']);
    expect(lines[3]).toBe('| a   | b   |');
  });
});

describe('alignMdTable ── 升の字は 1 文字も変えない(実物の読み手で見る)', () => {
  const tables = [
    '| 名前 | 価格 | 備考 |\n|:--|--:|:-:|\n| りんご | 100 | **赤い** |\n| みかん | 20 | `x` |',
    '| a\\|b | c |\n|---|---|\n| [x](http://e.com) | ~~y~~ |',
    '| x | y |\n|---|---|\n|   前後に空白   |  a  |\n| 🍎 | ｱｲ |',
    '| a | b | c |\n|---|---|---|\n| 1 |\n| 2 | 3 | 4 | 5 |',
  ];
  for (const t of tables) {
    it(JSON.stringify(t).slice(0, 36), () => {
      const body = `前\n\n${t}\n\n後`;
      const r = alignMdTable(body, body.indexOf('|'));
      if (!('text' in r)) throw new Error(r.reason);
      expect(r.text).not.toBe(body);
      const before = grid(body);
      expect(before.length).toBe(1); // 前提: 表が 1 つ描かれている
      expect(before[0]!.flat().length).toBeGreaterThanOrEqual(4); // 前提: 升が在る
      expect(grid(r.text)).toEqual(before);
    });
  }
});

describe('alignMdTable ── カーソルを同じ升へ写す', () => {
  it('升の中の字の手前に置いたカーソルは、揃えたあとも同じ字の手前', () => {
    const r = done('| a | bbb |\n|---|---|\n| りん^ご | d |');
    expect(r.text.slice(0, r.caret).endsWith('| りん')).toBe(true);
    expect(r.text.slice(r.caret)).toMatch(/^ご /);
  });

  it('後ろの升でも同じ升の同じ位置', () => {
    const r = done('| 名前 | 価格 |\n|---|---|\n| りんご | 1^00 |');
    expect(r.text.slice(r.caret - 1, r.caret + 2)).toBe('100');
  });

  it('見出しの行にカーソルが在っても写る', () => {
    const r = done('| a^ | bbb |\n|---|---|\n| cccc | d |');
    expect(r.text.slice(0, r.caret)).toBe('| a');
  });
});
