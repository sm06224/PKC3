/**
 * 🔴 **バックアップの色ラベルを、いまのコレクションへ戻す**(#1982 段 4。`importNotePinsInto` の対)。
 *
 * - いま色が付いているノートは動かさず、付いていないノートの分だけ足す(user の今の選び方を上書きしない)。
 * - いま一覧に無い lid(別のコレクションの物・消えたノート)は見送る。
 */
export interface NoteLabelImportDeps {
  /** いま色が付いているノートの lid(正本)。 */
  listLids(): Promise<readonly string[]>;
  /** 1 件付ける(失敗は throw)。 */
  put(lid: string, color: number): Promise<void>;
  /** その lid のノートが、いま一覧に在るか。 */
  exists(lid: string): boolean;
}

export async function importNoteLabelsInto(
  incoming: ReadonlyArray<{ lid: string; color: number }>,
  deps: NoteLabelImportDeps,
): Promise<{ added: number }> {
  const now = new Set(await deps.listLids());
  let added = 0;
  for (const e of incoming) {
    if (now.has(e.lid) || !deps.exists(e.lid)) continue;
    await deps.put(e.lid, e.color);
    now.add(e.lid);
    added += 1;
  }
  return { added };
}
