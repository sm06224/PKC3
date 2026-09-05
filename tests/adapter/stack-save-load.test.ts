/** @vitest-environment happy-dom */
/**
 * 🔴 **スタックを「参照のみのフォルダ」として保存し、載せ直す**(#633 段③。user 裁定 2026-08-30
 * 「**スタックをグループとして参照のみのフォルダとして保存する機能もつけろ**」)。
 *
 * 見るのは user が見る形 ── ①帯の「保存…」を押すと題名を聞かれ、リンクの箇条書きの
 * ノートができて**読んでいる本文は退かない** ②入れ物の「このスタックを載せる」で
 * **本文の 1 行目が一番上**に来る ③消えたノートの行は残り、数えて言う。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import type { Dispatchable } from '../../src/adapter/state/app-state';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { CenterRouter } from '../../src/adapter/ui/render/center';
import { setFoldNotify } from '../../src/adapter/ui/render/fold-notify';
import { DIALOG_REGION, resetAppDialogForTest } from '../../src/adapter/ui/render/app-dialog';
import { connectStoreEffects, type StorePort } from '../../src/adapter/state/store-effects';
import { entryMenuActions } from '../../src/features/entry-actions';
import { stackBody } from '../../src/features/flavor/stack-flavor';

function meta(lid: string, title: string, archetype = 'text'): EntryMeta {
  return {
    lid,
    title,
    archetype,
    createdAt: null,
    updatedAt: null,
    entryOrder: 1,
    status: null,
    date: null,
    archived: false,
    bodyChars: 0,
  };
}

const METAS = [meta('a', '議事録'), meta('b', '資料 B'), meta('c', '去年の稟議'), meta('s', '今週の束', 'stack')];

function booted(): Dispatcher {
  const d = new Dispatcher();
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: METAS as never, relations: [] });
  return d;
}

const tick = async (): Promise<void> => {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
};

const dialog = (): HTMLDialogElement | null =>
  document.querySelector<HTMLDialogElement>(`[data-pkc-region="${DIALOG_REGION}"]`);

beforeEach(() => {
  document.body.innerHTML = '';
  resetAppDialogForTest();
});

describe('CREATE_ENTRY keepSelection ── 作っても読んでいる本文を退かさない', () => {
  it('🔴 選択・開いている本文・絞りが動かず、編集にも入らない(それでも一覧には増える)', () => {
    const d = booted();
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    d.dispatch({ type: 'BODY_LOADED', lid: 'a', body: '# A\n' });
    d.dispatch({ type: 'SET_ENTRY_FILTER', query: '議' });
    const before = d.getState();
    d.dispatch({
      type: 'CREATE_ENTRY',
      lid: 'new1',
      title: 'スタック 9/5',
      archetype: 'stack',
      body: stackBody([{ title: '議事録', lid: 'a' }]),
      edit: false,
      keepSelection: true,
    });
    const after = d.getState();
    expect(after.selectedLid, '選択が新しい物へ動いた(本文が退いた)').toBe('a');
    expect(after.openBody, '開いている本文が差し替わった').toBe(before.openBody);
    expect(after.phase).toBe('ready');
    expect(after.filterQuery, '絞りが外れた').toBe(before.filterQuery);
    expect(after.entryMetas.get('new1')?.archetype).toBe('stack');
    expect(after.order).toContain('new1');
  });

  it('⚠ 対照群: keepSelection を付けなければ、今までどおり新しい物が選ばれる', () => {
    const d = booted();
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    d.dispatch({ type: 'CREATE_ENTRY', lid: 'new2', title: 'x', archetype: 'stack', body: '', edit: false });
    expect(d.getState().selectedLid).toBe('new2');
  });
});

describe('LOAD_STACK ── 本文の並びを、いまのスタックの上に積む', () => {
  const BODY = stackBody([
    { title: '議事録', lid: 'a' },
    { title: '資料 B', lid: 'b' },
    { title: '消えた', lid: 'ghost' },
  ]);

  it('🔴 本文の 1 行目が一番上に来て、既に載っていた物は下に残る(全置換にしない)', () => {
    const d = booted();
    d.dispatch({ type: 'PIN_SPLIT_ENTRY', lid: 'c' });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 's' });
    d.dispatch({ type: 'BODY_LOADED', lid: 's', body: BODY });
    const seen: string[] = [];
    const off = d.onEvent((e) => seen.push(e.type));
    d.dispatch({ type: 'LOAD_STACK', lid: 's' });
    off();
    expect(d.getState().splitLids).toEqual(['a', 'b', 'c']);
    // 載せた 2 件の本文を読みに行く(帯の札と同じ 1 本)。効果層へは行かない(本文は画面に在った)
    expect(seen.filter((t) => t === 'REQUEST_SPLIT_BODY')).toHaveLength(2);
    expect(seen).not.toContain('REQUEST_STACK_BODY');
  });

  it('🔴 消えたノートの行は残っていて、数えて言う(参照のみ ── メンバーの本文は書かない)', () => {
    const d = booted();
    d.dispatch({ type: 'SELECT_ENTRY', lid: 's' });
    d.dispatch({ type: 'BODY_LOADED', lid: 's', body: BODY });
    d.dispatch({ type: 'LOAD_STACK', lid: 's' });
    expect(d.getState().notice).toBe('2 件を載せました(1 件は見つかりません)');
    // ⚠ 本文そのものは 1 バイトも変わっていない(ghost の行が残る)
    expect(d.getState().openBody?.body).toBe(BODY);
  });

  it('⚠ 全部消えていれば「載せられるノートがありません」', () => {
    const d = booted();
    d.dispatch({ type: 'SELECT_ENTRY', lid: 's' });
    d.dispatch({ type: 'BODY_LOADED', lid: 's', body: stackBody([{ title: 'x', lid: 'gone' }]) });
    d.dispatch({ type: 'LOAD_STACK', lid: 's' });
    expect(d.getState().splitLids).toEqual([]);
    expect(d.getState().notice).toBe('載せられるノートがありません(1 件は見つかりません)');
  });

  it('⚠ スタックの入れ物でないノートには効かない(押し所は when: stack で畳まれている)', () => {
    const d = booted();
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    d.dispatch({ type: 'BODY_LOADED', lid: 'a', body: BODY });
    const before = d.getState();
    d.dispatch({ type: 'LOAD_STACK', lid: 'a' });
    expect(d.getState()).toBe(before);
  });

  it('🔴 本文が画面に無ければ効果層が読んで積む(実物の配線)', async () => {
    const d = booted();
    const store = { getBody: () => Promise.resolve(BODY) } as unknown as StorePort;
    const off = connectStoreEffects(d, store);
    try {
      const seen: string[] = [];
      const offEv = d.onEvent((e) => seen.push(e.type));
      d.dispatch({ type: 'LOAD_STACK', lid: 's' });
      offEv();
      expect(seen, '画面に無いのに効果層へ頼んでいない').toContain('REQUEST_STACK_BODY');
      for (let i = 0; i < 10 && d.getState().splitLids.length === 0; i += 1) await Promise.resolve();
      expect(d.getState().splitLids).toEqual(['a', 'b']);
    } finally {
      off();
    }
  });
});

describe('行のメニュー / 情報ペインの口(when: stack)', () => {
  it('🔴 スタックの入れ物にだけ「このスタックを載せる」が出る', () => {
    const forStack = entryMenuActions({ archetype: 'stack', linkedFile: null }).map((a) => a.action);
    const forText = entryMenuActions({ archetype: 'text', linkedFile: null }).map((a) => a.action);
    expect(forStack).toContain('stack-load');
    expect(forText).not.toContain('stack-load');
  });
});

describe('帯の「保存…」(#633 段③)', () => {
  function bootView() {
    const root = document.createElement('div');
    root.setAttribute('data-pkc-region', 'detail');
    document.body.append(root);
    setFoldNotify(() => {});
    const center = new CenterRouter(root, undefined, null, undefined, undefined);
    const d = booted();
    d.onState((s) => center.render(s));
    return { root, d };
  }

  it('🔴 載せていれば帯の右端に「保存…」が出て、編集中は押せない(理由つき)', async () => {
    const { root, d } = bootView();
    d.dispatch({ type: 'PIN_SPLIT_ENTRY', lid: 'b' });
    await tick();
    const save = root.querySelector<HTMLButtonElement>('[data-pkc-region="stack-bar"] [data-pkc-action="stack-save"]');
    expect(save, '帯に保存の口が無い').not.toBeNull();
    expect(save!.disabled).toBe(false);
    // 帯の**末尾**(札の後)に在る
    expect(save!.parentElement?.lastElementChild).toBe(save);
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    d.dispatch({ type: 'BODY_LOADED', lid: 'a', body: '# A\n' });
    d.dispatch({ type: 'START_EDIT' });
    await tick();
    expect(d.getState().phase, '前提: 編集に入った').toBe('editing');
    const saveEditing = root.querySelector<HTMLButtonElement>('[data-pkc-action="stack-save"]');
    expect(saveEditing?.disabled, '編集中なのに押せる顔をしている').toBe(true);
    expect(saveEditing?.title).toContain('編集を終えて');
  });

  function bindSetup() {
    resetAppDialogForTest();
    const root = document.createElement('div');
    root.setAttribute('data-pkc-slot', 'root');
    document.body.append(root);
    buildShell(root);
    const d = booted();
    const sent: Dispatchable[] = [];
    const raw = d.dispatch.bind(d);
    d.dispatch = ((a: Dispatchable) => {
      sent.push(a);
      return raw(a);
    }) as typeof d.dispatch;
    bindActions(root, d);
    // 帯の「保存…」と同じ綴りの押し口(帯そのものは center が描く ── ここでは受け手を見る)
    const save = document.createElement('button');
    save.setAttribute('data-pkc-action', 'stack-save');
    root.append(save);
    return { root, d, sent, save };
  }

  it('🔴 押すと題名を聞き、決めるとスタック順の箇条書きのノートができて、読んでいる本文は退かない', async () => {
    const { d, sent, save } = bindSetup();
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'c' });
    d.dispatch({ type: 'BODY_LOADED', lid: 'c', body: '# C\n' });
    d.dispatch({ type: 'PIN_SPLIT_ENTRY', lid: 'a' });
    d.dispatch({ type: 'PIN_SPLIT_ENTRY', lid: 'b' }); // 一番上は b
    sent.length = 0;
    save.click();
    await tick();
    expect(dialog()?.open, '題名を聞く窓が開いていない').toBe(true);
    const input = document.querySelector<HTMLInputElement>('[data-pkc-field="prompt-input"]')!;
    expect(input.value, '既定の題名が無い').toMatch(/^スタック \d+\/\d+$/);
    input.value = '今週の束 2';
    document.querySelector<HTMLButtonElement>('[data-pkc-field="dialog-ok"]')!.click();
    await tick();
    const created = sent.find((a) => a.type === 'CREATE_ENTRY') as
      | { type: 'CREATE_ENTRY'; title: string; archetype: string; body?: string; keepSelection?: boolean }
      | undefined;
    expect(created, 'CREATE_ENTRY が飛んでいない').toBeDefined();
    expect(created!.archetype).toBe('stack');
    expect(created!.title).toBe('今週の束 2');
    expect(created!.keepSelection).toBe(true);
    expect(created!.body).toBe(stackBody([{ title: '資料 B', lid: 'b' }, { title: '議事録', lid: 'a' }]));
    // 読んでいる本文は退いていない
    expect(d.getState().selectedLid).toBe('c');
    expect(d.getState().openBody?.lid).toBe('c');
    // 作った物へ行ける知らせ(「開く」の身元つき)
    expect(d.getState().notice).toContain('「今週の束 2」');
    expect(d.getState().noticeOpen).toBe(d.getState().order[d.getState().order.length - 1]);
  });

  it('⚠ やめると何も作らない / 空のスタックでは理由を言う', async () => {
    const { d, sent, save } = bindSetup();
    save.click();
    expect(d.getState().error).toContain('載せてあるノートがありません');
    d.dispatch({ type: 'PIN_SPLIT_ENTRY', lid: 'a' });
    sent.length = 0;
    save.click();
    await tick();
    expect(dialog()?.open).toBe(true);
    document.querySelector<HTMLButtonElement>('[data-pkc-field="dialog-cancel"]')!.click();
    await tick();
    expect(sent.find((a) => a.type === 'CREATE_ENTRY')).toBeUndefined();
  });

  it('🔴 「このスタックを載せる」の受け手は、押した行の入れ物を LOAD_STACK へ渡す', () => {
    const { root, d, sent } = bindSetup();
    const btn = document.createElement('button');
    btn.setAttribute('data-pkc-action', 'stack-load');
    btn.setAttribute('data-pkc-entry', 's');
    root.append(btn);
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    sent.length = 0;
    btn.click();
    expect(sent).toContainEqual({ type: 'LOAD_STACK', lid: 's' });
  });
});
