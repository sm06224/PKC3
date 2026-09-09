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
import {
  insertLines,
  resolveInsertPlace,
  type InsertAnchor,
  type InsertPlace,
} from '@features/markdown/line-move';
import { bodyWillChange, type WritableQueue } from './writable-queue';
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

/**
 * @param pinned 🔴 **入れ先を名指しする**(#826)。⚠ 既定(省略)はこれまでどおり
 *   **いま選んでいるノート**である。
 *
 *   ⚠ 名指しが要るのは、**選ぶ間ずっと画面を止めていない**口ができたからである ──
 *   別の窓で書庫の中を選んでいる間、user は主の窓で**別のノートへ移れる**。
 *   そのとき「いま選んでいるノート」を読むと、**押したときと違うノートへ入る**
 *   (CLAUDE.md §10「置き換えられる側が"ついでに"提供していた性質」── modal は
 *   周りを止めることで**入れ先の身元**も守っていた)。
 * 🔑 **判定はこの 1 本のまま**にする(呼び側で `entryMetas` を引き直さない)。
 */
export function noteToPutInto(dispatcher: Dispatcher, pinned?: string | null): NoteToPutInto {
  const st = dispatcher.getState();
  const lid = pinned === undefined ? st.selectedLid : pinned;
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
  /**
   * 🔴 **選択を返す先**(#684 ㋑)。⚠ **入れ先と別**である ── 横に留めた枠へ落とした回は
   *   「入るのは留めた枠のノート、画面に戻すのは主の枠のノート」になる。
   * ⚠ 省略 = 入れ先へ返す(これまでどおり。添付が奪った選択を戻すだけ)。
   */
  readonly selectBack?: string | null;
  /**
   * 入れ先のノートの題名。⚠ **入れ先が「いま開いているノート」でないときだけ**渡す
   *   ── 渡すと知らせが名前で言う(「『◯◯』の落とした所に入れました」)。
   *   ⚠ いつも名前を出すと、1 つしか見ていない user には**要らない字**が増える。
   */
  readonly intoTitle?: string;
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
  /**
   * 本文へ入ったら呼ぶ(#668 E。まとめて入れた回を件数で締めるために数える)。
   * ⚠ 入れない枝(ノートが無い / 入れられない種類)では**呼ばない** ── 呼ぶと
   *   「3 件を本文に入れました」の 3 に、入っていない物が数えられる。
   */
  readonly onPut?: (name: string) => void;
  /**
   * 🔴 **落とした所**(#684 段④)。⚠ **書き換わる入れ物**である ── 1 枚入るたびに
   *   「その行の下」へ進む(まとめて落とした写真が、落とした順に並ぶ)。
   * ⚠ 省略 = これまでどおり**本文のいちばん下**(添付ボタン・貼付・録音の経路)。
   */
  readonly place?: DropCursor;
}

/**
 * 🔴 **落とした所を持ち回る入れ物**(#684 段④)。
 *
 * ⚠ `lid` は**落とした本文のノート** ── 入れ先(`into.lid`)と違うなら位置は使わない
 *   (横に留めた枠へ落としたときに、主の枠のノートの行番号を信じない)。
 * ⚠ `at` が `null` になったら、その回はもう末尾である(戻さない)。
 */
export interface DropCursor {
  readonly lid: string;
  at: InsertPlace | null;
  /**
   * 🔴 **この回に「落とした所」へ入れたものが在るか**(着地前レビュー F)。
   * ⚠ 途中で末尾へ落ちた回に**同じ回の印(`batch`)を継ぐと、「元に戻す」が 1 行も
   *   消せない** ── `nextLastAppend` は「継いだ行は本文の中で連続している」を前提に
   *   しており、途中と末尾が混ざるとその前提が崩れる(`removeInsertedLines` は
   *   連続した並びしか探さない)。だから**混ざった回は継がない**。
   */
  placed: boolean;
  /**
   * 🔴 **落とした時の本文 + 自分が入れたぶん**(次の 1 枚が読む基底)。
   *
   * ⚠ **画面の本文は読めない** ── 添付のノートを作ると `CREATE_ENTRY` が選択を移し、
   *   `SELECT_ENTRY` で戻す時に「選択が変わったら旧 `openBody` は破棄」が効く。
   *   本文は非同期に読み直されるので、**書く時点では `screenBodyOf` が `null`** である
   *   (2026-09-08 の unit がここを突いた ── 画面を読む形では位置が**一度も使われない**)。
   * ⚠ 2 枚目以降も画面では足りない ── `INSERT_LINES` は錠(`writeLock`)を立てないので、
   *   2 枚目の取込は 1 枚目の**書込が終わる前**に走る。
   * 🔑 効果層は書換を**直列の 1 op** で回す(read→rewrite→write)ので、進めたこの本文が
   *   書く時の disk と揃う。
   */
  body: string;
}

/**
 * 🔴 **落とした所の申告**(binder → `attachFiles` → `DropCursor`)。
 * ⚠ `body` は**落とした時に読んだ本文** ── 書く時には画面から消えているので、
 *   ここで一緒に渡す(`DropCursor.body` の注記)。
 */
export interface DroppedAt {
  readonly lid: string;
  readonly toBefore: number;
  readonly body: string;
  /**
   * 🔴 **落とした塊の開き行**(行番号 + その字)── 書く直前に disk 側で突き合わせる目印。
   * ⚠ 行番号だけを持つと、待っている間に上へ 1 行足されただけで**段落の途中へ刺さる**。
   */
  readonly anchor: InsertAnchor;
}

/** 申告から、持ち回る入れ物を 1 つ作る(1 回の落としに 1 つ)。 */
export function dropCursor(at: DroppedAt): DropCursor {
  return {
    lid: at.lid,
    at: { kind: 'before', toBefore: at.toBefore, anchor: at.anchor },
    body: at.body,
    placed: false,
  };
}

/**
 * 落とした所を、持ち回っている本文の行番号へ解く。
 * @returns 差し込む所(この行の前)。⚠ **解けなければ `null`** = 末尾へ入れる。
 */
function placeFor(
  place: DropCursor | undefined,
  lid: string,
): { to: number; anchor: InsertAnchor } | null {
  /**
   * ⚠ **落とした本文と入れ先が違う回は、位置を使わない** ── 横に留めた枠へ落としても
   *   添付が入るのは主の枠のノート(`noteToPutInto` = `selectedLid`)なので、
   *   留めた枠の行番号で主の枠の本文へ書くと**別のノートの段落の途中へ刺さる**。
   * 🔑 そこへ線を出さないのは `binder.ts` の側(印と結果を食い違わせない)。
   */
  if (place === undefined || place.lid !== lid || place.at === null) return null;
  return resolveInsertPlace(place.body, place.at);
}

/**
 * 🔴 **選択を返して、本文へ参照を 1 行入れる。**
 *
 * ⚠ 入れられない枝(ノートが無い / 追記できない種類)でも**資産は残っている** ──
 *   「消えた」と読ませないので、そこまで言う。
 */
export function putAssetIntoNote(args: PutAssetArgs): void {
  const {
    dispatcher,
    queue,
    notify,
    into,
    attachedLid,
    assetKey,
    name,
    mime,
    why,
    batch,
    onPut,
    place,
    intoTitle,
  } = args;

  /**
   * 🔴 **開いていたノートへ戻す**(添付が奪った選択を返す)。
   * ⚠ 返す先は**入れ先とは限らない**(#684 ㋑)── 横に留めた枠へ落とした回は、
   *   入るのは留めた枠のノートだが、**画面は主の枠のまま**でなければならない
   *   (勝手に開き直したら「補助的な物が主の作業領域を奪う」#300 と同じ)。
   */
  const back = args.selectBack === undefined ? into.lid : args.selectBack;
  if (args.selectBack === null) {
    /**
     * 🔴 **何も開いていなかったなら、何も開いていない所へ返す**(#684 ㋑、
     *   着地前の動線レビュー 欠陥 2)。
     *
     * ⚠ 起動した直後は中央に何も開いていない(留めた枠だけ復元される)。そこへ
     *   留めた枠へ file を落とすと、`CREATE_ENTRY` が選択を**作った添付へ移す**ので、
     *   返し先が `null` = 撃たないだと **中央が `猫.png` の画面に化ける** ──
     *   お知らせにもマニュアルにも「画面は動きません」と書いた当の約束が、
     *   いちばん起きやすい入り口で破れる。
     * 🔑 だから**戻す先が「無い」ことも指示として扱う**(`DESELECT_ENTRY`)。
     * ⚠ `undefined`(= 指示が無い)とは区別する ── そちらはこれまでどおり
     *   「入れ先へ返す / 入れ先が無ければ何もしない」である。
     */
    dispatcher.dispatch({ type: 'DESELECT_ENTRY' });
  } else if (back !== null && back !== attachedLid) {
    dispatcher.dispatch({ type: 'SELECT_ENTRY', lid: back });
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
  /**
   * 🔴 **待っている間に本文が変わる回は、落とした所を捨てる**(#684 段④ / ㋑)。
   *
   * ⚠ 直す前は「**いま書けない**」(`canWriteBody`)で捨てていたが、それは
   *   問いが 1 つ広すぎた(#684 ㋑ の着地前レビュー 重大 ②)── **編集していない
   *   ノート**(横に留めた枠)へ落としても位置が捨てられ、線を出した所ではなく
   *   いちばん下へ入っていた。線が**守れない約束**になる。
   * 🔑 捨てるべきなのは**その本文自身が書き換わる**ときだけ(`bodyWillChange`):
   *   ①いま編集しているのがこのノート ②この本文への書込が錠を握っている。
   * ⚠ どちらでもなければ待っても本文は動かない ── 万一動いていても、書く直前に
   *   **目印(`InsertAnchor`)で突き合わせる**ので断る側に倒れる(黙って別の所へ入れない)。
   */
  if (place !== undefined && bodyWillChange(dispatcher, lid)) place.at = null;
  const held = queue.push(() => {
    /**
     * 🔴 **開いているノートと違う所へ入れた回は、「開く」を添える**(#684 ㋑、
     *   着地前の動線レビュー)。
     *
     * ⚠ 追記欄の「元に戻す」は**開いているノートの欄にしか出ない**
     *   (`append-box.ts` の `state.lastAppend?.lid === mode.lid`)── つまり
     *   留めた枠へ入れた 1 行は、**そのノートを開くまで戻す口が画面に無い**。
     *   それは「片道の操作を作らない」(user 指示 2026-08-23)に反する。
     * 🔑 だから知らせの隣に**行き先へ行く道**を置く ── 押して開けば、そこで
     *   「元に戻す」が出る(`lastAppend` は選び直しでは落ちない)。
     * ⚠ 開いているノート自身へ入れた回は添えない ── `paintStatusOpen` が
     *   「もうそれを開いている」で畳むので、どのみち出ない(口だけ作らない)。
     * ⚠ `notify` の 2 つ目を**受け取らない受け手が居る**(`capture.ts` の
     *   `showStatus` は字だけ出す)ので、渡すのは任意のままにする。
     */
    const openArg: readonly [string] | readonly [] =
      intoTitle === undefined ? [] : ([lid] as const);
    /**
     * 🔴 **落とした所が今も在るなら、そこへ**(#684 段④)。
     * ⚠ 解けなければ**末尾へ落とす**(黙って別の所へ入れない)。
     */
    const hit = placeFor(place, lid);
    if (hit !== null) {
      dispatcher.dispatch({
        type: 'INSERT_LINES',
        lid,
        toBefore: hit.to,
        lines: [ref],
        anchor: hit.anchor,
        refusal: '編集を終了してから、ファイルを本文へ落としてください',
        ...(batch === undefined ? {} : { batch }),
      });
      place!.placed = true;
      // ⚠ 次の 1 枚は**この行の下**へ(同じ所へ入れると 2 枚目が上に来て順番が逆になる)
      const next = insertLines(place!.body, hit.to, [ref], hit.anchor);
      // ⚠ 進めた本文が組めない回は**位置をやめる** ── 進められないのに `before` の
      //    ままにすると、次の 1 枚が**同じ所**へ入って 1 枚目の上に来る
      place!.at = next === null ? null : { kind: 'after', anchor: ref };
      if (next !== null) place!.body = next;
      // 🔑 **どこに入ったかを言う**(#668 F)── 画面は動かさないので、字で場所を指す
      notify(
        intoTitle === undefined
          ? `${why}「${name}」を落とした所に入れました`
          : `${why}「${name}」を『${intoTitle}』の落とした所に入れました`,
        ...openArg,
      );
    } else {
      /**
       * ⚠ **この行は等価な変異である**(変異試験 M6 が SURVIVED で教えた、2026-09-08)。
       * 解けなかった理由(位置が無い / 別のノート / 範囲外)は**回の間ずっと同じ**なので、
       * 捨てても捨てなくても 2 枚目以降は同じく末尾へ落ちる ── **殺せないことを承知で
       * 残している**(「一度末尾へ落ちた回は、もう末尾である」を字で残すため)。
       * ⚠ 「これが無いと順番が狂う」と書きかけたが、**外しても狂わなかった**
       *   (CLAUDE.md「『これが無いと壊れる』と書く前に、外して壊れるのを見る」)。
       */
      if (place !== undefined) place.at = null;
      /**
       * 🔴 **この回に「落とした所」へ入れたものが在るなら、末尾のぶんは別の 1 手にする**
       *   (着地前レビュー F)。⚠ 継ぐと `lastAppend.lines` が本文の中で**連続しなく
       *   なる**ので、「元に戻す」は 1 行も消せずに赤帯だけ出す(押した時点で材料も
       *   捨てられるので、押し直しもできない)。
       * ⚠ **いまは等価な変異である**(変異試験 N2 / N3 が SURVIVED で教えた、2026-09-08)──
       *   回の途中で末尾へ落ちる引き金は**錠**(`writeLock` を立てるのは
       *   `APPEND_TO_ENTRY` 1 か所)しか無く、その錠を立てた追記自身が `lastAppend` を
       *   差し替えるので、鎖はそこで切れている。
       * 🔑 それでも残すのは、**引き金が増えた日**(錠を立てる 2 か所目 / 回の途中で編集へ
       *   入れるようになった日)に静かに壊れないため ── 結果のほうは
       *   `attach-intake.test.ts` の「途中と末尾が混ざっても…」が守る。
       */
      const keep = batch !== undefined && place?.placed !== true;
      dispatcher.dispatch({
        type: 'APPEND_TO_ENTRY',
        lid,
        text: ref,
        heading: null,
        target: null,
        ...(keep ? { batch } : {}),
      });
      notify(
        intoTitle === undefined
          ? `${why}「${name}」を本文のいちばん下に入れました`
          : `${why}「${name}」を『${intoTitle}』の本文のいちばん下に入れました`,
        ...openArg,
      );
    }
    // ⚠ 知らせの**後**に数える ── まとめた回の締め(件数)が、この 1 行を上書きする側
    onPut?.(name);
  });
  // ⚠ **預かった回も黙らない**(いつ入るのかを言う)
  if (held)
    notify(`${why}「${name}」を添付にしました(いま本文を書けないので、書けるようになったら入れます)`);
}
