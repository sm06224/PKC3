import { stubStamps } from '../helpers/store-stamps';
import { describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import type { EntryUpsert } from '../../src/adapter/platform/storage/schema';
import { extractMeta } from '../../src/features/flavor';
import { initialState, reduce, type AppState } from '../../src/adapter/state/app-state';
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
    expect(r1.events).toEqual([{ type: 'REQUEST_BODY', lid: 'a' }]);
  });

  it('re-selecting the same entry re-requests body while openBody is absent (retry path)', () => {
    let s = booted();
    s = reduce(s, { type: 'SELECT_ENTRY', lid: 'a' }).state;
    // 読み失敗などで openBody が無いまま同じ entry を再クリック → 再要求される
    const retry = reduce(s, { type: 'SELECT_ENTRY', lid: 'a' });
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
    expect(reduce(s, { type: 'SET_VIEW_MODE', mode: 'kanban' }).state.viewMode).toBe(
      'detail',
    );
    /**
     * 🔴 **ただし「ノートを映さない面」は編集中でも開ける**(user 裁定 2026-08-08。
     * P11 の Q5 を覆した)。⚠ ここを塞ぐと「書きながらマニュアルを読む」が
     * できない ── ヘルプの主目的である。
     */
    expect(
      reduce(s, { type: 'SET_VIEW_MODE', mode: 'help' }).state.viewMode,
      '編集中にヘルプを開けない(無言の dead click)',
    ).toBe('help');
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
    // 常駐 meta も同じ reduce で追従(sidebar / kanban が古い列を見ない)
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
        type: 'REQUEST_TODO_TOGGLE',
        lid: 'td',
        title: 't-td',
        entryOrder: 3,
        nextStatus: 'done',
      },
    ]);
    expect(r.state.entryMetas).toBe(s.entryMetas); // ack までカードは動かない
    // editing 中は発火しない
    s = reduce(s, { type: 'SELECT_ENTRY', lid: 'td' }).state;
    s = reduce(s, { type: 'BODY_LOADED', lid: 'td', body: 'x' }).state;
    s = reduce(s, { type: 'START_EDIT' }).state;
    expect(reduce(s, { type: 'TOGGLE_TODO_STATUS', lid: 'td' }).events).toEqual([]);
  });

  it('TODO_TOGGLED: 編集中の同一 entry では draft を触らず persisted だけ追従', () => {
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
      type: 'TODO_TOGGLED',
      lid: 'td',
      body: toggledBody,
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
        type: 'TODO_TOGGLED',
        lid: 'td',
        body: toggled,
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
      type: 'TODO_TOGGLED',
      lid: 'td',
      body: toggledOld,
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
    s = reduce(s, { type: 'SET_VIEW_MODE', mode: 'kanban' }).state;
    expect(s.viewMode).toBe('kanban');
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
        d.dispatch({ type: 'SET_VIEW_MODE', mode: 'kanban' }); // listener 内 dispatch
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
    expect(seen[seen.length - 1]).toBe('a/kanban');
    expect(d.getState().viewMode).toBe('kanban');
  });
});

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
    await new Promise((r) => setTimeout(r, 60));
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
    await new Promise((r) => setTimeout(r, 40));
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
      async persistEntry() {
        return stubStamps();
      },
    };
    const off = connectStoreEffects(d, store);
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('a', 1)], relations: [] });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    await new Promise((r) => setTimeout(r, 20));
    expect(d.getState().error).toMatch(/boom/); // 次の成功 / 選択まで残る
    expect(d.getState().phase).toBe('ready'); // 読み失敗で app は死なない
    // 再クリック = retry(review C): queue は生きており復帰できる
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    await new Promise((r) => setTimeout(r, 20));
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
      async persistEntry(e) {
        if (failNext) throw new Error('disk full');
        persisted.push(e.body);
        return stubStamps();
      },
    };
    const off = connectStoreEffects(d, store);
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('a', 1)], relations: [] });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    await new Promise((r) => setTimeout(r, 20));
    d.dispatch({ type: 'START_EDIT' });
    d.dispatch({ type: 'UPDATE_OPEN_BODY', body: '# A2' });
    d.dispatch({ type: 'COMMIT_EDIT' });
    await new Promise((r) => setTimeout(r, 20));
    expect(d.getState().phase).toBe('error');
    // 未達の証拠が残っている
    expect(d.getState().openBody).toMatchObject({ baseline: '# A2', persisted: '# A' });

    failNext = false;
    d.dispatch({ type: 'RETRY_PERSIST' });
    await new Promise((r) => setTimeout(r, 20));
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
      async persistEntry() {
        throw new Error('disk full');
      },
    };
    const off = connectStoreEffects(d, store);
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('a', 1)], relations: [] });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    await new Promise((r) => setTimeout(r, 20));
    d.dispatch({ type: 'START_EDIT' });
    d.dispatch({ type: 'UPDATE_OPEN_BODY', body: 'A2' });
    d.dispatch({ type: 'COMMIT_EDIT' });
    await new Promise((r) => setTimeout(r, 20));
    expect(d.getState().phase).toBe('error'); // 保存失敗は静かに失敗しない
    off();
  });

  it('commit flows through effects and persists exactly the open body', async () => {
    const log: string[] = [];
    const d = new Dispatcher();
    const off = connectStoreEffects(d, fakeStore(log, { a: 'A' }));
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('a', 1)], relations: [] });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    await new Promise((r) => setTimeout(r, 40));
    d.dispatch({ type: 'START_EDIT' });
    d.dispatch({ type: 'UPDATE_OPEN_BODY', body: 'A2' });
    d.dispatch({ type: 'COMMIT_EDIT' });
    await new Promise((r) => setTimeout(r, 20));
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
    await new Promise((r) => setTimeout(r, 20));
    d.dispatch({ type: 'START_EDIT' });
    d.dispatch({
      type: 'UPDATE_OPEN_BODY',
      body: '---\nstatus: done\ndate: 2026-08-02\n---\n芝刈り',
    });
    d.dispatch({ type: 'COMMIT_EDIT' });
    await new Promise((r) => setTimeout(r, 20));
    const row = persisted[0];
    if (!row) throw new Error('no entry persisted');
    // store 境界の roundtrip pin: 書かれた行の抽出列 = body への extract 再適用
    expect({ status: row.status, date: row.date, archived: row.archived }).toEqual(
      extractMeta(row.archetype, row.body),
    );
    expect(row.status).toBe('done');
    off();
  });

  it('teardown stops in-flight results from dispatching (review H)', async () => {
    const d = new Dispatcher();
    const off = connectStoreEffects(d, {
    ...stubRevisionOps(),
      async getBody() {
        await new Promise((r) => setTimeout(r, 20));
        return 'late';
      },
      async deleteEntry() {},
      async setEntryParent() {},
      async persistEntry() {
        return stubStamps();
      },
    });
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('a', 1)], relations: [] });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    off(); // in-flight のまま teardown
    await new Promise((r) => setTimeout(r, 40));
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
    let s: AppState = { ...booted(), viewMode: 'kanban' };
    s = reduce(s, { type: 'SELECT_ENTRY', lid: 'a' }).state;
    expect(s.viewMode, 'kanban を勝手に畳んだ').toBe('kanban');
  });
});
