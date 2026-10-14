/**
 * 🔴 **押した時点の「その行の中身」を、画面が見ている本文から取る**(#1087)。
 *
 * ## なぜ要るか
 *
 * チェックの切り替え・予定の日付・繰り返しの回・表の升は、書換が**行番号**で行を指す。
 * 窓 A で別のノートを編集している間、窓 B が別のノート Y のチェックリストの上へ 1 行足すと、
 * 窓 A に残っている**古い Y の表示**(横に留めた枠・予定の札)の行番号は、disk では**別の項目**を指す。
 * 編集中のタブは他のノートの変更を取りに行かないので、その表示は古いまま残る。
 * そこで押すと、**押していない項目**が切り替わっていた。
 *
 * 🔑 直しは板の付箋(`place-move` の `openLine`)と同じ作法 ── 押した時点の行の中身を書換へ添え、
 *   disk 側の同じ行と byte 一致しなければ断る。この module は**運び手が行の中身を引く口**を 3 つに
 *   寄せる(§7):押した面によって「いま見えている本文」の置き場が違う。
 *
 * | 押した面 | 見えている本文の置き場 | 口 |
 * |---|---|---|
 * | 本文・横に留めた枠(表の升も) | `openBody` / `splitBodies` | `shownBodyLine` |
 * | 予定の札(押す・掴む・戻す) | `taskScan.cards`(札が焼かれた原文) | `shownCardLine` |
 * | 板の付箋の中のチェック | `placeBodies`(板のための抜粋) | `shownPlacedLine` |
 *
 * ⚠ どれも**引けなければ `null`**(画面に無い・札が走査に無い)。運び手は撃たずに断る
 *   (`SHOWN_LINE_LOST`)── 空文字を運ぶと、書換が「本文が変わっている」と嘘の理由で断る。
 */
import { applyBodyRewrite, bodyLineAt } from '@features/markdown/body-rewrite';
import { placeBodiesOf, screenBodyOf, type AppState } from './app-state';

/** 引けなかった回の断り文(運び手が `OP_FAILED` へ出す)。 */
export const SHOWN_LINE_LOST = '押した場所の内容を確かめられませんでした(開き直してください)';

/** 本文の面(主の枠・横に留めた枠)が見ている原文の、その行。 */
export function shownBodyLine(state: AppState, lid: string, line: number): string | null {
  const shown = screenBodyOf(state, lid);
  return shown === null ? null : bodyLineAt(shown, line);
}

/** 予定の札が焼かれた原文の、その行。⚠ 札は `taskScan` から描かれるので、見えているのはこの値である。 */
export function shownCardLine(
  state: Pick<AppState, 'taskScan'>,
  lid: string,
  line: number,
): string | null {
  const card = state.taskScan?.cards.find((c) => c.lid === lid && c.line === line);
  return card === undefined ? null : card.rawLine;
}

/**
 * 板の付箋の中(置いたノートの抜粋)の、その行。
 * ⚠ 抜粋は設定行(frontmatter)を剥がしてあるので、`lineOffset` を引いて抜粋の中の行に直す。
 * ⚠ **切った抜粋の最後の行は断る** ── 長い 1 行を字数で割った切り口かもしれず、原文の行と一致しない。
 */
export function shownPlacedLine(state: AppState, lid: string, line: number): string | null {
  const ex = placeBodiesOf(state).get(lid);
  if (ex === undefined || ex.missing === true || ex.gone === true) return null;
  const at = line - (ex.lineOffset ?? 0);
  if (!Number.isInteger(at) || at < 0) return null;
  if (ex.cut && ex.text.split('\n').length - 1 <= at) return null;
  return bodyLineAt(ex.text, at);
}

/**
 * 🔴 **表の升を続けて打つとき、自分が直前に書いた行を `openLine` に数える**(#1087 / #750 I1)。
 *
 * ## なぜ要るか
 *
 * `Tab` で隣の升を開くと、欄は**その場で**開く(書き戻しを待つと焦点が空く ── `cell-input.ts`)。
 * ところが前の升の書き戻しは**まだ画面の本文に届いていない**ので、隣の欄は書き戻し前の行
 * (`| a | b |`)を `openLine` として掴む。隣を確定する頃、disk は自分が書いた
 * `| りんご | b |` なので、書換は「別の窓が行を足した」と区別できず断る
 * (実ブラウザで `Tab` → 間を置かずに `3` → `Enter` → `Shift+Enter` が `b` のままだった)。
 *
 * 🔑 直しは**自分が確定した書換を、行の上で先へ進めて覚える**こと(`openLine` の意味は変えない)。
 *   画面の行が「覚えている列」のどれかと一致する間は、列の末尾(= 自分が書き終えた後の行)を使う。
 *
 * ⚠ **別の窓が行を足した形は断るまま**:覚えるのは自分の書換で進めた行だけで、画面の行が列に
 *   無ければ列ごと捨てる。足された行を指す番号は、予測した行と disk の行が食い違って断られる。
 * ⚠ 書き戻しが失敗した回に古い予測を使い続けないよう、**{@link CELL_CHAIN_TTL_MS} で捨てる**。
 */
const CELL_CHAIN_TTL_MS = 2000;

const cellChains = new Map<string, { lines: string[]; at: number }>();

const cellChainKey = (lid: string, line: number): string => `${lid}\n${line}`;

/** 覚えている列のうち、いま有効なもの(画面の行が列の中に居て、古すぎない)。 */
function liveCellChain(
  lid: string,
  line: number,
  shown: string,
  now: number,
): string[] | null {
  const key = cellChainKey(lid, line);
  const c = cellChains.get(key);
  if (c === undefined) return null;
  if (now - c.at > CELL_CHAIN_TTL_MS || !c.lines.includes(shown)) {
    cellChains.delete(key);
    return null;
  }
  return c.lines;
}

/** 表の升を開くときの `openLine`。自分が直前に書いた行が在れば、書き終えた後の行を返す。 */
export function shownCellLine(
  state: AppState,
  lid: string,
  line: number,
  now: number = Date.now(),
): string | null {
  const shown = shownBodyLine(state, lid, line);
  if (shown === null) return null;
  const chain = liveCellChain(lid, line, shown, now);
  return chain === null ? shown : chain[chain.length - 1]!;
}

/** 本文の `line` 行目を `text` に差し替えた本文(行末の `\r` は残す)。無い行は `null`。 */
function withBodyLine(body: string, line: number, text: string): string | null {
  const parts = body.split('\n');
  const old = parts[line];
  if (old === undefined) return null;
  parts[line] = text + (old.endsWith('\r') ? '\r' : '');
  return parts.join('\n');
}

/**
 * 升の確定を撃つ**直前**に呼ぶ ── この書換の結果の行を予測して、列の末尾へ足す。
 * ⚠ 予測は書換そのもの(`applyBodyRewrite`)で出す ── 規則を写さない(§7)。
 *   予測できなければ列を捨てる(断られる側に倒れる)。
 */
export function noteCellWrite(
  state: AppState,
  lid: string,
  rewrite: { line: number; openLine: string; col: number; value: string },
  now: number = Date.now(),
): void {
  const key = cellChainKey(lid, rewrite.line);
  const shown = shownBodyLine(state, lid, rewrite.line);
  const body = screenBodyOf(state, lid);
  if (shown === null || body === null) {
    cellChains.delete(key);
    return;
  }
  const chain = liveCellChain(lid, rewrite.line, shown, now) ?? [shown];
  if (chain[chain.length - 1] !== rewrite.openLine) {
    cellChains.delete(key);
    return;
  }
  const staged = withBodyLine(body, rewrite.line, rewrite.openLine);
  const next =
    staged === null ? null : applyBodyRewrite(staged, { kind: 'csv-cell', ...rewrite });
  const nextLine = next === null ? null : bodyLineAt(next, rewrite.line);
  if (nextLine === null) {
    cellChains.delete(key);
    return;
  }
  cellChains.set(key, {
    lines: nextLine === chain[chain.length - 1] ? chain : [...chain, nextLine],
    at: now,
  });
}

/** test 用 ── 覚えている列を空にする。 */
export function resetCellChains(): void {
  cellChains.clear();
}
