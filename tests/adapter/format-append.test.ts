/** @vitest-environment happy-dom */
/**
 * P8 段⑥ の end-to-end: **書式パネル**。
 *
 * > user 指摘 2026-08-03「**書式設定系のパネルも必要 / 何もかも足りない /
 * > ログの追記機構とテキストエントリの追記機構も無い**」
 *
 * 🔴 規則そのもの(`applyFormat`)は `tests/features/text-ops.test.ts`
 * が見ている。**ここが見るのは繋がり**である ── 押した所から textarea を見つけ、
 * 書き戻し、state と画面(プレビュー)が追いつくか。
 *
 * ⚠ 観測点を textarea の `value` だけにしない ── それだと「書き戻したが state に
 * 届いていない」実装が緑で通り、**保存すると書式が消える**。
 */
import { readFileSync } from 'node:fs';
import { stubStamps } from '../helpers/store-stamps';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import type { EntryUpsert } from '../../src/adapter/platform/storage/schema';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { DetailRenderer } from '../../src/adapter/ui/render/detail';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import {
  BAR_FORMAT_OPS,
  DIAGRAM_CHOICES,
  DIAGRAM_TEMPLATES,
  FORMAT_OPS,
  MERMAID_BLOCK,
  applyFormat,
  insertBlock,
} from '../../src/features/markdown/text-ops';
import { BUILTIN_SNIPPET_OPS } from '../../src/features/snippet/snippet-menu';
import { stubRevisionOps } from '../helpers/revision-stub';
import { resetAppDialogForTest } from '../../src/adapter/ui/render/app-dialog';
import { answerDialog, openDialog } from './dialog-helper';
import { DATE_SHORTCUTS, shortcutDate } from '../../src/features/schedule/date-shortcuts';
import { readLineDate } from '../../src/features/schedule/line-date';

function meta(lid: string, archetype = 'text'): EntryMeta {
  return {
    lid,
    title: 't-' + lid,
    archetype,
    createdAt: null,
    updatedAt: null,
    entryOrder: 1,
    status: null,
    date: null,
    archived: false,
    bodyChars: null,
  };
}

async function tick(ms = 10): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

function setup(metas: EntryMeta[], bodies: Record<string, string>) {
  const root = document.createElement('div');
  document.body.append(root);
  const d = new Dispatcher();
  const regions = buildShell(root);
  // ⚠ onBodyChange は main.ts と同じ配線(live の確定を state へ写す)
  const detail = new DetailRenderer(regions.detail, null, undefined, (body) =>
    d.dispatch({ type: 'UPDATE_OPEN_BODY', body }),
  );
  d.onState((s) => detail.render(s));
  bindActions(root, d);
  const persisted: EntryUpsert[] = [];
  connectStoreEffects(d, {
    ...stubRevisionOps(),
    getBody: async (lid) => bodies[lid] ?? null,
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
    persistEntry: async (e) => {
      persisted.push(e);
      return stubStamps();
    },
  });
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas, relations: [] });
  const q = <T extends HTMLElement>(s: string) => root.querySelector<T>(s);
  return { root, d, persisted, q };
}

/** 選択して書式ボタンを押す(実 UI と同じ順序 ── 選択は押す前に決まっている)。 */
function press(
  q: <T extends HTMLElement>(s: string) => T | null,
  op: string,
  range?: [number, number],
): HTMLTextAreaElement {
  const ta = q<HTMLTextAreaElement>('[data-pkc-field="editor-body"]')!;
  if (range) ta.setSelectionRange(range[0], range[1]);
  q(`[data-pkc-format="${op}"]`)!.click();
  return ta;
}

describe('書式パネル(P8 段⑥)', () => {
  // 2026-08-14(#104 第 2 弾): 既定は live ── この describe は split の面
  // (editor-body)で測るので、設定で split を明示する
  beforeEach(() => {
    localStorage.setItem('pkc3.editor-mode', 'split');
  });

  it('🔴 押すと本文・state・プレビューが**そろって**変わる', async () => {
    const { d, q } = setup([meta('a')], { a: '強調したい' });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    await tick();
    q('[data-pkc-action="start-edit"]')!.click();

    const ta = press(q, 'bold', [0, 2]);
    // ① 本文
    expect(ta.value).toBe('**強調**したい');
    // ② 🔴 state ── ここが繋がっていないと**保存した瞬間に書式が消える**
    expect(d.getState().openBody?.body).toBe('**強調**したい');
    // ③ 選択は中身のまま(続けて斜体を押せる)
    expect([ta.selectionStart, ta.selectionEnd]).toEqual([2, 4]);
    // ④ プレビュー(rAF 1 枚ぶん待つ)
    await tick(30);
    expect(q('[data-pkc-region="editor-preview"]')!.querySelector('strong')?.textContent).toBe(
      '強調',
    );
  });

  it('🔴 パネルのボタンは**表と 1 対 1**(押しても何も起きないボタンが無い)', async () => {
    const { d, q, root } = setup([meta('a')], { a: 'あいう' });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    await tick();
    q('[data-pkc-action="start-edit"]')!.click();
    const buttons = [...root.querySelectorAll('[data-pkc-action="format-text"]')];
    /**
     * ⚠ **帯に出す表**と突き合わせる(#425 段②-a で `onBar: false` を足した)──
     *   ハイライト / ルビ / 圏点 / 打ち消しは**帯に出さない**(既に横に長い)。
     * 🔑 出さない 4 つが**どこからも引けない**まま増えないことは、
     *   下の「鍵から必ず引ける」が守る。
     */
    expect(buttons.map((b) => b.getAttribute('data-pkc-format'))).toEqual(
      BAR_FORMAT_OPS.map((o) => o.op),
    );
    expect(buttons.map((b) => b.querySelector('[data-pkc-field="label"]')?.textContent)).toEqual(
      BAR_FORMAT_OPS.map((o) => o.label),
    );
  });

  /**
   * 🔴 **帯に出さない記法は、鍵から必ず引ける**(#425 段②-a)。
   *
   * ⚠ これが無いと、`onBar: false` を付けるだけで
   *   **どこからも押せない記法**が静かに増える(「書けるのに入れる口が無い」を
   *   直すために足した仕掛けが、同じ穴を作る側に回る)。
   * 🔑 だから **`FORMAT_OPS` の全数**を、帯か `FORMAT_OF`(鍵)のどちらかで
   *   受けていることを見る。
   */
  it('🔴 帯に出さない記法は、鍵から引ける(届かない記法を作らない)', () => {
    const onBar = new Set(BAR_FORMAT_OPS.map((o) => o.op));
    const byKey = new Set(
      [...readFileSync('src/adapter/ui/actions/binder.ts', 'utf-8').matchAll(
        /'(format-[a-z]+)': '([a-z]+)',/g,
      )].map((m) => m[2]!),
    );
    expect(byKey.size, '鍵の表を読めていない(空振り)').toBeGreaterThan(2);
    /**
     * ⚠ 2026-09-04(#528 案 B): **図**(`mermaid`)は帯から外れた ── 帯の「図」は
     *   `format-text` ではなく一覧を開く。`applyFormat('mermaid')` へ届く口は
     *   **雛形の一覧の組み込み**(`BUILTIN_SNIPPET_OPS`)である。⚠ 3 つ目の集合として
     *   数える ── ここに無ければ「表に在るのに誰も呼ばない op」になる。
     */
    const bySnippet = new Set<string>(BUILTIN_SNIPPET_OPS);
    expect(bySnippet.has('mermaid'), '雛形の一覧から「図」が消えた(前提が崩れている)').toBe(true);
    const unreachable = FORMAT_OPS.map((o) => o.op).filter(
      (op) => !onBar.has(op) && !byKey.has(op) && !bySnippet.has(op),
    );
    expect(unreachable, 'どこからも押せない記法が在る').toEqual([]);
  });

  it('🔴 押しても編集欄から focus を奪わない', async () => {
    const { d, q } = setup([meta('a')], { a: 'あ' });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    await tick();
    q('[data-pkc-action="start-edit"]')!.click();
    const ev = new Event('mousedown', { bubbles: true, cancelable: true });
    q('[data-pkc-format="bold"]')!.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
  });

  it('近道キー(Ctrl+B)がボタンと同じ結果になる', async () => {
    const { d, q } = setup([meta('a')], { a: '強調' });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    await tick();
    q('[data-pkc-action="start-edit"]')!.click();
    const ta = q<HTMLTextAreaElement>('[data-pkc-field="editor-body"]')!;
    ta.setSelectionRange(0, 2);
    ta.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, bubbles: true, cancelable: true }),
    );
    expect(ta.value).toBe('**強調**');
    expect(d.getState().openBody?.body).toBe('**強調**');
  });

  it('⚠ 変換中(IME)のキーは書式にしない', async () => {
    const { d, q } = setup([meta('a')], { a: '強調' });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    await tick();
    q('[data-pkc-action="start-edit"]')!.click();
    const ta = q<HTMLTextAreaElement>('[data-pkc-field="editor-body"]')!;
    ta.setSelectionRange(0, 2);
    ta.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'b',
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
        isComposing: true,
      }),
    );
    expect(ta.value).toBe('強調');
  });

  it('閲覧中は書式パネルを出さない(押す先が無い)', async () => {
    const { d, q } = setup([meta('a')], { a: 'あ' });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    await tick();
    expect(q('[data-pkc-region="format-bar"]')).toBeNull();
  });
});

/**
 * 🔴 **「図」を押すと 5 種から選べる**(#528 案 B。user 裁定 2026-09-04)。
 *
 * ⚠ 直す前は「図」= `format-text`(`op: 'mermaid'`)で、**必ず `graph TD` の 2 行**が
 *   入った ── UML の雛形(`DIAGRAM_TEMPLATES`)は在るのに、「図」から辿れなかった。
 * 🔴 見るのは繋がりである ── 押した所から一覧が開き、選んだ雛形が **caret の位置**に
 *   入り、state まで届くか。何が並ぶか(表)は `tests/features/text-ops.test.ts`。
 * ⚠ 観測点を textarea の `value` だけにしない ── state に届いていないと
 *   **保存した瞬間に消える**(書式パネルと同じ罠)。
 */
describe('「図」を押すと 5 種から選ぶ(#528 案 B)', () => {
  beforeEach(() => {
    localStorage.setItem('pkc3.editor-mode', 'split');
  });
  afterEach(() => {
    resetAppDialogForTest();
  });

  const rows = (): HTMLButtonElement[] => [
    ...(openDialog()?.querySelectorAll<HTMLButtonElement>('[data-pkc-field="pick-diagram"]') ?? []),
  ];

  /** 編集に入って本文と caret を作り、帯の「図」を押して一覧を開く。 */
  async function openPicker(body = '', caret = body.length) {
    const s = setup([meta('a')], { a: body });
    s.d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    await tick();
    s.q('[data-pkc-action="start-edit"]')!.click();
    await tick();
    const ta = s.q<HTMLTextAreaElement>('[data-pkc-field="editor-body"]')!;
    ta.setSelectionRange(caret, caret);
    s.q('[data-pkc-action="insert-diagram"]')!.click();
    await tick();
    return { ...s, ta };
  }

  /**
   * 🔴 **帯の「図」は表の直後に居て、`format-text` ではない。**
   * ⚠ 位置ごと pin する ── 末尾へ足す実装だと、表とコードブロックの間に在った
   *   ボタンが右へ飛ぶ(「同じものが常に同じ場所にある」)。
   */
  it('🔴 帯の「図」は表の隣に在り、一覧を開くボタンになっている', async () => {
    const { d, q, root } = setup([meta('a')], { a: 'x' });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    await tick();
    q('[data-pkc-action="start-edit"]')!.click();
    const buttons = [...root.querySelectorAll('[data-pkc-region="format-bar"] button')];
    const labels = buttons.map((b) => b.querySelector('[data-pkc-field="label"]')?.textContent);
    const at = labels.indexOf('図');
    expect(at, '帯に「図」が無い').toBeGreaterThan(0);
    expect(labels[at - 1], '「図」が表の隣に居ない').toBe('表');
    expect(buttons[at]!.getAttribute('data-pkc-action')).toBe('insert-diagram');
    expect(buttons[at]!.hasAttribute('data-pkc-format'), 'まだ format-text の口が残っている').toBe(false);
    // ⚠ 対照群 ── `format-text` の側には `mermaid` のボタンが**居ない**
    expect(root.querySelector('[data-pkc-format="mermaid"]')).toBeNull();
  });

  it('🔴 押しても編集欄から focus を奪わない(live の 1 面で無言 no-op にならない)', async () => {
    const { d, q } = setup([meta('a')], { a: 'あ' });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    await tick();
    q('[data-pkc-action="start-edit"]')!.click();
    const ev = new Event('mousedown', { bubbles: true, cancelable: true });
    q('[data-pkc-action="insert-diagram"]')!.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
  });

  it('🔴 押すと 5 種の一覧が出て、並びは表のとおり(先頭はフローチャート)', async () => {
    await openPicker();
    expect(openDialog(), '図の一覧が開いていない').not.toBeNull();
    const labels = rows().map((b) => b.textContent);
    // ⚠ 数を名指しで pin する ── 表と同じ物を写しただけでは、表が縮んでも通る
    expect(labels).toHaveLength(5);
    expect(labels).toEqual(DIAGRAM_CHOICES.map((d) => d.label));
    expect(labels[0]).toBe('フローチャート');
    expect(labels, 'UML の 4 種が並んでいない').toEqual(
      expect.arrayContaining(DIAGRAM_TEMPLATES.map((d) => d.label)),
    );
    // 🔑 焦点は先頭の行(鍵だけの人が、開いた直後に何もできないのを防ぐ)
    expect(document.activeElement).toBe(rows()[0]);
  });

  /**
   * 🔴 **対照群:フローチャートを選ぶと、今までの「図」と 1 バイト違わない。**
   * ⚠ `applyFormat(sel, 'mermaid')` が直す前の「図」そのものである ── これと
   *   等しくなければ、既存の user の手触りを変えている。
   */
  it('🔴 フローチャートを選ぶと、これまでの「図」と同じ 2 行が入る', async () => {
    const { d, ta } = await openPicker('まえ\n', 3);
    const before = applyFormat({ text: 'まえ\n', start: 3, end: 3 }, 'mermaid');
    rows()[0]!.click();
    await tick();
    expect(ta.value).toBe(before.text);
    expect(ta.value).toBe('まえ\n```mermaid\ngraph TD\n  A-->B\n```\n');
    expect(d.getState().openBody?.body, 'state に届いていない(保存すると消える)').toBe(before.text);
  });

  it('🔴 クラス図を選ぶと、その雛形が caret の位置に入り、state もそろって変わる', async () => {
    const { d, ta } = await openPicker('まえ\nうしろ', 3);
    const cls = DIAGRAM_TEMPLATES.find((t) => t.id === 'class')!;
    const want = insertBlock({ text: 'まえ\nうしろ', start: 3, end: 3 }, cls.block);
    rows().find((b) => b.textContent === 'クラス図')!.click();
    await tick();
    expect(ta.value).toBe(want.text);
    // ⚠ 0 行目は「まえ」、1 行目は fence の開き ── 種類の名前は 2 行目
    expect(ta.value.split('\n')[2], 'クラス図の 1 行目が入っていない').toBe('classDiagram');
    expect(ta.value.startsWith('まえ\n'), '先頭に入った(caret を控えていない)').toBe(true);
    expect(d.getState().openBody?.body).toBe(want.text);
    // ⚠ 対照群 ── フローチャートとは別の物が入った(同じ物なら一覧の意味が無い)
    expect(ta.value).not.toBe(MERMAID_BLOCK.text);
  });

  it('🔴 それぞれの行が、表のその雛形を入れる(5 行とも別の物)', async () => {
    const seen: string[] = [];
    for (const [i, choice] of DIAGRAM_CHOICES.entries()) {
      const { ta } = await openPicker();
      rows()[i]!.click();
      await tick();
      expect(ta.value, `${choice.label} の雛形が入っていない`).toBe(choice.block.text);
      seen.push(ta.value);
      resetAppDialogForTest();
      document.body.textContent = '';
    }
    expect(new Set(seen).size, '同じ雛形を入れる行が 2 つある').toBe(DIAGRAM_CHOICES.length);
  });

  it('🔴 Esc(やめる)なら何も入らず、state も動かない', async () => {
    const { d, ta } = await openPicker('もと');
    const state = d.getState().openBody?.body;
    await answerDialog('cancel');
    await tick();
    expect(ta.value).toBe('もと');
    expect(d.getState().openBody?.body).toBe(state);
    expect(openDialog(), '一覧が閉じていない').toBeNull();
  });

  /**
   * 🔴 **外(暗い地)を押したら閉じて、何も入らない**(#528 案 B の裁定の字)。
   * ⚠ 暗い地を押すと `click` の `target` は `<dialog>` 自身になる ── 中身の行を
   *   押したときは行が target なので、この経路には入らない(対照群を同じ it に置く)。
   */
  it('🔴 外を押すと閉じて、何も入らない', async () => {
    const { ta } = await openPicker('もと');
    const dialog = openDialog()!;
    dialog.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await tick();
    expect(openDialog(), '外を押しても閉じない').toBeNull();
    expect(ta.value).toBe('もと');
    // ⚠ 対照群 ── 行を押す経路は生きている(閉じ方を 1 本に寄せた副作用で死んでいない)
    const again = await openPicker('もと');
    rows()[0]!.click();
    await tick();
    expect(again.ta.value).not.toBe('もと');
  });

  /**
   * 🔴 **caret の位置に入る**(`insert-date` が 2026-08-23 に実機で踏んだ罠)。
   * ⚠ `<dialog>` は焦点を借りて返すが、**選択位置までは返さない** ── 控えていないと
   *   本文の**先頭**に入る。実機の `showModal()` が起こすことを、ここで手で起こす。
   */
  it('🔴 一覧を開いている間に caret が 0 へ戻されても、元の位置に入る', async () => {
    const { ta } = await openPicker('まえ\nうしろ', 3);
    ta.setSelectionRange(0, 0);
    rows()[0]!.click();
    await tick();
    expect(ta.value.startsWith('まえ\n```mermaid'), '本文の先頭に入った(caret を控えていない)').toBe(true);
  });

  /**
   * 🔑 **↑↓ で行を移れる**(鍵は近道)。⚠ 端では止まる(回り込まない)。
   */
  it('↑↓ で行の焦点が動く(端では止まる)', async () => {
    await openPicker();
    const r = rows();
    const key = (k: string): boolean => {
      const ev = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
      document.activeElement!.dispatchEvent(ev);
      return ev.defaultPrevented;
    };
    expect(document.activeElement).toBe(r[0]);
    expect(key('ArrowDown'), '矢印を握っていない(caret が動いて焦点が飛ぶ)').toBe(true);
    expect(document.activeElement).toBe(r[1]);
    key('ArrowUp');
    expect(document.activeElement).toBe(r[0]);
    // ⚠ 端では止まる ── 既定も止めない(握る理由が無い)
    expect(key('ArrowUp')).toBe(false);
    expect(document.activeElement).toBe(r[0]);
  });

  /**
   * 🔴 **画面から降りた欄に書き込まない**(日付 / 雛形と同じ門)。
   */
  it('🔴 編集をやめた後に選んでも、画面から降りた欄に書き込まない', async () => {
    const s = await openPicker('もと');
    s.d.dispatch({ type: 'CANCEL_EDIT' });
    await tick();
    expect(s.ta.isConnected, '前提が崩れている(欄がまだ画面に在る)').toBe(false);
    rows()[0]!.click();
    await tick();
    expect(s.ta.value, '画面に無い欄へ書き込んでいる').toBe('もと');
  });

  it('閲覧中は「図」のボタンが出ていない', async () => {
    const s = setup([meta('a')], { a: 'x' });
    s.d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    await tick();
    expect(s.q('[data-pkc-action="insert-diagram"]')).toBeNull();
  });
});

/**
 * 🔴 **live の 1 面でも書式が効く**(2026-08-08)。直す前は書式パネルも
 * Ctrl+B/I/K も `editor-body` を探して**無言 no-op** だった(flag `editor.live`
 * の面には `row-source` しか無い)。
 */
describe('書式パネル ── live の 1 面(2026-08-08)', () => {
  const setLive = (on: boolean): void => {
    // 2026-08-14: flag は設定 `pkc3.editor-mode` へ昇格(#104 第 2 弾。既定 live)
  localStorage.setItem('pkc3.editor-mode', on ? 'live' : 'split');
  };
  afterEach(() => setLive(false));

  /** 編集に入り、段落の行を開いて row-source を返す。 */
  async function openRow(
    q: <T extends HTMLElement>(s: string) => T | null,
    root: HTMLElement,
    text: string,
  ): Promise<HTMLTextAreaElement> {
    q<HTMLElement>('[data-pkc-action="start-edit"]')!.click();
    await tick(30); // 描画は follower(microtask)── 1 拍待つ
    const live = root.querySelector('[data-pkc-region="editor-live"]')!;
    const p = [...live.querySelectorAll('p')].find((e) => e.textContent === text)!;
    p.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0, ctrlKey: true }));
    return root.querySelector<HTMLTextAreaElement>('[data-pkc-field="row-source"]')!;
  }

  it('🔴 書式パネルが活性の行(row-source)に効き、確定で state まで届く', async () => {
    setLive(true);
    const { d, q, root } = setup([meta('a')], { a: '強調したい' });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    await tick();
    const ta = await openRow(q, root, '強調したい');
    ta.setSelectionRange(0, 2);
    q<HTMLElement>('[data-pkc-format="bold"]')!.click();
    expect(ta.value, '書式が行の入力欄に届いていない(無言 no-op)').toBe('**強調**したい');
    expect([ta.selectionStart, ta.selectionEnd]).toEqual([2, 4]);
    // 確定すると本文(state)に入る ── ここが切れていると保存で書式が消える
    ta.blur();
    expect(d.getState().openBody?.body).toBe('**強調**したい');
  });

  it('🔴 Ctrl+B も row-source に効く(近道キーの無言 no-op を塞ぐ)', async () => {
    setLive(true);
    const { d, q, root } = setup([meta('a')], { a: '強調したい' });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    await tick();
    const ta = await openRow(q, root, '強調したい');
    ta.setSelectionRange(0, 2);
    const ev = new KeyboardEvent('keydown', {
      key: 'b',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    ta.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(ta.value).toBe('**強調**したい');
  });

  it('🔴 row-source の Ctrl+S は行の確定で、編集の面は閉じない(COMMIT_EDIT に化けない)', async () => {
    setLive(true);
    const { d, q, root, persisted } = setup([meta('a')], { a: 'もとの文。' });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    await tick();
    const ta = await openRow(q, root, 'もとの文。');
    ta.value = '直した文。';
    const ev = new KeyboardEvent('keydown', {
      key: 's',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    ta.dispatchEvent(ev);
    expect(ev.defaultPrevented, 'ブラウザの保存ダイアログが開く').toBe(true);
    // 行は確定して state に入るが、**編集の面は続いている**
    expect(d.getState().openBody?.body).toBe('直した文。');
    expect(d.getState().phase).toBe('editing');
    expect(persisted, 'COMMIT_EDIT に化けて保存まで走った').toHaveLength(0);
  });
});

/**
 * 🔴 **日付を入れる道具**(user 指示 2026-08-23)。
 *
 * > 「**日付の記法としては入力がめんどくさいから、日付と時刻を簡単に入力できるし、
 * > ついてくるツールとか用意されてもいいかも。アイデアはすごくいいと思うけど足りない**」
 *
 * 🔴 規則そのもの(近道の日付 / 記法の組み立て)は
 * `tests/features/date-shortcuts.test.ts` / `tests/features/line-date.test.ts` が見る。
 * **ここが見るのは繋がり**である ── 押した所から欄を見つけ、ダイアログを開き、
 * 選んだものが **本文と state の両方**へ届くか。
 *
 * ⚠ 観測点を textarea の `value` だけにしない ── それだと「書き戻したが state に
 * 届いていない」実装が緑で通り、**保存すると日付が消える**。
 */
describe('日付を入れる道具(user 指示 2026-08-23)', () => {
  beforeEach(() => {
    localStorage.setItem('pkc3.editor-mode', 'split');
    resetAppDialogForTest();
  });

  /** 編集に入って、日付のボタンを押す。 */
  async function openPicker(body = '見積を送る') {
    const s = setup([meta('a')], { a: body });
    s.d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    await tick();
    s.q('[data-pkc-action="start-edit"]')!.click();
    const ta = s.q<HTMLTextAreaElement>('[data-pkc-field="editor-body"]')!;
    ta.setSelectionRange(ta.value.length, ta.value.length);
    s.q('[data-pkc-action="insert-date"]')!.click();
    await Promise.resolve();
    return { ...s, ta };
  }

  const dialog = (): HTMLDialogElement => {
    const d = openDialog();
    expect(d, '日付の窓が開いていない').not.toBeNull();
    return d!;
  };
  const shortcut = (id: string): HTMLButtonElement =>
    dialog().querySelector<HTMLButtonElement>(`[data-pkc-shortcut="${id}"]`)!;
  const field = (name: string): HTMLInputElement =>
    dialog().querySelector<HTMLInputElement>(`[data-pkc-field="${name}"]`)!;

  it('🔴 押すと窓が開き、近道と日付・時刻の欄が出る', async () => {
    await openPicker();
    for (const { id, label } of DATE_SHORTCUTS) {
      expect(shortcut(id), `近道「${label}」が無い`).not.toBeNull();
      expect(shortcut(id).textContent).toBe(label);
    }
    // 🔑 開いた時点で**今日**が入っている(いちばん多い答えを既に選んである)
    expect(field('pick-date').value, '日付の欄が空で開いた').toBe(
      shortcutDate('today', new Date()),
    );
    expect(field('pick-time').value, '時刻に既定を入れている(任意のはず)').toBe('');
  });

  /**
   * 🔴 **近道は日付欄を埋めるだけ。閉じない。**
   * ⚠ 押した瞬間に閉じる形にすると、時刻を足したい人が必ず 1 回やり直す。
   */
  it('🔴 近道を押しても閉じない(そのまま時刻も決められる)', async () => {
    await openPicker();
    shortcut('tomorrow').click();
    expect(field('pick-date').value).toBe(shortcutDate('tomorrow', new Date()));
    expect(openDialog(), '近道を押しただけで閉じた').not.toBeNull();
    // 🔑 押した手応え(どれを選んだか)が画面に出る
    expect(shortcut('tomorrow').hasAttribute('data-pkc-selected')).toBe(true);
    expect(shortcut('today').hasAttribute('data-pkc-selected'), '前の印が残っている').toBe(false);
  });

  /**
   * 🔴 **本文と state の両方**へ届く。
   * ⚠ どちらか片方だと「画面には出ているのに保存すると消える」形になる。
   */
  it('🔴 入れると、本文にも state にも記法が入る', async () => {
    const { d, ta } = await openPicker();
    shortcut('tomorrow').click();
    await answerDialog('ok');
    await tick();
    const want = `見積を送る @${shortcutDate('tomorrow', new Date())}`;
    expect(ta.value, '本文に入っていない').toBe(want);
    expect(d.getState().openBody?.body, 'state に届いていない').toBe(want);
  });

  it('時刻を入れると、記法にも入る', async () => {
    const { ta } = await openPicker();
    field('pick-date').value = '2026-08-25';
    field('pick-time').value = '14:00';
    await answerDialog('ok');
    await tick();
    expect(ta.value).toBe('見積を送る @2026-08-25 14:00');
  });

  /**
   * ⚠ **caret の直前が空白なら、区切りを足さない**(足すと 2 つ空く)。
   */
  it('直前が空白なら、空白を足さない', async () => {
    const { ta } = await openPicker('見積を送る ');
    field('pick-date').value = '2026-08-25';
    await answerDialog('ok');
    await tick();
    expect(ta.value).toBe('見積を送る @2026-08-25');
  });

  /** 🔴 **やめたら 1 バイトも変わらない**(空振り防止の対照群)。 */
  it('🔴 やめたら本文は変わらない', async () => {
    const { d, ta } = await openPicker();
    shortcut('tomorrow').click();
    await answerDialog('cancel');
    await tick();
    expect(ta.value, 'やめたのに入った').toBe('見積を送る');
    expect(d.getState().openBody?.body).toBe('見積を送る');
  });

  /**
   * 🔴 **入れた分は `Ctrl+Z` で戻せる**(書式パネルの他のボタンとは違う)。
   * ⚠ ここでは「`value` 直代入ではない」ことを見る ── happy-dom に
   *   `execCommand` は無いので `insertText` の fallback を通るが、
   *   その fallback も **`input` を撃つ**ことが本物との約束である
   *   (撃たないと state に届かない = 上の test が落ちる)。
   */
  it('🔴 挿した結果が、そのまま読み戻せる形になっている', async () => {
    const { ta } = await openPicker();
    field('pick-date').value = '2026-08-25';
    field('pick-time').value = '09:30';
    await answerDialog('ok');
    await tick();
    expect(readLineDate(ta.value)).toMatchObject({ date: '2026-08-25', time: '09:30' });
  });

  /**
   * 🔴 **窓を開いている間に caret が動いても、元の位置へ入る**
   * (2026-08-23、**実ブラウザの smoke が見つけた**不具合の回帰)。
   *
   * ⚠ 実機では `showModal()` のあと `selectionStart` が **0 に戻って**おり、
   *   日付が**本文の先頭**に入っていた(`@2026-08-24 14:00- [ ] 見積を送る`)。
   * ⚠ **happy-dom では起きない** ── 選択を保つので、直す前も緑だった。
   * 🔑 だからここでは**実機が起こすことを手で起こす** ── 環境差そのものを
   *   test の中に持ち込めば、どちらの箱でも同じ主張になる(CLAUDE.md §5)。
   */
  it('🔴 窓を開いている間に caret が 0 へ戻されても、元の位置に入る', async () => {
    const { ta } = await openPicker('- [ ] 見積を送る');
    // ⚠ 実機の `showModal()` が起こすことを、ここで手で起こす
    ta.setSelectionRange(0, 0);
    field('pick-date').value = '2026-08-25';
    await answerDialog('ok');
    await tick();
    expect(ta.value, '本文の先頭に入った(caret を控えていない)').toBe(
      '- [ ] 見積を送る @2026-08-25',
    );
  });

  /**
   * 🔴 **画面から降りた欄に書き込まない**(2026-08-25 に判明)。
   *
   * ⚠ この門(`formatTarget` を押された後に**引き直す**)は 2026-08-23 から
   *   在ったが、**どの test も通していなかった** ── 雛形の一覧(#196 段②-b)で
   *   同じ変異が生き延び、対称の反対側を疑って見つけた
   *   (CLAUDE.md「A を直したと書いた瞬間に B はどうかを grep する」)。
   * ⚠ 引き直さないと、**画面に無い節点へ字を書き `input` まで撃つ** ──
   *   本文は画面に出ないのに state だけ動く、いちばん気づけない食い違いになる。
   */
  it('🔴 編集をやめた後に「入れる」を押しても、画面から降りた欄に書き込まない', async () => {
    const s = await openPicker();
    const before = s.ta.value;
    s.d.dispatch({ type: 'CANCEL_EDIT' });
    await tick();
    expect(s.ta.isConnected, '前提が崩れている(欄がまだ画面に在る)').toBe(false);
    await answerDialog('ok');
    expect(s.ta.value, '画面に無い欄へ書き込んでいる').toBe(before);
  });

  /** ⚠ 閲覧中は帯そのものが無いので、押す口も無い(dead click を作らない)。 */
  it('閲覧中は日付のボタンが出ていない', async () => {
    const s = setup([meta('a')], { a: 'x' });
    s.d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    await tick();
    expect(s.q('[data-pkc-action="insert-date"]'), '閲覧中に押せる口が出ている').toBeNull();
  });
});
