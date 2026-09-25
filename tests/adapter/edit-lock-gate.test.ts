/** @vitest-environment happy-dom */
/**
 * #177: 「編集」ボタンの編集権ゲート ── binder → dispatcher の end-to-end。
 *
 * 守る主張:
 * 1. 取れたら編集に入る(従来と同じ)
 * 2. 取れなかったら**編集に入らず**、押した場所と対の断りが出る(無言にしない)
 * 3. 取ったのに reducer が編集を断ったら**返す**(取りっぱなしの死にロックを作らない)
 * 4. 作成 → 即編集も編集権を登録する(別タブが 'changed' でこの lid を知る前に)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { codeOnly } from '../helpers/code-only';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { DetailRenderer } from '../../src/adapter/ui/render/detail';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { stubStamps } from '../helpers/store-stamps';
import { stubRevisionOps } from '../helpers/revision-stub';

function meta(lid: string): EntryMeta {
  return {
    lid,
    title: 't-' + lid,
    archetype: 'text',
    createdAt: null,
    updatedAt: null,
    entryOrder: 1,
    status: null,
    date: null,
    archived: false,
    bodyChars: null,
  };
}

const tick = async (ms = 10): Promise<void> => {
  await new Promise((r) => setTimeout(r, ms));
};

function setup(services: {
  acquireEditLock?: (lid: string) => Promise<'granted' | 'denied' | 'unreachable'>;
  releaseEditLock?: (lid: string) => void;
}) {
  const root = document.createElement('div');
  document.body.append(root);
  const d = new Dispatcher();
  const regions = buildShell(root);
  const detail = new DetailRenderer(regions.detail);
  d.onState((s) => detail.render(s));
  bindActions(root, d, services);
  connectStoreEffects(d, {
    ...stubRevisionOps(),
    getBody: async () => '# 本文',
    deleteEntry: async () => {},
    setEntryParent: async () => {},
    /**
     * ⚠ **題名だけの口**(#178)── 本物は本文に触らない。
     *   だから fake も本文を持たない(触らないものは持たない)。
     */
    renameEntry: async () => stubStamps(),
    replaceAssetRefs: () =>
      Promise.reject(new Error('この test では添付の差し替えを使わない')),
    reorderEntry: async () => stubStamps(),
    persistEntry: async () => stubStamps(),
  });
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('a')], relations: [] });
  const q = <T extends HTMLElement>(sel: string) => root.querySelector<T>(sel);
  return { root, d, q };
}

beforeEach(() => {
  document.body.innerHTML = '';
  localStorage.setItem('pkc3.editor-mode', 'split');
});

describe('start-edit の編集権ゲート(#177)', () => {
  it('取れたら編集に入る', async () => {
    const acquireEditLock = vi.fn(async () => 'granted' as const);
    const { d, q } = setup({ acquireEditLock });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    await tick();
    q('[data-pkc-action="start-edit"]')!.click();
    await tick();
    expect(acquireEditLock).toHaveBeenCalledWith('a');
    expect(d.getState().phase).toBe('editing');
  });

  it('取れなかったら編集に入らず、断りが出る(無言の dead click にしない)', async () => {
    const { d, q } = setup({ acquireEditLock: async () => 'denied' });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    await tick();
    q('[data-pkc-action="start-edit"]')!.click();
    await tick();
    expect(d.getState().phase).toBe('ready');
    // ⚠ 文言は押した場所と対(§1)── 「別のタブ」が理由だと分かる形
    expect(d.getState().error).toContain('別のタブかウィンドウで編集中');
  });

  it('本体と話せないときは「編集中」と言わない(レビュー M-7 ── 文言の嘘)', async () => {
    const { d, q } = setup({ acquireEditLock: async () => 'unreachable' });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    await tick();
    q('[data-pkc-action="start-edit"]')!.click();
    await tick();
    expect(d.getState().phase).toBe('ready');
    expect(d.getState().error).toContain('最初に開いた PKC のタブと通信できません');
    expect(d.getState().error, '存在しない編集タブを探させる文言').not.toContain('編集中です');
  });

  it('acquire 待ち中に選択が変わったら、別ノートの編集に入らずロックを返す(レビュー M-3)', async () => {
    let resolveLock!: (v: 'granted') => void;
    const acquireEditLock = vi.fn(
      () => new Promise<'granted'>((r) => (resolveLock = r)),
    );
    const releaseEditLock = vi.fn();
    const { d, q } = setup({ acquireEditLock, releaseEditLock });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    await tick();
    q('[data-pkc-action="start-edit"]')!.click(); // 'a' の acquire 発行(pending)
    // 待っている間に別のノートへ移る(setup の meta は 'a' だけなので 'b' を足す)
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('a'), meta('b')], relations: [] });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'b' });
    await tick(); // 'b' の本文が openBody へ
    expect(d.getState().openBody?.lid).toBe('b');
    resolveLock('granted');
    await tick();
    // 🔴 'b' の編集に「'a' のロックで」入ってはいけない
    expect(d.getState().phase).toBe('ready');
    expect(releaseEditLock).toHaveBeenCalledWith('a');
  });

  it('取ったのに編集に入れなかったら返す(死にロックを作らない)', async () => {
    // 実在する race: acquire は非同期(follower は放送 1 往復)── 待っている間に
    // user が別の操作で editing に入ると、reducer は START_EDIT を断る。
    // そのときロックを返さないと、'a' は**どのタブからも編集できないノート**になる
    let resolveLock!: (v: 'granted') => void;
    const acquireEditLock = vi.fn(
      () => new Promise<'granted'>((r) => (resolveLock = r)),
    );
    const releaseEditLock = vi.fn();
    const { d, q } = setup({ acquireEditLock, releaseEditLock });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    await tick();
    q('[data-pkc-action="start-edit"]')!.click(); // acquire 発行(pending)
    d.dispatch({ type: 'CREATE_ENTRY', archetype: 'text', lid: 'b', title: 'b' });
    expect(d.getState().phase).toBe('editing'); // 'b' の編集に入った
    resolveLock('granted');
    await tick();
    expect(d.getState().openBody?.lid, "'a' の編集で上書きされた").toBe('b');
    expect(releaseEditLock, '入れなかったのに握りっぱなし').toHaveBeenCalledWith('a');
  });

  it('サービス未配線(単独タブ相当)なら従来どおり編集に入る', async () => {
    const { d, q } = setup({});
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    await tick();
    q('[data-pkc-action="start-edit"]')!.click();
    await tick();
    expect(d.getState().phase).toBe('editing');
  });

  it('作成 → 即編集も編集権を登録する', async () => {
    const acquired: string[] = [];
    const { d, q } = setup({
      acquireEditLock: async (lid) => {
        acquired.push(lid);
        return 'granted';
      },
    });
    await tick();
    const btn = q('[data-pkc-action="create-entry"]');
    expect(btn, 'create ボタンが無い(前提が崩れた)').not.toBeNull();
    btn!.click();
    await tick();
    expect(d.getState().phase).toBe('editing');
    const lid = d.getState().openBody?.lid;
    expect(lid).toBeTruthy();
    expect(acquired).toContain(lid);
  });
});

/**
 * 🔴 **Ctrl(⌘)+クリックの「その地点から編集」も、同じ門を通る**(#1044 の調査で判明)。
 *
 * ⚠ `startEditAt` の注釈は「Ctrl+クリックがロックを取らずに編集へ入っていた」のを直したと
 *   書いているが、#495 で Ctrl+クリックを「その地点から編集」にしたとき、**ここだけ
 *   `START_EDIT` の直撃ちに戻っていた** ── 別のタブで編集中のノートにも入れた。
 */
describe('Ctrl+クリックの編集権ゲート', () => {
  const ctrlClickHeading = (root: HTMLElement): void => {
    const h = root.querySelector('[data-pkc-field="detail-body"] h1');
    expect(h, '前提が崩れている: 本文の見出しが描かれていない').not.toBeNull();
    h!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ctrlKey: true }));
  };

  it('取れなかったら編集に入らず、断りが出る', async () => {
    const acquireEditLock = vi.fn(async () => 'denied' as const);
    const { root, d } = setup({ acquireEditLock });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    await tick();
    ctrlClickHeading(root);
    await tick();
    expect(acquireEditLock, 'ロックを問い合わせずに編集へ入った').toHaveBeenCalledWith('a');
    expect(d.getState().phase, '別のタブで編集中なのに入った').toBe('ready');
    expect(d.getState().error).toContain('別のタブかウィンドウで編集中');
  });

  it('⚠ 対照群 ── 取れたら押した行から編集に入る', async () => {
    const { root, d } = setup({ acquireEditLock: async () => 'granted' });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    await tick();
    ctrlClickHeading(root);
    await tick();
    expect(d.getState().phase).toBe('editing');
    expect(d.getState().editOpenAt, '押した行が渡っていない').toBe(0);
  });
});

/**
 * 🔴 **`START_EDIT` を撃つのは `startEditAt` の中だけ**(全数)。
 * ⚠ この門は 2 度破れている ── #426 段② で 1 本に寄せたのに、#495(Ctrl+クリック)と
 *   「常に編集で開く」が直撃ちで足された。注釈で「1 本にした」と書いても、足す人には届かない。
 */
describe('編集に入る口は 1 本', () => {
  function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (p.endsWith('.ts')) out.push(p);
    }
    return out;
  }
  it('src の中で START_EDIT を dispatch するのは startEditAt の本体だけ', () => {
    const files = walk(join(__dirname, '../../src'));
    expect(files.length, '空振り防止: src を読めていない').toBeGreaterThan(100);
    const outside: string[] = [];
    let inside = 0;
    for (const f of files) {
      let code = codeOnly(readFileSync(f, 'utf8'));
      const at = code.indexOf('function startEditAt(');
      if (at >= 0) {
        // 本体の終わり = 次の行頭の `}`(関数宣言は行頭から始まり、行頭の `}` で閉じる)
        const end = code.indexOf('\n}\n', at);
        expect(end, 'startEditAt の本体の終わりが読めない').toBeGreaterThan(at);
        const body = code.slice(at, end);
        inside += body.split("dispatch({ type: 'START_EDIT'").length - 1;
        code = code.slice(0, at) + code.slice(end);
      }
      if (code.includes("dispatch({ type: 'START_EDIT'")) outside.push(f);
    }
    expect(inside, '空振り防止: startEditAt の中の dispatch が見つからない').toBeGreaterThan(0);
    expect(outside, 'startEditAt を通らずに編集へ入る口がある(ロックと書込待ちを飛ばす)').toEqual([]);
  });
});
