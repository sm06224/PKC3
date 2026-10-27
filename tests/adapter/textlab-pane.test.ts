/** @vitest-environment happy-dom */
/**
 * 🔴 **テキスト整形の面**(#1233。user 指示 2026-10-26「全部やるのです」)。
 *
 * 見るのは user が見て押せるもの:
 * ①貼る → 整え方を押す → 右に結果が出る(打つそばから)②押された整え方は `aria-pressed` で見分けられ、表の 4 択は 1 つだけ
 * ③🔴 新しいノートにする / ノートの本文を置き換える は**保存された本文**で見る(画面だけ動く緑を通さない)
 * ④読み込んだ後にノートが変わっていたら置き換えない ⑤編集中は書かない ⑥タイルがあり、別窓で開く面の名前を持つ
 */
import { describe, expect, it, vi } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import { CenterRouter } from '../../src/adapter/ui/render/center';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { isAsidePane, isViewMode, leavesOnSelect, viewModeLabel } from '../../src/adapter/state/app-state';
import { withBuiltinTiles, BUILTIN_KINDS } from '../../src/features/launcher/tiles';
import { hasPaneHome } from '../../src/adapter/ui/render/browse-mode';
import { LAB_OPS } from '../../src/features/markdown/text-lab';
import { bindLabClient, labLoaded, refreshTextLab, LAB_TYPING_DEBOUNCE_MS } from '../../src/adapter/ui/render/textlab';
import { LAB_REGEX_TIMEOUT_NOTE, type LabRegexClient } from '../../src/adapter/platform/text/lab-client';
import type { LabRegex, LabRegexResult } from '../../src/features/markdown/lab-regex';
import { stubStamps } from '../helpers/store-stamps';
import { stubRevisionOps } from '../helpers/revision-stub';

const tick = (ms = 20): Promise<void> => new Promise((r) => setTimeout(r, ms));

function meta(lid: string, title: string): EntryMeta {
  return {
    lid,
    title,
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

function setup(bodies: Record<string, string> = { e1: '- 一\n- 二' }) {
  const root = document.createElement('div');
  document.body.append(root);
  const d = new Dispatcher();
  const center = new CenterRouter(root);
  d.onState((s) => center.render(s));
  const store: Record<string, string> = { ...bodies };
  const persisted: Array<{ lid: string; title: string; body: string }> = [];
  connectStoreEffects(d, {
    ...stubRevisionOps(),
    deleteEntry: async () => {},
    setEntryParent: async () => {},
    renameEntry: async () => stubStamps(),
    replaceAssetRefs: () => Promise.reject(new Error('使わない')),
    reorderEntry: async () => stubStamps(),
    persistEntry: async (e: { lid: string; title: string; body: string }) => {
      persisted.push(e);
      store[e.lid] = e.body;
      return stubStamps();
    },
    getBody: async (lid: string) => store[lid] ?? null,
  });
  bindActions(root, d);
  d.dispatch({
    type: 'SYS_BOOTED',
    cid: 'c1',
    metas: Object.keys(bodies).map((l) => meta(l, `題名-${l}`)),
    relations: [],
  });
  d.dispatch({ type: 'SET_VIEW_MODE', mode: 'textlab' });
  const pane = root.querySelector<HTMLElement>('[data-pkc-view-pane="textlab"]')!;
  const q = <T extends HTMLElement>(sel: string): T => pane.querySelector<T>(sel)!;
  const type = (field: string, value: string): void => {
    const el = q<HTMLInputElement | HTMLTextAreaElement>(`[data-pkc-field="${field}"]`);
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const press = (sel: string): void => q(sel).click();
  const out = (): string => q<HTMLTextAreaElement>('[data-pkc-field="textlab-output"]').value;
  const summary = (): string => q('[data-pkc-field="textlab-summary"]').textContent ?? '';
  return { root, d, pane, q, type, press, out, summary, persisted, store };
}

describe('テキスト整形の面', () => {
  it('🔴 面として実在し、道具(aside)で、塞がれたときの退避先は左に無い(本文を奪わない)', () => {
    expect(isViewMode('textlab')).toBe(true);
    expect(viewModeLabel('textlab')).toBe('テキスト整形');
    expect(isAsidePane('textlab')).toBe(true);
    // 読み込む前に、ノートを選んだ瞬間に面が退かない
    expect(leavesOnSelect('textlab')).toBe(false);
    expect(hasPaneHome('textlab')).toBe(false);
    const { pane } = setup();
    expect(pane.hidden).toBe(false);
  });

  it('🔴 組み込みタイルが 1 枚あり、別窓で開く種別(ViewMode と同じ綴り)として登録されている', () => {
    const tile = withBuiltinTiles([], { office: false }).filter((t) => t.kind === 'textlab');
    expect(tile).toHaveLength(1);
    expect(tile[0]!.title).toBe('テキスト整形');
    expect(BUILTIN_KINDS.has('textlab')).toBe(true);
    expect(isViewMode(tile[0]!.kind)).toBe(true);
  });

  it('🔴 貼ると右に結果が出る(整え方を選ぶ前は同じ字・選ぶと変わる)', () => {
    const s = setup();
    expect(s.summary()).toContain('貼ると');
    s.type('textlab-input', '- a\n- b');
    expect(s.out()).toBe('- a\n- b');
    s.press('[data-pkc-lab-op="strip-bullets"]');
    expect(s.out()).toBe('a\nb');
    // もう一度押すと外れる(片道にしない)
    s.press('[data-pkc-lab-op="strip-bullets"]');
    expect(s.out()).toBe('- a\n- b');
  });

  it('🔴 押した整え方は aria-pressed で見分けられ、表の 4 択は 1 つだけが押された状態になる', () => {
    const s = setup();
    const op = s.q('[data-pkc-lab-op="join-lines"]');
    expect(op.getAttribute('aria-pressed')).toBe('false');
    op.click();
    expect(op.getAttribute('aria-pressed')).toBe('true');
    const tables = [...s.pane.querySelectorAll('[data-pkc-lab-table]')];
    expect(tables).toHaveLength(4);
    expect(s.q('[data-pkc-lab-table="none"]').getAttribute('aria-pressed')).toBe('true');
    // 改行詰めは押したままだと表の行も結ぶので、外してから表を見る(外せること自体も確かめる)
    op.click();
    expect(op.getAttribute('aria-pressed')).toBe('false');
    s.press('[data-pkc-lab-table="to-markdown"]');
    expect(tables.filter((b) => b.getAttribute('aria-pressed') === 'true')).toHaveLength(1);
    s.type('textlab-input', 'a,b\n1,2');
    expect(s.out()).toBe('| a | b |\n| --- | --- |\n| 1 | 2 |');
    // 整え方の全数が画面にある
    expect(s.pane.querySelectorAll('[data-pkc-lab-op]')).toHaveLength(LAB_OPS.length);
  });

  it('🔴 正規表現の置換が打つそばから効き(少し待って)、読めない式は理由を出して入力を返す', async () => {
    const s = setup();
    s.type('textlab-input', 'abc 123');
    s.type('textlab-pattern', '\\d+');
    s.type('textlab-replacement', '#');
    // 置換はワーカーで走り、打鍵は少し待つ(`LAB_TYPING_DEBOUNCE_MS`)── 待つ間は古い結果を出さない
    expect(s.summary()).toContain('置換を計算しています');
    await tick(320);
    expect(s.out()).toBe('abc #');
    expect(s.summary()).toContain('置換: 1 か所');
    s.type('textlab-pattern', '(');
    await tick(320);
    expect(s.out()).toBe('abc 123');
    expect(s.summary()).toContain('正規表現として読めません');
  });

  it('消すと左の欄が空になり、結果も空になる。コピー・新しいノートは空では押せない', () => {
    const s = setup();
    expect(s.q<HTMLButtonElement>('[data-pkc-field="textlab-copy"]').disabled).toBe(true);
    s.type('textlab-input', 'x');
    expect(s.q<HTMLButtonElement>('[data-pkc-field="textlab-to-note"]').disabled).toBe(false);
    s.press('[data-pkc-action="textlab-clear"]');
    expect(s.out()).toBe('');
    expect(s.q<HTMLButtonElement>('[data-pkc-field="textlab-to-note"]').disabled).toBe(true);
  });

  it('🔴 新しいノートにすると、結果が本文として保存される(観測点は保存された本文)', async () => {
    const s = setup();
    s.type('textlab-input', '- 買う\n- 売る');
    s.press('[data-pkc-lab-op="strip-bullets"]');
    s.press('[data-pkc-action="textlab-to-note"]');
    await tick();
    const made = s.persisted.find((p) => p.lid !== 'e1');
    expect(made?.body).toBe('買う\n売る');
    expect(made?.title).toBe('買う');
    expect(s.summary()).toContain('新しいノート「買う」を作りました');
  });

  it('🔴 読み込んで置き換えると、そのノートの本文が結果になる(保存された本文で見る)', async () => {
    const s = setup();
    s.d.dispatch({ type: 'SELECT_ENTRY', lid: 'e1' });
    await tick();
    // 読み込む前は置き換えられない
    expect(s.q<HTMLButtonElement>('[data-pkc-action="textlab-apply-note"]').disabled).toBe(true);
    s.press('[data-pkc-action="textlab-load-note"]');
    expect(s.q<HTMLTextAreaElement>('[data-pkc-field="textlab-input"]').value).toBe('- 一\n- 二');
    s.press('[data-pkc-lab-op="strip-bullets"]');
    expect(s.q<HTMLButtonElement>('[data-pkc-action="textlab-apply-note"]').disabled).toBe(false);
    s.press('[data-pkc-action="textlab-apply-note"]');
    await tick();
    expect(s.store.e1).toBe('一\n二');
    expect(s.summary()).toContain('置き換えました');
    // 🔴 画面の下の知らせ: 題名が入り、置き換え前の `{title}` が残らない(テストの穴 B)
    const notice = s.d.getState().notice ?? '';
    expect(notice).toContain('「題名-e1」');
    expect(notice).toContain('テキスト整形の結果で置き換えました');
    expect(notice, '{title} が置き換わらずに残っている').not.toContain('{');
    // 置き換えた後は、同じ結果でもう一度置き換えられない
    expect(s.q<HTMLButtonElement>('[data-pkc-action="textlab-apply-note"]').disabled).toBe(true);
  });

  it('🔴 読み込んだ後にノートが変わっていたら、置き換えずに理由を言う', async () => {
    const s = setup();
    s.d.dispatch({ type: 'SELECT_ENTRY', lid: 'e1' });
    await tick();
    s.press('[data-pkc-action="textlab-load-note"]');
    s.press('[data-pkc-lab-op="strip-bullets"]');
    // 別の窓での書込を模す: 開いている本文だけが変わる
    s.d.dispatch({ type: 'SELECT_ENTRY', lid: 'e1' });
    const st = s.d.getState();
    (st.openBody as { body: string }).body = '別の字';
    s.press('[data-pkc-action="textlab-apply-note"]');
    await tick();
    expect(s.store.e1).toBe('- 一\n- 二');
    expect(s.summary()).toContain('ノートが変わりました');
  });

  it('🔴 ノートを開いていないとき、読み込みは押せず、理由が title に出る', () => {
    const s = setup();
    const load = s.q<HTMLButtonElement>('[data-pkc-action="textlab-load-note"]');
    expect(load.disabled).toBe(true);
    expect(load.title).toContain('ノートを開いてください');
  });

  /**
   * 🔴 **置換はワーカーで走る(非同期)── 古い応答が新しい結果を上書きしない / 待つ間は古い結果を出さない / 止めたと言う**
   * (レビュー ⚠1)。偽の置換口(`LabRegexClient`)を差して、返すタイミングを手で決める。
   */
  function fakeClient() {
    const calls: Array<{ text: string; regex: LabRegex; done: (r: LabRegexResult) => void }> = [];
    const client = {
      apply: (text: string, regex: LabRegex) =>
        new Promise<LabRegexResult>((resolve) => {
          calls.push({ text, regex, done: resolve });
        }),
    } as unknown as LabRegexClient;
    return { client, calls };
  }

  it('🔴 古い置換の返事が後から着いても、新しい結果を上書きしない', async () => {
    const s = setup();
    const f = fakeClient();
    bindLabClient(s.pane, f.client);
    s.q<HTMLTextAreaElement>('[data-pkc-field="textlab-input"]').value = '甲';
    s.q<HTMLInputElement>('[data-pkc-field="textlab-pattern"]').value = '甲';
    s.q<HTMLInputElement>('[data-pkc-field="textlab-replacement"]').value = '1';
    const first = refreshTextLab(s.pane);
    s.q<HTMLInputElement>('[data-pkc-field="textlab-replacement"]').value = '2';
    const second = refreshTextLab(s.pane);
    expect(f.calls).toHaveLength(2);
    // 新しいほうが先に返り、古いほうが後から返る
    f.calls[1]!.done({ text: '2', note: null, hits: 1 });
    await second;
    expect(s.out()).toBe('2');
    f.calls[0]!.done({ text: '1', note: null, hits: 1 });
    await first;
    expect(s.out(), '古い返事が新しい結果を上書きした').toBe('2');
  });

  it('🔴 置換の返事を待つ間は、結果を使うボタンを止め、押しても古い結果を出さない', async () => {
    const s = setup();
    const f = fakeClient();
    bindLabClient(s.pane, f.client);
    s.type('textlab-input', '甲');
    // 置換を入れる(打鍵は少し待つ)── まだワーカーへ投げていない間も、古い結果を出さない
    s.q<HTMLInputElement>('[data-pkc-field="textlab-pattern"]').value = '甲';
    const p = refreshTextLab(s.pane);
    expect(s.q<HTMLButtonElement>('[data-pkc-field="textlab-copy"]').disabled).toBe(true);
    expect(s.q<HTMLButtonElement>('[data-pkc-field="textlab-to-note"]').disabled).toBe(true);
    expect(s.summary()).toContain('置換を計算しています');
    s.press('[data-pkc-action="textlab-to-note"]');
    await tick();
    expect(s.persisted.find((e) => e.lid !== 'e1'), '計算中に古い結果でノートを作った').toBeUndefined();
    f.calls[0]!.done({ text: '乙', note: null, hits: 1 });
    await p;
    expect(s.q<HTMLButtonElement>('[data-pkc-field="textlab-to-note"]').disabled).toBe(false);
    expect(s.out()).toBe('乙');
  });

  it('🔴 時間切れで止めたときは、入力のままの結果と「重すぎるので止めました」を出す', async () => {
    const s = setup();
    const f = fakeClient();
    bindLabClient(s.pane, f.client);
    s.type('textlab-input', 'aaaaaaaaaaaaaaaaaaaaaaaaaaab');
    s.q<HTMLInputElement>('[data-pkc-field="textlab-pattern"]').value = '(a+)+$';
    const p = refreshTextLab(s.pane);
    f.calls[0]!.done({ text: 'aaaaaaaaaaaaaaaaaaaaaaaaaaab', note: LAB_REGEX_TIMEOUT_NOTE, hits: 0 });
    await p;
    expect(s.summary()).toContain('この置換は重すぎるので止めました');
    expect(s.out()).toBe('aaaaaaaaaaaaaaaaaaaaaaaaaaab');
  });

  it('🔴 打鍵はまとめて 1 回だけワーカーへ投げる(1 字ごとに投げない)', async () => {
    const s = setup();
    const f = fakeClient();
    bindLabClient(s.pane, f.client);
    s.type('textlab-input', 'abc');
    s.type('textlab-pattern', 'a');
    s.type('textlab-pattern', 'ab');
    s.type('textlab-pattern', 'abc');
    expect(f.calls, '打つたびに投げている').toHaveLength(0);
    await tick(LAB_TYPING_DEBOUNCE_MS + 60);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.regex.pattern).toBe('abc');
  });

  it('⚠ 対照群 ── 置換が無い整えは、ワーカーを使わずその場で結果が出る', () => {
    const s = setup();
    const f = fakeClient();
    const spy = vi.spyOn(f.client, 'apply');
    bindLabClient(s.pane, f.client);
    s.type('textlab-input', '- a');
    s.press('[data-pkc-lab-op="strip-bullets"]');
    expect(s.out()).toBe('a');
    expect(spy).not.toHaveBeenCalled();
  });

  /**
   * 🔴 **面を離れたら、読み込んだノートの控えを捨てる**(レビュー ⚠9)。
   * ⚠ 捨てないと、戻ったとき「読み込んだ時点の本文」と開いている本文を突き合わせる門が、古い控えで通る。
   */
  it('🔴 別の画面へ移って戻ると、読み込んだノートの控えは無く、置き換えは押せない。打った文章は残る', async () => {
    const s = setup();
    s.d.dispatch({ type: 'SELECT_ENTRY', lid: 'e1' });
    await tick();
    s.press('[data-pkc-action="textlab-load-note"]');
    expect(labLoaded(s.pane)?.lid).toBe('e1');
    s.d.dispatch({ type: 'SET_VIEW_MODE', mode: 'detail' });
    expect(labLoaded(s.pane), '面を離れても控えが残っている').toBeNull();
    s.d.dispatch({ type: 'SET_VIEW_MODE', mode: 'textlab' });
    expect(s.q<HTMLButtonElement>('[data-pkc-action="textlab-apply-note"]').disabled).toBe(true);
    expect(s.q<HTMLTextAreaElement>('[data-pkc-field="textlab-input"]').value, '打った文章まで消えている').toBe('- 一\n- 二');
  });
});
