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
import { BAR_FORMAT_OPS, FORMAT_OPS } from '../../src/features/markdown/text-ops';
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
    const unreachable = FORMAT_OPS.map((o) => o.op).filter(
      (op) => !onBar.has(op) && !byKey.has(op),
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
