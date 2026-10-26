/** @vitest-environment happy-dom */
/**
 * 🔴 **入力欄(` ```yaml form `)を押して打つ**(#1456)── binder と reducer の側。
 *
 * 本物の描画(`renderMarkdown` + `interactiveForms`)で台を組み、欄に打って押す。
 * 守る主張:
 * 1. 保存 → 先頭の設定欄の `vars.<項目名>`(空の欄はその行を消す)/ 変更が無ければ書かず言う
 * 2. 表に追加 / 行を更新 / 読み込む ── 押した後の本文を byte で見る(別の表・別の行は無傷)
 * 3. 断る(必須が空・行の番号が無い・表が無い・編集中)は**理由を言い**、書かない
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';
import { extractVars, bodyBelowFrontmatter, frontmatterLineCount } from '../../src/features/markdown/frontmatter';
import { applyBodyRewrite, type BodyRewrite } from '../../src/features/markdown/body-rewrite';

const DEF = [
  '```yaml form',
  'title: 日報',
  'table: 日報一覧',
  'fields:',
  '  - name: 氏名',
  '    required: true',
  '  - name: 件数',
  '    type: number',
  '  - name: 済',
  '    type: checkbox',
  '```',
].join('\n');

const TABLE = '```csv name=日報一覧\n氏名,件数,済\n山田,3,false\n佐藤,5,true\n```\n';

function rig(initial: string) {
  document.body.textContent = '';
  const dispatcher = new Dispatcher();
  const rewrites: BodyRewrite[] = [];
  const failures: string[] = [];
  const notices: string[] = [];
  dispatcher.onEvent((ev) => {
    if (ev.type === 'REQUEST_BODY_REWRITE') rewrites.push(ev.rewrite);
  });
  dispatcher.dispatch({
    type: 'SYS_BOOTED',
    cid: 'c1',
    metas: [
      { lid: 'n1', title: '日報', archetype: 'text', created_at: null, updated_at: null, entry_order: 1, status: null, date: null, archived: 0 } as never,
    ],
    relations: [],
  });
  dispatcher.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
  dispatcher.dispatch({ type: 'BODY_LOADED', lid: 'n1', body: initial });
  const root = document.createElement('div');
  root.setAttribute('data-pkc-slot', 'root');
  const host = document.createElement('div');
  host.setAttribute('data-pkc-field', 'detail-body');
  host.innerHTML = renderMarkdown(bodyBelowFrontmatter(initial), {
    interactiveForms: true,
    vars: extractVars(initial),
    sourceLineAnchors: true,
    taskLineOffset: frontmatterLineCount(initial),
  });
  root.append(host);
  document.body.append(root);
  bindActions(root, dispatcher, { showStatus: () => 0 });
  const err = (): string => dispatcher.getState().error ?? '';
  const field = (name: string): HTMLInputElement =>
    host.querySelector<HTMLInputElement>(`[data-pkc-form-field="${name}"]`)!;
  const press = (action: string): void => {
    host.querySelector<HTMLElement>(`[data-pkc-action="${action}"]`)!.click();
  };
  return { dispatcher, rewrites, failures, notices, host, err, field, press };
}

afterEach(() => {
  document.body.textContent = '';
});

describe('入力欄の保存', () => {
  it('🔴 打った値が vars.<項目名> として設定欄に入る(数は数、チェックは true/false、空は書かない)', () => {
    const r = rig(DEF + '\n');
    r.field('氏名').value = '山田';
    r.field('件数').value = '12';
    r.field('済').checked = true;
    r.press('form-save');
    expect(r.rewrites).toHaveLength(1);
    const next = applyBodyRewrite(DEF + '\n', r.rewrites[0]!)!;
    expect(next.startsWith('---\n')).toBe(true);
    expect(extractVars(next)).toEqual({ 氏名: '山田', 件数: '12', 済: 'true' });
    // 本文は無傷
    expect(next.endsWith(DEF + '\n')).toBe(true);
  });

  it('🔴 双方向 ── 空にして保存すると、その行が設定欄から消える', () => {
    const body = '---\nvars.氏名: 山田\nvars.件数: 3\n---\n' + DEF + '\n';
    const r = rig(body);
    expect(r.field('氏名').value, '設定欄の値が入力欄に出ていない').toBe('山田');
    r.field('件数').value = '';
    r.press('form-save');
    const next = applyBodyRewrite(body, r.rewrites[0]!)!;
    expect(extractVars(next)).toEqual({ 氏名: '山田', 済: 'false' });
  });

  it('変更が無ければ書かず、そう言う', () => {
    const body = '---\nvars.氏名: 山田\nvars.済: false\n---\n' + DEF + '\n';
    const r = rig(body);
    r.press('form-save');
    expect(r.rewrites).toHaveLength(0);
  });
});

describe('表との連携', () => {
  const body = '---\nvars.氏名: 田中\nvars.件数: 8\n---\n' + DEF + '\n\n' + TABLE;

  it('🔴 表に追加 ── 末尾に 1 行(チェックは true/false)・他の行は無傷', () => {
    const r = rig(body);
    r.press('form-row-add');
    expect(r.err()).toBe('');
    expect(r.rewrites).toHaveLength(1);
    const next = applyBodyRewrite(body, r.rewrites[0]!)!;
    expect(next).toBe(body.replace('佐藤,5,true\n```', '佐藤,5,true\n田中,8,false\n```'));
  });

  it('🔴 必須が空なら追加を断り、書かない', () => {
    const r = rig(body);
    r.field('氏名').value = '';
    r.press('form-row-add');
    expect(r.rewrites).toHaveLength(0);
    expect(r.err()).toContain('必須の項目が未入力です: 氏名');
  });

  it('🔴 行を更新 ── 番号の行だけ書き換わる', () => {
    const r = rig(body);
    (r.host.querySelector('[data-pkc-form-rowno]') as HTMLInputElement).value = '2';
    r.press('form-row-update');
    expect(r.err()).toBe('');
    const next = applyBodyRewrite(body, r.rewrites[0]!)!;
    expect(next).toBe(body.replace('佐藤,5,true', '田中,8,false'));
  });

  it('更新は行の番号が無い / 範囲外だと理由を言って書かない', () => {
    const r = rig(body);
    r.press('form-row-update');
    expect(r.err()).toContain('行」の欄');
    (r.host.querySelector('[data-pkc-form-rowno]') as HTMLInputElement).value = '9';
    r.press('form-row-update');
    expect(r.rewrites).toHaveLength(0);
    expect(r.err()).toContain('行 9 はありません');
  });

  it('🔴 読み込む ── 表の行が設定欄の vars へ入る(見出しに無い入力欄は元のまま)', () => {
    const r = rig(body);
    (r.host.querySelector('[data-pkc-form-rowno]') as HTMLInputElement).value = '2';
    r.press('form-row-load');
    expect(r.err()).toBe('');
    const next = applyBodyRewrite(body, r.rewrites[0]!)!;
    expect(extractVars(next)).toEqual({ 氏名: '佐藤', 件数: '5', 済: 'true' });
  });

  it('表が無ければ追加で作る / 更新・読み込みは理由を言う', () => {
    const noTable = '---\nvars.氏名: 田中\n---\n' + DEF + '\n';
    const r = rig(noTable);
    r.press('form-row-add');
    const next = applyBodyRewrite(noTable, r.rewrites[0]!)!;
    expect(next).toContain('```csv name=日報一覧\n氏名,件数,済\n田中,,false\n```');
    const r2 = rig(noTable);
    (r2.host.querySelector('[data-pkc-form-rowno]') as HTMLInputElement).value = '1';
    r2.press('form-row-load');
    expect(r2.rewrites).toHaveLength(0);
    expect(r2.err()).toContain('見つかりません');
  });

  it('🔴 編集中は書かず、理由を言う(編集の下書きを巻き込まない)', () => {
    const r = rig(body);
    r.dispatcher.dispatch({ type: 'START_EDIT' });
    r.press('form-save');
    expect(r.rewrites).toHaveLength(0);
    expect(r.err()).not.toBe('');
  });
});
