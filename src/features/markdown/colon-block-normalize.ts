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
 * - `docs/development/notation-redesign-2026-05/11-canonicalization-spec.md`
 */

/**
 * `:::` block directive の前後に blank line を正規化する(string-only 版)。
 *
 * 適用ルール:
 * 1. 全 `:::` 行(opener / closer)の **前** に blank line を挿入
 * 2. malformed `:::role{...<no close brace>$` 行の attrs を drop(寛容 parse)
 * 3. `:::role{...}` opener の **後** に blank line(content と分離)
 * 4. 3+ 連続 newline を 2 に collapse(冪等)
 *
 * **AST 経路用**:`src/features/ast/parse.ts` から呼ばれ、markdown-it に
 * 渡す前の文字列正規化だけが目的。LineMap thread は不要(AST 経路は
 * `data-pkc-source-line` を扱わない)。
 *
 * **冪等性**:複数回 適用しても同じ結果(2 回目以降は no-op)。
 */
export function ensureBlankAroundColonBlocks(body: string): string {
  // 全 `:::` 行(opener / closer)の **前** に blank line を挿入、
  // 多重 newline は事後 collapse。これで `:::\n:::`(連続 closer)
  // `}\n:::`(content + closer)`>quote\n:::`(blockquote lazy
  // continuation + closer)すべて blank line で分離される。
  let out = body.replace(/\n([ \t\u3000]*:::)/g, '\n\n$1');
  // malformed `:::role{...<no close brace>$` 行は attrs を drop
  // (寛容 parse、`author=` literal が content に漏れるのを防ぐ)
  out = out.replace(
    /^([ \t\u3000]*:::[a-zA-Z0-9_-]+)\{[^}\n]*$/gm,
    '$1',
  );
  // `:::role{...}` opener の **後** に blank line(content と分離)
  out = out.replace(
    /^([ \t\u3000]*:::[a-zA-Z0-9_-]+(?:\{[^}\n]{0,200}\})?[ \t]*)\n([^\n])/gm,
    '$1\n\n$2',
  );
  // 3+ 連続 newline を 2(blank line 1 個)に collapse
  out = out.replace(/\n{3,}/g, '\n\n');
  return out;
}

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
  // Step 1: line 単位に分割、malformed opener attrs drop(in-place)
  const inLines = source.split('\n');
  const stage1Lines: string[] = [];
  const stage1Map: number[] = [];
  const malformedOpenerRe = /^([ \t\u3000]*:::[a-zA-Z0-9_-]+)\{[^}\n]*$/;
  const colonStartRe = /^[ \t\u3000]*:::/;
  const openerRe = /^[ \t\u3000]*:::[a-zA-Z0-9_-]+(?:\{[^}\n]{0,200}\})?[ \t]*$/;
  for (let i = 0; i < inLines.length; i++) {
    const line = inLines[i]!;
    const inputIdx = lineMapIn[i] ?? i;
    const m = malformedOpenerRe.exec(line);
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
  for (let i = 0; i < stage1Lines.length; i++) {
    const line = stage1Lines[i]!;
    const inputIdx = stage1Map[i]!;
    if (colonStartRe.test(line)) {
      const prev = stage2Lines[stage2Lines.length - 1];
      if (prev !== undefined && prev.trim() !== '') {
        stage2Lines.push('');
        stage2Map.push(inputIdx); // 挿入 blank は次 `:::` 行の input idx を持つ
      }
    }
    stage2Lines.push(line);
    stage2Map.push(inputIdx);
  }
  // Step 3: `:::role{...}` opener の後に blank line 挿入(次行が非 blank のとき)
  const stage3Lines: string[] = [];
  const stage3Map: number[] = [];
  for (let i = 0; i < stage2Lines.length; i++) {
    const line = stage2Lines[i]!;
    const inputIdx = stage2Map[i]!;
    stage3Lines.push(line);
    stage3Map.push(inputIdx);
    if (openerRe.test(line)) {
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
