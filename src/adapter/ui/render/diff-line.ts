/**
 * 差分の 1 行の描き方(#398 段②。#1231 段② で `detail.ts` から出した)。
 *
 * 🔑 **履歴の面と、書き戻す前の確認の小窓が同じ器を使う** ── 印(+ / −)・色の規則
 *   (`[data-pkc-diff]`)・畳みの字を 2 か所に書くと、片方だけ直した日に割れる(CLAUDE.md §7)。
 */
import type { DiffRow } from '@features/revision/diff-view';

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
