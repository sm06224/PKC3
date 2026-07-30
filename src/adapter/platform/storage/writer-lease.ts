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
