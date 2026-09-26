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
import { phaseBlockReason, hasUnsavedTyping, SECTION_DRAFT_NOTE } from '@adapter/state/app-state';
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
  /**
   * 🔴 **取り込んだノートを画面に出す**(2026-08-05、user 報告
   * 「開いたら何も起きずに終わる」)。
   *
   * 直す前はここが無く、`reload()` して件数を出すだけだった ── 新しい entry は
   * 一覧の**末尾**に足されるので、蔵書が数十件あると**画面の外**に居る。
   * user から見ると「開いたのに何も起きない」で、唯一の反応が
   * 左下 12px の「取込完了: 1 件」だった(実測)。
   */
  focus?(lid: string): void;
  /**
   * 🔴 **どのファイルがどの lid になったか**(2026-08-05、user 報告
   * 「スポットの編集プレビュー導線も存在しない」)。⚠ 順序は **`files` と同じ**。
   *
   * 受け口(`launchQueue`)は `FileSystemFileHandle` を持っているが、取込の規則は
   * それを知る必要が無い ── だから handle を通さず「**何番目が何になったか**」
   * だけを返す。紐づけは呼び出し側(`main.ts`)が持つ。
   */
  imported?(lids: readonly string[]): void;
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
  const state = dispatcher.getState();
  /**
   * 🔴 **章の欄が開いている間も断る**(#1044 段2 3巡目の修理、S3)。
   * ⚠ 章の欄は `phase` を `ready` のまま保つ(設計 doc §3)ので、
   *   `phase !== 'ready'` だけでは素通りする ── `binder.ts` の `routeFiles`
   *   (drop の振り分け)と**同じ判定**(`hasUnsavedTyping`)に揃える(§7)。
   *   この口は file picker(`import-input` の `change`)からも直に呼ばれるので、
   *   binder 側の振り分けを迂回しても、ここが最後の門になる。
   */
  if (hasUnsavedTyping(state)) {
    return fail(
      state.phase === 'editing'
        ? `${phaseBlockReason(state.phase)}取り込んでください`
        : SECTION_DRAFT_NOTE,
    );
  }
  // ⚠ `hasUnsavedTyping` は `editing` を既に拾っている ── ここで残るのは
  //   `initializing` / `error`(読み込み中・保存に失敗して止まっている)
  if (state.phase !== 'ready') {
    return fail(`${phaseBlockReason(state.phase)}取り込んでください`);
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
  // ⚠ **最後の 1 件**を開く。複数選んだときに 1 件目を開くと、user が最後に
  //    指した物と食い違う(picker の並びと OS の launch の並びは同じ)
  const last = rows[rows.length - 1];
  if (last) deps.focus?.(last.lid);
  deps.imported?.(rows.map((r) => r.lid));
  deps.report?.(notes);
  deps.notify?.(
    notes.length > 0
      ? `取込完了: ${rows.length} 件 ⚠ 注意 ${notes.length} 件`
      : `取込完了: ${rows.length} 件`,
  );
  return rows.length;
}
