/**
 * 🔴 **2 ペインファイラの憶えごと**(#273 残件)── 留めた場所と、下見を出すか。
 *
 * ⚠ **container に入れない** ── ノートのデータではなく、**この端末の使い方**である
 * (`pkc3.panes` / `pkc3.editor-mode` と同じ作法)。
 * ⚠ 読めない環境(プライベートモード等)でも落ちない ── 「留めが無い / 下見は出さない」
 *   側に落ちる(**出しっぱなしで復帰するほうが害が大きい** ── 下見は本文を読むので)。
 */
import {
  decodeBookmarks,
  encodeBookmarks,
  toggleBookmark,
} from '@features/relation/dual-bookmarks';

const KEY_MARKS = 'pkc3.dual-bookmarks';
const KEY_PREVIEW = 'pkc3.dual-preview';

function readStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

export class DualPrefsStore {
  /** 保存が読めない環境の控え(この session では効いている)。 */
  private marks: string[] = [];
  private preview = false;

  constructor(
    private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null = readStorage(),
  ) {}

  /** ⚠ 読むたびに保存を見る(書き手が複数 ── UI と smoke の仕込み)。 */
  getBookmarks(): string[] {
    try {
      const raw = this.storage?.getItem(KEY_MARKS) ?? null;
      return raw === null ? this.marks : decodeBookmarks(raw);
    } catch {
      return this.marks;
    }
  }

  setBookmarks(list: readonly string[]): string[] {
    const next = decodeBookmarks(encodeBookmarks(list));
    this.marks = next;
    try {
      this.storage?.setItem(KEY_MARKS, encodeBookmarks(next));
    } catch {
      // 保存できないだけ ── この session では効いている
    }
    return next;
  }

  /** 留める / 外す。⚠ **同じ口が二役**(押し口を 2 つ作らない)。 */
  toggleBookmark(lid: string): string[] {
    return this.setBookmarks(toggleBookmark(this.getBookmarks(), lid));
  }

  isPreviewOn(): boolean {
    try {
      const raw = this.storage?.getItem(KEY_PREVIEW) ?? null;
      return raw === null ? this.preview : raw === '1';
    } catch {
      return this.preview;
    }
  }

  setPreview(on: boolean): boolean {
    this.preview = on;
    try {
      this.storage?.setItem(KEY_PREVIEW, on ? '1' : '0');
    } catch {
      // 同上
    }
    return on;
  }
}

/** アプリ共有の 1 個。⚠ 読む側は必ずこれを引く(`appFlags` と同じ規律)。 */
export const appDualPrefs = new DualPrefsStore();
