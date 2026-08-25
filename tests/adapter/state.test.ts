import { stubStamps } from '../helpers/store-stamps';
import { describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import type { EntryUpsert } from '../../src/adapter/platform/storage/schema';
import { extractMeta } from '../../src/features/flavor';
import {
  VIEW_MODES,
  initialState,
  nextViewMode,
  reduce,
  type AppState,
} from '../../src/adapter/state/app-state';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects, type StorePort } from '../../src/adapter/state/store-effects';
import { stubRevisionOps } from '../helpers/revision-stub';

function meta(lid: string, order: number): EntryMeta {
  return {
    lid,
    title: 't-' + lid,
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

function booted() {
  return reduce(initialState, {
    type: 'SYS_BOOTED',
    cid: 'c1',
    metas: [meta('a', 2), meta('b', 1)],
    relations: [],
  }).state;
}

function loadedA() {
  let s = booted();
  s = reduce(s, { type: 'SELECT_ENTRY', lid: 'a' }).state;
  s = reduce(s, { type: 'BODY_LOADED', lid: 'a', body: '# A' }).state;
  return s;
}

describe('reducer: lean aggregate', () => {
  it('SYS_BOOTED sorts order by entry_order and holds metas only', () => {
    const s = booted();
    expect(s.phase).toBe('ready');
    expect(s.order).toEqual(['b', 'a']);
    expect(s.entryMetas.size).toBe(2);
  });

  it('re-boot resets selection and openBody (no cross-container carry-over)', () => {
    let s = loadedA();
    s = reduce(s, {
      type: 'SYS_BOOTED',
      cid: 'c2',
      metas: [meta('a', 1)],
      relations: [],
    }).state;
    expect(s.cid).toBe('c2');
    expect(s.selectedLid).toBeNull();
    expect(s.openBody).toBeNull();
  });

  it('SELECT_ENTRY requests body and drops previous openBody', () => {
    const r1 = reduce(booted(), { type: 'SELECT_ENTRY', lid: 'a' });
    expect(r1.state.selectedLid).toBe('a');
    expect(r1.state.openBody).toBeNull();
    // ⚠ #348 で **選択が動いた 1 か所**から参照元も引くようになった ──
    //    等値のまま**両方**書く(`toContainEqual` へ緩めると、余計な event が
    //    増えても気づけなくなる)
    expect(r1.events).toEqual([
      { type: 'REQUEST_BODY', lid: 'a' },
      { type: 'REQUEST_BACKLINKS', lid: 'a' },
    ]);
  });

  it('re-selecting the same entry re-requests body while openBody is absent (retry path)', () => {
    let s = booted();
    s = reduce(s, { type: 'SELECT_ENTRY', lid: 'a' }).state;
    // 読み失敗などで openBody が無いまま同じ entry を再クリック → 再要求される
    const retry = reduce(s, { type: 'SELECT_ENTRY', lid: 'a' });
    // ⚠ 同じノートの再選択なので**参照元は引き直さない**(選択は動いていない)
    expect(retry.events).toEqual([{ type: 'REQUEST_BODY', lid: 'a' }]);
    // openBody 確立後の同一選択は no-op
    s = reduce(s, { type: 'BODY_LOADED', lid: 'a', body: '# A' }).state;
    expect(reduce(s, { type: 'SELECT_ENTRY', lid: 'a' }).events).toEqual([]);
  });

  it('stale BODY_LOADED (selection moved) is discarded', () => {
    let s = booted();
    s = reduce(s, { type: 'SELECT_ENTRY', lid: 'a' }).state;
    s = reduce(s, { type: 'BODY_LOADED', lid: 'b', body: 'stale' }).state;
    expect(s.openBody).toBeNull();
  });

  it('BODY_LOADED during editing is discarded (does not clobber typed input)', () => {
    let s = loadedA();
    s = reduce(s, { type: 'START_EDIT' }).state;
    s = reduce(s, { type: 'UPDATE_OPEN_BODY', body: 'typing…' }).state;
    // 遅延到着した同 lid の応答が入力を巻き戻さない(review B)
    s = reduce(s, { type: 'BODY_LOADED', lid: 'a', body: '# A(old)' }).state;
    expect(s.openBody?.body).toBe('typing…');
    expect(s.openBody?.baseline).toBe('# A');
  });

  it('stale BODY_LOAD_FAILED is discarded', () => {
    let s = booted();
    s = reduce(s, { type: 'SELECT_ENTRY', lid: 'a' }).state;
    const r = reduce(s, { type: 'BODY_LOAD_FAILED', lid: 'b', error: 'x' });
    expect(r.events).toEqual([]);
  });

  it('START_EDIT is a no-op until the selected body is loaded (unread-body guard)', () => {
    let s = booted();
    s = reduce(s, { type: 'SELECT_ENTRY', lid: 'a' }).state;
    expect(reduce(s, { type: 'START_EDIT' }).state.phase).toBe('ready');
    s = reduce(s, { type: 'BODY_LOADED', lid: 'a', body: '# A' }).state;
    expect(reduce(s, { type: 'START_EDIT' }).state.phase).toBe('editing');
  });

  it('editing blocks SELECT_ENTRY / SET_VIEW_MODE / UPDATE outside editing', () => {
    let s = loadedA();
    s = reduce(s, { type: 'START_EDIT' }).state;
    expect(reduce(s, { type: 'SELECT_ENTRY', lid: 'b' }).state.selectedLid).toBe('a');
    expect(reduce(s, { type: 'SET_VIEW_MODE', mode: 'query' }).state.viewMode).toBe(
      'detail',
    );
    /**
     * 🔴 **断るなら、声に出して断る**(user 目線レビュー U-2、2026-08-22)。
     *
     * ⚠ 直す前は `events: []` で**黙って捨てて**いた ── 押しても画面が 1 ドットも
     *   動かず、帯にも何も出ない。user から見ると「タイルが壊れている」としか
     *   見えない(実際 user から「動線がクソだし、直感的ではない」と指摘された)。
     * 🔑 **呼び名は画面の字と同じにする** ── 断り文に `query` と出ると
     *   user は別のものを探す。
     * ⚠ **断られる面は 1 つだけになった**(#292 段⑤、2026-08-23)── カレンダー /
     *   やることの板は中央から降りたので、残るノートを並べる面は**集計**である。
     *   だから「面ごとに呼び名が変わるか」はここでは見られない ── 呼び名の全数は
     *   `viewModeLabel` が `Record<ViewMode, string>` である(足し忘れは tsc が落とす)
     *   ことと、`tests/docs-parity.test.ts` §4-1 の等値 pin が守る。
     */
    const refused = reduce(s, { type: 'SET_VIEW_MODE', mode: 'query' }).state;
    expect(refused.error, '黙って捨てている(無言の dead click)').toBe(
      '編集中は集計を開けません(保存するか、取り消してください)',
    );
    // ⚠ 対照群 ── 開ける面では理由を出さない(常在する断り文を作らない)
    expect(
      reduce(s, { type: 'SET_VIEW_MODE', mode: 'help' }).state.error,
      '開けたのに断り文が出た',
    ).toBeNull();
    /**
     * 🔴 **ただし「ノートを映さない面」は編集中でも開ける**(user 裁定 2026-08-08。
     * P11 の Q5 を覆した)。⚠ ここを塞ぐと「書きながらマニュアルを読む」が
     * できない ── ヘルプの主目的である。
     */
    expect(
      reduce(s, { type: 'SET_VIEW_MODE', mode: 'help' }).state.viewMode,
      '編集中にヘルプを開けない(無言の dead click)',
    ).toBe('help');
    /**
     * 🔴 **そして本文へ戻れる**(2026-08-19、リリース前監査で判明)。
     *
     * ⚠ 直す前は `'detail'` への切替も編集中は捨てられていたので、
     * **開いたら最後、同じボタンをもう一度押しても本文へ戻れなかった**
     * (`set-view` のトグルは `'detail'` を撃つ)── マニュアルは
     * 「**寄り道して戻っても**、打ちかけの本文も取り消しもそのまま残ります」と
     * 約束しており、**その約束が守られていなかった**。
     * 🔑 編集の面は `detail` **そのもの**なので、戻るのは「編集へ帰る」である。
     */
    const away = reduce(s, { type: 'SET_VIEW_MODE', mode: 'help' }).state;
    const back = reduce(away, { type: 'SET_VIEW_MODE', mode: 'detail' });
    expect(back.state.viewMode, '編集中に開いたら本文へ戻れない(片道の袋小路)').toBe(
      'detail',
    );
    expect(back.state.phase, '戻ったら編集が終わっていた').toBe('editing');
    expect(back.state.openBody?.body, '戻ったら打ちかけが消えていた').toBe('# A');
    // editing 外での UPDATE_OPEN_BODY は無効
    const ready = loadedA();
    expect(
      reduce(ready, { type: 'UPDATE_OPEN_BODY', body: 'x' }).state.openBody?.body,
    ).toBe('# A');
  });

  it('COMMIT_EDIT emits PERSIST_ENTRY with the full row, and skips when unchanged', () => {
    let s = loadedA();
    s = reduce(s, { type: 'START_EDIT' }).state;

    const unchanged = reduce(s, { type: 'COMMIT_EDIT' });
    expect(unchanged.events).toEqual([]);
    expect(unchanged.state.phase).toBe('ready');

    s = reduce(s, { type: 'UPDATE_OPEN_BODY', body: '# A2' }).state;
    const committed = reduce(s, { type: 'COMMIT_EDIT' });
    expect(committed.events).toEqual([
      {
        type: 'PERSIST_ENTRY',
        // P5c: 変更ありの commit は checkpoint 付き(変更前 body の記録は worker が
        // 同 tx で行う ── event は「刻む意思」だけを運ぶ)
        checkpoint: true,
        entry: {
          lid: 'a',
          title: 't-a',
          archetype: 'text',
          body: '# A2',
          entryOrder: 2,
          status: null,
          date: null,
          archived: false,
        },
      },
    ]);
    expect(committed.state.openBody?.baseline).toBe('# A2');
    // text フレーバーの commit は抽出値が変わらない ── entryMetas の参照を壊さない
    // (sidebar は参照 fingerprint で差分検出するため)
    expect(committed.state.entryMetas).toBe(s.entryMetas);
  });

  it('COMMIT_EDIT extracts flavor columns at reduce time (roundtrip pin, review K/C-1)', () => {
    const todoMeta: EntryMeta = { ...meta('td', 1), archetype: 'todo' };
    let s = reduce(initialState, {
      type: 'SYS_BOOTED',
      cid: 'c1',
      metas: [todoMeta],
      relations: [],
    }).state;
    s = reduce(s, { type: 'SELECT_ENTRY', lid: 'td' }).state;
    s = reduce(s, {
      type: 'BODY_LOADED',
      lid: 'td',
      body: '---\nstatus: open\n---\n買い物',
    }).state;
    s = reduce(s, { type: 'START_EDIT' }).state;
    s = reduce(s, {
      type: 'UPDATE_OPEN_BODY',
      body: '---\nstatus: done\ndate: 2026-08-01\narchived: true\n---\n買い物',
    }).state;
    const r = reduce(s, { type: 'COMMIT_EDIT' });

    const ev = r.events.find((e) => e.type === 'PERSIST_ENTRY');
    if (ev?.type !== 'PERSIST_ENTRY') throw new Error('PERSIST_ENTRY expected');
    // 抽出列は body(frontmatter)と同一事実 ── event の行が既に一致している
    // (worker は素通しなので、書込境界のこの一致が roundtrip の pin)
    expect(ev.entry.status).toBe('done');
    expect(ev.entry.date).toBe('2026-08-01');
    expect(ev.entry.archived).toBe(true);
    // 常駐 meta も同じ reduce で追従(sidebar / 予定が古い列を見ない)
    const m = r.state.entryMetas.get('td');
    expect(m?.status).toBe('done');
    expect(m?.date).toBe('2026-08-01');
    expect(m?.archived).toBe(true);
    expect(r.state.entryMetas).not.toBe(s.entryMetas);
  });

  it('commit does not confirm disk: persisted updates only on BODY_PERSISTED ack (review E)', () => {
    let s = loadedA();
    s = reduce(s, { type: 'START_EDIT' }).state;
    s = reduce(s, { type: 'UPDATE_OPEN_BODY', body: '# A2' }).state;
    s = reduce(s, { type: 'COMMIT_EDIT' }).state;
    // enqueue と ack を混同しない: baseline は commit で、persisted は ack で動く
    expect(s.openBody).toMatchObject({ body: '# A2', baseline: '# A2', persisted: '# A' });
    s = reduce(s, { type: 'BODY_PERSISTED', lid: 'a', body: '# A2' }).state;
    expect(s.openBody?.persisted).toBe('# A2');
  });

  it('stale BODY_PERSISTED (selection moved, openBody replaced) is discarded', () => {
    let s = loadedA();
    // 選択が b へ移り openBody は破棄 → 旧 lid の ack は無視
    s = reduce(s, { type: 'SELECT_ENTRY', lid: 'b' }).state;
    s = reduce(s, { type: 'BODY_LOADED', lid: 'b', body: 'B' }).state;
    s = reduce(s, { type: 'BODY_PERSISTED', lid: 'a', body: '# A2' }).state;
    expect(s.openBody).toMatchObject({ lid: 'b', persisted: 'B' });
  });

  it('cancel after an in-flight commit restores the committed content, not pre-commit', () => {
    let s = loadedA();
    s = reduce(s, { type: 'START_EDIT' }).state;
    s = reduce(s, { type: 'UPDATE_OPEN_BODY', body: '# A2' }).state;
    s = reduce(s, { type: 'COMMIT_EDIT' }).state; // ack 未着
    s = reduce(s, { type: 'START_EDIT' }).state;
    s = reduce(s, { type: 'UPDATE_OPEN_BODY', body: 'draft' }).state;
    s = reduce(s, { type: 'CANCEL_EDIT' }).state;
    expect(s.openBody?.body).toBe('# A2'); // 直前 commit へ戻る(disk 未確認でも)
  });

  it('re-committing the original content after an intermediate commit still writes (A→B→A)', () => {
    let s = loadedA();
    s = reduce(s, { type: 'START_EDIT' }).state;
    s = reduce(s, { type: 'UPDATE_OPEN_BODY', body: '# B' }).state;
    s = reduce(s, { type: 'COMMIT_EDIT' }).state;
    s = reduce(s, { type: 'START_EDIT' }).state;
    s = reduce(s, { type: 'UPDATE_OPEN_BODY', body: '# A' }).state;
    const r = reduce(s, { type: 'COMMIT_EDIT' });
    // skip 基準は「最後に enqueue した内容」(baseline)── 元に戻す commit も書く
    expect(r.events).toHaveLength(1);
    expect(r.events[0]).toMatchObject({ type: 'PERSIST_ENTRY', checkpoint: true });
  });

  it('TOGGLE_TODO_STATUS: reduce 時に meta snapshot を捕獲し、state は ack まで動かさない', () => {
    const todo: EntryMeta = { ...meta('td', 3), archetype: 'todo', status: 'open' };
    let s = reduce(initialState, {
      type: 'SYS_BOOTED',
      cid: 'c1',
      metas: [todo],
      relations: [],
    }).state;
    const r = reduce(s, { type: 'TOGGLE_TODO_STATUS', lid: 'td' });
    expect(r.events).toEqual([
      {
        type: 'REQUEST_BODY_REWRITE',
        lid: 'td',
        title: 't-td',
        archetype: 'todo',
        entryOrder: 3,
        rewrite: { kind: 'frontmatter', keys: { status: 'done' } },
      },
    ]);
    expect(r.state.entryMetas).toBe(s.entryMetas); // ack までカードは動かない
    // editing 中は発火しない
    s = reduce(s, { type: 'SELECT_ENTRY', lid: 'td' }).state;
    s = reduce(s, { type: 'BODY_LOADED', lid: 'td', body: 'x' }).state;
    s = reduce(s, { type: 'START_EDIT' }).state;
    expect(reduce(s, { type: 'TOGGLE_TODO_STATUS', lid: 'td' }).events).toEqual([]);
  });

  it('BODY_REWRITTEN: 編集中の同一 entry では draft を触らず persisted だけ追従', () => {
    const todo: EntryMeta = { ...meta('td', 1), archetype: 'todo' };
    let s = reduce(initialState, {
      type: 'SYS_BOOTED',
      cid: 'c1',
      metas: [todo],
      relations: [],
    }).state;
    s = reduce(s, { type: 'SELECT_ENTRY', lid: 'td' }).state;
    s = reduce(s, { type: 'BODY_LOADED', lid: 'td', body: '---\nstatus: open\n---\nx' }).state;
    s = reduce(s, { type: 'START_EDIT' }).state;
    s = reduce(s, { type: 'UPDATE_OPEN_BODY', body: 'draft…' }).state;
    const toggledBody = '---\nstatus: done\n---\nx';
    s = reduce(s, {
      type: 'BODY_REWRITTEN',
      lid: 'td',
      body: toggledBody,
      rewrite: { kind: 'frontmatter', keys: { status: 'done' } },
      status: 'done',
      date: null,
      archived: false,
    }).state;
    expect(s.openBody?.body).toBe('draft…'); // draft は無傷
    expect(s.openBody?.persisted).toBe(toggledBody); // disk 事実は追従
    expect(s.entryMetas.get('td')?.status).toBe('done');
  });

  it('editing 窓に落ちた toggle ack は無変更 commit / cancel で disk が勝つ(review #4)', () => {
    const todo: EntryMeta = { ...meta('td', 1), archetype: 'todo' };
    const pre = '---\nstatus: open\n---\nx';
    const toggled = '---\nstatus: done\n---\nx';
    const boot = () => {
      let s = reduce(initialState, {
        type: 'SYS_BOOTED',
        cid: 'c1',
        metas: [todo],
        relations: [],
      }).state;
      s = reduce(s, { type: 'SELECT_ENTRY', lid: 'td' }).state;
      s = reduce(s, { type: 'BODY_LOADED', lid: 'td', body: pre }).state;
      s = reduce(s, { type: 'START_EDIT' }).state;
      // 編集中に toggle ack が着弾(draft は不触・persisted のみ追従)
      return reduce(s, {
        type: 'BODY_REWRITTEN',
        lid: 'td',
        body: toggled,
        rewrite: { kind: 'frontmatter', keys: { status: 'done' } },
        status: 'done',
        date: null,
        archived: false,
      }).state;
    };
    // 無変更 commit: pre-toggle の body を書き戻さず、disk(toggled)を採用
    const committed = reduce(boot(), { type: 'COMMIT_EDIT' });
    expect(committed.events).toEqual([]);
    expect(committed.state.openBody).toMatchObject({
      body: toggled,
      baseline: toggled,
      persisted: toggled,
    });
    // cancel も同じく disk へ
    const cancelled = reduce(boot(), { type: 'CANCEL_EDIT' });
    expect(cancelled.state.openBody?.body).toBe(toggled);
    // 以後の再編集は toggled を基底にする ── 後日の commit がトグルを巻き戻さない
  });

  it('CANCEL_EDIT restores baseline', () => {
    let s = loadedA();
    s = reduce(s, { type: 'START_EDIT' }).state;
    s = reduce(s, { type: 'UPDATE_OPEN_BODY', body: 'draft' }).state;
    s = reduce(s, { type: 'CANCEL_EDIT' }).state;
    expect(s.phase).toBe('ready');
    expect(s.openBody?.body).toBe('# A');
  });

  it('error 通知は SELECT_ENTRY 単独でクリアされる(個別 pin)', () => {
    let s = booted();
    s = reduce(s, { type: 'SELECT_ENTRY', lid: 'a' }).state;
    s = reduce(s, { type: 'BODY_LOAD_FAILED', lid: 'a', error: 'x' }).state;
    expect(s.error).toMatch(/x/);
    s = reduce(s, { type: 'SELECT_ENTRY', lid: 'b' }).state;
    expect(s.error).toBeNull();
  });

  it('error 通知は BODY_LOADED 単独でクリアされる(個別 pin)', () => {
    let s = booted();
    s = reduce(s, { type: 'SELECT_ENTRY', lid: 'a' }).state;
    s = reduce(s, { type: 'BODY_LOAD_FAILED', lid: 'a', error: 'x' }).state;
    s = reduce(s, { type: 'BODY_LOADED', lid: 'a', body: 'ok' }).state;
    expect(s.error).toBeNull();
    expect(s.openBody?.body).toBe('ok');
  });

  it('error phase の SELECT_ENTRY はブロック ── 未達 commit(唯一の写し)を無警告破棄しない', () => {
    let s = loadedA();
    s = reduce(s, { type: 'START_EDIT' }).state;
    s = reduce(s, { type: 'UPDATE_OPEN_BODY', body: '# v2' }).state;
    s = reduce(s, { type: 'COMMIT_EDIT' }).state;
    s = reduce(s, { type: 'SYS_ERROR', error: 'disk full' }).state;
    expect(s.phase).toBe('error');
    const after = reduce(s, { type: 'SELECT_ENTRY', lid: 'b' }).state;
    expect(after).toBe(s); // 完全 no-op(openBody / error / 選択すべて保持)
    expect(after.openBody?.baseline).toBe('# v2');
  });

  it('editing 中の SYS_ERROR は editing を維持する ── draft を破壊しない(review #3)', () => {
    let s = loadedA();
    s = reduce(s, { type: 'START_EDIT' }).state;
    s = reduce(s, { type: 'UPDATE_OPEN_BODY', body: 'draft…' }).state;
    s = reduce(s, { type: 'SYS_ERROR', error: 'late persist failure' }).state;
    expect(s.phase).toBe('editing'); // editor は生きたまま
    expect(s.openBody?.body).toBe('draft…');
    expect(s.error).toMatch(/late persist failure/);
  });

  it('error phase への toggle ack は baseline に status を合流(両方の意図を保全 ── review #4)', () => {
    const todo: EntryMeta = { ...meta('td', 1), archetype: 'todo' };
    const pre = '---\nstatus: open\n---\nv1';
    let s = reduce(initialState, {
      type: 'SYS_BOOTED',
      cid: 'c1',
      metas: [todo],
      relations: [],
    }).state;
    s = reduce(s, { type: 'SELECT_ENTRY', lid: 'td' }).state;
    s = reduce(s, { type: 'BODY_LOADED', lid: 'td', body: pre }).state;
    s = reduce(s, { type: 'START_EDIT' }).state;
    s = reduce(s, { type: 'UPDATE_OPEN_BODY', body: '---\nstatus: open\n---\nv2' }).state;
    s = reduce(s, { type: 'COMMIT_EDIT' }).state; // persist v2(失敗予定)
    s = reduce(s, { type: 'SYS_ERROR', error: 'disk full' }).state;
    // 後着の toggle(disk の旧内容基準)が成功して ack
    const toggledOld = '---\nstatus: done\n---\nv1';
    s = reduce(s, {
      type: 'BODY_REWRITTEN',
      lid: 'td',
      body: toggledOld,
      rewrite: { kind: 'frontmatter', keys: { status: 'done' } },
      status: 'done',
      date: null,
      archived: false,
    }).state;
    // 丸ごと差し替えず「未達の証拠」を保ったまま status を合流
    const merged = '---\nstatus: done\n---\nv2';
    expect(s.openBody).toMatchObject({
      body: merged,
      baseline: merged,
      persisted: toggledOld,
    });
    // 再保存は v2 テキスト + 新 status の両方を書く
    const r = reduce(s, { type: 'RETRY_PERSIST' });
    const ev = r.events[0];
    if (ev?.type !== 'PERSIST_ENTRY') throw new Error('PERSIST_ENTRY expected');
    expect(ev.entry.body).toBe(merged);
    expect(ev.entry.status).toBe('done');
  });

  it('SET_VIEW_MODE keeps selection (PKC2 convention)', () => {
    let s = booted();
    s = reduce(s, { type: 'SELECT_ENTRY', lid: 'a' }).state;
    s = reduce(s, { type: 'SET_VIEW_MODE', mode: 'query' }).state;
    expect(s.viewMode).toBe('query');
    expect(s.selectedLid).toBe('a');
  });
});

describe('dispatcher: re-entrancy linearization', () => {
  it('nested dispatch from a listener is queued, listeners always end on latest state', () => {
    const d = new Dispatcher();
    const seen: Array<string> = [];
    let fired = false;
    d.onState((s) => {
      if (!fired && s.selectedLid === 'a') {
        fired = true;
        d.dispatch({ type: 'SET_VIEW_MODE', mode: 'query' }); // listener 内 dispatch
      }
    });
    d.onState((s) => seen.push(`${s.selectedLid}/${s.viewMode}`));
    d.dispatch({
      type: 'SYS_BOOTED',
      cid: 'c1',
      metas: [meta('a', 1)],
      relations: [],
    });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    // 逆転しない: 最後に観測した state が最新(review G)
    expect(seen[seen.length - 1]).toBe('a/query');
    expect(d.getState().viewMode).toBe('query');
  });
});

/**
 * 🔴 **壁時計で待たない。条件で待つ**(2026-08-24)。
 *
 * ⚠ ここは元々 `setTimeout(r, 60)` のような**固定の待ち**だった ── 手元で他の仕事と
 *   並行に回したとき「ops are strictly serialized」が**1 度だけ赤**になった
 *   (単独で回すと緑、その後の全量も緑)。負荷が高い回は 60ms で 4 件揃わない。
 * ⚠ 主張(完了の順が交差しないこと)は正しいので**緩めない** ── 直すのは**待ちだけ**である。
 * 🔑 満ちなくても**必ず返る**(締切つき)── ここで投げると
 *   「何が足りなかったか」が消え、続く assert の文言のほうが読める。
 */
async function until(ok: () => boolean, budgetMs = 2000): Promise<void> {
  const limit = Date.now() + budgetMs;
  while (!ok() && Date.now() < limit) await new Promise((r) => setTimeout(r, 1));
}

describe('effect layer: serialized store I/O', () => {
  function fakeStore(log: string[], bodies: Record<string, string>): StorePort {
    return {
      ...stubRevisionOps(),
      async getBody(lid) {
        log.push('get:' + lid);
        await new Promise((r) => setTimeout(r, lid === 'a' ? 20 : 0)); // a を遅くする
        log.push('done:' + lid); // 完了順を記録(直列化の弁別に必須 ── review A)
        return bodies[lid] ?? null;
      },
      async deleteEntry() {},
      async setEntryParent() {},
      /** ⚠ **題名だけの口**(#178)── 本物は本文に触らない。 */
      renameEntry: async () => stubStamps(),
      replaceAssetRefs: () =>
        Promise.reject(new Error('この test では添付の差し替えを使わない')),
      reorderEntry: async () => stubStamps(),
      async persistEntry(entry) {
        log.push(`put:${entry.lid}:${entry.body}`);
        return stubStamps();
      },
    };
  }

  it('ops are strictly serialized: a slow op completes before the next starts (review #5 pin)', async () => {
    const log: string[] = [];
    const d = new Dispatcher();
    const off = connectStoreEffects(d, fakeStore(log, { a: 'A', b: 'B' }));
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('a', 1), meta('b', 2)], relations: [] });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' }); // 遅い get
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'b' }); // 速い get ── だが先行完了を待つ
    await until(() => log.length >= 4);
    // 完了順まで含めた非交差 assert: 非直列実装なら done:b が done:a を追い越して落ちる
    expect(log).toEqual(['get:a', 'done:a', 'get:b', 'done:b']);
    expect(d.getState().openBody?.lid).toBe('b');
    expect(d.getState().openBody?.body).toBe('B');
    off();
  });

  it('missing row is a failure, not an empty body (S3-bud guard, review C\')', async () => {
    const d = new Dispatcher();
    const off = connectStoreEffects(d, fakeStore([], {})); // 行なし
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('a', 1)], relations: [] });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    await until(() => d.getState().error !== null);
    expect(d.getState().error).toMatch(/entry row missing/); // state 駆動の可視エラー
    expect(d.getState().openBody).toBeNull(); // 「空のノート」に見せない
    off();
  });

  it('load failure sets state.error without killing the queue, cleared on recovery', async () => {
    const d = new Dispatcher();
    let calls = 0;
    const store: StorePort = {
      ...stubRevisionOps(),
      async getBody() {
        calls++;
        if (calls === 1) throw new Error('boom');
        return 'recovered';
      },
      async deleteEntry() {},
      async setEntryParent() {},
      /** ⚠ **題名だけの口**(#178)── 本物は本文に触らない。 */
      renameEntry: async () => stubStamps(),
      replaceAssetRefs: () =>
        Promise.reject(new Error('この test では添付の差し替えを使わない')),
      reorderEntry: async () => stubStamps(),
      async persistEntry() {
        return stubStamps();
      },
    };
    const off = connectStoreEffects(d, store);
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('a', 1)], relations: [] });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    await until(() => d.getState().error !== null);
    expect(d.getState().error).toMatch(/boom/); // 次の成功 / 選択まで残る
    expect(d.getState().phase).toBe('ready'); // 読み失敗で app は死なない
    // 再クリック = retry(review C): queue は生きており復帰できる
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    await until(() => d.getState().openBody?.body === 'recovered');
    expect(d.getState().openBody?.body).toBe('recovered');
    expect(d.getState().error).toBeNull(); // 成功でエラー通知はクリア
    off();
  });

  it('RETRY_PERSIST: 保存失敗から再送で復帰する(baseline≠persisted の回収)', async () => {
    const d = new Dispatcher();
    let failNext = true;
    const persisted: string[] = [];
    const store: StorePort = {
      ...stubRevisionOps(),
      async getBody() {
        return '# A';
      },
      async deleteEntry() {},
      async setEntryParent() {},
      /** ⚠ **題名だけの口**(#178)── 本物は本文に触らない。 */
      renameEntry: async () => stubStamps(),
      replaceAssetRefs: () =>
        Promise.reject(new Error('この test では添付の差し替えを使わない')),
      reorderEntry: async () => stubStamps(),
      async persistEntry(e) {
        if (failNext) throw new Error('disk full');
        persisted.push(e.body);
        return stubStamps();
      },
    };
    const off = connectStoreEffects(d, store);
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('a', 1)], relations: [] });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    await until(() => d.getState().openBody !== null);
    d.dispatch({ type: 'START_EDIT' });
    d.dispatch({ type: 'UPDATE_OPEN_BODY', body: '# A2' });
    d.dispatch({ type: 'COMMIT_EDIT' });
    await until(() => d.getState().phase === 'error');
    expect(d.getState().phase).toBe('error');
    // 未達の証拠が残っている
    expect(d.getState().openBody).toMatchObject({ baseline: '# A2', persisted: '# A' });

    failNext = false;
    d.dispatch({ type: 'RETRY_PERSIST' });
    // ⚠ `phase === 'ready'` は **RETRY を受けた時点**で真になる(書込の完了ではない)
    //    ── 待つのは**ack が届いたこと**である
    await until(() => d.getState().openBody?.persisted === '# A2');
    expect(persisted).toEqual(['# A2']); // baseline(最後の commit 内容)を再送
    expect(d.getState().phase).toBe('ready');
    expect(d.getState().error).toBeNull();
    expect(d.getState().openBody?.persisted).toBe('# A2'); // ack で回収完了
    off();
  });

  it('persist failure transitions to error phase (no silent loss today)', async () => {
    const d = new Dispatcher();
    const store: StorePort = {
      ...stubRevisionOps(),
      async getBody() {
        return '# A';
      },
      async deleteEntry() {},
      async setEntryParent() {},
      /** ⚠ **題名だけの口**(#178)── 本物は本文に触らない。 */
      renameEntry: async () => stubStamps(),
      replaceAssetRefs: () =>
        Promise.reject(new Error('この test では添付の差し替えを使わない')),
      reorderEntry: async () => stubStamps(),
      async persistEntry() {
        throw new Error('disk full');
      },
    };
    const off = connectStoreEffects(d, store);
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('a', 1)], relations: [] });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    await until(() => d.getState().openBody !== null);
    d.dispatch({ type: 'START_EDIT' });
    d.dispatch({ type: 'UPDATE_OPEN_BODY', body: 'A2' });
    d.dispatch({ type: 'COMMIT_EDIT' });
    await until(() => d.getState().phase === 'error');
    expect(d.getState().phase).toBe('error'); // 保存失敗は静かに失敗しない
    off();
  });

  it('commit flows through effects and persists exactly the open body', async () => {
    const log: string[] = [];
    const d = new Dispatcher();
    const off = connectStoreEffects(d, fakeStore(log, { a: 'A' }));
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('a', 1)], relations: [] });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    await until(() => log.includes('done:a'));
    d.dispatch({ type: 'START_EDIT' });
    d.dispatch({ type: 'UPDATE_OPEN_BODY', body: 'A2' });
    d.dispatch({ type: 'COMMIT_EDIT' });
    await until(() => log.length >= 3);
    expect(log).toEqual(['get:a', 'done:a', 'put:a:A2']);
    off();
  });

  it('persistEntry receives the reduce-time row: columns match re-extraction from body', async () => {
    const persisted: EntryUpsert[] = [];
    const d = new Dispatcher();
    const off = connectStoreEffects(d, {
    ...stubRevisionOps(),
      async getBody() {
        return '---\nstatus: open\n---\n芝刈り';
      },
      async deleteEntry() {},
      async setEntryParent() {},
      /** ⚠ **題名だけの口**(#178)── 本物は本文に触らない。 */
      renameEntry: async () => stubStamps(),
      replaceAssetRefs: () =>
        Promise.reject(new Error('この test では添付の差し替えを使わない')),
      reorderEntry: async () => stubStamps(),
      async persistEntry(entry) {
        persisted.push(entry);
        return stubStamps();
      },
    });
    d.dispatch({
      type: 'SYS_BOOTED',
      cid: 'c1',
      metas: [{ ...meta('td', 1), archetype: 'todo' }],
      relations: [],
    });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'td' });
    await until(() => d.getState().openBody !== null);
    d.dispatch({ type: 'START_EDIT' });
    d.dispatch({
      type: 'UPDATE_OPEN_BODY',
      body: '---\nstatus: done\ndate: 2026-08-02\n---\n芝刈り',
    });
    d.dispatch({ type: 'COMMIT_EDIT' });
    await until(() => persisted.length > 0);
    const row = persisted[0];
    if (!row) throw new Error('no entry persisted');
    // store 境界の roundtrip pin: 書かれた行の抽出列 = body への extract 再適用
    expect({ status: row.status, date: row.date, archived: row.archived }).toEqual(
      extractMeta(row.archetype, row.body),
    );
    expect(row.status).toBe('done');
    off();
  });

  /**
   * 読みの合図つきの店(teardown の 2 件が使う)。
   * @param entered 読みに**入った**回数 / @param resolved 読みが**解けた**か
   */
  function tracedStore(mark: { entered: number; resolved: boolean }): StorePort {
    return {
      ...stubRevisionOps(),
      async getBody() {
        mark.entered += 1;
        await new Promise((r) => setTimeout(r, 20));
        mark.resolved = true;
        return 'late';
      },
      async deleteEntry() {},
      async setEntryParent() {},
      /** ⚠ **題名だけの口**(#178)── 本物は本文に触らない。 */
      renameEntry: async () => stubStamps(),
      replaceAssetRefs: () =>
        Promise.reject(new Error('この test では添付の差し替えを使わない')),
      reorderEntry: async () => stubStamps(),
      async persistEntry() {
        return stubStamps();
      },
    };
  }

  it('teardown stops in-flight results from dispatching (review H)', async () => {
    /**
     * 🔴 **この test は 2026-08-24 まで空振りだった。**
     *
     * ⚠ 直す前は `SELECT_ENTRY` の直後に `off()` を呼び、40ms 待って
     *   「`openBody` が null」を見ていた。実測すると **`getBody` は 1 度も
     *   呼ばれていない** ── 読みは effect の鎖の先で始まるので、同期で畳むと
     *   **始まってすらいない**。つまり「飛んでいる結果を止める」という当の主張を
     *   1 度も通していなかった(CLAUDE.md §2「弱いのではなく走っていない」)。
     * 🔑 **本当に飛んでいる状態にしてから畳む** ── 読みに入った合図を待つ。
     */
    const d = new Dispatcher();
    const mark = { entered: 0, resolved: false };
    const off = connectStoreEffects(d, tracedStore(mark));
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('a', 1)], relations: [] });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    await until(() => mark.entered > 0);
    expect(mark.entered, '読みが始まっていない ── 畳む前から空振りである').toBe(1);
    off(); // 🔴 **ここで初めて in-flight のまま teardown**
    await until(() => mark.resolved);
    // ⚠ 解けた**後**の続きが回るところまで進める(合図は `return` の手前で立つ)
    for (let i = 0; i < 3; i += 1) await new Promise((r) => setTimeout(r, 0));
    expect(mark.resolved, '読みがまだ解けていない ── 空振りで緑になっている').toBe(true);
    expect(d.getState().openBody).toBeNull();
  });

  it('🔴 畳んだ後は、読みを始めない(上の test が偶然見ていたもの)', async () => {
    /**
     * ⚠ 上の test が**空振りのまま実際に見ていた**のはこちらである ──
     *   捨てるのは惜しいので、**別の主張として**残す。
     */
    const d = new Dispatcher();
    const mark = { entered: 0, resolved: false };
    const off = connectStoreEffects(d, tracedStore(mark));
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('a', 1)], relations: [] });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    off(); // ⚠ 読みが始まる**前**に畳む
    for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));
    expect(mark.entered, '畳んだのに読みを始めている').toBe(0);
    expect(d.getState().openBody).toBeNull();
  });
});

/**
 * 🔴 **ノートを映していない面を開いたまま一覧を押したら、中央をノートへ戻す**
 * (P8 段⑲ で直したバグ。P11 で面が増えたので一般化した)。
 *
 * 直す前は右の情報ペインだけ切り替わり、中央は設定のまま・追記欄も消えたままで、
 * **ノートが開かない理由が画面のどこにも無かった**(マニュアル「中央は常にいま
 * 開いているノート」の当の破れ)。
 *
 * ⚠ **この挙動には test が 1 件も無かった**(2026-08-07 に確認)。判定が
 * `viewMode === 'settings'` の**直書き**だったので、面を足すたびに取りこぼす ──
 * P11 で `isAsidePane` の集合へ寄せたうえで、ここで pin する
 * (CLAUDE.md「片側を直したら対称の反対側を疑う」)。
 */
describe('ノートでない面から、一覧を押したら中央が戻る', () => {
  // ⚠ **面を足したらここにも足す** ── 足さないと、その面だけ取りこぼす
  for (const view of ['settings', 'flags', 'help'] as const) {
    it(`🔴 ${view} を開いたまま別のノートを押すと detail へ戻る`, () => {
      let s: AppState = { ...booted(), viewMode: view };
      s = reduce(s, { type: 'SELECT_ENTRY', lid: 'a' }).state;
      expect(s.viewMode, `${view} のまま取り残された`).toBe('detail');
      expect(s.selectedLid).toBe('a');
    });

    it(`🔴 ${view} を開いたまま「いま開いているノート」を押しても戻る`, () => {
      // ⚠ 同じ lid を押す枝は**別の return** を通る ── 片方だけ直すと取りこぼす
      let s: AppState = { ...loadedA(), viewMode: view };
      s = reduce(s, { type: 'SELECT_ENTRY', lid: 'a' }).state;
      expect(s.viewMode, `${view} のまま取り残された(同一 lid の枝)`).toBe('detail');
    });
  }

  it('⚠ ノートを映している面(detail)では viewMode を触らない', () => {
    // 空振り防止 ── 何でも detail に戻す実装でも上は通ってしまう
    let s: AppState = { ...booted(), viewMode: 'query' };
    s = reduce(s, { type: 'SELECT_ENTRY', lid: 'a' }).state;
    expect(s.viewMode, '集計を勝手に畳んだ').toBe('query');
  });
});

/**
 * 🔴 **もう一度押したら本文へ戻る**(#277 段②-b で 1 か所へ寄せた規則)。
 *
 * ⚠ この規則は上の帯(`set-view`)にだけ書いてあり、**組み込みタイルから開く面**
 *   (2 ペイン #241 ほか)は素通りしていた ── 開いたら**本文へ帰るマウスの道が
 *   1 本も無い**(鍵盤の `view-detail` だけ)。
 * 🔑 帯もタイルも同じ関数を通すので、ここが唯一の pin である。
 * ⚠ 見るのは **`VIEW_MODES` の全数**(名指しの一覧にしない)── 面を足したのに
 *   ここへ足し忘れると、その面だけ**閉じられないまま**出荷される。
 */
describe('nextViewMode ── もう一度押したら本文へ戻る', () => {
  it('🔴 同じ面をもう一度指すと detail へ', () => {
    const faces = VIEW_MODES.filter((v) => v !== 'detail');
    expect(faces.length, '面が 1 つも無い(空振り)').toBeGreaterThan(0);
    for (const view of faces) {
      expect(nextViewMode(view, view), `${view} から出られない`).toBe('detail');
    }
  });

  it('違う面を指したら、その面へ行く', () => {
    expect(nextViewMode('detail', 'query')).toBe('query');
    expect(nextViewMode('query', 'dual')).toBe('dual');
  });

  /** ⚠ 既に本文に居るなら、本文を指しても本文のまま(往復しない)。 */
  it('本文から本文は本文のまま', () => {
    expect(nextViewMode('detail', 'detail')).toBe('detail');
  });
});

/**
 * 🔴 **カンバンの札は state で運ぶ**(#277 段②-b)。
 * 集計(#184)と同じ流儀:開いたときに頼み、器の入れ替えで捨て、
 * **書換の ack ではその場で組み直す**(往復を待たずに札が動く)。
 */
describe('カンバンの札(#277 段②-b)', () => {
  const scan = (
    raw: Array<{ lid: string; line: number; text: string; done: boolean; date?: string | null; time?: string | null }>,
  ) => ({
    // ⚠ 日付は既定 `null`(= 日付のないチェック項目)── 書く test だけが渡す
    cards: raw.map((c) => ({ date: null, time: null, until: null, ...c })),
    totalNotes: 1,
    scannedNotes: 1,
    truncated: false,
  });

  /**
   * 🔴 **口は `REFRESH_TASK_SCAN` 1 本**(#292 段⑤、2026-08-23)。
   *
   * ⚠ 予定は**左の列のタブ**になったので、`SET_VIEW_MODE`(中央の面)からは
   *   もう頼まない ── 頼むのは `main.ts` がタブを切り替えたときである。
   * ⚠ 空振り防止に**中央の面では頼まないこと**を対で見る ── 借りたままだと、
   *   予定を一度も開かない user にも全ノートの走査を負わせる。
   */
  it('🔴 頼まれたら集めを頼む(中央の面を開いただけでは頼まない)', () => {
    const out = reduce(booted(), { type: 'REFRESH_TASK_SCAN' });
    expect(out.events, '頼まれたのに集めていない').toContainEqual({ type: 'REQUEST_TASK_SCAN' });
    for (const mode of ['query', 'dual', 'settings', 'help'] as const) {
      expect(
        reduce(booted(), { type: 'SET_VIEW_MODE', mode }).events,
        `${mode} を開いただけで走査を頼んでいる`,
      ).not.toContainEqual({ type: 'REQUEST_TASK_SCAN' });
    }
  });

  /**
   * 🔴 **器を入れ替えたら捨てる**(取込はここを通る)。⚠ 残すと**消えたノートの札**が
   * 盤面に残り、押すと「見つからない」になる。⚠ そして**開いていれば集め直す** ──
   * 捨てるだけだと「集めています…」で止まる(捨てる側と頼む側は対で要る)。
   */
  it('🔴 器の読み直しで札を捨て、一度でも集めていれば集め直す', () => {
    let s = reduce(booted(), { type: 'REFRESH_TASK_SCAN' }).state;
    s = reduce(s, { type: 'SET_TASK_SCAN', scan: scan([{ lid: 'a', line: 0, text: 'x', done: false, date: null, time: null }]) }).state;
    expect(s.taskScan?.cards).toHaveLength(1);
    const out = reduce(s, { type: 'SYS_BOOTED', cid: 'c2', metas: [meta('a', 1)], relations: [] });
    expect(out.state.taskScan, '古い札が残っている').toBeNull();
    expect(out.events, '捨てただけで集め直していない').toContainEqual({ type: 'REQUEST_TASK_SCAN' });
  });

  /**
   * ⚠ **一度も集めていない user には撃たない**(集計と同じ流儀)── 予定を
   * 開かない user に、取込のたびに全ノートの走査を負わせない。
   * 🔑 判定は `taskScan === null` 1 本(直前に札を持っていたか)。
   */
  it('一度も集めていなければ、器を入れ替えても頼まない', () => {
    const out = reduce(booted(), { type: 'SYS_BOOTED', cid: 'c2', metas: [meta('a', 1)], relations: [] });
    expect(out.state.taskScan).toBeNull();
    expect(out.events).not.toContainEqual({ type: 'REQUEST_TASK_SCAN' });
  });

  /**
   * 🔴 **押した札は ack でその場で動く**(集め直しを頼まない)。
   * ⚠ 往復を待つと、押してから札が動くまで空白の間が出る。
   */
  it('🔴 書換の ack で、そのノートの札だけ組み直す', () => {
    let s = reduce(booted(), { type: 'REFRESH_TASK_SCAN' }).state;
    s = reduce(s, {
      type: 'SET_TASK_SCAN',
      scan: scan([
        { lid: 'a', line: 0, text: '牛乳', done: false, date: null, time: null },
        { lid: 'b', line: 0, text: '触るな', done: false, date: null, time: null },
      ]),
    }).state;
    const out = reduce(s, {
      type: 'BODY_REWRITTEN',
      lid: 'a',
      body: '- [x] 牛乳\n',
      rewrite: { kind: 'task', line: 0 },
      status: null,
      date: null,
      archived: false,
    });
    expect(out.state.taskScan?.cards.map((c) => [c.lid, c.done])).toEqual([
      ['a', true],
      ['b', false],
    ]);
    // ⚠ 集め直しは頼まない(worker を無駄に叩かない)
    expect(out.events).not.toContainEqual({ type: 'REQUEST_TASK_SCAN' });
  });

  /**
   * 🔴 **普通の保存でも札の行番号が追従する**(2026-08-19 のレビュー W-5)。
   *
   * ⚠ 直す前は書換の ack でしか組み直しておらず、**`COMMIT_EDIT` では古いまま**
   *   だった ── 板を閉じ、本文の先頭に 1 行足して保存し、板へ戻ると、
   *   走査が返るまで札は**古い行**を指したまま押せる。押すと
   *   **別の行が黙って完了になる**(落ちる向きがデータ破壊)。
   * 🔑 直しは「新しい本文が state に入る所」= `buildPersist` 1 か所を通すこと。
   */
  it('🔴 保存すると、札の行番号が新しい本文に追従する', () => {
    let s = reduce(booted(), { type: 'REFRESH_TASK_SCAN' }).state;
    s = reduce(s, { type: 'SELECT_ENTRY', lid: 'a' }).state;
    s = reduce(s, { type: 'BODY_LOADED', lid: 'a', body: '- [ ] A\n- [ ] B\n' }).state;
    s = reduce(s, {
      type: 'SET_TASK_SCAN',
      scan: scan([
        { lid: 'a', line: 0, text: 'A', done: false, date: null, time: null },
        { lid: 'a', line: 1, text: 'B', done: false, date: null, time: null },
      ]),
    }).state;
    // 先頭に 1 行足して保存 ── A は 0 行目から 1 行目へずれる
    s = reduce(s, { type: 'START_EDIT' }).state;
    s = reduce(s, { type: 'UPDATE_OPEN_BODY', body: '- [ ] 新しいやること\n- [ ] A\n- [ ] B\n' }).state;
    const out = reduce(s, { type: 'COMMIT_EDIT' });
    expect(
      out.state.taskScan?.cards.map((c) => [c.line, c.text]),
      '保存しても札が古い行を指したまま(押すと別の行が完了になる)',
    ).toEqual([
      [0, '新しいやること'],
      [1, 'A'],
      [2, 'B'],
    ]);
  });

  /** ⚠ 盤面を一度も開いていなければ、ack は札に触らない(null のまま)。 */
  it('盤面を開いていなければ ack は何もしない', () => {
    const out = reduce(booted(), {
      type: 'BODY_REWRITTEN',
      lid: 'a',
      body: '- [x] x\n',
      rewrite: { kind: 'task', line: 0 },
      status: null,
      date: null,
      archived: false,
    });
    expect(out.state.taskScan).toBeNull();
  });

  it('集められなかったことは「まだ」と区別して覚える', () => {
    const s = reduce(booted(), { type: 'TASK_SCAN_FAILED' }).state;
    expect(s.taskScanFailed).toBe(true);
    expect(s.taskScan, '失敗で札を作ってしまっている').toBeNull();
    /**
     * ⚠ **集め直しの action は持たない**(2026-08-19 のレビュー W-3)。
     * 集計には「集め直す」ボタンが在るが、板には**導線が無い**まま
     * `REFRESH_TASKS` だけが在り、`src/` の誰も送っていなかった ──
     * 実行するのが test だけの分岐は、製品の何も守らない(§2)。
     * 🔑 集め直す口は `SET_VIEW_MODE`(面を開く)1 本に寄せた。
     */
    const reopened = reduce(s, { type: 'REFRESH_TASK_SCAN' });
    expect(reopened.events).toContainEqual({ type: 'REQUEST_TASK_SCAN' });
  });
});
