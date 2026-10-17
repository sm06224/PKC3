/**
 * `:::` block directive の前後 blank line 正規化(共有 utility)。
 *
 * **背景**(2026-05-15 PR-W24 v3 + 2026-05-18 user 報告):
 * CommonMark の **blockquote lazy continuation** 仕様で、`>` で始まる
 * blockquote は次行が `>` prefix 無しでも paragraph continuation として
 * blockquote 内に取り込まれる。これにより:
 *
 * ```
 * > 引用テキスト
 * :::section{role=note}
 * 内容
 * :::
 * ```
 *
 * の `:::section` opener が blockquote の lazy continuation に取り込まれ、
 * `processSectionBlocks` 等の preprocessor が opener を sentinel 化しても
 * markdown-it パース時に blockquote 内 nested 構造として render され、HTML
 * 構造が崩れる。
 *
 * 本 utility は `:::` 行(opener / closer)の **前** に blank line を強制
 * 挿入することで lazy continuation を構造的に回避。`:::role{...}` opener の
 * **後** にも blank line を入れて content と分離。
 *
 * **歴史**:
 * - 元実装は `src/features/ast/parse.ts` 内 `ensureBlankAroundColonBlocks`
 *   として AST 経路専用だった(PR-W24 v3)
 * - 2026-05-18 user 報告で center pane / Viewer / Split View で使う
 *   `markdown-render.ts` 経路にも同じ正規化が必要と判明
 * - 本 module に抽出して両経路で共有(2 重保守を避け、対称性を担保)
 *
 * **関連 doc**:
 * - `docs/development/bug-section-blockquote-lazy-continuation-2026-05-18.md`
 * - `PKC2: docs/development/notation-redesign-2026-05/11-canonicalization-spec.md`
 */

import { advanceFence } from './list-renumber';

/**
 * `:::` block directive 前後 blank line 正規化(LineMap thread 版)。
 *
 * **markdown-render.ts 経路用**:Split View の source-preview-sync で
 * `data-pkc-source-line` が原文 line index を保つよう、insertion / drop を
 * line 単位で track して lineMap を更新する。
 *
 * 動作:
 * 1. malformed opener `:::role{...<no close brace>$` の attrs を drop
 *    (line in-place 書換、lineMap 不変)
 * 2. `:::` 行の **前** に blank line 挿入(insert、lineMap に複製)
 * 3. `:::role{...}` opener の **後** に blank line 挿入(insert、lineMap に複製)
 * 4. 連続 blank line の collapse(remove、lineMap 縮約)
 *
 * 挿入された blank line の lineMap 値は **直前 input line の index** を持つ
 * (Split View で caret が挿入 blank に来ても近傍の original line に
 * fallback できるよう)。
 */
export function ensureBlankAroundColonBlocksWithLineMap(
  source: string,
  lineMapIn: number[],
): { transformed: string; lineMap: number[] } {
  /**
   * 🔴 **`:::` も `\r` も無い本文は、3 段とも何もしない**(#1087)。
   * 3 つの正規表現(malformed / colonStart / opener)は全部 `:::` から始まる行にしか
   * 当たらないので、`:::` が 1 つも無ければ**行は 1 字も変わらず、挿入も無い**。
   * ⚠ 返す lineMap は遅い道と同じ式(`lineMapIn[i] ?? i`)で作る ── 入力の lineMap が
   *   恒等とは限らない(コメント除去などで既にずれている)ので、`lineMapIn` を
   *   そのまま返さない(同じ配列を共有しない)。
   * ⚠ `\r` も除外に入れる(行末の `\r` が正規表現の `$` に絡む形を、この近道の外に置く)。
   */
  if (source.indexOf(':::') === -1 && source.indexOf('\r') === -1) {
    const n = countLines(source);
    const map: number[] = new Array<number>(n);
    for (let i = 0; i < n; i++) map[i] = lineMapIn[i] ?? i;
    return { transformed: source, lineMap: map };
  }
  // Step 1: line 単位に分割、malformed opener attrs drop(in-place)
  const inLines = source.split('\n');
  const stage1Lines: string[] = [];
  const stage1Map: number[] = [];
  // 🔴 fence(``` / ~~~)の中と、その開閉の行は**一切触らない**(#1087)。コードの中の
  //   `:::` 行へ空行を挿すと、表示もコピーも空行が増える。判定の正本は `advanceFence`。
  const stage1Skip: boolean[] = [];
  let fenceMarker = '';
  const malformedOpenerRe = /^([ \t\u3000]*:::[a-zA-Z0-9_-]+)\{[^}\n]*$/;
  const colonStartRe = /^[ \t\u3000]*:::/;
  const openerRe = /^[ \t\u3000]*:::[a-zA-Z0-9_-]+(?:\{[^}\n]{0,200}\})?[ \t]*$/;
  for (let i = 0; i < inLines.length; i++) {
    const line = inLines[i]!;
    const inputIdx = lineMapIn[i] ?? i;
    const nextMarker = advanceFence(fenceMarker, line);
    const skip = fenceMarker !== '' || nextMarker !== '';
    fenceMarker = nextMarker;
    stage1Skip.push(skip);
    const m = skip ? null : malformedOpenerRe.exec(line);
    if (m) {
      stage1Lines.push(m[1]!);
    } else {
      stage1Lines.push(line);
    }
    stage1Map.push(inputIdx);
  }
  // Step 2: `:::` 行の前に blank line 挿入(直前 line が blank でないとき)
  const stage2Lines: string[] = [];
  const stage2Map: number[] = [];
  const stage2Skip: boolean[] = [];
  for (let i = 0; i < stage1Lines.length; i++) {
    const line = stage1Lines[i]!;
    const inputIdx = stage1Map[i]!;
    if (!stage1Skip[i]! && colonStartRe.test(line)) {
      const prev = stage2Lines[stage2Lines.length - 1];
      if (prev !== undefined && prev.trim() !== '') {
        stage2Lines.push('');
        stage2Map.push(inputIdx); // 挿入 blank は次 `:::` 行の input idx を持つ
        stage2Skip.push(false);
      }
    }
    stage2Lines.push(line);
    stage2Map.push(inputIdx);
    stage2Skip.push(stage1Skip[i]!);
  }
  // Step 3: `:::role{...}` opener の後に blank line 挿入(次行が非 blank のとき)
  const stage3Lines: string[] = [];
  const stage3Map: number[] = [];
  for (let i = 0; i < stage2Lines.length; i++) {
    const line = stage2Lines[i]!;
    const inputIdx = stage2Map[i]!;
    stage3Lines.push(line);
    stage3Map.push(inputIdx);
    if (!stage2Skip[i]! && openerRe.test(line)) {
      const next = stage2Lines[i + 1];
      if (next !== undefined && next.trim() !== '') {
        stage3Lines.push('');
        stage3Map.push(inputIdx); // 挿入 blank は直前 opener の input idx を持つ
      }
    }
  }
  // **LineMap-thread 版では Step 4(連続 blank collapse)を撤去**(2026-05-18 hotfix)。
  // 理由:他 preprocessor(processTolerantStandaloneAlign 等)が output line
  // 数を前提に alignMap / indexMap を構築しているため、pre-existing な
  // consecutive blank を collapse すると line index がずれて regression が
  // 出る。my insertion で発生する 3+ blank(user が手動 blank 入れていた
  // ところに自動 blank 追加など)は markdown-it 的に問題なし(2 個でも 3 個
  // でも paragraph separator として同 扱い)。
  return { transformed: stage3Lines.join('\n'), lineMap: stage3Map };
}

/** `source.split('\n').length` と同じ値(配列を作らずに数える)。 */
function countLines(source: string): number {
  let n = 1;
  for (let i = source.indexOf('\n'); i !== -1; i = source.indexOf('\n', i + 1)) n++;
  return n;
}
