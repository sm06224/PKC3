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
import { failImport } from './import-failure';
import { errorText } from '@features/error-text';
import type { Dispatcher } from '@adapter/state/dispatcher';
import { phaseBlockReason, hasUnsavedTyping, SECTION_DRAFT_NOTE } from '@adapter/state/app-state';
import type { EntryUpsert } from '@adapter/platform/storage/schema';
import { readPlainMarkdown, stampOfFileTime } from '@features/import/plain-markdown';
import { extractMeta } from '@features/flavor';
import { IMPORT_TEXT_MAX_BYTES, readImportTextInfo, SJIS_GUESS_NOTE } from '@features/import/text-decode';
import { humanBytes } from '@features/human-bytes';
import { duplicateNote, findDuplicates, narrowByLength } from '@features/import/duplicate-scan';
import { isOperationCancelled, type CancelToken } from '@features/job-cancel';
import { IMPORT_CANCELLED_NOTE, importDoneNote } from './job-control';

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
  /** 🔴 失敗の理由を「取り込み時の注意」の面へ(`import-failure.ts`)。 */
  reportFailure?(message: string): void;
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
  /** 🔴 既に在るノートの頭(#1087。PKC2 経路と同じ。省略可 ── 無い配線では重なりを数えないだけ)。 */
  existingHeads?(): readonly { lid: string; bodyChars: number | null }[];
  /** 🔴 絞った lid の本文だけ読む(#1087。省略可)。 */
  readBodies?(lids: readonly string[]): Promise<ReadonlyMap<string, string>>;
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
  /** 🔴 やめる印(台帳 #1852 の F2・依頼 253)。省略 = やめられない(従来どおり)。区切り(ファイル 1 本ごと・書く直前)で見る。 */
  token?: CancelToken,
): Promise<number | null> {
  const fail = (msg: string): null => {
    return failImport(dispatcher, deps, msg);
  };
  /**
   * 🔴 **章の欄が開いている間も断る**(#1044 段2 3巡目の修理、S3)。
   * ⚠ 章の欄は `phase` を `ready` のまま保つ(設計 doc §3)ので、
   *   `phase !== 'ready'` だけでは素通りする ── `binder.ts` の `routeFiles`
   *   (drop の振り分け)と**同じ判定**(`hasUnsavedTyping`)に揃える(§7)。
   *   この口は file picker(`import-input` の `change`)からも直に呼ばれるので、
   *   binder 側の振り分けを迂回しても、ここが最後の門になる。
   */
  const gate = (): string | null => {
    const state = dispatcher.getState();
    if (hasUnsavedTyping(state)) {
      return state.phase === 'editing'
        ? `${phaseBlockReason(state.phase)}取り込んでください`
        : SECTION_DRAFT_NOTE;
    }
    // ⚠ `hasUnsavedTyping` は `editing` を既に拾っている ── ここで残るのは
    //   `initializing` / `error`(読み込み中・保存に失敗して止まっている)
    if (state.phase !== 'ready') return `${phaseBlockReason(state.phase)}取り込んでください`;
    return null;
  };
  /** 🔴 読む段でやめた ── まだ 1 件も書いていないので、戻す物は無い。 */
  const cancelled = (): null => {
    deps.notify?.(IMPORT_CANCELLED_NOTE);
    return null;
  };
  const blocked = gate();
  if (blocked !== null) return fail(blocked);
  if (files.length === 0) return fail('取り込むファイルがありません');

  const notes: string[] = [];
  const rows: EntryUpsert[] = [];
  try {
    let order = deps.orderBase();
    for (const file of files) {
      token?.throwIfCancelled();
      // 🔴 読む前に大きさで断る(ics と同じ形。#1087)── 手違いの巨大な file を全部文字列にしない
      if (file.size > IMPORT_TEXT_MAX_BYTES) {
        return fail(
          `「${file.name}」は大きすぎて取り込めません(${humanBytes(IMPORT_TEXT_MAX_BYTES)} まで。ノートは 1 件も追加されていません)`,
        );
      }
      const read = await readImportTextInfo(file);
      const parsed = readPlainMarkdown(read.text, file.name);
      if (read.used === 'sjis') notes.push(`「${file.name}」: ${SJIS_GUESS_NOTE}`);
      // 注意は**どのファイルのものか**を言う ── 複数選択で「参照 3 件」とだけ
      // 出ても、どれを直せばいいのか分からない
      for (const w of parsed.warnings) notes.push(`「${file.name}」: ${w}`);
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
        // 🔴 file の更新日時を、ノートの更新日として引き継ぐ(依頼 176)。作成日は「いま」のまま(file に作成日は無い)
        updatedAt: stampOfFileTime(file.lastModified, Date.now()),
      });
    }
  } catch (e) {
    if (isOperationCancelled(e)) return cancelled();
    // 読めた分を書かずに終える ── 部分的に書くと「どこまで入ったか」が
    // user に分からないまま disk に残る(PKC2 経路は書込中の失敗なので事情が違う)
    return fail(
      `Markdown を読めませんでした(ノートは 1 件も追加されていません): ${errorText(e)}`,
    );
  }

  /**
   * 🔴 **同じ .md を 2 回取り込んだことに気づけるようにする**(#1087。PKC2 経路の #399 ② と同じ検出・同じ文)。
   * ⚠ **取り込みは止めない** ── 言うだけ。数えられなくても取り込みは続ける。
   */
  if (deps.existingHeads !== undefined && deps.readBodies !== undefined) {
    try {
      const incoming = rows.map((r) => ({ lid: r.lid, title: r.title, body: r.body }));
      const lids = narrowByLength(incoming, deps.existingHeads());
      if (lids.length > 0) {
        const note = duplicateNote(findDuplicates(incoming, await deps.readBodies(lids)));
        if (note !== null) notes.push(note);
      }
    } catch {
      // ⚠ 数えられなかっただけ ── 取り込みを止める理由にはならない
    }
  }

  /**
   * 🔴 **読んでいる間に編集が始まったかもしれない ── 書く直前に門をもう一度通す**(#1087。ics / pptx と同じ)。
   * ⚠ 直す前は書いてから反映を先送りし、「編集を終了すると反映されます」と「取り込み完了」が並んでいた。
   */
  const again = gate();
  if (again !== null) return fail(again);
  // 🔴 書く直前がやめられる最後の区切り(書き込みは 1 回で、途中で割り込まない ── 半端なノートを作らない)
  if (token?.cancelled === true) return cancelled();

  try {
    await deps.bulkUpsertEntries(rows);
  } catch (e) {
    await deps.reload().catch(() => {});
    return fail(
      `取り込みに失敗しました: ${errorText(e)}`,
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
    importDoneNote(
      token,
      rows.length,
      notes.length > 0 ? `取り込み完了: ${rows.length} 件(注意 ${notes.length} 件)` : `取り込み完了: ${rows.length} 件`,
    ),
  );
  return rows.length;
}
