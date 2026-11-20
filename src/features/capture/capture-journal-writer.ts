/**
 * 🔴 **途中保存の書き手**(#1985 項目 2)── 1 回の収録に 1 つ。判断は全部ここ(置き場は `JournalPort` の向こう)。
 *
 * - 書く順は**受け取った順**(1 本の待ち行列。区間の最初の断片 = WebM の見出しが書き終わるまで、次の断片を書き始めない)
 * - 最初の断片が書けなかった区間は、後ろの断片も書かない(見出しが無いと区間を再生できない)
 * - 書けない / 上限 / 空き不足のときは**録るのを止めず**、途中保存だけをやめて状態(`state()`)で言う
 * - 区間を添付にできたら `segmentDone` で、その区間の控えを消す(待ち行列の最後に並ぶ = 書きかけの断片の後で消える)
 * - 収録が終わり、区間が全部添付になったら、身元ごと消す
 *
 * ⚠ browser API を持たない(置き場・空きの問い合わせは外から渡す)。
 */
import {
  CAPTURE_JOURNAL_CAP_BYTES,
  CAPTURE_JOURNAL_FREE_FLOOR_BYTES,
  type JournalMeta,
  type JournalState,
} from './capture-journal';

/** 置き場の書く側の口。`@adapter/platform/capture-journal-store.ts` が実装する。 */
export interface JournalWritePort {
  putMeta(meta: JournalMeta): Promise<void>;
  putChunk(c: { rec: string; seg: number; idx: number; elapsedMs: number; blob: Blob }): Promise<void>;
  dropSegment(rec: string, seg: number): Promise<void>;
  dropRec(rec: string): Promise<void>;
}

export interface JournalWriterOptions {
  readonly capBytes?: number;
  /** 空き(bytes)を聞く口。`null` = 分からない(止めない)。区間の最初の断片の前にだけ聞く。 */
  readonly freeBytes?: () => Promise<number | null>;
  readonly freeFloorBytes?: number;
  /** 状態が変わったとき(`active` から外れたとき)。 */
  readonly onState?: (state: JournalState) => void;
  /** 収録が済んで控えが空になった / 捨てた(別のタブへ「録っている最中」を言う印を外す)。 */
  readonly onClosed?: () => void;
}

export interface JournalWriter {
  /** 断片を 1 つ足す(書くのは待ち行列の後ろ)。⚠ 呼び側は待たない。 */
  chunk(seg: number, idx: number, elapsedMs: number, blob: Blob): void;
  /** 区間を添付にできた。その区間の控えを消す。 */
  segmentDone(seg: number): void;
  /** 収録が終わった(止めた / 自動で止まった)。 */
  end(): void;
  /** 捨てた。控えを全部消す。 */
  discard(): void;
  state(): JournalState;
  /** 待ち行列が空になるまで(test と、閉じる前の待ち合わせ用)。 */
  settled(): Promise<void>;
}

export function createJournalWriter(
  port: JournalWritePort,
  meta: JournalMeta,
  opts: JournalWriterOptions = {},
): JournalWriter {
  const cap = opts.capBytes ?? CAPTURE_JOURNAL_CAP_BYTES;
  const floor = opts.freeFloorBytes ?? CAPTURE_JOURNAL_FREE_FLOOR_BYTES;
  let state: JournalState = 'active';
  let tail: Promise<void> = Promise.resolve();
  let metaWritten = false;
  let ended = false;
  let closed = false;
  /** 書いた(または書く予定の)量。区間ごと。上限の判定は合計。 */
  const segBytes = new Map<number, number>();
  /** 見出しが書けなかった区間(後ろの断片を書かない)。 */
  const headless = new Set<number>();
  const total = (): number => {
    let n = 0;
    for (const v of segBytes.values()) n += v;
    return n;
  };
  /** 書けなくなった(失敗 / 空き不足)。⚠ 上限(`off-cap`)は含めない ── 上限は**新しい断片を受けない**だけで、受けた分は書き切る。 */
  let broken = false;
  const turnOff = (why: Exclude<JournalState, 'active'>): void => {
    if (state !== 'active') return;
    state = why;
    if (why !== 'off-cap') broken = true;
    opts.onState?.(why);
  };
  const enqueue = (run: () => Promise<void>): void => {
    // ⚠ 失敗は run の中で受ける。ここで握りつぶすのは「待ち行列を止めない」ためだけ
    tail = tail.then(run, run);
  };
  const maybeClose = (): void => {
    if (closed || !ended || segBytes.size > 0) return;
    closed = true;
    enqueue(async () => {
      try {
        await port.dropRec(meta.id);
      } catch {
        // 消せなかった控えは、次の起動の掃除(`emptyRecs`)が拾う
      }
      opts.onClosed?.();
    });
  };

  return {
    chunk(seg, idx, elapsedMs, blob) {
      if (closed || state !== 'active') return;
      // 上限は受け取った時点で見る(書く順を待たずに止める)
      if (total() + blob.size > cap) {
        turnOff('off-cap');
        return;
      }
      segBytes.set(seg, (segBytes.get(seg) ?? 0) + blob.size);
      enqueue(async () => {
        // 待っている間に止まった / この区間の見出しが書けなかった
        if (broken || headless.has(seg)) return;
        try {
          if (idx === 0 && opts.freeBytes !== undefined) {
            const free = await opts.freeBytes();
            if (free !== null && free < floor) {
              headless.add(seg);
              turnOff('off-space');
              return;
            }
          }
          if (!metaWritten) {
            await port.putMeta(meta);
            metaWritten = true;
          }
          await port.putChunk({ rec: meta.id, seg, idx, elapsedMs, blob });
        } catch {
          // 🔴 書けなかった: 録るのは止めない。ここから先は守れないと言う
          if (idx === 0) headless.add(seg);
          turnOff('off-error');
        }
      });
    },
    segmentDone(seg) {
      if (closed) return;
      segBytes.delete(seg);
      headless.delete(seg);
      enqueue(async () => {
        try {
          await port.dropSegment(meta.id, seg);
        } catch {
          // 消せなかった控えは、次の起動で「復元できます」に出る(捨てるを選べる)
        }
      });
      maybeClose();
    },
    end() {
      ended = true;
      maybeClose();
    },
    discard() {
      if (closed) return;
      closed = true;
      ended = true;
      segBytes.clear();
      enqueue(async () => {
        try {
          await port.dropRec(meta.id);
        } catch {
          // 同上
        }
        opts.onClosed?.();
      });
    },
    state: () => state,
    settled: () => tail,
  };
}
