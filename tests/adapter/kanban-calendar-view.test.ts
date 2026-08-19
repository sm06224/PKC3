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
import { extractMeta } from '../../src/features/flavor';
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
    ...over,
  };
}

/**
 * 🔒 かんばん / カレンダーは**封印中**(`features/sealed.ts`)なので、切替ボタンが
 * 画面に無い。導線ではなく直接 dispatch で見せる ── **封印は導線を畳んだだけで、
 * 描画も state も生きている**という事実を、この test 自身が示している。
 * 封印を解いたら、ここをボタンのクリックへ戻す。
 */
function showView(d: Dispatcher, mode: ViewMode): void {
  d.dispatch({ type: 'SET_VIEW_MODE', mode });
}

async function tick(ms = 10): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

function setup(metas: EntryMeta[], bodies: Record<string, string>) {
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

describe('kanban view (P3-6)', () => {
  it('列振り分け → トグル実クリック → splice 書換が store に届き、カードが列を移る', async () => {
    const { d, q, qa, persisted, store } = setup(
      [
        meta('e1'),
        meta('e2', { status: 'done' }),
        meta('e3', { archived: true }),
        meta('e4', { archetype: 'text', status: null }),
      ],
      { e1: '---\nstatus: open\n---\n\n買い物メモ' },
    );
    showView(d, 'kanban');

    const colOpen = q('[data-pkc-kanban-status="open"] [data-pkc-region="kanban-cards"]')!;
    const colDone = q('[data-pkc-kanban-status="done"] [data-pkc-region="kanban-cards"]')!;
    expect([...colOpen.children].map((c) => c.getAttribute('data-pkc-entry'))).toEqual(['e1']);
    expect([...colDone.children].map((c) => c.getAttribute('data-pkc-entry'))).toEqual(['e2']);
    expect(qa('[data-pkc-entry="e3"]')).toHaveLength(0); // archived は出ない

    const doneCardBefore = q('[data-pkc-entry="e2"]');
    q<HTMLElement>('[data-pkc-entry="e1"] [data-pkc-action="toggle-todo"]')!.click();
    await tick(20);

    // 書込は splice 済み body + 抽出列(roundtrip pin: 列 = body 再抽出)
    expect(persisted).toHaveLength(1);
    const row = persisted[0]!;
    expect(row.body).toBe('---\nstatus: done\n---\n\n買い物メモ'); // 本文 byte 無傷
    expect({ status: row.status, date: row.date, archived: row.archived }).toEqual(
      extractMeta('todo', row.body),
    );
    expect(store['e1']).toBe(row.body);

    // ack でカードが done 列へ移り、既存カードは同一ノードのまま
    expect([...colOpen.children]).toHaveLength(0);
    expect([...colDone.children].map((c) => c.getAttribute('data-pkc-entry'))).toEqual([
      'e1',
      'e2',
    ]);
    expect(q('[data-pkc-entry="e2"]')).toBe(doneCardBefore);
    expect(d.getState().entryMetas.get('e1')?.status).toBe('done');
  });

  it('列間 move は O(1): 先頭トグルで後続カードが insertBefore されない(cursor 汚染 pin)', async () => {
    const metas = Array.from({ length: 8 }, (_, i) =>
      meta('e' + i, { status: 'open' }),
    );
    const { d, q } = setup(metas, {
      e0: '---\nstatus: open\n---\nx',
    });
    showView(d, 'kanban');
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
    q<HTMLElement>('[data-pkc-entry="e0"] [data-pkc-action="toggle-todo"]')!.click();
    await tick(20);

    expect([...doneHost.children].map((c) => c.getAttribute('data-pkc-entry'))).toEqual([
      'e0',
    ]);
    expect([...openHost.children]).toHaveLength(7);
    // 移動カード 1 枚の done 列への挿入だけ ── 後続 7 枚は動かない
    // (review #1: 修正前は移動元列の cursor 汚染で後続全カードが move した)
    expect(moves).toBe(1);
    // 行粒度 patch の pin(review #3): 列移動後のトグル印が「済」の図案に変わっている
    // ⚠ P9 段③ で図案が単色 SVG になった ── 見るのは `textContent` ではなく
    //    **どの図案が入っているか**(`data-pkc-icon-name`)と、中身が空でないこと
    const toggleBtn = q('[data-pkc-entry="e0"] [data-pkc-action="toggle-todo"]')!;
    expect(toggleBtn.getAttribute('data-pkc-icon-name')).toBe('check-box');
    expect(toggleBtn.querySelector('svg path'), 'トグルの図案が空').not.toBeNull();
    // data-pkc-entry は entry 要素(カード)専用 ── ボタンには付かない(P3-7a 規約)
    expect(toggleBtn.hasAttribute('data-pkc-entry')).toBe(false);
  });

  it('選択中 entry のトグル ack は openBody(body/baseline/persisted)を disk に揃える(review #2 pin)', async () => {
    const pre = '---\nstatus: open\n---\nメモ';
    const { d, q } = setup([meta('e1')], { e1: pre });
    showView(d, 'kanban');
    q<HTMLElement>('[data-pkc-entry="e1"]')!.click(); // 選択 → openBody 確立
    await tick();
    expect(d.getState().openBody?.body).toBe(pre);

    q<HTMLElement>('[data-pkc-entry="e1"] [data-pkc-action="toggle-todo"]')!.click();
    await tick(20);
    const toggled = '---\nstatus: done\n---\nメモ';
    // ready の openBody は丸ごと disk へ追従 ── stale baseline を残すと次の
    // commit がトグルを黙って巻き戻す(review #2 の退行シナリオ)
    expect(d.getState().openBody).toEqual({
      lid: 'e1',
      body: toggled,
      baseline: toggled,
      persisted: toggled,
      diskAhead: false,
    });
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

  it('トグル失敗は非致命 ── phase は ready のまま、通知が出て再クリックで復帰(review #1)', async () => {
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
      getBody: async () => '---\nstatus: open\n---\nx',
      deleteEntry: async () => {},
    setEntryParent: async () => {},
      persistEntry: async (e) => {
        if (failNext) throw new Error('flaky');
        persisted.push(e);
        return stubStamps();
      },
    });
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('e1')], relations: [] });
    showView(d, 'kanban');
    root
      .querySelector<HTMLElement>('[data-pkc-entry="e1"] [data-pkc-action="toggle-todo"]')!
      .click();
    await tick(20);
    expect(d.getState().phase).toBe('ready'); // app は死なない
    expect(d.getState().error).toMatch(/flaky/); // ただし黙らない
    failNext = false;
    root
      .querySelector<HTMLElement>('[data-pkc-entry="e1"] [data-pkc-action="toggle-todo"]')!
      .click();
    await tick(20);
    expect(persisted).toHaveLength(1); // 再クリック = retry
    expect(d.getState().entryMetas.get('e1')?.status).toBe('done');
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
