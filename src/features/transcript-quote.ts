/**
 * 🔴 **文字起こしの行を、時刻つきの引用としてノートへ入れる**(#1966 4-3 ①。user 裁定 2026-11-17 = 案 B)。
 *
 * 録音(添付)ノートの文字起こし・チャプターの行(`0:15 字`)の「ノートへ引用」を押すと、入れ先のノートの
 * 末尾に次の 1 行が入る:
 *
 * ```
 * > [0:15](entry:<録音>#t=15) 字の内容
 * ```
 *
 * リンクを押すと、その時刻から録音が鳴る(`entry:<lid>#t=<秒>` ── `entry-ref.ts`)。
 *
 * ## 入れ先(上から順に、最初に当たった物)
 *
 * 1. **横に留めた枠**(`splitLids`)のノート ── 議事録を横に並べて聞きながら書く形
 * 2. 録音に**結びついたノート**(関係。PDF の「ノートへ引用」と同じ選び方 ── `resolveQuoteTarget`)
 * 3. **直前に開いていたノート**(選んだ履歴。「戻る」で離れたばかりのノートを先に見る)── 議事録から録音を開いて聞いた形
 * 4. どれも無ければ**録音のノート自身**(説明の末尾)
 *
 * ⚠ 追記できる種類(ノート・ログ)だけを入れ先にする(フォルダ・別の添付へは足せない)。
 * 🔑 pure module。書くのは adapter(既存の追記 `appendUnlessEditedElsewhere` ── 「元に戻す」付き)。
 */
import type { EntryMeta, Relation } from '@core/model/entry-meta';
import { isAppendable } from '@features/flavor/append-spec';
import { escapeInline } from '@features/markdown/html-to-markdown';
import { resolveQuoteTarget } from '@features/pdf/pdf-quote';
import { formatEntryRef } from '@features/entry-ref/entry-ref';

/**
 * 引用の 1 行を作る。
 *
 * @param label 行頭の時刻の綴り(画面に出ている字そのまま。`0:15` / `1:02:03`)
 * @param text 時刻の後ろの字(描いた後の字 ── 記法の字は残っていない)
 * @returns 字が無ければ `null`(時刻だけの引用は作らない)
 */
export function formatTranscriptQuote(recordingLid: string, startMs: number, label: string, text: string): string | null {
  // ⚠ 改行・制御文字は 1 行へ畳む(引用は 1 行)
  // eslint-disable-next-line no-control-regex
  const body = text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (body === '' || !Number.isFinite(startMs) || startMs < 0) return null;
  const ref = formatEntryRef({ kind: 'time', lid: recordingLid, ms: Math.floor(startMs / 1000) * 1000 });
  // 🔴 字は記法として読まれない形にする(`*` `[` などが強調・リンクにならない ── PDF の引用と同じ 1 本)
  return `> [${escapeInline(label)}](${ref}) ${escapeInline(body)}`;
}

export interface TranscriptQuoteTargetInput {
  readonly recordingLid: string;
  /** 横に留めた枠(先頭が一番上)。 */
  readonly splitLids: readonly string[];
  /** 選んだ履歴(古い順。末尾が「いま」)。 */
  readonly past: readonly string[];
  /**
   * 「戻る」で離れたノート(先頭が直前に離れた物)。⚠ 議事録から「戻る」で録音へ戻ってきた形では、
   *   直前に開いていたノート(議事録)は `past` ではなくここの先頭に居る。省略 = 無い。
   */
  readonly future?: readonly string[];
  readonly metas: ReadonlyMap<string, EntryMeta>;
  readonly relations: readonly Relation[];
}

/** 入れ先のノート(説明は file の頭)。 */
export function resolveTranscriptQuoteTarget(input: TranscriptQuoteTargetInput): string {
  const { recordingLid, metas } = input;
  const ok = (lid: string | undefined): lid is string => {
    if (lid === undefined || lid === recordingLid) return false;
    const m = metas.get(lid);
    return m !== undefined && !m.archived && isAppendable(m.archetype);
  };
  const pinned = input.splitLids.find(ok);
  if (pinned !== undefined) return pinned;
  const related = resolveQuoteTarget(recordingLid, metas, input.relations);
  if (related !== recordingLid) return related;
  // 🔑 「戻る」で離れたばかりのノートは `future` の先頭(新しく選んだときは `future` は空)
  const left = input.future?.[0];
  if (ok(left)) return left;
  for (let i = input.past.length - 1; i >= 0; i -= 1) {
    const lid = input.past[i];
    if (ok(lid)) return lid;
  }
  return recordingLid;
}
