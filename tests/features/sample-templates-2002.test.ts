/**
 * 🔴 #2002 段 2 ── 組み込みのサンプルテンプレートと、「テンプレートから作る」が入力欄の囲み・表をそのまま写すこと。
 */
import { describe, expect, it } from 'vitest';
import { SAMPLE_TEMPLATES, sampleById, sampleLabel } from '../../src/features/snippet/sample-templates';
import { insertSnippet } from '../../src/features/snippet/snippet-expand';
import { snippetItemOf } from '../../src/features/snippet/snippet-table';
import { parseFormDef } from '../../src/features/markdown/form-def';
import { planFormRow, readFormTable } from '../../src/features/markdown/form-table';

const NOW = new Date(2026, 10, 21, 9, 5);
const make = (body: string): string => insertSnippet({ text: '', start: 0, end: 0 }, body, NOW).text;
const fenceOf = (body: string, info: string): string => {
  const lines = body.split('\n');
  const at = lines.findIndex((l) => l.startsWith('```' + info));
  if (at < 0) return '';
  const end = lines.findIndex((l, i) => i > at && l === '```');
  return lines.slice(at, end + 1).join('\n');
};

describe('🔴 テンプレートから作ると、入力欄の囲みと表が 1 バイトも変わらない', () => {
  const BODY = [
    '---',
    'abbr: rep',
    '---',
    '# 記録 ${date}',
    '',
    '---',
    '',
    '氏名は {{vars.氏名}} です。',
    '',
    '```yaml form',
    'title: 記録',
    'table: 記録表',
    'fields:',
    '  - name: 氏名',
    '    placeholder: ${date} の人',
    '  - name: 区分',
    '    type: radio',
    '    options: [a, b]',
    '```',
    '',
    '```csv name=記録表',
    '氏名,区分',
    '"山田, 太郎",a',
    '```',
    '',
  ].join('\n');

  it('囲み 2 つは原文のまま。変わるのは囲みの外の ${date} だけ', () => {
    const item = snippetItemOf('t1', '記録', BODY)!;
    const made = make(item.body);
    const form = fenceOf(item.body, 'yaml form');
    const table = fenceOf(item.body, 'csv name=記録表');
    expect(form, '囲みを見つけられていない').toContain('options: [a, b]');
    expect(table).toContain('"山田, 太郎",a');
    expect(made).toContain(form);
    expect(made).toContain(table);
    expect(made).toContain('# 記録 2026-11-21');
    expect(made).toContain('{{vars.氏名}}');
    expect(made.split('\n').filter((l) => l === '---'), '本文中の --- が消えた').toHaveLength(1);
    expect(made).toContain('placeholder: ${date} の人'); // 囲みの中は値にされない
  });
});

const RECORDS = SAMPLE_TEMPLATES.filter((s) => s.kind === 'record');

describe('組み込みのサンプル(記録 3 本)', () => {
  it('3 本・題名・一覧の字が引ける', () => {
    expect(RECORDS.map((s) => s.title)).toEqual(['回帰テストの実施記録', '当番の引き継ぎ', '仮説と検証の記録']);
    for (const s of SAMPLE_TEMPLATES) {
      expect(sampleById(s.id)).toBe(s);
      expect(sampleLabel(s)).toContain(s.title);
    }
    expect(sampleById('nothing')).toBeNull();
  });

  it('使う入力欄の型が 9 種(text / textarea / number / select / radio / checkbox-group / date / datetime / checkbox)そろう', () => {
    const all = RECORDS.map((s) => s.body).join('\n');
    for (const t of ['text', 'textarea', 'number', 'select', 'radio', 'checkbox-group', 'date', 'datetime', 'checkbox'])
      expect(all, t).toMatch(new RegExp(`type: ${t}$`, 'm'));
  });

  for (const s of RECORDS) {
    describe(s.title, () => {
      const made = make(s.body);
      const def = parseFormDef(fenceOf(made, 'yaml form').split('\n').slice(1, -1).join('\n'));

      it('入力欄の定義に誤りが 0 件で、囲みは作った後も原文どおり', () => {
        expect(def.errors).toEqual([]);
        expect(def.fields.length).toBeGreaterThanOrEqual(8);
        expect(made).toContain(fenceOf(s.body, 'yaml form'));
        expect(made).toContain(fenceOf(s.body, 'csv name='));
        expect(made).not.toContain('${date}');
      });

      it('表の見出しは入力欄の項目名と同じ並びで、「表に追加」で 1 行たまる', () => {
        expect(def.table).not.toBe('');
        const t0 = readFormTable(made, def.table);
        expect(t0, '連携先の表が無い').not.toBeNull();
        expect(t0!.header).toEqual(def.fields.map((f) => f.name));
        expect(t0!.rows).toHaveLength(0);
        const cells: Record<string, string> = {};
        for (const f of def.fields)
          cells[f.name] = f.type === 'checkbox-group' ? `${f.options[0]}, ${f.options[1]}` : `値-${f.name}`;
        const fields = def.fields.map((f) => ({ name: f.name, label: f.label }));
        const p1 = planFormRow(made, { mode: 'add', table: def.table, fields, cells });
        expect(p1.ok).toBe(true);
        if (!p1.ok) return;
        const t1 = readFormTable(p1.body, def.table)!;
        expect(t1.rows).toHaveLength(1);
        expect(t1.rows[0]).toEqual(def.fields.map((f) => cells[f.name]));
        const p2 = planFormRow(p1.body, { mode: 'add', table: def.table, fields, cells });
        expect(p2.ok).toBe(true);
        if (!p2.ok) return;
        expect(readFormTable(p2.body, def.table)!.rows).toHaveLength(2);
        expect(p2.body.match(/^```csv name=/gm)).toHaveLength(1);
        expect(p2.body).toContain(fenceOf(s.body, 'yaml form'));
      });
    });
  }
});
