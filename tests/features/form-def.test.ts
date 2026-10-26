/** @vitest-environment node */
/**
 * 🔴 **本文の入力欄の定義(` ```yaml form `)**(#1456)。
 *
 * 守る主張:
 * 1. 見出しの判定(yaml / yml + form)── 素の ` ```yaml ` は入力欄にしない
 * 2. 定義の読み(項目・種類・選択肢・必須)/ 読めない所は**理由つきで**出る(黙って捨てない)
 * 3. 入力欄の HTML(値の差し込み・エスケープ・種類ごとの欄)/ 押せない面は値の表
 */
import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';
import {
  FORM_EMPTY_TEXT,
  formHtml,
  isCheckedValue,
  isFormInfo,
  parseFormDef,
} from '../../src/features/markdown/form-def';

const DEF = [
  'title: 日報',
  'table: 日報一覧',
  'fields:',
  '  - name: 氏名',
  '    label: お名前',
  '    required: true',
  '  - name: 件数',
  '    type: number',
  '  - name: 区分',
  '    type: select',
  '    options: [通常, 休み, "半休, 午後"]',
  '  - name: 期日',
  '    type: date',
  '  - name: 済',
  '    type: checkbox',
  '  - name: 備考',
  '    type: textarea',
].join('\n');

describe('見出しの判定', () => {
  it('yaml / yml の後ろに form が付いたときだけ', () => {
    expect(isFormInfo('yaml form')).toBe(true);
    expect(isFormInfo('YML  Form')).toBe(true);
    expect(isFormInfo('yaml')).toBe(false);
    expect(isFormInfo('form')).toBe(false);
    expect(isFormInfo('json form')).toBe(false);
    expect(isFormInfo(null)).toBe(false);
  });
});

describe('定義を読む', () => {
  it('項目・種類・表示名・必須・選択肢・表の名前を読む', () => {
    const d = parseFormDef(DEF);
    expect(d.errors).toEqual([]);
    expect(d.title).toBe('日報');
    expect(d.table).toBe('日報一覧');
    expect(d.fields.map((f) => [f.name, f.label, f.type, f.required])).toEqual([
      ['氏名', 'お名前', 'text', true],
      ['件数', '件数', 'number', false],
      ['区分', '区分', 'select', false],
      ['期日', '期日', 'date', false],
      ['済', '済', 'checkbox', false],
      ['備考', '備考', 'textarea', false],
    ]);
    // 引用符の中のカンマは選択肢を割らない
    expect(d.fields[2]!.options).toEqual(['通常', '休み', '半休, 午後']);
  });

  it('省略形(- 名前)と、コメントの行・行末のコメント', () => {
    const d = parseFormDef('# 定義\n- 名前\n- name: 年齢 # 歳\n  type: number\n');
    expect(d.errors).toEqual([]);
    expect(d.fields.map((f) => [f.name, f.type])).toEqual([
      ['名前', 'text'],
      ['年齢', 'number'],
    ]);
  });

  it('🔴 読めない所は黙って捨てず、理由を出す', () => {
    const d = parseFormDef(
      [
        '- name: 空 白',
        '- name: 区分',
        '  type: select',
        '- name: 重複',
        '- name: 重複',
        '- name: 型',
        '  type: color',
        'oops: 1',
        '  stray: 2',
        '- type: text',
      ].join('\n'),
    );
    const text = d.errors.join('\n');
    expect(text).toContain('項目名「空 白」は使えません');
    expect(text).toContain('項目「区分」は select なのに options がありません');
    expect(text).toContain('項目名「重複」が重なっています');
    expect(text).toContain('type「color」は使えません');
    expect(text).toContain('「oops」は使えません');
    expect(text).toContain('name がありません');
    // 読めた項目だけが残る(重複は 1 つ目)
    expect(d.fields.map((f) => f.name)).toEqual(['重複']);
  });

  it('🔴 使えない表の名前は理由を出し、表の連携を付けない(押しても引けない口を出さない)', () => {
    const d = parseFormDef('table: 日報 一覧\nfields:\n  - name: 氏名\n');
    expect(d.table).toBe('');
    expect(d.errors.join('\n')).toContain('表の名前「日報 一覧」は使えません');
    const html = formHtml('table: 日報 一覧\n- name: 氏名\n', { interactive: true, vars: {} });
    expect(html).not.toContain('form-row-add');
  });

  it('項目が 1 つも無い定義は理由を出す', () => {
    expect(parseFormDef('title: だけ').errors).toEqual(['項目がありません(- name: 項目名 の行を書いてください)']);
  });

  it('チェックの値の読み(true / はい / 済 …)', () => {
    for (const v of ['true', 'はい', '済', '1', 'X']) expect(isCheckedValue(v), v).toBe(true);
    for (const v of ['false', '', 'いいえ', undefined]) expect(isCheckedValue(v), String(v)).toBe(false);
  });
});

describe('入力欄の HTML', () => {
  const vars = { 氏名: '山田 <太郎>', 件数: '3', 区分: '休み', 済: 'true' };

  it('🔴 種類ごとの欄が出て、値が入り、HTML は注入されない', () => {
    const html = formHtml(DEF, { interactive: true, vars, sourceAttrs: ' data-pkc-source-line="4"' });
    expect(html).toContain('data-pkc-form=""');
    expect(html).toContain('data-pkc-form-table="日報一覧"');
    expect(html).toContain('data-pkc-source-line="4"');
    expect(html).toContain('value="山田 &lt;太郎&gt;"');
    expect(html).not.toContain('<太郎>');
    expect(html).toContain('<input type="number" step="any" data-pkc-form-field="件数"');
    expect(html).toContain('value="3"');
    expect(html).toContain('<option value="休み" selected>休み</option>');
    expect(html).toContain('type="date"');
    expect(html).toMatch(/type="checkbox"[^>]*checked/u);
    expect(html).toContain('<textarea');
    // 必須の印と、押す口
    expect(html).toContain('pkc-form-required');
    for (const a of ['form-save', 'form-row-add', 'form-row-update', 'form-row-load']) {
      expect(html, a).toContain(`data-pkc-action="${a}"`);
    }
    // 定義そのものも読める(定義を見る)
    expect(html).toContain('<summary>定義を見る</summary>');
  });

  it('表の連携が無い定義には、表の口を出さない(対照群)', () => {
    const html = formHtml('- name: 一つ\n', { interactive: true, vars: {} });
    expect(html).toContain('data-pkc-action="form-save"');
    expect(html).not.toContain('form-row-add');
    expect(html).not.toContain('data-pkc-form-table');
  });

  it('🔴 選択肢に無い古い値も落とさず並べる', () => {
    const html = formHtml(DEF, { interactive: true, vars: { 区分: '廃止した選択肢' } });
    expect(html).toContain('<option value="廃止した選択肢" selected>廃止した選択肢</option>');
  });

  it('🔴 押せない面は値の表だけ(欄も押す口も出ない)', () => {
    const html = formHtml(DEF, { interactive: false, vars });
    expect(html).toContain('pkc-form-static');
    expect(html).not.toContain('<input');
    expect(html).not.toContain('data-pkc-action');
    expect(html).toContain('<th scope="row">お名前</th><td>山田 &lt;太郎&gt;</td>');
    expect(html).toContain('<td>☑</td>');
    expect(html).toContain(`<span class="pkc-form-empty">${FORM_EMPTY_TEXT}</span>`);
  });

  it('定義の誤りは入力欄の中に出る', () => {
    const html = formHtml('- name: 空 白\n', { interactive: true, vars: {} });
    expect(html).toContain('pkc-form-error');
    expect(html).toContain('使えません');
  });
});

describe('本文からの描画(markdown-render)', () => {
  const body = '---\nvars.氏名: 佐藤\n---\n\n```yaml form\n- name: 氏名\n```\n\n```yaml\n- name: 氏名\n```\n';
  const vars = { 氏名: '佐藤' };

  it('🔴 interactiveForms の面は欄、それ以外は値の表。素の yaml 囲みは今までどおりコード', () => {
    const live = renderMarkdown('```yaml form\n- name: 氏名\n```\n\n```yaml\n- name: 氏名\n```\n', {
      interactiveForms: true,
      vars,
    });
    expect(live).toContain('data-pkc-form-field="氏名"');
    expect(live).toContain('value="佐藤"');
    // 対照群: 素の ```yaml は入力欄にならない(コード枠のまま)
    expect(live.match(/data-pkc-form-field=/gu)).toHaveLength(1);
    expect(live).toContain('language-yaml');

    const stat = renderMarkdown(body.split('---\n')[2]!, { vars });
    expect(stat).toContain('pkc-form-static');
    expect(stat).toContain('佐藤');
    expect(stat).not.toContain('data-pkc-form-field');
  });

  it('定義の囲みが無い本文は 1 バイトも変わらない(対照群)', () => {
    const plain = '# 見出し\n\n```yaml\na: 1\n```\n';
    expect(renderMarkdown(plain, { interactiveForms: true, vars })).toBe(renderMarkdown(plain));
  });
});
