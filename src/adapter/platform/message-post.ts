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
 */
import {
  capForMessageLid,
  formatMessageSection,
  lidForMessageKind,
  MESSAGE_CAP_DEFAULT,
  MESSAGE_CAP_OPTIONS,
  sanitizeMessageText,
  titleForMessageLid,
  type MessageKind,
} from '@features/message/message-log';

const CAP_KEY = 'pkc3.messages.cap';
const READ_AT_KEY = 'pkc3.messages.read-at';

/** 好みの上限。⚠ 壊れた値・古い版が書いた値は既定へ丸める(黙って落とさない)。 */
export function currentMessageCap(): number {
  try {
    const raw = localStorage.getItem(CAP_KEY);
    const n = raw === null ? NaN : Number(raw);
    return MESSAGE_CAP_OPTIONS.includes(n) ? n : MESSAGE_CAP_DEFAULT;
  } catch {
    return MESSAGE_CAP_DEFAULT;
  }
}

/** ⚠ 選べる値以外は黙って無視する(壊れた値を書かせない)。 */
export function setMessageCap(n: number): void {
  if (!MESSAGE_CAP_OPTIONS.includes(n)) return;
  try {
    localStorage.setItem(CAP_KEY, String(n));
  } catch {
    /* この端末では効かない(次回起動まで既定のまま)。押した印だけは付く */
  }
}

/** 最後にメッセージのノートを開いた時刻(ISO)。まだ 1 度も開いていなければ `null`。 */
export function messagesReadAt(): string | null {
  try {
    return localStorage.getItem(READ_AT_KEY);
  } catch {
    return null;
  }
}

function stampMessagesReadNow(): void {
  try {
    localStorage.setItem(READ_AT_KEY, new Date().toISOString());
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
  push(item: SpoolItem): Promise<void>;
  remove(id: IDBValidKey): Promise<void>;
}

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

/**
 * 🔴 **アプリ全体で 1 個**(`appMessagePost`)── 2 個作ると、未読の数を
 * 2 か所で別々に数えることになる(CLAUDE.md §7)。
 */
export class MessagePost {
  private deps: MessagePostDeps | null = null;
  private unread = 0;
  private listeners: Array<(n: number) => void> = [];

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

  private notify(): void {
    for (const f of this.listeners) f(this.unread);
  }

  /** 起動直後、disk の本文から数え直した未読を種として渡す(main.ts の boot が呼ぶ)。 */
  seedUnread(n: number): void {
    this.unread = n;
    this.notify();
  }

  /** メッセージのノートを開いた ── 既読の時刻を進め、未読を 0 にする。 */
  markRead(): void {
    stampMessagesReadNow();
    this.unread = 0;
    this.notify();
  }

  /**
   * 🔴 **書く口はここだけ**(§7)。
   * ⚠ `text` は user の入力や本文の断片を含みうる想定で扱う ── 必ずここで
   *   `sanitizeMessageText` を通す(呼び側に任せない。判断を 1 か所に置く)。
   */
  post(input: { kind: MessageKind; source: string; text: string }): void {
    const lid = lidForMessageKind(input.kind);
    const title = titleForMessageLid(lid);
    const cap = capForMessageLid(lid, currentMessageCap());
    const section = formatMessageSection({
      at: new Date().toISOString(),
      kind: input.kind,
      source: input.source,
      text: sanitizeMessageText(input.text),
    });
    if (input.kind === 'caution' || input.kind === 'problem') {
      this.unread += 1;
      this.notify();
    }
    const cid = this.deps?.cid;
    if (cid === undefined) {
      // ⚠ boot 前 ── 起きない想定だが、黙って捨てない(控えへ積む)
      void this.spool.push({ cid: '', lid, title, section, cap }).catch(() => {});
      return;
    }
    void this.flushSpool().then(() => this.write({ cid, lid, title, section, cap }));
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
    } catch {
      // 🔴 書けなかった(壊れている / DB 未起動)── 控えへ積んで、次の機会に流す
      await this.spool.push(req).catch(() => {});
    }
  }

  /**
   * 控えを disk へ流し込む。⚠ **先頭から順に** ── 途中で失敗したら止める
   * (順序を守る。あとの節を先に書くと節の日時が前後する)。
   */
  private async flushSpool(): Promise<void> {
    if (!this.deps) return;
    let items: ReadonlyArray<{ id: IDBValidKey; item: SpoolItem }>;
    try {
      items = await this.spool.list();
    } catch {
      return; // 控えそのものが読めない ── 諦める(次の post でまた試す)
    }
    for (const { id, item } of items) {
      // ⚠ boot 前に積んだ分は cid が未確定(空文字)のまま控えている ── いまの cid で書き直す
      const fixed = item.cid === '' ? { ...item, cid: this.deps.cid } : item;
      try {
        await this.deps.appendMessage(fixed);
        await this.spool.remove(id).catch(() => {});
      } catch {
        return;
      }
    }
  }
}

export const appMessagePost = new MessagePost();
