/**
 * 🔴 **メッセージの書込 / 既読を、他のタブへ伝える**(#1087)。
 *
 * ## なぜ要るのか
 *
 * - メッセージの書込(`appendMessage`)は、他のタブへの放送路(`store-proxy` の `NOT_BROADCAST`)に
 *   **わざと乗せていない**(処理の記録は 5000 件規模で、書くたびに全タブを読み直させないため)。
 *   だから別のタブで書かれた知らせは、**いま開いているメッセージの画面にも、未読の数にも届かなかった**。
 * - 既読の時刻(`READ_AT`)は localStorage にあるが、誰も `storage` event を聞いていなかった。
 *   別のタブで既読にしても、こちらのタブの未読の数は残ったままだった。
 *
 * ## 🔑 通信量を増やさない作り
 *
 * - 書込の合図は**まとめて 1 秒に 1 回まで**(最後に 1 回だけ送る。`MESSAGES_SYNC_MS`)。lid の集合だけを運び、
 *   本文は運ばない。処理の記録は 50 件 / 5 秒で束ねて書くので、元々その間隔より多くは来ない。
 * - **読み直すかは受け手が決める**(自分が開いている lid が含まれるときだけ読み直す。
 *   未読は「メッセージ」の lid が含まれるときだけ数え直す)。開いていないタブは何も読まない。
 * - ストアの放送路(`NOT_BROADCAST`)はそのまま ── 別の路を足しただけである。
 *
 * ## ⚠ 封筒を組む口は 1 つだけにする(`wiped-channel.ts` と同じ理由)
 */

/** 放送路の名前。⚠ 可搬単一 HTML では**バンドルごとに切る**(呼び側が接尾辞を付ける)。 */
export const MESSAGES_CHANNEL = 'pkc3-messages-changed';

/** まとめる間隔(ms)。⚠ これより密には送らない。 */
export const MESSAGES_SYNC_MS = 1000;

/** `BroadcastChannel` の最小面(test では fake hub を差す)。 */
export interface MessagesChannelPort {
  postMessage(data: unknown): void;
  onmessage: ((ev: MessageEvent) => void) | null;
  close?(): void;
}

/** 走る封筒。⚠ **`tag` を必ず見る** ── 同名の路に別の物が流れても掴まない。 */
export interface MessagesWire {
  readonly tag: 'pkc3-messages';
  readonly from: string;
  readonly lids: readonly string[];
}

/** 封筒を組む唯一の口。 */
export function messagesMessage(from: string, lids: readonly string[]): MessagesWire {
  return { tag: 'pkc3-messages', from, lids };
}

/** 受け取った物が、他のタブの書込の便りなら lid の一覧。⚠ **自分の分は数えない**。 */
export function readMessages(data: unknown, self: string): string[] | null {
  if (typeof data !== 'object' || data === null) return null;
  const m = data as Partial<MessagesWire>;
  if (m.tag !== 'pkc3-messages') return null;
  if (typeof m.from !== 'string' || !Array.isArray(m.lids)) return null;
  if (m.from === self) return null;
  return m.lids.filter((l): l is string => typeof l === 'string');
}

/** `storage` event を聞く最小面(`window`)。 */
export interface StorageEventTarget {
  addEventListener(type: 'storage', fn: (ev: StorageEvent) => void): void;
  removeEventListener(type: 'storage', fn: (ev: StorageEvent) => void): void;
}

export interface MessageSync {
  /** このタブがその lid へ書いた(書けた後に呼ぶ)。⚠ 1 秒に 1 回までにまとめて送る。 */
  changed(lid: string): void;
  /** 聞くのをやめる(test 用)。 */
  dispose(): void;
}

export function connectMessageSync(opts: {
  /** 路(`null` = この箱には無い)。 */
  readonly channel: MessagesChannelPort | null;
  readonly id: string;
  /** `storage` event を聞く面(`null` = 聞かない)。 */
  readonly win: StorageEventTarget | null;
  /** 既読の時刻を持つ localStorage の key。 */
  readonly readAtKey: string;
  /** 他のタブがこれらの lid へ書いた。⚠ 呼び側が「開いているか」を見て読み直す。 */
  readonly onRemoteWritten: (lids: readonly string[]) => void;
  /** 他のタブが既読にした。⚠ 呼び側が未読を数え直す。 */
  readonly onReadElsewhere: () => void;
  readonly setTimer?: (fn: () => void, ms: number) => unknown;
  readonly clearTimer?: (h: unknown) => void;
}): MessageSync {
  const { channel, id, win } = opts;
  const setT = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearT = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const pending = new Set<string>();
  let timer: unknown = null;

  if (channel !== null) {
    channel.onmessage = (ev: MessageEvent) => {
      const lids = readMessages(ev.data, id);
      if (lids !== null && lids.length > 0) opts.onRemoteWritten(lids);
    };
  }
  const onStorage = (ev: StorageEvent): void => {
    // ⚠ key が null は `clear()`(全消し)── 既読の時刻も消えているので数え直す
    if (ev.key === opts.readAtKey || ev.key === null) opts.onReadElsewhere();
  };
  win?.addEventListener('storage', onStorage);

  return {
    changed(lid: string): void {
      if (channel === null) return;
      pending.add(lid);
      if (timer !== null) return;
      timer = setT(() => {
        timer = null;
        const lids = [...pending];
        pending.clear();
        if (lids.length > 0) channel.postMessage(messagesMessage(id, lids));
      }, MESSAGES_SYNC_MS);
    },
    dispose(): void {
      if (timer !== null) clearT(timer);
      timer = null;
      pending.clear();
      win?.removeEventListener('storage', onStorage);
      if (channel !== null) channel.onmessage = null;
    },
  };
}
