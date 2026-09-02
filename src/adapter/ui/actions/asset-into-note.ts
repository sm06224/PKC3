/**
 * 🔴 **取り込んだ資産を、開いていたノートの本文へ入れる**(user 裁定 2026-09-02、#666)。
 *
 * > 「読んでいたノートの本文に入る」── **A** を選んだ理由は、録音・画面録画と
 * > **結果が逆**だったからである(同じ帯の隣どうしなのに、片方は本文へ入り、
 * > もう片方は独立したノートを作って**画面ごと持っていく**)。
 *
 * ## ⚠ なぜ別 file へ出したか
 *
 * この段取りは **`capture.ts` の中に 1 つだけ**在った。添付にも要るからといって
 * 写すと、**同じ問いに答える口が 2 つ**になる(CLAUDE.md §7)── 断り方も、
 * 預かり方も、選択の返し方も、片方だけ直る日が来る。🔑 だから**寄せた**。
 *
 * ## 🔴 順番に意味がある(3 つとも過去に踏んだ罠である)
 *
 * 1. **入れ先は「取り込む時点で開いているノート」を先に控える** ── 添付を作ると
 *    `CREATE_ENTRY` の reducer が `selectedLid` を**新しい添付へ移す**ので、
 *    後から読むと**添付自身**を指す。
 * 2. **選択を返す** ── 返さないと、user は「写真を入れたのに、画面が写真になった」
 *    と読む(#666 に user が書いた症状そのもの)。
 * 3. **書けないなら捨てずに預かる** ── `await` の後なので、待っている間に state は
 *    動く。判定は `queue.push` の中の `canWriteBody` **1 か所**に任せる
 *    (ここで `phase` を数え直さない)。
 */
import type { Dispatcher } from '@adapter/state/dispatcher';
import type { WritableQueue } from './writable-queue';
import { formatAssetRef, isImageAssetMime } from '@features/asset/asset-ref-format';
import { isAppendable } from '@features/flavor/append-spec';

/**
 * 取り込む時点で開いていたノート。
 * ⚠ **`attach` を呼ぶ前に**採る(上の 1)。
 */
export interface NoteToPutInto {
  readonly lid: string | null;
  readonly archetype: string | undefined;
}

export function noteToPutInto(dispatcher: Dispatcher): NoteToPutInto {
  const st = dispatcher.getState();
  const lid = st.selectedLid;
  return {
    lid,
    archetype: lid === null ? undefined : st.entryMetas.get(lid)?.archetype,
  };
}

export interface PutAssetArgs {
  readonly dispatcher: Dispatcher;
  readonly queue: WritableQueue;
  /** 画面の下へ 1 行出す口。⚠ **どの枝でも必ず 1 行言う**(黙って終わらない)。 */
  readonly notify: (text: string) => void;
  /** `noteToPutInto` で**先に**控えたもの。 */
  readonly into: NoteToPutInto;
  /** 出来た添付の lid(選択を返すときに、同じものなら撃たない)。 */
  readonly attachedLid: string;
  readonly assetKey: string;
  readonly name: string;
  readonly mime: string;
  /**
   * 文頭に付ける事情(「共有が終わったので画面収録を止めました。」等)。
   * ⚠ 添付のように事情が無いときは空文字。
   */
  readonly why: string;
}

/**
 * 🔴 **選択を返して、本文へ参照を 1 行入れる。**
 *
 * ⚠ 入れられない枝(ノートが無い / 追記できない種類)でも**資産は残っている** ──
 *   「消えた」と読ませないので、そこまで言う。
 */
export function putAssetIntoNote(args: PutAssetArgs): void {
  const { dispatcher, queue, notify, into, attachedLid, assetKey, name, mime, why } = args;

  // 🔴 **開いていたノートへ戻す**(添付が奪った選択を返す)
  if (into.lid !== null && into.lid !== attachedLid) {
    dispatcher.dispatch({ type: 'SELECT_ENTRY', lid: into.lid });
  }

  if (into.lid === null) {
    notify(`${why}「${name}」を添付にしました(ノートを開いていないので本文には入れていません)`);
    return;
  }
  if (!isAppendable(into.archetype)) {
    notify(`${why}「${name}」を添付にしました(開いているのは追記できない種類なので本文には入れていません)`);
    return;
  }

  /**
   * ⚠ **画像かどうかで綴りが変わる**(`![…]` か `[…]`)── 画像は本文で描かれる。
   *   判定は `isImageAssetMime` **1 か所**(情報ペインの「参照をコピー」と同じ)。
   */
  const ref = formatAssetRef(name, `asset:${assetKey}`, isImageAssetMime(mime));
  const lid = into.lid;
  const held = queue.push(() => {
    dispatcher.dispatch({ type: 'APPEND_TO_ENTRY', lid, text: ref, heading: null, target: null });
    notify(`${why}「${name}」を本文に入れました`);
  });
  // ⚠ **預かった回も黙らない**(いつ入るのかを言う)
  if (held)
    notify(`${why}「${name}」を添付にしました(いま本文を書けないので、書けるようになったら入れます)`);
}
