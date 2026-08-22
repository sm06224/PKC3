/**
 * 🔴 **取込の衝突検査に渡す「既に使われている lid」を組む**(#328、2026-08-22)。
 *
 * ## なぜ独立した file なのか
 *
 * ⚠ この判定は `main.ts` に直書きされていた ── そこは
 * **原文を `readFileSync` で読む test しか無い層**である(CLAUDE.md
 * 「どの test からも実行されない file に、判断を書かない」)。
 * だから **state が遅れたら上書きになる**という性質を、誰も見ていなかった。
 *
 * ## 何が起きていたか
 *
 * 直す前は entry の lid を `dispatcher.getState().entryMetas` から取っていた。
 * ⚠ `entryMetas` は **DB の射影であって DB ではない** ── 他タブの書込が
 * `store-proxy` の `'changed'` 放送で届くまで遅れる。その窓の中で取り込むと:
 *
 * 1. 衝突検査が既存 lid を**見落とす**
 * 2. 取り込んだ entry が**元の lid のまま** `bulkUpsertEntries` へ行く
 *    (`pkc2-convert.ts` の `taken` が再採番の唯一の門)
 * 3. **既存が上書きされる。警告は出ず、件数が増えないだけ**
 *
 * ⚠ 再現にタイミング運は要らない ──
 * 「タブ A で取り込む → タブ B へ移る → B で同じファイルを取り込む」で窓に入る。
 *
 * 🔑 revision 側は**同じ理由で既に DB へ寄せてあった**(ゴミ箱の lid と衝突すると
 * その item がゴミ箱から消え、取り込んだ entry が他人の履歴を背負う ──
 * review H-1 が実 sqlite で実証)。**entry 側だけ state に残っていた**
 * (CLAUDE.md §7「片側を直したら、対称の反対側を必ず疑う」)。
 *
 * ## 規律
 *
 * 🔑 **和集合にする。** 3 つの出所(state / DB の entry / DB の revision)を足すので、
 * どれかが遅れても**安全側にしか動かない** ── lid が増える = 再採番が増えるだけで、
 * 上書きは減る。⚠ 逆に「DB だけを見る」に**しない** ── state にしか居ない
 * (書込 ack がまだ返っていない)lid を落とすと、今度はそちらを上書きする。
 */

/** DB から引ける lid の口。⚠ 呼び側(`main.ts`)が store client を包んで渡す。 */
export interface LidSources {
  /** state が持っている lid(射影。**遅れることがある**)。 */
  readonly fromState: () => Iterable<string>;
  /** DB の entry の lid。 */
  readonly entryLids: () => Promise<readonly string[]>;
  /**
   * DB の revision の lid。⚠ **生存 entry だけでは足りない** ── ゴミ箱の lid
   * (entries に居ないが revisions を持つ)と衝突すると、その item がゴミ箱から
   * 消え、取り込んだ entry が他人の履歴を背負う(review H-1)。
   */
  readonly revisionLids: () => Promise<readonly string[]>;
}

/**
 * 3 つの出所の**和集合**を返す。
 *
 * ⚠ 2 本の DB 問い合わせは**並行**に投げる(取込は user を待たせる操作なので、
 * 直列にすると往復が 2 倍になる)。
 */
export async function collectExistingLids(src: LidSources): Promise<Set<string>> {
  const [entryLids, revisionLids] = await Promise.all([src.entryLids(), src.revisionLids()]);
  return new Set<string>([...src.fromState(), ...entryLids, ...revisionLids]);
}
