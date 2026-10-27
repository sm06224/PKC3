/**
 * reducer の slice: 編集の開始・確定・取消と、章 / コード枠の下書き(#1383)。
 *
 * 🔑 `app-state.ts` の `reduceCore` から**機械的に移した**(case 本体は 1 文字も変えていない)。
 *   `reduceCore` は label を列挙してここへ渡す ── `switch` の網羅検査は両側で効く
 *   (`reduceCore` に label が無ければ `reduceEdit` に届かず、ここに case が無ければ tsc が落ちる)。
 * ⚠ 履歴・2 ペインの掃除・バックリンクは `reduceWithHistory` の 1 か所で見る(ここでは見ない)。
 */

import {
  type AppState,
  type Dispatchable,
  ENTRY_GONE_NOTE,
  type ReduceResult,
  buildPersist,
  clearedSectionDraftAdvisory,
  endEditRefusal,
  isCodeDraft,
  phaseBlockReason,
  refreshSmartHits,
  refreshTaskCards,
  removeEntryFromState,
  sectionDraftBlockedResult,
  smartScanFor,
  syncShownBodies,
} from '../app-state';
import { seedBodyFor } from '@features/flavor';
import { foldAttachmentHead, joinHiddenHead } from '@features/flavor/attachment-edit-fold';
import { sectionAt, sectionRange } from '@features/markdown/append-target';
import { replaceAll } from '@features/markdown/body-replace';
import { applyBodyRewrite } from '@features/markdown/body-rewrite';
import { openCodeFenceAt } from '@features/markdown/code-fence-edit';
import { frontmatterLineCount } from '@features/markdown/frontmatter';
import { isSystemMessageLid } from '@features/message/message-log';

export type EditAction = Extract<Dispatchable, { type: 'START_EDIT' | 'REPLACE_IN_BODY' | 'UPDATE_OPEN_BODY' | 'COMMIT_EDIT' | 'RETRY_PERSIST' | 'CANCEL_EDIT' | 'OPEN_SECTION_DRAFT' | 'SAVE_SECTION_DRAFT' | 'SECTION_SAVED' | 'SECTION_SAVE_FAILED' | 'CANCEL_SECTION_DRAFT' | 'OPEN_CODE_DRAFT' | 'SAVE_CODE_DRAFT' | 'CODE_SAVED' | 'CODE_SAVE_FAILED' | 'CANCEL_CODE_DRAFT' }>;

export function reduceEdit(state: AppState, action: EditAction): ReduceResult {
  switch (action.type) {
    case 'START_EDIT': {
      // openBody が現選択の body を持っているときだけ編集に入れる
      // (= 未読 body の編集・保存が構造的に不可能)
      if (state.phase !== 'ready') return { state, events: [] };
      if (!state.openBody || state.openBody.lid !== state.selectedLid)
        return { state, events: [] };
      // 🔴 **system 領域のノート(メッセージ・処理の記録)は編集に入れない**
      // (#1038 台帳③ C1 の着地前レビュー)。⚠ 押し口は描画側が出さない
      // (`detail.ts` / ⋯ の `phone-menu`)── ここは backstop。押し口が 1 つ増えた日に
      // 素通りして、アプリが書く記録を user の手で書き換えられる形にしない。
      if (isSystemMessageLid(state.openBody.lid)) return { state, events: [] };
      /**
       * 🔴 **章の欄が開いているノートでは、全文編集に入れない**(#1044 段2。
       *   設計 doc §3)。⚠ **無言では返さない**(design「do not silently drop
       *   the draft」)── 押した人には「章の欄を閉じれば入れる」と分かる字を出す。
       */
      if (state.sectionDraft?.lid === state.openBody.lid) {
        return sectionDraftBlockedResult(state);
      }
      // 🔴 **追記の書込が飛んでいる間は編集に入れない**(P8 段⑧)。
      // 入れてしまうと editor が古い body を掴み、着弾した追記を保存で上書きする
      // ── これが「追記が黙って消える」の実体。
      // ⚠ ここは**backstop** ── 無言の拒否にならないよう、描画側は書込中
      // 「編集」を出さずにロックの帯(理由 + 強制解放)を出す(`detail.ts`)
      // ⚠ タイル設定の書込中も編集に入れない(交錯すると disk の設定が消える)
      if (state.tileWrite && state.tileWrite.lid === state.openBody.lid)
        return { state, events: [] };
      if (state.writeLock && state.writeLock.lid === state.openBody.lid)
        return { state, events: [] };
      // ⚠ 編集がロックを握ることは**書かない** ── `phase === 'editing'` が既に
      // それを表している(`bodyLockOf`)。ここで別の field に写すと 2 つ目の真実
      return {
        state: {
          ...state,
          phase: 'editing',
          openBody:
            action.restoreBody === undefined
              ? state.openBody
              : { ...state.openBody, body: action.restoreBody },
          revisionPanel: null,
          // ⚠ 見ていた版も畳む(#398 段②)── 一覧が畳まれたら差分は孤児になる
          revisionPreview: null,
          /**
           * 🔴 **押した行を持って編集へ入る**(#395 段③)。
           * ⚠ **毎回入れ替える**(`?? null`)── 前回の値を残すと、普通に
           *   「編集」を押しただけで**前に押した行が開く**。
           */
          editOpenAt: action.atLine ?? null,
          // ⚠ 編集は行をずらすので「元に戻す」の材料は捨てる(#684 段①。`lastMove` の注記)
          lastMove: null,
        },
        /**
         * 🔴 **編集に入るたびに雛形を集め直す**(#196 / B-2)。
         *
         * ⚠ 「一度集めたら使い回す」にしない ── **さっき直した雛形が次の編集で
         *   古いまま**になる(自分で作った物が効かないのは、いちばん困る形)。
         * 🔑 実費は「archetype で絞った ≤200 行を worker で読む」1 往復で、
         *   しかも**押した瞬間ではなく編集を開いた瞬間**に走るので、`Tab` の
         *   反応には乗らない。
         * ⚠ 頼むのは配線ではなくここ ── `main.ts` に書くと、どの test からも
         *   実行されない場所に判断が沈む(CLAUDE.md §2)。
         */
        events: [{ type: 'REQUEST_SNIPPET_SCAN' }],
      };
    }
    /**
     * 🔴 **本文の置換**(#191)。⚠ 編集中だけ ── 読んでいるだけの面から本文を
     * 書き換えると、user が「編集していない」と思っている間に内容が変わる。
     * ⚠ **0 件のときも state を返す**(何も起きないのではなく「見つからなかった」と
     * 言う)── 押しても無反応な dead click を作らない。
     */
    case 'REPLACE_IN_BODY': {
      /**
       * 🔴 **編集中でないときも黙らない**(#1087 の見直し 2026-10-13)── 置換の欄は保存した後も開いたまま残るので、
       *   そのまま「すべて置換」を押すと何も起きなかった(ショートカットキーと操作を探すは押す前に断っていたが、ボタンだけ無言)。
       */
      if (state.phase !== 'editing' || !state.openBody)
        return {
          state: { ...state, error: '「すべて置換」は編集中のノートでだけ使えます(「ノートを編集する」を押してから)' },
          events: [],
        };
      /**
       * 🔴 **置換の結果は「結果」の知らせで言う。エラーの行に入れない**(#1087 の見直し 2026-10-13)。
       * ⚠ 直す前は 3 つとも `error` に入れていたので、画面下に「エラー: 2 件を置き換えました」と出て、
       *   メッセージには種類「問題」で積まれていた(成功したのに失敗の顔)。
       * ⚠ 探す語が空のときは、空の鉤括弧(「」は本文に見つかりませんでした)ではなく、何を入れるかを言う。
       */
      if (action.find === '') return { state: { ...state, notice: '探す語を入れてください', noticeOpen: null, noticeCreate: null }, events: [] };
      /**
       * 🔴 **添付ノートは、画面に出ていない設定の行を置換の外に置く**(#1579 Q1 = A)。
       * ⚠ 設定の行(`attachment.*`)は編集欄に畳まれて見えない。そこへ当てると、
       *   見えない所が書き換わって添付が壊れる。切り方は編集欄と同じ `foldAttachmentHead` 1 本。
       *   件数も見える本文だけを数える(`replaceAll` の返す count をそのまま使う)。
       */
      const fold =
        state.entryMetas.get(state.openBody.lid)?.archetype === 'attachment'
          ? foldAttachmentHead(state.openBody.body)
          : null;
      const done = replaceAll(fold === null ? state.openBody.body : fold.rest, action.find, action.replace, {
        caseSensitive: action.caseSensitive === true,
      });
      const count = done.count;
      const body = fold === null ? done.body : joinHiddenHead(fold.head, done.body);
      if (count === 0)
        return {
          state: { ...state, notice: `「${action.find}」は本文に見つかりませんでした`, noticeOpen: null, noticeCreate: null },
          events: [],
        };
      return {
        state: { ...state, notice: `${count} 件を置き換えました`, noticeOpen: null, noticeCreate: null, openBody: { ...state.openBody, body } },
        events: [],
      };
    }
    case 'UPDATE_OPEN_BODY': {
      if (state.phase !== 'editing' || !state.openBody) return { state, events: [] };
      return {
        state: { ...state, openBody: { ...state.openBody, body: action.body } },
        events: [],
      };
    }
    case 'COMMIT_EDIT': {
      // 🔴 捨てるなら**声に出して**捨てる(#723)── `app-state.ts` の `endEditRefusal` を見よ
      if (state.phase !== 'editing' || !state.openBody)
        return { state: { ...state, error: endEditRefusal('保存', state) }, events: [] };
      const { lid, body: draft, baseline, persisted } = state.openBody;
      /**
       * 🔴 **保存時に本文中のタグを `body-tags:` へ集約する**(#550)。書換は `applyBodyRewrite` の 1 本。
       * ⚠ 下書きが baseline と同じなら書かない(「変わっていないなら書かない」を壊さない)ので、
       *   集約は**変更のある保存**でだけ走る。集約が今と同じなら本文は 1 字も変わらない。
       */
      const body =
        draft === baseline
          ? draft
          : (applyBodyRewrite(draft, { kind: 'body-tags-sync' }) ?? draft);
      // baseline := body(最終 commit 内容)。disk 確認は persisted が別に持つので
      // これは楽観確定ではない(review E は persisted の導入で解消)
      const { diskAhead } = state.openBody;
      const next: AppState = {
        ...state,
        phase: 'ready',
        freshLid: state.freshLid === lid ? null : state.freshLid,
        // 変更ありの commit は draft が正(可視内容の last-write-wins)── disk
        // 先行の印はここで畳む
        openBody: { lid, body, baseline: body, persisted, diskAhead: false },
      };
      // 変わっていないなら書かない(PKC2 #1024 の教訓を最初から)。
      // ローカル変更が無く disk が先行(編集中に toggle ack ── diskAhead)なら
      // **disk が勝つ** ── stale baseline を持ち越すと、後日の無関係な commit が
      // toggle を黙って巻き戻す(P3-6a review #4)
      if (body === baseline) {
        if (diskAhead) {
          return {
            state: {
              ...state,
              phase: 'ready',
              freshLid: state.freshLid === lid ? null : state.freshLid,
              openBody: {
                lid,
                body: persisted,
                baseline: persisted,
                persisted,
                diskAhead: false,
              },
            },
            events: [],
          };
        }
        return {
          state: { ...next, openBody: { ...next.openBody!, diskAhead: false } },
          events: [],
        };
      }
      const meta = state.entryMetas.get(lid);
      if (!meta) {
        // openBody は SELECT_ENTRY(存在検査済)経由でしか確立しない ── ここに
        // 来たら不変量違反。書かずに可視エラーで終える(黙って捨てない)
        return {
          state: { ...state, phase: 'ready', error: ENTRY_GONE_NOTE },
          events: [],
        };
      }
      // 抽出はイベント発火時(= この reduce)に同期で行い、行全体を確定して運ぶ
      const { entryMetas, entry, taskScan, smartHits } = buildPersist(state, meta, body);
      // 変更前(baseline)を履歴に積むかどうか(P5c: 実際の記録は worker が
      // 同 tx で行う ── ここは「刻むか / 頭を張り替えるだけか」の意思決定)。
      // 新規作成の初回 commit は積まない ──「flavor seed へ戻す」だけの復元先は
      // ゴミ(PKC2 は無条件に積んで肥大した)。
      // ⚠ freshLid だけでは足りない(review P5b F4): rename が fresh を解除する
      // ため「作成 → title → 本文 → 保存」の普通の流れで seed revision が積まれる
      // ── baseline が flavor seed のままなら fresh 扱いで skip する
      /**
       * 🔴 **別の窓の版を上書きするなら、必ず履歴へ積む**(#178、2026-08-22)。
       *
       * ⚠ ここは **last-write-wins のまま**である(「変更ありの commit は draft が
       *   正」── P3-6a review #4 の判断は覆さない)。user が打った字を、
       *   別の窓の都合で**捨てさせない**ためである。
       * 🔑 変えるのは**残るかどうか**と**黙るかどうか**の 2 つだけ:
       *   ① `checkpoint` を強制する(下の断り文「履歴に残しました」を**本当にする**)
       *   ② 画面に出す ── 直す前は**完全に無言**で、user は「カレンダーで付けた
       *      日付が消えた」としか見えなかった(戻せることを知る道が無い)。
       * ⚠ ①は「たぶん積まれる」では足りない ── 新規作成の初回 commit は
       *   `checkpoint` が false なので、そこだけ本当に消える。
       */
      const checkpoint =
        diskAhead || (state.freshLid !== lid && baseline !== seedBodyFor(meta.archetype));
      return {
        state: {
          ...next,
          entryMetas,
          taskScan,
          smartHits,
          ...(diskAhead
            ? {
                error:
                  '別のタブまたはウィンドウの変更と重なりました。こちらの内容で保存し、' +
                  '別のタブまたはウィンドウの版は履歴に残してあります(履歴から戻せます)',
              }
            : {}),
        },
        /**
         * 🔑 **保存したのが入れ物自身なら、条件が変わったかもしれない**
         *   (本文の `smart-tags:` は手で書ける ── マニュアルにもそう書いてある)。
         * ⚠ 上の `refreshSmartHits` は**自分自身を触らない**(自分は集めないので
         *   正しい)ので、条件の変更はここでしか拾えない。
         * ⚠ 入れ物でなければ `smartScanFor` が空を返す ── 普通の保存で走査は走らない。
         */
        events: [
          { type: 'PERSIST_ENTRY', entry, checkpoint, keepMeta: true },
          ...smartScanFor(state, lid),
        ],
      };
    }
    case 'RETRY_PERSIST': {
      // persist 失敗(error phase)からの復帰: baseline(最後に commit した内容)が
      // disk(persisted)に未達なら、現 meta で行を組み直して再送する。
      // baseline ≠ persisted が「未達の証拠」── P3-5 で導入した分離の回収点
      if (state.phase !== 'error' || !state.openBody) return { state, events: [] };
      const { lid, baseline, persisted, diskAhead } = state.openBody;
      // ⚠ `diskAhead` でも**止めない**(#1087)── 別のタブが先に書いた版がある状態で再保存を
      //   黙って断ると、未達の字の出口が無くなる。通すが、履歴に残して知らせる(commit と同じ)
      if (baseline === persisted) return { state, events: [] };
      const meta = state.entryMetas.get(lid);
      if (!meta) return { state, events: [] };
      const { entryMetas, entry, taskScan, smartHits } = buildPersist(state, meta, baseline);
      // 再送でも刻む意思は同じ(worker 側の hash skip が重複を防ぐので二重に
      // 積まれることはない ── 初回 persist が失敗していれば disk はまだ前の内容)
      const checkpoint =
        diskAhead || (state.freshLid !== lid && persisted !== seedBodyFor(meta.archetype));
      return {
        state: {
          ...state,
          phase: 'ready',
          error: diskAhead
            ? '別のタブまたはウィンドウの変更と重なりました。こちらの内容で保存し、' +
              '別のタブまたはウィンドウの版は履歴に残してあります(履歴から戻せます)'
            : null,
          entryMetas,
          taskScan,
          smartHits,
          openBody: { lid, body: baseline, baseline, persisted, diskAhead: false },
        },
        events: [{ type: 'PERSIST_ENTRY', entry, checkpoint, keepMeta: true }],
      };
    }
    case 'CANCEL_EDIT': {
      // 🔴 捨てるなら**声に出して**捨てる(#723)── `app-state.ts` の `endEditRefusal` を見よ
      if (state.phase !== 'editing' || !state.openBody)
        return { state: { ...state, error: endEditRefusal('取り消し', state) }, events: [] };
      const { lid, body, baseline, persisted, diskAhead } = state.openBody;
      // 新規作成直後の未編集 cancel は entry ごと掃除する ── PKC2 は掃除が無く
      // 「作成 → Esc」で既定 title の空 entry が堆積した(P3-7a)。draft を
      // 打ち込んでからの cancel は PKC2 同様 entry を残す(誤 Esc で消さない)
      if (state.freshLid === lid && body === baseline) {
        /**
         * 🔴 **何も書かれていないノートは、ゴミ箱へ移さず消す**(#1087)。直す前は「新規 → 何も打たず Esc」の
         *   たびに空のノートがゴミ箱へ溜まった。⚠ 消してよいのは**本当に手付かず**の物だけ ──
         *   本文が種のまま(`seedBodyFor`)で、題名も作ったときのまま(改名は `freshLid` を外す)。
         *   取り込み・貼り付けなどで中身を持って作った物は `seedBodyFor` と違うので、ゴミ箱を通る。
         */
        const meta = state.entryMetas.get(lid);
        const untouched = meta !== undefined && baseline === seedBodyFor(meta.archetype);
        return removeEntryFromState(state, lid, [
          untouched ? { type: 'REQUEST_DELETE', lid, untouched: true } : { type: 'REQUEST_DELETE', lid },
        ]);
      }
      // draft 破棄。disk 先行(diskAhead)なら disk を採用(review #4)。
      // 自 commit の ack 待ちで persisted が遅れているだけなら baseline が正。
      // fresh は非掃除分岐でも解除する ── draft を打った cancel は「残す意思」で
      // あり、後日の無変更 Esc が作業済み entry を消してはならない
      // (P3-7a review 中: toggle を跨いで freshLid が生き残る反例)
      const restored = diskAhead ? persisted : baseline;
      return {
        state: {
          ...state,
          phase: 'ready',
          freshLid: state.freshLid === lid ? null : state.freshLid,
          openBody: {
            lid,
            body: restored,
            baseline: restored,
            persisted,
            diskAhead: false,
          },
        },
        events: [],
      };
    }
    /**
     * 🔴 **章だけの下書きを開く**(#1044 段2)。
     *
     * ⚠ 見出しは**押した行**で特定する(`sectionAt`)── ここでは行はまだずれていない
     *   (開く瞬間なので、押した行がそのまま本文の行である)。保存のときだけ
     *   **名前で**探し直す(その間に別の窓が書いているかもしれないため)。
     * ⚠ **章の範囲は追記欄と同じ関数**(`sectionRange`)── 2 つ目の規則を作らない
     *   (設計 doc §3)。
     */
    case 'OPEN_SECTION_DRAFT': {
      const { lid, line } = action;
      if (state.phase !== 'ready') return { state, events: [] };
      if (!state.openBody || state.openBody.lid !== lid) return { state, events: [] };
      // 🔴 system 領域のノートは編集に入れない(START_EDIT と同じ backstop)
      if (isSystemMessageLid(lid)) return { state, events: [] };
      /**
       * 🔴 **二重に開かない。ただし無言にしない**(#1044 段2、F-E)。
       *
       * ⚠ 直す前は無言で何もしなかった ── 呼び手(binder)が同じノートの**別の
       *   見出し**を押したときも、reducer がここで黙って捨てるので**押しても
       *   何も起きなかった**(押し間違いと区別できない dead click)。
       * 🔑 binder 側(`startSectionEditAt`)が `leaveSectionDraftOrAsk` と同じ
       *   3 択を先に通し、通った後にだけ `OPEN_SECTION_DRAFT` を撃つ ── ここへ
       *   来るのは**その門を通らずに撃った**とき(防波堤)なので、可視の理由を出す。
       */
      if (state.sectionDraft != null) {
        return sectionDraftBlockedResult(state);
      }
      const body = state.openBody.body;
      const abs = line + frontmatterLineCount(body);
      const sec = sectionAt(body, abs);
      const range = sec === null ? null : sectionRange(body, sec.slug);
      if (sec === null || range === null) {
        return {
          state: { ...state, error: '章の範囲を読めませんでした(本文を開き直してください)' },
          events: [],
        };
      }
      const lines = body.split(/\r?\n/);
      const original = lines.slice(range.start, range.end).join('\n');
      /**
       * 🔴 **開けたら、章の欄自身の断り文は消す**(#1044 段2 2巡目の修理、R5)。
       * ⚠ 「二重に開かない」門(上)が出した `SECTION_DRAFT_NOTE` は、
       *   ここまで来た時点で通っている(前の下書きは閉じられている)ので、
       *   もう画面に残す理由が無い。
       */
      return {
        state: {
          ...state,
          sectionDraft: { lid, heading: sec.text, original, saving: false },
          ...clearedSectionDraftAdvisory(state),
        },
        events: [],
      };
    }
    /**
     * 🔴 **章の欄を保存する**(#1044 段2。3巡目の修理、S1 で読み直しの向きを直した)。
     *
     * 🔴 **本文は event に載せない。書く瞬間に disk から読み直す**(#1044 段2 3巡目の
     *   修理、S1)。⚠ 直す前は `state.openBody.body`(章の欄が開いている間ずっと
     *   更新されない、画面の古い写し)を土台に差し替えていた ── 別の窓がその間に
     *   本文を進めていても、章の欄が開いている限り `openBody` は追随しないので、
     *   保存は**その別の窓の書込を巻き戻す**(disk へは反映されるが、こちらの土台には
     *   乗っていないので黙って消える)。
     * 🔑 **追記(`APPEND_TO_ENTRY`)と同じ作法** ── ここでは
     *   「保存中」の印を立てて要求を出すだけ、探し直し・比較・差し替えは
     *   effect が disk から読んだ本文へ {@link replaceSectionByHeading} を当てる
     *   (features 層の純関数 1 本 ── 2 本目の規則を作らない)。
     * ⚠ **断ったら `sectionDraft` は残す**(箱も残る)── 書きかけを消さない。
     */
    case 'SAVE_SECTION_DRAFT': {
      const draft = state.sectionDraft ?? null;
      // ⚠ **コード枠の下書きが開いているのに撃たれたら、黙って捨てる**(#1044 段3)──
      //   binder は種類ごとに別の action を撃つので、ここへ来るのは防波堤のみ。
      if (draft === null || isCodeDraft(draft)) return { state, events: [] };
      /**
       * 🔴 **二重押しは黙って捨てる**(#1044 段2 3巡目の修理、S1)。
       * ⚠ **追記の `writeLock` と同じ作法**(`app-state.ts` の `APPEND_TO_ENTRY`
       *   `if (state.writeLock) return { state, events: [] };`)── 箱は
       *   `saving` の間押せない見た目になる(`detail.ts`)ので、ここは
       *   その見た目をすり抜けた回の防波堤である。
       */
      if (draft.saving) return { state, events: [] };
      /**
       * 🔴 **「null章を保存してください」を作らない**(#1044 段2、F-D)。
       *
       * ⚠ 直す前は `${phaseBlockReason(state.phase)}章を保存してください` の 1 行で
       *   3 つの前提を一括で断っていたが、`phaseBlockReason('ready')` は `null` を
       *   返す ── **phase が `ready` のまま `openBody` だけ欠けている窓**
       *   (`SYS_BOOTED` が `openBody: null` にしてから `BODY_LOADED` が戻すまでの
       *   数百 ms。別タブが書くたびに起きる)で、断り文に文字列 `"null"` が混ざっていた。
       * 🔑 だから **phase の断りだけをここで見る**。⚠ **`openBody` の有無はもう見ない**
       *   (S1)── 保存は disk から読み直すので、画面側の `openBody` が読み直し中でも
       *   保存の正しさに影響しない(`SECTION_DRAFT_RELOADING_NOTE` は要らなくなった)。
       */
      if (state.phase !== 'ready') {
        return { state: { ...state, error: `${phaseBlockReason(state.phase)}章を保存してください` }, events: [] };
      }
      const meta = state.entryMetas.get(draft.lid);
      if (!meta) {
        // openBody は SELECT_ENTRY(存在検査済)経由でしか確立しない ── ここに
        // 来たら不変量違反(COMMIT_EDIT と同じ backstop)。
        return { state: { ...state, error: ENTRY_GONE_NOTE }, events: [] };
      }
      return {
        state: {
          ...state,
          sectionDraft: { ...draft, saving: true },
          ...clearedSectionDraftAdvisory(state),
        },
        events: [
          {
            type: 'REQUEST_SECTION_SAVE',
            lid: draft.lid,
            gen: state.lockGen,
            title: meta.title,
            archetype: meta.archetype,
            entryOrder: meta.entryOrder,
            heading: draft.heading,
            original: draft.original,
            text: action.text,
          },
        ],
      };
    }
    /**
     * 🔴 **章の保存が disk に着いた**(#1044 段2 3巡目の修理、S1)。⚠ **世代の合わない
     *   ack は捨てる**(強制解放の後着 ── `ENTRY_APPENDED` と同じ作法)。
     * ⚠ **draft の身元も見る**(`lid` + `heading`) ── system command で
     *   `guardSectionDraftTransition` が sectionDraft を先に閉じていたら(別タブが
     *   このノートを消した等)、後から来たこの ack は当てない(閉じた後の draft は
     *   もう「保存の行き先」ではない)。
     */
    case 'SECTION_SAVED': {
      if (action.gen !== state.lockGen) return { state, events: [] };
      const draft = state.sectionDraft;
      if (
        draft === null ||
        isCodeDraft(draft) ||
        draft.lid !== action.lid ||
        draft.heading !== action.heading
      ) {
        return { state, events: [] };
      }
      const meta = state.entryMetas.get(action.lid);
      const entryMetas = !meta
        ? state.entryMetas
        : new Map(state.entryMetas).set(action.lid, {
            ...meta,
            status: action.status,
            date: action.date,
            archived: action.archived,
          });
      const openBody = {
        lid: action.lid,
        body: action.body,
        baseline: action.body,
        persisted: action.body,
        diskAhead: false,
      };
      /**
       * 🔴 **保存できたら、章の欄自身の断り文は消す**(#1044 段2 2巡目の修理、R5)。
       * ⚠ 直す前はここを 1 バイトも触っていなかった ── `SECTION_DRAFT_NOTE` を
       *   出した後に保存し直しても、画面には「章を編集中は使えません」が保存の
       *   **成功後も**残っていた。
       */
      return {
        state: {
          ...state,
          entryMetas,
          sectionDraft: null,
          ...clearedSectionDraftAdvisory(state),
          openBody,
          taskScan: refreshTaskCards(state.taskScan, action.lid, action.body),
          smartHits: refreshSmartHits(state.smartHits, action.lid, action.body, entryMetas),
          ...syncShownBodies(state, action.lid, action.body),
        },
        events: smartScanFor(state, action.lid),
      };
    }
    /**
     * 🔴 **章の保存が断られた**(#1044 段2 3巡目の修理、S1)。⚠ **ロックは必ず解く**
     *   (`saving: false`)── 解かないと箱が永久に押せなくなる。⚠ **draft(箱・書きかけ)
     *   は残す** ── 断ったのは disk 側の事情で、user が打った字とは無関係。
     * 🔴 **`sectionAdvisory` も同時に控える**(#1044 段2 5巡目の修理、U3)。
     *   ⚠ `action.error` は固定の 4 文言だけではない ── `REQUEST_SECTION_SAVE` の
     *   catch-all(「章を保存できませんでした: <e>」、例外の中身が動く字)もここを通る。
     *   その動く字も「章の欄自身がいま置いた字」として同じ扱いにするため、
     *   中身を問わず `action.error` をそのまま控える。
     */
    case 'SECTION_SAVE_FAILED': {
      if (action.gen !== state.lockGen) return { state, events: [] };
      const draft = state.sectionDraft;
      if (
        draft === null ||
        isCodeDraft(draft) ||
        draft.lid !== action.lid ||
        draft.heading !== action.heading
      ) {
        return { state, events: [] };
      }
      return {
        state: {
          ...state,
          sectionDraft: { ...draft, saving: false },
          error: action.error,
          sectionAdvisory: action.error,
        },
        events: [],
      };
    }
    /**
     * 🔴 **章の欄を、書かずに閉じる**(#1044 段2)。
     * ⚠ **閉じたら、章の欄自身の断り文も消す**(#1044 段2 2巡目の修理、R5)──
     *   `OPEN_SECTION_DRAFT` / `SAVE_SECTION_DRAFT` の成功と同じ寿命の考え方。
     * 🔴 **保存中は黙って捨てる**(#1044 段2 3巡目の修理、S1)。⚠ `saving` の間に
     *   閉じさせると、あとから届く保存の ack(成功 / 失敗)が**もう居ない draft**
     *   を当てようとする ── 身元検査(`SECTION_SAVED` / `SECTION_SAVE_FAILED` の
     *   `lid`+`heading` 一致)で黒巻き戻しは起きないが、user から見ると
     *   「やめたのに書きかけが disk へ着く」ことがある(効果が読んだ後に閉じた回)。
     *   箱は `saving` の間押せない見た目になる(`detail.ts`)ので、ここは
     *   その見た目をすり抜けた回の防波堤である(`save-section-draft` と同じ作法)。
     */
    case 'CANCEL_SECTION_DRAFT':
      return state.sectionDraft == null || state.sectionDraft.saving
        ? { state, events: [] }
        : {
            state: {
              ...state,
              sectionDraft: null,
              ...clearedSectionDraftAdvisory(state),
            },
            events: [],
          };
    /**
     * 🔴 **コード枠だけの下書きを開く**(#1044 段3)。⚠ **段2 と同じ 3 つの門**
     *   (`OPEN_SECTION_DRAFT` の docstring と同じ):phase 検査 / system 領域の
     *   backstop / 「二重に開かない。ただし無言にしない」。
     *
     * 🔑 枠の特定と身元の取り出しは {@link openCodeFenceAt} **1 本**(features 層の
     *   純関数 ── reducer に走査の規則を書かない、CLAUDE.md §7)。
     */
    case 'OPEN_CODE_DRAFT': {
      const { lid, line } = action;
      if (state.phase !== 'ready') return { state, events: [] };
      if (!state.openBody || state.openBody.lid !== lid) return { state, events: [] };
      if (isSystemMessageLid(lid)) return { state, events: [] };
      if (state.sectionDraft != null) {
        return sectionDraftBlockedResult(state);
      }
      const body = state.openBody.body;
      const abs = line + frontmatterLineCount(body);
      const identity = openCodeFenceAt(body, abs);
      if (identity === null) {
        return {
          state: { ...state, error: 'このコードブロックを編集できませんでした(本文を開き直してください)' },
          events: [],
        };
      }
      return {
        state: {
          ...state,
          sectionDraft: { lid, ...identity, saving: false },
          ...clearedSectionDraftAdvisory(state),
        },
        events: [],
      };
    }
    /**
     * 🔴 **コード枠の欄を保存する**(#1044 段3)。⚠ **段2(`SAVE_SECTION_DRAFT`)と
     *   全く同じ形**(本文は event に載せない / 二重押しは黙って捨てる /
     *   phase だけを見る / 断ったら draft は残す)。差し替えの純関数だけが違う
     *   ({@link replaceCodeFenceContent})。
     */
    case 'SAVE_CODE_DRAFT': {
      const draft = state.sectionDraft ?? null;
      if (draft === null || !isCodeDraft(draft)) return { state, events: [] };
      if (draft.saving) return { state, events: [] };
      if (state.phase !== 'ready') {
        return {
          state: { ...state, error: `${phaseBlockReason(state.phase)}コードを保存してください` },
          events: [],
        };
      }
      const meta = state.entryMetas.get(draft.lid);
      if (!meta) {
        return { state: { ...state, error: ENTRY_GONE_NOTE }, events: [] };
      }
      return {
        state: {
          ...state,
          sectionDraft: { ...draft, saving: true },
          ...clearedSectionDraftAdvisory(state),
        },
        events: [
          {
            type: 'REQUEST_CODE_SAVE',
            lid: draft.lid,
            gen: state.lockGen,
            title: meta.title,
            archetype: meta.archetype,
            entryOrder: meta.entryOrder,
            line: draft.line,
            openLine: draft.openLine,
            original: draft.original,
            quote: draft.quote,
            text: action.text,
          },
        ],
      };
    }
    /**
     * 🔴 **コード枠の保存が disk に着いた**(#1044 段3)。⚠ **世代 + 身元
     *   (`lid` + `line` + `openLine` + `quote`)の両方を見る**(`SECTION_SAVED` と同じ理由)。
     */
    case 'CODE_SAVED': {
      if (action.gen !== state.lockGen) return { state, events: [] };
      const draft = state.sectionDraft;
      if (
        draft === null ||
        !isCodeDraft(draft) ||
        draft.lid !== action.lid ||
        draft.line !== action.line ||
        draft.openLine !== action.openLine ||
        draft.quote !== action.quote
      ) {
        return { state, events: [] };
      }
      const meta = state.entryMetas.get(action.lid);
      const entryMetas = !meta
        ? state.entryMetas
        : new Map(state.entryMetas).set(action.lid, {
            ...meta,
            status: action.status,
            date: action.date,
            archived: action.archived,
          });
      const openBody = {
        lid: action.lid,
        body: action.body,
        baseline: action.body,
        persisted: action.body,
        diskAhead: false,
      };
      return {
        state: {
          ...state,
          entryMetas,
          sectionDraft: null,
          ...clearedSectionDraftAdvisory(state),
          openBody,
          taskScan: refreshTaskCards(state.taskScan, action.lid, action.body),
          smartHits: refreshSmartHits(state.smartHits, action.lid, action.body, entryMetas),
          ...syncShownBodies(state, action.lid, action.body),
        },
        events: smartScanFor(state, action.lid),
      };
    }
    /**
     * 🔴 **コード枠の保存が断られた**(#1044 段3)。⚠ **ロックは必ず解く**
     *   (`SECTION_SAVE_FAILED` と同じ作法)。
     */
    case 'CODE_SAVE_FAILED': {
      if (action.gen !== state.lockGen) return { state, events: [] };
      const draft = state.sectionDraft;
      if (
        draft === null ||
        !isCodeDraft(draft) ||
        draft.lid !== action.lid ||
        draft.line !== action.line ||
        draft.openLine !== action.openLine ||
        draft.quote !== action.quote
      ) {
        return { state, events: [] };
      }
      return {
        state: {
          ...state,
          sectionDraft: { ...draft, saving: false },
          error: action.error,
          sectionAdvisory: action.error,
        },
        events: [],
      };
    }
    /**
     * 🔴 **コード枠の欄を、書かずに閉じる**(#1044 段3。`CANCEL_SECTION_DRAFT` と同じ形)。
     */
    case 'CANCEL_CODE_DRAFT':
      return state.sectionDraft == null || !isCodeDraft(state.sectionDraft) || state.sectionDraft.saving
        ? { state, events: [] }
        : {
            state: {
              ...state,
              sectionDraft: null,
              ...clearedSectionDraftAdvisory(state),
            },
            events: [],
          };
  }
}
