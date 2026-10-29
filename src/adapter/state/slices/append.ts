/**
 * reducer の slice: 追記・書込の打ち切り・追記の取り消し(#1383)。
 *
 * 🔑 `app-state.ts` の `reduceCore` から**機械的に移した**(case 本体は 1 文字も変えていない)。
 *   `reduceCore` は label を列挙してここへ渡す ── `switch` の網羅検査は両側で効く
 *   (`reduceCore` に label が無ければ `reduceAppend` に届かず、ここに case が無ければ tsc が落ちる)。
 * ⚠ 履歴・2 ペインの掃除・バックリンクは `reduceWithHistory` の 1 か所で見る(ここでは見ない)。
 */

import {
  AGENT_APPEND_BATCH,
  APPEND_BUSY_NOTE,
  APPEND_OPEN_BLOCK_REFUSAL,
  type AppState,
  type Dispatchable,
  type ReduceResult,
  bodyWriteBlockResult,
  nextLastAppend,
  refreshSmartHits,
  refreshTaskCards,
  screenBodyOf,
  syncShownBodies,
} from '../app-state';
import { endsInsideOpenBlock } from '@features/markdown/place-notation';

export type AppendAction = Extract<Dispatchable, { type: 'APPEND_TO_ENTRY' | 'FORCE_RELEASE_LOCK' | 'ENTRY_APPENDED' | 'UNDO_APPEND' | 'UNDO_AGENT_APPEND' | 'APPEND_FAILED' }>;

export function reduceAppend(state: AppState, action: AppendAction): ReduceResult {
  switch (action.type) {
    /**
     * 🔑 **追記**(P8 段⑧)。編集画面を開かず、末尾に足して**直に disk へ書く**。
     *
     * ⚠ **編集中のノート自身へは断る + ロック**。編集中のノートへ裏で書くと、
     * 保存で上書きされて追記が消える。書込中の二重要求も断る(直列 queue には載るが、
     * 2 通目の基底が 1 通目の結果になるかは queue 実装に依存させない)。
     * ⚠ **本文を event に載せない** ── effect が disk から読み直す。画面が持つ
     * 本文を基底にすると、別経路(toggle / 復元)の書込を巻き戻す。
     *
     * 🔴 **断るなら声に出す**(#1051)。⚠ 直す前は 1 行目が `phase !== 'ready'`、
     *   2 行目が `writeLock` で、どちらも `{ state, events: [] }` を返して
     *   **黙って捨てて**いた。🔴 実害の形:①保存の往復が返る前に「追記」を
     *   押すと、**何も起きず理由も出ない**(`format-bar.smoke.spec.ts` が混んだ回に
     *   踏んだ)②予定の面の「足す」は押した直後に欄を空にするので、
     *   **打った字ごと消えていた**(binder の `schedule-quick-add`)。
     * 🔑 断る条件は**本文を書き換える他の操作と同じ門**(`bodyWriteBlockReason`。
     *   C6 / #1043)── 編集中でも**別のノート**へは通す。⚠ 安全の根拠は 2 つ:
     *   ①`ENTRY_APPENDED` が `openBody` を差し替えるのは `openBody.lid` が一致する
     *   ときだけで、編集中のノート自身へは上の門が通さない ②書込中のノートの編集には
     *   入れない(`START_EDIT` の `writeLock` の門)。
     */
    case 'APPEND_TO_ENTRY': {
      const blockedResult = bodyWriteBlockResult(state, action.lid, '追記してください');
      if (blockedResult !== null) return blockedResult;
      if (state.writeLock) return { state: { ...state, error: APPEND_BUSY_NOTE }, events: [] };
      /**
       * 🔴 **章の欄が、この lid で開いていれば断る**(#1044 段2 2巡目の修理、R11)
       *   ── 上の門(`bodyWriteBlockResult`)がこれも見ている。
       *
       * ⚠ R11 の前は章の欄を見る門が無く、`phase` は章の欄の間も `ready` のままなので
       *   素通りした ── file を落として置き所が解けなかった回(末尾へ
       *   落ちる回。`attach.ts` の `putAssetIntoNote`)は `INSERT_LINES`
       *   (`bodyRewriteGate` 経由で `bodyWriteBlockReason` を通る)ではなく
       *   **ここ**(`APPEND_TO_ENTRY`)を通るので、章の下書きが持つ古い原文の
       *   すぐ下へ本文が直に書き換わっていた(下書きは気づかず、保存すると
       *   その 1 行が消える)。
       * 🔑 `INSERT_LINES` と**同じ関数**(`bodyWriteBlockReason`)で見る
       *   (§7:同じ判定を複数の場所に書かない)。
       */
      const meta = state.entryMetas.get(action.lid);
      if (!meta) return { state, events: [] };
      if (action.text.trim() === '') return { state, events: [] }; // 空の追記は作らない
      // 🔴 末尾へ足す回で、画面の本文の末尾が閉じていないブロックの中なら、押した時点で理由を言う
      //   (`ADD_PLACE` と同じ関数。画面に無いノートは書込側 = effect が同じ条件で断る)
      if (action.target === null) {
        const shown = screenBodyOf(state, action.lid);
        if (shown !== null && endsInsideOpenBlock(shown))
          return { state: { ...state, error: APPEND_OPEN_BLOCK_REFUSAL }, events: [] };
      }
      return {
        state: { ...state, writeLock: { lid: action.lid }, revisionPanel: null, revisionPreview: null },
        events: [
          {
            type: 'REQUEST_APPEND',
            lid: meta.lid,
            gen: state.lockGen,
            title: meta.title,
            archetype: meta.archetype,
            entryOrder: meta.entryOrder,
            heading: action.heading,
            text: action.text,
            target: action.target,
            ...(action.batch === undefined ? {} : { batch: action.batch }),
          },
        ],
      };
    }
    /**
     * 🔴 **強制解放**(user 指示 2026-08-03)。
     * ⚠ **世代を上げる**のが本体 ── 解放しただけだと、飛んでいる書込の ack が
     * 後から着いて user が見ている本文を巻き戻す。世代が変われば古い ack は捨てる。
     *
     * 🔴 **章の欄の保存中にも効く**(#1044 段2 4巡目の修理、T1)。⚠ 直す前は
     *   `writeLock` / `tileWrite` しか見ておらず、章の欄が `saving: true` のまま
     *   詰まったとき **逃げ道が 1 つも無かった**(2 つのボタンは押せず(`saving` の
     *   間は disable)、離れる操作は外側の門(`guardSectionDraftTransition`)が
     *   断り続け、`F5` 以外に出口が無かった)。
     * 🔑 **追記(`writeLock`)と同じ「打ち切る」作法を移す** ── ただし章の欄は
     *   `writeLock` を握らない(追記と違う lock の器)ので、ここで
     *   `sectionDraft.saving` を直に解く。⚠ **discardDraft では捨てない** ──
     *   章の欄は「箱と書きかけは残す(user がコピーできる)」が設計(T1)。
     *   `lockGen` はここで必ず上がるので、その後に遅れて届く `SECTION_SAVED` /
     *   `SECTION_SAVE_FAILED` は **`gen` 不一致で無視される**(両 reducer が
     *   既に `action.gen !== state.lockGen` を見ている)── 打ち切った箱を
     *   後着の ack が閉じたり書き換えたりしない。
     */
    case 'FORCE_RELEASE_LOCK': {
      /**
       * 🔴 **捨てる下書きは、錠を握っていたノートの物だけ**(#1081)。
       * ⚠ 直す前は `phase === 'editing'` だけを見ていた ── #1051 から、ノート A の編集中に
       *   別のノート B への追記が錠を握れる(`APPEND_TO_ENTRY` は別のノートなら編集中も通す)。
       *   B の書込が詰まって打ち切ると、**無関係な A の打ちかけが消えていた**。
       * ⚠ いま `discardDraft: true` を撃つ口は無い(`binder.ts` の `force-release` は `false`
       *   だけ)── 口を足した日に静かに消さないための門である。
       */
      const lockedLid = state.writeLock?.lid ?? state.tileWrite?.lid ?? null;
      const draft =
        action.discardDraft &&
        state.phase === 'editing' &&
        state.openBody &&
        (lockedLid === null || lockedLid === state.openBody.lid);
      const section = state.sectionDraft;
      return {
        state: {
          ...state,
          writeLock: null,
          // ⚠ タイル設定の書込も一緒に畳む(片方だけ残ると編集に入れないままになる)
          tileWrite: null,
          lockGen: state.lockGen + 1,
          ...(draft
            ? {
                phase: 'ready' as const,
                // draft を捨てる = disk で確認できている内容へ戻す
                openBody: {
                  lid: state.openBody!.lid,
                  body: state.openBody!.persisted,
                  baseline: state.openBody!.persisted,
                  persisted: state.openBody!.persisted,
                  diskAhead: false,
                },
              }
            : {}),
          ...(section?.saving ? { sectionDraft: { ...section, saving: false } } : {}),
        },
        events: [],
      };
    }
    /** 追記が disk に着いた。⚠ **世代の合わない ack は捨てる**(強制解放の後着)。 */
    case 'ENTRY_APPENDED': {
      if (action.gen !== state.lockGen) return { state, events: [] };
      const meta = state.entryMetas.get(action.lid);
      // 再 boot 済み(entry が消えた)でも**ロックは必ず解く**
      if (!meta) {
        return {
          state: { ...state, writeLock: null },
          events: [
            {
              type: 'APPEND_SETTLED',
              lid: action.lid,
              gen: action.gen,
              ok: false,
              error: 'ノートの状態を確かめられませんでした',
            },
          ],
        };
      }
      const entryMetas = new Map(state.entryMetas).set(action.lid, {
        ...meta,
        status: action.status,
        date: action.date,
        archived: action.archived,
      });
      // ⚠ 編集中のノート自身へは APPEND_TO_ENTRY が通らない(#1051 からは
      //    別のノートへは編集中も通る)ので、lid が一致する openBody は
      //    編集欄を持たない ── 丸ごと差し替えて安全
      const openBody =
        state.openBody?.lid === action.lid
          ? {
              lid: action.lid,
              body: action.body,
              baseline: action.body,
              persisted: action.body,
              diskAhead: false,
            }
          : state.openBody;
      return {
        state: {
          ...state,
          entryMetas,
          openBody,
          writeLock: null,
          /**
           * 🔴 **ここも「新しい本文が state に入る所」である**(2026-08-20 に判明)。
           *
           * ⚠ `refreshTaskCards` の docstring は「2 か所**だけ**を通す」と宣言して
           *   いたが、**この 3 か所目が漏れていた** ── §7 の「数えた数だけ通す」で
           *   数を間違えた形である(宣言が在るぶん、次に読む人は疑わない)。
           * ⚠ いまの追記は**末尾に足す**ので既存の札の行番号はずれない。実害は
           *   「**足したチェック項目が板に出ない**」(開き直すまで)。⚠ ただし
           *   板から「やること」を足す口を作ると、これが正面の欠陥になる。
           */
          taskScan: refreshTaskCards(state.taskScan, action.lid, action.body),
          /**
           * 🔴 **横に留めた枠にも、同じノートが出ていることがある**(#684 ㋑、
           *   着地前レビュー 重大 ①)。
           *
           * ⚠ `syncSplitBody` を呼ぶ口は `BODY_REWRITTEN` / `BODY_PERSISTED` /
           *   `REMOTE_BODY_CHANGED` の 3 つで、**追記(ここ)だけ抜けていた** ──
           *   しかも追記は `BODY_PERSISTED` を通らない(`store-effects` は
           *   `ENTRY_APPENDED` しか撃たない)ので、**どこからも直らない**。
           * 🔴 実害:留めた枠へ落とした file が入った回、知らせは
           *   「『◯◯』の本文に入れました」と言うのに**目の前の枠は 1 文字も変わらない**
           *   ── user は入っていないと読んで、もう一度落とす(行が二重になる)。
           * ⚠ 同じ穴を #757 が `BODY_REWRITTEN` で塞いだばかりで、その注記が
           *   「§7 ── 片方だけ直る」と戒めている。**4 か所目がここだった。**
           */
          ...syncShownBodies(state, action.lid, action.body),
          // 🔑 タグが変われば、開いている入れ物の中身も変わる(#421 / user 要望 2026-08-26)
          smartHits: refreshSmartHits(
            state.smartHits,
            action.lid,
            action.body,
            state.entryMetas,
          ),
          /**
           * 🔴 **直前の 1 手だけ覚える**(#395 段①)── 「元に戻す」の材料。
           * ⚠ 純粋な挿入でなかった回は `null` に落とす ── 前の追記の材料を
           *   **残したままにしない**(古い材料で消すと、別の所が消える)。
           */
          ...(action.batch === AGENT_APPEND_BATCH
            ? {
                // 🔴 AI の書き足しは**別の 1 手**に持つ ── 自分の「追記を元に戻す」(`lastAppend`)を消さない(依頼 362)
                lastAgentAppend:
                  action.inserted === null
                    ? null
                    : {
                        lid: action.lid,
                        lines: action.inserted,
                        ...(action.insertedAt == null ? {} : { at: action.insertedAt }),
                      },
              }
            : { lastAppend: nextLastAppend(state.lastAppend, action) }),
        },
        events: [
          { type: 'APPEND_SETTLED', lid: action.lid, gen: action.gen, ok: true, error: null },
        ],
      };
    }
    /**
     * 🔴 **直前の追記を取り消す**(#395 段①)。
     *
     * ⚠ **消すのは「足した行そのもの」**で、行番号ではない ── 取り消すまでの間に
     *   別の窓が上へ足していれば番号はずれる。見つからなければ
     *   `applyBodyRewrite` が `null` を返して effect が断る(黙って別の所を消さない)。
     * ⚠ **1 手で使い切る**(`lastAppend` を落とす)── 2 度押しで、同じ字の
     *   別の行まで消えるのを止める。
     */
    case 'UNDO_APPEND': {
      const last = state.lastAppend;
      if (!last) return { state, events: [] };
      /**
       * 🔴 **断るなら声に出す。判定は lid で**(#1051)。⚠ 直す前は `phase !== 'ready'` で
       *   **黙って捨てて**いた ── 状態の行の「追記を元に戻す」は phase を見ずに出て、
       *   `START_EDIT` は材料も知らせも捨てないので、横に留めた別のノートへファイルを
       *   入れた後に編集を始めると、押しても何も起きなかった(実ブラウザ:
       *   `body-block-drag.smoke.spec.ts`「横に留めた枠へファイルを落とす」の末尾)。
       * ⚠ 断った回は**材料を残す**(編集を終えてから押し直せる)。
       */
      const blockedResult = bodyWriteBlockResult(state, last.lid, '追記を元に戻してください');
      if (blockedResult !== null) return blockedResult;
      const meta = state.entryMetas.get(last.lid);
      if (!meta) return { state: { ...state, lastAppend: null }, events: [] };
      return {
        state: { ...state, lastAppend: null },
        events: [
          {
            type: 'REQUEST_BODY_REWRITE',
            lid: meta.lid,
            title: meta.title,
            archetype: meta.archetype,
            entryOrder: meta.entryOrder,
            rewrite: { kind: 'undo-append', lines: last.lines, ...(last.at === undefined ? {} : { at: last.at }) },
          },
        ],
      };
    }
    /**
     * 🔴 **直前の AI の書き足しを取り消す**(台帳 #1852 P1 / 依頼 362)。`UNDO_APPEND` と同じ作法で、
     * 材料が `lastAgentAppend` なだけ(断った回は材料を残す / 使い切る / 書換は `REQUEST_BODY_REWRITE` の 1 本)。
     */
    case 'UNDO_AGENT_APPEND': {
      const last = state.lastAgentAppend;
      if (!last) return { state, events: [] };
      const blockedResult = bodyWriteBlockResult(state, last.lid, '書き足しを元に戻してください');
      if (blockedResult !== null) return blockedResult;
      const meta = state.entryMetas.get(last.lid);
      if (!meta) return { state: { ...state, lastAgentAppend: null }, events: [] };
      return {
        state: { ...state, lastAgentAppend: null },
        events: [
          {
            type: 'REQUEST_BODY_REWRITE',
            lid: meta.lid,
            title: meta.title,
            archetype: meta.archetype,
            entryOrder: meta.entryOrder,
            rewrite: { kind: 'undo-append', lines: last.lines, ...(last.at === undefined ? {} : { at: last.at }) },
          },
        ],
      };
    }
    case 'APPEND_FAILED': {
      // ⚠ 世代が違っても**ロックは解く** ── 「古い ack だから無視」で握ったままに
      // すると、user は永久に追記できず、しかも理由が分からない。
      // 巻き戻しの危険があるのは**本文を採る**ときだけで、解放は常に安全
      if (action.gen !== state.lockGen) return { state, events: [] };
      // 失敗は非致命。理由は effect が OP_FAILED で別に出す(phase は落とさない)
      return {
        state: { ...state, writeLock: null, error: action.error },
        events: [
          { type: 'APPEND_SETTLED', lid: action.lid, gen: action.gen, ok: false, error: action.error },
        ],
      };
    }
  }
}
