/** @vitest-environment happy-dom */
/**
 * 🔴 **作ったノートの種類を、あとから変える**(台帳 #1852 I2 / 依頼 157。Gemini 回答 = 推薦 ②)。
 *
 * 見るのは 5 つ:
 * ① 出る範囲 ── ノートとログにだけ「種類を変える…」が出る(フォルダ・添付などには出さない)
 * ② reducer ── ノート ⇄ ログだけ変わり、編集中は黙らずに断る
 * ③ 書込 ── 本文は 1 バイトも変えず、種類だけを書く。別の窓が本文を書いていたら書かず、画面の種類を戻す
 * ④ 押したときの確認 ── 押すとまず確認が出て、「変える」で初めて変わる(やめるなら変わらない)
 * ⑤ 右の列のボタン ── ノートとログのときだけ見える
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stubStamps } from '../helpers/store-stamps';
import { stubRevisionOps } from '../helpers/revision-stub';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import type { EntryUpsert } from '../../src/adapter/platform/storage/schema';
import { initialState, reduce } from '../../src/adapter/state/app-state';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { InspectorRenderer } from '../../src/adapter/ui/render/inspector';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { resetAppDialogForTest } from '../../src/adapter/ui/render/app-dialog';
import { entryMenuActions } from '../../src/features/entry-actions';
import {
  canChangeKind,
  kindChangeQuestion,
  kindChangeTarget,
  kindChangedNotice,
} from '../../src/features/flavor/kind-change';

const meta = (lid: string, archetype: string): EntryMeta => ({
  lid,
  title: '買い物',
  archetype,
  createdAt: null,
  updatedAt: null,
  entryOrder: 1,
  status: null,
  date: null,
  archived: false,
  bodyChars: null,
});

const tick = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('① 出る範囲', () => {
  it('ノートとログだけ変えられる(組は入れ替え)', () => {
    expect(canChangeKind('text')).toBe(true);
    expect(canChangeKind('textlog')).toBe(true);
    expect(kindChangeTarget('text')).toBe('textlog');
    expect(kindChangeTarget('textlog')).toBe('text');
    for (const a of ['folder', 'smart', 'stack', 'attachment', 'snippet', 'spreadsheet', 'todo', 'appgroup']) {
      expect(canChangeKind(a), a).toBe(false);
      expect(kindChangeTarget(a), a).toBeNull();
    }
    expect(canChangeKind(null)).toBe(false);
  });

  it('右クリック・右の列の表にも同じ条件で出る(フォルダなどには出ない)', () => {
    const has = (archetype: string): boolean =>
      entryMenuActions({ archetype, linkedFile: null }).some((a) => a.action === 'change-entry-kind');
    expect(has('text')).toBe(true);
    expect(has('textlog')).toBe(true);
    for (const a of ['folder', 'attachment', 'stack', 'smart']) expect(has(a), a).toBe(false);
    const row = entryMenuActions({ archetype: 'text', linkedFile: null }).find((a) => a.action === 'change-entry-kind')!;
    expect(row.label).toBe('種類を変える…');
    expect(row.hint).not.toBe('');
  });

  it('確認の字は画面の言葉で、本文が変わらないことと戻せることを言う', () => {
    const q = kindChangeQuestion('買い物', 'text', 'textlog');
    expect(q).toContain('「買い物」を「ノート」から「ログ」に変えます');
    expect(q).toContain('本文はそのまま残ります');
    expect(q).toContain('もう一度押せば元に戻せます');
    expect(kindChangeQuestion('', 'textlog', 'text')).toContain('このノートを「ログ」から「ノート」に変えます');
    expect(kindChangedNotice('textlog')).toBe('種類を「ログ」に変えました');
  });
});

describe('② reducer', () => {
  const ready = (archetype: string) =>
    reduce(initialState, { type: 'SYS_BOOTED', cid: 'c1', metas: [meta('a', archetype)], relations: [] }).state;

  it('ノートをログに:画面の種類が先に変わり、永続化の依頼が 1 件出る', () => {
    const r = reduce(ready('text'), { type: 'SET_ENTRY_ARCHETYPE', lid: 'a', archetype: 'textlog' });
    expect(r.state.entryMetas.get('a')!.archetype).toBe('textlog');
    expect(r.events).toEqual([
      { type: 'REQUEST_SET_ARCHETYPE', lid: 'a', title: '買い物', archetype: 'textlog', oldArchetype: 'text', entryOrder: 1 },
    ]);
  });

  it('組にない変更・同じ種類・無いノートは何もしない', () => {
    const base = ready('folder');
    expect(reduce(base, { type: 'SET_ENTRY_ARCHETYPE', lid: 'a', archetype: 'text' }).events).toEqual([]);
    const note = ready('text');
    expect(reduce(note, { type: 'SET_ENTRY_ARCHETYPE', lid: 'a', archetype: 'text' }).events).toEqual([]);
    expect(reduce(note, { type: 'SET_ENTRY_ARCHETYPE', lid: 'a', archetype: 'folder' }).events).toEqual([]);
    expect(reduce(note, { type: 'SET_ENTRY_ARCHETYPE', lid: 'zz', archetype: 'textlog' }).events).toEqual([]);
  });

  it('🔴 編集中は変えず、理由を言う(黙って断らない)', () => {
    let s = ready('text');
    s = reduce(s, { type: 'SELECT_ENTRY', lid: 'a' }).state;
    s = reduce(s, { type: 'BODY_LOADED', lid: 'a', body: '本文' }).state;
    s = reduce(s, { type: 'START_EDIT' } as never).state;
    expect(s.phase).toBe('editing');
    const r = reduce(s, { type: 'SET_ENTRY_ARCHETYPE', lid: 'a', archetype: 'textlog' });
    expect(r.events).toEqual([]);
    expect(r.state.entryMetas.get('a')!.archetype).toBe('text');
    expect(r.state.error).toContain('種類を変えてください');
  });

  it('保存に失敗したときの戻し:画面がまだ「変えた後」のときだけ元へ戻す', () => {
    const changed = reduce(ready('text'), { type: 'SET_ENTRY_ARCHETYPE', lid: 'a', archetype: 'textlog' }).state;
    const back = reduce(changed, { type: 'SET_ENTRY_ARCHETYPE_ROLLBACK', lid: 'a', from: 'textlog', to: 'text' });
    expect(back.state.entryMetas.get('a')!.archetype).toBe('text');
    // 間に別の変更が入っていたら触らない
    const other = reduce(changed, { type: 'SET_ENTRY_ARCHETYPE_ROLLBACK', lid: 'a', from: 'text', to: 'textlog' });
    expect(other.state.entryMetas.get('a')!.archetype).toBe('textlog');
  });
});

describe('③ 書込', () => {
  async function run(opts: { conflict?: boolean; gone?: boolean; throws?: boolean } = {}) {
    const d = new Dispatcher();
    const body = '---\ndate: 2026-10-10\n---\n## 2026-10-10 12:30:00\n\n会議\n';
    const writes: { e: EntryUpsert; o: { expectHash?: string; checkpoint?: boolean; keepMeta?: boolean } | undefined }[] = [];
    connectStoreEffects(d, {
      ...stubRevisionOps(),
      getBody: async () => (opts.gone === true ? null : body),
      deleteEntry: async () => {},
      setEntryParent: async () => {},
      renameEntry: async () => stubStamps(),
      persistEntry: async (e: EntryUpsert, o?: { expectHash?: string; checkpoint?: boolean; keepMeta?: boolean }) => {
        writes.push({ e, o });
        if (opts.throws === true) throw new Error('disk');
        return opts.conflict === true ? { ...stubStamps(), conflict: true } : stubStamps();
      },
    } as never);
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('a', 'text')], relations: [] });
    d.dispatch({ type: 'SET_ENTRY_ARCHETYPE', lid: 'a', archetype: 'textlog' });
    await tick();
    return { d, writes, body };
  }

  it('🔴 本文は 1 バイトも変えず、種類だけを書く。知らせを出す', async () => {
    const { d, writes, body } = await run();
    expect(writes).toHaveLength(1);
    const w = writes[0]!;
    expect(w.e.body, '本文が変わった').toBe(body);
    expect(w.e.archetype).toBe('textlog');
    expect(w.e.title).toBe('買い物');
    expect(w.e.date, '抽出列(日付)を新しい種類の規則で引き直している').toBe('2026-10-10');
    // 読んだ本文の hash で門を掛ける(別の窓の書込を踏まない)。履歴は積まない・題名などは渡した値で書く
    expect(w.o?.expectHash).toEqual(expect.any(String));
    expect(w.o?.checkpoint).toBeUndefined();
    expect(w.o?.keepMeta).toBeUndefined();
    expect(d.getState().entryMetas.get('a')!.archetype).toBe('textlog');
    expect(d.getState().notice).toBe('種類を「ログ」に変えました');
  });

  it('🔴 別の窓が本文を書いていたら、書かずに断り、画面の種類を元へ戻す', async () => {
    const { d } = await run({ conflict: true });
    expect(d.getState().entryMetas.get('a')!.archetype).toBe('text');
    expect(d.getState().error).toContain('種類を変えられませんでした');
  });

  it('ノートが無かった・書けなかったときも、画面の種類を元へ戻して理由を言う', async () => {
    const gone = await run({ gone: true });
    expect(gone.d.getState().entryMetas.get('a')!.archetype).toBe('text');
    expect(gone.writes).toHaveLength(0);
    expect(gone.d.getState().error).toBeTruthy();
    const bad = await run({ throws: true });
    expect(bad.d.getState().entryMetas.get('a')!.archetype).toBe('text');
    expect(bad.d.getState().error).toContain('種類を変えられませんでした: ');
  });
});

describe('④ 押したときの確認 / ⑤ 右の列', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    resetAppDialogForTest();
  });
  afterEach(() => {
    document.body.innerHTML = '';
  });

  function setup(archetype: string) {
    const root = document.createElement('div');
    document.body.append(root);
    buildShell(root);
    const d = new Dispatcher();
    bindActions(root, d, {});
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('a', archetype)], relations: [] });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    const press = (): void => {
      const b = document.createElement('button');
      b.setAttribute('data-pkc-action', 'change-entry-kind');
      b.setAttribute('data-pkc-entry', 'a');
      root.append(b);
      b.click();
    };
    return { root, d, press };
  }
  const dialog = (name: string): HTMLButtonElement | null =>
    document.querySelector<HTMLButtonElement>(`[data-pkc-field="${name}"]`);

  it('🔴 押すと確認が先に出る(まだ変わらない)。「変える」で初めて変わる', async () => {
    const { d, press } = setup('text');
    press();
    await tick();
    expect(d.getState().entryMetas.get('a')!.archetype, '確認の前に変わった').toBe('text');
    expect(document.body.textContent).toContain('「買い物」を「ノート」から「ログ」に変えます');
    expect(dialog('dialog-ok')!.textContent).toBe('「ログ」に変える');
    dialog('dialog-ok')!.click();
    await tick();
    expect(d.getState().entryMetas.get('a')!.archetype).toBe('textlog');
  });

  it('「やめる」なら変わらない', async () => {
    const { d, press } = setup('text');
    press();
    await tick();
    dialog('dialog-cancel')!.click();
    await tick();
    expect(d.getState().entryMetas.get('a')!.archetype).toBe('text');
  });

  it('変えられない種類(フォルダ)を押したら、確認を出さずに理由を言う', async () => {
    const { d, press } = setup('folder');
    press();
    await tick();
    expect(dialog('dialog-ok')).toBeNull();
    expect(d.getState().error).toContain('変えられるのはノートとログです');
  });

  it('右の列のボタンはノートとログのときだけ見える(フォルダでは畳む)', () => {
    for (const [archetype, visible] of [['text', true], ['textlog', true], ['folder', false]] as const) {
      document.body.textContent = '';
      const root = document.createElement('div');
      document.body.append(root);
      const inspector = new InspectorRenderer(buildShell(root).inspector);
      const s = reduce(initialState, { type: 'SYS_BOOTED', cid: 'c1', metas: [meta('n1', archetype)], relations: [] }).state;
      inspector.render(reduce(s, { type: 'SELECT_ENTRY', lid: 'n1' }).state);
      const b = root.querySelector<HTMLButtonElement>('[data-pkc-action="change-entry-kind"]');
      expect(b, `${archetype}: 右の列にボタンが無い`).not.toBeNull();
      expect(b!.hidden, archetype).toBe(!visible);
      expect(b!.title, archetype).not.toBe('');
    }
  });
});
