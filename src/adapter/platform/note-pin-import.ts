/**
 * 🔴 **バックアップのピン留めを、いまのコレクションへ戻す**(#1377)。
 *
 * - いま留めている物は動かさず、足りない分だけ足す。生きているピン(いま一覧に在るノート)が上限 `limit` に達したら見送る。
 * - 足した lid を返す ── 取り込みの取り消しが「足したピン」だけを外す(前から在った物は触らない)。
 */
export interface NotePinImportDeps {
  /** いまのピン(正本)。 */
  list(): Promise<readonly string[]>;
  /** 1 件留める(失敗は throw)。 */
  put(lid: string): Promise<void>;
  /** その lid のノートが、いま一覧に在るか。 */
  exists(lid: string): boolean;
  /** 生きているピンの上限。 */
  limit: number;
}

export async function importNotePinsInto(
  lids: readonly string[],
  deps: NotePinImportDeps,
): Promise<{ added: number; overLimit: number; addedLids: string[] }> {
  const now = await deps.list();
  let live = now.filter((l) => deps.exists(l)).length;
  const addedLids: string[] = [];
  let overLimit = 0;
  for (const lid of lids) {
    if (now.includes(lid) || addedLids.includes(lid)) continue;
    if (live >= deps.limit) {
      overLimit += 1;
      continue;
    }
    await deps.put(lid);
    live += 1;
    addedLids.push(lid);
  }
  return { added: addedLids.length, overLimit, addedLids };
}
