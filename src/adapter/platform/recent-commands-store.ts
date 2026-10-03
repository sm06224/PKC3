/**
 * 最近使った操作(左の列の `>` の一覧から実行した物)の置き場(#274)。**端末ごと**(localStorage)。
 *
 * 🔴 **アプリのデータに混ぜない** ── `search-history-store.ts` と**同じ判断**。container に
 * 入れると書き出し / バックアップに同乗し、渡した相手に**何を使っていたか**が並ぶ。
 * ⚠ 設定でもない(最後の操作の記録)ので、設定の持ち出しにも乗せない
 *   (`settings-file.ts` の `SKIPPED_KEYS` に理由つきで載せてある)。
 *
 * 🔴 **保存できない端末でも、落ちない。その session の中では効く**(#278 段②の教訓)。
 * ⚠ `?.` で書くと **`null` は例外を投げない**ので `catch` の控えが**死んだ枝**になる
 *   ── だから `storage === null` を**先に**見る(CLAUDE.md §7)。
 * ⚠ **溢れても黙って捨てる**(ただし控えには積む)。⚠ **読むたびに保存を引く**
 *   (別のタブで使った操作も、次に `>` を打ったとき出る)。
 */
import { pushRecentCommand, RECENT_COMMANDS_KEEP } from '@features/palette/recent-commands';

const KEY = 'pkc3.recent-commands';

/** 保存の口。⚠ test は偽物を渡して**書込の中身**まで観測する。 */
export interface RecentCommandsStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

const browserStorage: RecentCommandsStorage | null = ((): RecentCommandsStorage | null => {
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
function parse(raw: string | null): string[] {
  if (raw === null || raw === '') return [];
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const t of v) {
    if (typeof t === 'string' && t !== '' && !out.includes(t)) out.push(t);
  }
  return out.slice(0, RECENT_COMMANDS_KEEP);
}

/**
 * ⚠ **アプリ全体で 1 個**にする(`appRecentCommands`)── 2 個作ると、片方が古い一覧を
 *   書き戻して**記録が巻き戻る**。
 */
export class RecentCommandsStore {
  /** 🔴 保存が無い端末の控え ── この session の中だけ効く。 */
  private fallback: string[] = [];

  constructor(private readonly storage: RecentCommandsStorage | null = browserStorage) {
    if (storage !== null) this.fallback = parse(storage.get(KEY));
  }

  /** 新しい順。 */
  list(): readonly string[] {
    // ⚠ **`?.` で書かない**(上の戒め)── `null` のときは控えを返す
    if (this.storage === null) return this.fallback;
    const stored = parse(this.storage.get(KEY));
    // 🔴 **保存は在るが書込だけ失敗する端末**(`setItem` が投げる = 容量・私用ウィンドウ)── 保存は
    //   空のままなので、控えが非空ならそちらを返す。⚠ 返さないと、積んだ物が**1 度も出ない**。
    //   ⚠ 保存に 1 件でも在れば保存を正とする(別のタブが積んだ物を拾う ── 上の「読むたびに保存を引く」)。
    return stored.length === 0 && this.fallback.length > 0 ? this.fallback : stored;
  }

  /** 実行した操作の id を憶える。**新しい順**の一覧を返す。⚠ 変わらないとき(先頭と同じ)は書かない。 */
  push(id: string): readonly string[] {
    const now = this.list();
    const next = pushRecentCommand(now, id);
    if (next.length === now.length && next.every((t, i) => t === now[i])) return now;
    this.fallback = [...next];
    if (this.storage !== null) this.storage.set(KEY, JSON.stringify(next));
    return next;
  }

  /** 全部消す(test と、将来「記録を消す」口が要るとき用)。 */
  clear(): void {
    this.fallback = [];
    if (this.storage !== null) this.storage.remove(KEY);
  }
}

/** アプリ全体で 1 個(上の注記)。 */
export const appRecentCommands = new RecentCommandsStore();
