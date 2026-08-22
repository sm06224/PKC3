/** @vitest-environment happy-dom */
/**
 * kanban / calendar view の end-to-end(P3-6):
 * binder(実クリック)→ dispatcher → CenterRouter → fake store。
 * 「state mutation → consumer 観測点」まで通す(PKC2 Testing 規約)。
 */
import { stubStamps } from '../helpers/store-stamps';
import { describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import type { EntryUpsert } from '../../src/adapter/platform/storage/schema';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import type { ViewMode } from '../../src/adapter/state/app-state';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { CenterRouter } from '../../src/adapter/ui/render/center';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { stubRevisionOps } from '../helpers/revision-stub';

function meta(lid: string, over: Partial<EntryMeta> = {}): EntryMeta {
  return {
    lid,
    title: 't-' + lid,
    archetype: 'todo',
    createdAt: null,
    updatedAt: null,
    entryOrder: Number(lid.slice(1)) || 0,
    status: 'open',
    date: null,
    archived: false,
    bodyChars: null,
    ...over,
  };
}

/**
 * 🔑 **面の切替は dispatch で作る**(2026-08-19 に理由を書き直した)。
 *
 * ⚠ 以前ここには「封印中なので切替ボタンが画面に無い。**解いたらボタンのクリックへ
 *   戻す**」と書いてあったが、封印は #276 / #277 で解けたのに**戻していない** ──
 *   古い指示が残っていた。
 * 🔑 戻さないのが正しい:解いた形は**組み込みタイル**であって帯の切替ではないので、
 *   ここでボタンを押すなら**ランチャーの面まで組む**ことになる。導線が実際に効くかは
 *   `tests/smoke/kanban.smoke.spec.ts` が**実クリック**で見る ── unit は
 *   **描画と state** を見る場所として dispatch のままにする(役割で分ける)。
 */
function showView(d: Dispatcher, mode: ViewMode): void {
  d.dispatch({ type: 'SET_VIEW_MODE', mode });
}

async function tick(ms = 10): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

/**
 * ⚠ `extra` は**店の口を足す / 差し替える**ためのもの(#277 段②-b)。
 *   既定の fake は `taskScan` を持たない ── それ自体が
 *   「持っていない環境では面が断る」の実演になっている。
 */
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
 * 🔴 **カンバン ── 札 1 枚 = 本文のチェック項目**(#277 段②-b)。
 *
 * ⚠ 2026-08-19 に**主張ごと入れ替えた**。ここは以前「`todo` アーキタイプの
 *   ノートを status 列に振り分ける」面だったが、`todo` は封印中で作れないので
 *   **盤面に何も出せる人が居なかった**(`features/sealed.ts`)。
 *
 * 🔑 ここで通すのは binder(実クリック)→ dispatcher → 書換 → CenterRouter の
 *   一巡である。⚠ 札は worker が集めるので、その部分だけ `SET_TASK_SCAN` で与える
 *   (worker 自身の主張は `tests/adapter/storage-worker.test.ts` が持つ)。
 */
describe('kanban view (#277 段②-b)', () => {
  /** 盤面へ札を流し込む(worker が集めた結果の代わり)。 */
  function feed(d: Dispatcher, cards: Array<{ lid: string; line: number; text: string; done: boolean }>): void {
    d.dispatch({
      type: 'SET_TASK_SCAN',
      scan: { cards, totalNotes: 1, scannedNotes: 1, truncated: false },
    });
  }

  const cardsIn = (host: HTMLElement): string[] =>
    [...host.children].map((c) => c.getAttribute('data-pkc-entry') ?? '');

  it('🔴 印の有無で列に立ち、実クリックで本文が書き換わって札が列を移る', async () => {
    const body = '# 買い物\n\n- [ ] 牛乳\n- [x] 卵\n';
    const { d, q, persisted, store } = setup([meta('e1', { archetype: 'text', status: null })], {
      e1: body,
    });
    showView(d, 'kanban');
    feed(d, [
      { lid: 'e1', line: 2, text: '牛乳', done: false },
      { lid: 'e1', line: 3, text: '卵', done: true },
    ]);

    const colOpen = q('[data-pkc-kanban-status="open"] [data-pkc-region="kanban-cards"]')!;
    const colDone = q('[data-pkc-kanban-status="done"] [data-pkc-region="kanban-cards"]')!;
    expect(cardsIn(colOpen), '未完了の列が違う').toEqual(['e1']);
    expect(cardsIn(colDone), '完了の列が違う').toEqual(['e1']);
    const doneCardBefore = colDone.children[0];

    // 実クリック(本物の checkbox)
    q<HTMLElement>('[data-pkc-region="kanban-cards"] [data-pkc-task-line="2"]')!.click();
    await tick(20);

    // 🔴 書込は**印の 1 文字だけ**(本文 byte 無傷)
    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.body, '本文が整形された').toBe('# 買い物\n\n- [x] 牛乳\n- [x] 卵\n');
    expect(store['e1']).toBe(persisted[0]!.body);

    // 🔑 ack で札が動く(往復を待たない)。⚠ 触っていない札は同じノードのまま
    await tick(5);
    expect(cardsIn(colOpen), '押した札が未完了に残っている').toEqual([]);
    expect(colDone.children).toHaveLength(2);
    expect(colDone.children[1], '触っていない札まで作り直した').toBe(doneCardBefore);
  });

  /**
   * 🔴 **押した札は、その札のノートに効く**(#277 段②-b で直した地雷)。
   *
   * ⚠ 直す前の binder は `openBody?.lid ?? selectedLid` だけを見ていたので、
   *   盤面から押すと**いま開いているノート**の同じ行番号を書き換えた ──
   *   user から見ると「触っていないノートが勝手に変わる」= 静かなデータ破壊。
   * 🔑 だから **2 件目を選んだ状態で 1 件目の札を押す**。
   */
  it('🔴 開いているノートではなく、札のノートを書き換える', async () => {
    const { d, q, persisted } = setup(
      [meta('e1', { archetype: 'text', status: null }), meta('e2', { archetype: 'text', status: null })],
      { e1: '- [ ] 牛乳\n', e2: '- [ ] 触るな\n' },
    );
    // e2 を開く(選択 → openBody 確立)
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'e2' });
    await tick();
    expect(d.getState().openBody?.lid, '当て馬が開いていない(前提が崩れた)').toBe('e2');

    showView(d, 'kanban');
    feed(d, [{ lid: 'e1', line: 0, text: '牛乳', done: false }]);
    q<HTMLElement>('[data-pkc-region="kanban-cards"] [data-pkc-task-line="0"]')!.click();
    await tick(20);

    expect(persisted, '書込が 1 件でない').toHaveLength(1);
    expect(persisted[0]!.lid, '開いているノートを書き換えた(別ノートへの書込)').toBe('e1');
    expect(persisted[0]!.body).toBe('- [x] 牛乳\n');
  });

  /**
   * 列間 move は O(1)(cursor 汚染 pin ── 旧カンバンから引き継ぐ主張)。
   * ⚠ 先頭の札を動かしたときに、後続の札まで `insertBefore` されない。
   */
  it('列間 move は O(1): 先頭を動かしても後続の札は動かない(cursor 汚染 pin)', async () => {
    const lines = Array.from({ length: 8 }, (_, i) => `- [ ] やること ${i}`).join('\n') + '\n';
    const { d, q } = setup([meta('e0', { archetype: 'text', status: null })], { e0: lines });
    showView(d, 'kanban');
    feed(
      d,
      Array.from({ length: 8 }, (_, i) => ({ lid: 'e0', line: i, text: `やること ${i}`, done: false })),
    );
    const openHost = q('[data-pkc-kanban-status="open"] [data-pkc-region="kanban-cards"]')!;
    const doneHost = q('[data-pkc-kanban-status="done"] [data-pkc-region="kanban-cards"]')!;

    let moves = 0;
    for (const host of [openHost, doneHost]) {
      const original = host.insertBefore.bind(host);
      (host as { insertBefore: typeof host.insertBefore }).insertBefore = ((
        node: Node,
        ref: Node | null,
      ) => {
        moves++;
        return original(node, ref);
      }) as typeof host.insertBefore;
    }
    q<HTMLElement>('[data-pkc-region="kanban-cards"] [data-pkc-task-line="0"]')!.click();
    await tick(20);

    expect(doneHost.children, '押した札が完了へ移っていない').toHaveLength(1);
    expect(openHost.children).toHaveLength(7);
    // 移動した 1 枚の挿入だけ ── 後続 7 枚は動かない
    expect(moves, '後続の札まで動いた(cursor 汚染)').toBe(1);
    // 🔑 印の向きも DOM に出ている(属性だけでなく `checked`)
    const moved = doneHost.querySelector<HTMLInputElement>('[data-pkc-task-line="0"]')!;
    expect(moved.checked, '移った札の印が付いていない').toBe(true);
  });

  /**
   * 🔴 **「まだ」「駄目だった」「無い」を区別する**(集計 #184 と同じ規律)。
   * ⚠ 混ぜると、集めている最中と項目 0 件が同じ顔になり、
   *   user は「壊れている」と読む。
   */
  it('🔴 集めている最中・失敗・0 件で、出す言葉が違う', async () => {
    // ⚠ **返らない口**を渡して「まだ集めていない」を作る(0 件と区別する)
    const { d, q } = setup([meta('e1', { archetype: 'text', status: null })], { e1: 'x' }, {
      taskScan: () => new Promise(() => {}),
    });
    showView(d, 'kanban');
    const note = (): string => q('[data-pkc-field="kanban-note"]')!.textContent ?? '';
    expect(note(), 'まだ集めていないのに別のことを言っている').toContain('集めています');

    d.dispatch({ type: 'TASK_SCAN_FAILED' });
    expect(note(), '失敗を「無い」と混同している').toContain('集められませんでした');

    feed(d, []);
    expect(note(), '0 件のときの導きが無い').toContain('- [ ]');
  });

  /**
   * 🔴 **持っていない環境では、面が黙らずに断る**(集計 #184 と同じ落ち方)。
   * ⚠ 古い worker が service worker のキャッシュに残っている端末で実際に起きる ──
   *   黙ると盤面は「集めています…」のまま**永久に止まって見える**。
   * 🔑 既定の fake が `taskScan` を持たないので、これは**実演**である。
   */
  it('🔴 集める口を持たない環境では、断りが出る(黙って止まらない)', async () => {
    const { d, q } = setup([meta('e1', { archetype: 'text', status: null })], { e1: 'x' });
    showView(d, 'kanban');
    expect(
      q('[data-pkc-field="kanban-note"]')!.textContent ?? '',
      '口が無いのに「集めています」のまま止まっている',
    ).toContain('集められませんでした');
  });

  it('トグル失敗は非致命 ── phase は ready のまま、通知が出て再クリックで復帰', async () => {
    const root = document.createElement('div');
    document.body.append(root);
    const d = new Dispatcher();
    const regions = buildShell(root);
    const center = new CenterRouter(regions.detail, () => new Date(2026, 7, 15));
    d.onState((s) => center.render(s));
    bindActions(root, d);
    let failNext = true;
    const persisted: EntryUpsert[] = [];
    connectStoreEffects(d, {
      ...stubRevisionOps(),
      getBody: async () => '- [ ] やること\n',
      deleteEntry: async () => {},
      setEntryParent: async () => {},
      persistEntry: async (e) => {
        if (failNext) throw new Error('flaky');
        persisted.push(e);
        return stubStamps();
      },
    });
    d.dispatch({
      type: 'SYS_BOOTED',
      cid: 'c1',
      metas: [meta('e1', { archetype: 'text', status: null })],
      relations: [],
    });
    showView(d, 'kanban');
    d.dispatch({
      type: 'SET_TASK_SCAN',
      scan: {
        cards: [{ lid: 'e1', line: 0, text: 'やること', done: false }],
        totalNotes: 1,
        scannedNotes: 1,
        truncated: false,
      },
    });
    const click = (): void =>
      root.querySelector<HTMLElement>('[data-pkc-region="kanban-cards"] [data-pkc-task-line="0"]')!.click();
    click();
    await tick(20);
    expect(d.getState().phase, 'アプリが死んだ').toBe('ready');
    expect(d.getState().error, '黙って失敗した').toMatch(/flaky/);
    failNext = false;
    click();
    await tick(20);
    expect(persisted, '再クリックが retry になっていない').toHaveLength(1);
  });

  /**
   * 🔴 **断られたとき、印だけが付いたまま残らない**(2026-08-19 のレビュー W-2)。
   * ⚠ 直す前はブラウザの既定動作で `checked` が反転し、断り経路(編集中 /
   *   書換が当たらない / 保存の失敗)では**戻す者が居なかった** ──
   *   「チェックしたのに保存されない」という、いちばん質の悪い見え方。
   * 🔑 いまは押した瞬間に何も変えない(`preventDefault`)。
   */
  it('🔴 編集中に札を押しても、印は付かない(見た目が嘘をつかない)', async () => {
    const { d, q, persisted } = setup([meta('e1', { archetype: 'text', status: null })], {
      e1: '- [ ] やること\n',
    });
    showView(d, 'kanban');
    feed(d, [{ lid: 'e1', line: 0, text: 'やること', done: false }]);
    // 編集中にする(札は ready 限定)
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'e1' });
    await tick();
    d.dispatch({ type: 'START_EDIT' });
    await tick();
    const box = q<HTMLInputElement>('[data-pkc-region="kanban-cards"] [data-pkc-task-line="0"]')!;
    box.click();
    await tick(20);
    expect(box.checked, '断られたのに印が付いたまま残っている').toBe(false);
    expect(persisted, '編集中なのに書き込んだ').toHaveLength(0);
  });

  /**
   * ⚠ **空振り防止** ── 上の test は「そもそも click が印を動かさない環境」でも
   * 通ってしまう。**素の checkbox は反転する**ことを同じ環境で確かめる。
   */
  it('⚠ 素の checkbox は click で反転する(空振り防止)', () => {
    const plain = document.createElement('input');
    plain.type = 'checkbox';
    document.body.append(plain);
    plain.click();
    expect(plain.checked, 'この環境では click が既定動作を起こさない = 上の test は空振り').toBe(
      true,
    );
    plain.remove();
  });

  /**
   * 🔴 **切ったことを画面に出す**(2026-08-19 のレビュー W-6)。
   * ⚠ `truncated` を描画側で与える test が 1 件も無く、
   *   「切ったなら必ず言う」の 1 行だけが無防備だった。
   */
  it('🔴 上限で切ったら、そう画面に書く(「無い」と読ませない)', () => {
    const { d, q } = setup([meta('e1', { archetype: 'text', status: null })], { e1: 'x' });
    showView(d, 'kanban');
    d.dispatch({
      type: 'SET_TASK_SCAN',
      scan: {
        cards: [{ lid: 'e1', line: 0, text: 'やること', done: false }],
        totalNotes: 900,
        scannedNotes: 500,
        truncated: true,
      },
    });
    const note = q('[data-pkc-field="kanban-note"]')!.textContent ?? '';
    expect(note, '切ったことを言っていない').toContain('多いので');
    expect(note, '候補の総数を出していない').toContain('900');
  });

  /**
   * 🔴 **本文の当たり(検索)も絞り込みに効く**(レビュー W-7 / W-8)。
   * ⚠ 題名に無い語で絞ったとき、本文が当たっているノートの札が消えると
   *   「左の一覧には出るのに板は空」になる。
   */
  it('🔴 本文の当たりで絞れる(題名に無い語でも札が残る)', () => {
    const { d, q } = setup(
      [meta('e1', { archetype: 'text', status: null }), meta('e2', { archetype: 'text', status: null })],
      { e1: 'x', e2: 'y' },
    );
    showView(d, 'kanban');
    feed(d, [
      { lid: 'e1', line: 0, text: 'あ', done: false },
      { lid: 'e2', line: 0, text: 'い', done: false },
    ]);
    const cards = (): number =>
      q('[data-pkc-view-pane="kanban"]')!.querySelectorAll('[data-pkc-region="kanban-cards"] [data-pkc-entry]').length;
    expect(cards()).toBe(2);
    // 題名(t-e1 / t-e2)に無い語で絞る ── 本文の当たりだけが根拠になる
    d.dispatch({ type: 'SET_ENTRY_FILTER', query: 'ぜんぜん違う語' });
    expect(cards(), '当たりが無いのに残っている').toBe(0);
    d.dispatch({ type: 'SET_SEARCH_HITS', query: 'ぜんぜん違う語', lids: ['e1'] });
    expect(cards(), '本文の当たりが盤面に効いていない').toBe(1);
  });

  /** 🔴 ノートを改名したら、札の出どころの字も直る(レビュー W-9)。 */
  it('🔴 改名が札に映る', async () => {
    const { d, q } = setup([meta('e1', { archetype: 'text', status: null })], { e1: 'x' });
    showView(d, 'kanban');
    feed(d, [{ lid: 'e1', line: 0, text: 'やること', done: false }]);
    const note = (): string =>
      q('[data-pkc-region="kanban-cards"] [data-pkc-field="note"]')!.textContent ?? '';
    expect(note()).toBe('t-e1');
    d.dispatch({ type: 'RENAME_ENTRY_TITLE', lid: 'e1', title: '新しい名前' });
    await tick();
    expect(note(), '改名が札に映っていない').toBe('新しい名前');
  });

  /** 🔴 済みの札に印が付く / 選んだ札に印が付く(レビュー W-10)。 */
  it('🔴 済みと選択が DOM の属性に出る', () => {
    const { d, q } = setup([meta('e1', { archetype: 'text', status: null })], { e1: 'x' });
    showView(d, 'kanban');
    feed(d, [
      { lid: 'e1', line: 0, text: 'まだ', done: false },
      { lid: 'e1', line: 1, text: 'すんだ', done: true },
    ]);
    const done = q('[data-pkc-kanban-status="done"] [data-pkc-entry]')!;
    expect(done.hasAttribute('data-pkc-task-done'), '済みの印が無い(取り消し線が効かない)').toBe(
      true,
    );
    const open = q('[data-pkc-kanban-status="open"] [data-pkc-entry]')!;
    expect(open.hasAttribute('data-pkc-task-done'), '未完了に済みの印が付いている').toBe(false);
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'e1' });
    expect(open.hasAttribute('data-pkc-selected'), '選んだ札に印が付かない').toBe(true);
  });

  /**
   * 🔴 **片付けたノートの項目は、カレンダーと同じ規則**(レビュー指摘)。
   */
  it('🔴 片付けたノートの札は既定で出ない(見せる設定なら出る)', () => {
    const { d, q } = setup([meta('e1', { archetype: 'text', status: null, archived: true })], {
      e1: 'x',
    });
    showView(d, 'kanban');
    feed(d, [{ lid: 'e1', line: 0, text: 'やること', done: false }]);
    const cards = (): number =>
      q('[data-pkc-view-pane="kanban"]')!.querySelectorAll('[data-pkc-region="kanban-cards"] [data-pkc-entry]').length;
    expect(cards(), '片付けたノートの項目が既定で出ている').toBe(0);
    d.dispatch({ type: 'TOGGLE_SHOW_ARCHIVED' });
    expect(cards(), '見せる設定にしても出ない').toBe(1);
  });

  it('編集中はトグル不可(ready 限定)/ 未知 lid・text は no-op', async () => {
    const { d, persisted } = setup([meta('e1'), meta('e4', { archetype: 'text' })], {
      e1: 'x',
    });
    d.dispatch({ type: 'TOGGLE_TODO_STATUS', lid: 'nope' });
    d.dispatch({ type: 'TOGGLE_TODO_STATUS', lid: 'e4' });
    await tick();
    expect(persisted).toHaveLength(0);
  });
});

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

describe('calendar view (P3-6)', () => {
  /**
   * 🔴 **今日に印が付く**(2026-08-20。user 指示「カレンダーを利用するための導線が
   * 不足している」)。⚠ 直す前は**今日を示すものが 1 つも無かった** ── カレンダーで
   * 最初に探すものが画面に無い。
   * 🔑 `now` は注入できる(`CenterRouter` の第 2 引数)ので、実時刻に依存しない。
   */
  it('🔴 今日のセルにだけ印が付く(別の月を見ているときは付かない)', () => {
    const { d, q, qa } = setup([meta('e1', { date: '2026-08-01' })], {});
    showView(d, 'calendar');
    // 注入した「今日」は 2026-08-15
    expect(qa('[data-pkc-today]').length, '今日の印が 1 つでない').toBe(1);
    expect(q('[data-pkc-today]')?.getAttribute('data-pkc-date')).toBe('2026-08-15');
    // 翌月へ送ると、その月に今日は無い
    q<HTMLElement>('[data-pkc-action="calendar-nav"][data-pkc-nav-month="9"]')!.click();
    expect(qa('[data-pkc-today]').length, '別の月なのに今日の印が出た').toBe(0);
  });

  /**
   * ⚠ **月外のセルは「押せない」と分かる形にする** ── 直す前は素の空 td で、
   *   見た目が月内と同じなのに押しても何も起きなかった(無言の dead click)。
   */
  it('月外のセルは印が付き、押す口を持たない', () => {
    const { d, qa } = setup([], {});
    showView(d, 'calendar');
    const outside = qa('[data-pkc-outside]');
    expect(outside.length, '2026-08 は 1 日が土曜なので月外のセルが在るはず').toBeGreaterThan(0);
    for (const td of outside) {
      expect(td.hasAttribute('data-pkc-date'), '月外のセルが日付を持っている').toBe(false);
      expect(td.hasAttribute('data-pkc-action'), '月外のセルが押せる').toBe(false);
    }
  });

  /**
   * ⚠ **土日は列そのもの**に印を付ける(セルが空でも分かるように)。
   * 🔑 曜日は格子の位置で決まる ── 見出しと本体で**同じ列**に付くことを見る
   *   (片方だけだと、縞がずれて見える)。
   */
  it('土日の列に印が付く(見出しと本体で同じ列)', () => {
    const { d, q, qa } = setup([], {});
    showView(d, 'calendar');
    const heads = [...q('[data-pkc-region="calendar-grid"] thead tr')!.children];
    expect(heads.map((th) => th.hasAttribute('data-pkc-weekend'))).toEqual([
      true, false, false, false, false, false, true,
    ]);
    const firstRow = [...q('[data-pkc-region="calendar-grid"] tbody tr')!.children];
    expect(firstRow.map((td) => td.hasAttribute('data-pkc-weekend'))).toEqual([
      true, false, false, false, false, false, true,
    ]);
    expect(qa('[data-pkc-weekend]').length, '空振り(1 つも付いていない)').toBeGreaterThan(2);
  });

  /**
   * 🔴 **どのノートに日付が付くかを、押す前に出す**(2026-08-20)。
   *
   * ⚠ 直す前は、押して初めて「日付を付けるノートを先に選んでください」と断られた
   *   ── 押す前に何が選ばれているか画面から読めなかった。
   * ⚠ **文言は「押した場所」と対で pin する**(CLAUDE.md §1)── 題名が出るだけの
   *   検査だと、選んでいないときの案内文を消す変異が生き延びる。
   */
  it('🔴 帯に「どのノートに日付が付くか」が出る(選ぶ前は、何をすればよいかを出す)', () => {
    const { d, q } = setup([meta('e1', { date: null, title: 'あ' })], {});
    showView(d, 'calendar');
    const bar = () => q('[data-pkc-field="calendar-target"]')?.textContent;
    expect(bar(), '選ぶ前の案内が出ていない').toBe(
      '日を押す前に、左の一覧からノートを選んでください',
    );
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'e1' });
    expect(bar(), '選んだノートの題名が出ていない').toBe('「あ」に日付を付けます');
    expect(
      q('[data-pkc-field="calendar-target"]')?.getAttribute('data-pkc-entry'),
      '帯が指しているノートが分からない',
    ).toBe('e1');
  });

  it('date セルに todo が立ち、showArchived と月送りが効く', async () => {
    const { d, q, qa } = setup(
      [
        meta('e1', { date: '2026-08-01' }),
        meta('e2', { date: '2026-08-01', archived: true }),
        meta('e3', { date: '2026-09-05' }),
      ],
      {},
    );
    showView(d, 'calendar');

    expect(q('[data-pkc-field="calendar-month"]')?.getAttribute('data-pkc-month')).toBe(
      '2026-08',
    );
    const cell = q('[data-pkc-date="2026-08-01"]')!;
    expect(
      [...cell.querySelectorAll('[data-pkc-entry]')].map((e) =>
        e.getAttribute('data-pkc-entry'),
      ),
    ).toEqual(['e1']); // archived は既定で出ない

    q<HTMLElement>('input[data-pkc-action="toggle-show-archived"]')!.click();
    expect(
      [...q('[data-pkc-date="2026-08-01"]')!.querySelectorAll('[data-pkc-entry]')].map(
        (e) => e.getAttribute('data-pkc-entry'),
      ),
    ).toEqual(['e1', 'e2']);

    // 月送り(› = 描画時に焼き込まれた遷移先)で 9 月へ、e3 が見える
    q<HTMLElement>('[data-pkc-action="calendar-nav"][data-pkc-nav-month="9"]')!.click();
    expect(q('[data-pkc-field="calendar-month"]')?.getAttribute('data-pkc-month')).toBe(
      '2026-09',
    );
    expect(q('[data-pkc-date="2026-09-05"]')!.querySelector('[data-pkc-entry]')).not.toBeNull();
    expect(qa('[data-pkc-date="2026-08-01"]')).toHaveLength(0);
  });

  /**
   * 🔴 **普通のノートがカレンダーに出る**(#276。封印の解除。user 指示 2026-08-19
   * 「frontmatter でのカレンダー情報付与…でカンバンとカレンダーを復活させるのです」)。
   *
   * ⚠ 直す前は `archetype !== 'todo'` を弾いていた ── **todo は封印中**なので、
   *   その規則では**この面に何かを出せる人が居ない**(解いても空のままになる)。
   */
  it('🔴 普通のノートも date を持てば出る(todo に限らない)', () => {
    const { d, q } = setup(
      [
        meta('n1', { archetype: 'text', status: null, date: '2026-08-03' }),
        meta('n2', { archetype: 'folder', status: null, date: '2026-08-03' }),
      ],
      {},
    );
    showView(d, 'calendar');
    const cell = q('[data-pkc-date="2026-08-03"]')!;
    expect(
      [...cell.querySelectorAll('[data-pkc-entry]')].map((e) => e.getAttribute('data-pkc-entry')),
      '普通のノートがカレンダーに出ない',
    ).toEqual(['n1', 'n2']);
    // ⚠ 状態は**書いてあるときだけ**出す(既定値「未完了」を作らない)
    expect(
      cell.querySelector('[data-pkc-entry="n1"]')?.hasAttribute('data-pkc-status'),
      '書いていない状態が付いた',
    ).toBe(false);
  });

  /**
   * 🔴 **読むだけにしない**(#276 の 4)── 日付の地を押すと、選んでいるノートの
   * frontmatter に `date` が入る。
   * 🔑 観測点は **store へ届いた本文**(画面だけ変わって保存されない、を作らない)。
   */
  it('🔴 日を押すと、選んでいるノートに日付が入る(本文に書かれる)', async () => {
    const { d, q, persisted, store } = setup(
      [meta('n1', { archetype: 'text', status: null })],
      { n1: '# 予定\n' },
    );
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    showView(d, 'calendar');
    q<HTMLElement>('[data-pkc-date="2026-08-07"]')!.click();
    await tick(20);
    expect(persisted, '書込が出ていない').toHaveLength(1);
    expect(store['n1'], '本文に日付が入っていない').toBe('---\ndate: 2026-08-07\n---\n# 予定\n');
    // 🔴 列にも入る(= 次の描画でカレンダーに出る)
    expect(d.getState().entryMetas.get('n1')?.date).toBe('2026-08-07');
    /**
     * 🔴 **抽出は「そのノートのアーキタイプ」で行う**(#276)。
     * ⚠ 'todo' に固定したままだと、普通のノートに **`status: open` が生える**
     *   ── 書いていない状態が付き、カンバンにも勝手に並ぶ。
     *   ⚠ 日付だけを見ていると**この取り違えを見逃す**(todo でも日付は入る)。
     */
    expect(
      d.getState().entryMetas.get('n1')?.status,
      '書いていない状態が生えた(抽出が todo に固定されている)',
    ).toBeNull();
    expect(
      q('[data-pkc-date="2026-08-07"]')?.querySelector('[data-pkc-entry="n1"]'),
      '入れた日に出ていない',
    ).not.toBeNull();
  });

  /** 🔑 **同じ日をもう一度押したら外れる**(付けた本人が外せない導線を作らない)。 */
  it('🔴 同じ日をもう一度押すと外れる', async () => {
    const { d, q, store } = setup(
      [meta('n1', { archetype: 'text', status: null, date: '2026-08-07' })],
      { n1: '---\ndate: 2026-08-07\n---\n# 予定\n' },
    );
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    showView(d, 'calendar');
    q<HTMLElement>('[data-pkc-date="2026-08-07"]')!.click();
    await tick(20);
    expect(store['n1'], '日付が外れていない').not.toContain('date:');
    expect(d.getState().entryMetas.get('n1')?.date).toBeNull();
  });

  /**
   * ⚠ **セルの中のノートを押したときは、そちらが勝つ**(選択の意味が変わらない)。
   * 🔑 押した所と起きることを一致させる ── 日付を変えるのは「地」を押したときだけ。
   */
  it('セルの中のノートを押したら、日付は変わらず選択が動く', async () => {
    const { d, q, persisted } = setup(
      [
        meta('n1', { archetype: 'text', status: null, date: '2026-08-07' }),
        meta('n2', { archetype: 'text', status: null }),
      ],
      { n1: '---\ndate: 2026-08-07\n---\nx', n2: 'y' },
    );
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n2' });
    showView(d, 'calendar');
    q<HTMLElement>('[data-pkc-date="2026-08-07"] [data-pkc-entry="n1"]')!.click();
    await tick(20);
    expect(d.getState().selectedLid, '選択が動いていない').toBe('n1');
    expect(persisted, 'ノートを押しただけで日付が書き換わった').toHaveLength(0);
  });

  /** ⚠ **黙って断らない**(押しても何も起きないセルを作らない)。 */
  it('🔴 何も選ばずに日を押したら、理由が出る', () => {
    const { d, q } = setup([meta('n1', { archetype: 'text', status: null })], {});
    showView(d, 'calendar');
    q<HTMLElement>('[data-pkc-date="2026-08-07"]')!.click();
    expect(d.getState().error ?? '', '無言で終わった').toContain('先に選んでください');
  });

  it('12 月から › で年を跨ぐ(reducer 正規化)', () => {
    const { d } = setup([], {});
    d.dispatch({ type: 'SET_CALENDAR_MONTH', year: 2026, month: 13 });
    expect(d.getState().calendarMonth).toEqual({ year: 2027, month: 1 });
    d.dispatch({ type: 'SET_CALENDAR_MONTH', year: 2027, month: 0 });
    expect(d.getState().calendarMonth).toEqual({ year: 2026, month: 12 });
  });

  it('view 切替は pane の hidden 付替のみ(detail の DOM は生きている)', async () => {
    const { d, root } = setup([meta('e1')], { e1: '# 本文' });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'e1' });
    await tick();
    const detailPane = root.querySelector<HTMLElement>('[data-pkc-view-pane="detail"]')!;
    const bodyBefore = detailPane.querySelector('[data-pkc-field="detail-body"]');
    expect(bodyBefore).not.toBeNull();

    showView(d, 'kanban');
    expect(detailPane.hidden).toBe(true);
    showView(d, 'detail');
    expect(detailPane.hidden).toBe(false);
    // 中身は作り直されていない(常駐 pane ── ノード同一)
    expect(detailPane.querySelector('[data-pkc-field="detail-body"]')).toBe(bodyBefore);
  });
});

/**
 * 🔴 **完了は畳んで下へ落とす**(2026-08-20。設計 doc §4-4)。
 *
 * ⚠ 直す前は「完了」列に**打ち消し線で残り続けて**いた ── 市井の 6 実装を
 *   当たったが、この形は 1 つも無かった(どれも畳むか、別の場所へ落とす)。
 * 🔴 ただし **畳むことと隠すことは違う** ── 件数は必ず見えていなければ、
 *   user は「やったはずのものが無い」と読む。
 */
describe('板の「完了」は畳む(2026-08-20)', () => {
  /**
   * ⚠ **札は走査の結果から来る**(本文からではない)── `SET_TASK_SCAN` を撃たないと
   *   盤面は 0 件のままである(1 稿目はここを忘れて「件数が出ない」と読み違えた)。
   */
  const feedCards = (d: Dispatcher, cards: { lid: string; line: number; text: string; done: boolean }[]) =>
    d.dispatch({
      type: 'SET_TASK_SCAN',
      scan: { cards, totalNotes: 1, scannedNotes: 1, truncated: false },
    });

  const head = (q: (s: string) => Element | null): string =>
    q('[data-pkc-kanban-status="done"] [data-pkc-field="kanban-column-label"]')?.textContent ?? '';
  const doneHost = (q: (s: string) => Element | null): HTMLElement =>
    q('[data-pkc-kanban-status="done"] [data-pkc-region="kanban-cards"]') as HTMLElement;

  it('🔴 既定は畳まれていて、件数は見えている', () => {
    const { d, q } = setup([meta('e1')], { e1: '- [ ] あ\n- [x] い\n- [x] う\n' });
    showView(d, 'kanban');
    feedCards(d, [
      { lid: 'e1', line: 0, text: 'あ', done: false },
      { lid: 'e1', line: 1, text: 'い', done: true },
      { lid: 'e1', line: 2, text: 'う', done: true },
    ]);
    expect(doneHost(q).hidden, '既定で開いている(市井の 6 実装に無い形)').toBe(true);
    expect(head(q), '畳んだのに件数が出ていない(やったものが消えたように見える)').toBe(
      '▸ 完了(2)',
    );
    // ⚠ **札は作ったまま**(開くたびに組み直さない ── 器を捨てない)
    expect(
      doneHost(q).querySelectorAll('[data-pkc-entry]').length,
      '畳むときに札を捨てている(開いた瞬間に作り直しになる)',
    ).toBe(2);
  });

  it('🔴 見出しを押すと 1 操作で開き、もう一度で畳む', () => {
    const { d, q } = setup([meta('e1')], { e1: '- [ ] あ\n- [x] い\n' });
    showView(d, 'kanban');
    feedCards(d, [
      { lid: 'e1', line: 0, text: 'あ', done: false },
      { lid: 'e1', line: 1, text: 'い', done: true },
    ]);
    const btn = () =>
      q('[data-pkc-kanban-status="done"] [data-pkc-action="toggle-show-done"]') as HTMLElement;
    btn().click();
    expect(doneHost(q).hidden, '押しても開かない').toBe(false);
    expect(head(q), '開いたのに印が変わらない').toBe('▾ 完了(1)');
    btn().click();
    expect(doneHost(q).hidden, 'もう一度押しても畳まれない').toBe(true);
  });

  /**
   * ⚠ **「やること」側は畳めない** ── 畳んだら面が空になる。押す口も出さない
   *   (押せて何も起きないボタンは無言の dead click)。
   */
  it('やること側に畳む口は無い', () => {
    const { d, q } = setup([meta('e1')], { e1: '- [ ] あ\n' });
    showView(d, 'kanban');
    feedCards(d, [{ lid: 'e1', line: 0, text: 'あ', done: false }]);
    expect(
      q('[data-pkc-kanban-status="open"] [data-pkc-action="toggle-show-done"]'),
      'やること側にも畳む口が出ている',
    ).toBeNull();
    expect(
      (q('[data-pkc-kanban-status="open"] [data-pkc-region="kanban-cards"]') as HTMLElement).hidden,
      'やること側が畳まれている',
    ).toBe(false);
  });

  it('件数は絞り込みの後の数(画面に出ている分)を出す', () => {
    const { d, q } = setup([meta('e1', { title: 'あ' }), meta('e2', { title: 'い' })], {
      e1: '- [x] 済み A\n',
      e2: '- [x] 済み B\n',
    });
    showView(d, 'kanban');
    feedCards(d, [
      { lid: 'e1', line: 0, text: '済み A', done: true },
      { lid: 'e2', line: 0, text: '済み B', done: true },
    ]);
    expect(head(q)).toBe('▸ 完了(2)');
    d.dispatch({ type: 'SET_ENTRY_FILTER', query: 'あ' });
    expect(head(q), '絞り込みで消えた分まで数えている').toBe('▸ 完了(1)');
  });
});

/**
 * 🔴 **開いている面を、その場で閉じられる**(user 目線レビュー U-3、2026-08-22)。
 *
 * ## 直す前に起きていたこと
 *
 * user はフォルダタブでノートを選び、**アプリ** → **カレンダー** を開く。
 * 日付を付けるためにフォルダタブへ戻る(カレンダーは開いたまま)。
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
    // ⚠ **全部の面を通す** ── 1 面だけ抜けるのがこの機構の壊れ方である
    const views: ViewMode[] = ['calendar', 'kanban', 'query', 'dual', 'settings', 'flags', 'help'];
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
    showView(s.d, 'calendar');
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
