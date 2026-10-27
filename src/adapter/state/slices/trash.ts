/**
 * reducer の slice: ごみ箱(#1383)。
 *
 * 🔑 `app-state.ts` の `reduceCore` から**機械的に移した**(case 本体は 1 文字も変えていない)。
 *   `reduceCore` は label を列挙してここへ渡す ── `switch` の網羅検査は両側で効く
 *   (`reduceCore` に label が無ければ `reduceTrash` に届かず、ここに case が無ければ tsc が落ちる)。
 * ⚠ 履歴・2 ペインの掃除・バックリンクは `reduceWithHistory` の 1 か所で見る(ここでは見ない)。
 */

import { type AppState, type Dispatchable, type ReduceResult, sectionDraftBlockedResult } from '../app-state';

export type TrashAction = Extract<Dispatchable, { type: 'SHOW_TRASH' | 'FILE_LINKED' | 'HIDE_TRASH' | 'TRASH_LIST_LOADED' | 'RESTORE_TRASH' | 'UNDO_TRASH' | 'PURGE_TRASH' }>;

export function reduceTrash(state: AppState, action: TrashAction): ReduceResult {
  switch (action.type) {
    case 'SHOW_TRASH': {
      /**
       * 🔴 **門を持たない**(#319)。⚠ 直す前は `phase !== 'ready'` で**黙って捨てて**
       * いたので、編集中に「ゴミ箱」を押すと**1 ドットも変わらず理由も出なかった**
       * ── P8 段⑲ で潰した「無言の操作拒否」そのものである。
       * 🔑 **開くのは読むだけ**で、下書きに 1 バイトも触らない ── `slices/dual.ts` の
       *   2 ペインの節が既に同じ判断を書いている(「断りが要るのは**実際に動かす
       *   操作**だけ」)。動かす側(復元・空にする)はそちらで断る。
       * ⚠ 外すなら `TRASH_LIST_LOADED` も同時に ── 片方だけだと
       *   「押せるのに一覧が来ない」という**別の無言**を作る。
       */
      return { state, events: [{ type: 'REQUEST_TRASH_LIST' }] };
    }
    case 'FILE_LINKED': {
      // ⚠ **居ない entry には紐づけない**(取込が失敗した後に届いても導線を作らない)
      if (!state.entryMetas.has(action.lid)) return { state, events: [] };
      if (state.linkedFiles.get(action.lid) === action.name) return { state, events: [] };
      const linkedFiles = new Map(state.linkedFiles);
      linkedFiles.set(action.lid, action.name);
      return { state: { ...state, linkedFiles }, events: [] };
    }
    case 'HIDE_TRASH':
      return { state: { ...state, trashPanel: null }, events: [] };
    case 'TRASH_LIST_LOADED':
      // 🔴 **開く側と対で門を外す**(#319)── 片方だけ残すと
      //    「押せるのに一覧が来ない」という別の無言になる
      return {
        state: {
          ...state,
          // 🔴 **いま存在する entry は「ゴミ箱」ではない**(P8 段⑪ の hotfix)。
          // ゴミ箱の定義は「entry が居ない revision」なので、届いた一覧を
          // **その場の真実で濾す**。これが無いと、開いた直後に復元したとき
          // **先に飛んだ一覧要求の応答が後から着いて、復元したものを戻す**
          // ── 画面には「復元したのにゴミ箱に残っている」が出る(smoke が
          // 3 回に 2 回落ちる形で表面化していた)。
          // ⚠ 世代(token)ではなく**導出**で塞ぐ ── どの順で着いても正しい
          trashPanel: { items: action.items.filter((t) => !state.entryMetas.has(t.entryLid)) },
        },
        events: [],
      };
    case 'RESTORE_TRASH': {
      if (state.phase !== 'ready') return { state, events: [] };
      /**
       * 🔴 **章の欄が開いている間は断る**(#1044 段2 2巡目の修理、R2)。
       *
       * ⚠ 直す前はここを素通りしていた ── `RESTORE_TRASH` 自身は `selectedLid`
       *   を動かさない(効果層へ `REQUEST_TRASH_RESTORE` を頼むだけ)ので、
       *   外側の門(`guardSectionDraftTransition`)はこの時点では何も気づかない。
       *   効果層が復元を終えた**後** `ENTRY_RESTORED` が届き、`phase !== 'editing'`
       *   の枝が `selectedLid` を復元先へ無条件に動かす ── これはようやく
       *   外側の門に引っかかるが、system command 側の枝(「結果は受け入れ、
       *   知らせて閉じる」)を通ってしまい、断り文が
       *   「このノートが別の場所で消されたか入れ替わったため」と**事実と違う理由**を
       *   言う(実際はこの user 自身の操作が引き起こした)。
       * 🔑 だから起点(ここ)で断る ── `REQUEST_TRASH_RESTORE` を出す前に止めれば、
       *   ENTRY_RESTORED も system 側の枝も一度も走らない。
       */
      if (state.sectionDraft !== null) {
        return sectionDraftBlockedResult(state);
      }
      if (state.entryMetas.has(action.entryLid)) {
        // lid 衝突(同 lid が再作成済み)── 黙って上書きしない(可視で止める)
        return {
          state: {
            ...state,
            // 🔴 内部の ID ではなく題名で言う(#1087)。user に見えない値を出さない
            error: `復元できません: 同じ ID のノート「${state.entryMetas.get(action.entryLid)?.title ?? '(無題)'}」が既にあります`,
          },
          events: [],
        };
      }
      const lastLid = state.order[state.order.length - 1];
      // 🔴 「元に戻す」は移す前の並びへ挿す(#1087)。ゴミ箱の一覧から戻すときは並びを知らないので末尾
      const entryOrder =
        action.entryOrder ??
        (lastLid ? (state.entryMetas.get(lastLid)?.entryOrder ?? 0) + 1 : 1);
      return {
        state,
        events: [
          {
            type: 'REQUEST_TRASH_RESTORE',
            entryLid: action.entryLid,
            revId: action.revId,
            entryOrder,
            ...(action.entryOrder !== undefined ? { explicitOrder: true } : {}),
            selectedAtIssue: state.selectedLid,
          },
        ],
      };
    }
    case 'UNDO_TRASH': {
      // ⚠ 起点で断る(`RESTORE_TRASH` と同じ ── 章の欄が開いている間は復元が選択を動かす)
      if (state.phase !== 'ready' || action.lids.length === 0) return { state, events: [] };
      if (state.sectionDraft !== null) return sectionDraftBlockedResult(state);
      return {
        state,
        events: [
          {
            type: 'REQUEST_TRASH_UNDO',
            lids: action.lids,
            ...(action.orders ? { orders: action.orders } : {}),
          },
        ],
      };
    }
    case 'PURGE_TRASH': {
      if (state.phase !== 'ready') return { state, events: [] };
      return {
        state,
        events: [{ type: 'REQUEST_TRASH_PURGE', ...(action.lid === undefined ? {} : { lid: action.lid }) }],
      };
    }
    /* ── 2 ペインタブファイラ(#241 段⑥)───────────────────────────
     * 🔴 **どれも `phase` を見ない**(= 編集中でも通る)。
     * ⚠ 直前の稿は `phase !== 'ready'` で黙って捨てていたが、それは #240 と P11 で
     *   2 度踏んだ**無言の操作拒否**そのものである ── 場所を移る・印を付けるは
     *   下書きに 1 バイトも触らないので、止める理由が無い(`SET_VIEW_MODE` が
     *   ヘルプ・設定を編集中に通すのと同じ判断:「書きながら置き場を眺める」)。
     * 🔑 **断りが要るのは「実際に動かす操作」だけ** ── そちらは `moveEntries` /
     *   `DELETE_ENTRIES` が既に**声に出して**断っている(判定を増やさない)。
     */
  }
}
