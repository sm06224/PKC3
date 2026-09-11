/**
 * 最近開いたノートの置き場(#215 残り①)。**端末ごと**(localStorage)。
 *
 * 🔴 **アプリのデータに混ぜない** ── `theme.ts` / `flag-store.ts` /
 * `notice-store.ts` / `copy-history-store.ts` と**同じ判断**。container に入れると
 * 書き出しに同乗し、**HTML を渡した相手に、こちらが何を読んでいたかが並ぶ**。
 *
 * 🔴 **保存できない端末でも、その session の中では効く**(#278 段② の教訓)。
 * ⚠ `?.` で書くと **`null` は例外を投げない**ので `catch` の控えが**死んだ枝**になる
 * ── だから `storage === null` を**先に**見る(CLAUDE.md §7)。
 *
 * ⚠ **溢れても黙って捨てる。** ここはコピーの履歴と違い、書けなかったことを
 * user へ言う必要が無い(開いた記録は user が作った物ではない)── ⚠ ただし
 * **その session の控えには積む**ので、並べ替えは効いたまま閉じるまで続く。
 */
import { openedMap, OPENED_MAX, pruneOpened, pushOpened, type OpenedAt } from '@features/history/opened-log';

const KEY = 'pkc3.opened';

/** 保存の口。⚠ test は偽物を渡して**書込の中身**まで観測する。 */
export interface OpenedStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

const browserStorage: OpenedStorage | null = ((): OpenedStorage | null => {
  try {
    // ⚠ 触れるかどうかまで見る(存在するのに投げる端末が在る)
    localStorage.getItem(KEY);
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
        /* 溢れただけ。控えには積んである */
      }
    },
    remove: (k) => {
      try {
        localStorage.removeItem(k);
      } catch {
        /* 消せないだけ */
      }
    },
  };
})();

/** 読めた形かを検める。⚠ 壊れた JSON で画面ごと落とさない。 */
function parse(raw: string | null): OpenedAt[] {
  if (raw === null || raw === '') return [];
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(v)) return [];
  const out: OpenedAt[] = [];
  for (const c of v) {
    if (typeof c !== 'object' || c === null) continue;
    const o = c as Record<string, unknown>;
    if (typeof o['lid'] !== 'string' || o['lid'] === '') continue;
    out.push({ lid: o['lid'], at: typeof o['at'] === 'number' ? o['at'] : 0 });
  }
  return out.slice(0, OPENED_MAX);
}

/**
 * 端末の「最近開いた」を持つ。
 * ⚠ **アプリ全体で 1 個**にする(`appOpenedStore`)── 2 個作ると、片方が古い一覧を
 *   書き戻して**記録が巻き戻る**。
 */
export class OpenedStore {
  /** 🔴 保存が無い端末の控え ── この session の中だけ効く。 */
  private fallback: OpenedAt[] = [];

  constructor(private readonly storage: OpenedStorage | null = browserStorage) {
    if (storage !== null) this.fallback = parse(storage.get(KEY));
  }

  list(): readonly OpenedAt[] {
    // ⚠ **`?.` で書かない**(上の戒め)── `null` のときは控えを返す
    if (this.storage === null) return this.fallback;
    return parse(this.storage.get(KEY));
  }

  /** lid → 開いた時刻。並べ替えが引く形。 */
  map(): Map<string, number> {
    return openedMap(this.list());
  }

  /** 開いたことを憶える。**新しい順**の一覧を返す(呼び側が state へ載せる)。 */
  push(lid: string, at: number): readonly OpenedAt[] {
    const next = pushOpened(this.list(), lid, at);
    this.write(next);
    return next;
  }

  /** 消えたノートの行を落とす。⚠ 減らなければ**書かない**(毎回の書込を作らない)。 */
  prune(alive: (lid: string) => boolean): readonly OpenedAt[] {
    const now = this.list();
    const next = pruneOpened(now, alive);
    if (next.length !== now.length) this.write(next);
    return next;
  }

  /** 🔴 user が消す口(「最近開いた記録を消す」)。 */
  clear(): void {
    this.fallback = [];
    if (this.storage !== null) this.storage.remove(KEY);
  }

  private write(next: readonly OpenedAt[]): void {
    this.fallback = [...next];
    if (this.storage !== null) this.storage.set(KEY, JSON.stringify(next));
  }
}

/** アプリ全体で 1 個(上の注記)。 */
export const appOpenedStore = new OpenedStore();
