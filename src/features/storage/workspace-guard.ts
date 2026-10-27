/**
 * 🔴 **複数のワークスペースが居るとき、全部を消す操作を断る**(#1455)。
 *
 * 「作り直す」「初期化する」は DB のファイルごと捨てる ── 使っている 1 つのつもりで、ほかのワークスペースまで消える。
 * 断る場所は 2 つ:
 * ① **入口**(`resetContainer` / `rebuildContainer` の最初)── 添付の実体(IndexedDB)を**消す前**に断る。
 *    ⚠ 直す前は worker の `wipeStorage` だけが断っており、そこへ着く前に**添付の実体が先に消えていた**
 *    (「初期化」は添付 → DB の順)。断ったのに添付だけ失っている形になる。
 * ② **worker の `wipeStorage`**(最後の砦)。
 *
 * 🔑 断り文はここ 1 か所(3 つの場所が同じ字を言う)。
 */
export const WORKSPACES_REMAIN_MESSAGE =
  '複数のワークスペースがあるため、全部を消す操作はできません(「ワークスペース」で、ほかのワークスペースを先に削除してください)';

/**
 * 入口の門。`count` が数えられなかった(壊れた DB など)ときは断らない ── 壊れを直す道を塞がない。
 * @param count ワークスペースの数を返す口(失敗しうる)
 */
export async function refuseWhenWorkspacesRemain(count: () => Promise<number>): Promise<void> {
  let n: number;
  try {
    n = await count();
  } catch {
    return;
  }
  if (n > 1) throw new Error(WORKSPACES_REMAIN_MESSAGE);
}
