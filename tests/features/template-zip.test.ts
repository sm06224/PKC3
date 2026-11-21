import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { convertTemplate, findTemplateRoot, TemplateImportError, type TemplateSource } from '../../src/features/import/template-zip';
import { parseYamlSubset, YamlSubsetError } from '../../src/features/import/yaml-subset';
import { parseFormDef } from '../../src/features/markdown/form-def';

const ROOT = join(__dirname, '..', 'fixtures', 'pkc-templates');

function walk(dir: string, base = ''): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p, `${base}${n}/`) : [`${base}${n}`];
  });
}

export function loadFixture(name: string): TemplateSource {
  const dir = join(ROOT, name);
  const forms = new Map<string, string>();
  const other: string[] = [];
  for (const f of walk(dir)) {
    if (f === 'template.yaml') continue;
    if (f.startsWith('forms/')) forms.set(f.slice(6), readFileSync(join(dir, f), 'utf8'));
    else other.push(f);
  }
  return { template: readFileSync(join(dir, 'template.yaml'), 'utf8'), forms, otherFiles: other };
}

let n = 0;
const opts = () => {
  n = 0;
  return { genLid: () => `L${String(++n)}`, genRelationId: () => `R${String(n)}`, now: new Date('2026-11-21T09:30:00') };
};

const FENCE = /```yaml form\n([\s\S]*?)\n```/u;

describe('template-zip: 3 つの実例', () => {
  it('qa-regression: フォルダ 3・ノート 4(入力欄 2・ログ 1・テキスト 1)・項目 10', () => {
    const r = convertTemplate(loadFixture('qa-regression'), opts());
    expect(r.counts).toEqual({ folders: 3, notes: 4, forms: 2, textlogs: 1, texts: 1, fields: 10 });
    expect(r.notes.filter((x) => x.archetype === 'folder').map((x) => x.title)).toEqual(['Smoke', 'Full Regression', 'Report']);
    expect(r.notes.slice(3).map((x) => x.title)).toEqual(['Smoke Checklist', 'Full Checklist', 'Bug Triage Log', 'Release Note Draft']);
    expect(r.relations).toHaveLength(4);
    expect(r.renamed).toEqual([]);
    expect(r.ignored).toEqual([
      'template.yaml の識別情報(meta.id・meta.version・meta.pkc_min_version・meta.author・meta.description・schema_version・template_id・template_name・template_version)は記録しません',
      'assets/ のファイル 1 個(check-targets.txt)は取り込みません',
    ]);
  });

  it('ops-handoff: 未対応の flag、trust_level / required_capabilities / assets / snippets を出す', () => {
    const r = convertTemplate(loadFixture('ops-handoff'), opts());
    expect(r.counts).toEqual({ folders: 3, notes: 4, forms: 1, textlogs: 1, texts: 2, fields: 9 });
    expect(r.ignored).toEqual([
      'template.yaml の識別情報(meta.id・meta.version・meta.pkc_min_version・meta.author・meta.description・schema_version・template_id・template_name・template_version・description)は記録しません',
      'template.yaml の meta.trust_level(0)は取り込みません',
      'template.yaml の meta.required_capabilities(io.import.builtin)は取り込みません',
      'assets/ のファイル 1 個(logo.txt)は取り込みません',
      'snippets/ のファイル 1 個(handoff-template.md)は取り込みません',
      'template.yaml の entries「当日ログ」の lines[1] の flag「warn」(未対応の印。行は取り込み、印は付けません)',
    ]);
    const log = r.notes.find((x) => x.archetype === 'textlog')!;
    expect(log.body).toBe('## 2026-11-21 09:30:00\n\n引き継ぎテンプレートで初期化\n\n## 2026-11-21 09:30:00\n\n重大な変更があればここに追記');
  });

  it('product-discovery: info の flag と network.fetch を出す', () => {
    const r = convertTemplate(loadFixture('product-discovery'), opts());
    expect(r.counts).toEqual({ folders: 3, notes: 3, forms: 1, textlogs: 1, texts: 1, fields: 6 });
    expect(r.ignored.filter((s) => /trust_level|required_capabilities|flag|snippets/.test(s))).toEqual([
      'template.yaml の meta.trust_level(1)は取り込みません',
      'template.yaml の meta.required_capabilities(network.fetch)は取り込みません',
      'snippets/ のファイル 1 個(interview-agenda.md)は取り込みません',
      'template.yaml の entries「インタビュー記録」の lines[0] の flag「info」(未対応の印。行は取り込み、印は付けません)',
    ]);
  });

  it.each(['qa-regression', 'ops-handoff', 'product-discovery'])('%s: 変換した入力欄が誤り 0・項目数が一致し、表の見出しは項目名', (name) => {
    const r = convertTemplate(loadFixture(name), opts());
    let total = 0;
    let seen = 0;
    for (const note of r.notes.filter((x) => x.body.includes('```yaml form'))) {
      seen += 1;
      const def = parseFormDef(FENCE.exec(note.body)![1]!);
      expect(def.errors).toEqual([]);
      expect(def.fields.length).toBeGreaterThan(0);
      total += def.fields.length;
      const csv = /```csv name=(\S+)\n(.*)\n```/u.exec(note.body)!;
      expect(csv[1]).toBe(def.table);
      expect(csv[2]!.split(',')).toEqual(def.fields.map((f) => f.name));
    }
    expect(seen).toBe(r.counts.forms);
    expect(total).toBe(r.counts.fields);
  });

  it('型の対応: radio→select / checkbox-group / datetime / required / options', () => {
    const r = convertTemplate(loadFixture('ops-handoff'), opts());
    const f = r.notes.find((x) => x.title === '引き継ぎチェック')!;
    const def = parseFormDef(FENCE.exec(f.body)![1]!);
    const by = Object.fromEntries(def.fields.map((x) => [x.name, x]));
    expect(by.severity!.type).toBe('select');
    expect(by.severity!.options).toEqual(['Critical', 'High', 'Medium', 'Low']);
    expect(by.severity!.required).toBe(true);
    expect(by.affected_components!.type).toBe('checkbox-group');
    expect(by.detected_at!.type).toBe('datetime');
    expect(by.has_customer_impact!.type).toBe('checkbox');
    expect(by.owner!.label).toBe('担当者');
    expect(f.body).toContain('## 項目の区分');
    expect(f.body).toContain('- 基本: 担当者、概要');
  });

  it('red / important の flag は ★ になる', () => {
    const r = convertTemplate(T('  - type: textlog\n    title: L\n    lines:\n      - body: x\n        flag: red\n      - body: y\n        flag: important\n'), opts());
    expect(r.notes[1]!.body).toBe('## 2026-11-21 09:30:00 ★\n\nx\n\n## 2026-11-21 09:30:00 ★\n\ny');
    expect(r.ignored).toEqual([]);
  });
});

function T(extra: string, forms: Record<string, string> = {}): TemplateSource {
  return {
    template: `folders:\n  - id: a\n    name: A\nentries:\n${extra}`,
    forms: new Map(Object.entries(forms)),
    otherFiles: [],
  };
}

describe('template-zip: 変換の端', () => {
  it('項目名は VAR_NAME に直し、変換表を出す(重なりは _2)', () => {
    const form = 'form_id: f\ntitle: "売上 表"\nsections:\n  - section: S\n    fields:\n      - key: a.b\n        label: L1\n        type: text\n      - key: "a b"\n        type: text\n';
    const r = convertTemplate(T('  - type: form\n    title: F\n    form: f\n', { 'f.yaml': form }), opts());
    expect(r.renamed).toEqual(['forms/f.yaml: a.b → a_b', 'forms/f.yaml: a b → a_b_2']);
    const body = r.notes[1]!.body;
    expect(parseFormDef(FENCE.exec(body)![1]!).errors).toEqual([]);
    expect(body).toContain('```csv name=売上_表\na_b,a_b_2\n```');
  });

  it('未対応の型・条件つき・未知のキー・未知の entry は 1 件ずつ列挙する', () => {
    const form =
      'form_id: f\nsections:\n  - fields:\n      - key: x\n        type: email\n        visible_if: "y"\n        weird: 1\n      - key: z\n        type: radio\n        required:\n          when: x\n        options: [a]\n';
    const r = convertTemplate(
      T('  - type: form\n    title: F\n    form: f\n    foo: 1\n  - type: widget\n    title: W\n  - type: text\n    title: T\n    folder: nope\n', {
        'f.yaml': form,
        'unused.yaml': 'form_id: u\nsections: []\n',
      }),
      opts(),
    );
    expect(r.ignored).toEqual([
      'template.yaml の entries「F」のキー「foo」(未知のキー)',
      'forms/f.yaml の sections[0].fields[0]「x」の「visible_if」(条件つきの必須・表示は取り込みません)',
      'forms/f.yaml の sections[0].fields[0]「x」のキー「weird」(未知のキー)',
      'forms/f.yaml の sections[0].fields[0]「x」の type「email」(未対応の型。text として取り込みました)',
      'forms/f.yaml の sections[0].fields[1]「z」の required(true / false 以外の値は条件つきの必須として取り込みません)',
      'template.yaml の entries「W」の type「widget」(未対応の種類のためノートは作りません)',
      'template.yaml の entries「T」の folder「nope」(定義に無いフォルダ。いちばん上に置きました)',
      'forms/unused.yaml(どのノートからも使われていないため取り込みません)',
    ]);
    expect(r.counts.notes).toBe(2);
  });

  it('forms/ に無い form 参照はノートを作らず列挙する', () => {
    const r = convertTemplate(T('  - type: form\n    title: F\n    form: none\n  - type: text\n    title: T\n'), opts());
    expect(r.counts.notes).toBe(1);
    expect(r.ignored).toEqual(['template.yaml の entries「F」の form「none」(forms/ に定義が無いためノートは作りません)']);
  });

  it('壊れた YAML は 1 件も作らず断る(どのファイルかを言う)', () => {
    expect(() => convertTemplate({ template: 'entries: [', forms: new Map(), otherFiles: [] }, opts())).toThrow(TemplateImportError);
    expect(() => convertTemplate(T('  - type: text\n    title: T\n', { 'bad.yaml': 'a: [1\n' }), opts())).toThrow(/forms\/bad\.yaml/);
    expect(() => convertTemplate({ template: 'meta: !!python/object x\nentries: []\n', forms: new Map(), otherFiles: [] }, opts())).toThrow(/タグ/);
  });

  it('findTemplateRoot: 直下 / 1 段下 / 無し / 複数', () => {
    expect(findTemplateRoot(['template.yaml', 'forms/a.yaml'])).toBe('');
    expect(findTemplateRoot(['x/template.yml', 'x/forms/a.yaml'])).toBe('x/');
    expect(findTemplateRoot(['manifest.json', 'container.json'])).toBeNull();
    expect(findTemplateRoot(['a/template.yaml', 'b/template.yaml'])).toBeNull();
  });
});

describe('yaml-subset', () => {
  it('入れ子・並び・引用符・複数行・コメントを読む', () => {
    const v = parseYamlSubset(
      '# c\na:\n  - k: "x # y"  # tail\n    n: 3\n  - plain\nb: |\n  l1\n  l2\nc: >-\n  p\n  q\nd: [1, \'a\'\'b\', "c, d"]\ne: true\n',
    ) as Record<string, unknown>;
    expect({ ...v }).toEqual({ a: [{ k: 'x # y', n: 3 }, 'plain'], b: 'l1\nl2\n', c: 'p q', d: [1, "a'b", 'c, d'], e: true });
  });
  it.each([
    ['タグ', 'a: !!str x\n'],
    ['アンカー', 'a: &x 1\n'],
    ['エイリアス', 'a: *x\n'],
    ['合成', '<<: 1\n'],
    ['{ }', 'a: {b: 1}\n'],
    ['複数文書', 'a: 1\n---\nb: 2\n'],
    ['タブ', 'a:\n\tb: 1\n'],
    ['重なり', 'a: 1\na: 2\n'],
  ])('%s は断る', (_n, src) => {
    expect(() => parseYamlSubset(src)).toThrow(YamlSubsetError);
  });
  it('大きさと深さの上限、__proto__', () => {
    expect(() => parseYamlSubset('a: ' + 'x'.repeat(1024 * 1024 + 1))).toThrow(/大きすぎ/);
    let deep = '';
    for (let i = 0; i < 40; i += 1) deep += `${' '.repeat(i)}k:\n`;
    expect(() => parseYamlSubset(deep)).toThrow(/深すぎ/);
    expect(() => parseYamlSubset('__proto__: 1\n')).toThrow(YamlSubsetError);
  });
  it('行番号つきで断る', () => {
    expect(() => parseYamlSubset('a: 1\nbad line\n')).toThrow(/^2 行目/);
  });
});
