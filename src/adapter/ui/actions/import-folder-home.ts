/**
 * 🔴 **取り込んだノートを、いま開いているフォルダの中へ入れる**(台帳 #1852 の束 F1、依頼 340。Gemini 裁定 = A)。
 *
 * user の物語: フォルダ「X」を開くと画面に「新しく作るものは「X」に入ります」と出る。なのに .md や連絡先を取り込むと、
 * 取り込んだノートはルートの末尾に入り、一覧の外に居る(「取り込んだのに無い」)。
 *
 * 🔑 **取り込みの道は 5 本ある**(Markdown / 連絡先 / 予定 / PowerPoint / PKC2・バックアップ)が、どれも最後は
 *   `bulkUpsertEntries` → `reload` を通る。ここで **deps を包む 1 か所**に寄せ、5 本の本体は 1 行も変えない(§7)。
 * ⚠ 入れ先は取り込みを**始めたとき**のフォルダに固定する(取り込みの最中に別のフォルダへ移っても、押した所に入る)。
 * ⚠ 入れるのは**根のノートだけ**。PKC2 の書き出しはフォルダの形(親子)を持つので、この取り込みの中で親を持つノートは
 *   そのまま(= PKC2 のフォルダの形は、開いているフォルダの中に作られる)。
 * ⚠ 入れ先が無い(ルート / スマートフォルダ / 消えたフォルダ)なら**何もしない**(これまでどおりルート)。
 * ⚠ 書けなかったときは黙らない ── ルートに入っていることを言う。
 */
import type { EntryUpsert } from '@adapter/platform/storage/schema';
import { STRUCTURAL } from '@features/relation/kinds';

/** 包む対象に要る口(`MarkdownImportDeps` / `ImportDeps` の共通部分)。 */
export interface FolderHomeDeps {
  bulkUpsertEntries(entries: EntryUpsert[]): Promise<void>;
  bulkUpsertRelations?(
    relations: Array<{ id: string; fromLid: string; toLid: string; kind: string }>,
  ): Promise<void>;
  reload(): Promise<void>;
  reportFailure?(message: string, undoable?: boolean): void;
}

/**
 * @param folderLid 取り込み先のフォルダ。`null` なら包まずそのまま返す
 * @param putRelations 辺の書き込み(`bulkUpsertRelations`)── 型の都合で別に受ける(md の deps には無い)
 */
export function withFolderHome<D extends FolderHomeDeps>(
  deps: D,
  folderLid: string | null,
  putRelations: (relations: Array<{ id: string; fromLid: string; toLid: string; kind: string }>) => Promise<void>,
  genRelationId: () => string,
): D {
  if (folderLid === null) return deps;
  const written: string[] = [];
  const children = new Set<string>();
  let flushed = false;
  const flush = async (): Promise<void> => {
    if (flushed) return;
    flushed = true;
    const roots = written.filter((lid) => lid !== folderLid && !children.has(lid));
    if (roots.length === 0) return;
    try {
      await putRelations(
        roots.map((lid) => ({ id: genRelationId(), fromLid: folderLid, toLid: lid, kind: STRUCTURAL })),
      );
    } catch (e) {
      deps.reportFailure?.(
        `取り込んだノートを開いているフォルダへ入れられませんでした(ルートに入っています): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  };
  return {
    ...deps,
    bulkUpsertEntries: async (entries: EntryUpsert[]) => {
      await deps.bulkUpsertEntries(entries);
      for (const e of entries) written.push(e.lid);
    },
    bulkUpsertRelations: async (relations) => {
      for (const r of relations) if (r.kind === STRUCTURAL) children.add(r.toLid);
      await (deps.bulkUpsertRelations ?? putRelations)(relations);
    },
    reload: async () => {
      await flush();
      await deps.reload();
    },
  } as D;
}
