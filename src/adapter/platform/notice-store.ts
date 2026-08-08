/**
 * お知らせの既読(P11 段⑤)。
 *
 * 🔴 **見た id の「集合」で持つ**(user 裁定 2026-08-07 Q6 = localStorage)。
 *
 * ⚠ PKC2 は「**最後に閉じた id との厳密等価**」で判定していた。単一 HTML 製品では
 * user が旧ビルドを手元に残すので、旧へ戻ると古いお知らせが再表示され、閉じると
 * 既読が**古い id へ巻き戻る**。新へ戻るとまた出る ── 往復するたびに書き換わる。
 * 集合なら巻き戻らない。
 *
 * ⚠ **アプリのデータに混ぜない**(`theme.ts` / `flag-store.ts` と同じ判断)──
 * container に入れると export に同乗し、**書き出した HTML を渡した相手に
 * お知らせが出なくなる**(PKC2 が実際にその形になっている)。
 */
import { NOTICE_KEEP_MAX } from '@features/notice/notice-log';

const SEEN_KEY = 'pkc3.notices.seen';
const OFF_KEY = 'pkc3.notices.off';

/** 保存の口。⚠ test は偽物を渡して**書込回数**まで観測する。 */
export interface NoticeStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

const browserStorage: NoticeStorage = {
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
      /* 保存できないだけ。この session では効いている */
    }
  },
  remove: (k) => {
    try {
      localStorage.removeItem(k);
    } catch {
      /* 同上 */
    }
  },
};

/**
 * 既読の集合と、恒久オフの切替を持つ。
 * ⚠ **アプリ全体で 1 個**にする(`appNoticeStore`)── 2 個作ると、設定画面で
 *   切り替えても帯側が古い値のままになる。
 */
export class NoticeStore {
  private seen: string[];
  private off: boolean;

  constructor(private readonly storage: NoticeStorage = browserStorage) {
    this.seen = this.readSeen();
    this.off = this.storage.get(OFF_KEY) === '1';
  }

  private readSeen(): string[] {
    try {
      const raw = this.storage.get(SEEN_KEY);
      if (raw === null) return [];
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      return []; // 壊れていても落ちない ── 全部未読に戻るだけ
    }
  }

  seenIds(): readonly string[] {
    return this.seen;
  }

  /** お知らせを出してよいか(恒久オフでない)。 */
  enabled(): boolean {
    return !this.off;
  }

  /**
   * 恒久オフを切り替える。⚠ **戻せること**が要件(user が自分で復帰できる)。
   */
  setEnabled(on: boolean): void {
    this.off = !on;
    if (this.off) this.storage.set(OFF_KEY, '1');
    else this.storage.remove(OFF_KEY);
  }

  /**
   * 見たものとして記録する。
   * ⚠ **内容が変わらないなら書かない**(無用な書込をしない)。
   * ⚠ 上限を超えたら **id の降順(= 新しい順)で残す** ── 投入順ではない。
   *   古い id を落とすのが目的なので、並べ替えの鍵は id である。
   */
  markSeen(ids: readonly string[]): void {
    const merged = [...new Set([...this.seen, ...ids])]
      .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
      .slice(0, NOTICE_KEEP_MAX);
    const same =
      merged.length === this.seen.length && merged.every((v, i) => v === this.seen[i]);
    if (same) return;
    this.seen = merged;
    this.storage.set(SEEN_KEY, JSON.stringify(merged));
  }
}

/** 🔴 **アプリ共有の 1 個**(2 個作ると面ごとに値が食い違う)。 */
export const appNoticeStore = new NoticeStore();
