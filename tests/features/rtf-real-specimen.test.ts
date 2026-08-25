/**
 * 🔴 **実物の RTF で見る**(user 指示 2026-08-25「**ちゃんと調査してください**」)。
 *
 * ⚠ **自分で書いた fixture は、実装と同じ盲点を持つ**(CLAUDE.md §1
 * 「期待値を実装と同じ文法の別の綴りで組むと、同じ盲点を共有する」)。
 * `rtf-to-markdown.test.ts` の 57 件は**全部こちらが書いた綴り**なので、
 * 「RTF はこう書かれるはずだ」という思い込みごと緑になっていた。
 *
 * 🔑 だからここは **LibreOffice が実際に書き出した RTF** を通す ── 産み手が違う。
 * ⚠ この 1 本を通したら、**7 件の欠陥が一度に出た**(自作 57 件では 1 件も出ていない):
 * ① 日本語の太字が丸ごと落ちる(`\ab` を読んでいなかった)
 * ② コードが 1 つも囲まれない(`Courier New` は `\fnil\fprq0` で出る)
 * ③ 表とふつうの文が丸ごとコードになる(`\plain` がフォントを戻していなかった)
 * ④ 行内コードが平文になる(実物は文字スタイル `\cs18 Source Text` で書く)
 * ⑤ 見出しが `# **題**` になる(見出しのスタイルが太字を持つ)
 * ⑥ 表の見出し行が空になる(`\trhdr` は無く、スタイル名 `Table Heading` で表す)
 * ⑦ リンクが `[:字:underline:](url)` になる(リンクのスタイルが下線を持つ)
 *
 * 🔑 **fixture の作り直し方は `tests/fixtures/rtf/README.md`** に書いてある。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { convertPastedRtf } from '../../src/features/markdown/rtf-to-markdown';

/** ⚠ RTF は 7bit ASCII + escape なので `latin1` で読む(`utf-8` だと壊れる)。 */
const RTF = readFileSync('tests/fixtures/rtf/libreoffice-ai-answer.rtf', 'latin1');

const out = (): string => {
  const r = convertPastedRtf({ rtf: RTF, plain: '' });
  expect(r, '実物を 1 文字も変換できていない').not.toBeNull();
  return r!;
};

describe('LibreOffice が書いた実物', () => {
  it('前提: fixture が本物である(産み手の印が在る)', () => {
    expect(RTF.startsWith('{\\rtf1')).toBe(true);
    expect(RTF, 'LibreOffice の出力ではない').toContain('LibreOffice');
    // ⚠ 自作の fixture では**在りえない**形が入っていること
    expect(RTF, '`\\ab` が無い(実物ではない可能性)').toContain('\\ab');
    expect(RTF, 'スタイルシートが無い').toContain('Preformatted Text');
  });

  it('🔴 見出しが、飾りを重ねずに出る', () => {
    expect(out()).toContain('# まとめ');
    expect(out(), '見出しに太字が二重に掛かっている').not.toContain('# **');
  });

  it('🔴 日本語の太字が残る(`\\ab` を読んでいる)', () => {
    expect(out(), '日本語の太字が落ちている').toContain('**太字**');
    expect(out()).toContain('*斜体*');
    expect(out()).toContain('~~打ち消し~~');
  });

  it('🔴 行内コードが出る(文字スタイル `Source Text`)', () => {
    expect(out(), '行内コードが平文になっている').toContain('`count`');
  });

  it('🔴 コードが 1 つの囲みになる(段落スタイル `Preformatted Text`)', () => {
    expect(out(), 'コードが囲まれていない').toContain(
      '```\nfunction f() {\n  return 1;\n}\n```',
    );
  });

  it('🔴 ふつうの文がコードに巻き込まれない(`\\plain` がフォントを戻す)', () => {
    const t = out();
    // 最後の段落は本文である ── 囲みの中に入っていない
    const lastFence = t.lastIndexOf('```');
    expect(t.slice(lastFence + 3), '本文が囲みの中に入っている').toContain('詳しくは');
  });

  it('🔴 表の見出し行が出る(スタイル名 `Table Heading`。`\\trhdr` は無い)', () => {
    expect(RTF, '前提が崩れた(実物に \\trhdr が在る)').not.toContain('\\trhdr');
    expect(out()).toContain('| 名 | 数 |\n| --- | --- |\n| 卵 | 6 |');
  });

  it('🔴 リンクが出て、下線が二重に掛からない', () => {
    expect(out()).toContain('[こちら](https://example.com/a)');
    expect(out(), 'リンクに下線が二重に掛かっている').not.toContain(':underline:');
  });

  it('入れ子の箇条書きと番号付きが残る', () => {
    expect(out()).toContain('- 牛乳を買う');
    expect(out()).toContain('  - 低脂肪');
    expect(out()).toMatch(/1\. ひとつ/);
  });

  it('⚠ 産み手の内部の名前が本文に漏れない', () => {
    const t = out();
    for (const noise of [
      'Liberation',
      'Courier New',
      'Preformatted',
      'Table Heading',
      'HYPERLINK',
      'listtext',
      'Normal',
    ])
      expect(t, `${noise} が本文に漏れている`).not.toContain(noise);
  });
});

/**
 * 🔴 **印を 1 つずつ抜いて、残った 1 本だけで通ることを見る**。
 *
 * ⚠ 実物はコードを**複数の印**(スタイル名 + フォントの宣言 + フォント名)で
 * 同時に名乗っている ── そのままだと**どれを外しても他が救う**ので、
 * 「どの印も効いていること」を確かめられない(変異試験 6 件が SURVIVED で教えた。
 * CLAUDE.md §1「救い手が変わっただけ」)。
 *
 * 🔑 だから**実物から 1 つだけ削った変種**を作る ── 形は実物のまま、印だけが減る。
 * ⚠ 削れたことを**前提として assert する**(削れていなければ、この test は空振り)。
 */
describe('印を 1 つずつ抜く', () => {
  const conv = (rtf: string): string => {
    const r = convertPastedRtf({ rtf, plain: '' });
    expect(r, '変種が 1 文字も変換できていない').not.toBeNull();
    return r!;
  };

  it('🔴 スタイル名だけでコードになる(フォントの印を全部消しても)', () => {
    // フォント側の印を 3 つとも消す ── 宣言 2 つと、名前 + 代替名
    const noFont = RTF.replaceAll('\\fmodern', '\\fnil')
      .replaceAll('\\fprq1', '\\fprq2')
      .replaceAll('Courier New', 'Georgia')
      .replaceAll('Liberation Mono', 'Georgia')
      .replaceAll('monospace', 'Georgia');
    // 前提 ── フォントの印は本当に消えた
    expect(noFont, '\\fmodern が残っている').not.toContain('\\fmodern');
    expect(noFont, 'mono の名前が残っている').not.toMatch(/mono|courier/i);
    // 前提 ── スタイル名のほうは残っている
    expect(noFont).toContain('Preformatted Text');

    const t = conv(noFont);
    expect(t, 'スタイル名だけではコードにならない').toContain(
      '```\nfunction f() {\n  return 1;\n}\n```',
    );
    expect(t, 'スタイル名だけでは行内コードにならない').toContain('`count`');
  });

  it('🔴 フォントの印だけでコードになる(スタイル名を消しても)', () => {
    // スタイルの名前を、コードと名乗らないものに変える
    const noStyle = RTF.replaceAll('Preformatted Text', 'Body Indent').replaceAll(
      'Source Text',
      'Body Indent',
    );
    expect(noStyle, 'スタイル名が残っている').not.toContain('Preformatted Text');
    expect(noStyle, 'スタイル名が残っている').not.toContain('Source Text');
    // 前提 ── フォントの印のほうは残っている
    expect(noStyle).toContain('Courier New');

    const t = conv(noStyle);
    expect(t, 'フォントの印だけではコードにならない').toContain(
      '```\nfunction f() {\n  return 1;\n}\n```',
    );
    expect(t, 'フォントの印だけでは行内コードにならない').toContain('`count`');
  });

  it('🔴 フォントの「名前」だけで等幅と読む(宣言を消しても)', () => {
    // 宣言(`\fmodern` / `\fprq1`)を消し、名前だけ残す
    const nameOnly = RTF.replaceAll('\\fmodern', '\\fnil').replaceAll('\\fprq1', '\\fprq2');
    expect(nameOnly).not.toContain('\\fmodern');
    expect(nameOnly, '前提が崩れた(名前が無い)').toContain('Courier New');
    // スタイル名も消して、名前だけを唯一の印にする
    const only = nameOnly.replaceAll('Preformatted Text', 'Body Indent').replaceAll(
      'Source Text',
      'Body Indent',
    );
    expect(conv(only), '名前だけでは等幅と読めていない').toContain('```\nfunction f() {');
  });

  it('🔴 文字スタイルは段落スタイルと別に数える(番号空間が違う)', () => {
    /**
     * ⚠ 実物では行内コードが `\cs18`、段落のコードが `\s32` である ──
     *   混ぜると `\s18`(`Source Text` の**段落**)がコードの塊になる。
     * 🔑 フォントの印を消して、**スタイルだけ**が効く形で見る。
     */
    const noFont = RTF.replaceAll('\\fmodern', '\\fnil')
      .replaceAll('\\fprq1', '\\fprq2')
      .replaceAll('Courier New', 'Georgia')
      .replaceAll('Liberation Mono', 'Georgia')
      .replaceAll('monospace', 'Georgia');
    const t = conv(noFont);
    // 行内は行内のまま(塊に化けていない)
    expect(t).toContain('`count`という変数です。');
    expect(t, '行内コードが塊に化けている').not.toContain('```\ncount');
  });
});
