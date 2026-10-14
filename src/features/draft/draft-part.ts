/**
 * 章の欄 / コード枠の欄の控え(#1728)を、いまの本文に当てる ── 判断だけを持つ純関数。
 *
 * 🔑 探し方は保存のときと同じ関数を通す(2 本目の規則を作らない):章は見出しの**名前**で
 *   (`replaceSectionByHeading` と同じ ── 0 個 / 2 個以上は決まらない、原文が違えば別の場所で書き換えられている)、
 *   枠は身元(`locateCodeFence`)で探す。
 * ⚠ 行は **frontmatter を剥がした側**で返す ── `OPEN_SECTION_DRAFT` / `OPEN_CODE_DRAFT` が受ける行と同じ規約。
 */
import { listAppendTargets, sectionRange } from '../markdown/append-target';
import { locateCodeFence } from '../markdown/code-fence-edit';
import { frontmatterLineCount } from '../markdown/frontmatter';
import type { DraftPart, DraftRecord } from './draft-recovery';

export type PartLocation =
  | { readonly ok: true; readonly line: number }
  | { readonly ok: false; readonly reason: 'missing' | 'ambiguous' | 'mismatch' };

/** `part.original` と同じ字を持つ欄が、`body` のどこに在るか。 */
export function locateDraftPart(body: string, part: DraftPart): PartLocation {
  const fm = frontmatterLineCount(body);
  if (part.kind === 'code') {
    const located = locateCodeFence(body, part);
    return located.ok ? { ok: true, line: located.fence.start - fm } : { ok: false, reason: located.reason };
  }
  const matches = listAppendTargets(body).filter((h) => h.text === part.heading);
  if (matches.length === 0) return { ok: false, reason: 'missing' };
  if (matches.length > 1) return { ok: false, reason: 'ambiguous' };
  const range = sectionRange(body, matches[0]!.slug);
  if (range === null) return { ok: false, reason: 'missing' };
  const current = body.split(/\r?\n/).slice(range.start, range.end).join('\n');
  if (current !== part.original) return { ok: false, reason: 'mismatch' };
  return { ok: true, line: range.start - fm };
}

/**
 * 起動時、保存されている本文と欄の控えを比べた結果。
 * - `gone`  ノートが無い ── 黙って片付ける
 * - `same`  いまの欄が打っていた字と同じ(保存は済んでいる)── 聞くことが無い
 * - `plain` 欄が開いたときのまま ── 戻せる
 * - `moved` 欄が見つからない / 変わっている ── 書き込まない。打った字をコピーで渡す
 */
export type PartVerdict = 'gone' | 'same' | 'plain' | 'moved';

export function judgePartDraft(
  draft: DraftRecord & { readonly part: DraftPart },
  storedBody: string | null,
): PartVerdict {
  if (storedBody === null) return 'gone';
  if (locateDraftPart(storedBody, { ...draft.part, original: draft.body }).ok) return 'same';
  return locateDraftPart(storedBody, draft.part).ok ? 'plain' : 'moved';
}
