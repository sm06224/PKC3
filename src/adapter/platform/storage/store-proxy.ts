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
/**
 * 編集ロックの生存確認間隔(follower → holder)と、掃除の閾値。
 * ⚠ TTL は **crash した follower の置き土産**を掃除するためだけの物 ──
 *   holder 自身のロックには適用しない(tryLock 参照。レビュー H-1: 適用すると
 *   本体タブで 45 秒編集しただけで別タブに同じノートを取られる)。
 * ⚠ 5 分にしてあるのは背面タブの timer throttling 対策(レビュー L-3 ──
 *   Chrome は背面の interval を 60 秒に間引くので、45 秒だと ping が TTL を跨ぐ)。
 */
export const EDIT_PING_MS = 15_000;
export const EDIT_LOCK_TTL_MS = 300_000;

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

/**
 * 編集権の返答は 3 値(レビュー M-7)。⚠ boolean にすると「返事が無い」と
 * 「別タブが編集中」が同じ顔になり、holder 不在のとき user に**存在しない
 * 編集タブを探させる**文言を出してしまう。
 */
export type EditGrant = 'granted' | 'denied' | 'unreachable';

/** タブ間で同期すべきことの口(holder / follower の両実装が同じ形で持つ)。 */
export interface TabSync {
  role(): 'holder' | 'follower';
  /** この lid の編集権を取る。denied = 別タブが編集中 / unreachable = 本体と話せない。 */
  acquireEdit(cid: string, lid: string): Promise<EditGrant>;
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

  acquireEdit(cid: string, lid: string): Promise<EditGrant> {
    return Promise.resolve(this.tryLock(lockKey(cid, lid), this.id) ? 'granted' : 'denied');
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
    if (cur && cur.tab !== tab) {
      // 🔴 **holder 自身のロックは時間で失効させない**(レビュー H-1)。
      //    holder が生きている限り有効 ── 死ねば台帳ごと消えるので TTL は不要。
      //    TTL の対象は「crash して bye も ping も出せなかった follower」だけ。
      const stale = cur.tab !== this.id && this.now() - cur.seenAt > EDIT_LOCK_TTL_MS;
      if (!stale) return false;
    }
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
  /** cid/lid を持つのは holder 交代時の**再送**のため(レビュー M-7)。 */
  private readonly editWaiters = new Map<
    number,
    { cid: string; lid: string; settle: (g: EditGrant) => void }
  >();
  /** 自分が握っている編集ロック(holder 交代時の再主張と ping に使う)。 */
  private readonly heldEdits = new Map<string, { cid: string; lid: string }>();
  private readonly changedListeners = new Set<(cid: string, lids: string[] | null) => void>();
  private readonly revokedListeners = new Set<(cid: string, lid: string) => void>();
  /** 'dead' = 昇格失敗(レビュー H-2)── 以後の要求は**即断る**(静かに積まない)。 */
  private state: 'channel' | 'promoting' | 'real' | 'dead' = 'channel';
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
        /**
         * タブ終了で 'bye'(レビュー L-1)── 出せれば holder が即ロックを返すので、
         * 「閉じたのに数分ロックが残る」を縮める。⚠ crash では出ない ── そのときの
         * 保険が TTL(EDIT_LOCK_TTL_MS)。⚠ bfcache 誤発火(window-close.ts の教訓)は
         * 実害が無い ── 誤って bye しても、次の編集で取り直すだけで壊れない。
         */
        if (typeof window !== 'undefined')
          window.addEventListener('pagehide', () => {
            if (!f.terminated && f.state === 'channel')
              f.ch.postMessage({ kind: 'bye', from: f.id } satisfies ProxyWire);
          });
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
    if (this.state === 'dead')
      return Promise.reject(
        new Error('本体への切り替えに失敗しています(タブを読み直してください)'),
      );
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

  acquireEdit(cid: string, lid: string): Promise<EditGrant> {
    if (this.terminated || this.state === 'dead') return Promise.resolve('unreachable');
    const key = lockKey(cid, lid);
    if (this.state !== 'channel') {
      // 昇格後は自分が裁定者になっているはず ── 呼び側は host の TabSync に
      // 乗り換えている(onPromoted)。ここへ来たら握って良い
      this.heldEdits.set(key, { cid, lid });
      return Promise.resolve('granted');
    }
    const id = this.nextId++;
    return new Promise((resolve) => {
      const setT = this.deps.setTimeoutFn ?? setTimeout;
      const timer = setT(() => {
        this.editWaiters.delete(id);
        // 返事が無い = holder 不在。安全側(編集させない)へ倒すが、
        // 「別のタブが編集中」とは**別の顔**で返す(M-7 ── 文言の嘘を作らない)
        resolve('unreachable');
      }, this.deps.requestTimeoutMs ?? REQUEST_TIMEOUT_MS);
      this.editWaiters.set(id, {
        cid,
        lid,
        settle: (g) => {
          (this.deps.clearTimeoutFn ?? clearTimeout)(timer);
          if (g === 'granted') this.heldEdits.set(key, { cid, lid });
          resolve(g);
        },
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
    let real: { client: StoreClientLike; init: InitResult };
    try {
      real = await makeReal();
    } catch (e) {
      /**
       * 🔴 失敗を静かに hang させない(レビュー H-2)。ここで止まると promoting の
       * バッファに以後の全要求が**無期限に**積まれ、保存が「できたように見えて
       * disk に無い」最悪の形になる ── 積んだ物を全部断り、以後も即断る。
       */
      this.state = 'dead';
      const msg = e instanceof Error ? e.message : String(e);
      const toReject = this.buffered;
      this.buffered = [];
      for (const b of toReject)
        b.reject(new Error(`本体への切り替えに失敗しました: ${msg}`));
      this.ch.close();
      throw e;
    }
    this.realClient = real.client;
    this.initResult = real.init;
    this.state = 'real';
    const toFlush = this.buffered;
    this.buffered = [];
    for (const b of toFlush) {
      real.client
        .request(b.req as RequestFor<StorageRequest['op']>)
        .then(b.resolve, (e: Error) => b.reject(e));
    }
    this.ch.close();
    return real;
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
        // ②' 待っている edit-acquire も再送(M-7 ── 再送しないと、新 holder が
        //     1 秒で立っても user の「編集」は 10 秒の満了まで黙って待たされる)
        for (const [id, w] of this.editWaiters)
          this.ch.postMessage({
            kind: 'edit-acquire',
            from: this.id,
            id,
            cid: w.cid,
            lid: w.lid,
          } satisfies ProxyWire);
        // ② 編集ロックの再主張(新 holder の台帳は空で始まる)
        for (const [key, { cid, lid }] of this.heldEdits) {
          const id = this.nextId++;
          this.editWaiters.set(id, {
            cid,
            lid,
            settle: (g) => {
              if (g === 'granted') return;
              this.heldEdits.delete(key);
              for (const fn of this.revokedListeners) fn(cid, lid);
            },
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
        w.settle(msg.granted ? 'granted' : 'denied');
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
