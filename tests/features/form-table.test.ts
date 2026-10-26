/** @vitest-environment node */
/**
 * 🔴 **入力欄 ⇄ 表の行**(#1456)。
 *
 * 期待値は**字面で書く**(実装と同じ切り方で組むと同じ盲点を共有する)。frontmatter を持たせる
 * (行番号の起点が frontmatter の下であることを見る ── 0 行の fixture は永久に緑)。
 */
import { describe, expect, it } from 'vitest';
import { applyBodyRewrite } from '../../src/features/markdown/body-rewrite';
import { loadFormRow, planFormRow, readFormTable } from '../../src/features/markdown/form-table';

const FM = '---\nvars.氏名: 山田\n---\n';
const BODY = [
  FM + '# 日報',
  '',
  '```csv name=日報一覧',
  '氏名,件数,備考',
  '山田,3,"a,b"',
  '佐藤,5,',
  '```',
  '',
  '```csv name=別の表',
  'x,y',
  '1,2',
  '```',
  '',
].join('\n');

const FIELDS = [
  { name: '氏名', label: 'お名前' },
  { name: '件数', label: '件数' },
];

const ok = (p: ReturnType<typeof planFormRow>): string => {
  expect(p.ok, p.ok ? '' : p.why).toBe(true);
  return p.ok ? p.body : '';
};

describe('表を読む', () => {
  it('見出しとデータ行(frontmatter の下から数える / 同じノートの別の表と取り違えない)', () => {
    const t = readFormTable(BODY, '日報一覧')!;
    expect(t.header).toEqual(['氏名', '件数', '備考']);
    expect(t.rows).toEqual([
      ['山田', '3', 'a,b'],
      ['佐藤', '5', ''],
    ]);
    expect(readFormTable(BODY, '別の表')!.rows).toEqual([['1', '2']]);
    expect(readFormTable(BODY, 'ない')).toBeNull();
  });
});

describe('表に追加', () => {
  it('🔴 末尾に 1 行足す(見出しの順・入力欄に無い列は空・他の行と別の表は 1 バイトも動かない)', () => {
    const next = ok(planFormRow(BODY, { mode: 'add', table: '日報一覧', fields: FIELDS, cells: { 氏名: '鈴木, 花', 件数: '7' } }));
    expect(next).toBe(BODY.replace('佐藤,5,\n```', '佐藤,5,\n"鈴木, 花",7,\n```'));
  });

  it('🔴 見出しに無い入力欄は見出しの右に足す(既存の行は触らない)', () => {
    const next = ok(
      planFormRow(BODY, {
        mode: 'add',
        table: '日報一覧',
        fields: [...FIELDS, { name: '区分', label: '区分' }],
        cells: { 氏名: 'A', 件数: '1', 区分: '休み' },
      }),
    );
    expect(next).toContain('氏名,件数,備考,区分\n山田,3,"a,b"\n佐藤,5,\nA,1,,休み\n```');
  });

  it('見出しは表示名で書いてあってもよい', () => {
    const body = '```csv name=T\nお名前,件数\nx,1\n```\n';
    const next = ok(planFormRow(body, { mode: 'add', table: 'T', fields: FIELDS, cells: { 氏名: 'y', 件数: '2' } }));
    expect(next).toBe('```csv name=T\nお名前,件数\nx,1\ny,2\n```\n');
  });

  it('🔴 表が無ければ、項目名を見出しにして末尾に作る(本文は先頭から無傷)', () => {
    const body = FM + '# 日報\n\n本文\n';
    const next = ok(planFormRow(body, { mode: 'add', table: '新規', fields: FIELDS, cells: { 氏名: 'A', 件数: '1' } }));
    expect(next).toBe(body + '\n```csv name=新規\n氏名,件数\nA,1\n```\n');
  });

  it('空の表(囲みだけ)には見出しから作る', () => {
    const next = ok(planFormRow('```csv name=T\n```\n', { mode: 'add', table: 'T', fields: FIELDS, cells: { 氏名: 'A', 件数: '1' } }));
    expect(next).toBe('```csv name=T\n氏名,件数\nA,1\n```\n');
  });

  it('引用の中の表にも、前置きを付けて足す', () => {
    const body = '> ```csv name=T\n> 氏名,件数\n> a,1\n> ```\n';
    const next = ok(planFormRow(body, { mode: 'add', table: 'T', fields: FIELDS, cells: { 氏名: 'b', 件数: '2' } }));
    expect(next).toBe('> ```csv name=T\n> 氏名,件数\n> a,1\n> b,2\n> ```\n');
  });

  it('tsv の囲みは区切りがタブ', () => {
    const body = '```tsv name=T\n氏名\t件数\n```\n';
    const next = ok(planFormRow(body, { mode: 'add', table: 'T', fields: FIELDS, cells: { 氏名: 'a b', 件数: '2' } }));
    expect(next).toBe('```tsv name=T\n氏名\t件数\na b\t2\n```\n');
  });

  it('noheader の表は断る(理由つき)', () => {
    const p = planFormRow('```csv noheader name=T\n1,2\n```\n', { mode: 'add', table: 'T', fields: FIELDS, cells: {} });
    expect(p).toMatchObject({ ok: false });
    expect(p.ok ? '' : p.why).toContain('noheader');
  });
});

describe('表の行を更新', () => {
  it('🔴 指定した行だけを書き換える(入力欄に無い列は元の升のまま / 他の行・別の表は無傷)', () => {
    const next = ok(planFormRow(BODY, { mode: 'update', table: '日報一覧', row: 2, fields: FIELDS, cells: { 氏名: '佐藤2', 件数: '9' } }));
    expect(next).toBe(BODY.replace('佐藤,5,\n', '佐藤2,9,\n'));
  });

  it('範囲外の行・無い表は理由を言う', () => {
    const p1 = planFormRow(BODY, { mode: 'update', table: '日報一覧', row: 3, fields: FIELDS, cells: {} });
    expect(p1.ok ? '' : p1.why).toContain('行 3 はありません');
    const p0 = planFormRow(BODY, { mode: 'update', table: '日報一覧', row: 0, fields: FIELDS, cells: {} });
    expect(p0.ok).toBe(false);
    const p2 = planFormRow(BODY, { mode: 'update', table: 'ない', row: 1, fields: FIELDS, cells: {} });
    expect(p2.ok ? '' : p2.why).toContain('見つかりません');
  });

  it('🔴 升の中に改行がある表では、行の番号が原文の行と合わないので更新を断る(追加は通る)', () => {
    const body = '```csv name=T\n氏名,件数\n"a\nb",1\nc,2\n```\n';
    const p = planFormRow(body, { mode: 'update', table: 'T', row: 2, fields: FIELDS, cells: { 氏名: 'z' } });
    expect(p.ok ? '' : p.why).toContain('改行');
    const add = planFormRow(body, { mode: 'add', table: 'T', fields: FIELDS, cells: { 氏名: 'z', 件数: '3' } });
    expect(add.ok).toBe(true);
  });
});

describe('表の行を読み込む', () => {
  it('見出し（項目名でも表示名でも）に合う列だけを、項目名 → 値で返す', () => {
    const got = loadFormRow(BODY, '日報一覧', 1, [...FIELDS, { name: '区分', label: '区分' }]);
    expect(got).toEqual({ ok: true, cells: { 氏名: '山田', 件数: '3' } });
    const labeled = loadFormRow('```csv name=T\nお名前,件数\nx,1\n```\n', 'T', 1, FIELDS);
    expect(labeled).toEqual({ ok: true, cells: { 氏名: 'x', 件数: '1' } });
  });

  it('範囲外・無い表は理由を言う', () => {
    expect(loadFormRow(BODY, '日報一覧', 9, FIELDS)).toMatchObject({ ok: false });
    expect(loadFormRow(BODY, 'ない', 1, FIELDS)).toMatchObject({ ok: false });
  });
});

describe('書込の道(body-rewrite の form-row)', () => {
  it('計画と同じ結果を返す / 計画が断るものは null(黙って別の行を書かない)', () => {
    const rw = { kind: 'form-row', table: '日報一覧', mode: 'add', fields: FIELDS, cells: { 氏名: 'A', 件数: '1' } } as const;
    expect(applyBodyRewrite(BODY, rw)).toBe(ok(planFormRow(BODY, { mode: 'add', table: '日報一覧', fields: FIELDS, cells: { 氏名: 'A', 件数: '1' } })));
    expect(applyBodyRewrite(BODY, { ...rw, mode: 'update', row: 99 })).toBeNull();
  });
});
