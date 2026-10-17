/** @vitest-environment happy-dom */
import { describe, expect, it } from 'vitest';
import { renderMarkdown, stripComments } from '../../src/features/markdown/markdown-render';
import MarkdownIt from 'markdown-it';
import { advanceFence, fenceStep } from '../../src/features/markdown/list-renumber';
import { hasTaskItems, sortTasksByStatus } from '../../src/features/markdown/task-sort';

/**
 * #1087 M9: 引用(`> ````)・リストの項目(`- ````)の中の fence も、最上位の fence と同じに
 * **1 バイトも触らない**。かつては最上位の fence しか見なかったので、中身の `%%…%%` `||` `__`
 * `_` `+++` が記法として食われた(`%%a%% b` → ` b`、`||x` の行が段落になって fence を壊す)。
 */
const TOKENS = ['%%a%% b', '||x', '|>x', '__x', '_', '+++', '%%%', ':::note', ':::', '{{vars.a}}', ':::comment', '==a=='];

const codeOf = (html: string): string => {
  const doc = new DOMParser().parseFromString('<body>' + html + '</body>', 'text/html');
  return Array.from(doc.body.querySelectorAll('pre code')).map((c) => c.textContent ?? '').join('\n');
};

const WRAPS: Array<[string, (t: string) => string]> = [
  ['top', (t) => '```\n' + t + '\n```'],
  ['quote', (t) => '> ```\n> ' + t + '\n> ```'],
  ['quote2', (t) => '> > ```\n> > ' + t + '\n> > ```'],
  ['list', (t) => '- ```\n  ' + t + '\n  ```'],
  ['ordered', (t) => '1. ```\n   ' + t + '\n   ```'],
  ['quote+list', (t) => '> - ```\n>   ' + t + '\n>   ```'],
];

describe('入れ物の中の fence は素通し #1087 M9', () => {
  for (const [name, wrap] of WRAPS) {
    for (const t of TOKENS) {
      it(`${name}: ${JSON.stringify(t)} がコードのまま残る`, () => {
        const html = renderMarkdown(wrap(t));
        expect(codeOf(html)).toBe(t + '\n');
      });
    }
  }

  it('stripComments: 引用の fence の中の %% は 1 バイトも変わらない', () => {
    const s = '> ```\n> %%a%% b\n> ```';
    expect(stripComments(s).transformed).toBe(s);
  });

  it('対照: fence の外の引用の %%a%% は今までどおり消える', () => {
    expect(stripComments('> %%a%% b').transformed).toBe('>  b');
  });

  it('引用が終わったら fence も終わる(閉じ忘れが後ろを飲まない)', () => {
    const html = renderMarkdown('> ```\n> x\n\n%%a%% VISIBLE');
    expect(html).toContain('VISIBLE');
    expect(html).not.toContain('%%a%%');
  });

  it('fence の後ろの task は原文の行(index 3)を指したまま', () => {
    const html = renderMarkdown('> ```\n> ||x\n> ```\n- [ ] t', { interactiveTasks: true });
    expect([...html.matchAll(/data-pkc-task-line="(\d+)"/g)].map((m) => Number(m[1]))).toEqual([3]);
  });

  it('字下げ(4 SP)のコード: 文書の頭 / 空行の後は素通し', () => {
    for (const t of ['__x', '%%a%% b', '||x', '+++', '_', '%%%']) {
      expect(codeOf(renderMarkdown('    ' + t)), 'head ' + t).toBe(t + '\n');
      expect(codeOf(renderMarkdown('para\n\n    ' + t)), 'after blank ' + t).toBe(t + '\n');
    }
    // 複数行(間の空行もコードの続き)
    expect(codeOf(renderMarkdown('    __a\n\n    %%b%% c'))).toBe('__a\n\n%%b%% c\n');
  });

  it('字下げのコードの後の task は原文の行を指したまま', () => {
    const html = renderMarkdown('para\n\n    %%%\n    x\n\n- [ ] t', { interactiveTasks: true });
    expect([...html.matchAll(/data-pkc-task-line="(\d+)"/g)].map((m) => Number(m[1]))).toEqual([5]);
  });

  it('対照: 段落の続きの 4 SP・リストの項目の続きの 4 SP はコードではないので従来どおり', () => {
    // 空行なしの 4 SP は段落の続き(コードにならない)
    expect(stripComments('para\n    %%a%% b').transformed).toBe('para\n     b');
    // リストの項目の後の空行 + 4 SP は項目の中の段落(コードではない)
    expect(stripComments('- a\n\n    %%a%% b').transformed).toBe('- a\n\n     b');
    // 字下げのコードが終わったら通常に戻る
    expect(stripComments('    %%a%% b\n\n%%c%% d').transformed).toBe('    %%a%% b\n\n d');
  });

  it('advanceFence: 深さの違う行では閉じず、浅い行で畳む', () => {
    const open = advanceFence('', '> ```');
    expect(open).not.toBe('');
    expect(advanceFence(open, '> ```')).toBe('');
    expect(advanceFence(open, '> > ```')).toBe(open);
    expect(advanceFence(open, 'plain')).toBe('');
    // 最上位の fence の中の "> ```" は中身(閉じではない)
    expect(advanceFence('```', '> ```')).toBe('```');
  });
});

/**
 * #1087 M9b: 入れ物(引用・リストの項目)の中で開いた fence は、**入れ物が終わったら終わる**。
 * かつては閉じ忘れの fence が文書の残りを飲み込み、後ろのチェック項目・コメント・見出しが
 * 全部「コードの中」として扱われた(markdown-it は正しく描くので、前処理と描画がずれた)。
 */
const taskLines = (body: string): number[] =>
  [...renderMarkdown(body, { interactiveTasks: true }).matchAll(/data-pkc-task-line="(\d+)"/g)].map((m) => Number(m[1]));
/** 末尾に足した `%%c%%` の行が生きている(= コメントとして消える)か */
const tailLive = (body: string): boolean => !stripComments(body + '\nz %%c%% y').transformed.endsWith('%%c%% y');

describe('打ち切られた fence は後ろを飲まない #1087 M9b', () => {
  const REPROS: Array<[string, string, number[]]> = [
    ['項目の fence + 空行 + 兄弟', '- ```\n  x\n\n- [x] b\n- [ ] a', [3, 4]],
    ['項目の fence の直後に兄弟', '- ```\n- [x] b\n- [ ] a', [1, 2]],
    ['項目の fence の中身の後に兄弟', '- ```\n  x\n- [ ] a\n- [x] b', [2, 3]],
    ['兄弟が fence の開きで、その後ろ', '- ```\n- ```\n- [ ] a', [2]],
    ['引用が終わった行が新しい fence の開き', '> ```\n```\ncode\n```\n- [x] b\n- [ ] a', [4, 5]],
    ['字下げ 4 の ```js は fence ではない', 'p\n\n    ```js\n    code\n\nafter\n- [ ] t', [6]],
  ];
  for (const [name, body, lines] of REPROS) {
    it(`${name}: 後ろの task が生きている`, () => {
      expect(taskLines(body), 'markdown-it と描画').toEqual(lines);
      expect(hasTaskItems(body), 'hasTaskItems').toBe(true);
      const sorted = sortTasksByStatus(body);
      const open = sorted.indexOf('[ ]');
      const done = sorted.indexOf('[x]');
      if (open >= 0 && done >= 0) expect(open, '未完が先に並ぶ').toBeLessThan(done);
      // 末尾の行(fence の外)のコメントが消える ── 前処理が「まだ fence の中」と読んでいない
      expect(tailLive(body), 'stripComments の末尾').toBe(true);
    });
  }

  it('並べ替え: 項目の fence が打ち切られても、後ろの項目が並ぶ', () => {
    expect(sortTasksByStatus('- [x] b\n- [ ] a')).toBe('- [ ] a\n- [x] b');
    expect(sortTasksByStatus('- ```\n  x\n\n- [x] b\n- [ ] a')).toBe('- ```\n  x\n\n- [ ] a\n- [x] b');
  });

  it('字下げ 4 の ```js の後ろの本文はコメントが消える', () => {
    expect(stripComments('p\n\n    ```js\n    code\n\nafter %%c%% d\n- [ ] t').transformed).toBe('p\n\n    ```js\n    code\n\nafter  d\n- [ ] t');
  });

  it('fenceStep: 打ち切られた行は inside が偽で、開きなら読み直す', () => {
    const open = advanceFence('', '- ```');
    expect(fenceStep(open, '  x').inside).toBe(true);
    expect(fenceStep(open, '').inside).toBe(true);
    expect(fenceStep(open, '- [x] b')).toEqual({ next: '', inside: false });
    const again = fenceStep(open, '- ```');
    expect(again.inside).toBe(true);
    expect(again.next).not.toBe('');
    // 引用が終わった行
    const q = advanceFence('', '> ```');
    expect(fenceStep(q, 'plain')).toEqual({ next: '', inside: false });
    expect(fenceStep(q, '```').inside).toBe(true);
  });

  it('閉じは内容の桁から 3 桁まで(4 桁以上の ``` は中身)', () => {
    const open = advanceFence('', '- ```');
    expect(advanceFence(open, '  ```')).toBe('');
    expect(advanceFence(open, '     ```')).toBe('');
    expect(advanceFence(open, '      ```')).toBe(open);
    expect(advanceFence('```', '    ```')).toBe('```');
    expect(advanceFence('```', '   ```')).toBe('');
  });
});

describe('前処理の「コードの中」は markdown-it と一致する(乱数の総当たり) #1087 M9b', () => {
  const POOL = [
    '- [ ] a', '- [x] b', '  - [ ] c', '> - [ ] d', '1. [x] e', '* [ ] f',
    '```', '```js', '~~~', '````', '> ```', '> > ```', '- ```', '  - ```', '> - ```', '1. ```', '    ```js',
    'x', '  x', '    x', '> x', '- x', '  p %%c%% q', 'p %%c%% q', '> p %%c%% q', '- p %%c%% q',
    '', '', '', ':::note', ':::', '---',
  ];
  const rng = (start: number) => () => {
    const seed = (start + 0x6d2b79f5) | 0;
    start = seed;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const md = new MarkdownIt();
  /** markdown-it が task と読む項目の行 / コード(fence・字下げ)の行 */
  const oracle = (body: string): { tasks: number[]; code: Set<number> } => {
    const toks = md.parse(body, {});
    const tasks: number[] = [];
    const code = new Set<number>();
    toks.forEach((t, i) => {
      if ((t.type === 'fence' || t.type === 'code_block') && t.map) {
        for (let l = t.map[0]; l < t.map[1]; l++) code.add(l);
      }
      if (t.type === 'inline' && /^\[[ xX]\](\s|$)/.test(t.content) && toks[i - 1]?.type === 'paragraph_open' && toks[i - 2]?.type === 'list_item_open') {
        tasks.push(toks[i - 2]!.map![0]);
      }
    });
    return { tasks, code };
  };
  // ⚠ 範囲外(見分けられない形): 記号の無い字下げだけの fence の開き(`  ```` )は、リストの項目の続きか最上位かを
  //   1 行からは決められない。最上位として読む(閉じていれば markdown-it と同じ。閉じ忘れだけがずれる)。
  const BODIES = 6000;

  it(`${BODIES} 本: task の行 / hasTaskItems / コメントの生死が markdown-it と一致する`, () => {
    const r = rng(1087);
    const bad: string[] = [];
    let withTasks = 0;
    let withCodeAndTask = 0;
    let unclosed = 0;
    for (let n = 0; n < BODIES; n++) {
      const len = 2 + Math.floor(r() * 8);
      const lines: string[] = [];
      for (let i = 0; i < len; i++) {
        const l = POOL[Math.floor(r() * POOL.length)]!;
        // 字下げ 4 の行は、空行の後にだけ置く(空行なしの 4 SP は段落の続き・入れ物の続きで、読み分けは
        //   `advanceIndent` の持ち場。ここで見るのは fence の開閉。字下げのコードの中の `%%c%%` の行は
        //   リストの中かの読みが保守側に倒れる設計なので、この総当たりには入れない)
        lines.push(/^ {4}/.test(l) && (i === 0 || lines[i - 1] !== '') ? 'x' : l);
      }
      const body = lines.join('\n');
      const o = oracle(body);
      if (o.tasks.length > 0) withTasks += 1;
      if (o.tasks.length > 0 && o.code.size > 0) withCodeAndTask += 1;
      if (lines.some((l, i) => /^[\s>-]*(```|~~~)/.test(l) && o.code.has(i) && !lines.slice(i + 1).some((m) => /^[\s>-]*(```|~~~)\s*$/.test(m)))) unclosed += 1;
      const got = taskLines(body);
      const why: string[] = [];
      if (JSON.stringify(got) !== JSON.stringify(o.tasks)) why.push(`task 行 ${JSON.stringify(got)} != ${JSON.stringify(o.tasks)}`);
      const top = o.tasks.some((l) => !/^\s*>/.test(lines[l]!));
      if (hasTaskItems(body) !== top) why.push(`hasTaskItems ${String(hasTaskItems(body))} != ${String(top)}`);
      const out = stripComments(body).transformed.split('\n');
      if (out.length === lines.length) {
        lines.forEach((l, i) => {
          if (l.includes('%%c%%') && out[i]!.includes('%%c%%') !== o.code.has(i)) why.push(`コメント 行${i} 前処理=${String(out[i]!.includes('%%c%%'))} md=${String(o.code.has(i))}`);
        });
      }
      if (why.length > 0) bad.push(JSON.stringify(body) + '\n   ' + why.join('\n   '));
    }
    // 空振り防止: 検査が実際に task・コード・閉じ忘れを通っている
    expect(withTasks, 'task を持つ本文').toBeGreaterThan(BODIES / 3);
    expect(withCodeAndTask, 'task とコードの両方を持つ本文').toBeGreaterThan(BODIES / 10);
    expect(unclosed, '閉じ忘れの fence を持つ本文').toBeGreaterThan(200);
    expect(bad.slice(0, 8).join('\n'), `不一致 ${bad.length} 本`).toBe('');
  });
});
