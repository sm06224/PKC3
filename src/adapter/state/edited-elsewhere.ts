/**
 * 🔴 **そのノートを、別のタブ・窓が編集中か**(#529 W5-a〜d。Gemini 裁定 2026-10-11 依頼 18 Q5 = A)。
 *
 * ⚠ 通すと、編集中のタブが保存したとき**そちらの内容で上書きされ**、足した字は履歴にだけ残る
 *   (設計 `board-edit-in-place-design-2026-10.md` §3.2 の 5)。だから**断って理由を出し、打った字は欄に残す**。
 * 🔑 問い合わせは**編集に入るときと同じ口**(`acquireEditLock`)── 判定を 2 本にしない(§7)。
 *   取れたら**すぐ返す**(追記・改名は錠を握り続けない。握ると付箋 10 枚で 10 枚ぶん握る)。
 * ⚠ **このタブが自分で編集中のノートは問い合わせない** ── 取り直して返すと自分の錠を手放す。
 *   このタブの編集は reducer の門(`bodyWriteBlockReason`)が断る。
 * ⚠ `unreachable`(メインのタブと通信できない)は**断らない** ── 「別のタブが編集中」とは別の事実で、
 *   新しい断りを足さない。
 *
 * 呼び手(追記の口の全数。W5-d で数えた): 板の付箋の追記・題名(`binder.ts`)/ 本文の下の追記欄(`append-entry`)/
 * PDF の「ノートへ引く」(`quote-into-note.ts`)/ ブラウザの AI の `pkc_append_note`(`main.ts`)/
 * 予定タブの「足す」と目盛りの作成(`addScheduleItemChecked`、`binder.ts`)/
 * 履歴の「この版に戻す」(`restore-revision`、`binder.ts`。#1087)/
 * 塊を別のノートへ持っていく「⠿」(元と先の両方。`actUnlessEditedElsewhere`、#1087)/
 * 表の行・列を足す「＋」と消す「×」(`shape-cell`。#1087)/
 * 板の付箋の操作(置く・前へ出す・形・色・線の太さ・矢じり・文字の大きさ・回す・グループ・位置と大きさ。
 *   `placeEditedElsewhereGate`、`binder.ts`。#1087)/
 * 表の升の書換(`edit-cell` の確定。断ったら打った字を知らせに残す)と、表の形変え(「表にする」`applyTableFormat`)(#1087)/
 * 拡張からの書き戻し(`applyExtWriteOps`、`ext-write-apply.ts`。書く lid ごと。#1087)/
 * タグの付け外し(情報ペインの `add-tag` / `untag-entry`・フォルダの帯の `bulk-tag-add` / `bulk-tag-remove`・
 * 集計の `query-tag-rename` / `query-tag-remove`・スマートフォルダの「外す」と落とし。実体は `BULK_TAG`。#1087)/
 * スマートフォルダの条件の書き換え(足す `smart-cond-add` / 選ぶ `smart-field` / 外す `smart-cond-remove`。
 *   確かめるのは条件の入れ物のノート 1 件。#1087)。
 * ⚠ 板の付箋のドラッグ移動・付箋を消す(`remove-place`)・線を消す(`remove-place-line`)には足していない
 *   (離した直後 / 確認の直後の体感が変わるので、見え方の判断待ち。3 つは同じ「判断待ち」の組)。
 * 通さない口(理由は設計 doc §6 W5-d): 計時の記録・文字起こし・添付のドロップ。
 */
import { EDIT_ELSEWHERE_ERROR } from '@features/message/caution-events';
import type { Dispatcher } from './dispatcher';
import { appendAndSettle, REAL_APPEND_TIMERS, type AppendOutcome, type AppendTimers } from './append-settle';

/** 編集の錠の口(`BinderServices` の同名の 2 つと同じ形)。 */
export interface EditLockPort {
  acquireEditLock?(lid: string): Promise<'granted' | 'denied' | 'unreachable'>;
  releaseEditLock?(lid: string): void;
  /**
   * 🔴 **確かめるだけの問い合わせ**(#1087)。取れても**このタブの別の呼び手が同じノートの錠を
   * 必要としているなら、返してよいとは言わない**(`mayRelease: false`)。
   * ⚠ 無い口(unit の fake)では従来どおり `acquireEditLock` + 自分で判断する。
   */
  probeEditLock?(lid: string): Promise<{ grant: 'granted' | 'denied' | 'unreachable'; mayRelease: boolean }>;
}

/** `TabSync` のうち錠の 2 つ(`store-proxy.ts`)。 */
export interface EditLockSync {
  acquireEdit(cid: string, lid: string): Promise<'granted' | 'denied' | 'unreachable'>;
  releaseEdit(cid: string, lid: string): void;
}

/**
 * 錠の口を組む(`main.ts` から取り出した ── 配線を test できるように)。
 * ⚠ `sync` は昇格で実体が替わるので**呼ぶたびに読む**(`getSync`)。
 */
export function makeEditLockPort(getSync: () => EditLockSync, cid: string): Required<EditLockPort> {
  /**
   * 🔴 **同じタブの中で、同じノートの錠を取る呼び手が重なる**(#1087)。台帳はタブ単位で 1 件なので、
   * 「確かめるだけ」の呼び手が返すと、同時に編集に入ろうとしている呼び手の錠まで落ちる。
   * 🔑 だから**編集に入る側の取得**(`acquireEditLock`)の「始めた回数」と「返事待ちの数」を数え、
   *   確かめるだけの側(`probeEditLock`)は、重なった回は返さない。
   *   確かめる側どうしが重なる回は、最後に終わった 1 つだけが返す(全員が譲ると錠が残る)。
   */
  const seq = new Map<string, number>();
  const inflight = new Map<string, number>();
  const probing = new Map<string, number>();
  const bump = (m: Map<string, number>, lid: string, d: number): number => {
    const v = (m.get(lid) ?? 0) + d;
    if (v <= 0) m.delete(lid);
    else m.set(lid, v);
    return v;
  };
  return {
    acquireEditLock: (lid) => {
      bump(seq, lid, 1);
      bump(inflight, lid, 1);
      return getSync()
        .acquireEdit(cid, lid)
        .finally(() => {
          bump(inflight, lid, -1);
        });
    },
    releaseEditLock: (lid) => {
      getSync().releaseEdit(cid, lid);
    },
    probeEditLock: async (lid) => {
      const seqAtStart = seq.get(lid) ?? 0;
      const othersInFlight = (inflight.get(lid) ?? 0) > 0;
      bump(probing, lid, 1);
      try {
        const grant = await getSync().acquireEdit(cid, lid);
        const overlapped = othersInFlight || (seq.get(lid) ?? 0) !== seqAtStart;
        return { grant, mayRelease: !overlapped && (probing.get(lid) ?? 0) === 1 };
      } finally {
        bump(probing, lid, -1);
      }
    },
  };
}

/**
 * 問い合わせが**要らない**か(同期)。口が無い / このタブが自分で編集中(章の下書き含む)。
 * ⚠ 要らないときは**同期のまま**書く ── 口の無い環境(unit)の追記を非同期に変えない。
 */
export function elsewhereCheckNotNeeded(dispatcher: Dispatcher, port: EditLockPort, lid: string): boolean {
  if (!port.acquireEditLock) return true;
  return ownsLocally(dispatcher, lid);
}

/** このタブが自分でそのノートを編集中(全文 / 章の下書き)。 */
function ownsLocally(dispatcher: Dispatcher, lid: string): boolean {
  const st = dispatcher.getState();
  return (st.phase === 'editing' && st.openBody?.lid === lid) || st.sectionDraft?.lid === lid;
}

/** 断る理由(別のタブが編集中)。通すなら `null`。 */
export async function editedElsewhereReason(
  dispatcher: Dispatcher,
  port: EditLockPort,
  lid: string,
): Promise<string | null> {
  if (elsewhereCheckNotNeeded(dispatcher, port, lid)) return null;
  const { grant, mayRelease } = port.probeEditLock
    ? await port.probeEditLock(lid)
    : { grant: await port.acquireEditLock!(lid), mayRelease: true };
  if (grant === 'granted') {
    // ⚠ 待っている間に**このタブが同じノートの編集に入った**なら、いま握っている錠は
    //   その編集の物(同じ錠の取り直し)── 返すと自分の編集の錠を手放す。
    //   🔴 編集に入ろうとしている途中(返事待ち)の呼び手が居る回も返さない(`mayRelease`。#1087)
    if (mayRelease && !ownsLocally(dispatcher, lid)) port.releaseEditLock?.(lid);
    return null;
  }
  return grant === 'denied' ? EDIT_ELSEWHERE_ERROR : null;
}

/**
 * 別のタブの編集を確かめてから {@link appendAndSettle} へ渡す(PDF の引用・ブラウザの AI の書き足し)。
 * 断った回は何も書かず `refused` + 理由で返す(呼び手が自分の字で言う)。
 */
export function appendUnlessEditedElsewhere(
  dispatcher: Dispatcher,
  port: EditLockPort,
  lid: string,
  text: string,
  heading: string | null,
  timeoutMs: number,
  timers: AppendTimers = REAL_APPEND_TIMERS,
): Promise<AppendOutcome> {
  // 問い合わせが要らない回は**同期のまま**撃つ(口の無い環境の追記を 1 手遅らせない)
  if (elsewhereCheckNotNeeded(dispatcher, port, lid)) {
    return appendAndSettle(dispatcher, lid, text, heading, timeoutMs, timers);
  }
  return editedElsewhereReason(dispatcher, port, lid).then((why) =>
    why !== null
      ? ({ ok: false, reason: 'refused', error: why } as const)
      : appendAndSettle(dispatcher, lid, text, heading, timeoutMs, timers),
  );
}
