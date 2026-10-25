/**
 * 🔴 **可搬単一 HTML の保存の配線**(#1589 の根治)── 画像の保存(`portable-persist`)と日誌(`portable-journal`)を繋ぐ。
 *
 * `main.ts` はどの test からも実行されない(原文を読む test しか無い)ので、**繋ぎ方そのもの**(番号を控える順・
 * 捨てる条件・再生した後の畳み直し)をここに取り出して test で pin する。
 *
 * ## 🔑 繋ぎの約束
 * 1. 画像を書き出す**直前**に `snapshotSeq` を控え、器へ**書けた後**に、その番号以下を捨てる(`trim`)。
 *    ⚠ 書けなかったら捨てない(日誌が最後の砦)。⚠ 番号を渡さずに書くと、次の起動が旧い記録の扱い(時刻)になる。
 * 2. 日誌に頼れなくなったら(足せない / 大きすぎる)**画像の保存を即時に流す**。
 * 3. 再生した分は画像へ**畳み直す**(`touch`)── 畳まないと次の起動でまた流し直す。失敗が混ざっても同じ:
 *    失敗した op は `failed` 置き場へ残し(捨てない)、画像の保存で日誌を区切る = **同じ失敗を毎回やり直さない**。
 */
import { createJournal, type JournalBackend, type PortableJournal, type ReplayResult } from './portable-journal';
import { connectPortablePersist, type PersistState, type PortablePersist } from './portable-persist';

export interface PortableWiringDeps {
  backend: JournalBackend;
  exportImage: () => Promise<Uint8Array>;
  writeImage: (rec: { savedAt: number; image: Uint8Array; snapshotSeq: number }) => Promise<void>;
  /** 起動で日誌を流し直した結果(流し直さなかった回は `null`)。 */
  replayed: ReplayResult | null;
  /** 番号の下限(画像の番号と日誌の最大の番号)。 */
  seqFloor: number;
  onState: (s: PersistState) => void;
  onUnsaved: (unsaved: boolean) => void;
  /** 日誌に頼れなくなった(診断用)。 */
  onJournalError?: (why: string) => void;
  /** 再生に失敗した op があった(user に見せる文)。 */
  onReplayProblem?: (text: string) => void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
}

export interface PortableWiring {
  journal: PortableJournal;
  persist: PortablePersist;
}

/** 再生に失敗した op を名指しした文(op の種類と件数)。 */
export function replayProblemText(r: ReplayResult): string {
  const ops = new Map<string, number>();
  for (const e of r.failedEntries) {
    const op = typeof (e.req as { op?: unknown } | null)?.op === 'string' ? (e.req as { op: string }).op : '不明';
    ops.set(op, (ops.get(op) ?? 0) + 1);
  }
  const list = [...ops].map(([op, n]) => `${op} ${n} 件`).join('、');
  return `直前の変更の控えのうち ${r.failed} 件(${list})を元に戻せませんでした(${r.firstError ?? '理由不明'})。控えは残してあります`;
}

export function connectPortableWiring(deps: PortableWiringDeps): PortableWiring {
  let persist: PortablePersist | null = null;
  const journal = createJournal({
    backend: deps.backend,
    initialSeq: deps.seqFloor,
    ...(deps.now ? { now: deps.now } : {}),
    onError: (why) => {
      deps.onJournalError?.(why);
      // 🔴 日誌に頼れない変更が在る ── 画像の保存を待たずに流す(touch で未保存にしてから)
      persist?.touch();
      void persist?.flush().catch(() => undefined);
    },
    onIdle: () => persist?.recheck(),
  });
  let snapshot = 0;
  persist = connectPortablePersist({
    exportImage: async () => {
      snapshot = journal.snapshotSeq();
      return deps.exportImage();
    },
    write: async ({ savedAt, image }) => {
      const upTo = snapshot;
      await deps.writeImage({ savedAt, image, snapshotSeq: upTo });
      journal.trim(upTo);
    },
    onState: deps.onState,
    onUnsaved: deps.onUnsaved,
    busy: () => journal.pending() > 0,
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.setTimer ? { setTimer: deps.setTimer } : {}),
    ...(deps.clearTimer ? { clearTimer: deps.clearTimer } : {}),
  });
  const r = deps.replayed;
  if (r !== null && r.applied + r.failed > 0) {
    if (r.failed > 0) {
      void deps.backend.keepFailed(r.failedEntries).catch(() => undefined);
      deps.onReplayProblem?.(replayProblemText(r));
    }
    // 🔑 畳み直す(次の画像の保存が日誌を区切る)。⚠ 全部失敗した回も触る ── 触らないと毎回の起動で同じ失敗を繰り返す
    persist.touch();
  }
  return { journal, persist };
}
