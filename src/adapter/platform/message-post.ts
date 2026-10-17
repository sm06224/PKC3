/**
 * 🔴 **メッセージを書く、唯一の口**(設計 doc §7、段②a)。
 *
 * ⚠ **中身を漏らさない**(§7)── `text` はここで必ず `sanitizeMessageText` を通す。
 * 呼び側(`main.ts`)は sqlite の知識も IndexedDB の知識も持たない ── ここが
 * 「sqlite に書けないときは控えへ」を吸収する。
 *
 * ⚠ `client`(storage worker への口)は boot が終わるまで存在しないので、
 * `attach()` で**後から**渡す(`CopyHistoryStore` / `appOfficePack` と同じ作法)。
 * `attach()` の前に呼ばれた `post()` は**控えに積むだけ**にする(黙って捨てない)。
 *
 * 🔴 **`kind: 'job'` だけ束ねる**(設計 doc §7、段②b)。`appendMessage` は
 * その system ノートの本文全体を読み書きする ── ワーカーの動き(`job-monitor.ts`)
 * のたびに 1 回書くと、重い処理を増やすたびに sqlite への書込まで増える
 * (CLAUDE.md 不可侵指示「重い処理はワーカーへ」の書込版)。**50 件 or 5 秒**で
 * まとめて 1 回の `appendMessage` にする。⚠ **閉じる直前(pagehide /
 * visibilitychange:hidden)に残りを流す**口(`flushJobBuffer()`)を必ず main.ts
 * から呼ぶこと ── 呼ばないと、閉じる寸前に溜まった分がそのまま消える。
 */
import {
  capForMessageLid,
  formatMessageSection,
  lidForMessageKind,
  MESSAGE_CAP_DEFAULT,
  MESSAGE_CAP_OPTIONS,
  parseMessageCap,
  countUnread,
  postedAtAfterReadMark,
  withSpooledSections,
  sanitizeMessageText,
  titleForMessageLid,
  type MessageKind,
} from '@features/message/message-log';

const CAP_KEY = 'pkc3.messages.cap';
/** 既読の時刻の key。⚠ 他のタブの既読を聞く側(`message-sync.ts`)が同じ key を見る。 */
export const READ_AT_KEY = 'pkc3.messages.read-at';

/**
 * 保存が読めない / 書けない端末の控え(この session では効いている)。
 * ⚠ 設定の store 群(`alarm-enabled.ts` ほか)と同じ作法 ── 控えが無いと、
 *   localStorage が使えない端末では件数を選んでも何も起きない(#1087)。
 */
let capFallback: number | null = null;
/** 🔴 直近の書き込みが失敗したか。真の間は読みも控えを返す(戻らない)。 */
let capSaveFailed = false;

/** 好みの上限。⚠ 壊れた値・古い版が書いた値は既定へ丸める(黙って落とさない)。 */
export function currentMessageCap(): number {
  if (capSaveFailed && capFallback !== null) return capFallback;
  try {
    // 🔴 `localStorage` が無い環境は `getItem` を呼ぶ前に例外になる ── その枝は下の控えへ
    const stored = parseMessageCap(localStorage.getItem(CAP_KEY));
    return stored ?? MESSAGE_CAP_DEFAULT;
  } catch {
    return capFallback ?? MESSAGE_CAP_DEFAULT;
  }
}

/** ⚠ 選べる値以外は黙って無視する(壊れた値を書かせない)。 */
export function setMessageCap(n: number): void {
  if (!MESSAGE_CAP_OPTIONS.includes(n)) return;
  capFallback = n;
  capSaveFailed = false;
  try {
    localStorage.setItem(CAP_KEY, String(n));
  } catch {
    // 🔴 書けなかった ── 次に書けるまで、読みは控え(選んだ値)を返す
    capSaveFailed = true;
  }
}

/** test 用: 控えを空に戻す。 */
export function resetMessageCapFallbackForTest(): void {
  capFallback = null;
  capSaveFailed = false;
}

/** 最後にメッセージのノートを開いた時刻(ISO)。まだ 1 度も開いていなければ `null`。 */
export function messagesReadAt(): string | null {
  try {
    return localStorage.getItem(READ_AT_KEY);
  } catch {
    return null;
  }
}

function stampMessagesRead(atMs: number): void {
  try {
    localStorage.setItem(READ_AT_KEY, new Date(atMs).toISOString());
  } catch {
    /* この端末では憶えられない ── 次回起動でまた未読に見えるだけで、実害は無い */
  }
}

/** 1 件の控え(sqlite に書けなかった分)。 */
export interface SpoolItem {
  readonly cid: string;
  readonly lid: string;
  readonly title: string;
  readonly section: string;
  readonly cap: number;
}

/**
 * 🔴 **控えの置き場**(§7「sqlite に書けないとき」)。
 * ⚠ **入れ替え可能にする**(`CopyHistoryStorage` と同じ作法)── unit test は
 *   実 IndexedDB を持たない環境で回るので、in-memory の偽物を渡せる形にする。
 */
export interface MessageSpool {
  list(): Promise<ReadonlyArray<{ id: IDBValidKey; item: SpoolItem }>>;
  /** 件数だけ。⚠ 毎回の `post` は、空かどうかをこれで見る(本文ごと全件を読まない)。 */
  count(): Promise<number>;
  push(item: SpoolItem): Promise<void>;
  remove(id: IDBValidKey): Promise<void>;
}

/**
 * 🔴 **控えの上限**(#1087)。⚠ 書けない状態が続くと控えは増える一方だったので、超えたら**古い順に**捨てる
 *   (メッセージの上限と同じ向き ── 新しい知らせを残す)。
 */
export const SPOOL_CAP = 500;

const SPOOL_DB_NAME = 'pkc3-messages';
const SPOOL_STORE = 'spool';

function openSpoolDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(SPOOL_DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(SPOOL_STORE))
        req.result.createObjectStore(SPOOL_STORE, { autoIncrement: true });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('idb open failed'));
  });
}

/** ⚠ 書きは commit(`oncomplete`)まで待つ(`asset-blob-store.ts` と同じ理由)。 */
function tx<T>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = db.transaction(SPOOL_STORE, mode);
    const req = run(t.objectStore(SPOOL_STORE));
    const fail = (e: unknown): void =>
      reject(e instanceof Error ? e : new Error('idb request failed'));
    if (mode === 'readonly') {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => fail(req.error);
      return;
    }
    let result: T;
    req.onsuccess = () => {
      result = req.result;
    };
    t.oncomplete = () => resolve(result);
    t.onerror = () => fail(t.error);
    t.onabort = () => fail(t.error ?? new Error('idb transaction aborted'));
  });
}

class IdbMessageSpool implements MessageSpool {
  private db: IDBDatabase | null = null;

  private async need(): Promise<IDBDatabase> {
    if (!this.db) this.db = await openSpoolDb();
    return this.db;
  }

  async list(): Promise<ReadonlyArray<{ id: IDBValidKey; item: SpoolItem }>> {
    const db = await this.need();
    const keys = await tx<IDBValidKey[]>(db, 'readonly', (s) => s.getAllKeys());
    const values = await tx<SpoolItem[]>(db, 'readonly', (s) => s.getAll());
    return keys.map((id, i) => ({ id, item: values[i] as SpoolItem }));
  }

  async count(): Promise<number> {
    return tx<number>(await this.need(), 'readonly', (s) => s.count());
  }

  async push(item: SpoolItem): Promise<void> {
    await tx(await this.need(), 'readwrite', (s) => s.add(item));
  }

  async remove(id: IDBValidKey): Promise<void> {
    await tx(await this.need(), 'readwrite', (s) => s.delete(id));
  }
}

/** boot が終わってから渡す物(`client` が要るので後から届く)。 */
export interface MessagePostDeps {
  readonly cid: string;
  readonly appendMessage: (req: {
    cid: string;
    lid: string;
    title: string;
    section: string;
    cap: number;
  }) => Promise<unknown>;
}

/** job だけ束ねる ── これだけ件数か時間かで待たせる(§7、段②b)。 */
const JOB_BATCH_SIZE = 50;
const JOB_BATCH_MS = 5000;

/** 溜めている job の節(まだ書いていない分)。 */
interface JobBatch {
  lid: string;
  title: string;
  cap: number;
  sections: string[];
}

/**
 * 🔴 **アプリ全体で 1 個**(`appMessagePost`)── 2 個作ると、未読の数を
 * 2 か所で別々に数えることになる(CLAUDE.md §7)。
 */
export class MessagePost {
  private deps: MessagePostDeps | null = null;
  private unread = 0;
  /** 未読を増やした `post` の通算(`seedUnread` が「種を頼んだ後に増えた分」を足すための目盛り)。 */
  private unreadPosts = 0;
  /** `markRead` の通算(種を頼んだ後に既読にされたら、古い種は捨てる)。 */
  private readCount = 0;
  /** 書いている途中の `deliver`(種を頼む前に、これらが書き終わるのを待つ)。 */
  private inflight = new Set<Promise<void>>();
  private listeners: Array<(n: number) => void> = [];
  /** ⚠ `job` だけ。他の種類は即座に `deliver()` する(束ねない)。 */
  private jobBatch: JobBatch | null = null;
  private jobTimer: ReturnType<typeof setTimeout> | null = null;
  /** 直近に積んだ節の時刻(ms)。既読の時刻がこれより前に戻らないための目盛り。 */
  private lastPostedAtMs = 0;

  constructor(private readonly spool: MessageSpool = new IdbMessageSpool()) {}

  /** main.ts の boot が client / cid を確定させたら 1 度だけ呼ぶ。 */
  attach(deps: MessagePostDeps): void {
    this.deps = deps;
    void this.flushSpool();
  }

  /** 未読の数が変わったら呼ばれる(状態への反映は main.ts が張る)。 */
  onUnreadChanged(fn: (n: number) => void): () => void {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter((f) => f !== fn);
    };
  }

  private writtenListeners: Array<(lid: string) => void> = [];

  /**
   * 🔴 **ノートへ節が書き込まれた**(#1087)。⚠ 開いているメッセージのノートを読み直す合図 ──
   *   開いたまま新しい知らせが来ても、本文は読み込んだ時点のままだった。書けた後にだけ呼ぶ(控えへ積んだ分は呼ばない)。
   */
  onWritten(fn: (lid: string) => void): () => void {
    this.writtenListeners.push(fn);
    return () => {
      this.writtenListeners = this.writtenListeners.filter((f) => f !== fn);
    };
  }

  private notifyWritten(lid: string): void {
    for (const f of this.writtenListeners) f(lid);
  }

  private notify(): void {
    for (const f of this.listeners) f(this.unread);
  }

  /**
   * 起動直後、disk の本文から数え直した未読を種として渡す。
   * 🔴 **`postsAtRequest` を渡すと**、種を頼んだ後に増えた分(`unreadPosts` の差)を足す ── 直す前は
   *   `unread = n` で上書きしたので、読み込みの間に積んだ注意が消えていた(#1087)。
   */
  seedUnread(n: number, postsAtRequest: number = this.unreadPosts): void {
    this.unread = n + (this.unreadPosts - postsAtRequest);
    this.notify();
  }

  /**
   * 🔴 **起動直後の未読を disk から数えて種にする**(main.ts の boot が呼ぶ)。
   * ⚠ 順番が肝心:①**書きかけの分が書き終わるのを待つ** ②目盛りを控えて**同じ同期の中で**本文を頼む。
   *   ①が無いと「頼む前に積んだが、まだ書けていない分」が種にも差分にも入らず落ちる。
   *   ②の後に積んだ分は、本文の読みより後に書かれる(同じ経路の順番)ので、差分で足せば二重にならない。
   * ⚠ 待っている間 / 読んでいる間に既読にされたら、古い種は捨てる(既読を巻き戻さない)。
   */
  async seedUnreadFromDisk(readBody: () => Promise<string | null | undefined>): Promise<void> {
    await this.whenWritten();
    const posts = this.unreadPosts;
    const reads = this.readCount;
    const body = await readBody();
    if (reads !== this.readCount) return;
    this.seedUnread(countUnread(body ?? '', messagesReadAt()), posts);
  }

  /**
   * 🔴 **画面・書き出しが読む本文は、控えの分も含める**(#1087 M1)。⚠ 書けない状態(壊れ / 容量)では
   *   節は控えにしか無く、本文だけ読むと「未読 1 件」なのに画面は空だった。
   * - ノートの本文の後ろへ、その lid の控えの節を作られた順に足す(整形し直さない)。
   * - 本文が読めなかったときは、控えがあれば控えだけを返す(設計 doc §7「DB が読めなければ控えを出す」)。
   *   控えも無ければ、元の例外を投げる。
   * ⚠ 本文 → 控えの順に読む:流しの途中(書いた後・控えから消す前)に読んでも二重にならず、
   *   落ちるのは一瞬だけで、書込の合図で読み直される。
   */
  async withSpool(lid: string, readDb: () => Promise<string | null | undefined>): Promise<string> {
    let db = '';
    let failure: unknown = null;
    let failed = false;
    try {
      db = (await readDb()) ?? '';
    } catch (e) {
      failed = true;
      failure = e;
    }
    let spooled: string[] = [];
    try {
      const cid = this.deps?.cid;
      spooled = (await this.spool.list())
        .filter(({ item }) => item.lid === lid && (cid === undefined || item.cid === '' || item.cid === cid))
        .map(({ item }) => item.section);
    } catch {
      /* 控えが読めない ── 本文だけ返す(本文も読めていなければ下で投げる) */
    }
    if (failed && spooled.length === 0) throw failure;
    return withSpooledSections(db, spooled);
  }

  /** 書きかけの分(控えの流しも含む)がすべて終わるまで待つ。 */
  async whenWritten(): Promise<void> {
    for (;;) {
      const pending: Array<Promise<unknown>> = [...this.inflight];
      if (this.spoolRun !== null) pending.push(this.spoolRun);
      if (pending.length === 0) return;
      await Promise.allSettled(pending);
    }
  }

  /** メッセージのノートを開いた ── 既読の時刻を進め、未読を 0 にする。 */
  markRead(): void {
    // 🔴 既読の次の秒へ送って積んだ節(`post`)があれば、その時刻まで進める ── 進めないと数え直しで未読に戻る(#1087 M5)
    stampMessagesRead(Math.max(Date.now(), this.lastPostedAtMs));
    this.unread = 0;
    this.readCount += 1;
    this.notify();
  }

  /**
   * 🔴 **書く口はここだけ**(§7)。
   * ⚠ `text` は user の入力や本文の断片を含みうる想定で扱う ── 必ずここで
   *   `sanitizeMessageText` を通す(呼び側に任せない。判断を 1 か所に置く)。
   */
  post(input: { kind: MessageKind; source: string; text: string; fixedHead?: string }): void {
    /**
     * 🔴 **空の字は積まない**(#1017 C5)。⚠ 直す前は、進行中の字を消すための `notify('')` が
     *   `OP_NOTICE` 経由で**「結果」の空の節を 1 件**積んでいた(見出しと種類だけの行)。
     *   ここに置くのは、呼び側が増えても**書く口の 1 か所**で止めるため(§7)。
     */
    if (input.text.trim() === '') return;
    const lid = lidForMessageKind(input.kind);
    const title = titleForMessageLid(lid);
    const cap = capForMessageLid(lid, currentMessageCap());
    const at = postedAtAfterReadMark(new Date().toISOString(), messagesReadAt());
    this.lastPostedAtMs = Math.max(this.lastPostedAtMs, Date.parse(at));
    const section = formatMessageSection({
      at,
      kind: input.kind,
      source: input.source,
      text: sanitizeMessageText(input.text, input.fixedHead),
    });
    if (input.kind === 'caution' || input.kind === 'problem') {
      this.unread += 1;
      this.unreadPosts += 1;
      this.notify();
    }
    if (input.kind === 'job') {
      this.bufferJob(lid, title, cap, section);
      return;
    }
    this.deliver(lid, title, cap, section);
  }

  /** 1 件を disk(または boot 前の控え)へ送る。⚠ `job` 以外はここを直に通る。 */
  private deliver(lid: string, title: string, cap: number, section: string): void {
    const cid = this.deps?.cid;
    if (cid === undefined) {
      // ⚠ boot 前 ── 起きない想定だが、黙って捨てない(控えへ積む)
      void this.stash({ cid: '', lid, title, section, cap }).catch(() => {});
      return;
    }
    const req = { cid, lid, title, section, cap };
    // 🔴 **書きは 1 本の鎖で順に**(#1087 M9)。⚠ 直す前は、控えが空のあいだ 2 件が同時に書きへ進み、
    //   1 件目が一時的に失敗して控えへ回ると 2 件目が先に書かれた(二件目 → 一件目)。前の 1 件が
    //   書けた / 控えへ回った後で次が控えを流す(失敗した分が新しい分より先に書き直される)。
    //   ⚠ 前に走っている書きが無いときは鎖を挟まず直に流す(待ちの tick を増やさない)。
    this.pendingWrites += 1;
    const head = this.pendingWrites === 1 ? this.flushSpool() : this.chain.then(() => this.flushSpool());
    const run: Promise<void> = head
      .then((drained) =>
        // 🔴 控えが流し切れていないときは、**新しい分も控えの後ろへ**(先に書くと節の日時が前後する。#1087)
        drained ? this.write(req) : this.park(req),
      )
      .finally(() => {
        this.inflight.delete(run);
        this.pendingWrites -= 1;
      });
    this.inflight.add(run);
    this.chain = run.catch(() => {});
  }
  /** 書きの鎖(`deliver` の順番を守る)。⚠ 決して reject しない。 */
  private chain: Promise<void> = Promise.resolve();
  private pendingWrites = 0;

  /** 控えへ積み、上限を超えた分を古い順に捨てる。⚠ 積めなかったら投げる(呼び側が決める)。 */
  private async stash(item: SpoolItem): Promise<void> {
    await this.spool.push(item);
    try {
      const all = await this.spool.list();
      const over = all.length - SPOOL_CAP;
      for (let i = 0; i < over; i += 1) await this.spool.remove((all[i] as { id: IDBValidKey }).id);
    } catch {
      /* 上限の整理に失敗しても、積めた事実は変わらない(次の積みで整理される) */
    }
  }

  /** 控えの後ろへ積む。⚠ 控えそのものが使えないときは、順番より書くことを選ぶ(捨てない)。 */
  private async park(req: SpoolItem): Promise<void> {
    try {
      await this.stash(req);
    } catch {
      await this.write(req);
    }
  }

  /**
   * 🔴 **job だけ束ねる**(§7、段②b)。⚠ `appendMessage` は本文全体を読み書き
   *   するので、ワーカーの動きのたびに書くと sqlite への書込が跳ね上がる。
   *   **50 件か 5 秒**の早いほうでまとめて 1 回にする。
   */
  private bufferJob(lid: string, title: string, cap: number, section: string): void {
    if (!this.jobBatch) {
      this.jobBatch = { lid, title, cap, sections: [] };
    } else {
      // ⚠ cap は set-message-cap で変わりうる ── 直近の値で書く
      this.jobBatch.lid = lid;
      this.jobBatch.title = title;
      this.jobBatch.cap = cap;
    }
    this.jobBatch.sections.push(section);
    if (this.jobBatch.sections.length >= JOB_BATCH_SIZE) {
      this.flushJobBuffer();
      return;
    }
    if (this.jobTimer === null) {
      this.jobTimer = setTimeout(() => {
        this.jobTimer = null;
        this.flushJobBuffer();
      }, JOB_BATCH_MS);
    }
  }

  /**
   * 🔴 溜めた job の節をまとめて 1 回書く。
   * ⚠ **main.ts が `pagehide` / `visibilitychange`(hidden)から呼ぶ** ──
   *   呼ばないと、閉じる直前に溜まった分がそのまま消える。
   * ⚠ 何も溜まっていなければ何もしない(空の `appendMessage` を打たない)。
   */
  flushJobBuffer(): void {
    if (this.jobTimer !== null) {
      clearTimeout(this.jobTimer);
      this.jobTimer = null;
    }
    const batch = this.jobBatch;
    this.jobBatch = null;
    if (!batch || batch.sections.length === 0) return;
    this.deliver(batch.lid, batch.title, batch.cap, batch.sections.join(''));
  }

  private async write(req: {
    cid: string;
    lid: string;
    title: string;
    section: string;
    cap: number;
  }): Promise<void> {
    if (!this.deps) return;
    try {
      await this.deps.appendMessage(req);
      this.notifyWritten(req.lid);
    } catch {
      // 🔴 書けなかった(壊れている / DB 未起動)── 控えへ積んで、次の機会に流す
      await this.stash(req).catch(() => {});
    }
  }

  /**
   * 🔴 **走っている流しは 1 本だけ**(着地後レビュー 💭)。⚠ 1 稿目は重ねて走れたので、控えが空でない
   *   間に近い 2 つの `post`(それぞれが `deliver` から流す)が**同じ控えを両方読んで、二重に
   *   `appendMessage`** していた(同じ節がメッセージに 2 件並ぶ)。いま走っているなら**その Promise を返す**
   *   (呼び側は完了を待つだけなので、同じものを待たせて困らない)。
   */
  private spoolRun: Promise<boolean> | null = null;
  /** @returns 控えが空になったか(`false` なら、まだ残っている ── 新しい分は後ろへ回す)。 */
  private flushSpool(): Promise<boolean> {
    if (!this.deps) return Promise.resolve(true);
    // ⚠ `drainSpool` は必ず 1 度 await してから終わる ── 同期で終わると、下の代入が
    //   `finally` の `null` の後に走って「走っている」印が残りっぱなしになる
    this.spoolRun ??= this.drainSpool();
    return this.spoolRun;
  }

  /**
   * 控えを disk へ流し込む。⚠ **先頭から順に** ── 途中で失敗したら止める
   * (順序を守る。あとの節を先に書くと節の日時が前後する)。
   * ⚠ どの出口でも走っている印(`spoolRun`)を下ろす ── 下ろさないと以後の流しが全部止まる。
   */
  private drainSpool(): Promise<boolean> {
    // 🔴 別のタブと**同時に流さない**(同じ控えを両方が読むと、同じ節が二重に書かれる。#1087)。
    //   ロックが無い環境は、これまでどおり(同じタブの中の重なりは `spoolRun` が防ぐ)。
    const locks =
      typeof navigator === 'undefined' ? null : (navigator.locks as LockManager | null | undefined);
    const run =
      locks === null || locks === undefined
        ? this.drainBody()
        : locks.request('pkc3-message-spool', () => this.drainBody());
    // ⚠ 下ろす枝は**呼び側の `then` より先**に付ける(同じ tick で、印が先に消える)
    const release = (): void => {
      this.spoolRun = null;
    };
    run.then(release, release);
    return run;
  }

  private async drainBody(): Promise<boolean> {
    const deps = this.deps;
    if (!deps) return true;
    let items: ReadonlyArray<{ id: IDBValidKey; item: SpoolItem }>;
    try {
      // ⚠ 毎回の `post` が全件を読まないよう、空かどうかは件数で見る
      if ((await this.spool.count()) === 0) return true;
      items = await this.spool.list();
    } catch {
      return false; // 控えそのものが読めない ── 諦める(次の post でまた試す)
    }
    for (const { id, item } of items) {
      // ⚠ boot 前に積んだ分は cid が未確定(空文字)のまま控えている ── いまの cid で書き直す
      const fixed = item.cid === '' ? { ...item, cid: deps.cid } : item;
      try {
        await deps.appendMessage(fixed);
        this.notifyWritten(fixed.lid);
        await this.spool.remove(id).catch(() => {});
      } catch {
        return false;
      }
    }
    return true;
  }
}

export const appMessagePost = new MessagePost();
