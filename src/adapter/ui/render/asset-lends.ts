/**
 * 🔴 **IDB の絵を `<img>` に差して、寿命の終わりに返す**(#856 段②)。
 *
 * user 指示 2026-07-27(不可侵):
 * > ゼロコピー、生成とライフサイクル後の速やかな破棄を徹底してください
 *
 * ⚠ `URL.createObjectURL` は**返すまで bytes を握り続ける**ので、借りっぱなしにすると
 *   画面に無い絵がメモリに残る(`mermaid-hydrate.ts` が実測で
 *   「`createObjectURL` 5 回 / `revokeObjectURL` 0 回」を踏んでいる)。
 *
 * ## なぜ別の file なのか(⚠ 2 つ目の実装を作らないために)
 *
 * 🔴 同じ帳簿が **`DetailRenderer` の中にも在る**(`hydrateAssetRefs` / `pruneLends`)。
 * ⚠ あちらは**面ごとの寿命**(ノートを開き直すと捨てる)に強く結びついていて、
 *   そのまま持ち出すと本文の面の回帰を招く ── だから**ここへ切り出して、
 *   新しい面(アプリの一覧)から先に使う**。
 * 🔑 **本文の面をこちらへ寄せるのは別の仕事**として #880 に切ってある
 *   (⚠ 寄せるまでは 2 つ在る、と自覚して使う ── CLAUDE.md §7)。
 */

/**
 * 借りる口。⚠ **ここで定義し直さない** ── 同じ名前の型が `detail.ts` に既に在り、
 * `center.ts` / `captures.ts` が**そちら**を見ている(2 つ定義すると、片方だけ直した日に
 * 静かに割れる ── CLAUDE.md §7)。⚠ 型の import は実行時に消えるので、器の結びつきは
 * 増えない。🔑 置き場を寄せるのは #880 の仕事。
 */
import type { AssetLender } from './detail';

export type { AssetLender };

export interface Lend {
  /**
   * 何のための貸出か。
   *
   * ⚠ **`null` は「鍵で探さない」**(#880 で本文の面から寄せた形)── 添付の下見のように
   *   **器そのものの寿命に乗る**貸出は、使い回す相手が居ないので鍵を持たない。
   */
  readonly key: string | null;
  /** 差してある URL。⚠ 鍵を持たない貸出は `null`(差す先を自分で持たない)。 */
  readonly url: string | null;
  readonly dispose: () => void;
  /** この貸出が生きている根拠の要素。⚠ **1 つも画面に残っていなければ返す**。 */
  els: Element[];
}

/** 画面に出ていない要素を指す貸出を返す。 */
export class AssetLends {
  private lends: Lend[] = [];
  /** ⚠ 組み直すたびに進める ── 飛んでいる借用が**古い DOM** に差すのを止める。 */
  private token = 0;

  /**
   * 🔴 **借りた物を帳簿へ載せる**(#880)。
   *
   * ⚠ 呼ぶ側が `dispose` を自分で握らない ── 握ると「返す所」が 2 つになり、
   *   片方が返し忘れた日に**bytes が常駐する**(2026-07-27 の不可侵指示)。
   */
  track(lend: Lend): void {
    this.lends.push(lend);
  }

  /**
   * 🔴 **生きている貸出を鍵で探す**(#880)。
   *
   * ⚠ 「生きている」は**画面に 1 つでも残っている**こと ── 1 つも残っていない貸出を
   *   使い回すと、`prune` が返した後の URL を差すことになる。
   * ⚠ 鍵を持たない貸出(`key: null`)は**探さない**(使い回す相手が居ない)。
   */
  live(key: string): Lend | null {
    return (
      this.lends.find(
        (l) => l.key === key && l.url !== null && l.els.some((e) => e.isConnected),
      ) ?? null
    );
  }

  /**
   * 🔴 **`img[data-pkc-asset-key]` を全部埋める。**
   *
   * ⚠ 呼ぶのは**器を組み直した直後**だけ(指紋で早期 return する面では、
   *   組み直さなかった回に呼ぶと、同じ絵をもう一度借りることになる)。
   */
  async hydrate(root: ParentNode, lender: AssetLender): Promise<void> {
    this.token += 1;
    const token = this.token;
    this.prune();

    const byKey = new Map<string, HTMLImageElement[]>();
    for (const img of root.querySelectorAll<HTMLImageElement>('img[data-pkc-asset-key]')) {
      const key = img.getAttribute('data-pkc-asset-key') ?? '';
      if (key === '') continue;
      const got = byKey.get(key);
      if (got) got.push(img);
      else byKey.set(key, [img]);
    }
    if (byKey.size === 0) return;

    /**
     * 🔴 **生きている貸出を使い回す**(`DetailRenderer` が 2026-08-18 に学んだ形)。
     * ⚠ 使い回した `<img>` を**その貸出の `els` に足す**のが要である ── 足さないと、
     *   古い `<img>` が消えた時点で `prune` が返してしまい、
     *   **画面に出ている新しい `<img>` の src が死ぬ**。
     */
    for (const [key, imgs] of [...byKey]) {
      const live = this.live(key);
      if (!live || live.url === null) continue;
      live.els.push(...imgs);
      for (const img of imgs) img.src = live.url;
      byKey.delete(key);
    }
    if (byKey.size === 0) return;

    await Promise.all(
      [...byKey].map(async ([key, imgs]) => {
        let lent: { url: string; dispose: () => void } | null;
        try {
          lent = await lender.lend(key);
        } catch {
          // ⚠ **黙って捨てない** ── 下で「絵が無い」の印を残す道へ落とす
          lent = null;
        }
        if (token !== this.token) {
          // ⚠ 借りた瞬間に返す ── この DOM はもう画面に無い
          lent?.dispose();
          return;
        }
        if (lent === null) {
          // ⚠ **黙って空にしない** ── 出す側が「絵が無い」と分かる印を残す
          for (const img of imgs) img.setAttribute('data-pkc-asset-missing', '');
          return;
        }
        this.track({ key, url: lent.url, dispose: lent.dispose, els: imgs });
        for (const img of imgs) img.src = lent.url;
      }),
    );
  }

  /** 画面から消えた要素だけを指す貸出を返す。 */
  prune(): void {
    const keep: Lend[] = [];
    for (const l of this.lends) {
      l.els = l.els.filter((e) => e.isConnected);
      if (l.els.length > 0) keep.push(l);
      else l.dispose();
    }
    this.lends = keep;
  }

  /** 🔴 面を畳むとき / 器ごと捨てるときに**全部返す**。 */
  disposeAll(): void {
    for (const l of this.lends) l.dispose();
    this.lends = [];
    // ⚠ 進めておく ── 飛んでいる借用が、返した後に差し直すのを止める
    this.token += 1;
  }

  /** ⚠ test の観測点(いま何本借りているか)。 */
  get size(): number {
    return this.lends.length;
  }
}
