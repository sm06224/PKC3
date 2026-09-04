/**
 * 🔴 **同じノートの付箋を 2 枚作らない**(#685、user 裁定 2026-09-04)。
 *
 * > 「**開いている窓が前に出る**(2 枚目は作らない)。違うノートなら今までどおり増える」
 *
 * ## なぜ「窓の名前」で済まないのか(2026-09-04 実測)
 *
 * ふつうは `window.open(url, 名前, …)` に**名前**を渡せばブラウザが窓を使い回す
 * (`manual-window.ts` がその形)。⚠ ところが **`noopener` を付けると名前は無視され、
 * 2 度目も新しい窓が開く**:
 *
 * | 開き方 | 2 度目に押すと | 戻り値 |
 * |---|---|---|
 * | 名前あり・`noopener` **なし** | **同じ窓を使い回す** | handle |
 * | 名前あり・`noopener` あり | **窓が増える** | null |
 *
 * 🔑 `noopener` は捨てられない ── あれが「閉じたら常駐が還る」(−32.2 MB / −4.6 MB)の
 * 根拠であり、user 不可侵指示「効くのは定常 / もっさりだと嫌」に直結する。
 * だから**こちらで台帳を持つ**。
 *
 * ## 作り
 *
 * - 付箋の窓は「いま自分はこのノートを出している」を放送する(`here`)
 * - どの窓もそれを聞いて `lid → 窓の id` の表を持つ
 * - 押したときは**その表を同期に読む** ── ⚠ ここで待つと
 *   `window.open` が gesture の外へ落ちてポップアップ遮断に当たる
 * - 出さないと決めたら「前に出て」と頼む(`raise`)
 *
 * ## ⚠ 「前に出る」は保証できない(2026-09-04、判定不能)
 *
 * headless では `document.hasFocus()` が**親子とも `true`** を返す(対照群が崩れる)ので、
 * `window.focus()` が実際に窓を手前へ出すかは**測れなかった**。
 * 分かったのは「例外を投げない」ことだけである。
 * 🔑 だから**画面に出す字で「前に出しました」とは言わない** ── 言えるのは
 * 「別のウィンドウで開いています」までである(実機で user が見て裁定する)。
 */
import type { Broadcaster } from './storage/store-proxy';

/** 放送路。⚠ store の protocol とも面の窓の合図とも**別にする**(混ぜない)。 */
export const NOTE_REGISTRY_CHANNEL = 'pkc3-note-window';

/** 便りの種別。⚠ 名前を付ける ── 将来この路に別の便りが乗っても取り違えない。 */
export const NOTE_HERE = 'note-window-here';
export const NOTE_GONE = 'note-window-gone';
export const NOTE_ROLL_CALL = 'note-window-roll-call';
export const NOTE_RAISE = 'note-window-raise';

interface Wire {
  readonly tag: string;
  readonly id: string;
  readonly lid?: string;
  readonly to?: string;
}

export interface NoteRegistryDeps {
  /** 放送路。⚠ `null` なら台帳は**常に空**(この窓では 2 枚目を止められない)。 */
  readonly channel: Broadcaster | null;
  /** この窓の id。⚠ 自分の放送を数えないために要る。 */
  readonly id: string;
  /** 「前に出て」と頼まれたときに呼ばれる。 */
  readonly onRaise: () => void;
}

export interface NoteRegistry {
  /**
   * この窓がいま出している付箋のノートを伝える。`null` = 付箋ではない。
   * ⚠ **変わったときだけ放送する**(選択が動くたびに撒かない)。
   */
  announce(lid: string | null): void;
  /** そのノートを出している**別の**窓が居るか。⚠ 同期に答える(gesture を割らない)。 */
  has(lid: string): boolean;
  /** その窓に「前に出て」と頼む。⚠ 居なければ何もしない。 */
  raise(lid: string): void;
  /** 窓を閉じるときに呼ぶ(台帳から自分を外す)。 */
  close(): void;
}

/**
 * 🔴 **台帳を建てる。** ⚠ 建てた瞬間に**点呼**する ── 後から開いた窓が、
 * 先に居る付箋を知らないと「2 枚目を作らない」が効かない。
 */
export function createNoteRegistry(deps: NoteRegistryDeps): NoteRegistry {
  /** `lid → 窓の id`。⚠ **自分は入れない**(自分の付箋は数えない)。 */
  const byLid = new Map<string, string>();
  let mine: string | null = null;

  const send = (w: Wire): void => deps.channel?.postMessage(w);

  /** ⚠ 1 つの窓が出す付箋は 1 件 ── 前に載っていた行を必ず外す。 */
  const drop = (id: string): void => {
    for (const [lid, who] of [...byLid]) if (who === id) byLid.delete(lid);
  };

  if (deps.channel !== null) {
    deps.channel.onmessage = (ev: MessageEvent): void => {
      const w = ev.data as Wire | null;
      if (w === null || typeof w !== 'object' || typeof w.tag !== 'string') return;
      // ⚠ 自分の放送は数えない(自分の付箋で自分を止めない)
      if (w.id === deps.id) return;
      if (w.tag === NOTE_ROLL_CALL) {
        if (mine !== null) send({ tag: NOTE_HERE, id: deps.id, lid: mine });
        return;
      }
      if (w.tag === NOTE_HERE && typeof w.lid === 'string') {
        drop(w.id);
        byLid.set(w.lid, w.id);
        return;
      }
      if (w.tag === NOTE_GONE) {
        drop(w.id);
        return;
      }
      if (w.tag === NOTE_RAISE && w.to === deps.id) deps.onRaise();
    };
    send({ tag: NOTE_ROLL_CALL, id: deps.id });
  }

  return {
    announce: (lid) => {
      if (lid === mine) return;
      mine = lid;
      send(lid === null ? { tag: NOTE_GONE, id: deps.id } : { tag: NOTE_HERE, id: deps.id, lid });
    },
    has: (lid) => byLid.has(lid),
    raise: (lid) => {
      const to = byLid.get(lid);
      if (to !== undefined) send({ tag: NOTE_RAISE, id: deps.id, to });
    },
    close: () => {
      send({ tag: NOTE_GONE, id: deps.id });
      deps.channel?.close();
    },
  };
}
