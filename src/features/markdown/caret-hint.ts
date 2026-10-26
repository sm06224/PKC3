import { codeContextAt } from './code-context';
import { frontmatterLineCount } from './frontmatter';
import { lineStart } from './line-start';
import { tableRowAt } from './table-assist';

/**
 * 🔴 **いまの caret がどの記法の中に居るか**(#1451。編集の帯の右端の案内の材料)。
 *
 * 表(行が `|` で始まる)・コード(```)・数式(`$$`)・先頭の frontmatter(`---`)の 4 つ。
 * 🔑 判定は既存の規則を**そのまま引く**(第二の正本を作らない):表 = `tableRowAt`(Tab が実際にセルを移す行)/
 *   コード・数式 = `codeContextAt`(Enter の続き・貼り付けの変換が「中」と数える規則)/
 *   frontmatter = `frontmatterLineCount`(描く側・parse する側と同じ位置規則)。
 * 🔑 答えには**行の範囲 `[from, to]`**を添える ── 呼び側は caret が同じ行に居るあいだ本文を読み直さない
 *   (大きい本文で long task を増やさない)。⚠ 入力があれば呼び側が控えを捨てる。
 * ⚠ 重い走査(コード・数式・frontmatter)は、**本文にその印が在るときだけ**行う(`indexOf` は速い)。
 */
export type CaretBlock = 'table' | 'code' | 'math' | 'frontmatter' | null;

export interface CaretBlockAt {
  readonly from: number;
  readonly to: number;
  readonly block: CaretBlock;
}

/** 案内の字(帯の右端)。⚠ 画面の字は標準の IT 用語で書く。 */
export const CARET_HINT: Readonly<Record<Exclude<CaretBlock, null>, string>> = {
  table: 'Tab で次のセル',
  code: 'コード内: 記法は働きません(閉じは ```)',
  math: '数式内: TeX で書きます(閉じは $$)',
  frontmatter: 'frontmatter 内: 閉じは ---',
};

export function caretBlockAt(value: string, caret: number): CaretBlockAt {
  const row = tableRowAt(value, caret);
  if (row.table) return { from: row.from, to: row.to, block: 'table' };
  const range = { from: row.from, to: row.to };
  // frontmatter: 本文の先頭が `---` のときだけ数える
  if (value.startsWith('---')) {
    const n = frontmatterLineCount(value);
    if (n > 0) {
      let line = 0;
      for (let i = value.indexOf('\n'); i !== -1 && i < caret; i = value.indexOf('\n', i + 1)) line += 1;
      if (line < n) return { ...range, block: 'frontmatter' };
    }
  }
  if (value.includes('```') || value.includes('~~~') || value.includes('$$')) {
    const ctx = codeContextAt(value, caret);
    if (ctx === 'fence' || ctx === 'math') {
      // ⚠ 開きの柵の行は、caret が柵の字より前か後ろかで答えが変わる ── 範囲を caret 1 点にして控えを使わせない
      const head = value.slice(lineStart(value, caret), row.to).trimStart();
      const onOpener = /^(?:>\s*)*(?:`{3,}|~{3,}|\$\$)/.test(head);
      return { from: onOpener ? caret : row.from, to: onOpener ? caret : row.to, block: ctx === 'fence' ? 'code' : 'math' };
    }
  }
  return { ...range, block: null };
}
