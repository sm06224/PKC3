/** @vitest-environment happy-dom */
/**
 * 🔴 #2002 段 5 「入口(アプリのタイル)」。
 * 観測点: ① 入力欄つきの自分のテンプレート + サンプル 3 件だけが並ぶ(入力欄の無い雛形は並ばない = 対照群)
 * ② 「新しい記録」1 クリックで template: つきの記録のノートが作られ編集に入る ③ 「記録の一覧」で集計が template で開く
 * ④ 入力欄から「アプリの一覧」へ戻れる(set-browse) ⑤ アプリの一覧を開く要求は雛形の走査も頼む。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { initialState, reduce, type AppState, type Dispatchable } from '../../src/adapter/state/app-state';
import { reduceLauncher } from '../../src/adapter/state/slices/launcher';
import { LauncherRenderer } from '../../src/adapter/ui/render/launcher';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { recordTemplates } from '../../src/features/launcher/record-tiles';
import { snippetItemOf } from '../../src/features/snippet/snippet-table';
import { SAMPLE_TEMPLATES } from '../../src/features/snippet/sample-templates';
import { formHtml } from '../../src/features/markdown/form-def';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import type { LauncherTile } from '../../src/features/launcher/tiles';

const FORM_BODY = '# 受付\n\n```yaml form\ntitle: 受付\nfields:\n  - name: 氏名\n    type: text\n```\n';

function setup(o: { busy?: boolean; tiles?: LauncherTile[]; truncated?: boolean } = {}) {
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
  bindActions(root, d, { busy: () => o.busy === true });
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [metaOf('t-form', 'snippet'), metaOf('t-plain', 'snippet')], relations: [] });
  d.dispatch({ type: 'LAUNCHER_TILES_LOADED', tiles: o.tiles ?? [] });
  const withForm = snippetItemOf('t-form', '受付票', FORM_BODY)!;
  const plain = snippetItemOf('t-plain', '議事録の型', '## 議事録\n- ')!;
  d.dispatch({ type: 'SET_SNIPPET_SCAN', scan: { items: [withForm, plain], total: 2, truncated: o.truncated === true } });
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

const metaOf = (lid: string, archetype: string): EntryMeta => ({
  lid,
  title: lid,
  archetype,
  createdAt: null,
  updatedAt: null,
  entryOrder: 1,
  status: null,
  date: null,
  archived: false,
  bodyChars: null,
});

const BUILTIN_TILES: LauncherTile[] = [
  { lid: 'b1', title: 'カレンダー', group: '', kind: 'app' } as LauncherTile,
  { lid: 'b2', title: '連絡先', group: '', kind: 'app' } as LauncherTile,
];

describe('段 5 の追い込み(R1・変異試験の生き残り・a11y・切れ)', () => {
  /** 編集 → 本文を打つ → 保存 までを reducer で通し、保存が撃つ頼みを返す */
  const commitEvents = (archetype: string): string[] => {
    let st: AppState = reduce(initialState, {
      type: 'SYS_BOOTED',
      cid: 'c1',
      metas: [metaOf('n1', archetype)],
      relations: [],
    }).state;
    st = reduce(st, { type: 'SELECT_ENTRY', lid: 'n1' }).state;
    st = reduce(st, { type: 'BODY_LOADED', lid: 'n1', body: '古い本文\n' }).state;
    st = reduce(st, { type: 'START_EDIT' }).state;
    st = reduce(st, { type: 'UPDATE_OPEN_BODY', body: `新しい本文\n${FORM_BODY}` }).state;
    expect(st.phase, '前提: 編集中').toBe('editing');
    return reduce(st, { type: 'COMMIT_EDIT' }).events.map((e) => e.type);
  };

  it('🔴 R1: テンプレート(snippet)のノートを保存すると走査を頼み直す。普通のノートの保存では頼まない(対照群)', () => {
    const own = commitEvents('snippet');
    expect(own).toContain('PERSIST_ENTRY');
    expect(own).toContain('REQUEST_SNIPPET_SCAN');
    const plain = commitEvents('text');
    expect(plain).toContain('PERSIST_ENTRY');
    expect(plain).not.toContain('REQUEST_SNIPPET_SCAN');
  });

  it('🔴 R1: 保存のあと「新しい記録」は、古い走査ではなく保存済みの本文から作る', () => {
    const { d, region, renderer, sent } = setup();
    // 走査(古い版)は t-form を入力欄つきで持っている。実物のノート t-form は保存で本文が変わった
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [metaOf('t-form', 'snippet')], relations: [] });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 't-form' });
    d.dispatch({ type: 'BODY_LOADED', lid: 't-form', body: FORM_BODY.replace('氏名', '住所') });
    d.dispatch({ type: 'SET_SNIPPET_SCAN', scan: { items: [snippetItemOf('t-form', '受付票', FORM_BODY)!], total: 1, truncated: false } });
    renderer.render(d.getState());
    sent.length = 0;
    region.querySelector<HTMLElement>('[data-pkc-action="record-new"][data-pkc-template-lid="t-form"]')!.click();
    const created = sent.find((a) => a.type === 'CREATE_ENTRY') as { body?: string } | undefined;
    expect(created!.body).toContain('住所');
    expect(created!.body).not.toContain('氏名');
  });

  it('SYS_BOOTED は、アプリの一覧を開いたことがあるなら走査も頼み直す(開いていなければ頼まない)', () => {
    const base = reduce(initialState, { type: 'SYS_BOOTED', cid: 'c1', metas: [], relations: [] }).state;
    const opened = reduce(base, { type: 'LAUNCHER_TILES_LOADED', tiles: [] }).state;
    expect(opened.launcherTiles, '前提: 開いたことがある').not.toBeNull();
    const again = reduce(opened, { type: 'SYS_BOOTED', cid: 'c1', metas: [], relations: [] }).events.map((e) => e.type);
    expect(again).toContain('REQUEST_SNIPPET_SCAN');
    const fresh = reduce(initialState, { type: 'SYS_BOOTED', cid: 'c1', metas: [], relations: [] }).events.map((e) => e.type);
    expect(fresh).not.toContain('REQUEST_SNIPPET_SCAN');
  });

  it('書き出し / 取り込みが実行中なら「新しい記録」はノートを作らず、理由を言う', () => {
    const { d, sent, region } = setup({ busy: true });
    region.querySelector<HTMLElement>('[data-pkc-action="record-new"][data-pkc-template-lid="t-form"]')!.click();
    expect(sent.some((a) => a.type === 'CREATE_ENTRY')).toBe(false);
    expect(sent.some((a) => a.type === 'OP_FAILED')).toBe(true);
    expect(d.getState().phase).toBe('ready');
  });

  it('絞り込みが記録のテンプレートにだけ合うとき(組み込みのタイルが全部消える)も節は出る', () => {
    const { d, region, renderer } = setup({ tiles: BUILTIN_TILES });
    expect(region.querySelector('[data-pkc-action="open-tile"][data-pkc-tile="b1"]'), '前提: タイルが実在').not.toBeNull();
    d.dispatch({ type: 'SET_ENTRY_FILTER', query: '受付票' } as Dispatchable);
    renderer.render(d.getState());
    expect(region.querySelector('[data-pkc-action="open-tile"]'), '前提: タイルは 1 枚も残らない').toBeNull();
    const rows = [...region.querySelectorAll('[data-pkc-action="record-new"]')];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.getAttribute('data-pkc-template-lid')).toBe('t-form');
  });

  it('「新しい記録」には、どのテンプレートのものか分かる読み上げ名が付く', () => {
    const { region } = setup();
    const names = [...region.querySelectorAll('[data-pkc-action="record-new"]')].map((b) => b.getAttribute('aria-label'));
    expect(names).toEqual(['受付票 の新しい記録', ...SAMPLE_TEMPLATES.map((s) => `${s.title} の新しい記録`)]);
  });

  it('走査が上限で切れていたら、すべては出ていないと 1 行で言う。切れていなければ出さない', () => {
    const cut = setup({ truncated: true });
    expect(cut.region.querySelector('[data-pkc-field="launcher-records-truncated"]')?.textContent).toBe(
      'テンプレートが多いため、すべては表示していません。',
    );
    const whole = setup();
    expect(whole.region.querySelector('[data-pkc-field="launcher-records-truncated"]')).toBeNull();
  });
});
