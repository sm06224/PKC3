/**
 * 🔴 **本文が空行で始まるとき、行頭を 1 と読み違えない**(#1241。#1213 の調査で見つけた形の残り)。
 *
 * `text.lastIndexOf('\n', pos - 1) + 1` は `pos === 0` で第 2 引数が -1 になり、**JS は負の位置を
 * 0 に丸めて 0 番目を見る**。本文が `\n` で始まると、先頭の行の頭が 0 ではなく 1 と読まれる。
 * (`Math.max(0, pos - 1)` で守ったつもりの形も同じ ── 0 に丸めた先で 0 番目を見る。)
 * 判定は `lineStart`(`line-start.ts`)の 1 か所へ寄せた。
 *
 * ⚠ **画面で化ける操作は 2 つだけ**(行頭記号の付け外し / コードブロックで囲む・外す)。
 * 残りの 6 か所は `pos = 0` の行が**必ず空の行**なので、取り違えても `slice(1, 0)` = `''` で
 * 同じ答えになる(= 変異を当てても出力は変わらない)。だから**その分は「書き方」を見る門**
 * (下の最後の describe)で守る ── 出力を見る検査では、戻した変異を殺せない。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { lineStart } from '../../src/features/markdown/line-start';
import { calcLineAction, explainCalcMiss } from '../../src/features/markdown/inline-calc';
import { quoteOnEnter } from '../../src/features/markdown/quote-assist';
import { tableOnTab } from '../../src/features/markdown/table-assist';
import {
  autoPairFor,
  toggleLinePrefix,
  wrapAsBlock,
  type TextSelection,
} from '../../src/features/markdown/text-ops';

/** `|` で選択範囲を書く(1 つなら caret)。 */
function sel(marked: string): TextSelection {
  const start = marked.indexOf('|');
  const second = marked.indexOf('|', start + 1);
  const end = second === -1 ? start : second - 1;
  return { text: marked.replace(/\|/g, ''), start, end };
}

describe('lineStart(共有の判定)', () => {
  it('先頭が空行でも、pos 0 の行頭は 0', () => {
    expect(lineStart('\nあ', 0)).toBe(0);
    expect(lineStart('\nあ', 1)).toBe(1);
    expect(lineStart('あ\nい', 3)).toBe(2);
  });
});

describe('🔴 行頭記号の付け外し(toggleLinePrefix)', () => {
  it('先頭の空行に caret があるとき、記号は 1 行目の空行に付く(2 行目へ流れない)', () => {
    const r = toggleLinePrefix(sel('|\nあ'), 'h2');
    expect(r.text, '行頭を 1 と読んで、本文が書き換わった').toBe('## \nあ');
    expect([r.start, r.end]).toEqual([0, 3]);
  });

  it('先頭の空行から複数行を選ぶと、選んだ行ぜんぶに付く(頭の空行が選びから落ちない)', () => {
    const r = toggleLinePrefix(sel('|\nあ|'), 'ul');
    expect(r.text).toBe('- \n- あ');
    expect(r.start, '選びの頭がずれた').toBe(0);
  });

  it('対照群: 先頭の行が空でなければ、今までどおり', () => {
    const r = toggleLinePrefix(sel('|あ|\nい'), 'h2');
    expect([r.text, r.start, r.end]).toEqual(['## あ\nい', 0, 4]);
  });
});

describe('🔴 コードブロックで囲む・外す(wrapAsBlock)', () => {
  it('先頭の空行の直後にある開きの行を選んでも、閉じの行を巻き込んで消さない', () => {
    const before = sel('\n|```|\n```');
    const r = wrapAsBlock(before, '```', '```');
    // 「直前の行が開き」と読み違えると、選んだ行そのものを開きと取り、後ろの閉じを消す
    expect(r.text.match(/```/g)?.length, '開きと閉じの対が欠けた').toBeGreaterThanOrEqual(2);
    expect(r.text.startsWith('\n'), '先頭の空行が消えた').toBe(true);
  });

  it('対照群: 先頭が空行でなくても同じ形で同じ答え(行の位置が 1 つずれた形)', () => {
    const r = wrapAsBlock(sel('あ\n|```|\n```'), '```', '```');
    expect(r.text.match(/```/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('対照群: 開き・閉じに挟まれた中身だけを選んだときは、今までどおり外れる', () => {
    const r = wrapAsBlock(sel('あ\n```\n|x|\n```\nい'), '```', '```');
    expect(r.text).toBe('あ\nx\nい');
  });
});

/**
 * 以下 6 か所は `pos = 0` のとき行が空なので、行頭を取り違えても**出力は同じ**。
 * 「先頭が空行の本文で今までどおり」を pin する(戻した変異は最後の describe が殺す)。
 */
describe('先頭が空行の本文で、今までどおり動く(出力が変わらない 6 か所)', () => {
  it('括弧の自動閉じ(autoPairFor)', () => {
    expect(autoPairFor(sel('|\nあ'), '(')).toEqual(autoPairFor(sel('|あ'), '('));
  });

  it('引用の Enter(quoteOnEnter): 先頭の空行では何もしない', () => {
    expect(quoteOnEnter('\n> あ', 0)).toEqual({ kind: 'none' });
    // 対照群: 2 行目の引用は続く
    expect(quoteOnEnter('\n> あ', 4)).toEqual({ kind: 'continue', insert: '\n> ' });
  });

  it('表の Tab(tableOnTab): 先頭の空行では表と読まない / 2 行目の表は動く', () => {
    expect(tableOnTab('\n| a | b |', 0, false)).toBeNull();
    const r = tableOnTab('\n| a | b |', 3, false);
    expect(r?.kind, '2 行目の表で Tab が動かない').toBe('navigate');
  });

  it('行の計算(calcLineAction / explainCalcMiss): 先頭の空行では何もしない', () => {
    expect(calcLineAction('\n1+2', 0)).toBeNull();
    expect(explainCalcMiss('\n1+2=', 0)).toBeNull();
    // 対照群: 2 行目は計算される
    expect(calcLineAction('\n1+2', 4)?.kind).toBe('insert');
  });
});

/**
 * 🔑 **行頭の判定は 1 か所**(§7)── 上の 6 か所は出力を見ても戻した変異を殺せないので、
 * **書き方そのもの**を見る。`lastIndexOf('\n', …)` を素で書いてよいのは `lineStart` と、
 * 行頭ではなく別の用途(`place-embed.ts` の切り口探し)だけ。
 */
describe('🔑 行頭の判定は lineStart の 1 か所', () => {
  function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (p.endsWith('.ts')) out.push(p);
    }
    return out;
  }
  /** 注釈を落とす(自分の解説に満たされない)。 */
  function code(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  }
  const RAW = /lastIndexOf\(\s*'\\n'/;
  const ALLOWED = new Set(['src/features/markdown/line-start.ts', 'src/features/markdown/place-embed.ts']);
  const files = walk('src');

  it('素の lastIndexOf(\'\\n\') は許した 2 file にしか無い(走査が空振りしていない)', () => {
    const hits = files.filter((f) => RAW.test(code(readFileSync(f, 'utf8'))));
    // 空振り防止: 許した 2 file が実際に拾えている(= 走査が生きている)
    expect([...hits].sort()).toEqual([...ALLOWED].sort());
  });
});
