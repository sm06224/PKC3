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
import { appendableKindsLabel, isAppendable } from '@features/flavor/append-spec';
import { archetypeLabel } from '@features/flavor/archetype-label';

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
  /**
   * 画面の下へ 1 行出す口。⚠ **どの枝でも必ず 1 行言う**(黙って終わらない)。
   * `open` = その知らせの隣に「開く」で出す物の lid(#668 A)。⚠ 受け側が
   *   2 つ目を読まなくてもよい(`capture.ts` の `showStatus` は字だけ出す)。
   */
  readonly notify: (text: string, open?: string) => void;
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
  /**
   * 取り込みの回の印(#668 C)。同じ印で入れた行は「元に戻す」1 回でまとめて消える。
   * ⚠ 省略 = 単独の 1 手(録音・画面録画は 1 回に 1 本なので付けない)。
   */
  readonly batch?: string;
}

/**
 * 🔴 **選択を返して、本文へ参照を 1 行入れる。**
 *
 * ⚠ 入れられない枝(ノートが無い / 追記できない種類)でも**資産は残っている** ──
 *   「消えた」と読ませないので、そこまで言う。
 */
export function putAssetIntoNote(args: PutAssetArgs): void {
  const { dispatcher, queue, notify, into, attachedLid, assetKey, name, mime, why, batch } = args;

  // 🔴 **開いていたノートへ戻す**(添付が奪った選択を返す)
  if (into.lid !== null && into.lid !== attachedLid) {
    dispatcher.dispatch({ type: 'SELECT_ENTRY', lid: into.lid });
  }

  if (into.lid === null) {
    notify(`${why}「${name}」を添付にしました(ノートを開いていないので本文には入れていません)`);
    return;
  }
  if (!isAppendable(into.archetype)) {
    /**
     * 🔴 **何を開いているのか・何なら入るのかを言い、その添付へ行く口を添える**
     *   (#668 A。PR #667 の着地前レビュー)。
     * ⚠ 直す前は「追記できない種類なので」だけで、user は**開いている物の種類も、
     *   どれなら入るのかも、作られた添付がどこに在るのかも**読めなかった
     *   (一覧は絞りで隠れていることがある ── 押して行ける口が 1 つも無い)。
     * ⚠ 種類の名前が引けない回(meta が消えた)だけ、元の言い方に落ちる。
     */
    const kind =
      into.archetype === undefined ? '追記できない種類' : `『${archetypeLabel(into.archetype)}』`;
    notify(
      `${why}「${name}」を添付にしました(開いているのは${kind}なので、本文には入れていません。本文に入れられるのは${appendableKindsLabel()}だけです)`,
      attachedLid,
    );
    return;
  }

  /**
   * ⚠ **画像かどうかで綴りが変わる**(`![…]` か `[…]`)── 画像は本文で描かれる。
   *   判定は `isImageAssetMime` **1 か所**(情報ペインの「参照をコピー」と同じ)。
   */
  const ref = formatAssetRef(name, `asset:${assetKey}`, isImageAssetMime(mime));
  const lid = into.lid;
  const held = queue.push(() => {
    dispatcher.dispatch({
      type: 'APPEND_TO_ENTRY',
      lid,
      text: ref,
      heading: null,
      target: null,
      ...(batch === undefined ? {} : { batch }),
    });
    // 🔑 **どこに入ったかを言う**(#668 F)── 画面は動かさないので、字で場所を指す
    notify(`${why}「${name}」を本文のいちばん下に入れました`);
  });
  // ⚠ **預かった回も黙らない**(いつ入るのかを言う)
  if (held)
    notify(`${why}「${name}」を添付にしました(いま本文を書けないので、書けるようになったら入れます)`);
}
