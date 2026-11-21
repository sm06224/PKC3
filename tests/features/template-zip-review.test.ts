/**
 * #2002 段 3 のレビュー指摘: 字の保存・日時を作らない・重なった form_id・名前の 1 行化・上限の境界・YAML の変異の生き残り。
 */
import { describe, expect, it } from 'vitest';
import {
  convertTemplate,
  oneLine,
  TEMPLATE_MAX_ENTRIES,
  TEMPLATE_MAX_FIELDS,
  TEMPLATE_MAX_FOLDERS,
  TEMPLATE_MAX_FORMS,
  type TemplateSource,
} from '../../src/features/import/template-zip';
import { parseYamlSubset, YAML_MAX_NODES } from '../../src/features/import/yaml-subset';
import { parseFormDef } from '../../src/features/markdown/form-def';

let n = 0;
const opts = () => {
  n = 0;
  return { genLid: () => `L${String(++n)}`, genRelationId: () => `R${String(n)}` };
};
const FENCE = /```yaml form\n([\s\S]*?)\n```/u;

function T(extra: string, forms: Record<string, string> = {}): TemplateSource {
  return {
    template: `folders:\n  - id: a\n    name: A\nentries:\n${extra}`,
    forms: new Map(Object.entries(forms)),
    otherFiles: [],
  };
}

const FORM_HEAD = 'form_id: f\ntitle: T\nsections:\n  - fields:\n';
const useForm = (form: string, extra: Record<string, string> = {}) =>
  convertTemplate(T('  - type: form\n    title: F\n    form: f\n', { 'f.yaml': form, ...extra }), opts());
const fenceOf = (r: ReturnType<typeof convertTemplate>) => FENCE.exec(r.notes[1]!.body)![1]!;

describe('template-zip: 字の保存と取り扱い', () => {
  it('数の形の選択肢・題名は書かれたままの字(1.0 → 1.0、1.10 → 1.10)', () => {
    const r = useForm('form_id: f\ntitle: 1.10\nsections:\n  - fields:\n      - key: v\n        type: select\n        options: [1.0, 2.0, 1.10]\n');
    const def = parseFormDef(fenceOf(r));
    expect(def.errors).toEqual([]);
    expect(def.fields[0]!.options).toEqual(['1.0', '2.0', '1.10']);
    expect(def.title).toBe('1.10');
    const t = convertTemplate(T('  - type: text\n    title: 1.10\n'), opts());
    expect(t.notes[1]!.title).toBe('1.10');
  });

  it('ログの行は取り込んだ時刻を作らず (日時なし) の見出しにする', () => {
    const r = convertTemplate(T('  - type: textlog\n    title: L\n    lines:\n      - a\n      - body: b\n        flag: red\n'), opts());
    expect(r.notes[1]!.body).toBe('## (日時なし)\n\na\n\n## (日時なし) ★\n\nb');
    expect(r.notes[1]!.body).not.toMatch(/\d{4}-\d{2}-\d{2}/u);
  });

  it('form_id の重なった 2 つ目のファイルは黙って落とさず、理由つきで列挙する', () => {
    const second = 'form_id: f\ntitle: 別\nsections:\n  - fields:\n      - key: z\n';
    const r = useForm(`${FORM_HEAD}      - key: a\n`, { 'g.yaml': second });
    expect(r.ignored).toContain('forms/g.yaml(form_id「f」が forms/f.yaml と重なっているため取り込みません)');
    expect(r.counts.fields).toBe(1);
  });

  it('checkbox-group の選択肢の「,」は「，」にして列挙する', () => {
    const r = useForm(`${FORM_HEAD}      - key: c\n        type: checkbox-group\n        options: ["a,b", c]\n`);
    expect(parseFormDef(fenceOf(r)).fields[0]!.options).toEqual(['a，b', 'c']);
    expect(r.ignored).toEqual(['forms/f.yaml の sections[0].fields[0]「c」の選択肢の「,」(全角の「，」に変えました)']);
  });

  it('label の「"」は入力欄の定義を壊さない(引用符の選び分け)', () => {
    const r = useForm(`${FORM_HEAD}      - key: q\n        label: 'say "hi"'\n        placeholder: 'it''s "x"'\n`);
    expect(fenceOf(r)).toContain(`label: 'say "hi"'`);
    const def = parseFormDef(fenceOf(r));
    expect(def.errors).toEqual([]);
    expect(def.fields[0]!.label).toBe('say "hi"');
    expect(def.fields[0]!.placeholder).toBe("it's ”x”");
  });

  it('YAML 由来の名前は 1 行にして結果へ(改行・見出し・HTML をそのままの字で、節を割らずに)', () => {
    expect(oneLine('a\n## b\r\n<img src=x>\u2028c')).toBe('a ## b <img src=x> c');
    const r = convertTemplate(
      {
        template: 'folders: []\nentries:\n  - type: text\n    title: T\n    "x\\n## evil <b>": 1\n',
        forms: new Map(),
        otherFiles: ['assets/a\nb.png'],
      },
      opts(),
    );
    expect(r.ignored.every((s) => !/[\r\n\u2028\u2029]/u.test(s))).toBe(true);
    expect(r.ignored).toContain('template.yaml の entries「T」のキー「x ## evil <b>」(未知のキー)');
    expect(r.ignored).toContain('assets/ のファイル 1 個(a b.png)は取り込みません');
  });
});

describe('template-zip: 上限の境界(ちょうどは通り、1 つ超えると断る)', () => {
  const listOf = (count: number, mk: (i: number) => string) => Array.from({ length: count }, (_, i) => mk(i)).join('');
  const run = (template: string, forms = new Map<string, string>()) => convertTemplate({ template, forms, otherFiles: [] }, opts());

  it('フォルダ', () => {
    const mk = (c: number) => `folders:\n${listOf(c, (i) => `  - id: f${String(i)}\n    name: F\n`)}entries:\n  - type: text\n    title: T\n`;
    expect(run(mk(TEMPLATE_MAX_FOLDERS)).counts.folders).toBe(TEMPLATE_MAX_FOLDERS);
    expect(() => run(mk(TEMPLATE_MAX_FOLDERS + 1))).toThrow(/フォルダが多すぎ/);
  });
  it('ノート', () => {
    const mk = (c: number) => `entries:\n${listOf(c, () => '  - type: text\n    title: T\n')}`;
    expect(run(mk(TEMPLATE_MAX_ENTRIES)).counts.notes).toBe(TEMPLATE_MAX_ENTRIES);
    expect(() => run(mk(TEMPLATE_MAX_ENTRIES + 1))).toThrow(/ノートが多すぎ/);
  });
  it('forms/ のファイル数', () => {
    const forms = (c: number) => new Map(Array.from({ length: c }, (_, i) => [`f${String(i)}.yaml`, 'sections: []\n'] as const));
    const t = 'entries:\n  - type: text\n    title: T\n';
    expect(run(t, forms(TEMPLATE_MAX_FORMS)).counts.notes).toBe(1);
    expect(() => run(t, forms(TEMPLATE_MAX_FORMS + 1))).toThrow(/forms\/ のファイルが多すぎ/);
  });
  it('1 つの入力欄の項目数', () => {
    const form = (c: number) => `${FORM_HEAD}${listOf(c, (i) => `      - key: k${String(i)}\n`)}`;
    expect(useForm(form(TEMPLATE_MAX_FIELDS)).counts.fields).toBe(TEMPLATE_MAX_FIELDS);
    expect(() => useForm(form(TEMPLATE_MAX_FIELDS + 1))).toThrow(/項目が多すぎ/);
  });
});

describe('yaml-subset: 追加の検査', () => {
  it('constructor: / toString: は普通のキー(重なりと誤認せず、プロトタイプの値を持たない)', () => {
    const v = parseYamlSubset('constructor: 1\ntoString: 2\nvalueOf: 3\nhasOwnProperty: 4\n') as Record<string, unknown>;
    expect(Object.getPrototypeOf(v)).toBeNull();
    expect(Object.keys(v)).toEqual(['constructor', 'toString', 'valueOf', 'hasOwnProperty']);
    expect(v.constructor).toBe(1);
    expect(v.toString).toBe(2);
    const empty = parseYamlSubset('a: 1\n') as Record<string, unknown>;
    expect('constructor' in empty).toBe(false);
    expect(empty.toString).toBeUndefined();
    expect(() => parseYamlSubset('constructor: 1\nconstructor: 2\n')).toThrow(/重なって/);
  });

  it('節の数の上限(YAML_MAX_NODES): ちょうどは通り、1 つ超えると断る', () => {
    const mk = (c: number) => Array.from({ length: c }, (_, i) => `k${String(i)}: 1\n`).join('');
    expect(Object.keys(parseYamlSubset(mk(YAML_MAX_NODES)) as object)).toHaveLength(YAML_MAX_NODES);
    expect(() => parseYamlSubset(mk(YAML_MAX_NODES + 1))).toThrow(/項目が多すぎ/);
  });

  it('numbersAsText: 数の形の素の字は書かれたまま、既定は数', () => {
    expect({ ...(parseYamlSubset('a: 1.10\nb: [1.0, 2]\n') as object) }).toEqual({ a: 1.1, b: [1, 2] });
    expect({ ...(parseYamlSubset('a: 1.10\nb: [1.0, 2]\n', { numbersAsText: true }) as object) }).toEqual({ a: '1.10', b: ['1.0', '2'] });
  });
});
