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
import { errorText } from '@features/error-text';
import { markName } from '@features/message/message-log';
import type { Dispatcher } from '@adapter/state/dispatcher';
import { hasUnsavedTyping, phaseBlockReason, SECTION_DRAFT_NOTE } from '@adapter/state/app-state';
import type { EntryUpsert } from '@adapter/platform/storage/schema';
import { extractMeta } from '@features/flavor';
import { readPptxSlide, pptxSlideNamesInOrder } from '@features/import/pptx-board';
import { readZipDirectory, readZipText, ZipReadError } from '@features/import/zip-reader';
import type { MarkdownImportDeps } from './import-markdown';
import { failImport } from './import-failure';
import { isOperationCancelled, type CancelToken } from '@features/job-cancel';
import { IMPORT_CANCELLED_NOTE, importDoneNote } from './job-control';

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
  /** 🔴 やめる印(台帳 #1852 の F2・依頼 253)。省略 = やめられない。 */
  token?: CancelToken,
): Promise<number | null> {
  const fail = (msg: string): null => {
    return failImport(dispatcher, deps, msg);
  };
  /** 🔴 読む段でやめた ── まだ 1 件も書いていない。 */
  const cancelled = (): null => {
    deps.notify?.(IMPORT_CANCELLED_NOTE);
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
  /** {@link SLIDES_MAX} を超えて読まなかったスライド(図形の取り込めなかった数とは分けて言う) */
  let skippedSlides = 0;
  let rounded = 0;
  let simplified = 0;
  try {
    let order = deps.orderBase();
    for (const file of files) {
      token?.throwIfCancelled();
      let dir;
      try {
        dir = await readZipDirectory(file);
      } catch (e) {
        if (e instanceof ZipReadError) {
          return fail(
            `「${markName(file.name)}」を読めませんでした(PowerPoint のファイルではないか、中身を読み込めません。ノートは 1 件も追加されていません)`,
          );
        }
        throw e;
      }
      const byName = new Map(dir.map((d) => [d.name, d]));
      // 🔴 スライドの順番は `presentation.xml` が決める(読めなければ番号順)
      const partText = async (name: string): Promise<string | null> => {
        const d = byName.get(name);
        if (d === undefined || d.uncompressedSize > SLIDE_XML_MAX) return null;
        try {
          return await readZipText(file, d);
        } catch {
          return null;
        }
      };
      const slideNames = pptxSlideNamesInOrder(
        dir.map((d) => d.name),
        await partText('ppt/presentation.xml'),
        await partText('ppt/_rels/presentation.xml.rels'),
      );
      if (slideNames.length === 0) {
        return fail(
          `「${markName(file.name)}」は PowerPoint のファイルではありません(スライドが見つかりません。ノートは 1 件も追加されていません)`,
        );
      }
      const used = slideNames.slice(0, SLIDES_MAX);
      skippedSlides += slideNames.length - used.length;
      let n = 0;
      for (const name of used) {
        token?.throwIfCancelled(); // スライド 1 枚ごとも区切り
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
        rounded += slide.rounded;
        simplified += slide.simplified;
        // 何も置けず題名も無いスライドはノートにしない(中身が無い)
        if (slide.placed === 0 && slide.flowed === 0 && slide.title === null) continue;
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
    if (isOperationCancelled(e)) return cancelled();
    return fail(
      `PowerPoint を読めませんでした(ノートは 1 件も追加されていません): ${errorText(e)}`,
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

  if (token?.cancelled === true) return cancelled(); // 書く直前がやめられる最後の区切り

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
  if (dropped > 0) notes.push(`取り込めなかったものが ${dropped} 件ありました`);
  if (skippedSlides > 0) notes.push(`スライドが多いため、先頭の ${SLIDES_MAX} 枚だけ取り込みました(残り ${skippedSlides} 枚は取り込んでいません)`);
  // 🔴 文字の大きさを近い段へ丸めた付箋の数(#530 段⑤a)── 黙らない。丸めなかった付箋は数えない
  if (rounded > 0) notes.push(`文字の大きさを近い段(小 / 標準 / 大 / 特大)に丸めた付箋が ${rounded} 枚ありました`);
  // 🔴 入れ子のグループ(内側だけ残る)と反転(向きは失われる)を直した付箋の数(#530 段⑤c・⑤e)── 黙らない
  if (simplified > 0) notes.push(`入れ子のグループや反転を、近い形に直した付箋が ${simplified} 枚ありました`);
  deps.report?.(notes);
  const head = `取り込み完了: 板 ${rows.length} 件`;
  const tails = [
    ...(dropped > 0 ? [`取り込めなかったもの ${dropped} 件`] : []),
    ...(skippedSlides > 0 ? [`取り込まなかったスライド ${skippedSlides} 枚`] : []),
    ...(rounded > 0 ? [`文字の大きさを丸めた付箋 ${rounded} 枚`] : []),
    ...(simplified > 0 ? [`形を直した付箋 ${simplified} 枚`] : []),
  ];
  deps.notify?.(importDoneNote(token, rows.length, tails.length > 0 ? `${head}(${tails.join('、')})` : head));
  return rows.length;
}
