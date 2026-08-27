/**
 * 探し方(左の列のタブ)の既定と記憶(#240 段⑤。user 指示 2026-08-17
 * 「そもそも左ペインの一覧表示はあまり意味がない。フォルダ表示メインに」)。
 *
 * 🔴 **既定はフォルダ**。⚠ ただし**一覧タブは残す** ── user 指摘は「あまり意味がない」
 * であって「消せ」ではなく、消すと**全件を一望する面**と #183 の並べ替えを見る場所が
 * 無くなる(記法と同じで、動線を減らす向きの整理はしない)。
 *
 * ⚠ 1 鍵だけ(`pkc3.theme` / `pkc3.panes` と同じ作法)。**container に入れない** ──
 * 「どう探すか」は画面側の都合であって、ノートのデータではない。
 * ⚠ 既定を**ここ 1 か所**に置く(直す前は `main.ts` に 2 か所、`browse.ts` に 2 か所
 * 散っており、変えるときに必ず取りこぼす形だった)。
 */
/**
 * 🔴 **探し方の全数はこの 1 本**(2026-08-27、#278 段①)。
 *
 * ⚠ 直す前は**型と判定が別々に書かれて**おり、判定のほうは
 *   `v === 'list' || … || v === 'schedule'` という手書きの連なりだった。
 *   ⚠ file 自身が「**探し方を足したらここも足す**」と注意していたのに、
 *   連絡先を足したとき**実際に足し忘れた** ── そして
 *   🔴 **黙って壊れる**:タブは出る・押せる・器も在るのに、
 *   `isBrowseMode` が弾くので**面が切り替わらない**(押しても何も起きない)。
 * 🔑 だから**一覧から型も判定も導く** ── 足し忘れようがない形にする(§7)。
 */
export const BROWSE_MODES = ['list', 'filer', 'launcher', 'schedule', 'contacts'] as const;

export type BrowseMode = (typeof BROWSE_MODES)[number];

/** 🔴 既定 = フォルダ(#240 段⑤)。 */
export const DEFAULT_BROWSE_MODE: BrowseMode = 'filer';

export function isBrowseMode(v: string): v is BrowseMode {
  return (BROWSE_MODES as readonly string[]).includes(v);
}

const KEY = 'pkc3.browse';

function readStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

export class BrowseModeStore {
  private fallback: BrowseMode = DEFAULT_BROWSE_MODE;

  constructor(
    private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null = readStorage(),
  ) {}

  /** ⚠ 読めない値・知らない値は既定へ落ちる(壊れた保存で面が出ないほうが害が大きい)。 */
  get(): BrowseMode {
    try {
      const v = this.storage?.getItem(KEY);
      return v !== null && v !== undefined && isBrowseMode(v) ? v : DEFAULT_BROWSE_MODE;
    } catch {
      return this.fallback;
    }
  }

  set(mode: BrowseMode): void {
    this.fallback = mode;
    try {
      this.storage?.setItem(KEY, mode);
    } catch {
      // 保存できないだけ ── この session では効いている
    }
  }
}

/** アプリ共有の 1 個。⚠ 読む側は必ずこれを引く。 */
export const appBrowseMode = new BrowseModeStore();
