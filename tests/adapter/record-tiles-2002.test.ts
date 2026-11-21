/** @vitest-environment happy-dom */
/**
 * 🔴 #2002 段 5 「入口(アプリのタイル)」。
 * 観測点: ① 入力欄つきの自分のテンプレート + サンプル 3 件だけが並ぶ(入力欄の無い雛形は並ばない = 対照群)
 * ② 「新しい記録」1 クリックで template: つきの記録のノートが作られ編集に入る ③ 「記録の一覧」で集計が template で開く
 * ④ 入力欄から「アプリの一覧」へ戻れる(set-browse) ⑤ アプリの一覧を開く要求は雛形の走査も頼む。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { initialState, type Dispatchable } from '../../src/adapter/state/app-state';
import { reduceLauncher } from '../../src/adapter/state/slices/launcher';
import { LauncherRenderer } from '../../src/adapter/ui/render/launcher';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { recordTemplates } from '../../src/features/launcher/record-tiles';
import { snippetItemOf } from '../../src/features/snippet/snippet-table';
import { SAMPLE_TEMPLATES } from '../../src/features/snippet/sample-templates';
import { formHtml } from '../../src/features/markdown/form-def';

const FORM_BODY = '# 受付\n\n```yaml form\ntitle: 受付\nfields:\n  - name: 氏名\n    type: text\n```\n';

function setup() {
  document.body.textContent = '';
  const root = document.createElement('div');
  document.body.append(root);
  const d = new Dispatcher();
  const sent: Dispatchable[] = [];
  const raw = d.dispatch.bind(d);
  d.dispatch = ((a: Dispatchable) => {
    sent.push(a);
    return raw(a);
  }) as typeof d.dispatch;
  bindActions(root, d);
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [], relations: [] });
  d.dispatch({ type: 'LAUNCHER_TILES_LOADED', tiles: [] });
  const withForm = snippetItemOf('t-form', '受付票', FORM_BODY)!;
  const plain = snippetItemOf('t-plain', '議事録の型', '## 議事録\n- ')!;
  d.dispatch({ type: 'SET_SNIPPET_SCAN', scan: { items: [withForm, plain], total: 2, truncated: false } });
  const region = document.createElement('div');
  root.append(region);
  const renderer = new LauncherRenderer(region);
  renderer.render(d.getState());
  sent.length = 0;
  return { root, d, sent, region, renderer };
}

afterEach(() => {
  document.body.textContent = '';
});

describe('記録の節の並び', () => {
  it('入力欄つきの自分のテンプレート → サンプルの順。入力欄の無い雛形は並ばない', () => {
    const { region } = setup();
    const rows = [
      ...region.querySelectorAll('[data-pkc-field="launcher-record-row"] [data-pkc-field="title"]'),
    ].map((e) => e.textContent);
    expect(rows).toEqual(['受付票', ...SAMPLE_TEMPLATES.map((s) => s.title)]);
    expect(rows).not.toContain('議事録の型');
  });

  it('自分のテンプレートが 0 件 / 走査がまだ(null)でもサンプルの入口は在る', () => {
    expect(recordTemplates(null)).toHaveLength(SAMPLE_TEMPLATES.length);
    expect(recordTemplates({ items: [], total: 0, truncated: false })).toHaveLength(3);
  });

  it('走査が後から届くと節が組み直される(指紋)', () => {
    const { d, region, renderer } = setup();
    expect(region.querySelectorAll('[data-pkc-action="record-new"]')).toHaveLength(4);
    d.dispatch({ type: 'SET_SNIPPET_SCAN', scan: { items: [], total: 0, truncated: false } });
    renderer.render(d.getState());
    expect(region.querySelectorAll('[data-pkc-action="record-new"]')).toHaveLength(3);
  });

  it('アプリの一覧を開く要求は雛形の走査も頼む', () => {
    const r = reduceLauncher(initialState, { type: 'REFRESH_LAUNCHER_TILES' });
    expect(r.events.map((e) => e.type)).toContain('REQUEST_SNIPPET_SCAN');
  });
});

describe('1 クリックの入口', () => {
  it('🔴 自分のテンプレートの「新しい記録」→ template: つきの text ノートが編集で開く', () => {
    const { d, sent, region } = setup();
    region.querySelector<HTMLElement>('[data-pkc-action="record-new"][data-pkc-template-lid="t-form"]')!.click();
    const created = sent.find((a) => a.type === 'CREATE_ENTRY') as { body?: string; archetype: string } | undefined;
    expect(created?.archetype).toBe('text');
    expect(created!.body).toContain('template: 受付票');
    expect(created!.body).toContain('```yaml form');
    expect(d.getState().phase).toBe('editing');
  });

  it('サンプルの「新しい記録」→ 題名つきで作られる', () => {
    const { sent, region } = setup();
    region
      .querySelector<HTMLElement>('[data-pkc-action="record-new"][data-pkc-template-sample="ops-handoff"]')!
      .click();
    const created = sent.find((a) => a.type === 'CREATE_ENTRY') as { body?: string; title: string } | undefined;
    expect(created?.title).toBe('当番の引き継ぎ');
    expect(created!.body).toContain('template: 当番の引き継ぎ');
  });

  it('消えたテンプレートは作らずに理由を言う', () => {
    const { sent, region } = setup();
    const b = region.querySelector<HTMLElement>('[data-pkc-action="record-new"][data-pkc-template-lid="t-form"]')!;
    b.setAttribute('data-pkc-template-lid', 'gone');
    b.click();
    expect(sent.some((a) => a.type === 'CREATE_ENTRY')).toBe(false);
    expect(sent.find((a) => a.type === 'OP_FAILED')).toBeDefined();
  });

  it('「記録の一覧」で集計が template で開く', () => {
    const { d, region } = setup();
    region.querySelector<HTMLElement>('[data-pkc-field="launcher-records-list"]')!.click();
    expect(d.getState().viewMode).toBe('query');
    expect(d.getState().queryKey).toBe('template');
  });

  it('絞り込みで題名が合わないものは出ない', () => {
    const { d, region, renderer } = setup();
    d.dispatch({ type: 'SET_ENTRY_FILTER', query: '受付' } as Dispatchable);
    renderer.render(d.getState());
    expect(region.querySelectorAll('[data-pkc-action="record-new"]')).toHaveLength(1);
  });
});

describe('戻る道', () => {
  it('入力欄に「アプリの一覧」(set-browse launcher)が出る。項目が無ければ出ない', () => {
    const html = formHtml('fields:\n  - name: 一つ\n', { interactive: true, vars: {} });
    expect(html).toContain('data-pkc-action="set-browse" data-pkc-browse="launcher"');
    expect(formHtml('fields: []\n', { interactive: true, vars: {} })).not.toContain('data-pkc-browse="launcher"');
  });
});
