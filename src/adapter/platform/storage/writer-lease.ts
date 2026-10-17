/**
 * 多重タブの writer リース(設計 doc §4.5、review #1a の恒久対策)。
 *
 * SAHPool は実質単一接続なので、storage worker を init してよいのは
 * **リースを held しているタブだけ**。取れないタブは待機(read-only 表示)し、
 * 保持タブが閉じる(lock 自動解放)と昇格する。BroadcastChannel での
 * 読取追従は P3 の app 層接続で足す。
 */
export type LeaseState = 'held' | 'waiting' | 'released';

export interface WriterLease {
  state(): LeaseState;
  /** リースを held した時点で resolve(既に held なら即)。 */
  whenHeld: Promise<void>;
  /** 「今すぐ取れたか」。false = 別タブが保持中で待機に入った。 */
  immediate: Promise<boolean>;
  release(): void;
}

export const WRITER_LOCK_NAME = 'pkc3-writer';

/**
 * 昇格(follower → holder)を走らせ、**失敗したら握った lease を手放す**(#1087)。
 *
 * 🔴 lease を取った時点で lock は握られているが、昇格(新しい storage worker の起動)が
 *   失敗する場面がある(別のタブが先に更新して、古い worker の chunk が 404 になる等)。
 *   そのまま放っておくと、動かないタブが lock を握り続け、**読み込み直したタブが
 *   書き手になれない**。失敗したら返して、待っている他のタブに回す。
 */
export async function promoteOrReleaseLease<T>(
  lease: Pick<WriterLease, 'release'>,
  promote: () => Promise<T>,
): Promise<T> {
  try {
    return await promote();
  } catch (e) {
    lease.release();
    throw e;
  }
}

/**
 * 🔴 **昇格で開いた保存先が、空のメモリへ落ちていたら失敗にする**(多重タブ T2)。
 *
 * ⚠ OPFS が開けないと `memory`(空)に落ちるが、昇格のタブはそのまま書き手を名乗り、**空のノートを
 *   見せたまま保存先が無い**。注意の通知も `memory` では出ない。
 * 🔑 失敗にすれば `promoteOrReleaseLease` が lock を手放し、**別のタブが書き手になれる**。
 * ⚠ 持ち歩ける 1 枚の HTML(`portable`)は**選んで** `memory` なので対象外。起動の経路は変えない。
 */
export function isPromotionMemoryFallback(args: { portable: boolean; vfs: string }): boolean {
  return !args.portable && args.vfs === 'memory';
}

export function acquireWriterLease(name: string = WRITER_LOCK_NAME): WriterLease {
  let state: LeaseState = 'waiting';
  let releaseFn: (() => void) | null = null;
  let resolveHeld!: () => void;
  const whenHeld = new Promise<void>((r) => (resolveHeld = r));

  const locks: LockManager | undefined = navigator.locks;
  if (!locks) {
    // Web Locks 非対応(旧ブラウザ): 単一タブ前提で held 扱い
    state = 'held';
    resolveHeld();
    return {
      state: () => state,
      whenHeld,
      immediate: Promise.resolve(true),
      release: () => {
        state = 'released';
      },
    };
  }

  const hold = (): Promise<void> =>
    new Promise<void>((r) => {
      releaseFn = r;
    });

  const immediate = new Promise<boolean>((resolveImmediate) => {
    void locks
      .request(name, { ifAvailable: true }, (lock) => {
        if (lock === null) {
          resolveImmediate(false); // 別タブ保持中 → 下の待ち request へ
          return;
        }
        resolveImmediate(true);
        state = 'held';
        resolveHeld();
        return hold(); // release() まで lock を保持
      })
      .then(() => {
        if (state !== 'waiting') return; // held→released 済み or 取得済み
        // 待機: 保持タブの解放(close 含む)で grant される
        return locks.request(name, () => {
          if (state === 'released') return; // 待機中に release() された
          state = 'held';
          resolveHeld();
          return hold();
        });
      });
  });

  return {
    state: () => state,
    whenHeld,
    immediate,
    release: () => {
      state = 'released';
      releaseFn?.();
      releaseFn = null;
    },
  };
}
