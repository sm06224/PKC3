/**
 * コピーした物の履歴の置き場(#678)。**端末ごと**(localStorage)。
 *
 * 🔴 **アプリのデータに混ぜない。** これは `theme.ts` / `flag-store.ts` /
 * `notice-store.ts` と**同じ判断**で、理由も同じ ── container に入れると
 * **書き出しに同乗する**。⚠ コピーした物は「その端末で、いま貼りたい物」であって、
 * 別の端末へ運ぶ物でも、誰かに渡す物でもない。
 *
 * ⚠ **issue #678 の推薦(sqlite の表 1 つ)を覆した**(2026-09-09)。理由は 2 つ:
 * ① 先例が 3 件そろって「混ぜない」を選んでいる ② 「探せる」という利点は
 * **N が大きいときの物**で、20 件を絞るのに SQL は要らない。
 * 🔑 これが分かったら覆る:**20 件では足りず、何百件も持ちたい**と分かったとき
 * (そのときは探せることに意味が出るので、置き場ごと考え直す)。
 *
 * 🔴 **溢れたら「積めなかった」と言える形にする** ── `setItem` は quota を
 * 超えると投げる。⚠ 黙って握り潰すと、user から見て
 * 「コピーしたのに履歴に無い」という**理由の分からない壊れ方**になる。
 */
import {
  COPY_HISTORY_BYTES_MAX,
  COPY_HISTORY_MAX,
  dropCopied,
  pushCopied,
  type CopiedItem,
} from '@features/clipboard/history';

const KEY = 'pkc3.copy.history';

/** 保存の口。⚠ test は偽物を渡して**書込の回数と中身**まで観測する。 */
export interface CopyHistoryStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

const browserStorage: CopyHistoryStorage = {
  get: (k) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k, v) => {
    // ⚠ ここでは握り潰さない ── 呼び側が「積めなかった」を知る必要がある
    localStorage.setItem(k, v);
  },
  remove: (k) => {
    try {
      localStorage.removeItem(k);
    } catch {
      /* 消せないだけ。この session では消えている */
    }
  },
};

/** 読めた形かを検める。⚠ 壊れた JSON で画面ごと落とさない。 */
function parse(raw: string | null): CopiedItem[] {
  if (raw === null || raw === '') return [];
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(v)) return [];
  const out: CopiedItem[] = [];
  for (const c of v) {
    if (typeof c !== 'object' || c === null) continue;
    const o = c as Record<string, unknown>;
    if (typeof o['text'] !== 'string' || o['text'] === '') continue;
    out.push({
      at: typeof o['at'] === 'number' ? o['at'] : 0,
      text: o['text'],
      html: typeof o['html'] === 'string' ? o['html'] : '',
    });
  }
  return out;
}

/**
 * ⚠ **アプリ全体で 1 個**にする(`appCopyHistory`)── 2 個作ると、
 * 一覧側と積む側が別の写しを持ち、消しても消えない形になる。
 */
export class CopyHistoryStore {
  private list: CopiedItem[];

  constructor(private readonly storage: CopyHistoryStorage = browserStorage) {
    this.list = parse(this.storage.get(KEY));
  }

  /** いま持っている物(新しい順)。 */
  items(): readonly CopiedItem[] {
    return this.list;
  }

  /**
   * 1 件積む。
   * @returns 積めたか。⚠ **false を返すのは置き場が受け取れなかったとき**
   *   ── 呼び側はそれを user に言う(黙って捨てない)。
   */
  push(item: CopiedItem): boolean {
    const next = pushCopied(this.list, item, COPY_HISTORY_MAX, COPY_HISTORY_BYTES_MAX);
    // ⚠ 積まれなかった(空など)ときは書きに行かない ── 無駄な書込をしない
    if (next.length === this.list.length && next[0]?.text === this.list[0]?.text) {
      this.list = next;
      return true;
    }
    return this.write(next);
  }

  /** 1 件消す。 */
  drop(text: string): boolean {
    return this.write(dropCopied(this.list, text));
  }

  /** 全部消す。 */
  clear(): boolean {
    this.storage.remove(KEY);
    this.list = [];
    return true;
  }

  private write(next: CopiedItem[]): boolean {
    try {
      this.storage.set(KEY, JSON.stringify(next));
      this.list = next;
      return true;
    } catch {
      // 🔴 **画面の物だけ先に進めない** ── 書けなかったのに一覧へ出すと、
      //    読み直した瞬間に消えて「さっき在ったのに」になる
      return false;
    }
  }
}

/** アプリ全体で 1 個。 */
export const appCopyHistory = new CopyHistoryStore();
