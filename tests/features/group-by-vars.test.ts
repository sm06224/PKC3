import { describe, expect, it } from 'vitest';
import {
  FRONTMATTER_SCAN_CHARS,
  QUERY_LIMITS,
  allPlainNumbers,
  compareVarValues,
  TEMPLATE_KEY,
  collectKeys,
  createQueryScan,
  groupByKey,
} from '../../src/features/query/group-by';
import { parseFrontmatter } from '../../src/features/markdown/frontmatter';
import { hasFormFence, stampTemplateOrigin } from '../../src/features/snippet/template-origin';

const rec = (tpl: string, vars: Record<string, string>): string =>
  `---\ntemplate: ${tpl}\n${Object.entries(vars)
    .map(([k, v]) => `vars.${k}: ${v}`)
    .join('\n')}\n---\n本文`;

describe('#2002 段 4: 入力欄の値(vars.<名前>)を集計に出す', () => {
  const rows = [
    { lid: 'a', head: rec('回帰', { ビルド: '1.10', 結果: '合格' }) },
    { lid: 'b', head: rec('回帰', { ビルド: '1.2', 結果: '不合格' }) },
    { lid: 'c', head: rec('回帰', { ビルド: '1.2', 結果: '合格' }) },
    { lid: 'd', head: rec('引き継ぎ', { 担当: '佐藤' }) },
  ];

  it('目録に vars.<名前> と template が出る', () => {
    const keys = collectKeys(rows).keys.map((k) => k.key);
    expect(keys).toContain('vars.ビルド');
    expect(keys).toContain('vars.結果');
    expect(keys).toContain(TEMPLATE_KEY);
  });

  it('template で束ねると、同じテンプレートの記録が 1 組になり、vars の列が付く', () => {
    const r = groupByKey(rows, TEMPLATE_KEY);
    const kai = r.groups.find((g) => g.value === '回帰')!;
    expect([...kai.lids]).toEqual(['a', 'b', 'c']);
    expect(r.columns).toContain('ビルド');
    const col = r.columns!.indexOf('結果');
    expect(r.cells!['a']![col]).toBe('合格');
    expect(r.cells!['b']![col]).toBe('不合格');
    // 値を持たない列は空(別テンプレートの行)
    expect(r.cells!['d']![col]).toBe('');
  });

  it('vars.<名前> で束ねると値の順(数は数として)に並ぶ。件数順ではない', () => {
    // 件数順なら 1.2(1 件)が 1.10(2 件)の後ろ。値の順なら 1.2 → 1.10(件数と値の順が食い違う fixture)
    const r = groupByKey(
      [
        { lid: 'a', head: rec('回帰', { ビルド: '1.10' }) },
        { lid: 'b', head: rec('回帰', { ビルド: '1.10' }) },
        { lid: 'c', head: rec('回帰', { ビルド: '1.2' }) },
        { lid: 'd', head: rec('引き継ぎ', { 担当: '佐藤' }) },
      ],
      'vars.ビルド',
    );
    expect(r.groups.map((g) => g.value)).toEqual(['1.2', '1.10', '']);
    expect(r.groups.map((g) => g.total)).toEqual([1, 2, 1]);
    expect(r.groups[2]!.lids).toEqual(['d']);
  });

  it('手で vars: の下に字下げして書いた値も vars.<名前> として読む(トップレベルの key にしない対照付き)', () => {
    const r = groupByKey([{ lid: 'x', head: '---\nvars:\n  状態: 進行\n---\n' }], 'vars.状態');
    expect(r.groups[0]!.value).toBe('進行');
  });

  it('列が無いときは columns / cells を出さない(対照群)', () => {
    const r = groupByKey([{ lid: 'x', head: '---\nauthor: 佐藤\n---\n' }], 'author');
    expect(r.columns).toBeUndefined();
  });

  it('列は上限(8)で切る', () => {
    const vars: Record<string, string> = {};
    for (let i = 0; i < 12; i += 1) vars[`k${i}`] = 'v';
    const r = groupByKey([{ lid: 'x', head: rec('t', vars) }], TEMPLATE_KEY);
    expect(r.columns).toHaveLength(8);
  });

  it('先頭の設定欄が窓(16KB)を超えて閉じないノートの数を言う', () => {
    const long = `---\n${'vars.x: ' + 'a'.repeat(FRONTMATTER_SCAN_CHARS)}`.slice(0, FRONTMATTER_SCAN_CHARS);
    const scan = createQueryScan(null);
    scan.feed([
      { lid: 'long', head: long },
      { lid: 'ok', head: rec('t', { a: '1' }) },
    ]);
    expect(scan.finish().keys.unreadable).toBe(1);
    // 対照: 短い囲みは数えない
    const none = createQueryScan(null);
    none.feed([{ lid: 'ok', head: rec('t', { a: '1' }) }]);
    expect(none.finish().keys.unreadable).toBe(0);
  });
});

describe('#2002 段 4: 値の順(compareVarValues)', () => {
  const sort = (xs: string[]): string[] => {
    const num = allPlainNumbers(xs);
    return [...xs].sort((a, b) => compareVarValues(a, b, num));
  };
  it('小数・負の数を数として並べる', () => {
    expect(sort(['0.5', '0.25', '10.5', '9.75', '-1', '2'])).toEqual(['-1', '0.25', '0.5', '2', '9.75', '10.5']);
  });
  it('groupByKey でも小数が数の順', () => {
    const r = groupByKey(
      ['0.5', '0.25', '10.5', '9.75', '-1', '2'].map((v, i) => ({ lid: `l${i}`, head: rec('t', { x: v }) })),
      'vars.x',
    );
    expect(r.groups.map((g) => g.value)).toEqual(['-1', '0.25', '0.5', '2', '9.75', '10.5']);
  });
  it('小数部の末尾が 0 の値(1.10)があれば版番号として読む。判定は列に 1 回なので推移律が崩れない', () => {
    expect(allPlainNumbers(['1.25', '1.5', '1.10'])).toBe(false);
    expect(sort(['1.10', '1.5', '1.25', '1.2'])).toEqual(['1.2', '1.5', '1.10', '1.25']);
    expect(allPlainNumbers(['1.25', '1.5', ''])).toBe(true);
    expect(allPlainNumbers([''])).toBe(false);
  });
  it('日付・日時は時刻の順、版番号は区切りごとの数の順、文字は自然な順', () => {
    expect(sort(['2026-11-21', '2026-02-03', '2026-11-03'])).toEqual(['2026-02-03', '2026-11-03', '2026-11-21']);
    expect(sort(['2026-11-21T10:00', '2026-11-21T09:30'])).toEqual(['2026-11-21T09:30', '2026-11-21T10:00']);
    expect(sort(['1.10.1', '1.2.9', '1.2'])).toEqual(['1.2', '1.2.9', '1.10.1']);
    expect(sort(['段階10', '段階2', 'あ'])).toEqual(['あ', '段階2', '段階10']);
  });
  it('数と文字が混ざっても決まった順になる(同値は字の順で必ず決まる)', () => {
    const a = sort(['b', '10', '2', 'a', '1.0', '1']);
    expect(sort([...a].reverse())).toEqual(a);
    expect(a.indexOf('2')).toBeLessThan(a.indexOf('10'));
  });
});

describe('#2002 段 4: 上限で切られた行は列・値に影響しない', () => {
  it('lid の上限(組あたり)を超えた行の vars は列にも値にも出ない', () => {
    const rows = [];
    for (let i = 0; i < QUERY_LIMITS.lidsPerGroup; i += 1) rows.push({ lid: `in${i}`, head: rec('t', { 本線: '1' }) });
    for (let i = 0; i < 3; i += 1) rows.push({ lid: `out${i}`, head: rec('t', { 外れ: '9' }) });
    const r = groupByKey(rows, TEMPLATE_KEY);
    expect(r.groups[0]!.total).toBe(QUERY_LIMITS.lidsPerGroup + 3);
    expect(r.groups[0]!.lids).toHaveLength(QUERY_LIMITS.lidsPerGroup);
    expect(r.columns).toEqual(['本線']);
    expect(Object.keys(r.cells!)).toHaveLength(QUERY_LIMITS.lidsPerGroup);
    expect(r.cells!['out0']).toBeUndefined();
  });
  it('組の上限(200)を超えて捨てられた組の行は列に影響しない', () => {
    const rows = [];
    for (let i = 0; i < QUERY_LIMITS.groups + 5; i += 1)
      rows.push({ lid: `r${i}`, head: rec('t', { n: String(i), ...(i >= QUERY_LIMITS.groups ? { 捨て列: 'x' } : {}) }) });
    const r = groupByKey(rows, 'vars.n');
    expect(r.groups).toHaveLength(QUERY_LIMITS.groups);
    expect(r.omittedGroups).toBe(5);
    expect(r.columns).toEqual(['n']);
    expect(r.cells!['r204']).toBeUndefined();
  });
  it('値は 80 字で丸めて持つ', () => {
    const r = groupByKey([{ lid: 'x', head: rec('t', { 長い: 'あ'.repeat(200) }) }], TEMPLATE_KEY);
    expect(r.cells!['x']![0]).toBe('あ'.repeat(QUERY_LIMITS.valueChars) + '…');
  });
  it('列は「多く書かれた順 → 名前の字順」(件数の順と名前の順が食い違う)', () => {
    const rows = [
      { lid: 'a', head: rec('t', { あ: '1', い: '1', う: '1' }) },
      { lid: 'b', head: rec('t', { い: '1', う: '1' }) },
      { lid: 'c', head: rec('t', { う: '1', あ: '1' }) },
      { lid: 'd', head: rec('t', { う: '1' }) },
    ];
    // う 4 / あ 2 / い 2(あ と い は同数 → 名前の字順)
    expect(groupByKey(rows, TEMPLATE_KEY).columns).toEqual(['う', 'あ', 'い']);
  });
  it('列は組の違う行から数える', () => {
    const rows = [
      { lid: 'a', head: rec('回帰', { 結果: '1' }) },
      { lid: 'b', head: rec('引き継ぎ', { 担当: '1', 結果: '2' }) },
      { lid: 'c', head: rec('引き継ぎ', { 担当: '1' }) },
    ];
    expect(groupByKey(rows, TEMPLATE_KEY).columns).toEqual(['担当', '結果']);
  });
});

describe('#2002 段 4: 読めなかった件数の対照', () => {
  const unclosed = (n: number): string => ('---\n' + 'vars.x: a\n'.repeat(Math.ceil(n / 10))).slice(0, n);
  const count = (head: string): number => {
    const s = createQueryScan(null);
    s.feed([{ lid: 'x', head }]);
    return s.finish().keys.unreadable ?? -1;
  };
  it('短くて閉じていない設定欄は数えない(窓の外に続きが無い)', () => {
    expect(count(unclosed(200))).toBe(0);
    expect(count(unclosed(FRONTMATTER_SCAN_CHARS - 1))).toBe(0);
  });
  it('窓いっぱいで、先頭が --- でない長いノートは数えない', () => {
    expect(count(('# 題\n' + 'x: y\n'.repeat(FRONTMATTER_SCAN_CHARS)).slice(0, FRONTMATTER_SCAN_CHARS))).toBe(0);
  });
  it('先頭が水平線で始まる長い文書(設定欄の行が無い)は数えない', () => {
    expect(count(('---\n\n' + 'ただの文章。\n'.repeat(FRONTMATTER_SCAN_CHARS)).slice(0, FRONTMATTER_SCAN_CHARS))).toBe(0);
  });
  it('ちょうど窓の長さで閉じていなければ数える。閉じていれば数えない(境界)', () => {
    expect(count(unclosed(FRONTMATTER_SCAN_CHARS))).toBe(1);
    const closed = ('---\nvars.x: a\n---\n' + 'あ'.repeat(FRONTMATTER_SCAN_CHARS)).slice(0, FRONTMATTER_SCAN_CHARS);
    expect(count(closed)).toBe(0);
  });
});

const FORM = '```yaml form\nfields:\n  - name: a\n```\n';

describe('#2002 段 4: テンプレートの出自を残す', () => {
  it('入力欄つきの本文には template: を設定欄へ足し、vars は壊さない', () => {
    const out = stampTemplateOrigin('---\nvars.a: 1\n---\n' + FORM, '回帰テスト');
    expect(out).toContain('template: 回帰テスト');
    expect(out).toContain('vars.a: 1');
    expect(out.endsWith(FORM)).toBe(true);
  });
  it('囲みが無い本文には囲みを前置する', () => {
    expect(stampTemplateOrigin(FORM, '雛形')).toBe('---\ntemplate: 雛形\n---\n' + FORM);
  });
  it('入力欄の無い本文には書かない(対照)', () => {
    expect(stampTemplateOrigin('# 議事録', '雛形')).toBe('# 議事録');
  });
  it('既に template: があれば書き換えない / 題名が空なら何もしない', () => {
    const b = '---\ntemplate: 手書き\n---\n' + FORM;
    expect(stampTemplateOrigin(b, '別')).toBe(b);
    expect(stampTemplateOrigin(FORM, '  ')).toBe(FORM);
  });
});

describe('#2002 段 4: 題名の刻印は読み戻して同じ題名になる', () => {
  const titles = ['a: b', '#x', 'He said "hi"', '---', "it's", '12', 'null', 'true', '[a, b]', '- x', '日本語: 題', 'a # b', '  前後  '];
  for (const t of titles) {
    it(`題名 ${JSON.stringify(t)}`, () => {
      const out = stampTemplateOrigin(FORM, t);
      expect(out).not.toBe(FORM);
      expect(parseFrontmatter(out).meta[TEMPLATE_KEY]).toBe(t.trim());
      expect(parseFrontmatter(out).body).toBe(FORM);
    });
  }
  it('対照: 引用せずに手書きした刻印は、これらの題名では読み戻せない', () => {
    const bad = ['a: b', '#x', 'null', '12', '---'].filter((t) => {
      const v = parseFrontmatter(`---\ntemplate: ${t}\n---\n`).meta[TEMPLATE_KEY];
      return v !== t;
    });
    expect(bad.length).toBeGreaterThanOrEqual(3);
  });
});

describe('#2002 段 4: 入力欄の囲みの判定(hasFormFence)', () => {
  it('ふつうの囲みは入力欄', () => {
    expect(hasFormFence('# a\n\n```yaml form\nfields: []\n```\n')).toBe(true);
    expect(hasFormFence('~~~yml form\nfields: []\n~~~\n')).toBe(true);
  });
  it('4 本の囲みの中に書いた yaml form は定義ではない', () => {
    const b = '````md\n```yaml form\nfields: []\n```\n````\n';
    expect(hasFormFence(b)).toBe(false);
    expect(stampTemplateOrigin(b, 't')).toBe(b);
  });
  it('他の言語の囲みの中の行は定義ではないが、閉じた後ろの入力欄は数える', () => {
    expect(hasFormFence('```js\n```yaml form\n```\n')).toBe(false);
    expect(hasFormFence('````md\nx\n````\n\n```yaml form\nfields: []\n```\n')).toBe(true);
  });
  it('form の無い yaml は入力欄ではない', () => {
    expect(hasFormFence('```yaml\na: 1\n```\n')).toBe(false);
  });
});
