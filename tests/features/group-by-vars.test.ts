import { describe, expect, it } from 'vitest';
import {
  FRONTMATTER_SCAN_CHARS,
  TEMPLATE_KEY,
  collectKeys,
  createQueryScan,
  groupByKey,
} from '../../src/features/query/group-by';
import { stampTemplateOrigin } from '../../src/features/snippet/template-origin';

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
    const r = groupByKey(rows, 'vars.ビルド');
    // 件数順なら 1.2(2 件)が先。値の順なら 1.2 → 1.10
    expect(r.groups.map((g) => g.value)).toEqual(['1.2', '1.10', '']);
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
