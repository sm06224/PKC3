/**
 * reducer の slice: ノートの復元とごみ箱の消去の結果(#1383)。
 *
 * 🔑 `app-state.ts` の `reduceCore` から**機械的に移した**(case 本体は 1 文字も変えていない)。
 *   `reduceCore` は label を列挙してここへ渡す ── `switch` の網羅検査は両側で効く
 *   (`reduceCore` に label が無ければ `reduceRestore` に届かず、ここに case が無ければ tsc が落ちる)。
 * ⚠ 履歴・2 ペインの掃除・バックリンクは `reduceWithHistory` の 1 か所で見る(ここでは見ない)。
 */

import {
  type AppState,
  type Dispatchable,
  type ReduceResult,
  insertByOrder,
  mergeRelations,
  refreshSmartHits,
  refreshTaskCards,
  restoreKeepsSelection,
  revisionRestoredNotice,
  syncShownBodies,
  trashRestoredNotice,
} from '../app-state';

export type RestoreAction = Extract<Dispatchable, { type: 'ENTRY_RESTORED' | 'TRASH_PURGED' }>;

export function reduceRestore(state: AppState, action: RestoreAction): ReduceResult {
  switch (action.type) {
    case 'ENTRY_RESTORED': {
      // 🔒 編集中の着弾(review P5b F1 ── 反例実験で draft 全損と editor
      // 乗っ取りを実証): 選択と editor は絶対に乗っ取らない。
      // - 同一 lid: disk 先行の印だけ付ける(TODO_TOGGLED の editing 分岐と同じ
      //   意味論 ── 変更あり commit は draft が勝ち、無変更 commit / cancel は
      //   disk = 復元内容が勝つ)
      // - 別 lid: ゴミ箱からの復元は一覧にだけ足す(下)/ 履歴復元は破棄(復元は disk 側で完了済み)
      if (state.phase === 'editing') {
        if (state.openBody?.lid === action.meta.lid) {
          return {
            state: {
              ...state,
              entryMetas: new Map(state.entryMetas).set(action.meta.lid, action.meta),
              openBody: { ...state.openBody, persisted: action.body, diskAhead: true },
              ...syncShownBodies(state, action.meta.lid, action.body),
            },
            events: [],
          };
        }
        /**
         * 🔴 **別のノートをゴミ箱から戻した着弾は、一覧にだけ足す**(#1087)。
         * ⚠ 直す前は破棄していた ── 「元に戻す」の途中で編集に入ると、戻したノートが画面の一覧に出ず
         *   (再読み込みまで見えない)、「元に戻す」だけが使われた扱いになっていた。
         * 🔑 選択と開いている本文には触らない(編集を乗っ取らない)。居る物の二重復元は従来どおり捨てる。
         */
        if (action.mode === 'trash' && !state.entryMetas.has(action.meta.lid)) {
          const metasE = new Map(state.entryMetas).set(action.meta.lid, action.meta);
          return {
            state: {
              ...state,
              entryMetas: metasE,
              order: state.order.includes(action.meta.lid)
                ? state.order
                : insertByOrder(state.order, action.meta.lid, metasE),
              relations: mergeRelations(state.relations, action.relations ?? []),
              trashPanel: state.trashPanel
                ? { items: state.trashPanel.items.filter((t) => t.entryLid !== action.meta.lid) }
                : null,
            },
            events: [],
          };
        }
        return { state, events: [] };
      }
      if (state.phase !== 'ready') return { state, events: [] };
      // 整合判定(review P5b F2): 履歴復元は entry が居るのが前提 ── 発行後に
      // 削除されていたら破棄(disk も queue 直列で「復元 → 削除」の順に終わって
      // おり、捨てる = 整合)。trash 復元は居ないのが前提(二重復元の後着を破棄)
      const exists = state.entryMetas.has(action.meta.lid);
      if (action.mode === 'revision' ? !exists : exists)
        return { state, events: [] };
      // 履歴復元(既存 meta 置換)と trash 復元(再出現)の合流点。復元先を
      // 選択して結果を見せる。openBody は disk 確定値で確立(persisted = body)
      const entryMetas = new Map(state.entryMetas).set(action.meta.lid, action.meta);
      /**
       * 🔴 **履歴の復元が着く前に別のノートを選んでいたら、選択を奪い返さない**(#1087)。
       * ⚠ 直す前は無条件に `selectedLid` と `openBody` を差し替えていた ── 戻すを押した直後に別のノートを押すと、
       *   押したノートが開かず、戻したノートへ引き戻されていた(押したのに何も起きないように見える)。
       * 🔑 戻したこと自体は言う(書込は済んでいる)。並び・本文の画面は選んでいるノートのまま。
       */
      if (action.mode === 'trash' && restoreKeepsSelection(state, action)) {
        /**
         * 🔴 **ゴミ箱から戻した着弾も同じ**(#1087)── 頼んでから着くまでの間に別のノートを選び直していたら、
         *   選択と開いている本文は動かさず、戻したことは一覧と知らせで言う(居場所も戻す)。
         */
        const metasK = new Map(state.entryMetas).set(action.meta.lid, action.meta);
        const orderK = state.order.includes(action.meta.lid)
          ? state.order
          : insertByOrder(state.order, action.meta.lid, metasK);
        const relationsK = mergeRelations(state.relations, action.relations ?? []);
        return {
          state: {
            ...state,
            entryMetas: metasK,
            order: orderK,
            relations: relationsK,
            trashPanel: state.trashPanel
              ? { items: state.trashPanel.items.filter((t) => t.entryLid !== action.meta.lid) }
              : null,
            notice: trashRestoredNotice(action.meta.lid, relationsK, metasK),
            restoreUndo: null,
            noticeOpen: null,
            noticeCreate: null,
          },
          events: [],
        };
      }
      if (action.mode === 'revision' && state.selectedLid !== action.meta.lid) {
        return {
          state: {
            ...state,
            entryMetas,
            ...syncShownBodies(state, action.meta.lid, action.body),
            taskScan: refreshTaskCards(state.taskScan, action.meta.lid, action.body),
            smartHits: refreshSmartHits(state.smartHits, action.meta.lid, action.body, state.entryMetas),
            notice:
              action.notice ??
              revisionRestoredNotice(
                state.entryMetas.get(action.meta.lid)?.title ?? action.meta.title,
                action.meta.title,
                action.fromUndo === true,
              ),
          },
          events: [],
        };
      }
      /**
       * 🔴 **元の位置へ戻す**(2026-08-06。user 報告 2-9)。
       *
       * 直す前は `[...state.order, lid]` = **末尾に飛んでいた**。並びの規則は
       * boot と同じ「`entryOrder` 昇順・同値は lid」なので、**その規則で挿す**
       * ── 別の規則を書かない(復元だけ並びが違う、を作らない)。
       */
      const order = state.order.includes(action.meta.lid)
        ? state.order
        : insertByOrder(state.order, action.meta.lid, entryMetas);
      /**
       * 🔴 **居場所を戻す**(同上)。disk の relations は消えていないので、
       * 効果層が読み直したものを常駐へ合流させる。
       * ⚠ **同じ id は上書き**(二重復元で関係が 2 本にならない)。
       */
      const relations = mergeRelations(state.relations, action.relations ?? []);
      const trashPanel = state.trashPanel
        ? {
            items: state.trashPanel.items.filter(
              (t) => t.entryLid !== action.meta.lid,
            ),
          }
        : null;
      return {
        state: {
          ...state,
          entryMetas,
          order,
          relations,
          trashPanel,
          revisionPanel: null,
          // ⚠ 見ていた版も畳む(#398 段②)── 一覧が畳まれたら差分は孤児になる
          revisionPreview: null,
          selectedLid: action.meta.lid,
          // 🔴 留めた枠・板の抜粋も新しい本文へ(#1087)── 主の枠だけ追随すると、同じノートを留めた枠が古い本文のまま残る
          ...syncShownBodies(state, action.meta.lid, action.body),
          openBody: {
            lid: action.meta.lid,
            body: action.body,
            baseline: action.body,
            persisted: action.body,
            diskAhead: false,
          },
          /**
           * 🔴 **復元も「新しい本文が state に入る所」である**(2026-08-20 に判明)。
           *
           * ⚠ 履歴の復元も ゴミ箱からの復元も、本文を**丸ごと**入れ替える ──
           *   板を開いたまま古い版へ戻すと、札は**入れ替わる前の行番号**を指したまま
           *   押せる。押すと**別の行が黙って完了になる**(#277 段②-b と同じ形)。
           * 🔑 この漏れは、手で数え直したのではなく **`tests/repo-hygiene.test.ts` が
           *   reducer を全数走査して見つけた** ── 宣言(「2 か所だけ」)を信じて
           *   いた間は、2 つとも見えていなかった。
           * ⚠ 上の editing 分岐は `persisted` の印だけを付ける(本文を差し替えない)
           *   ので、こちらは通さない ── そもそも編集中に板は開けない。
           */
          taskScan: refreshTaskCards(state.taskScan, action.meta.lid, action.body),
          // 🔑 タグが変われば、開いている入れ物の中身も変わる(#421 / user 要望 2026-08-26)
          smartHits: refreshSmartHits(
            state.smartHits,
            action.meta.lid,
            action.body,
            state.entryMetas,
          ),
          error: null,
          /**
           * 🔴 **履歴から戻したら、戻したことを言う**(#1087 の見直し 2026-10-13)。
           * ⚠ 直す前は履歴の一覧が畳まれるだけで、何も出なかった ── 押した人には
           *   戻ったのか分からず、取り消し方(画面の下の「元に戻す」/ 履歴から戻す前の版を選ぶ)も見えない。
           * 🔴 **ゴミ箱から戻したときも、ここで言う**(#1087)── 直す前は、移した直後の「元に戻す」(binder の `undo-trash`)
           *   だけが「ゴミ箱から元に戻しました」を出し、**ゴミ箱の一覧の「ゴミ箱から戻す」は何も出なかった**。
           *   戻った先のフォルダが分かるときは、その題名も言う(居場所は `relations` から引く ── `order` と同じく合流後の値)。
           */
          ...(action.mode === 'trash'
            ? {
                notice: trashRestoredNotice(action.meta.lid, relations, entryMetas),
                restoreUndo: null,
                noticeOpen: null,
                noticeCreate: null,
              }
            : {}),
          ...(action.mode === 'revision'
            ? {
                // 🔴 「元に戻す」から来たときは、同じ字を出し続けない(#1087)。
                //   さらに「元に戻す」を出すと、押すたびに同じ字のまま 2 つの本文を行き来する ──
                //   もとの版は履歴に残っているので、続けて戻すのは履歴から選ぶ。
                notice:
                  action.notice ??
                  revisionRestoredNotice(
                    state.entryMetas.get(action.meta.lid)?.title ?? action.meta.title,
                    action.meta.title,
                    action.fromUndo === true,
                  ),
                // ⚠ 知らせの字そのものも持つ ── 画面の下に出ている字がこの知らせのときだけ「元に戻す」を出す
                restoreUndo:
                  (action.undoRevId === undefined && action.undoTitle === undefined) || action.fromUndo === true
                    ? null
                    : {
                        lid: action.meta.lid,
                        revId: action.undoRevId ?? '',
                        notice:
                          action.notice ??
                          revisionRestoredNotice(
                            state.entryMetas.get(action.meta.lid)?.title ?? action.meta.title,
                            action.meta.title,
                            false,
                          ),
                        ...(action.undoTitle === undefined ? {} : { title: action.undoTitle }),
                      },
                noticeOpen: null,
                noticeCreate: null,
              }
            : {}),
        },
        events: [],
      };
    }
    case 'TRASH_PURGED': {
      /**
       * 🔴 **消したあとに、何が起きたかと、残る物を言う**(台帳 #1852 G1 / 依頼 140 ③、G2 / 依頼 301 A)。
       * ⚠ 直す前は一覧が「空です」になるだけで知らせが無かった。消したノートの添付ファイルの中身は端末に残ったままで、
       *   容量を空けるのは別の「使われていない添付を消す」だけ ── 押した人はそれを知らないと容量が減らず戸惑う。
       * ⚠ 件数は**ノートの数**(一覧の行)で数える ── `purged` は履歴の版の数で、ノート数ではない。
       */
      const items = state.trashPanel?.items ?? null;
      const only = action.lid;
      const tail = '添付ファイルの分の容量は、システムの「使われていない添付を消す」で空きます';
      const notice =
        only !== undefined
          ? `「${items?.find((t) => t.entryLid === only)?.title ?? '(無題)'}」を完全に消しました(${tail})`
          : items === null || items.length === 0
            ? null
            : `ゴミ箱を空にしました(${String(items.length)} 件を消しました。${tail})`;
      return {
        state: {
          ...state,
          trashPanel: state.trashPanel
            ? { items: only === undefined ? [] : state.trashPanel.items.filter((t) => t.entryLid !== only) }
            : null,
          ...(notice === null ? {} : { notice, noticeOpen: null, noticeCreate: null }),
        },
        events: [],
      };
    }
  }
}
