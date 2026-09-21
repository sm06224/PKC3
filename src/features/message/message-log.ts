/**
 * 🔴 **メッセージ型**(設計 doc `docs/development/ui-total-design-2026-09.md` §7、段②a)。
 *
 * メッセージは **system 領域のノート 1 件**(フレーバー = ログ)。裁定 2026-09-20
 * 「システム用ノートで GO。user のディレクトリと明確に分けることが条件」を、
 * ノートという既存の型(`entries.realm = 'system'`)に載せて実現する ──
 * 新しい画面も新しい保存の仕組みも作らない。
 *
 * 🔴 **中身を漏らさない**(§7)。書く口を 1 つ(`postMessage`、adapter 側)に絞り、
 * ここでは**固定の形の節しか作れない** ── user の題名・見出し・添付名を
 * 組み込める自由な文字列を、そのまま本文へ書き込む経路を構造から無くす。
 *
 * ⚠ **pure module**(browser API を持たない)。IndexedDB の控え・localStorage の
 * 既読は adapter 側(`src/adapter/platform/message-post.ts`)が持つ。
 */
import { formatHeadingTimestamp } from '../flavor/textlog-flavor';

export type MessageKind = 'result' | 'caution' | 'problem' | 'delivery' | 'job';

/** 画面の字(設計 doc §7 の表)。 */
export const MESSAGE_KIND_LABEL: Readonly<Record<MessageKind, string>> = {
  result: '結果',
  caution: '注意',
  problem: '問題',
  delivery: '配信',
  job: '処理',
};

/**
 * 逆引き(節の先頭に書いた太字の字から種類を読み直す ── `countUnread` が使う)。
 * ⚠ **`MESSAGE_KIND_LABEL` の写しを手で書かない**(§7「同じ値は複数の場所に
 * 置かない」)── ここから組む。
 */
const LABEL_TO_KIND: ReadonlyMap<string, MessageKind> = new Map(
  (Object.keys(MESSAGE_KIND_LABEL) as MessageKind[]).map((k) => [MESSAGE_KIND_LABEL[k], k]),
);

/**
 * 🔴 **system 領域の固定 lid**(設計 doc §7)。
 *
 * ⚠ **種類ごとに分けるのは上限が違うから**(§7)── `result / caution / problem /
 *   delivery` は 1 本のノート(題名「メッセージ」)に集約し、`job`
 *   (ワーカーの記録。段②b で接続)だけ上限が違う(5,000 件)ので別ノートにする。
 *   ⚠ 画面では「メッセージ」の節 1 つに種類の切替として見せる(§7)。
 */
export const SYSTEM_MESSAGE_LID = 'sys-messages';
export const SYSTEM_JOB_LID = 'sys-jobs';

/** その種類のメッセージを書くノートの lid。 */
export function lidForMessageKind(kind: MessageKind): string {
  return kind === 'job' ? SYSTEM_JOB_LID : SYSTEM_MESSAGE_LID;
}

/**
 * 🔴 **system のメッセージ 2 lid かどうかの判定は、ここ 1 か所を通す**
 * (CLAUDE.md §7「同じ問いに答える口を 2 つ作らない」)。
 *
 * ⚠ **`entries.realm` を読まない**(段②a の時点では system 領域のノートは
 *   この 2 件しか無いので、固定の lid 判定で足りる)。system 領域のノートの
 *   種類が増えたら、ここを `realm` ベースの判定へ寄せ直すこと(段③以降)。
 */
export function isSystemMessageLid(lid: string): boolean {
  return lid === SYSTEM_MESSAGE_LID || lid === SYSTEM_JOB_LID;
}

/** そのノートの題名(設計 doc §7)。 */
export function titleForMessageLid(lid: string): string {
  return lid === SYSTEM_JOB_LID ? '処理の記録' : 'メッセージ';
}

/**
 * 🔴 **上限**(設計 doc §7)。
 * ⚠ user が選べるのは `result / caution / problem / delivery` の側だけ
 * (`MESSAGE_CAP_OPTIONS`)。`job` は既定で固定(§7「処理 = 5,000 件保管」)。
 */
export const MESSAGE_CAP_DEFAULT = 500;
export const MESSAGE_CAP_OPTIONS: readonly number[] = [100, 500, 2000];
export const JOB_CAP = 5000;

/** そのノートに効く上限(`job` は configuredCap を無視する)。 */
export function capForMessageLid(lid: string, configuredCap: number): number {
  return lid === SYSTEM_JOB_LID ? JOB_CAP : configuredCap;
}

/** 1 件の節に必要な物。⚠ `text` は呼び側が `sanitizeMessageText` を通した後の値。 */
export interface MessageSectionInput {
  /** ISO timestamp。 */
  readonly at: string;
  readonly kind: MessageKind;
  /** 出所(固定の機能名。user の入力は含めない)。 */
  readonly source: string;
  /** 文(サニタイズ済み)。 */
  readonly text: string;
}

/**
 * 1 件の節を組む。
 *
 * ⚠ **見出しは `textlog-flavor.ts` と同じ形**(`## YYYY-MM-DD HH:mm:ss`)を使う ──
 *   普通のノートと同じ道具(検索・別窓・印刷・書き出す)でそのまま読めるように、
 *   記法を 1 つも増やさない(設計 doc §7「新しい画面も道具も作らない」)。
 * ⚠ **`text` はここでは sanitize しない** ── 呼び側(`postMessage`)が
 *   `sanitizeMessageText` を通した後の値を渡す(判断を 1 か所に置く)。
 */
export function formatMessageSection(input: MessageSectionInput): string {
  const heading = `## ${formatHeadingTimestamp(input.at)}`;
  const label = MESSAGE_KIND_LABEL[input.kind];
  return `${heading}\n**${label}** ${input.source} ── ${input.text}\n\n`;
}

/**
 * 🔴 **中身を漏らさない**(設計 doc §7)。
 *
 * ① 「…」『…』の中身を潰す ── 題名・見出し・添付名が混ざる形は、この repo では
 *    全部この括弧で書かれる(13 か所の実例)。
 * ② 改行を空白へ ── 節の形(見出し + 1〜2 行)を壊さない。
 * ③ 80 字で切る ── 生の例外(`${e.message}` / `${String(e)}`)は無制限の長さを
 *    持ちうる。⚠ **切ったことは字で言う**(黙って切らない ── CLAUDE.md §1)。
 */
const QUOTE_RE = /「[^」]*」|『[^』]*』/g;
const MAX_MESSAGE_TEXT_LENGTH = 80;

export function sanitizeMessageText(text: string): string {
  const collapsed = text.replace(QUOTE_RE, (m) => (m.charAt(0) === '「' ? '「…」' : '『…』'));
  const flattened = collapsed.replace(/\r?\n/g, ' ');
  return flattened.length > MAX_MESSAGE_TEXT_LENGTH
    ? `${flattened.slice(0, MAX_MESSAGE_TEXT_LENGTH)}…`
    : flattened;
}

/**
 * 節ごとに分ける。⚠ **`## ` から始まる行の直前で切る** ── `appendMessage` が
 * 足すのは `formatMessageSection` の出力だけなので、本文は必ず `## ` から始まる
 * (先頭の空文字列は捨てる)。
 */
function splitSections(body: string): string[] {
  if (body === '') return [];
  return body.split(/(?=^## )/m).filter((s) => s !== '');
}

/**
 * 古い節から落として上限に収める(設計 doc §7「種類ごと・古い節から落とす」)。
 * ⚠ **節の単位で切る** ── 途中で切ると壊れた markdown を残す。
 */
export function trimToCap(body: string, cap: number): string {
  const sections = splitSections(body);
  if (sections.length <= cap) return body;
  return sections.slice(sections.length - cap).join('');
}

/**
 * 🔴 **未読の数**(設計 doc §7「既読」)。
 *
 * ⚠ 数えるのは **注意 / 問題だけ** ── 結果・配信・処理は「読んで確かめる」
 *   性質の知らせではないので未読に数えない(起動のたびに未読が増え続けない)。
 * ⚠ `readAtIso === null`(まだ 1 度も開いていない)なら、注意 / 問題は全部未読。
 */
const SECTION_HEAD_RE = /^## (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\n\*\*([^*]+)\*\*/;

export function countUnread(body: string, readAtIso: string | null): number {
  const readMark = readAtIso === null ? '' : formatHeadingTimestamp(readAtIso);
  let count = 0;
  for (const section of splitSections(body)) {
    const m = SECTION_HEAD_RE.exec(section);
    if (!m) continue;
    const at = m[1] ?? '';
    const kind = LABEL_TO_KIND.get(m[2] ?? '');
    if (kind !== 'caution' && kind !== 'problem') continue;
    if (at > readMark) count += 1;
  }
  return count;
}
