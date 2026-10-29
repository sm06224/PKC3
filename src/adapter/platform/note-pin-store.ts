/**
 * ノートのピン留めの置き場(#1377)。**端末ごと**(localStorage)。
 *
 * 🔴 **アプリのデータに混ぜない**(`saved-search-store.ts` と同じ判断)── 並べ方は見る人の道具で、
 * container に入れると書き出し・バックアップに同乗して、渡した相手に「いつも見ているノート」が並ぶ。
 * 設定ファイルにも載せない(中身が ID そのもの ── `settings-file.ts` の `SKIPPED_KEYS`)。
 *
 * 🔴 **保存できない端末でも、その session の中では効く**。⚠ `?.` で書くと `null` は例外を投げず
 * `catch` の控えが死んだ枝になる ── だから `storage === null` を**先に**見る(CLAUDE.md §7)。
 * 🔑 一覧は**メモリに持つ**(状態が動くたびに描く帯が、毎回 JSON を読まないため)。別のタブが書いたときは
 * `refresh()`(`storage` イベント)で読み直す。
 */
import { decodeNotePins, encodeNotePins, togglePin } from '@features/relation/note-pins';

export const NOTE_PINS_KEY = 'pkc3.note-pins';

/** 保存の口。⚠ test は偽物を渡して書込の中身まで観測する。 */
export interface NotePinStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

const browserStorage: NotePinStorage | null = ((): NotePinStorage | null => {
  try {
    localStorage.getItem(NOTE_PINS_KEY);
  } catch {
    return null;
  }
  return {
    get: (k) => {
      try {
        return localStorage.getItem(k);
      } catch {
        return null;
      }
    },
    set: (k, v) => {
      try {
        localStorage.setItem(k, v);
      } catch {
        /* 溢れただけ。控え(メモリ)には積んである */
      }
    },
  };
})();

export class NotePinStore {
  private items: string[] = [];
  private readonly listeners = new Set<() => void>();

  constructor(private readonly storage: NotePinStorage | null = browserStorage) {
    this.refresh(false);
  }

  /** ピン留めした順(他のコレクションの分・消えたノートの分を含む)。 */
  list(): readonly string[] {
    return this.items;
  }

  has(key: string): boolean {
    return this.items.includes(key);
  }

  /** 保存を読み直す(別のタブが書いたとき)。変わったときだけ知らせる。 */
  refresh(notify = true): void {
    if (this.storage === null) return;
    const next = decodeNotePins(this.storage.get(NOTE_PINS_KEY));
    if (JSON.stringify(next) === JSON.stringify(this.items)) return;
    this.items = next;
    if (notify) this.emit();
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => void this.listeners.delete(cb);
  }

  /** ピン留めする / 外す(`liveCount` = このコレクションで生きているピンの数。満杯なら足さない)。 */
  toggle(key: string, liveCount: number): void {
    const next = togglePin(this.items, key, liveCount);
    if (JSON.stringify(next) === JSON.stringify(this.items)) return;
    this.items = next;
    if (this.storage !== null) {
      try {
        this.storage.set(NOTE_PINS_KEY, encodeNotePins(next));
      } catch {
        /* 書けなかっただけ。控え(メモリ)には積んである */
      }
    }
    this.emit();
  }

  private emit(): void {
    for (const cb of [...this.listeners]) cb();
  }
}

/** アプリ全体で 1 個。 */
export const appNotePins = new NotePinStore();

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('storage', (e) => {
    if (e.key === NOTE_PINS_KEY || e.key === null) appNotePins.refresh();
  });
}
