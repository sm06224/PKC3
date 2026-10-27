/**
 * reducer の slice: 起動・システムのメッセージの既読・ノートの選択・本文の読み込み(#1383)。
 *
 * 🔑 `app-state.ts` の `reduceCore` から**機械的に移した**(case 本体は 1 文字も変えていない)。
 *   `reduceCore` は label を列挙してここへ渡す ── `switch` の網羅検査は両側で効く
 *   (`reduceCore` に label が無ければ `reduceBoot` に届かず、ここに case が無ければ tsc が落ちる)。
 * ⚠ 履歴・2 ペインの掃除・バックリンクは `reduceWithHistory` の 1 か所で見る(ここでは見ない)。
 */

import {
  type AppState,
  type Dispatchable,
  ENTRY_GONE_NOTE,
  type ReduceResult,
  attachmentEntriesOf,
  dualPreviewTarget,
  keepCaptures,
  keepContacts,
  keepLinks,
  keepTasks,
  keepWorkLog,
  launcherReloadEvents,
  leavesOnSelect,
  placeBodiesOf,
  refreshSmartHits,
  refreshTaskCards,
  searchRefreshEvents,
} from '../app-state';
import type { PlaceExcerpt } from '@features/markdown/place-embed';
import { baseLidOfKey } from '@features/markdown/section-embed';
import { isSystemMessageLid } from '@features/message/message-log';
import { initialDual } from '@features/relation/dual-pane';
import { SMART_ARCHETYPE } from '@features/smart/smart-spec';

export type BootAction = Extract<Dispatchable, { type: 'SYS_BOOTED' | 'MESSAGES_UNREAD_SET' | 'MESSAGES_BODY_REFRESH' | 'SELECT_ENTRY' | 'MESSAGES_READ' | 'BODY_LOADED' | 'BODY_LOAD_FAILED' }>;

export function reduceBoot(state: AppState, action: BootAction): ReduceResult {
  switch (action.type) {
    case 'SYS_BOOTED': {
      const metas = new Map(action.metas.map((m) => [m.lid, m]));
      // entryOrder の tie は lid 辞書順で安定化(review P5b F3 ── trash 復元と
      // CREATE の並行採番は重複しうる。正準親の tie-break とも同じ規約)
      const order = [...action.metas]
        .sort((a, b) => a.entryOrder - b.entryOrder || a.lid.localeCompare(b.lid))
        .map((m) => m.lid);
      // 🔴 **同じ container への再読込なら選択を保つ**(2026-08-05、user 報告)。
      //
      // ここは元々「再 boot では旧選択・旧 openBody を持ち越さない」だった。
      // 意図は **container 切替**での lid 偶然衝突の防止(review F)で、それは正しい。
      // ただし取込は**同じ container の再読込**でもここを通る ── つまり
      // **md を 1 件開いただけで、いま読んでいたノートが画面から消えて**
      // 「左の一覧から選ぶと…」に戻っていた(実測)。
      //
      // ⚠ 保つ条件は 2 つとも要る:**cid が同じ**(別 container なら従来どおり捨てる)
      //    かつ **その lid が新しい一覧に在る**(消えたノートを選んだままにしない)。
      // ⚠ `openBody` は必ず捨てる ── 再読込で本文が変わっている可能性がある。
      //    代わりに `REQUEST_BODY` を出して**取り直す**(選択の意味論は SELECT_ENTRY と同じ)
      /**
       * 🔴 **システムのメッセージ / 処理の記録を開いているときも保つ**(#1087)。
       * ⚠ この 2 件は `entryMetas` に居ない(§1.1)ので、`metas.has` だけで検めると
       *   別タブが保存・改名・削除するたびに(300ms 後の再読込で)閉じて「何も選んでいない」へ戻っていた。
       *   居る場所が違うだけで消えてはいないので、保って**メッセージ用の口**で取り直す(`REQUEST_BODY` ではない)。
       */
      const keepsLid = (l: string): boolean => metas.has(l) || isSystemMessageLid(l);
      const keepLid =
        state.cid === action.cid && state.selectedLid !== null && keepsLid(state.selectedLid)
          ? state.selectedLid
          : null;
      /**
       * 🔴 **現在地と印も同じ規則で検める**(#240 の着地前レビュー 1)。
       *
       * ⚠ `SYS_BOOTED` は**別タブが書くたび**に飛ぶ(`main.ts` の 300ms 束ね)。
       *    選択だけ検めて `scopeLid` を素通りさせると、**別タブがそのフォルダを
       *    消した瞬間**に「現在地は在るが実体は無い」状態になり、表は 0 行・
       *    パンくずはルートだけ ── **データが全部消えたように見える**。
       *    そこで「+ ノート」を押すと親が付かず、作ったものも画面に出ない。
       * ⚠ 印(`selection`)も同じ ── 消えた lid が残ると「N 件を選んでいます」の
       *    帯だけが出て、まとめて削除が**画面に無いものを消す**。
       * ⚠ 別 container(`cid` 違い)なら全部捨てる ── lid の偶然衝突を持ち越さない。
       */
      const sameCid = state.cid === action.cid;
      const keepScope =
        sameCid && state.scopeLid !== null && metas.has(state.scopeLid) ? state.scopeLid : null;
      const keepMarks = sameCid ? state.selection.filter(keepsLid) : [];
      /**
       * ⚠ **別 container なら 2 ペインも畳む**(印の持ち越しと同じ判断)──
       * lid の偶然衝突で「他人のフォルダを開いた 2 枚のタブ」を残さない。
       * 🔑 同じ container のときの掃除は `reduce` の 1 か所がやる(`app-state.ts` の `reduceWithHistory` の注記)。
       */
      const keepDual = sameCid ? state.dual : initialDual;
      /**
       * 🔴 **読んでいたノートが、別のタブの操作で一覧から無くなったら、そう言う**(台帳 #1852 G2 / 依頼 298 A)。
       * ⚠ 直す前は何の知らせもなく「何も選んでいない」画面になり、データが消えたように見えた。
       *   取り込みの総入れ替えでもここを通るので、断定せず「ゴミ箱へ移されたかもしれません」と言う。
       */
      const lostReading =
        sameCid && state.selectedLid !== null && !keepsLid(state.selectedLid)
          ? state.entryMetas.get(state.selectedLid)?.title
          : undefined;
      const keepAnchor =
        sameCid && state.selectionAnchor !== null && keepsLid(state.selectionAnchor)
          ? state.selectionAnchor
          : null;
      return {
        state: {
          ...state,
          phase: 'ready',
          error: null,
          cid: action.cid,
          entryMetas: metas,
          order,
          relations: action.relations,
          selectedLid: keepLid,
          scopeLid: keepScope,
          dual: keepDual,
          ...(lostReading === undefined
            ? {}
            : {
                notice: `読んでいたノート「${lostReading}」が一覧から無くなりました(別のタブでゴミ箱へ移されたかもしれません。ゴミ箱から戻せます)`,
                noticeOpen: null,
                noticeCreate: null,
              }),
          selection: keepMarks,
          selectionAnchor: keepAnchor,
          openBody: null,
          freshLid: null,
          // 🔴 別の container なら、板・見出しの節の抜粋も捨てる(lid の偶然衝突で他人の本文を出さない)。
          //    同じ container の再読込では保つ(書込の追随は `syncShownBodies` が担う)
          placeBodies: sameCid ? state.placeBodies : new Map<string, PlaceExcerpt>(),
          // ⚠ 元ファイルの紐づけは**このセッションの持ち物**なので、同じ container の
          //    再読込では保つ(取込のたびに消えると、開いた直後に書き戻せなくなる)。
          //    ⚠ ただし**消えた lid は落とす** ── 居ない entry を指す導線を残さない
          linkedFiles: keepLinks(state, action.cid, metas),
          /**
           * 🔴 **集計の数字は再読込で捨てる**(レビュー C-1)。⚠ 取込はここを通るので、
           * 残すと「N 件のノートを見ました」が**古い数**のまま出続ける。
           * ⚠ 捨てるだけでは「数えています…」で止まるので、**面を開いていれば
           * 数え直しも頼む**(捨てる側と頼む側は対で要る)。
           * ⚠ 束ね方(`queryKey`)は端末の設定なので**保つ**。
           */
          queryKeys: null,
          queryGroups: null,
          queryFailed: false,
          /**
           * 🔴 **予定の札は、同じ container なら保って集め直す / 別なら捨てる**(#1087。連絡先と同じ作法)。
           * ⚠ 丸ごと `null` にすると、本体で保存するたびに**同じ中身を見ている別ウィンドウの予定表が
           *   「集めています…」の空表へ戻る**。消えた lid の札だけ落とす(`keepTasks`)。
           *
           * (以下は捨てていた頃の理由。別 container では今も当てはまる ── #277 段②-b)
           * ⚠ 取込はここを通るので、残すと**消えたノートの札**が盤面に残り、
           *   押すと「見つからない」になる。⚠ 捨てるだけでは「集めています…」で
           *   止まるので、**一度でも集めていれば集め直しも頼む**(対で要る)。
           */
          taskScan: keepTasks(state, sameCid, metas),
          taskScanFailed: false,
          // 🔴 **雛形も捨てる**(同じ理由)── 残すと**消えたノートの雛形**が
          //    `/` に並び、押すと本文が入らない(押しても何も起きない導線)
          snippetScan: null,
          /**
           * 🔴 **連絡先も再読込で検め直す**(#278 段③ の動線レビュー 2026-08-28)。
           *
           * ⚠ ここは **`contactScan` だけが漏れていた** ── 集計・予定・雛形は
           *   捨てて頼み直すのに、連絡先は表にも events にも居なかった。
           *   帰結は 2 つで、どちらも user のデータに触る:
           *   ① **取込はここを通る**ので、`.vcf` を 200 枚入れても一覧は
           *      「連絡先はまだありません」のまま ── user は「入らなかった」と読み、
           *      **同じ file をもう一度取り込んで 400 件になる**
           *      (`reload-snapshot.ts` が「二重取込が実データとして残る」と書いている形)
           *   ② ノートを消しても行が残り、押しても**何も起きない**
           *      (`SELECT_ENTRY` は居ない lid を黙って捨てる)
           * 🔑 直し方は**予定と同じにしない** ── あちらは丸ごと `null` にするが、
           *   連絡先で同じことをすると**別タブが書くたびに一覧が空へ飛ぶ**
           *   (`SYS_BOOTED` は 300ms 束ねで頻繁に飛ぶ。`REFRESH_CONTACT_SCAN` が
           *   「消すと行が飛ぶ」とわざわざ書いているのはそのため)。
           * 🔑 だから**消えた lid だけ落として頼み直す** ── この reducer が
           *   `selection` に対して既にやっている形と同じである(`keepMarks`)。
           */
          contactScan: keepContacts(state, sameCid, metas),
          /**
           * 🔴 **録ったものも同じ扱い**(#683 段①。上の `contactScan` と対)。
           * ⚠ 丸ごと `null` にしない ── `SYS_BOOTED` は別タブが書くたびに飛ぶので、
           *   捨てると一覧が「集めています…」へ落ちて**行が飛ぶ**。
           * ⚠ 落とさないと、**消したノートの行が残って押しても何も起きない**。
           */
          captureItems: keepCaptures(state, sameCid, metas),
          // 🔴 計った時間も同じ扱い(#683 ①)── 丸ごと `null` にしない / 消えたノートの行は落とす
          workLogScan: keepWorkLog(state, sameCid, metas),
          /**
           * 🔴 **履歴・ごみ箱の開いた面は、同じ container なら保って取り直す / 別なら畳む**(#1087)。
           * ⚠ 別タブの書込はここを通るが、今まで `...state` で素通りだった ── 履歴の面は
           *   **別タブが保存した版が増えない**。ノートが消えていれば畳む(居ない lid の履歴を出さない)。
           * ⚠ 前の答えは取り直しが届くまで保つ(ちらつかせない)。
           */
          revisionPanel:
            sameCid && state.revisionPanel !== null && metas.has(state.revisionPanel.lid)
              ? state.revisionPanel
              : null,
          trashPanel: sameCid ? state.trashPanel : null,
        },
        events: [
          ...(keepLid === null
            ? []
            : [
                isSystemMessageLid(keepLid)
                  ? { type: 'REQUEST_MESSAGES_BODY' as const, lid: keepLid }
                  : { type: 'REQUEST_BODY' as const, lid: keepLid },
              ]),
          // 🔴 参照元・履歴・ごみ箱・横に留めた枠・板の抜粋も、別タブの書込で古くなる(#1087)。
          //    題名 / 件数が同じだと `entryListChanged` では取り直されないので、ここで頼む。
          ...(keepLid !== null && !isSystemMessageLid(keepLid) && state.backlinks !== null
            ? [{ type: 'REQUEST_BACKLINKS' as const, lid: keepLid }]
            : []),
          ...(sameCid && state.revisionPanel !== null && metas.has(state.revisionPanel.lid)
            ? [{ type: 'REQUEST_REVISION_LIST' as const, lid: state.revisionPanel.lid }]
            : []),
          ...(sameCid && state.trashPanel !== null ? [{ type: 'REQUEST_TRASH_LIST' as const }] : []),
          // ⚠ 本文は捨てない(返事が届くまで今の字を映す)。留めた枠は読むだけの面なので、
          //    編集中の打鍵を上書きしない(編集の入れ物は `openBody` / 編集 draft で別)
          ...(sameCid
            ? state.splitLids
                .filter((l) => metas.has(l))
                .map((l) => ({ type: 'REQUEST_SPLIT_BODY' as const, lid: l }))
            : []),
          ...(sameCid
            ? [...placeBodiesOf(state).keys()]
                .filter((k) => metas.has(baseLidOfKey(k)))
                .map((k) => ({ type: 'REQUEST_PLACE_BODY' as const, lid: k }))
            : []),
          // 🔴 取込・別タブの変更で本文が変わっている ── 絞っている語で撃ち直す(#1087)
          ...searchRefreshEvents(state),
          // 🔴 2 ペインの下見も撃ち直す(#1087)── 別タブが書くと古い本文のままだった。
          //    消えた行・畳んだ下見には撃たない。前の本文は届くまで保つ(ちらつかせない)
          ...(sameCid &&
          state.dual.previewOn &&
          state.dual.preview !== null &&
          metas.has(state.dual.preview.lid) &&
          dualPreviewTarget(state, state.dual) === state.dual.preview.lid
            ? [{ type: 'REQUEST_DUAL_PREVIEW' as const, lid: state.dual.preview.lid }]
            : []),
          ...(state.viewMode === 'query'
            ? [{ type: 'REQUEST_QUERY_SCAN' as const, key: state.queryKey }]
            : []),
          /**
           * 🔴 **予定は「開いているか」ではなく「一度でも集めたか」で頼み直す**
           * (#292 段⑤、2026-08-23)。
           *
           * ⚠ 中央の面だった頃は `state.viewMode === 'kanban'` で足りたが、
           *   予定は**左の列のタブ**になったので、reducer からは開いているか
           *   どうかが見えない(`BrowseMode` は state に持たせていない ──
           *   「どう探すか」は画面側の都合で container のデータではない)。
           * 🔑 だから**直前に札を持っていたか**で決める ── 持っていたなら
           *   その user は予定を開いており、いま `null` に落としたので
           *   頼み直さないと**「集めています…」で止まったまま**になる。
           * ⚠ 一度も開いていない user には撃たない(全ノートの走査を、
           *   予定を使わない user に負わせない ── 集計と同じ流儀)。
           * ⚠ **判定を `main.ts` へ出さない** ── あちらはどの test からも
           *   実行されない(CLAUDE.md §2)。
           */
          ...(state.taskScan === null ? [] : [{ type: 'REQUEST_TASK_SCAN' as const }]),
          /**
           * 🔴 **開いているスマートフォルダも集め直す**(#1087。予定・連絡先・録ったものと同じ作法)。
           * ⚠ `smartHits` は持ち越されるので、別タブがタグを足す・外す / 取り込みで `SYS_BOOTED` が来ても
           *   撃ち直さないと**中身が古いまま追随しない**。「一度でも集めた」= `smartHits` に居る物だけ撃つ
           *   (一度も開いていないスマートフォルダには走査を負わせない)。
           * ⚠ 消えたノート・別のコレクションの lid には撃たない。
           */
          ...(sameCid
            ? [...state.smartHits.keys()]
                .filter((l) => metas.get(l)?.archetype === SMART_ARCHETYPE)
                .map((l) => ({ type: 'REQUEST_SMART_SCAN' as const, lid: l }))
            : []),
          /**
           * 🔴 **連絡先も頼み直す**(上の `contactScan` と対)。
           * ⚠ 落とすだけでは、**取り込んだ 200 件が 1 件も現れない** ──
           *   集め直しの合図は「左のタブを連絡先へ切り替えたとき」1 か所しか
           *   無いので、タブを開いたままの user には永久に届かない。
           * ⚠ 一度も開いていない user には撃たない(全ノートの走査を、
           *   連絡先を使わない user に負わせない ── 予定・集計と同じ流儀)。
           */
          ...(state.contactScan === null ? [] : [{ type: 'REQUEST_CONTACT_SCAN' as const }]),
          // 🔴 計った時間も頼み直す(#683 ①。一度も開いていない user には撃たない)
          ...(state.workLogScan === null ? [] : [{ type: 'REQUEST_WORK_LOG_SCAN' as const }]),
          /**
           * 🔴 **アプリ一覧のタイルとグループも頼み直す**(#1087。上の連絡先と対)。
           * ⚠ 落とさずに素通りしていたので、別タブの書込・取り込みの再読込・改名・ごみ箱で
           *   **旧名や消した物のタイルが残り、押すとごみ箱の物を開いた**。
           * ⚠ 一度も開いていない user には撃たない(`launcherTiles === null`)。
           * ⚠ **新しい `order` / `metas` で数える**(取り込んだ添付を載せるため)。
           */
          ...(state.launcherTiles === null ? [] : launcherReloadEvents(order, metas, state.appGroupGen)),
          /**
           * 🔴 **録ったものも頼み直す**(#683 段①。上の連絡先と対)。
           * ⚠ 落とすだけでは、**取り込んだ録音が 1 件も現れない** ── 集め直しの
           *   合図は「タブを開いたとき」しか無いので、開いたままの user には届かない。
           * ⚠ 一度も開いていない user には撃たない(添付の本文の走査を、
           *   この面を使わない user に負わせない ── 予定・連絡先と同じ流儀)。
           */
          ...(state.captureItems === null
            ? []
            : [
                {
                  type: 'REQUEST_CAPTURE_ITEMS' as const,
                  /**
                   * ⚠ **新しい `metas` / `order` で数える** ── `state`(古い方)から
                   *   採ると、いま取り込んだ添付が 1 件も載らない
                   *   (取込はこの枝を通るので、それが本命の場面である)。
                   */
                  entries: attachmentEntriesOf(order, metas),
                },
              ]),
        ],
      };
    }
    case 'MESSAGES_UNREAD_SET': {
      // ⚠ 値を写すだけ ── 「注意 / 問題だけ数える」判定は countUnread(features 層)側
      if (state.messagesUnread === action.count) return { state, events: [] };
      return { state: { ...state, messagesUnread: action.count }, events: [] };
    }
    case 'MESSAGES_BODY_REFRESH': {
      // ⚠ 開いているそのノートだけ。`BODY_LOADED` も編集中 / 別の選択なら捨てるので、ここで先に止める
      if (state.selectedLid !== action.lid || state.phase !== 'ready') return { state, events: [] };
      return { state, events: [{ type: 'REQUEST_MESSAGES_BODY', lid: action.lid }] };
    }
    case 'SELECT_ENTRY': {
      if (state.phase === 'editing') return { state, events: [] }; // 編集中は選択遷移しない
      // error phase(= persist 失敗)でも遷移しない ── openBody の baseline が
      // 「disk 未達 commit の唯一の写し」であり、選択遷移は無警告破棄になる
      // (P3-6b review #2)。出口は 再保存(RETRY_PERSIST)
      if (state.phase === 'error') return { state, events: [] };
      if (!state.entryMetas.has(action.lid)) return { state, events: [] };
      // 同一 lid でも openBody が確立していなければ再要求する
      // (読み失敗後の再クリックが自然な retry になる ── review C)
      // 🔴 **設定を開いたまま一覧を押したら、中央をノートへ戻す**(P8 段⑲)。
      //    直す前は右の情報ペインだけ切り替わり、中央は設定のまま・追記欄も
      //    消えたままで、ノートが開かない理由が画面のどこにも無かった
      //    (マニュアル「行の右クリックから整理する」の「中央は常にいま開いているノート」の当の破れ)
      // 🔴 **`isAsidePane` ではない**(#906)── SQL の面は退かない(`app-state.ts` の `leavesOnSelect`)
      const leaveSettings = leavesOnSelect(state.viewMode);
      if (state.selectedLid === action.lid && state.openBody?.lid === action.lid) {
        /**
         * 🔴 **すでに開いている行を素で押したときも、印は 1 件へ戻す**(#240 段②)。
         *
         * ⚠ ここは「同じノートをもう一度押した」だけの早期 return だが、
         * **印(複数選択)はその外に在る** ── 直す前は 3 件に印を付けたあと、
         * そのうちの 1 件を素で押しても**印が 3 件のまま**だった(実ブラウザ smoke で
         * 判明。unit は「別の行を押す」筋しか通っていなかった)。
         * 🔑 修飾なしのクリックは「これだけを相手にする」の意味なので、
         *   どの行を押したかに関わらず印は 1 件になる。
         */
        const marks =
          state.selection.length === 1 && state.selection[0] === action.lid
            ? state
            : { ...state, selection: [action.lid], selectionAnchor: action.lid };
        return leaveSettings
          ? { state: { ...marks, viewMode: 'detail' as const }, events: [] }
          : { state: marks, events: [] };
      }
      // 選択が変わったら旧 openBody は破棄(速やかな破棄の原則)し、新 body を要求。
      // 🔴 **知らせは選択で消えない**(設計 doc §7、段②a)── 「注意 / 問題」を
      // 消せるのは「メッセージ」のノートを開いたとき(`MESSAGES_READ`)だけ。
      return {
        state: {
          ...state,
          ...(leaveSettings ? { viewMode: 'detail' as const } : {}),
          selectedLid: action.lid,
          /**
           * ⚠ **印は 1 件へ置き換える**(#240 段②)── 修飾なしのクリックは
           * 「これだけを相手にする」の意味。`Ctrl` / `Shift` は別の action で入る。
           */
          selection: [action.lid],
          selectionAnchor: action.lid,
          openBody: null,
          revisionPanel: null, // panel は選択に従属(P5b)
          // ⚠ 見ていた版も畳む(#398 段②)── 一覧が畳まれたら差分は孤児になる
          revisionPreview: null,
        },
        events: [{ type: 'REQUEST_BODY', lid: action.lid }],
      };
    }
    case 'MESSAGES_READ': {
      /**
       * 🔴 **メッセージ(system 領域のノート)を開く**(設計 doc §7、段②a)。
       *
       * ⚠ `SELECT_ENTRY` と**同じ形の遷移**だが、`state.entryMetas.has(lid)` は
       *   通さない(system 領域のノートは `entryMetas` に無い ── §1.1)。
       * ⚠ **編集中 / error phase では遷移しない**(`SELECT_ENTRY` と同じ理由 ──
       *   openBody の baseline が disk 未達 commit の唯一の写しである)。
       */
      if (state.phase === 'editing' || state.phase === 'error') return { state, events: [] };
      const leaveSettings = leavesOnSelect(state.viewMode);
      return {
        state: {
          ...state,
          ...(leaveSettings ? { viewMode: 'detail' as const } : {}),
          selectedLid: action.lid,
          selection: [action.lid],
          selectionAnchor: action.lid,
          openBody: null,
          revisionPanel: null,
          revisionPreview: null,
          // 🔴 **既読はここで消える**(§7)── 選ぶだけでは消えない(直前の case の注記)。
          error: null,
          messagesUnread: 0,
        },
        events: [{ type: 'REQUEST_MESSAGES_BODY', lid: action.lid }],
      };
    }
    case 'BODY_LOADED': {
      // 編集中は受理しない ── 遅延到着の応答が入力中の body/baseline を
      // 巻き戻す事故の防止(review B)
      if (state.phase === 'editing') return { state, events: [] };
      // 応答が現選択と食い違う(遅延到着)なら捨てる ── stale 反映防止
      if (state.selectedLid !== action.lid) return { state, events: [] };
      return {
        state: {
          ...state,
          // 🔴 **`error` はここで消さない**(設計 doc §7、段②a)。
          openBody: {
            lid: action.lid,
            body: action.body,
            baseline: action.body,
            persisted: action.body,
            diskAhead: false,
          },
          /**
           * ⚠ **disk の本文は、板の走査より新しいことがある**(別タブが書いた等)。
           *   組み直さないと、その 1 件だけ古い行番号を指したまま押せる。
           * 🔑 板を開いていなければ即 `null` で返るので、実費はほぼ無い。
           */
          taskScan: refreshTaskCards(state.taskScan, action.lid, action.body),
          // 🔑 タグが変われば、開いている入れ物の中身も変わる(#421 / user 要望 2026-08-26)
          smartHits: refreshSmartHits(
            state.smartHits,
            action.lid,
            action.body,
            state.entryMetas,
          ),
        },
        events: [],
      };
    }
    case 'BODY_LOAD_FAILED': {
      if (state.selectedLid !== action.lid) return { state, events: [] };
      // phase は落とさない(読み失敗はアプリ死ではない ── 再クリックが retry)。
      // エラーは state に持つ: 次の成功 / 選択までステータスに残る
      return {
        state: { ...state, error: action.error === ENTRY_GONE_NOTE ? ENTRY_GONE_NOTE : `本文を読み込めませんでした: ${action.error}` },
        events: [],
      };
    }
  }
}
