/**
 * P7 段②: 素の `.md` の取込(実行部)。設計 doc §1。
 *
 * 🔑 **PKC2 経路と合流させない**。あちらは container を変換し、asset / relation /
 * 履歴まで面倒を見る。こちらは **1 ファイル = 1 entry** で、それ以外は何もしない
 * ── 混ぜると「どっちの経路で壊れたか」が分からなくなる(裁定 §5-4)。
 *
 * ⚠ 本文は**原文のまま**書く。`readPlainMarkdown` は題名と archetype を読むために
 * frontmatter を parse するが、body には手を触れない(P6d 段④ の規律)。
 */
import type { Dispatcher } from '@adapter/state/dispatcher';
import type { EntryUpsert } from '@adapter/platform/storage/schema';
import { readPlainMarkdown } from '@features/import/plain-markdown';
import { extractMeta } from '@features/flavor';

/**
 * ⚠ `ImportDeps`(PKC2 経路)の**部分集合**として書く ── 呼び出し側が
 * 2 つの deps を組み立てずに済む。ここで要らないもの(asset / relation / 履歴)を
 * 要求しないこと自体が「この経路は何もしない」という宣言になる。
 */
export interface MarkdownImportDeps {
  /** 既存 entryOrder の最大値。 */
  orderBase(): number;
  genLid(): string;
  bulkUpsertEntries(entries: EntryUpsert[]): Promise<void>;
  /** 取込後の再読込(boot と同じ経路で state を作り直す)。 */
  reload(): Promise<void>;
  notify?(message: string): void;
  /** **注意の全件**を渡す(1 行の status には埋もれる)。 */
  report?(notes: readonly string[]): void;
}

/**
 * md ファイルを 1 件ずつ entry にする。**失敗は必ず可視**(OP_FAILED)で終える。
 *
 * @returns 取り込んだ entry 数(失敗時は null)
 */
export async function importMarkdownFiles(
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
      const parsed = readPlainMarkdown(await file.text(), file.name);
      // 注意は**どのファイルのものか**を言う ── 複数選択で「参照 3 件」とだけ
      // 出ても、どれを直せばいいのか分からない
      for (const w of parsed.warnings) notes.push(`${file.name}: ${w}`);
      const ext = extractMeta(parsed.archetype, parsed.body);
      rows.push({
        lid: deps.genLid(),
        title: parsed.title,
        archetype: parsed.archetype,
        body: parsed.body,
        entryOrder: ++order,
        status: ext.status,
        date: ext.date,
        archived: ext.archived,
      });
    }
  } catch (e) {
    // 読めた分を書かずに終える ── 部分的に書くと「どこまで入ったか」が
    // user に分からないまま disk に残る(PKC2 経路は書込中の失敗なので事情が違う)
    return fail(
      `Markdown を読めませんでした(書込は行われていません): ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  try {
    await deps.bulkUpsertEntries(rows);
  } catch (e) {
    await deps.reload().catch(() => {});
    return fail(
      `取込に失敗しました: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  await deps.reload();
  deps.report?.(notes);
  deps.notify?.(
    notes.length > 0
      ? `取込完了: ${rows.length} 件 ⚠ 注意 ${notes.length} 件`
      : `取込完了: ${rows.length} 件`,
  );
  return rows.length;
}
