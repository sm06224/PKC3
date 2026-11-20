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
  /** 空き(bytes)を聞く口。`null` = 分からない(止めない)。区間の最初の断片の前と、書いた量が `freeRecheckBytes` 増えるごとに聞く。 */
  readonly freeBytes?: () => Promise<number | null>;
  readonly freeFloorBytes?: number;
  /** 空きを聞き直す間隔(書いた量)。既定 8MB。⚠ 長い収録の途中で空きが尽きても気づけるように。 */
  readonly freeRecheckBytes?: number;
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
  /** この収録の身元(`JournalMeta.id`)。控えから区間を読み戻すときの鍵。 */
  readonly id: string;
  /**
   * 🔴 **区間が欠けずに控えへ書けているか**(#1985 項目 1 の継ぎ目)。待ち行列が空になるのを待ってから答える。
   * `true` = 受け取った断片が全部書けた(控えだけから区間を作れる)。`false` = 上限・空き不足・失敗で 1 つでも書けていない / 断片が無い。
   * ⚠ `true` のときだけ、メモリ上の収録を手放して控えから取り込んでよい(`false` ならメモリに持ち続ける)。
   */
  segmentIntact(seg: number): Promise<boolean>;
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
  const recheck = opts.freeRecheckBytes ?? 8 * 1024 * 1024;
  /** 最後に空きを聞いてから書いた量。 */
  let sinceFreeCheck = 0;
  let state: JournalState = 'active';
  let tail: Promise<void> = Promise.resolve();
  let metaWritten = false;
  let ended = false;
  let closed = false;
  /** 書いた(または書く予定の)量。区間ごと。上限の判定は合計。 */
  const segBytes = new Map<number, number>();
  /** 見出しが書けなかった区間(後ろの断片を書かない)。 */
  const headless = new Set<number>();
  /** 1 つでも書けなかった断片が在る区間(控えだけからは作れない)。 */
  const lost = new Set<number>();
  /**
   * 🔴 **区間ごとの次に来るはずの断片の番号**(#1985 項目 1 の着地前レビュー)。
   * ⚠ 収録側で断片を渡す途中に例外が出ると、その断片は**ここへ届かない**(`lost` にも載らない)── 番号が飛んだら
   *   その区間は欠けていると数える。そうしないと、真ん中が抜けた控えを「全部書けた」と読んでメモリを手放す。
   */
  const nextIdx = new Map<number, number>();
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
      if (closed) return;
      if (idx !== (nextIdx.get(seg) ?? 0)) lost.add(seg);
      nextIdx.set(seg, idx + 1);
      if (state !== 'active') {
        lost.add(seg);
        return;
      }
      // 上限は受け取った時点で見る(書く順を待たずに止める)
      if (total() + blob.size > cap) {
        lost.add(seg);
        turnOff('off-cap');
        return;
      }
      segBytes.set(seg, (segBytes.get(seg) ?? 0) + blob.size);
      enqueue(async () => {
        // 待っている間に止まった / この区間の見出しが書けなかった
        if (broken || headless.has(seg)) {
          lost.add(seg);
          return;
        }
        try {
          if (opts.freeBytes !== undefined && (idx === 0 || sinceFreeCheck >= recheck)) {
            sinceFreeCheck = 0;
            const free = await opts.freeBytes();
            if (free !== null && free < floor) {
              // ⚠ 区間の途中で尽きたときも、これ以後は書かない(収録は続く。守られていないと言う)
              if (idx === 0) headless.add(seg);
              lost.add(seg);
              turnOff('off-space');
              return;
            }
          }
          sinceFreeCheck += blob.size;
          if (!metaWritten) {
            await port.putMeta(meta);
            metaWritten = true;
          }
          await port.putChunk({ rec: meta.id, seg, idx, elapsedMs, blob });
        } catch {
          // 🔴 書けなかった: 録るのは止めない。ここから先は守れないと言う
          if (idx === 0) headless.add(seg);
          lost.add(seg);
          turnOff('off-error');
        }
      });
    },
    segmentDone(seg) {
      if (closed) return;
      segBytes.delete(seg);
      headless.delete(seg);
      lost.delete(seg);
      nextIdx.delete(seg);
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
    id: meta.id,
    segmentIntact: async (seg) => {
      await tail;
      return !closed && segBytes.has(seg) && !lost.has(seg);
    },
    settled: () => tail,
  };
}
