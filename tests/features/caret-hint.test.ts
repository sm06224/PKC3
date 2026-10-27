import { describe, expect, it } from 'vitest';
import { caretBlockAt, createCaretBlockResolver } from '../../src/features/markdown/caret-hint';
import { codeContextAt } from '../../src/features/markdown/code-context';

const F = '```';

describe('caretBlockAt(#1451)', () => {
  const doc = `---\na: 1\n---\n本文\n${F}js\ncode\n${F}\n$$\nx\n$$\n| a | b |\n`;
  const kind = (s: string, d = 0): string | null => caretBlockAt(doc, doc.indexOf(s) + d).block;

  it('各記法を引き分ける', () => {
    expect(kind('a: 1')).toBe('frontmatter');
    expect(kind('本文')).toBeNull();
    expect(kind('code')).toBe('code');
    expect(kind('x\n$$')).toBe('math');
    expect(kind('| a')).toBe('table');
  });

  it('🔴 閉じの行(frontmatter の閉じ・柵の閉じ・$$ の閉じ)は案内しない / 開きの行は記号の後ろだけ(穴 G)', () => {
    expect(caretBlockAt(doc, doc.indexOf('---\n本文') + 1).block, 'frontmatter の閉じの行').toBeNull();
    expect(caretBlockAt(doc, doc.lastIndexOf(F) + 1).block, '柵の閉じの行').toBeNull();
    expect(caretBlockAt(doc, doc.lastIndexOf('$$') + 1).block, '$$ の閉じの行').toBeNull();
    const open = doc.indexOf(`${F}js`);
    expect(caretBlockAt(doc, open).block, '開きの記号の前').toBeNull();
    const after = caretBlockAt(doc, open + 5);
    expect(after.block).toBe('code');
    expect(after.from, '開き行は範囲を 1 点にして控えを使わせない').toBe(after.to);
  });

  it('🔴 1 行の $$x$$ は数式の塊ではない(誤判定しない)', () => {
    const d = '前\n$$x^2$$\n後\n';
    for (const s of ['前', 'x^2', '後']) expect(caretBlockAt(d, d.indexOf(s)).block, s).toBeNull();
  });

  it('🔴 閉じは実際の柵の字で言う(~~~ / 4 個)', () => {
    const t = '~~~\nabc\n~~~\n';
    expect(caretBlockAt(t, t.indexOf('abc')).hint).toBe('コード内: 記法は働きません(閉じは ~~~)');
    const q = `\`\`\`\`\nabc\n\`\`\`\`\n`;
    expect(caretBlockAt(q, q.indexOf('abc')).hint).toBe('コード内: 記法は働きません(閉じは ````)');
  });

  it('🔴 解釈される柵は専用の字を出す(コードの字を言わない)', () => {
    const hint = (info: string): string | null => {
      const d = `${F}${info}\nbody\n${F}\n`;
      return caretBlockAt(d, d.indexOf('body')).hint;
    };
    expect(hint('csv')).toBe(`表(csv)の中: 閉じは ${F}`);
    expect(hint('mermaid')).toBe(`図(mermaid)の中: 閉じは ${F}`);
    expect(hint('chart-render')).toBe(`グラフ(chart)の中: 閉じは ${F}`);
    expect(hint('js'), '対照群: 素のコード').toBe(`コード内: 記法は働きません(閉じは ${F})`);
    expect(hint('csv')).not.toContain('記法は働きません');
  });

  it('板の付箋の中では案内が出る(閉じの行と外は出ない)', () => {
    const d = '前\n:::format{.pkc-place x=40 y=40}\n中身\n:::\n後\n';
    expect(caretBlockAt(d, d.indexOf('中身')).block).toBe('board');
    expect(caretBlockAt(d, d.indexOf('中身')).hint).toContain('x= y=');
    expect(caretBlockAt(d, d.indexOf('前')).block).toBeNull();
    expect(caretBlockAt(d, d.indexOf('後')).block).toBeNull();
    expect(caretBlockAt(d, d.lastIndexOf(':::') + 1).block, '閉じの行').toBeNull();
    // 対照群: 板でない囲み(:::note)
    const n = ':::note\n中身\n:::\n';
    expect(caretBlockAt(n, n.indexOf('中身')).block).toBeNull();
  });

  it('印が無い本文は null', () => {
    expect(caretBlockAt('普通の文', 2).block).toBeNull();
  });
});

/** 決定的な疑似乱数(再現できる失敗にする)。 */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

describe('🔴 索引(block-spans)は codeContextAt と同じ答えを返す(生成した文書)', () => {
  const PARTS = [
    '通常の行', F + 'js', F, '~~~', '~~~~', '$$', '$$x$$', '    字下げ', '', F + 'csv', 'a,b',
  ];
  it('500 文書 × 全 caret 位置で、塊の中かどうかが一致する(閉じの行・開き行の記号前は案内しない約束で補正)', () => {
    const r = rng(12345);
    let checked = 0;
    let inside = 0;
    for (let n = 0; n < 500; n++) {
      const lines: string[] = [];
      const len = 3 + Math.floor(r() * 14);
      for (let i = 0; i < len; i++) lines.push(PARTS[Math.floor(r() * PARTS.length)]!);
      const doc = lines.join('\n');
      const resolver = createCaretBlockResolver();
      for (let caret = 0; caret <= doc.length; caret++) {
        const ls = caret === 0 ? 0 : doc.lastIndexOf('\n', caret - 1) + 1;
        const le = doc.indexOf('\n', ls) === -1 ? doc.length : doc.indexOf('\n', ls);
        const line = doc.slice(ls, le);
        const ctx = codeContextAt(doc, caret);
        const got = resolver.at(doc, caret);
        // 表の行は表が勝つ(別の判定)
        if (got.block === 'table') continue;
        const want = ctx === 'fence' ? 'code' : ctx === 'math' ? 'math' : null;
        // 約束: 閉じの行は案内しない。codeContextAt は閉じの行を「中」と数えるので、索引が null のときは閉じの行だけが違ってよい
        if (got.block === null && want !== null) {
          // 閉じの行(約束で案内しない)/ 開き記号の行(`codeContextAt` は行頭の `$$` を打ち終えた時点で「中」と読むが、
          // 索引は `$$` だけの行で開く塊だけを数える ── 1 行の `$$x$$` は誤判定しない)
          const marker = /^\s*(?:>\s*)*(?:`{3,}|~{3,}|\$\$)/.test(line);
          expect(marker, `閉じの行・開きの行以外で食い違った: ${JSON.stringify(doc)} @${caret}`).toBe(true);
        } else if (got.block === 'frontmatter' || got.block === 'board') {
          continue;
        } else {
          expect(got.block, `${JSON.stringify(doc)} @${caret}`).toBe(want);
        }
        checked += 1;
        if (want !== null) inside += 1;
      }
    }
    expect(checked, '比べた数が 0(空振り)').toBeGreaterThan(5000);
    expect(inside, '塊の中を一度も通っていない(空振り)').toBeGreaterThan(500);
  });
});

describe('入れ物が終わって打ち切られた囲み(codeContextAt より正確)', () => {
  it('引用・リストの項目の中で開いた囲みは、入れ物が終わった行から「外」になる', () => {
    const q = `> ${F}
> 中
外の行
`;
    expect(caretBlockAt(q, q.indexOf('中')).block).toBe('code');
    expect(caretBlockAt(q, q.indexOf('外')).block, '引用が終わった行').toBeNull();
    const l = `- ${F}sh
  中
外の行
`;
    expect(caretBlockAt(l, l.indexOf('中')).block).toBe('code');
    expect(caretBlockAt(l, l.indexOf('外')).block, 'リストの項目が終わった行').toBeNull();
  });
});

describe('🔴 大きいノートでも、案内は打鍵ごとに全文をなぞらない(⚠3)', () => {
  it('1.5MB・囲み 3000 で、索引を作った後の問い合わせは 1 件あたり 1ms 未満', () => {
    const chunk = (i: number): string =>
      `見出し ${i}\n` + 'あ'.repeat(200) + `\n${F}js\nlet a${i} = 1;\n${F}\n` + 'い'.repeat(150) + '\n';
    let doc = '';
    for (let i = 0; i < 3000; i++) doc += chunk(i);
    while (doc.length < 1_500_000) doc += 'う'.repeat(300) + '\n';
    const resolver = createCaretBlockResolver();
    const t0 = performance.now();
    resolver.at(doc, 10); // 索引を作る(本文が変わったときの 1 回)
    const build = performance.now() - t0;
    expect(build, `索引の作成が重い: ${build.toFixed(1)}ms`).toBeLessThan(400);
    let hits = 0;
    const t1 = performance.now();
    const N = 2000;
    for (let k = 0; k < N; k++) {
      const caret = Math.floor((doc.length * (k + 0.5)) / N);
      if (resolver.at(doc, caret).block === 'code') hits += 1;
    }
    const per = (performance.now() - t1) / N;
    expect(hits, '囲みの中を 1 つも引いていない(空振り)').toBeGreaterThan(0);
    expect(per, `問い合わせが重い: ${per.toFixed(3)}ms/件`).toBeLessThan(1);
    // 対照群: 本文が変わったら索引を作り直す(古い索引で答えない)
    const edited = doc.replace('let a5 = 1;', 'let a5 = 1;\n'.repeat(1));
    expect(resolver.at(edited, edited.indexOf('let a5') + 2).block).toBe('code');
  });
});
