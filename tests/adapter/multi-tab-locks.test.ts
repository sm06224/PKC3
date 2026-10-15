/** @vitest-environment happy-dom */
/**
 * #1087 複数タブの編集ロックの見直し ── 失敗した保存 / 遅れて届く許可 / bfcache / 同じタブの重なり。
 *
 * 🔑 どれも「片方のタブだけ見る unit」では素通りする形(別のタブが挟まる / 返事が遅れる)なので、
 *   本物の StoreProxyHost + ProxyStoreClient を fake の放送路で繋ぎ、足りない側だけ手で演じる。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { EDIT_ELSEWHERE_ERROR } from '../../src/features/message/caution-events';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import {
  hasUnreachedCommit,
  initialState,
  reduce,
  unsavedTypingLidOf,
} from '../../src/adapter/state/app-state';
import { bindEditLockRelease } from '../../src/adapter/state/edit-lock-release';
import { editedElsewhereReason, makeEditLockPort } from '../../src/adapter/state/edited-elsewhere';
import { ProxyStoreClient, StoreProxyHost } from '../../src/adapter/platform/storage/store-proxy';
import type { Broadcaster, ProxyWire, StoreClientLike } from '../../src/adapter/platform/storage/store-proxy';
import type { InitResult } from '../../src/adapter/platform/storage/protocol';

function makeHub() {
  const members = new Set<FakeChannel>();
  class FakeChannel implements Broadcaster {
    onmessage: ((ev: MessageEvent) => void) | null = null;
    closed = false;
    constructor() {
      members.add(this);
    }
    postMessage(data: unknown): void {
      if (this.closed) return;
      for (const m of members) {
        if (m === this || m.closed) continue;
        queueMicrotask(() => {
          if (!m.closed) m.onmessage?.({ data } as MessageEvent);
        });
      }
    }
    close(): void {
      this.closed = true;
      members.delete(this);
    }
  }
  return { make: (): Broadcaster => new FakeChannel() };
}
const INIT: InitResult = {
  vfs: 'opfs-sahpool',
  libVersion: 'test',
  crossOriginIsolated: true,
  journalMode: 'wal',
  reservedLockPatched: true,
  reservedLockUpstreamFixed: false,
};
const drain = async (n = 12): Promise<void> => {
  for (let i = 0; i < n; i += 1) await Promise.resolve();
};

/** holder を手で演じる(返事の出し方を test が決める)。受けた物は `seen` に残る。 */
function manualHolder(hub: ReturnType<typeof makeHub>, opts: { reply?: boolean } = {}) {
  const ch = hub.make();
  const seen: ProxyWire[] = [];
  ch.onmessage = (ev) => {
    const m = ev.data as ProxyWire;
    seen.push(m);
    if (m.kind === 'hello' && opts.reply !== false)
      ch.postMessage({ kind: 'holder-here', holder: 'h', init: INIT, to: m.from } satisfies ProxyWire);
  };
  return { ch, seen, send: (m: ProxyWire) => ch.postMessage(m) };
}

describe('② 時間切れの後に届いた許可は、握らずに返す', () => {
  it('🔴 返事が遅れて許可が届いたら edit-release を撃つ(台帳に幽霊の錠を残さない)', async () => {
    const hub = makeHub();
    const h = manualHolder(hub);
    const f = (await ProxyStoreClient.connect({ makeChannel: hub.make, tabId: 'f1', requestTimeoutMs: 10 }))!;
    const grant = await f.acquireEdit('c1', 'n1');
    expect(grant).toBe('unreachable');
    await drain();
    const ask = h.seen.find((m) => m.kind === 'edit-acquire');
    expect(ask).toBeTruthy();
    h.send({ kind: 'edit-res', to: 'f1', id: (ask as { id: number }).id, granted: true });
    await drain();
    expect(h.seen).toContainEqual({ kind: 'edit-release', from: 'f1', cid: 'c1', lid: 'n1' });
    expect(f.heldEditLocks()).toEqual([]);
  });

  it('対照群: 時間内に届いた許可は握る(返さない)', async () => {
    const hub = makeHub();
    const h = manualHolder(hub);
    const f = (await ProxyStoreClient.connect({ makeChannel: hub.make, tabId: 'f1' }))!;
    const p = f.acquireEdit('c1', 'n1');
    await drain();
    const ask = h.seen.find((m) => m.kind === 'edit-acquire') as { id: number };
    h.send({ kind: 'edit-res', to: 'f1', id: ask.id, granted: true });
    expect(await p).toBe('granted');
    expect(f.heldEditLocks()).toEqual([{ cid: 'c1', lid: 'n1' }]);
    await drain();
    expect(h.seen.some((m) => m.kind === 'edit-release')).toBe(false);
  });

  it('⚠ 同じノートを別の取得が握った後に、古い許可が届いても、その錠を落とさない', async () => {
    const hub = makeHub();
    const h = manualHolder(hub);
    const f = (await ProxyStoreClient.connect({ makeChannel: hub.make, tabId: 'f1', requestTimeoutMs: 30 }))!;
    expect(await f.acquireEdit('c1', 'n1')).toBe('unreachable'); // 1 回目は時間切れ
    await drain();
    const second = f.acquireEdit('c1', 'n1');
    await drain();
    const asks = h.seen.filter((m) => m.kind === 'edit-acquire') as Array<{ id: number }>;
    expect(asks).toHaveLength(2);
    h.send({ kind: 'edit-res', to: 'f1', id: asks[1]!.id, granted: true });
    expect(await second).toBe('granted');
    h.send({ kind: 'edit-res', to: 'f1', id: asks[0]!.id, granted: true }); // 古い許可
    await drain();
    expect(h.seen.some((m) => m.kind === 'edit-release')).toBe(false);
    expect(f.heldEditLocks()).toEqual([{ cid: 'c1', lid: 'n1' }]);
  });

  it('許可でなければ(denied)返さない', async () => {
    const hub = makeHub();
    const h = manualHolder(hub);
    const f = (await ProxyStoreClient.connect({ makeChannel: hub.make, tabId: 'f1', requestTimeoutMs: 10 }))!;
    await f.acquireEdit('c1', 'n1');
    await drain();
    const ask = h.seen.find((m) => m.kind === 'edit-acquire') as { id: number };
    h.send({ kind: 'edit-res', to: 'f1', id: ask.id, granted: false });
    await drain();
    expect(h.seen.some((m) => m.kind === 'edit-release')).toBe(false);
  });
});

describe('③ 許可が届く前に手放した取得は、届いたときに返す', () => {
  it('🔴 作った直後に保存(releaseEdit)→ 後から許可 → 握らず返す', async () => {
    const hub = makeHub();
    const h = manualHolder(hub);
    const f = (await ProxyStoreClient.connect({ makeChannel: hub.make, tabId: 'f1' }))!;
    const p = f.acquireEdit('c1', 'n1');
    f.releaseEdit('c1', 'n1'); // 許可はまだ
    await drain();
    const ask = h.seen.find((m) => m.kind === 'edit-acquire') as { id: number };
    h.send({ kind: 'edit-res', to: 'f1', id: ask.id, granted: true });
    await p;
    await drain();
    expect(h.seen).toContainEqual({ kind: 'edit-release', from: 'f1', cid: 'c1', lid: 'n1' });
    expect(f.heldEditLocks()).toEqual([]);
  });

  it('⚠ 手放した後にもう一度取った回は、古い許可が来ても新しい取得の錠を落とさない', async () => {
    const hub = makeHub();
    const h = manualHolder(hub);
    const f = (await ProxyStoreClient.connect({ makeChannel: hub.make, tabId: 'f1' }))!;
    const a = f.acquireEdit('c1', 'n1');
    f.releaseEdit('c1', 'n1');
    const b = f.acquireEdit('c1', 'n1');
    await drain();
    const asks = h.seen.filter((m) => m.kind === 'edit-acquire') as Array<{ id: number }>;
    expect(asks).toHaveLength(2);
    h.send({ kind: 'edit-res', to: 'f1', id: asks[0]!.id, granted: true });
    h.send({ kind: 'edit-res', to: 'f1', id: asks[1]!.id, granted: true });
    await Promise.all([a, b]);
    await drain();
    expect(h.seen.some((m) => m.kind === 'edit-release')).toBe(false);
    expect(f.heldEditLocks()).toEqual([{ cid: 'c1', lid: 'n1' }]);
  });
});

describe('⑨ hello への返事は、聞いた 1 枚にだけ', () => {
  it('🔴 後から来たタブの hello で、既存の follower が宙の要求を再送しない', async () => {
    const hub = makeHub();
    const calls: string[] = [];
    const real: StoreClientLike = {
      request: vi.fn(async (req: { op: string }) => {
        calls.push(req.op);
        if (req.op === 'appendMessage') return new Promise(() => {}) as never; // 返らない
        return null as never;
      }) as StoreClientLike['request'],
      terminate: vi.fn(),
    };
    const host = new StoreProxyHost({ client: real, init: INIT, makeChannel: hub.make, tabId: 'holder' });
    const f1 = (await ProxyStoreClient.connect({ makeChannel: hub.make, tabId: 'f1' }))!;
    void f1.request({ op: 'appendMessage', cid: 'c1', message: {} } as never).catch(() => {});
    await drain();
    expect(calls.filter((c) => c === 'appendMessage')).toHaveLength(1);
    const f2 = await ProxyStoreClient.connect({ makeChannel: hub.make, tabId: 'f2' });
    expect(f2).not.toBeNull();
    await drain();
    expect(calls.filter((c) => c === 'appendMessage')).toHaveLength(1);
    host.close();
  });

  it('他のタブ宛ての返事を、接続中のタブが自分への返事と読まない', async () => {
    const hub = makeHub();
    const h = manualHolder(hub, { reply: false });
    const p = ProxyStoreClient.connect({ makeChannel: hub.make, tabId: 'f1', handshakeTimeoutMs: 20 });
    await drain();
    h.send({ kind: 'holder-here', holder: 'h', init: INIT, to: 'someone-else' });
    expect(await p).toBeNull();
  });
});

describe('⑤ bfcache から戻ったら、握っていた錠を取り直す', () => {
  const pageshow = (persisted: boolean): void => {
    const ev = new Event('pageshow');
    Object.defineProperty(ev, 'persisted', { value: persisted });
    window.dispatchEvent(ev);
  };
  async function rig() {
    const hub = makeHub();
    const real: StoreClientLike = { request: (async () => null) as never, terminate: vi.fn() };
    const host = new StoreProxyHost({ client: real, init: INIT, makeChannel: hub.make, tabId: 'holder' });
    const f1 = (await ProxyStoreClient.connect({ makeChannel: hub.make, tabId: 'f1' }))!;
    const f2 = (await ProxyStoreClient.connect({ makeChannel: hub.make, tabId: 'f2' }))!;
    return { host, f1, f2 };
  }

  it('🔴 pagehide(bye)で台帳から落ち、pageshow(persisted)で戻る', async () => {
    const { f1, f2 } = await rig();
    const revoked = vi.fn();
    f1.onEditRevoked(revoked);
    expect(await f1.acquireEdit('c1', 'n1')).toBe('granted');
    window.dispatchEvent(new Event('pagehide'));
    await drain();
    pageshow(true);
    await drain();
    expect(await f2.acquireEdit('c1', 'n1')).toBe('denied');
    expect(revoked).not.toHaveBeenCalled();
  });

  it('対照群: persisted でない pageshow(普通の読み込み)では取り直さない', async () => {
    const { f1, f2 } = await rig();
    expect(await f1.acquireEdit('c1', 'n1')).toBe('granted');
    window.dispatchEvent(new Event('pagehide'));
    await drain();
    pageshow(false);
    await drain();
    expect(await f2.acquireEdit('c1', 'n1')).toBe('granted');
  });

  it('復元までの間に別のタブが取っていたら、取り直しは否認され、知らせる', async () => {
    const { f1, f2 } = await rig();
    const revoked = vi.fn();
    f1.onEditRevoked(revoked);
    expect(await f1.acquireEdit('c1', 'n1')).toBe('granted');
    window.dispatchEvent(new Event('pagehide'));
    await drain();
    expect(await f2.acquireEdit('c1', 'n1')).toBe('granted');
    pageshow(true);
    await drain();
    expect(revoked).toHaveBeenCalledWith('c1', 'n1');
    expect(f1.heldEditLocks()).toEqual([]);
  });
});

/* ------------------------------------------------------------------ ① */

/** 保存に失敗して error phase にいる state を作る(未達の字: baseline ≠ persisted)。 */
function failedSaveRig() {
  const d = new Dispatcher(
    reduce(initialState, { type: 'SYS_BOOTED', cid: 'c1', metas: [], relations: [] }).state,
  );
  const releaseEdit = vi.fn();
  bindEditLockRelease(d, () => ({ releaseEdit }), 'c1');
  d.dispatch({
    type: 'CREATE_ENTRY',
    archetype: 'text',
    lid: 'n1',
    title: 't',
    parentLid: null,
    relationId: 'r1',
  });
  d.dispatch({ type: 'UPDATE_OPEN_BODY', body: '# 未達の字' });
  d.dispatch({ type: 'COMMIT_EDIT' });
  releaseEdit.mockClear();
  d.dispatch({ type: 'SYS_ERROR', error: '保存に失敗しました' });
  return { d, releaseEdit };
}

describe('① 保存に失敗して止まっている間は、錠を握り続ける', () => {
  it('🔴 error phase になっても錠を返さない。再保存で返す', () => {
    const { d, releaseEdit } = failedSaveRig();
    const st = d.getState();
    expect(st.phase).toBe('error');
    expect(hasUnreachedCommit(st)).toBe(true);
    expect(unsavedTypingLidOf(st)).toBe('n1');
    expect(releaseEdit).not.toHaveBeenCalled();
    d.dispatch({ type: 'RETRY_PERSIST' });
    expect(d.getState().phase).toBe('ready');
    expect(releaseEdit).toHaveBeenCalledWith('c1', 'n1');
  });

  it('対照群: 未達の字が無い error(baseline = persisted)では握らない', () => {
    const st = {
      ...initialState,
      phase: 'error' as const,
      openBody: { lid: 'n1', body: 'a', baseline: 'a', persisted: 'a', diskAhead: false },
    };
    expect(hasUnreachedCommit(st)).toBe(false);
    expect(unsavedTypingLidOf(st)).toBeNull();
  });

  it('🔴 別のタブの書込(REMOTE_BODY_CHANGED)で diskAhead が立ち、再保存は断らず履歴に残して知らせる', () => {
    const { d } = failedSaveRig();
    d.dispatch({ type: 'REMOTE_BODY_CHANGED', lid: 'n1', body: '別のタブの字' });
    const ob = d.getState().openBody!;
    expect(ob.diskAhead).toBe(true);
    expect(ob.persisted).toBe('別のタブの字');
    expect(ob.baseline).toBe('# 未達の字'); // 打った字には触らない
    const r = reduce(d.getState(), { type: 'RETRY_PERSIST' });
    expect(r.state.phase).toBe('ready');
    expect(r.state.error).toContain('別のタブまたはウィンドウの版は履歴に残してあります');
    expect(r.events[0]).toMatchObject({ type: 'PERSIST_ENTRY', checkpoint: true });
  });

  it('🔴 新規作成直後(freshLid)でも、別のタブの版が先に在った再保存は履歴に残す(強制する側を見る)', () => {
    const { d } = failedSaveRig();
    d.dispatch({ type: 'REMOTE_BODY_CHANGED', lid: 'n1', body: '別のタブの字' });
    const fresh = { ...d.getState(), freshLid: 'n1' };
    expect(reduce(fresh, { type: 'RETRY_PERSIST' }).events[0]).toMatchObject({ checkpoint: true });
    // 対照群: 別のタブの版が無い(印が無い)新規作成直後の再保存は積まない ── 強制が効いている証拠
    const { d: d2 } = failedSaveRig();
    const fresh2 = { ...d2.getState(), freshLid: 'n1' };
    expect(reduce(fresh2, { type: 'RETRY_PERSIST' }).events[0]).toMatchObject({ checkpoint: false });
  });

  it('対照群: 別の lid の書込は印を立てない。印が無い再保存は知らせを出さない', () => {
    const { d } = failedSaveRig();
    d.dispatch({ type: 'REMOTE_BODY_CHANGED', lid: 'other', body: 'z' });
    expect(d.getState().openBody!.diskAhead).toBe(false);
    const r = reduce(d.getState(), { type: 'RETRY_PERSIST' });
    expect(r.state.error).toBeNull();
  });

  it('対照群: 未達の字が無い ready では REMOTE_BODY_CHANGED は印を立てない(reloadSnapshot の仕事)', () => {
    const st = reduce(initialState, { type: 'SYS_BOOTED', cid: 'c1', metas: [], relations: [] }).state;
    const r = reduce(
      { ...st, openBody: { lid: 'n1', body: 'a', baseline: 'a', persisted: 'a', diskAhead: false } },
      { type: 'REMOTE_BODY_CHANGED', lid: 'n1', body: 'b' },
    );
    expect(r.state.openBody!.diskAhead).toBe(false);
  });
});

/* ------------------------------------------------------------------ ④ */

describe('④ 同じタブの中で、確かめる側の返却が編集に入る側の錠を落とさない', () => {
  type G = 'granted' | 'denied' | 'unreachable';
  function rig() {
    const waits: Array<(g: G) => void> = [];
    const releaseEdit = vi.fn();
    const sync = {
      acquireEdit: () => new Promise<G>((r) => waits.push(r)),
      releaseEdit,
    };
    const port = makeEditLockPort(() => sync, 'c1');
    const d = new Dispatcher(
      reduce(initialState, { type: 'SYS_BOOTED', cid: 'c1', metas: [], relations: [] }).state,
    );
    return { waits, releaseEdit, port, d };
  }

  it('🔴 確かめる最中に編集の取得が重なったら、確かめる側は返さない', async () => {
    const { waits, releaseEdit, port, d } = rig();
    const reason = editedElsewhereReason(d, port, 'n1');
    const start = port.acquireEditLock('n1'); // 編集に入る側
    waits[0]!('granted');
    waits[1]!('granted');
    expect(await reason).toBeNull();
    expect(await start).toBe('granted');
    expect(releaseEdit).not.toHaveBeenCalled();
  });

  it('🔴 編集の取得が先に飛んでいて、確かめる側が後から入った回も返さない', async () => {
    const { waits, releaseEdit, port, d } = rig();
    const start = port.acquireEditLock('n1');
    const reason = editedElsewhereReason(d, port, 'n1');
    waits[0]!('granted');
    waits[1]!('granted');
    await Promise.all([start, reason]);
    expect(releaseEdit).not.toHaveBeenCalled();
  });

  it('対照群: 重ならない回は確かめた後に返す(錠を握り続けない)', async () => {
    const { waits, releaseEdit, port, d } = rig();
    const reason = editedElsewhereReason(d, port, 'n1');
    waits[0]!('granted');
    expect(await reason).toBeNull();
    expect(releaseEdit).toHaveBeenCalledTimes(1);
    expect(releaseEdit).toHaveBeenCalledWith('c1', 'n1');
  });

  it('確かめる側どうしが重なる回は、最後の 1 つだけが返す(全員が譲ると錠が残る)', async () => {
    const { waits, releaseEdit, port, d } = rig();
    const a = editedElsewhereReason(d, port, 'n1');
    const b = editedElsewhereReason(d, port, 'n1');
    waits[0]!('granted');
    waits[1]!('granted');
    await Promise.all([a, b]);
    expect(releaseEdit).toHaveBeenCalledTimes(1);
  });

  it('別のノートの取得は邪魔しない', async () => {
    const { waits, releaseEdit, port, d } = rig();
    const reason = editedElsewhereReason(d, port, 'n1');
    const other = port.acquireEditLock('n2');
    waits[0]!('granted');
    waits[1]!('granted');
    await Promise.all([reason, other]);
    expect(releaseEdit).toHaveBeenCalledWith('c1', 'n1');
  });
});

/* ------------------------------------------------------------ 字 / 配線 */

describe('⑥⑦ 画面の字', () => {
  it('断りの文は、そのタブがもう無い場合の道を言う(全文を pin)', () => {
    expect(EDIT_ELSEWHERE_ERROR).toBe(
      'このノートは別のタブまたはウィンドウで編集中です(そちらを閉じるか保存してください。そのタブがもう無いときは、数分たつと編集できます)',
    );
  });
  it('通信できない文は「メインのタブ」と言う(最初に開いたタブは昇格で替わる)', () => {
    const binder = readFileSync('src/adapter/ui/actions/binder.ts', 'utf8');
    expect(binder).toContain('メインのタブと通信できません(少し待ってもう一度お試しください)');
    expect(binder).not.toContain('最初に開いた PKC3 のタブ');
  });
});

describe('main.ts の配線(起動できないので字で pin する)', () => {
  const src = readFileSync('src/main.ts', 'utf8')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*'))
    .join('\n');
  it('⑧ タグの色の読み直しは 300ms の束ねの中で 1 回(changed のたびに撃たない)', () => {
    expect(src).toMatch(/setTimeout\(\(\) => \{\s*syncReloadQueued = false;\s*void reloadTagColors\(\);/);
    const handler = src.slice(src.indexOf('const onRemoteChanged'), src.indexOf('syncReloadQueued = true;'));
    expect(handler).not.toContain('reloadTagColors');
  });
  it('⑤ bfcache で戻ったら unloading を下ろす', () => {
    expect(src).toMatch(/addEventListener\('pageshow', \(ev\) => \{\s*if \(ev\.persisted\) unloading = false;/);
  });
  it('① 他タブの書込の問い合わせは、保存に失敗して止まっているときも編集中として扱う', () => {
    expect(src).toMatch(/st\.phase === 'editing' \|\| hasUnreachedCommit\(st\)/);
  });
  it('④ 編集の錠の口は 1 つで、編集に入る側の取得も同じ口を通る', () => {
    expect(src.match(/makeEditLockPort\(/g)).toHaveLength(1);
    expect(src).toMatch(/acquireEditLock: editLockPort\.acquireEditLock,\s*releaseEditLock: editLockPort\.releaseEditLock,/);
  });
});
