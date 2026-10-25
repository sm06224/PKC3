/**
 * 🔴 **予定表のカンバン ── 状態(未完了 / 完了)を列に並べる**(#277。user 指示 2026-08-19「カンバンとカレンダーを復活」)。
 *
 * ## 何を札にするか
 *
 * user が不合格にしたのは「**全部のチェックリストが札になる**」ことだけ(2026-08-23 「体裁として書いたチェックリストまで
 * 看板に出てくる。これはただのノイズ。ただし、日付を入れたチェックリスト、これが予定として機能する。この発想はいい」)。
 * だから札は **日付付きのチェック項目(本文の 1 行)** だけ ── 予定表が一覧に出すのと同じ札(`AgendaItem`)である。
 *
 * - 🔑 **ノート 1 件が丸ごと予定**(`line === null`)は札にしない ── 動かして書き換えるチェック欄(`[ ]`↔`[x]`)が無い。
 * - 🔑 **繰り返しの規則の行**は札にしない ── チェックすると「その日ぶんの行が本文に増える」ので、状態の列を行き来する物ではない。
 *   (予定表の一覧・日・週・月では今までどおり扱える。数は `skipped` で返し、面が言う)
 * - 日付なしの項目は札にしない(予定として扱わない ── 上の user の字のとおり)。
 *
 * ⚠ **pure module**(DOM も時計も持たない)。上限で切ったら `more` が数を返す ── 面が必ず言う(黙って切らない)。
 */
import type { AgendaItem } from './agenda';

/** 1 列に出す札の上限。⚠ これ以上は 1 画面で扱えない(超えた分は数だけ言う)。 */
export const BOARD_COLUMN_MAX = 100;

export interface BoardColumns {
  /** 未完了。期限の近い(古い)順 ── 期限切れが上に来る。 */
  readonly open: readonly AgendaItem[];
  /** 完了。済ませた日付の新しい順 ── 最近済ませたものが上に来る。 */
  readonly done: readonly AgendaItem[];
  /** 上限で切った、未完了 / 完了の札の数。 */
  readonly openMore: number;
  readonly doneMore: number;
  /** 札にしなかった繰り返しの規則の数(面が「予定表の一覧で扱います」と言う)。 */
  readonly skipped: number;
}

const byDateTime = (a: AgendaItem, b: AgendaItem): number =>
  (a.date ?? '').localeCompare(b.date ?? '') ||
  (a.time ?? '').localeCompare(b.time ?? '') ||
  a.lid.localeCompare(b.lid) ||
  (a.line ?? 0) - (b.line ?? 0);

/** 札になるか。⚠ 「日付付きのチェック項目」の定義は面ではなくここ 1 か所。 */
export function isBoardCard(item: AgendaItem): boolean {
  return item.line !== null && item.date !== null && item.repeat === null;
}

export function buildBoard(items: readonly AgendaItem[], max: number = BOARD_COLUMN_MAX): BoardColumns {
  const open: AgendaItem[] = [];
  const done: AgendaItem[] = [];
  let skipped = 0;
  for (const it of items) {
    if (it.line === null || it.date === null) continue;
    if (it.repeat !== null) {
      skipped += 1;
      continue;
    }
    (it.done ? done : open).push(it);
  }
  open.sort(byDateTime);
  done.sort((a, b) => byDateTime(b, a));
  return {
    open: open.slice(0, max),
    done: done.slice(0, max),
    openMore: Math.max(0, open.length - max),
    doneMore: Math.max(0, done.length - max),
    skipped,
  };
}
