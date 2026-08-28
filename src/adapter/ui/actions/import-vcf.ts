/**
 * 🔴 **vCard(.vcf)の取込**(#278 段③)── 1 枚 = 1 ノート。
 *
 * 作りは `import-markdown.ts` と同じ型(deps も同じ物を使う ── 取込の経路ごとに
 * 別の deps を組み立てない)。読む規則は `features/contact/vcard.ts`(pure)。
 *
 * ⚠ **読めた分を書かずに終える**(部分的に書かない)── md 経路と同じ理由。
 * ⚠ 題名の無いカードは番号名(「連絡先 3」)を振る ── 黙って捨てない。
 */
import type { Dispatcher } from '@adapter/state/dispatcher';
import type { EntryUpsert } from '@adapter/platform/storage/schema';
import { contactOf } from '@features/contact/contact-card';
import { parseVcf, vcfNoteOf } from '@features/contact/vcard';
import { extractMeta } from '@features/flavor';
import type { MarkdownImportDeps } from './import-markdown';

/**
 * .vcf を 1 枚ずつノートにする。**失敗は必ず可視**(OP_FAILED)で終える。
 * @returns 取り込んだノート数(失敗時は null)
 */
export async function importVcfFiles(
  dispatcher: Dispatcher,
  deps: MarkdownImportDeps,
  files: readonly File[],
): Promise<number | null> {
  const fail = (msg: string): null => {
    dispatcher.dispatch({ type: 'OP_FAILED', error: msg });
    return null;
  };
  if (dispatcher.getState().phase !== 'ready') {
    return fail('編集を終了してから取り込んでください');
  }
  if (files.length === 0) return fail('取り込むファイルがありません');

  const notes: string[] = [];
  const rows: EntryUpsert[] = [];
  try {
    let order = deps.orderBase();
    for (const file of files) {
      const parsed = parseVcf(await file.text());
      for (const w of parsed.warnings) notes.push(`${file.name}: ${w}`);
      if (parsed.cards.length === 0) {
        notes.push(`${file.name}: 連絡先が 1 枚も読めませんでした`);
        continue;
      }
      for (const card of parsed.cards) {
        const note = vcfNoteOf(card);
        const title = note.title !== '' ? note.title : `連絡先 ${rows.length + 1}`;
        if (note.title === '')
          notes.push(`${file.name}: 名前の無いカードに「${title}」と付けました`);
        const ext = extractMeta('text', note.body);
        rows.push({
          lid: deps.genLid(),
          title,
          archetype: 'text',
          body: note.body,
          entryOrder: ++order,
          status: ext.status,
          date: ext.date,
          archived: ext.archived,
        });
      }
    }
  } catch (e) {
    return fail(
      `vCard を読めませんでした(書込は行われていません): ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (rows.length === 0) {
    return fail('vCard から連絡先を 1 枚も読めませんでした');
  }

  try {
    await deps.bulkUpsertEntries(rows);
  } catch (e) {
    await deps.reload().catch(() => {});
    return fail(`取込に失敗しました: ${e instanceof Error ? e.message : String(e)}`);
  }

  await deps.reload();
  const last = rows[rows.length - 1];
  if (last) deps.focus?.(last.lid);
  deps.imported?.(rows.map((r) => r.lid));

  /**
   * 🔴 **「取り込んだ数」と「連絡先に並ぶ数」は別である**(着地前レビュー 2026-08-28)。
   *
   * ⚠ 1 稿目は作ったノートの数をそのまま「連絡先 N 件」と出していた。
   *   ところが**連絡先の面に並ぶ条件は「電話かメールが 1 つ以上」**
   *   (`contactOf`)なので、住所とメモだけのカードは**ノートにはなるが
   *   面には出ない** ── user は「N 件取り込んだのに、連絡先に M 件しか無い。
   *   残りは**消えた**」と読む(実際はノートとして在る)。
   * 🔑 だから**両方の数を出し、出ない分の在り処を言う**。
   * ⚠ 判定は面と**同じ 1 つ**(`contactOf`)を呼ぶ ── 数え方を 2 本持たない(§7)。
   */
  const listed = rows.filter((r) => contactOf(r.lid, r.title, r.body) !== null).length;
  const hidden = rows.length - listed;
  if (hidden > 0)
    notes.push(
      `電話もメールも無いカードが ${hidden} 件ありました(ノートにはなっていますが、連絡先の一覧には出ません)`,
    );
  deps.report?.(notes);
  const head =
    hidden > 0
      ? `取込完了: ノート ${rows.length} 件(うち連絡先に並ぶのは ${listed} 件)`
      : `取込完了: 連絡先 ${rows.length} 件`;
  deps.notify?.(notes.length > 0 ? `${head} ⚠ 注意 ${notes.length} 件` : head);
  return rows.length;
}
