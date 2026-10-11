/**
 * 🔴 **PowerPoint(.pptx)の取込**(#530 C)── スライド 1 枚 = 板のノート 1 件。
 *
 * 作りは `import-vcf.ts` と同じ型(deps も同じ物 ── 取込の経路ごとに別の deps を組み立てない)。
 * 読む規則は `features/import/pptx-board.ts`(pure)。
 *
 * - ⚠ **読めた分を書かずに終える**(部分的に書かない)── md / vCard 経路と同じ理由。
 * - ⚠ **戻せなかったものは件数で言う**(「取り込めなかったものが N 件ありました」)。何かは列挙しない。
 * - 🔑 **メインスレッドで読む**: 読むのは小さな XML 数枚で、zip の展開は既存の読み手
 *   (`readZipEntry`。`DecompressionStream` で流す)が非同期に行う。重い計算が無いのでワーカーは起こさない
 *   (不可侵指示「重い処理はワーカーへ」の対象外)。ただし zip 爆弾に備え、1 枚が
 *   {@link SLIDE_XML_MAX} を超えるスライドは読まずに件数へ数える。
 */
import type { Dispatcher } from '@adapter/state/dispatcher';
import { hasUnsavedTyping, phaseBlockReason, SECTION_DRAFT_NOTE } from '@adapter/state/app-state';
import type { EntryUpsert } from '@adapter/platform/storage/schema';
import { extractMeta } from '@features/flavor';
import { readPptxSlide, pptxSlideNames } from '@features/import/pptx-board';
import { readZipDirectory, readZipText, ZipReadError } from '@features/import/zip-reader';
import type { MarkdownImportDeps } from './import-markdown';

/** 1 枚のスライド XML の上限(展開後)。普通のスライドは数十 KB。 */
export const SLIDE_XML_MAX = 8 * 1024 * 1024;
/** 1 つの file から作る板の上限。超えた分は件数に数える。 */
export const SLIDES_MAX = 200;

const baseName = (name: string): string => name.replace(/\.pptx$/i, '');

/**
 * .pptx を 1 枚ずつ板のノートにする。**失敗は必ず可視**(OP_FAILED)で終える。
 * @returns 取り込んだノート数(失敗時は null)
 */
export async function importPptxFiles(
  dispatcher: Dispatcher,
  deps: MarkdownImportDeps,
  files: readonly File[],
): Promise<number | null> {
  const fail = (msg: string): null => {
    dispatcher.dispatch({ type: 'OP_FAILED', error: msg });
    return null;
  };
  const state = dispatcher.getState();
  // ⚠ 門は md / vCard 経路と同じ(§7)
  if (hasUnsavedTyping(state)) {
    return fail(
      state.phase === 'editing'
        ? `${phaseBlockReason(state.phase)}取り込んでください`
        : SECTION_DRAFT_NOTE,
    );
  }
  if (state.phase !== 'ready') {
    return fail(`${phaseBlockReason(state.phase)}取り込んでください`);
  }
  if (files.length === 0) return fail('取り込むファイルがありません');

  const rows: EntryUpsert[] = [];
  const notes: string[] = [];
  let dropped = 0;
  try {
    let order = deps.orderBase();
    for (const file of files) {
      let dir;
      try {
        dir = await readZipDirectory(file);
      } catch (e) {
        if (e instanceof ZipReadError) {
          return fail(
            `${file.name} を読めませんでした(PowerPoint のファイルではないか、中身を読み込めません。ノートは 1 件も追加されていません)`,
          );
        }
        throw e;
      }
      const byName = new Map(dir.map((d) => [d.name, d]));
      const slideNames = pptxSlideNames(dir.map((d) => d.name));
      if (slideNames.length === 0) {
        return fail(
          `${file.name} は PowerPoint のファイルではありません(スライドが見つかりません。ノートは 1 件も追加されていません)`,
        );
      }
      const used = slideNames.slice(0, SLIDES_MAX);
      dropped += slideNames.length - used.length;
      let n = 0;
      for (const name of used) {
        n += 1;
        const entry = byName.get(name)!;
        if (entry.uncompressedSize > SLIDE_XML_MAX) {
          dropped += 1;
          continue;
        }
        let slide;
        try {
          slide = readPptxSlide(await readZipText(file, entry));
        } catch (e) {
          if (e instanceof ZipReadError) throw e;
          // ⚠ 1 枚が読めないだけなら、その 1 枚を件数に数えて先へ進む
          dropped += 1;
          continue;
        }
        dropped += slide.dropped;
        // 何も置けず題名も無いスライドはノートにしない(中身が無い)
        if (slide.placed === 0 && slide.title === null) continue;
        const title =
          slide.title ?? (slideNames.length === 1 ? baseName(file.name) : `${baseName(file.name)} ${n}`);
        const ext = extractMeta('text', slide.body);
        rows.push({
          lid: deps.genLid(),
          title,
          archetype: 'text',
          body: slide.body,
          entryOrder: ++order,
          status: ext.status,
          date: ext.date,
          archived: ext.archived,
        });
      }
    }
  } catch (e) {
    return fail(
      `PowerPoint を読めませんでした(ノートは 1 件も追加されていません): ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (rows.length === 0) {
    return fail('PowerPoint から取り込める図形が 1 つもありませんでした');
  }

  // 🔴 読んでいる間に編集が始まったかもしれない ── 書く直前に先頭の門をもう一度通す
  const again = dispatcher.getState();
  if (hasUnsavedTyping(again)) {
    return fail(
      again.phase === 'editing'
        ? `${phaseBlockReason(again.phase)}取り込んでください`
        : SECTION_DRAFT_NOTE,
    );
  }
  if (again.phase !== 'ready') {
    return fail(`${phaseBlockReason(again.phase)}取り込んでください`);
  }

  try {
    await deps.bulkUpsertEntries(rows);
  } catch (e) {
    await deps.reload().catch(() => {});
    return fail(`取り込みに失敗しました: ${e instanceof Error ? e.message : String(e)}`);
  }

  await deps.reload();
  const last = rows[rows.length - 1];
  if (last) deps.focus?.(last.lid);
  deps.imported?.(rows.map((r) => r.lid));
  if (dropped > 0) notes.push(`取り込めなかったものが ${dropped} 件ありました`);
  deps.report?.(notes);
  const head = `取り込み完了: 板 ${rows.length} 件`;
  deps.notify?.(dropped > 0 ? `${head}(取り込めなかったもの ${dropped} 件)` : head);
  return rows.length;
}
