/**
 * 多重タブの storage proxy(#177 ── 設計 doc §4.5「BroadcastChannel での読取追従」の実体)。
 *
 * SAHPool は実質単一接続なので、DB(sqlite worker)を開けるのは lease 保持タブ
 * (holder)だけ。2 枚目以降(follower)は **holder 経由で**同じ storage protocol を話す:
 *
 *   follower の ProxyStoreClient ──(BroadcastChannel)── holder の StoreProxyHost ── 実 worker
 *
 * - **書込も通す**(user 要望: 複数タブで別々のノートを編集したい)。書込は holder の
 *   worker(単一 queue)が直列化する。**同じノート**の同時編集だけを per-lid の
 *   編集ロックで止める ── last-write-wins のデータ欠損を作らない(CLAUDE.md §7 の向き)。
 * - mutation が通るたび holder が 'changed' を放送し、**発信者以外の**タブが取り込んで
 *   描き直す(発信者の state は自分の dispatcher が既に更新している)。
 * - holder が閉じると Web Locks が待ち行列の先頭タブへ lease を渡す ── そのタブは
 *   `promote()` で**その場で実 worker に乗り換え**、新しい holder になる(reload 不要。
 *   編集中の下書きもタブの中で生き続ける)。
 * - 旧ビルドの holder(この proxy を持たない)相手では handshake が時間切れになる ──
 *   呼び側は従来の「別のタブで開いています」待機に落とす(graceful fallback)。
 *
 * ⚠ BroadcastChannel は **transfer できない**(structured clone のみ)が、この protocol の
 *   payload は文字列と小さな行 object だけ(asset の bytes は IDB Blob 直読みで通らない)。
 * ⚠ postMessage は**自分の channel instance には配られない** ── 'changed' の
 *   「発信者以外」はこの性質 + origin 判定の両方で守る(host は発信者の代理で放送するため)。
 */
import type { InitResult, RequestFor, ResultMap, StorageRequest } from './protocol';

/**
 * StoreClient と同じ口。実 worker(StoreClient)と proxy(ProxyStoreClient)を
 * 呼び側で差し替えられるようにするための最小面。
 */
export interface StoreClientLike {
  request<Op extends StorageRequest['op']>(req: RequestFor<Op>): Promise<ResultMap[Op]>;
  terminate(): void;
}

export const STORE_PROXY_CHANNEL = 'pkc3-store-proxy';

/** follower の要求に holder が応えない(旧ビルド / 死んだ直後)と判断するまで。 */
export const HANDSHAKE_TIMEOUT_MS = 1500;
/** 要求→応答の上限。超えたら reject(永久 hang を作らない ── StoreClient と同じ規律)。 */
export const REQUEST_TIMEOUT_MS = 10_000;
/** 編集ロックの生存確認間隔(follower → holder)と、掃除の閾値。 */
export const EDIT_PING_MS = 15_000;
export const EDIT_LOCK_TTL_MS = 45_000;

/** 書込 op = 'changed' を放送する op(protocol.ts の mutation 全数)。 */
const MUTATING_OPS: ReadonlySet<StorageRequest['op']> = new Set([
  'upsertEntry',
  'bulkUpsertEntries',
  'deleteEntry',
  'setEntryParent',
  'bulkUpsertRelations',
  'importRevisionChains',
  'restoreRevisionChains',
  'purgeTrash',
  'putAssetMeta',
  'deleteAssetMeta',
]);

/** 変更の当たり先(null = 特定できない → 全面 refresh)。 */
function changedLids(req: StorageRequest): string[] | null {
  switch (req.op) {
    case 'upsertEntry':
      return [req.entry.lid];
    case 'deleteEntry':
    case 'setEntryParent':
      return [req.lid];
    case 'bulkUpsertEntries':
      return req.entries.map((e) => e.lid);
    default:
      return null;
  }
}

/** BroadcastChannel の最小面(test では fake hub を差す ── office-window と同じ作法)。 */
export interface Broadcaster {
  postMessage(data: unknown): void;
  close(): void;
  onmessage: ((ev: MessageEvent) => void) | null;
}

export type ProxyWire =
  | { kind: 'hello'; from: string }
  | { kind: 'holder-here'; holder: string; init: InitResult }
  | { kind: 'req'; from: string; id: number; req: StorageRequest }
  | { kind: 'res'; to: string; id: number; ok: true; result: unknown }
  | { kind: 'res'; to: string; id: number; ok: false; error: string }
  | { kind: 'changed'; origin: string; cid: string; lids: string[] | null }
  | { kind: 'edit-acquire'; from: string; id: number; cid: string; lid: string }
  | { kind: 'edit-res'; to: string; id: number; granted: boolean }
  | { kind: 'edit-release'; from: string; cid: string; lid: string }
  | { kind: 'edit-ping'; from: string; keys: string[] }
  | { kind: 'bye'; from: string };

/** タブ間で同期すべきことの口(holder / follower の両実装が同じ形で持つ)。 */
export interface TabSync {
  role(): 'holder' | 'follower';
  /** この lid の編集権を取る。false = 別タブが編集中。 */
  acquireEdit(cid: string, lid: string): Promise<boolean>;
  releaseEdit(cid: string, lid: string): void;
  /** 自分以外のタブが書き込んだとき(lids = null は全面 refresh)。 */
  onChanged(fn: (cid: string, lids: string[] | null) => void): () => void;
}

const lockKey = (cid: string, lid: string): string => `${cid}\uE000${lid}`;

function makeTabId(): string {
  const c = globalThis.crypto;
  return c && 'randomUUID' in c ? c.randomUUID() : `tab-${Math.random().toString(36).slice(2)}`;
}

interface CommonDeps {
  readonly makeChannel?: (name: string) => Broadcaster;
  readonly now?: () => number;
  readonly tabId?: string;
}

function openChannel(deps: CommonDeps): Broadcaster {
  return deps.makeChannel
    ? deps.makeChannel(STORE_PROXY_CHANNEL)
    : (new BroadcastChannel(STORE_PROXY_CHANNEL) as unknown as Broadcaster);
}

/* ------------------------------------------------------------------ holder */

export interface StoreProxyHostDeps extends CommonDeps {
  /** 実 worker への client(このタブが lease を握って init 済みのもの)。 */
  readonly client: StoreClientLike;
  /** init の結果(follower の handshake にそのまま返す)。 */
  readonly init: InitResult;
  /**
   * 昇格時に引き継ぐ自タブの編集ロック(follower として握っていたもの)。
   * ⚠ 台帳へ**先に**入れてから名乗る ── 名乗りを聞いた他 follower の再主張が
   * こちらの編集中ノートを取ってしまわないように。
   */
  readonly heldLocks?: ReadonlyArray<{ cid: string; lid: string }>;
}

/**
 * holder 側。follower の要求を実 worker へ回し、mutation を 'changed' で放送し、
 * 編集ロックを裁定する。holder タブ自身のアプリは `localClient()` を使う
 * (自分の mutation も放送に乗る ── 判定を 2 か所に書かない)。
 */
export class StoreProxyHost implements TabSync {
  private readonly ch: Broadcaster;
  private readonly real: StoreClientLike;
  private readonly init: InitResult;
  private readonly id: string;
  private readonly now: () => number;
  /** lockKey → { tab, seenAt } ── seenAt は edit-ping で更新、TTL 超えは掃除。 */
  private readonly locks = new Map<string, { tab: string; seenAt: number }>();
  private readonly changedListeners = new Set<(cid: string, lids: string[] | null) => void>();
  private closed = false;

  constructor(deps: StoreProxyHostDeps) {
    this.real = deps.client;
    this.init = deps.init;
    this.id = deps.tabId ?? makeTabId();
    this.now = deps.now ?? ((): number => Date.now());
    for (const l of deps.heldLocks ?? [])
      this.locks.set(lockKey(l.cid, l.lid), { tab: this.id, seenAt: this.now() });
    this.ch = openChannel(deps);
    this.ch.onmessage = (ev: MessageEvent): void => {
      void this.receive(ev.data as ProxyWire);
    };
    // 起動を名乗る ── 待機中の follower(前の holder の死で宙に浮いた要求を持つ)が
    // これを見て再送・ロック再主張する
    this.ch.postMessage({ kind: 'holder-here', holder: this.id, init: this.init });
  }

  role(): 'holder' {
    return 'holder';
  }

  /** holder タブ自身のアプリが使う client(mutation を放送に乗せる包み)。 */
  localClient(): StoreClientLike {
    return {
      request: async <Op extends StorageRequest['op']>(
        req: RequestFor<Op>,
      ): Promise<ResultMap[Op]> => {
        const result = await this.real.request(req);
        if (MUTATING_OPS.has(req.op)) this.broadcastChanged(this.id, req);
        return result;
      },
      terminate: () => {
        this.real.terminate();
      },
    };
  }

  acquireEdit(cid: string, lid: string): Promise<boolean> {
    return Promise.resolve(this.tryLock(lockKey(cid, lid), this.id));
  }

  releaseEdit(cid: string, lid: string): void {
    const key = lockKey(cid, lid);
    if (this.locks.get(key)?.tab === this.id) this.locks.delete(key);
  }

  onChanged(fn: (cid: string, lids: string[] | null) => void): () => void {
    this.changedListeners.add(fn);
    return () => {
      this.changedListeners.delete(fn);
    };
  }

  close(): void {
    this.closed = true;
    this.ch.close();
  }

  private tryLock(key: string, tab: string): boolean {
    const cur = this.locks.get(key);
    if (cur && cur.tab !== tab && this.now() - cur.seenAt <= EDIT_LOCK_TTL_MS) return false;
    this.locks.set(key, { tab, seenAt: this.now() });
    return true;
  }

  private broadcastChanged(origin: string, req: StorageRequest): void {
    if (!('cid' in req)) return;
    this.ch.postMessage({
      kind: 'changed',
      origin,
      cid: req.cid,
      lids: changedLids(req),
    } satisfies ProxyWire);
  }

  private async receive(msg: ProxyWire): Promise<void> {
    if (this.closed || !msg || typeof msg !== 'object') return;
    switch (msg.kind) {
      case 'hello':
        this.ch.postMessage({
          kind: 'holder-here',
          holder: this.id,
          init: this.init,
        } satisfies ProxyWire);
        return;
      case 'req': {
        const { from, id, req } = msg;
        // ⚠ follower の 'close' を実 worker に通さない ── holder の DB ごと閉じる。
        //    そのタブのロックだけ返して成功を返す
        if (req.op === 'close') {
          this.dropLocksOf(from);
          this.ch.postMessage({ kind: 'res', to: from, id, ok: true, result: null } satisfies ProxyWire);
          return;
        }
        try {
          const result = await this.real.request(req as RequestFor<StorageRequest['op']>);
          this.ch.postMessage({ kind: 'res', to: from, id, ok: true, result } satisfies ProxyWire);
          if (MUTATING_OPS.has(req.op)) {
            this.broadcastChanged(from, req);
            // 🔑 holder 自身のアプリにも知らせる ── follower の書込は holder の
            //    dispatcher を通らないので、放送(自分には届かない)とは別に直接呼ぶ
            if ('cid' in req)
              for (const fn of this.changedListeners) fn(req.cid, changedLids(req));
          }
        } catch (e) {
          this.ch.postMessage({
            kind: 'res',
            to: from,
            id,
            ok: false,
            error: e instanceof Error ? e.message : String(e),
          } satisfies ProxyWire);
        }
        return;
      }
      case 'edit-acquire': {
        const granted = this.tryLock(lockKey(msg.cid, msg.lid), msg.from);
        this.ch.postMessage({
          kind: 'edit-res',
          to: msg.from,
          id: msg.id,
          granted,
        } satisfies ProxyWire);
        return;
      }
      case 'edit-release': {
        const key = lockKey(msg.cid, msg.lid);
        if (this.locks.get(key)?.tab === msg.from) this.locks.delete(key);
        return;
      }
      case 'edit-ping': {
        for (const key of msg.keys) {
          const cur = this.locks.get(key);
          if (cur && cur.tab === msg.from) cur.seenAt = this.now();
        }
        return;
      }
      case 'bye':
        this.dropLocksOf(msg.from);
        return;
      default:
        return;
    }
  }

  private dropLocksOf(tab: string): void {
    for (const [key, v] of this.locks) if (v.tab === tab) this.locks.delete(key);
  }
}

/* ---------------------------------------------------------------- follower */

export interface FollowerDeps extends CommonDeps {
  readonly handshakeTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly editPingMs?: number;
  readonly setTimeoutFn?: typeof setTimeout;
  readonly clearTimeoutFn?: typeof clearTimeout;
  readonly setIntervalFn?: typeof setInterval;
  readonly clearIntervalFn?: typeof clearInterval;
}

interface Pending {
  readonly req: StorageRequest;
  readonly resolve: (v: unknown) => void;
  readonly reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * follower 側。`connect()` が holder と handshake できたら成立(null = holder 不在
 * か旧ビルド ── 呼び側は従来の待機画面へ)。lease が回ってきたら `promote()` で
 * 実 worker に乗り換える。
 */
export class ProxyStoreClient implements StoreClientLike, TabSync {
  private readonly ch: Broadcaster;
  private readonly id: string;
  private readonly deps: FollowerDeps;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly editWaiters = new Map<number, (granted: boolean) => void>();
  /** 自分が握っている編集ロック(holder 交代時の再主張と ping に使う)。 */
  private readonly heldEdits = new Map<string, { cid: string; lid: string }>();
  private readonly changedListeners = new Set<(cid: string, lids: string[] | null) => void>();
  private readonly revokedListeners = new Set<(cid: string, lid: string) => void>();
  private state: 'channel' | 'promoting' | 'real' = 'channel';
  private realClient: StoreClientLike | null = null;
  private buffered: Array<{ req: StorageRequest; resolve: (v: unknown) => void; reject: (e: Error) => void }> = [];
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private terminated = false;
  initResult: InitResult | null = null;

  private constructor(deps: FollowerDeps) {
    this.deps = deps;
    this.id = deps.tabId ?? makeTabId();
    this.ch = openChannel(deps);
    this.ch.onmessage = (ev: MessageEvent): void => {
      this.receive(ev.data as ProxyWire);
    };
  }

  /**
   * handshake して follower を作る。holder が応えなければ null(⚠ その場合も
   * channel は閉じて返す ── 開きっぱなしの 1 本を残さない)。
   */
  static connect(deps: FollowerDeps = {}): Promise<ProxyStoreClient | null> {
    const f = new ProxyStoreClient(deps);
    const setT = deps.setTimeoutFn ?? setTimeout;
    return new Promise((resolve) => {
      let done = false;
      const timer = setT(() => {
        if (done) return;
        done = true;
        f.ch.close();
        resolve(null);
      }, deps.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS);
      f.onHolderHere = () => {
        if (done) return;
        done = true;
        (deps.clearTimeoutFn ?? clearTimeout)(timer);
        f.startPing();
        resolve(f);
      };
      f.ch.postMessage({ kind: 'hello', from: f.id } satisfies ProxyWire);
    });
  }

  private onHolderHere: (() => void) | null = null;

  role(): 'holder' | 'follower' {
    return this.state === 'real' ? 'holder' : 'follower';
  }

  request<Op extends StorageRequest['op']>(req: RequestFor<Op>): Promise<ResultMap[Op]> {
    if (this.terminated) return Promise.reject(new Error('store client terminated'));
    if (this.state === 'real' && this.realClient) return this.realClient.request(req);
    if (this.state === 'promoting') {
      return new Promise((resolve, reject) => {
        this.buffered.push({ req, resolve: resolve as (v: unknown) => void, reject });
      });
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const setT = this.deps.setTimeoutFn ?? setTimeout;
      const p: Pending = {
        req,
        resolve: resolve as (v: unknown) => void,
        reject,
        timer: null,
      };
      p.timer = setT(() => {
        this.pending.delete(id);
        reject(new Error('本体タブと通信できません(応答がありません)'));
      }, this.deps.requestTimeoutMs ?? REQUEST_TIMEOUT_MS);
      this.pending.set(id, p);
      this.ch.postMessage({ kind: 'req', from: this.id, id, req } satisfies ProxyWire);
    });
  }

  acquireEdit(cid: string, lid: string): Promise<boolean> {
    if (this.terminated) return Promise.resolve(false);
    const key = lockKey(cid, lid);
    if (this.state !== 'channel') {
      // 昇格後は自分が裁定者になっているはず ── 呼び側は host の TabSync に
      // 乗り換えている(onPromoted)。ここへ来たら握って良い
      this.heldEdits.set(key, { cid, lid });
      return Promise.resolve(true);
    }
    const id = this.nextId++;
    return new Promise((resolve) => {
      const setT = this.deps.setTimeoutFn ?? setTimeout;
      const timer = setT(() => {
        this.editWaiters.delete(id);
        resolve(false); // 返事が無い = holder 不在。安全側(編集させない)へ倒す
      }, this.deps.requestTimeoutMs ?? REQUEST_TIMEOUT_MS);
      this.editWaiters.set(id, (granted) => {
        (this.deps.clearTimeoutFn ?? clearTimeout)(timer);
        if (granted) this.heldEdits.set(key, { cid, lid });
        resolve(granted);
      });
      this.ch.postMessage({ kind: 'edit-acquire', from: this.id, id, cid, lid } satisfies ProxyWire);
    });
  }

  releaseEdit(cid: string, lid: string): void {
    const key = lockKey(cid, lid);
    if (!this.heldEdits.delete(key)) return;
    if (this.state === 'channel')
      this.ch.postMessage({ kind: 'edit-release', from: this.id, cid, lid } satisfies ProxyWire);
  }

  onChanged(fn: (cid: string, lids: string[] | null) => void): () => void {
    this.changedListeners.add(fn);
    return () => {
      this.changedListeners.delete(fn);
    };
  }

  /** holder 交代時のロック再主張が**否認された**とき(編集権を失った)。 */
  onEditRevoked(fn: (cid: string, lid: string) => void): () => void {
    this.revokedListeners.add(fn);
    return () => {
      this.revokedListeners.delete(fn);
    };
  }

  /** 自分が握っている編集ロック(昇格時に新 host の台帳へ引き継ぐ)。 */
  heldEditLocks(): Array<{ cid: string; lid: string }> {
    return [...this.heldEdits.values()];
  }

  /**
   * lease が回ってきた ── 実 worker に乗り換える(このタブが新 holder になる)。
   * 呼び側は返ってきた client/init で `StoreProxyHost` を建てること。
   * 乗り換え中に来た要求はバッファし、実 client 成立後に流す。
   */
  async promote(
    makeReal: () => Promise<{ client: StoreClientLike; init: InitResult }>,
  ): Promise<{ client: StoreClientLike; init: InitResult }> {
    this.state = 'promoting';
    this.stopPing();
    // 宙に浮いている channel 要求は新 client で引き継ぐ(旧 holder は死んでいる)
    for (const [id, p] of this.pending) {
      if (p.timer !== null) (this.deps.clearTimeoutFn ?? clearTimeout)(p.timer);
      this.pending.delete(id);
      this.buffered.push({ req: p.req, resolve: p.resolve, reject: p.reject });
    }
    const { client, init } = await makeReal();
    this.realClient = client;
    this.initResult = init;
    this.state = 'real';
    const toFlush = this.buffered;
    this.buffered = [];
    for (const b of toFlush) {
      client
        .request(b.req as RequestFor<StorageRequest['op']>)
        .then(b.resolve, (e: Error) => b.reject(e));
    }
    this.ch.close();
    return { client, init };
  }

  terminate(): void {
    this.terminated = true;
    this.stopPing();
    if (this.state === 'channel')
      this.ch.postMessage({ kind: 'bye', from: this.id } satisfies ProxyWire);
    this.ch.close();
    for (const p of this.pending.values()) {
      if (p.timer !== null) (this.deps.clearTimeoutFn ?? clearTimeout)(p.timer);
      p.reject(new Error('store client terminated'));
    }
    this.pending.clear();
    this.realClient?.terminate();
  }

  private startPing(): void {
    const setI = this.deps.setIntervalFn ?? setInterval;
    this.pingTimer = setI(() => {
      if (this.heldEdits.size === 0) return;
      this.ch.postMessage({
        kind: 'edit-ping',
        from: this.id,
        keys: [...this.heldEdits.keys()],
      } satisfies ProxyWire);
    }, this.deps.editPingMs ?? EDIT_PING_MS);
  }

  private stopPing(): void {
    if (this.pingTimer !== null) (this.deps.clearIntervalFn ?? clearInterval)(this.pingTimer);
    this.pingTimer = null;
  }

  private receive(msg: ProxyWire): void {
    if (this.terminated || !msg || typeof msg !== 'object') return;
    switch (msg.kind) {
      case 'holder-here': {
        if (this.onHolderHere) {
          const fn = this.onHolderHere;
          this.onHolderHere = null;
          this.initResult = msg.init;
          fn();
          return;
        }
        if (this.state !== 'channel') return;
        // holder 交代(前の holder が死に、別タブが昇格した)。
        // ① 宙に浮いた要求を新 holder へ再送(旧 holder が適用済みでも upsert は
        //    同内容の上書きで、データが欠ける向きにはならない)
        for (const [id, p] of this.pending)
          this.ch.postMessage({ kind: 'req', from: this.id, id, req: p.req } satisfies ProxyWire);
        // ② 編集ロックの再主張(新 holder の台帳は空で始まる)
        for (const [key, { cid, lid }] of this.heldEdits) {
          const id = this.nextId++;
          this.editWaiters.set(id, (granted) => {
            if (granted) return;
            this.heldEdits.delete(key);
            for (const fn of this.revokedListeners) fn(cid, lid);
          });
          this.ch.postMessage({ kind: 'edit-acquire', from: this.id, id, cid, lid } satisfies ProxyWire);
        }
        return;
      }
      case 'res': {
        if (msg.to !== this.id) return;
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (p.timer !== null) (this.deps.clearTimeoutFn ?? clearTimeout)(p.timer);
        if (msg.ok) p.resolve(msg.result);
        else p.reject(new Error(msg.error));
        return;
      }
      case 'edit-res': {
        if (msg.to !== this.id) return;
        const w = this.editWaiters.get(msg.id);
        if (!w) return;
        this.editWaiters.delete(msg.id);
        w(msg.granted);
        return;
      }
      case 'changed': {
        if (msg.origin === this.id) return; // 自分の書込は自分の state が既に知っている
        for (const fn of this.changedListeners) fn(msg.cid, msg.lids);
        return;
      }
      default:
        return;
    }
  }
}
