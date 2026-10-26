/** @vitest-environment happy-dom */
/**
 * 🔴 **差分マージの面**(#1231。user 指示 2026-10-26「全部やるのです」)。
 *
 * 見るのは user が見て押せるもの:
 * ①左右にノートを選ぶと、ちがいが塊ごとに並ぶ ②→ ← で塊を取り込むと、その塊が消える(取り消せる)
 * ③🔴 保存を押すまで何も書かず、押すと**保存された本文**が変わる(書き換わるのはノートの側だけ)
 * ④履歴の版・PC のファイルは読むだけ(取り込みの向きが塞がれ、理由が出る)⑤読み込んだ後にノートが変わっていたら書かない
 * ⑥選び直しの前の遅い読み込みが、いまの選びを上書きしない ⑦タイルと面がある
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import { CenterRouter } from '../../src/adapter/ui/render/center';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { isAsidePane, isViewMode, leavesOnSelect, viewModeLabel } from '../../src/adapter/state/app-state';
import { BUILTIN_KINDS, withBuiltinTiles } from '../../src/features/launcher/tiles';
import { hasPaneHome } from '../../src/adapter/ui/render/browse-mode';
import { stubStamps } from '../helpers/store-stamps';
import { stubRevisionOps } from '../helpers/revision-stub';

const tick = (ms = 20): Promise<void> => new Promise((r) => setTimeout(r, ms));

function meta(lid: string, title: string, order = 1): EntryMeta {
  return {
    lid,
    title,
    archetype: 'text',
    createdAt: null,
    updatedAt: null,
    entryOrder: order,
    status: null,
    date: null,
    archived: false,
    bodyChars: null,
  };
}

const A = '序\nりんご\nみかん\nぶどう\n中\n中\n中\n中\n中\n末\n';
const B = '序\nバナナ\nみかん\nぶどう\n中\n中\n中\n中\n中\n末\n追加\n';

interface Opts {
  bodies?: Record<string, string>;
  revs?: Record<string, { id: string; revOrder: number; createdAt: string | null; title: string | null }[]>;
  revBodies?: Record<string, string>;
  file?: string | { tooLarge: true } | null;
  /** 読み込みを手で止める(遅れて届く読み込みを作る)。 */
  hold?: (lid: string) => Promise<void> | null;
}

function setup(opts: Opts = {}) {
  const root = document.createElement('div');
  document.body.append(root);
  const store: Record<string, string> = { n1: A, n2: B, n3: 'まったく別', ...(opts.bodies ?? {}) };
  const persisted: Array<{ lid: string; body: string }> = [];
  const d = new Dispatcher();
  const center = new CenterRouter(root);
  d.onState((s) => center.render(s));
  const effects = connectStoreEffects(d, {
    ...stubRevisionOps(),
    deleteEntry: async () => {},
    setEntryParent: async () => {},
    renameEntry: async () => stubStamps(),
    replaceAssetRefs: () => Promise.reject(new Error('使わない')),
    reorderEntry: async () => stubStamps(),
    persistEntry: async (e: { lid: string; body: string }) => {
      persisted.push(e);
      store[e.lid] = e.body;
      return stubStamps();
    },
    getBody: async (lid: string) => store[lid] ?? null,
  });
  const reads: string[][] = [];
  bindActions(root, d, {
    readBodies: async (lids: readonly string[]) => {
      reads.push([...lids]);
      for (const lid of lids) await opts.hold?.(lid);
      return new Map(lids.filter((l) => store[l] !== undefined).map((l) => [l, store[l]!] as const));
    },
    diffListRevisions: async (lid: string) => opts.revs?.[lid] ?? [],
    diffReadRevision: async (id: string) => opts.revBodies?.[id] ?? null,
    readLinkedFile: async () => (opts.file === undefined ? null : opts.file),
    // 実物と同じ: 飛んでいる書込が着くまで待つ(待たないと、保存の確かめが書込を追い越す)
    settle: () => effects.settled(),
  });
  d.dispatch({
    type: 'SYS_BOOTED',
    cid: 'c1',
    metas: [meta('n1', '左の下書き', 1), meta('n2', '右の下書き', 2), meta('n3', '別のノート', 3)],
    relations: [],
  });
  d.dispatch({ type: 'SET_VIEW_MODE', mode: 'diff' });
  const pane = root.querySelector<HTMLElement>('[data-pkc-view-pane="diff"]')!;
  const q = <T extends HTMLElement>(sel: string): T => pane.querySelector<T>(sel)!;
  const side = (s: 'left' | 'right') => `[data-pkc-field="diff-side"][data-pkc-side="${s}"]`;
  const pick = (s: 'left' | 'right', what: 'kind' | 'note' | 'rev', value: string): void => {
    const el = q<HTMLSelectElement>(`${side(s)} [data-pkc-pick="${what}"]`);
    el.value = value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const summary = (): string => q('[data-pkc-field="diff-summary"]').textContent ?? '';
  const hunks = (): HTMLElement[] => [...pane.querySelectorAll<HTMLElement>('[data-pkc-field="diff-hunk"]')];
  const take = (n: number, from: 'a' | 'b'): void =>
    pane.querySelector<HTMLElement>(`[data-pkc-action="diff-take"][data-pkc-hunk="${n}"][data-pkc-from="${from}"]`)!.click();
  const press = (action: string): void => q(`[data-pkc-action="${action}"]`).click();
  const saveBtn = (): HTMLButtonElement => q('[data-pkc-action="diff-save"]');
  /** 左 n1 / 右 n2 を選んで読み込み終える。 */
  const loadBoth = async (): Promise<void> => {
    pick('left', 'note', 'n1');
    pick('right', 'note', 'n2');
    await tick();
  };
  return { root, d, pane, q, pick, summary, hunks, take, press, saveBtn, loadBoth, store, persisted, reads, side };
}

beforeEach(() => {
  document.body.textContent = '';
});

describe('差分マージの面', () => {
  it('🔴 面として実在し、道具(aside)で、選んだ瞬間に退かず、左に置き場が無く、組み込みタイルが 1 枚ある', () => {
    expect(isViewMode('diff')).toBe(true);
    expect(viewModeLabel('diff')).toBe('差分マージ');
    expect(isAsidePane('diff')).toBe(true);
    expect(leavesOnSelect('diff')).toBe(false);
    expect(hasPaneHome('diff')).toBe(false);
    const tile = withBuiltinTiles([], { office: false }).filter((t) => t.kind === 'diff');
    expect(tile).toHaveLength(1);
    expect(tile[0]!.title).toBe('差分マージ');
    expect(BUILTIN_KINDS.has('diff')).toBe(true);
  });

  it('🔴 相手を選ぶ前は何も出ず、選ぶと塊ごとのちがいが左右に並ぶ(添付・フォルダは選び所に出ない)', async () => {
    const s = setup();
    expect(s.summary()).toContain('相手を選ぶと');
    const options = [...s.pane.querySelectorAll(`${s.side('left')} [data-pkc-pick="note"] option`)].map((o) => o.textContent);
    expect(options).toEqual(['(ノートを選んでください)', '左の下書き', '右の下書き', '別のノート']);
    await s.loadBoth();
    expect(s.summary()).toBe('ちがい 2 か所');
    expect(s.hunks()).toHaveLength(2);
    // 1 つ目の塊: 左に「りんご」、右に「バナナ」。字単位の強調の印が付く
    const first = s.hunks()[0]!;
    expect(first.textContent).toContain('りんご');
    expect(first.textContent).toContain('バナナ');
    expect(first.querySelectorAll('mark[data-pkc-diff-char]').length).toBeGreaterThan(0);
    // 同じ行が長く続く所は畳まれる
    expect(s.pane.textContent).toContain('変わっていない');
  });

  it('🔴 → ← で塊を取り込むと、その塊が消える。元に戻す・やり直す・読み込んだ状態に戻すが効く', async () => {
    const s = setup();
    await s.loadBoth();
    expect(s.saveBtn().disabled, '何も取り込んでいないのに保存が押せる').toBe(true);
    s.take(0, 'b'); // 右の内容を左へ
    expect(s.summary()).toBe('ちがい 1 か所');
    expect(s.hunks()).toHaveLength(1);
    expect(s.saveBtn().disabled).toBe(false);
    s.press('diff-undo');
    expect(s.summary()).toBe('ちがい 2 か所');
    expect(s.saveBtn().disabled).toBe(true);
    s.press('diff-redo');
    expect(s.summary()).toBe('ちがい 1 か所');
    s.take(0, 'a');
    s.press('diff-reset');
    expect(s.summary()).toBe('ちがい 2 か所');
  });

  it('🔴 保存を押すまで何も書かず、押すと書き換えたノートの本文だけが変わる(置き換え前は履歴へ)', async () => {
    const s = setup();
    await s.loadBoth();
    s.take(0, 'b'); // りんご → バナナ(左のノートが変わる)
    s.take(0, 'b'); // 追加行(左へ)。取り込んだ塊は消えるので、残りの番号は詰まる
    await tick();
    expect(s.persisted, '押す前に書いている').toHaveLength(0);
    s.press('diff-save');
    await tick(60);
    expect(s.store.n1).toBe('序\nバナナ\nみかん\nぶどう\n中\n中\n中\n中\n中\n末\n追加\n');
    expect(s.store.n2, '触っていない右が変わっている').toBe(B);
    // 保存できたと言い、画面の下の知らせは「差分マージ」の言葉(ファイルの取り込み直しではない)
    expect(s.summary()).toContain('保存しました');
    expect(s.d.getState().notice ?? '').toContain('差分マージ');
    expect(s.d.getState().notice ?? '').not.toContain('パソコン側のファイル');
    // 保存の後は、保存した状態が「読み込んだ状態」になる(押せなくなる)。左右が同じになった
    expect(s.saveBtn().disabled).toBe(true);
    expect(s.summary()).toContain('左右は同じ内容です');
  });

  it('右のノートへ取り込むと、右のノートが書き換わる(向きを取り違えない)', async () => {
    const s = setup();
    await s.loadBoth();
    s.take(0, 'a'); // 左の内容を右へ
    s.press('diff-save');
    await tick(60);
    expect(s.store.n1, '触っていない左が変わっている').toBe(A);
    expect(s.store.n2).toBe(B.replace('バナナ', 'りんご'));
  });

  it('🔴 残りを全部そろえる → 左右が同じ内容になる', async () => {
    const s = setup();
    await s.loadBoth();
    const allLeft = s.q<HTMLButtonElement>('[data-pkc-field="diff-take-all-left"]');
    allLeft.click();
    expect(s.summary()).toBe('左右は同じ内容です');
    s.press('diff-save');
    await tick(60);
    expect(s.store.n1).toBe(B);
  });

  it('🔴 読み込んだあとにノートが変わっていたら、書かずに理由を言う', async () => {
    const s = setup();
    await s.loadBoth();
    s.take(0, 'b');
    s.store.n1 = '別の窓で書き換えた\n';
    s.press('diff-save');
    await tick(60);
    expect(s.store.n1).toBe('別の窓で書き換えた\n');
    expect(s.persisted).toHaveLength(0);
    expect(s.summary()).toContain('変わりました');
  });

  it('🔴 履歴の版は読むだけ: その側へは取り込めず(ボタンが塞がる)、ノートの側へは取り込める', async () => {
    const s = setup({
      revs: { n1: [{ id: 'r1', revOrder: 1, createdAt: null, title: '昔' }, { id: 'r2', revOrder: 2, createdAt: null, title: '最近' }] },
      revBodies: { r1: '昔の字\n', r2: '最近の字\n' },
    });
    s.pick('left', 'kind', 'rev');
    s.pick('left', 'note', 'n1');
    await tick();
    // 版の一覧は新しい順(最近 → 昔)
    const labels = [...s.pane.querySelectorAll(`${s.side('left')} [data-pkc-pick="rev"] option`)].map((o) => o.textContent);
    expect(labels).toEqual(['(版を選んでください)', '(日時なし)  最近', '(日時なし)  昔']);
    s.pick('left', 'rev', 'r1');
    s.pick('right', 'note', 'n3');
    await tick();
    expect(s.hunks()).toHaveLength(1);
    const toRight = s.pane.querySelector<HTMLButtonElement>('[data-pkc-action="diff-take"][data-pkc-from="a"]')!;
    const toLeft = s.pane.querySelector<HTMLButtonElement>('[data-pkc-action="diff-take"][data-pkc-from="b"]')!;
    expect(toRight.disabled, '版 → ノートへは取り込める').toBe(false);
    expect(toLeft.disabled, 'ノート → 版へは取り込めない').toBe(true);
    expect(toLeft.title).toContain('読むだけ');
    // 塞がっているボタンを(鍵などで)呼んでも書き換わらず、理由が出る
    toLeft.disabled = false;
    toLeft.click();
    expect(s.summary()).toContain('読むだけ');
    expect(s.saveBtn().disabled).toBe(true);
  });

  it('どちらも読むだけの相手のときは、取り込めない理由が一言に出る', async () => {
    const s = setup({
      revs: { n1: [{ id: 'r1', revOrder: 1, createdAt: null, title: null }] },
      revBodies: { r1: '版\n' },
      file: 'ファイル\n',
    });
    s.pick('left', 'kind', 'rev');
    s.pick('left', 'note', 'n1');
    await tick();
    s.pick('left', 'rev', 'r1');
    s.d.dispatch({ type: 'FILE_LINKED', lid: 'n2', name: 'x.md' });
    s.pick('right', 'kind', 'file');
    s.pick('right', 'note', 'n2');
    await tick();
    expect(s.summary()).toContain('どちらも読むだけの相手');
  });

  it('PC のファイル: 結びついたノートだけが選べ、読めない・大きすぎるは理由が出る', async () => {
    const s = setup({ file: null });
    s.d.dispatch({ type: 'FILE_LINKED', lid: 'n2', name: 'メモ.md' });
    s.pick('right', 'kind', 'file');
    const opts = [...s.pane.querySelectorAll(`${s.side('right')} [data-pkc-pick="note"] option`)].map((o) => o.textContent);
    expect(opts).toEqual(['(ノートを選んでください)', '右の下書き(メモ.md)']);
    s.pick('right', 'note', 'n2');
    await tick();
    expect(s.q(`${s.side('right')} [data-pkc-field="diff-side-note"]`).textContent).toContain('ファイルを読めませんでした');
    expect(s.summary()).toContain('読み込めなかった');
  });

  it('PC のファイルが大きすぎるときは、そう言う(「同じ」と言わない)', async () => {
    const s = setup({ file: { tooLarge: true } });
    s.d.dispatch({ type: 'FILE_LINKED', lid: 'n2', name: 'big.md' });
    s.pick('right', 'kind', 'file');
    s.pick('right', 'note', 'n2');
    await tick();
    expect(s.q(`${s.side('right')} [data-pkc-field="diff-side-note"]`).textContent).toContain('大きい');
    expect(s.summary()).not.toContain('同じ内容');
  });

  it('PC のファイルとの比べ: 読めたら、ノートの側へ取り込める', async () => {
    const s = setup({ file: A.replace('りんご', 'ファイルの字') });
    s.d.dispatch({ type: 'FILE_LINKED', lid: 'n2', name: 'a.md' });
    s.pick('left', 'note', 'n1');
    s.pick('right', 'kind', 'file');
    s.pick('right', 'note', 'n2');
    await tick();
    expect(s.hunks()).toHaveLength(1);
    s.take(0, 'b'); // ファイルの内容を左のノートへ
    s.press('diff-save');
    await tick(60);
    expect(s.store.n1).toBe(A.replace('りんご', 'ファイルの字'));
  });

  it('同じノートを左右に選ぶと、取り込めず理由が出る', async () => {
    const s = setup();
    s.pick('left', 'note', 'n1');
    s.pick('right', 'note', 'n1');
    await tick();
    expect(s.summary()).toContain('左右は同じ内容です');
    // 同じ内容なので塊は無い ── 別々の字を持つ同じ lid を作る(版 vs ノート)ではなく、判定そのものを直に見る
    s.store.n1 = A;
    s.pick('right', 'note', 'n2');
    await tick();
    s.pick('right', 'note', 'n1');
    await tick();
    expect(s.hunks()).toHaveLength(0);
  });

  it('🔴 選び直しの前の遅い読み込みは、いまの選びを上書きしない', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const s = setup({ hold: (lid) => (lid === 'n3' ? gate : null) });
    s.pick('left', 'note', 'n3'); // 遅い
    s.pick('left', 'note', 'n1'); // すぐ読める
    s.pick('right', 'note', 'n2');
    await tick();
    expect(s.summary()).toBe('ちがい 2 か所');
    release();
    await tick();
    // 遅れて n3 が届いても、左は n1 のまま
    expect(s.summary()).toBe('ちがい 2 か所');
    expect(s.q<HTMLSelectElement>(`${s.side('left')} [data-pkc-pick="note"]`).value).toBe('n1');
  });

  it('読めなかった相手は、その側の一言に理由が出る(黙って空にしない)', async () => {
    const s = setup();
    delete s.store.n1;
    s.pick('left', 'note', 'n1');
    await tick();
    expect(s.q(`${s.side('left')} [data-pkc-field="diff-side-note"]`).textContent).toContain('読めませんでした');
    expect(s.summary()).toContain('読み込めなかった');
  });

  it('「開いているノート」で、いま開いているノートを相手にできる(開いていなければ押せない)', async () => {
    const s = setup();
    expect(s.q<HTMLButtonElement>(`${s.side('left')} [data-pkc-field="diff-use-open"]`).disabled).toBe(true);
    s.d.dispatch({ type: 'SELECT_ENTRY', lid: 'n2' });
    await tick();
    const b = s.q<HTMLButtonElement>(`${s.side('left')} [data-pkc-field="diff-use-open"]`);
    expect(b.disabled).toBe(false);
    b.click();
    await tick();
    expect(s.q<HTMLSelectElement>(`${s.side('left')} [data-pkc-pick="note"]`).value).toBe('n2');
    expect(s.q(`${s.side('left')} [data-pkc-field="diff-side-note"]`).textContent).toContain('書き換えられる側');
  });

  it('選び所を開いただけ(同じ値の click)では、読み込み済みの相手を捨てない', async () => {
    const s = setup();
    await s.loadBoth();
    const before = s.reads.length;
    s.q(`${s.side('left')} [data-pkc-pick="note"]`).click();
    s.q(`${s.side('left')} [data-pkc-pick="kind"]`).click();
    await tick();
    expect(s.reads.length, '開いただけで読み直している').toBe(before);
    expect(s.summary()).toBe('ちがい 2 か所');
  });

  it('編集中は保存できず、理由が出る(何も書かない)', async () => {
    const s = setup();
    await s.loadBoth();
    s.take(0, 'b');
    s.d.dispatch({ type: 'SELECT_ENTRY', lid: 'n3' });
    await tick();
    s.d.dispatch({ type: 'START_EDIT' });
    s.press('diff-save');
    await tick(60);
    expect(s.persisted).toHaveLength(0);
    expect(s.summary()).not.toContain('保存しました');
  });
});
