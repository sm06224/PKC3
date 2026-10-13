/**
 * 🔴 **カレンダー形式(.ics)の取込**(#855 段 D)── 1 file = 予定の一覧 1 ノート。
 *
 * 作りは `import-vcf.ts` と同じ型(deps も同じ物 ── 取込の経路ごとに別の deps を組み立てない)。
 * 読む規則は `features/schedule/ics-import.ts`(pure)。
 *
 * - ⚠ **読めた分を書かずに終える**(部分的に書かない)── md / vCard 経路と同じ理由。
 * - ⚠ **読めなかった物は種類ごとに数えて言う**(繰り返しを読めず 1 回目だけ入れた数 …)。黙って落とさない。
 * - 🔑 メインスレッドで読む: 読むのは文字列の走査だけで重い計算が無い(ワーカー規律の対象外)。
 *   ただし大きすぎる file(`ICS_IMPORT_MAX_BYTES`)と予定が多すぎる file(`ICS_IMPORT_MAX_EVENTS`)は**断る**。
 */
import { errorText } from '@features/error-text';
import type { Dispatcher } from '@adapter/state/dispatcher';
import { hasUnsavedTyping, phaseBlockReason, SECTION_DRAFT_NOTE } from '@adapter/state/app-state';
import type { EntryUpsert } from '@adapter/platform/storage/schema';
import { extractMeta } from '@features/flavor';
import { humanBytes } from '@features/human-bytes';
import {
  ICS_IMPORT_MAX_BYTES,
  ICS_IMPORT_MAX_EVENTS,
  icsCountNotes,
  icsNoteBody,
  icsNoteTitle,
  parseIcs,
  type IcsCounts,
} from '@features/schedule/ics-import';
import type { MarkdownImportDeps } from './import-markdown';

const ZERO: IcsCounts = {
  cancelled: 0,
  repeatUnread: 0,
  invalid: 0,
  zoneUnknown: 0,
  spansDays: 0,
  overrides: 0,
  zoneRepeat: 0,
};

/**
 * .ics を予定の一覧ノートにする。**失敗は必ず可視**(OP_FAILED)で終える。
 * @returns 取り込んだ予定の数(失敗時は null)
 */
export async function importIcsFiles(
  dispatcher: Dispatcher,
  deps: MarkdownImportDeps,
  files: readonly File[],
): Promise<number | null> {
  const fail = (msg: string): null => {
    dispatcher.dispatch({ type: 'OP_FAILED', error: msg });
    return null;
  };
  const gate = (): string | null => {
    const st = dispatcher.getState();
    // ⚠ 門は md / vCard / PowerPoint 経路と同じ(§7)
    if (hasUnsavedTyping(st)) {
      return st.phase === 'editing' ? `${phaseBlockReason(st.phase)}取り込んでください` : SECTION_DRAFT_NOTE;
    }
    if (st.phase !== 'ready') return `${phaseBlockReason(st.phase)}取り込んでください`;
    return null;
  };
  const blocked = gate();
  if (blocked !== null) return fail(blocked);
  if (files.length === 0) return fail('取り込むファイルがありません');

  const rows: EntryUpsert[] = [];
  let total = 0;
  const sum: { -readonly [K in keyof IcsCounts]: number } = { ...ZERO };
  const notes: string[] = [];
  try {
    let order = deps.orderBase();
    for (const file of files) {
      if (file.size > ICS_IMPORT_MAX_BYTES) {
        return fail(
          `${file.name} は大きすぎて取り込めません(${humanBytes(ICS_IMPORT_MAX_BYTES)} まで。ノートは 1 件も追加されていません)`,
        );
      }
      const parsed = parseIcs(await file.text());
      if (parsed.overLimit) {
        return fail(
          `${file.name} は予定が多すぎて取り込めません(${ICS_IMPORT_MAX_EVENTS} 件まで。ノートは 1 件も追加されていません)`,
        );
      }
      for (const k of Object.keys(sum) as (keyof IcsCounts)[]) sum[k] += parsed.counts[k];
      if (parsed.events.length === 0) {
        const why = icsCountNotes(parsed.counts);
        notes.push(`${file.name}: 取り込める予定が 1 件もありませんでした${why.length > 0 ? `(${why.join('、')})` : ''}`);
        continue;
      }
      const body = icsNoteBody(parsed.events);
      const ext = extractMeta('text', body);
      total += parsed.events.length;
      rows.push({
        lid: deps.genLid(),
        title: icsNoteTitle(file.name),
        archetype: 'text',
        body,
        entryOrder: ++order,
        status: ext.status,
        date: ext.date,
        archived: ext.archived,
      });
    }
  } catch (e) {
    return fail(
      `カレンダー形式のファイルを読めませんでした(ノートは 1 件も追加されていません): ${errorText(e)}`,
    );
  }
  if (rows.length === 0) {
    return fail(notes.length > 0 ? notes.join(' / ') : '取り込める予定が 1 件もありませんでした');
  }

  // 🔴 読んでいる間に編集が始まったかもしれない ── 書く直前に門をもう一度通す
  const again = gate();
  if (again !== null) return fail(again);

  try {
    await deps.bulkUpsertEntries(rows);
  } catch (e) {
    await deps.reload().catch(() => {});
    return fail(`取り込みに失敗しました: ${errorText(e)}`);
  }

  await deps.reload();
  const last = rows[rows.length - 1];
  if (last) deps.focus?.(last.lid);
  deps.imported?.(rows.map((r) => r.lid));

  const why = icsCountNotes(sum);
  notes.push(...why);
  deps.report?.(notes);
  deps.notify?.(`予定 ${total} 件を取り込みました${why.length > 0 ? `(${why.join('、')})` : ''}`);
  return total;
}
