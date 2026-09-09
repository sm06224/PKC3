/**
 * 🔴 **保存先が取れなかったときに、少し待ってもう一度試す**(#811 の 3 番目)。
 *
 * ## なぜ要るか(実測で分かったこと)
 *
 * `initStorage` の再試行は **`promoted` が真のときだけ**通っていた ── ところが
 * 呼ばれ方は 2 通りで、**いちばん多い形が再試行を 1 度も通っていなかった**:
 *
 * | 呼び方 | 再試行 |
 * |---|---|
 * | すぐ lease が取れたタブ(= 1 枚だけ開いている普通の形) | 🔴 **通らない** |
 * | 待ってから本体になったタブ(昇格) | 通る |
 *
 * ⚠ user の iPhone の報告はおそらく前者である(タブ 1 枚)。つまりあの画面は
 * **1 度も試し直さずに `memory` へ落ちたまま**動いていた ── そして `memory` は
 * 「書いたものが OPFS へ 1 バイトも届かない」形である(`storage-worker.ts` の注記)。
 *
 * 🔑 **再試行が効く理由**:直前に閉じたタブの SAH 解放は lock の解放より**遅れる**
 * ので、200ms 待つだけで普通に開けることがある(元の注記が昇格 boot について
 * 書いていたのと同じ現象で、⚠ 昇格に限った話ではなかった)。
 *
 * ## ⚠ それでも駄目なら、**開く**(止めない)
 *
 * 🔴 止める(= 開かない)側も検討したが、**iPhone で締め出しになりうる** ──
 * 端末側の事情(プライベートブラウズなど)で OPFS が取れないとき、止めると
 * **いま在るノートを読むこともできない**。⚠ 消えるのは「これから書くもの」だけで、
 * 既に在るものは消えていないので、読ませない理由が弱い。
 * 🔑 代わりに**画面が言う** ── 帯の 1 行とヘルプの「保存先」で、
 * 「閉じると消えます」が**指で触る端末でも読める**形になっている(#811 の 1 と 2)。
 *
 * ## ⚠ ここに置く理由
 *
 * `main.ts` は**どの test からも実行されない**(CLAUDE.md §2)。だから
 * **待つ回数も、諦め方も**この module が持ち、`main.ts` は**呼ぶだけ**にする。
 */

/**
 * 🔴 **待つ間隔**(ms)。⚠ 合計 1.7 秒 ── 「開くのが少し遅くなる」で収まる範囲にする。
 * ⚠ 伸ばすと、**取れない端末**(プライベートブラウズなど)で毎回その分待たされる
 *   ── そちらは待っても取れないので、長くしても損しかしない。
 */
export const STORAGE_RETRY_DELAYS_MS = [200, 500, 1000] as const;

/** 開いた結果の最小面(`vfs` だけ見る ── ほかは呼び側の型のまま通す)。 */
interface OpenedLike {
  readonly vfs: string;
}

export interface OpenWithRetryDeps<C, I extends OpenedLike> {
  /** 保存先を開く(1 回ぶん)。⚠ **毎回新しい worker で**開くこと ── 失敗は
   *  worker の中で名前ごとに憶えられるので、同じ worker で試し直しても同じ答えになる。 */
  open(): Promise<{ client: C; init: I }>;
  /** 捨てる側の後始末。⚠ **必ず呼ぶ** ── 呼ばないと worker が積み上がる。 */
  close(client: C): void;
  wait(ms: number): Promise<void>;
  /**
   * 🔴 **試し直してよいか**。⚠ 持ち歩ける 1 枚の HTML は**選んで** `memory` で動くので、
   *   ここを `false` にする ── 入れると**必ず 3 回待たされてから同じ答え**になる。
   */
  retryable: boolean;
  /** 差し替え用(既定は `STORAGE_RETRY_DELAYS_MS`)。 */
  delays?: readonly number[];
}

/**
 * 保存先を開く。`memory` へ落ちた回は、少し待って開き直す。
 *
 * ⚠ **投げない** ── 最後まで駄目でも、最後に開いたものをそのまま返す
 *   (画面が「閉じると消えます」と言う。上の注記)。
 * @returns `tries` = 実際に開いた回数(1 = 一発で取れた)。⚠ 診断のために返す。
 */
export async function openStorageWithRetry<C, I extends OpenedLike>(
  deps: OpenWithRetryDeps<C, I>,
): Promise<{ client: C; init: I; tries: number }> {
  let { client, init } = await deps.open();
  let tries = 1;
  if (!deps.retryable || init.vfs !== 'memory') return { client, init, tries };
  for (const delayMs of deps.delays ?? STORAGE_RETRY_DELAYS_MS) {
    // ⚠ **先に捨ててから待つ** ── 掴んだままだと、自分が次の試行の邪魔をする
    deps.close(client);
    await deps.wait(delayMs);
    const next = await deps.open();
    client = next.client;
    init = next.init;
    tries += 1;
    if (init.vfs !== 'memory') break;
  }
  return { client, init, tries };
}
