/**
 * 差分の 1 行の描き方(#398 段②。#1231 段② で `detail.ts` から出した)。
 *
 * 🔑 **履歴の面と、書き戻す前の確認の小窓が同じ器を使う** ── 印(+ / −)・色の規則
 *   (`[data-pkc-diff]`)・畳みの字を 2 か所に書くと、片方だけ直した日に割れる(CLAUDE.md §7)。
 */
import type { DiffRow } from '@features/revision/diff-view';
import type { SideCell, SideRow } from '@features/revision/diff-side';

/** 差分の 1 行(#398 段②)。⚠ **読むだけ**の器 ── 押せる物を置かない。 */
export function diffLineEl(row: DiffRow): HTMLElement {
  const li = document.createElement('li');
  li.setAttribute('data-pkc-diff', row.kind);
  if (row.kind === 'gap') {
    li.textContent = `⋯ 変わっていない ${row.skipped ?? 0} 行`;
    return li;
  }
  // ⚠ 印は**字で置く**(色だけにしない ── 色が見えない人に届かない)
  const mark = row.kind === 'add' ? '+' : row.kind === 'del' ? '−' : ' ';
  li.textContent = `${mark} ${row.text}`;
  return li;
}

/**
 * 🔴 **左右に並べた差分の升 1 つ**(#1231 段①)。`side` = どちらの列か。`null` = **空の升**(反対側にだけ在る行)。
 *
 * ⚠ **読むだけ**の器。⚠ 印(+ / −)は**字で置く**(色だけにしない)── 左右に分けても同じ。
 * 🔑 `parts` が在れば、**変わった字だけ** `<mark data-pkc-diff-char>` で包む(同じ字は mark の外)。
 *   `null` なら行ごと塗る(長い行 / 対になる行が無い)。
 */
export function sideCellEl(side: 'left' | 'right', cell: SideCell | null): HTMLElement {
  const li = document.createElement('li');
  li.setAttribute('data-pkc-diff-side', side);
  if (cell === null) {
    li.setAttribute('data-pkc-diff', 'empty');
    li.setAttribute('aria-hidden', 'true');
    return li;
  }
  li.setAttribute('data-pkc-diff', cell.kind);
  const mark = cell.kind === 'add' ? '+' : cell.kind === 'del' ? '−' : ' ';
  if (cell.parts === null) {
    li.textContent = `${mark} ${cell.text}`;
    return li;
  }
  li.append(`${mark} `);
  for (const part of cell.parts) {
    if (!part.changed) {
      li.append(part.text);
      continue;
    }
    const m = document.createElement('mark');
    m.setAttribute('data-pkc-diff-char', cell.kind === 'del' ? 'del' : 'add');
    m.textContent = part.text;
    li.append(m);
  }
  return li;
}

/** 左右の差分の 1 行 = 升 2 つ(`gap` は両列にまたがる 1 つ)。⚠ 同じ行の升は同じ高さに揃う(CSS の grid)。 */
export function sideRowEls(row: SideRow): HTMLElement[] {
  if (row.kind === 'gap') return [diffLineEl({ kind: 'gap', text: '', skipped: row.skipped })];
  return [sideCellEl('left', row.left), sideCellEl('right', row.right)];
}
