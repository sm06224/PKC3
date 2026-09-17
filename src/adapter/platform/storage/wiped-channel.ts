/**
 * 🔴 **「この入れ物は捨てた」を、他のタブへ伝える**(#986 段③)。
 *
 * ## なぜ要るのか
 *
 * 入れ物を捨てるのは **file の層**(`wipeStorage`)なので、
 * ⚠ **他のタブは何も知らないまま、捨てる前の一覧を画面に持ち続ける**。
 * 🔴 そのタブで 1 文字でも書くと、**消したはずのノートが 1 件だけ蘇る**
 * (書込は holder が受けるので、捨てた後の新しい DB へ INSERT される)。
 * ⚠ これは「いちばん気づけない壊れ方」である ── user は捨てたつもりでいる。
 *
 * ## 🔑 なぜ `store-proxy` の放送路に相乗りしないのか
 *
 * あちらが運ぶのは「**どの行が変わったか**」で、受け手は**一覧を描き直す**。
 * ここで要るのは「**この入れ物はもう無い**」という別の主張で、受け手がするのは
 * **読み込み直し**である ── 同じ路に別の意味を足すと、
 * `MUTATING_OPS` の表と `changedLids` の表が**この件について嘘をつく**ことになる。
 *
 * ## ⚠ 封筒を組む口は 1 つだけにする(#195 の教訓)
 *
 * 送る側と受ける側が**それぞれ手で封筒を組む**と、綴りが食い違っても
 * **両側の test が緑のまま**通る(受け側は黙って捨てるので 1 バイトも届かない)。
 * 🔑 だから `wipedMessage()` を通してしか組めない形にし、
 *   **実物どうしを繋ぐ test**(fake hub の両端に本物を置く)を 1 本持つ。
 */

/** 放送路の名前。⚠ 可搬単一 HTML では**バンドルごとに切る**(呼び側が接尾辞を付ける)。 */
export const WIPED_CHANNEL = 'pkc3-container-wiped';

/** `BroadcastChannel` の最小面(test では fake hub を差す)。 */
export interface WipedChannelPort {
  postMessage(data: unknown): void;
  onmessage: ((ev: MessageEvent) => void) | null;
  close?(): void;
}

/** 走る封筒。⚠ **`tag` を必ず見る** ── 同名の路に別の物が流れても掴まない。 */
export interface WipedWire {
  readonly tag: 'pkc3-wiped';
  readonly from: string;
  readonly cid: string;
}

/** 封筒を組む唯一の口。⚠ 手で `{ tag: … }` と書かない(上の節)。 */
export function wipedMessage(from: string, cid: string): WipedWire {
  return { tag: 'pkc3-wiped', from, cid };
}

/** 受け取った物が、こちら宛ての「捨てた」便りか。⚠ **自分の分は数えない**。 */
export function readWiped(data: unknown, self: string): string | null {
  if (typeof data !== 'object' || data === null) return null;
  const m = data as Partial<WipedWire>;
  if (m.tag !== 'pkc3-wiped') return null;
  if (typeof m.from !== 'string' || typeof m.cid !== 'string') return null;
  if (m.from === self) return null;
  return m.cid;
}

export interface WipedChannel {
  /** 捨てた、と伝える。⚠ 路が無い箱では**何もしない**(壊れる方向へ倒れない)。 */
  announce(cid: string): void;
}

/**
 * 放送路に繋ぐ。
 *
 * @param opts.channel 路(`null` = この箱には無い ── 古いブラウザ / test)
 * @param opts.id このタブの名乗り(自分の便りを拾わないため)
 * @param opts.onWiped 他のタブが捨てた ── ⚠ **呼び側が読み込み直す**
 *   (ここで `location.reload()` を呼ぶと、test がこの module を 1 度も
 *   最後まで走らせられない ── `container-reset.ts` と同じ理由)
 */
export function connectWipedChannel(opts: {
  readonly channel: WipedChannelPort | null;
  readonly id: string;
  readonly onWiped: (cid: string) => void;
}): WipedChannel {
  const { channel, id, onWiped } = opts;
  if (channel !== null) {
    channel.onmessage = (ev: MessageEvent) => {
      const cid = readWiped(ev.data, id);
      if (cid !== null) onWiped(cid);
    };
  }
  return {
    announce(cid: string): void {
      channel?.postMessage(wipedMessage(id, cid));
    },
  };
}
