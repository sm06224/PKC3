/** @vitest-environment happy-dom */
/**
 * 中央の面まわりの end-to-end:binder(実クリック)→ dispatcher → CenterRouter →
 * fake store。「state mutation → consumer 観測点」まで通す(PKC2 Testing 規約)。
 *
 * 🔴 **この file は `kanban-calendar-view.test.ts` の生き残りである**
 * (#292 段⑤、2026-08-23)。カレンダー / やることの板は中央の面から降りたので
 * あちらは丸ごと落としたが、**面と一緒に死ななかった主張が 2 つ**在った ──
 * ① **本文の中のチェックの印**(面ではなく `detail` の話だった)
 * ② **面の帯の × 閉じる**(どの面にも要る、面に依らない話だった)。
 * 🔑 落とすときは「この test が守っているのは**面**か、それとも**面に依らない
 *   何か**か」を 1 件ずつ問う ── 問わずに消すと、守っていた物ごと消える。
 *   ⚠ 札の側の主張は `schedule-view.test.ts` へ移した。
 */
import { stubStamps } from '../helpers/store-stamps';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import type { EntryUpsert } from '../../src/adapter/platform/storage/schema';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { VIEW_MODES, type ViewMode } from '../../src/adapter/state/app-state';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { CenterRouter } from '../../src/adapter/ui/render/center';
import { HelpRenderer } from '../../src/adapter/ui/render/help';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { stubRevisionOps } from '../helpers/revision-stub';

function meta(lid: string, over: Partial<EntryMeta> = {}): EntryMeta {
  return {
    lid,
    title: 't-' + lid,
    archetype: 'text',
    createdAt: null,
    updatedAt: null,
    entryOrder: Number(lid.slice(1)) || 0,
    status: null,
    date: null,
    archived: false,
    bodyChars: null,
    ...over,
  };
}

/** 面の切替は dispatch で作る(帯のボタンそのものは別の test が見る)。 */
function showView(d: Dispatcher, mode: ViewMode): void {
  d.dispatch({ type: 'SET_VIEW_MODE', mode });
}

async function tick(ms = 10): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

function setup(
  metas: EntryMeta[],
  bodies: Record<string, string>,
  extra: Record<string, unknown> = {},
) {
  const root = document.createElement('div');
  document.body.append(root);
  const d = new Dispatcher();
  const regions = buildShell(root);
  const center = new CenterRouter(regions.detail, () => new Date(2026, 7, 15)); // 2026-08
  d.onState((s) => center.render(s));
  const store = { ...bodies };
  const persisted: EntryUpsert[] = [];
  const effects = connectStoreEffects(d, {
    ...stubRevisionOps(),
    getBody: async (lid) => store[lid] ?? null,
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
      store[e.lid] = e.body;
      return stubStamps();
    },
    ...extra,
  });
  /**
   * ⚠ **配線は `main.ts` と同じ形にする**(#288)── `settle` を渡さないと、
   *   「飛んでいる書込を待ってから編集を始める」経路が**この harness では
   *   1 度も通らない**(CLAUDE.md §2「弱いのではなく走っていない」)。
   */
  bindActions(root, d, { settle: () => effects.settled() });
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas, relations: [] });
  const q = <T extends HTMLElement>(sel: string) => root.querySelector<T>(sel);
  const qa = (sel: string) => [...root.querySelectorAll<HTMLElement>(sel)];
  return { root, d, persisted, q, qa, store };
}

/**
 * 🔴 **チェックの印が押せて、本文に届く**(#277)。
 *
 * ⚠ 直す前は `disabled` で**読むだけ**だった ── その前は押せたが本文が
 *   1 文字も変わらず、開き直すと全部外れた(「チェックしたのに消えた」)。
 * 🔑 観測点は **store へ届いた本文**(画面だけ変わって保存されない、を作らない)。
 */
describe('チェックの印(#277)', () => {
  const BODY = ['# 買い物', '', '- [ ] 牛乳', '- [x] 卵', '', 'ここは本文。'].join('\n');

  it('🔴 押すと原文の印が反転し、保存まで届く', async () => {
    const { d, q, persisted, store } = setup([meta('n1', { archetype: 'text', status: null })], {
      n1: BODY,
    });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    await tick(20);
    const box = q<HTMLElement>('[data-pkc-action="toggle-task"][data-pkc-task-line="2"]');
    expect(box, 'チェックが押せる形で出ていない').not.toBeNull();
    box!.click();
    await tick(20);
    expect(persisted, '保存が出ていない').toHaveLength(1);
    expect(store['n1'], '原文の印が反転していない').toBe(
      ['# 買い物', '', '- [x] 牛乳', '- [x] 卵', '', 'ここは本文。'].join('\n'),
    );
  });

  /** ⚠ もう一度押すと戻る(片道にしない)。 */
  it('もう一度押すと外れる', async () => {
    const { d, q, store } = setup([meta('n1', { archetype: 'text', status: null })], { n1: BODY });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    await tick(20);
    q<HTMLElement>('[data-pkc-action="toggle-task"][data-pkc-task-line="3"]')!.click();
    await tick(20);
    expect(store['n1']!.split('\n')[3], '外れていない').toBe('- [ ] 卵');
  });

  /**
   * 🔴 **押した直後に編集へ入っても、押す前の本文が出ない**(#288)。
   *
   * ⚠ 直す前は、書込が着く前に「編集」へ入ると入力欄に**押す前の本文**が出て、
   *   そこで 1 文字でも打つと可視内容の last-write-wins で**印が黙って戻った**。
   * 🔑 直し方は「飛んでいる書込を待ってから始める」── 待つ口は書き出しが
   *   2026-08-17 に作った `settled()` と**同じ 1 本**(2 本目を作らない)。
   * ⚠ **飛んでいない回は待たない**(`settle()` が `null` を返す)── 待つと
   *   押下が必ず 1 tick 遅れ、既存の同期な動きが全部壊れる(実際 40 件落ちた)。
   */
  it('🔴 押した直後に編集へ入っても、印が反映済みの本文が出る (#288)', async () => {
    const { d, q, root, store } = setup([meta('n1', { archetype: 'text', status: null })], {
      n1: BODY,
    });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    await tick(20);
    // ⚠ **待たずに**続けて編集へ入る(これが踏んだ形)
    q<HTMLElement>('[data-pkc-action="toggle-task"][data-pkc-task-line="2"]')!.click();
    root.querySelector<HTMLElement>('[data-pkc-action="start-edit"]')!.click();
    await tick(30);
    expect(d.getState().phase, '編集に入っていない').toBe('editing');
    expect(
      d.getState().openBody?.body,
      '押す前の本文で編集が始まった(打つと印が黙って戻る)',
    ).toBe(store['n1']);
    expect(d.getState().openBody?.body, '印が入っていない').toContain('- [x] 牛乳');
  });

  /**
   * 🔴 **配線そのものを pin する**(#288。変異 W2 が生き延びて判明)。
   *
   * ⚠ 上の test は `settle` を**自分で渡す** harness なので、
   *   **`main.ts` が渡し忘れても緑のまま**である ── 実際、渡す行を消す変異が
   *   生き延びた(CLAUDE.md §2「どの test からも実行されない file に判断を書かない」)。
   * ⚠ `main.ts` は原文を読む test しか無いので、ここは**字面**で見る。
   *   **弱いと自覚して使う**(`resolve-container-compat.test.ts` と同じ妥協)。
   */
  it('🔴 boot が「飛んでいる書込を待つ口」を binder へ渡している (#288)', async () => {
    const { readFileSync } = await import('node:fs');
    const code = readFileSync('src/main.ts', 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    expect(code.length, 'コメント落としが本体まで消した').toBeGreaterThan(1000);
    expect(code, 'settle の配線が落ちている(押した直後の編集で本文が古くなる)').toMatch(
      /settle:\s*\(\)\s*=>\s*storeEffects\?\.settled\(\)/,
    );
  });

  /**
   * 🔴 **編集中は裏で書き換えない**(変異試験 T7 が生き延びて判明)。
   *
   * ⚠ 押す口は編集中には**描かれない**(編集の面に替わる)ので、これは
   *   「描かれてから phase が動くまでの隙間」を塞ぐ門である ── 隙間は狭いが、
   *   通ると**user が見ていない本文**が書き換わる。
   * 🔑 だから**口を直に叩いて**確かめる(DOM の都合で届かない門を、
   *   「守られている」と書かない ── CLAUDE.md「外して壊れることを 1 度は見る」)。
   */
  it('🔴 編集中に押しても書き換えず、理由を出す', async () => {
    const { d, root, persisted, store } = setup(
      [meta('n1', { archetype: 'text', status: null })],
      { n1: BODY },
    );
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    await tick(20);
    d.dispatch({ type: 'START_EDIT' });
    await tick(20);
    expect(d.getState().phase, '前提が崩れている').toBe('editing');
    // ⚠ 編集中は口が描かれないので、**同じ属性の口を置いて**叩く
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.setAttribute('data-pkc-action', 'toggle-task');
    box.setAttribute('data-pkc-task-line', '2');
    root.append(box);
    box.click();
    await tick(20);
    expect(persisted, '編集中に裏で書き込んだ').toHaveLength(0);
    expect(store['n1'], '本文が変わった').toBe(BODY);
    expect(d.getState().error ?? '', '無言で終わった').toContain('編集を終了してから');
  });

  /**
   * 🔴 **本文が変わっていたら黙って別の所を書かない**(#277)。
   * ⚠ 行番号は「描いた時の原文」のものなので、その後の書換でずれることがある。
   */
  it('🔴 その行がチェックでなくなっていたら、理由を出して何も書かない', async () => {
    const { d, persisted, store } = setup([meta('n1', { archetype: 'text', status: null })], {
      n1: BODY,
    });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    await tick(20);
    // 見出しの行(チェックではない)を指す
    d.dispatch({ type: 'TOGGLE_TASK', lid: 'n1', line: 0 });
    await tick(20);
    expect(persisted, '当てずっぽうで書き込んだ').toHaveLength(0);
    expect(store['n1'], '本文が変わった').toBe(BODY);
    expect(d.getState().error ?? '', '無言で終わった').toContain('反映できません');
  });
});


/**
 * 🔴 **開いている面を、その場で閉じられる**(user 目線レビュー U-3、2026-08-22)。
 *
 * ## 直す前に起きていたこと
 *
 * user はフォルダタブでノートを選び、**アプリ** → **カレンダー** を開く
 * (⚠ 当時の例。カレンダーは #292 段⑤ で左の列のタブへ引っ越したが、
 * **帰り道が無い**という欠陥は面に依らないので、この主張はそのまま生きている)。
 * 日付を付けるためにフォルダタブへ戻る(面は開いたまま)。
 * 付け終えて本文に戻りたい ── ⚠ **画面のどこにも「閉じる」が無い。**
 *
 * 効く道は 2 つだけだった:①**アプリ**タブへ戻って同じタイルをもう一度押す
 * ②`Alt+1`。⚠ ①はいま左の列がフォルダ一覧なので**その押す物が見えていない**、
 * ②は**画面のどこにも出ていない**。しかも「もう一度押すと閉じる」という規則を、
 * **押す物が一切示していない**(組み込みタイルには「いま開いている」印すら無い)。
 *
 * 🔑 だから **1 本の帯を中央に置き、全部の面で同じ位置に × を出す**
 *   (user 指示 2026-08-03「業務画面」の「同じものが常に同じ場所にある」)。
 *   ⚠ 面ごとに実装しない ── 8 面ぶん書くと、また 1 面だけ抜ける。
 *
 * ## ⚠ 題名は帯に入れなかった(U-7 は**取らなかった**)
 *
 * 初稿は帯に題名も入れたが、**実ブラウザが `pane-title` の重複を出した** ──
 * ヘルプ・設定・フラグ・2 ペインは**自分の題名を既に持っている**(unit では
 * 器が遅延生成なので 1 つしか見えず、気づけなかった)。
 * 🔑 7 か所に題名を作り直すより、**既にある物はそのまま**にして、
 *   足りなかった**帰り道だけ**を 1 か所で配るほうが小さく確実である。
 * ⚠ カレンダー(年月が出る)/ やることの板(列見出しが出る)は、
 *   題名が無くても**何の面か画面から分かる**ので足していない。
 */
describe('🔴 面の帯(user 目線レビュー U-3)', () => {
  const bar = (root: HTMLElement): HTMLElement | null =>
    root.querySelector('[data-pkc-region="pane-bar"]');

  it('🔴 本文では帯を出さない(本文は「閉じる」対象ではない)', async () => {
    const s = setup([meta('n1')], { n1: '本文' });
    s.d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    await tick();
    expect(bar(s.root)?.hidden, '本文で帯が出ている').toBe(true);
  });

  it('🔴 どの面を開いても、同じ場所に閉じる口が出る', async () => {
    const s = setup([meta('n1')], { n1: '本文' });
    // ⚠ **全部の面を通す** ── 1 面だけ抜けるのがこの機構の壊れ方である。
    //    🔑 名指しの一覧にしない(#292 段⑤)── `VIEW_MODES` から引けば、
    //      面を足した日に**足し忘れた面がここで落ちる**
    const views = VIEW_MODES.filter((v) => v !== 'detail');
    expect(views.length, '面が 1 つも無い(空振り)').toBeGreaterThan(0);
    for (const mode of views) {
      showView(s.d, mode);
      await tick();
      expect(bar(s.root)?.hidden, `${mode} で帯が出ていない`).toBe(false);
      expect(
        s.root.querySelector('[data-pkc-action="close-pane"]'),
        `${mode} に閉じる口が無い`,
      ).not.toBeNull();
    }
  });

  it('🔴 × を押すと本文へ戻る(画面の中だけで完結する)', async () => {
    const s = setup([meta('n1')], { n1: '本文' });
    s.d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    showView(s.d, 'query');
    await tick();
    const close = s.root.querySelector<HTMLElement>('[data-pkc-action="close-pane"]');
    expect(close, '閉じる口が画面に無い').not.toBeNull();
    // ⚠ 字も見る ── 記号だけだと「何が閉じるのか」が読めない
    expect(close!.textContent, '何が起きるか読めない').toContain('閉じる');
    close!.click();
    await tick();
    expect(s.d.getState().viewMode, '× を押しても閉じない').toBe('detail');
    expect(bar(s.root)?.hidden, '閉じたのに帯が残っている').toBe(true);
  });

  /**
   * ⚠ **編集中でも閉じられる** ── わきの面(ヘルプ等)は編集中でも開けるので、
   *   そこで閉じられないと「入ったら出られない」になる。
   *   🔑 `SET_VIEW_MODE 'detail'` は編集中でも通る(2026-08-19「本文へ戻る道は
   *   塞がない」)ので、この × はその道に乗っている。
   */
  /**
   * 🔴 **アプリの窓では、× が窓ごと閉じる**(#300 段③ の直し、2026-08-22)。
   *
   * ⚠ 直す前は別窓の面でも `SET_VIEW_MODE 'detail'` が飛ぶだけで、
   *   **窓は残りそこに本文が出た** ── user から見ると「アプリを閉じたら
   *   PKC がもう 1 つ増えた」である(動線レビュー §7)。
   * ⚠ 本体のタブでは配線されない ── 上の test 群がその対照群である。
   */
  it('🔴 アプリの窓では、× を押しても面を畳まない(窓ごと閉じる)', async () => {
    const s = setup([meta('n1')], { n1: '本文' });
    const root2 = document.createElement('div');
    document.body.append(root2);
    // ⚠ この test だけ別の器で binder を組み直す(service を渡すため)
    const regions = buildShell(root2);
    const center = new CenterRouter(regions.detail, () => new Date(2026, 7, 15));
    s.d.onState((st) => center.render(st));
    bindActions(root2, s.d, { closeViewWindow: () => 'closed' });
    showView(s.d, 'query');
    await tick();
    root2.querySelector<HTMLElement>('[data-pkc-action="close-pane"]')!.click();
    await tick();
    expect(s.d.getState().viewMode, '窓ごと閉じるはずが、面を畳んだ').toBe('query');
  });

  /**
   * 🔴 **閉じられなかったら黙らない。**
   * ⚠ user がブックマークから開いた窓は script では閉じられない ──
   *   そのときは理由を出してから本文へ畳む(無言の dead click を作らない)。
   */
  it('🔴 窓を閉じられなかったら、理由を出して本文へ畳む', async () => {
    const s = setup([meta('n1')], { n1: '本文' });
    const root2 = document.createElement('div');
    document.body.append(root2);
    const regions = buildShell(root2);
    const center = new CenterRouter(regions.detail, () => new Date(2026, 7, 15));
    s.d.onState((st) => center.render(st));
    bindActions(root2, s.d, { closeViewWindow: () => 'refused' });
    showView(s.d, 'query');
    await tick();
    root2.querySelector<HTMLElement>('[data-pkc-action="close-pane"]')!.click();
    await tick();
    expect(s.d.getState().viewMode, '本文へ畳んでいない').toBe('detail');
    expect(s.d.getState().error, '黙って畳んだ(窓が残る理由が分からない)').toContain(
      '× で閉じてください',
    );
  });

  it('🔴 編集中に開いたヘルプも、× で閉じて編集へ帰れる', async () => {
    const s = setup([meta('n1')], { n1: '本文' });
    s.d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    await tick();
    s.d.dispatch({ type: 'START_EDIT' });
    expect(s.d.getState().phase, '前提が崩れている(編集に入れていない)').toBe('editing');
    showView(s.d, 'help');
    await tick();
    s.root.querySelector<HTMLElement>('[data-pkc-action="close-pane"]')!.click();
    await tick();
    expect(s.d.getState().viewMode, '編集中は × が効かない(袋小路)').toBe('detail');
    expect(s.d.getState().phase, '閉じたら編集が終わっていた').toBe('editing');
  });
});


/**
 * 🔴 **ヘルプから出たことが、ヘルプの面に届いている**(#531 H3、2026-08-28)。
 *
 * ⚠ **この主張は、どちらの単体 test にも書けない** ── `HelpRenderer` の test は
 *   「`onHidden()` を呼んだら手放す」を見るだけで、**誰も呼んでいなくても緑**である。
 *   `CenterRouter` の test も、面が入れ替わったことしか見ていない。
 *   🔑 だから**合意を見る場所を別に 1 つ置く**(CLAUDE.md §7、2026-08-25)。
 *
 * ⚠ 本体は**呼び抜けさせない**(`mockImplementation` で止める)── 呼び抜けると
 *   5 分の予約が実時間で残る(`vi.spyOn` は既定で本体を呼ぶ ── CLAUDE.md の戒め)。
 */
describe('ヘルプから出たら、面に伝わる(#531 H3)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('🔴 ヘルプ → 本文 で伝わり、別の面から出たときは伝わらない', async () => {
    const spy = vi.spyOn(HelpRenderer.prototype, 'onHidden').mockImplementation(() => undefined);
    const { d } = setup([meta('n1')], { n1: '本文' });

    // ① ヘルプを開いて、出る
    showView(d, 'help');
    await tick();
    expect(spy, '開いただけで「出た」と言っている').not.toHaveBeenCalled();
    showView(d, 'detail');
    await tick();
    expect(spy, 'ヘルプから出たのに面へ伝わっていない(いつまでも抱えたまま)').toHaveBeenCalledTimes(1);

    // ② 🔴 対照群 ── **別の面**から出たときに呼ばない(面を見分けている証拠)
    showView(d, 'settings');
    await tick();
    showView(d, 'detail');
    await tick();
    expect(spy, '別の面から出たのにヘルプへ伝えている(面を見分けていない)').toHaveBeenCalledTimes(
      1,
    );
  });
});
