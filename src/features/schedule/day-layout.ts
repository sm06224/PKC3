/**
 * 🔴 **予定の「日」の見せ方 ── 時間の目盛りに置く計算**(#855 段 A-1)。
 *
 * 予定の面の「日」は、1 日を 0:00〜24:00 の目盛りに並べる。この file は**その置き場所の計算だけ**を持つ
 * (pure ── DOM も時計も読まない)。束ね方・繰り返し・期間の展開は `agenda.ts` の仕事で、
 * ここは**束が出した 1 日ぶんを、目盛りのどこに置くか**だけを決める。
 *
 * ## 規則
 *
 * | 場合 | 置き場所 |
 * |---|---|
 * | 時刻なし / 期間(`until`) / ノート 1 件の予定 / 時刻が読めない | **終日**(目盛りに置かない) |
 * | `14:00..15:00` | 14:00 から 15:00 まで |
 * | `14:00`(幅なし) | 14:00 から **30 分** |
 * | 幅が 0 や逆(`14:00..14:00`) | 幅なしと同じ(30 分) |
 * | 24:00 を越える | **24:00 で切る** |
 *
 * ⚠ **重なりの判定は画面に描く長さで行う**(30 分未満の予定は 30 分ぶんの高さで描くので、その長さで)。
 *   `14:00..15:00` と `15:00..16:00` は接しているだけなので重ならない(同じ列に並ぶ)。
 */
import type { AgendaItem } from './agenda';

/** 1 日の分。 */
export const DAY_MINUTES = 24 * 60;

/** 幅のない予定を目盛りに置くときの長さ(分)。 */
export const DEFAULT_SPAN_MINUTES = 30;

/**
 * 🔴 **画面に描く最低の長さ(分)** ── 札の最低の高さ(`app.css` の `calc(var(--day-hour) / 2)`)と同じ値。
 * ⚠ 重なりの判定は**この長さで**行う(着地前レビューが読んで指摘)── 実際の分だけで判定すると、
 *   `14:00..14:15` と `14:15..14:30` は同じ列に入るのに、画面では 1 件目の札が 2 件目の上半分を覆って押せない。
 */
export const MIN_SLOT_MINUTES = 30;

/**
 * `HH:MM` を 0 時からの分にする。読めない字は `null`。
 * ⚠ `25:99` のような値も予定の記法は通す(`isScheduleTime`)ので、**ここで丸める**
 *   (分は 59 まで・全体は 24:00 まで)── 目盛りの外へ置かない。
 */
export function minutesOf(time: string): number | null {
  const m = /^(\d{2}):(\d{2})$/.exec(time);
  if (m === null) return null;
  const mins = Number(m[1]) * 60 + Math.min(59, Number(m[2]));
  return Math.min(DAY_MINUTES, mins);
}

/** 目盛りに置く予定 1 件(置き場所を決める前)。 */
export interface DayPiece {
  /** 呼び側が持つ鍵(結果を引き当てる)。 */
  readonly key: string;
  readonly startMin: number;
  readonly endMin: number;
}

/** 目盛りの上の置き場所。 */
export interface DaySlot extends DayPiece {
  /** 何列目か(0 始まり)。 */
  readonly col: number;
  /** 同じ重なりの塊の列の数(幅は 1/cols)。 */
  readonly cols: number;
}

/**
 * 時刻から目盛り上の幅を決める。終日なら `null`。
 * ⚠ 始まりが 24:00 以降(`24:00` など)は**最後の 30 分に寄せる** ── 落とすと予定が黙って消える。
 */
export function pieceOf(
  key: string,
  time: string | null,
  timeEnd: string | null,
): DayPiece | null {
  if (time === null) return null;
  const rawStart = minutesOf(time);
  if (rawStart === null) return null;
  const start = Math.min(rawStart, DAY_MINUTES - DEFAULT_SPAN_MINUTES);
  const rawEnd = timeEnd === null ? null : minutesOf(timeEnd);
  const end =
    rawEnd !== null && rawEnd > start
      ? Math.min(rawEnd, DAY_MINUTES)
      : Math.min(start + DEFAULT_SPAN_MINUTES, DAY_MINUTES);
  return { key, startMin: start, endMin: end };
}

/** 束の 1 件を、目盛りに置くか終日に置くかで分ける。 */
export function splitDay(items: readonly AgendaItem[]): {
  readonly allDay: AgendaItem[];
  readonly timed: { readonly item: AgendaItem; readonly piece: DayPiece }[];
} {
  const allDay: AgendaItem[] = [];
  const timed: { item: AgendaItem; piece: DayPiece }[] = [];
  for (const item of items) {
    // ⚠ 期間・ノート 1 件の予定は、時刻を持っていても終日に置く(その日いっぱいの前提)
    const piece =
      item.until !== null || item.line === null ? null : pieceOf(item.key, item.time, item.timeEnd);
    if (piece === null) allDay.push(item);
    else timed.push({ item, piece });
  }
  return { allDay, timed };
}

/**
 * 重なる予定を横に並べる。
 *
 * ① 始まりの昇順(同じなら長いほうが先)に並べる
 * ② 互いに連鎖して重なる予定を 1 つの塊にする
 * ③ 塊の中で、空いている最初の列へ入れる
 * ④ 幅は塊の列の数で割る(塊が違えば列の数も違う)
 */
export function placeColumns(pieces: readonly DayPiece[]): DaySlot[] {
  const sorted = pieces
    .map((p, i) => ({ p, i }))
    .sort((a, b) => a.p.startMin - b.p.startMin || b.p.endMin - a.p.endMin || a.i - b.i)
    .map((x) => x.p);
  const out: DaySlot[] = [];
  let cluster: { piece: DayPiece; col: number }[] = [];
  let colEnds: number[] = [];
  let clusterEnd = -1;
  const flush = (): void => {
    for (const c of cluster) out.push({ ...c.piece, col: c.col, cols: colEnds.length });
    cluster = [];
    colEnds = [];
    clusterEnd = -1;
  };
  for (const p of sorted) {
    // ⚠ 判定は画面に描く長さで(上の MIN_SLOT_MINUTES)。返す endMin は実際の分のまま
    const drawnEnd = Math.max(p.endMin, p.startMin + MIN_SLOT_MINUTES);
    // 接しているだけ(前の終わり == 次の始まり)は重なりではない
    if (cluster.length > 0 && p.startMin >= clusterEnd) flush();
    let col = colEnds.findIndex((end) => end <= p.startMin);
    if (col === -1) {
      col = colEnds.length;
      colEnds.push(drawnEnd);
    } else {
      colEnds[col] = drawnEnd;
    }
    cluster.push({ piece: p, col });
    clusterEnd = Math.max(clusterEnd, drawnEnd);
  }
  flush();
  return out;
}

/**
 * 開いたとき最初に見せる位置(分)。
 * 最初の予定の 1 時間前 / 予定がなければ 8:00。
 */
export function initialScrollMinutes(pieces: readonly DayPiece[]): number {
  if (pieces.length === 0) return 8 * 60;
  const first = Math.min(...pieces.map((p) => p.startMin));
  return Math.max(0, first - 60);
}

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'] as const;

/**
 * 「日」の見出しの字(`10月10日(土)` / 今日と明日は後ろに添える / 今年でなければ年も出す)。
 * ⚠ `Date` に通して実在を確かめる(`2026-02-30` が 3 月 2 日へ寄るのを、別の日として出さない)。
 *   読めない字はそのまま出す(`agenda.ts` の `labelOf` と同じ向き)。
 */
export function dayHeading(date: string, today: string, tomorrow: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (m === null) return date;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const at = new Date(y, mo - 1, d);
  if (at.getFullYear() !== y || at.getMonth() !== mo - 1 || at.getDate() !== d) return date;
  const thisYear = today.slice(0, 4) === m[1];
  const head = `${thisYear ? '' : `${y}年`}${mo}月${d}日(${WEEKDAYS[at.getDay()]})`;
  if (date === today) return `${head} 今日`;
  if (date === tomorrow) return `${head} 明日`;
  return head;
}
