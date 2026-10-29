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
import { tagFoldKey } from '../flavor/tags';
import type { AgendaItem } from './agenda';
import { inlineTagsOf } from './item-color';

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

// ══ 信号機(#1457)══════════════════════════════════════════════════
/**
 * 🔴 **信号機の列 ── 進捗を赤・黄・緑で並べる**(#1457「カラータグ・カンバンタグ(信号機バッジ等)による視覚的グルーピングと進捗管理」)。
 *
 * ## 何を求められていたか
 *
 * 優先度や進捗が、限られた画面で**一目で**分かる。赤 = 緊急・止まっている / 黄 = 進行中・保留 / 緑 = 順調・完了、という
 * 信号機の意味を持つ列でカンバンを見られる(PKC1 の `#status/red` のようなタグでも指定できる)。
 *
 * ## 列の決め方(上が勝つ)
 *
 * | 順 | 条件 | 列 |
 * |---|---|---|
 * | 1 | 済み(`[x]`) | **完了** |
 * | 2 | 行に**信号のタグ**(`#赤` `#黄` `#緑` / `#red` `#yellow` `#green` / `#status/red` ほか) | そのタグの色 |
 * | 3 | 期日が**今日より前**(期限切れ) | **赤** |
 * | 4 | 期日が**今日から 3 日以内** | **黄** |
 * | 5 | それ以降 | **緑** |
 *
 * 🔑 色が示すのは**情報**だけ(期限の近さと、user が付けたタグ)。「地は無彩色、色は情報にだけ使う」の内側。
 * ⚠ 札になる物は状態のカンバンと**同じ**(`buildBoard` と同じ定義 ── 日付付きのチェック項目)。
 * ⚠ 落とし先の意味は状態のカンバンと同じ: 赤・黄・緑は「未完了」、完了は「完了」(列の間で動かすと `[ ]`↔`[x]` が切り替わる)。
 *   赤・黄・緑どうしの間は動かさない(期日とタグは本文に書く物で、ドラッグでは書き換えない)。
 */
export type SignalColor = 'red' | 'yellow' | 'green';

/** 期日が今日からこの日数以内なら黄。 */
export const SIGNAL_SOON_DAYS = 3;

/** 信号のタグの綴り(畳んだ形で突き合わせる ── 大小・全角半角は無視)。 */
const SIGNAL_TAG_WORDS: Readonly<Record<SignalColor, readonly string[]>> = {
  red: ['赤', 'red'],
  yellow: ['黄', '黄色', 'yellow'],
  green: ['緑', 'green'],
};

const SIGNAL_TAG_INDEX: ReadonlyMap<string, SignalColor> = new Map(
  (Object.keys(SIGNAL_TAG_WORDS) as SignalColor[]).flatMap((c) =>
    SIGNAL_TAG_WORDS[c].flatMap((w) => [
      [tagFoldKey(w), c] as const,
      [tagFoldKey(`status/${w}`), c] as const,
    ]),
  ),
);

/** 行の字に書いた信号のタグ(先に書いたもの)。無ければ `null`。 */
export function signalTagOf(text: string): SignalColor | null {
  for (const tag of inlineTagsOf(text)) {
    const c = SIGNAL_TAG_INDEX.get(tagFoldKey(tag));
    if (c !== undefined) return c;
  }
  return null;
}

/** `YYYY-MM-DD` に日数を足す(暦の計算は UTC で ── 夏時間や時刻の影響を受けない)。読めなければ `null`。 */
function addDays(date: string, days: number): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (m === null) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) + days * 86_400_000;
  const d = new Date(t);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** 未完了の札の信号(上の表の 2〜5)。`today` は `YYYY-MM-DD`。 */
export function signalOf(item: AgendaItem, today: string): SignalColor {
  const tagged = signalTagOf(item.text);
  if (tagged !== null) return tagged;
  const date = item.date ?? '';
  if (date < today) return 'red';
  const soon = addDays(today, SIGNAL_SOON_DAYS);
  if (soon !== null && date <= soon) return 'yellow';
  return 'green';
}

export interface SignalBoardColumns {
  readonly red: readonly AgendaItem[];
  readonly yellow: readonly AgendaItem[];
  readonly green: readonly AgendaItem[];
  readonly done: readonly AgendaItem[];
  /** 上限で切った数(赤 / 黄 / 緑 / 完了)。 */
  readonly more: Readonly<Record<SignalColor | 'done', number>>;
  readonly skipped: number;
}

/** 信号機の列に並べる。⚠ 札の定義と並び(期日の近い順・完了は新しい順)は `buildBoard` と同じ。 */
export function buildSignalBoard(
  items: readonly AgendaItem[],
  today: string,
  max: number = BOARD_COLUMN_MAX,
): SignalBoardColumns {
  const cols: Record<SignalColor | 'done', AgendaItem[]> = { red: [], yellow: [], green: [], done: [] };
  let skipped = 0;
  for (const it of items) {
    if (it.line === null || it.date === null) continue;
    if (it.repeat !== null) {
      skipped += 1;
      continue;
    }
    cols[it.done ? 'done' : signalOf(it, today)].push(it);
  }
  for (const c of ['red', 'yellow', 'green'] as const) cols[c].sort(byDateTime);
  cols.done.sort((a, b) => byDateTime(b, a));
  const cut = (c: SignalColor | 'done'): readonly AgendaItem[] => cols[c].slice(0, max);
  const over = (c: SignalColor | 'done'): number => Math.max(0, cols[c].length - max);
  return {
    red: cut('red'),
    yellow: cut('yellow'),
    green: cut('green'),
    done: cut('done'),
    more: { red: over('red'), yellow: over('yellow'), green: over('green'), done: over('done') },
    skipped,
  };
}
