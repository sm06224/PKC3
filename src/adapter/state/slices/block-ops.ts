/**
 * reducer の slice: ブロックの移動・受け渡し・行挿入・日付・本文の書き換え結果(#1383)。
 *
 * 🔑 `app-state.ts` の `reduceCore` から**機械的に移した**(case 本体は 1 文字も変えていない)。
 *   `reduceCore` は label を列挙してここへ渡す ── `switch` の網羅検査は両側で効く
 *   (`reduceCore` に label が無ければ `reduceBlockOps` に届かず、ここに case が無ければ tsc が落ちる)。
 * ⚠ 履歴・2 ペインの掃除・バックリンクは `reduceWithHistory` の 1 か所で見る(ここでは見ない)。
 */

import {
  type AppState,
  type Dispatchable,
  type ReduceResult,
  blockedWithSuffix,
  bodyRewriteGate,
  bodyWriteBlockReason,
  bodyWriteBlockResult,
  nextLastAppend,
  phaseBlockReason,
  refreshSmartHits,
  refreshTaskCards,
  screenBodyOf,
  syncShownBodies,
} from '../app-state';
import { isAppendable } from '@features/flavor/append-spec';
import { applyBodyRewrite } from '@features/markdown/body-rewrite';
import { BLOCK_MOVED_NOTICE, moveLinesWithInverse } from '@features/markdown/line-move';

export type BlockOpsAction = Extract<Dispatchable, { type: 'MOVE_BLOCK' | 'SPLIT_CHAPTER' | 'RESTORE_CHAPTER' | 'HANDOFF_BLOCK' | 'INSERT_LINES' | 'UNDO_MOVE' | 'SET_ENTRY_DATE' | 'TOGGLE_TODO_STATUS' | 'BODY_REWRITTEN' }>;

export function reduceBlockOps(state: AppState, action: BlockOpsAction): ReduceResult {
  switch (action.type) {
    /**
     * 🔴 **本文の塊を掴んで並べ替える**(#684 段①)── 板と**同じ門**。
     * 🔑 掴んだ時点の行そのものは**ここで**画面の本文から捕える(`placeOpenLineOf` と同じ
     *   向き)── disk 側とずれていれば `line-move.ts` が byte 一致で断る。
     * ⚠ `dragstart` では phase を見ない(掴むのは自由)── 落としたときにここで断る。
     */
    case 'MOVE_BLOCK':
      return bodyRewriteGate(state, action.lid, '、本文のブロックを動かしてください', (shown) => {
        if (shown === null) return null; // 画面に無い本文の行番号は信じない
        const { start, end, toBefore } = action;
        if (!Number.isInteger(start) || !Number.isInteger(end) || !Number.isInteger(toBefore)) return null;
        const lines = shown.split('\n');
        if (start < 0 || end < start || end >= lines.length) return null;
        // 🔴 落とし先の行の中身も捕える(#1087)── 行数と等しい `toBefore` は末尾(`null`)、それ以外は範囲外
        if (toBefore < 0 || toBefore > lines.length) return null;
        return {
          kind: 'move-lines',
          start,
          end,
          toBefore,
          lines: lines.slice(start, end + 1),
          toBeforeLine: lines[toBefore] ?? null,
        };
      });
    case 'SPLIT_CHAPTER':
      return bodyRewriteGate(state, action.lid, '、章を切り出してください', (shown) => {
        if (shown === null) return null; // 画面に無い本文の行番号は信じない
        const { start, end, link } = action;
        if (!Number.isInteger(start) || !Number.isInteger(end) || link === '') return null;
        const rows = shown.split('\n');
        if (start < 0 || end < start || end >= rows.length) return null;
        return {
          kind: 'chapter-split',
          start,
          end,
          lines: rows.slice(start, end + 1),
          link,
          childLid: action.childLid,
          childTitle: action.childTitle,
        };
      });
    case 'RESTORE_CHAPTER': {
      const blocked =
        bodyWriteBlockReason(state, action.lid) ?? bodyWriteBlockReason(state, action.childLid);
      if (blocked !== null)
        return { state: { ...state, error: blockedWithSuffix(blocked, '、章を元に戻してください') }, events: [] };
      const into = state.entryMetas.get(action.lid);
      const child = state.entryMetas.get(action.childLid);
      if (!into || !child || action.lid === action.childLid) return { state, events: [] };
      // 🔴 本当にここから切り出した子だけ(つながりが在る)。種類が変わっていたら断る(#1439 レビュー ⚠4)
      if (!state.relations.some((r) => r.kind === 'provenance' && r.fromLid === action.childLid && r.toLid === action.lid))
        return {
          state: { ...state, error: 'このノートから切り出した章ではないため、元に戻せません(つながりが見つかりません)' },
          events: [],
        };
      if (child.archetype !== 'text')
        return {
          state: { ...state, error: '切り出した先の種類が変わっているため、元に戻せません(普通のノートに戻してから試してください)' },
          events: [],
        };
      const shown = screenBodyOf(state, action.lid);
      const openLine = shown?.split('\n')[action.line];
      if (shown === null || openLine === undefined) return { state, events: [] };
      return {
        state,
        events: [
          {
            type: 'REQUEST_CHAPTER_RESTORE',
            into: {
              lid: into.lid,
              title: into.title,
              archetype: into.archetype,
              entryOrder: into.entryOrder,
              line: action.line,
              openLine,
            },
            child: { lid: child.lid, title: child.title },
          },
        ],
      };
    }
    /**
     * 🔴 **本文の塊を、別のノートへ持っていく**(#684 段③)。
     *
     * 門(どれか 1 つでも外れたら黙って何もしない):
     * - 相(`ready`)── 編集中は**声に出して断る**(`bodyRewriteGate` と同じ言い方)
     * - 元のノートの本文が**画面に出ている**(掴んだ時点の行をそこから捕える)
     * - 行き先が**別のノート**で、実在し、**本文に入れられる種類**
     *   (フォルダ・添付・スタックへは持っていかない ── 断り方は落とす側が出す)
     * ⚠ 同じノートなら `MOVE_BLOCK` の仕事である(ここでは撃たない)。
     */
    case 'HANDOFF_BLOCK': {
      const { fromLid, start, end, toLid } = action;
      if (state.phase !== 'ready')
        return {
          state: {
            ...state,
            error: `${phaseBlockReason(state.phase)}、本文のブロックを別のノートへ移してください`,
          },
          events: [],
        };
      if (fromLid === toLid) return { state, events: [] };
      const from = state.entryMetas.get(fromLid);
      const to = state.entryMetas.get(toLid);
      if (!from || !to || !isAppendable(to.archetype)) return { state, events: [] };
      const shown = screenBodyOf(state, fromLid);
      if (shown === null) return { state, events: [] };
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start)
        return { state, events: [] };
      const rows = shown.split('\n');
      if (end >= rows.length) return { state, events: [] };
      return {
        state,
        events: [
          {
            type: 'REQUEST_BLOCK_HANDOFF',
            from: {
              lid: from.lid,
              title: from.title,
              archetype: from.archetype,
              entryOrder: from.entryOrder,
              start,
              end,
              lines: rows.slice(start, end + 1),
            },
            to: {
              lid: to.lid,
              title: to.title,
              archetype: to.archetype,
              entryOrder: to.entryOrder,
              toBefore: action.toBefore,
              ...(action.anchor === undefined ? {} : { anchor: action.anchor }),
            },
          },
        ],
      };
    }
    /**
     * 🔴 **一覧の行を本文へ落とすとリンクになる**(#684 段②)── 同じ門。空の並びは撃たない。
     * ⚠ 落とした所へ入れる添付(#684 段④)も同じ口を通る ── 入る字が違うだけで、
     *   「本文のここへ 1 塊を差し込む」は同じ 1 つの操作である(§7)。
     * 🔑 断り文の**続き**は**押した場所と対**なので、掴んだ物の名前は呼び側が渡す
     *   (`refusal`。前置きは `bodyRewriteGate` が `phaseBlockReason` から付ける ──
     *   C11b / #1045)── ここで 1 本に丸めると、file を落とした user が「一覧の行」と言われる。
     * ⚠ 段④ は `writable-queue` が**書けるようになってから**撃つので、実際にはここへ
     *   来ない ── それでも既定に頼らず渡すのは、来たときに嘘を言わせないためである。
     * 🔴 **`shown` を読まない**(座標も字も呼び側が持っている)── だから画面に本文が
     *   出ていなくても通す。⚠ これは緩めているのではなく、**この経路では画面に
     *   出ていないのが普通**だからである:添付を取り込むと `CREATE_ENTRY` が選択を
     *   移し、`SELECT_ENTRY` で戻す時に旧 `openBody` が捨てられる(本文は非同期に
     *   読み直される)。画面を要求すると、落とした所は**一度も使われない**。
     */
    case 'INSERT_LINES':
      return bodyRewriteGate(
        state,
        action.lid,
        action.refusal ?? '、一覧の行を本文へドロップしてください',
        () =>
          Number.isInteger(action.toBefore) && action.lines.length > 0
            ? {
                kind: 'insert-lines',
                toBefore: action.toBefore,
                lines: action.lines,
                anchor: action.anchor,
                ...(action.batch === undefined ? {} : { batch: action.batch }),
              }
            : null,
      );
    /**
     * 🔴 **直前の塊の移動を元に戻す**(#684 段①)── `UNDO_APPEND` と同じ形。
     * ⚠ **1 手で使い切る**(`lastMove` を落とす)。戻した結果も `BODY_REWRITTEN` が
     *   `move-lines` として届くので、そこでまた「戻す」の材料が入る(= 押し直せる)。
     */
    case 'UNDO_MOVE': {
      const last = state.lastMove;
      if (!last) return { state, events: [] };
      /**
       * 🔴 **断るなら声に出す。判定は lid で**(#1051)。⚠ 直す前は `phase !== 'ready'` で
       *   **黙って捨てて**いた。`START_EDIT` は材料を捨てるが、🔴 **動かした書換の ack が
       *   編集に入った後に返ると、材料がもう一度入る**(`BODY_REWRITTEN` の `move-lines` は
       *   phase を見ない)── 状態の行に「移動を元に戻す」が出て、押しても何も起きなかった。
       * ⚠ 編集中に**新しく**塊を動かす道は、いまの画面には無い(留めた枠の ⠿ が編集中は
       *   出ない ── #1081)。ここを lid で見るのは、他の書換と同じ門に揃えるためである。
       * ⚠ 断った回は**材料を残す**(`UNDO_APPEND` と同じ)。
       */
      const blockedResult = bodyWriteBlockResult(state, last.lid, '移動を元に戻してください');
      if (blockedResult !== null) return blockedResult;
      const meta = state.entryMetas.get(last.lid);
      if (!meta) return { state: { ...state, lastMove: null }, events: [] };
      return {
        state: { ...state, lastMove: null },
        events: [
          {
            type: 'REQUEST_BODY_REWRITE',
            lid: meta.lid,
            title: meta.title,
            archetype: meta.archetype,
            entryOrder: meta.entryOrder,
            rewrite: {
              kind: 'move-lines',
              start: last.start,
              end: last.end,
              toBefore: last.toBefore,
              lines: last.lines,
              toBeforeLine: last.toBeforeLine,
              // 🔴 動かす前の本文そのものへ戻す回(依頼 118-3)── 本文が変わっていなければ空行の数まで元どおりになる
              ...(last.restore === undefined ? {} : { restore: last.restore }),
            },
          },
        ],
      };
    }
    case 'SET_ENTRY_DATE': {
      // 🔴 **黙って捨てない**(#516)── 理由は `slices/body-edit.ts` の `SET_TASK_DATE` に書いた
      // ⚠ 断りは lid で判定する(C6 / #1043)── 予定表の他の書換(繰り返しの回)と揃える
      const blocked = bodyWriteBlockReason(state, action.lid);
      if (blocked !== null)
        return {
          state: {
            ...state,
            error: blockedWithSuffix(blocked, action.date === null ? 'ノートの日付を外してください' : 'ノートに日付を付けてください'),
          },
          events: [],
        };
      // 未知 lid は no-op
      const meta = state.entryMetas.get(action.lid);
      if (!meta) return { state, events: [] };
      // ⚠ 同じ値なら何もしない(空の書込を投げない)。時刻を添えた回は、同じ日でも時刻が違うことがある(書換が同じ字なら書かない)
      if ((meta.date ?? null) === action.date && action.time === undefined) return { state, events: [] };
      return {
        state,
        events: [
          {
            type: 'REQUEST_BODY_REWRITE',
            lid: meta.lid,
            title: meta.title,
            archetype: meta.archetype,
            entryOrder: meta.entryOrder,
            // 🔴 時刻つきの `date:`(`2026-10-20 14:00`)は日だけ替えて時刻を残す ── 書換は `entry-date` 1 本(依頼 192 / 284)
            rewrite: { kind: 'entry-date', date: action.date, ...(action.time === undefined ? {} : { time: action.time }) },
          },
        ],
      };
    }
    /**
     * ⚠ 断りは lid で判定する(C6 / #1043)── todo 以外・未知 lid は今までどおり no-op。
     */
    case 'TOGGLE_TODO_STATUS': {
      const blocked = bodyWriteBlockReason(state, action.lid);
      if (blocked !== null)
        return { state: { ...state, error: blockedWithSuffix(blocked, `状態を切り替えてください`) }, events: [] };
      const meta = state.entryMetas.get(action.lid);
      if (!meta || meta.archetype !== 'todo') return { state, events: [] };
      const nextStatus = meta.status === 'done' ? 'open' : 'done';
      // state はまだ動かさない ── store への書込が確定した TODO_TOGGLED(ack)で
      // 列が動く(persisted 規律と同じ「enqueue と ack を混同しない」)。
      // ack 前の連打は stale meta 基準で同方向になる(往復しない)── 安全側の
      // debounce 的意味論として意図どおり(review #6)
      return {
        state,
        events: [
          {
            type: 'REQUEST_BODY_REWRITE',
            lid: meta.lid,
            title: meta.title,
            archetype: 'todo',
            entryOrder: meta.entryOrder,
            rewrite: { kind: 'frontmatter', keys: { status: nextStatus } },
          },
        ],
      };
    }
    case 'BODY_REWRITTEN': {
      // TODO(P6/P7 コンテナ切替導入時): cid を event/ack に載せて跨ぎ ack を
      // 捨てる(lid 偶然衝突 ── review F と同型の穴。P3-6a review #7)
      const meta = state.entryMetas.get(action.lid);
      if (!meta) return { state, events: [] }; // 再 boot 済みなら捨てる
      const entryMetas = new Map(state.entryMetas).set(action.lid, {
        ...meta,
        status: action.status,
        date: action.date,
        archived: action.archived,
      });
      let openBody = state.openBody;
      if (openBody?.lid === action.lid) {
        if (state.phase === 'editing') {
          // toggle 直後に同じ entry の編集へ入った稀な窓: draft は触らず、
          // persisted の追従 + **diskAhead の印**だけ付ける。変更ありの commit は
          // draft が勝つ(可視内容の last-write-wins)が、無変更 commit / cancel は
          // disk を採用する(review #4 ── 窓の外へ帰結を生き残らせない)
          openBody = { ...openBody, persisted: action.body, diskAhead: true };
        } else if (
          state.phase === 'error' &&
          openBody.baseline !== openBody.persisted &&
          !openBody.diskAhead
        ) {
          // persist 失敗中(未達 commit あり)に後着 toggle が成功した窓:
          // 丸ごと差し替えると baseline===persisted になり「未達の証拠」ごと
          // 消える(review #4 ── v2 が回収不能)。baseline に status を合流させ、
          // 再保存が「未達のテキスト + 新しい status」の両方の意図を書く
          // ⚠ 合流も**やった書換そのもの**で当て直す(#276 / #277)── todo の
          //   status に固定していると、日付やチェックを書いた回で**それが落ちる**
          const merged = applyBodyRewrite(openBody.baseline, action.rewrite) ?? openBody.baseline;
          openBody = {
            lid: action.lid,
            body: openBody.body === openBody.baseline ? merged : openBody.body,
            baseline: merged,
            persisted: action.body,
            diskAhead: false,
          };
        } else {
          // ready では body===baseline 不変量が立つので丸ごと差し替えで安全
          openBody = {
            lid: action.lid,
            body: action.body,
            baseline: action.body,
            persisted: action.body,
            diskAhead: false,
          };
        }
      }
      /**
       * 🔴 **押した札をその場で動かす**(#277 段②-b)。ack は**新しい本文**を
       * 持っているので、そのノートの札はここで組み直せる ── 集め直しを頼むと
       * 往復のぶん札が固まったままになり、押した手応えが消える。
       * ⚠ 触るのは**そのノートの札だけ**(他のノートを並び直さない)。
       * ⚠ 盤面を一度も開いていなければ `null` のまま(何もしない)。
       */
      const taskScan = refreshTaskCards(state.taskScan, action.lid, action.body);
      /**
       * 🔴 **塊を動かした回は「元に戻す」の材料を入れ、知らせを出す**(#684 段①)。
       *
       * 逆向きの指示は、動かす**前**の本文(この ack が届く前に画面が持っていた本文)から
       * 計算する。⚠ その本文から同じ結果(`action.body`)が出ないとき(= 画面が古かった)は
       * 材料を入れない ── 当てずっぽうの位置へ戻さない(`undo-append` の「見つからなければ
       * 断る」と同じ向き)。
       * ⚠ 同じノートへの**別の**書換は、行がずれうるので材料を捨てる(`lastMove` は位置を持つ)。
       * 🔑 知らせは `OP_NOTICE` と同じ 2 つ(`notice` / `noticeOpen`)を書く ── 「開く」の
       *   身元は添えないので `null`(次の知らせで消える作法のまま)。
       */
      let lastMove = state.lastMove;
      let notice = state.notice;
      let noticeOpen = state.noticeOpen;
      if (action.rewrite.kind === 'move-lines') {
        const before = screenBodyOf(state, action.lid);
        const moved = before === null ? null : moveLinesWithInverse(before, action.rewrite);
        lastMove =
          moved !== null && moved.body === action.body && moved.inverse !== null
            ? { lid: action.lid, ...moved.inverse }
            : null;
        if (lastMove !== null) {
          notice = BLOCK_MOVED_NOTICE;
          noticeOpen = null;
        }
      } else if (lastMove !== null && lastMove.lid === action.lid) {
        lastMove = null;
      }
      /**
       * 🔴 **差し込んだ回も「元に戻す」の材料を入れる**(#684 段④)。
       *
       * ⚠ 直す前、本文へ入る添付は `APPEND_TO_ENTRY`(末尾)だけで、そちらは
       *   `ENTRY_APPENDED` が材料を入れていた ── **落とした所へ入れる経路に
       *   移した瞬間、追記欄の「元に戻す」が黙って消える**(動線を 1 つ失う。
       *   user 指示 2026-08-23「片道の操作を作らない」)。
       * 🔑 **足した行は「結果から」取り出す**(`insertedLines`)── 前後に空行を補う
       *   作法をここで書き写すと、規則が 2 か所になる(§7)。⚠ 補った空行まで
       *   材料に入るので、まとめて落とした 2 枚目以降の run は 1 枚目の**すぐ後ろ**に
       *   並ぶ = `removeInsertedLines` が 1 手として消せる(`nextLastAppend` の前提)。
       * ⚠ **画面の本文は読まない**(着地前レビュー E で直した)── ここへ来る書換は
       *   画面に本文が出ていなくても通る(段④ の経路がまさにそれ)。材料は
       *   **書いた結果から**効果層が出し、純粋な挿入でなければ `null` が届く
       *   ── そのときは材料を入れない(当てずっぽうで消さない)。
       */
      let lastAppend = state.lastAppend;
      if (action.rewrite.kind === 'insert-lines') {
        lastAppend = nextLastAppend(lastAppend, {
          lid: action.lid,
          inserted: action.inserted ?? null,
          insertedAt: action.insertedAt ?? null,
          ...(action.rewrite.batch === undefined ? {} : { batch: action.rewrite.batch }),
        });
      }
      /**
       * 🔴 **表の形を変えたら、変えたと言う**(#708 段②、着地前レビュー・動線 ①)。
       *
       * ⚠ 直す前は**完全に無言**だった ── 本文が丸ごと書き換わるのに、画面に出る
       *   変化は「表の幅が変わる」だけで、user には**壊れたように見える**。
       * 🔑 言うのは**できるようになったこと**である(幅ではなく用途)。
       * ⚠ **2026-09-05(段④)に字を直した** ── それまでは csv 側を「升を押して打てる」と
       *   言っていたが、段④ で**markdown の表の升も押せる**ようになったので、
       *   その字は**両方で真 = 何も伝えていない**。いま形で変わるのは
       *   **行・列の ＋ ×** と**式**である(そこだけを言う)。
       * ⚠ **戻し方も同じ 1 行で言う** ── 帰り道を知っているのは実装した本人だけ、
       *   という形にしない(#300 の実害と同じ型)。
       * 🔴 **帰り道は「▾」で言う**(#708 裁定②の着地前レビュー・動線 D1)。
       *   ⚠ 直す前は「もう一度**右クリック**」と書いていたが、
       *   **指で触る端末に右クリックは無い** ── この裁定はまさに
       *   「右クリックが無い端末に入口を作る」ためのもので、そこで押した user に
       *   **その端末に存在しない操作**で戻れと言っていた。
       *   🔑 「▾」は**どちらの端末にも出る**(表の右上)ので、常に真である。
       * 🔴 **往復で落ちるものも同じ 1 行で言う**(同 D6 / I5)。
       *   ⚠ 「もう一度押せば戻る」は**完全には戻らない** ── 桁揃え(右寄せ・中央寄せ)は
       *   csv に書けないので落ち、markdown へ戻すと行・列の ＋ × と式が使えなくなる。
       *   ⚠ マニュアルには書いてあるが、**右クリックの節の中だけ**だった
       *   (指の端末の user はその節を読まない)。
       */
      if (action.rewrite.kind === 'table-format' && action.rewrite.header !== undefined) {
        // 🔴 見出しの切り替え(#1662 3)── 戻し方も言う(同じ ▾ の小窓)
        notice = action.rewrite.header
          ? '表の 1 行目を見出しにしました(戻すには表の右上の ▾ から)'
          : '表の見出しをやめました(戻すには表の右上の ▾ から)';
        noticeOpen = null;
      } else if (action.rewrite.kind === 'table-format') {
        notice =
          action.rewrite.to === 'csv'
            ? '表を CSV の表にしました。式が使えます(戻すには表の右上の ▾ から。桁揃えは戻りません)'
            : '表を Markdown の表にしました。よそへ貼りやすい字になります(戻すには表の右上の ▾ から。式は使えなくなります)';
        noticeOpen = null;
      }
      /**
       * 🔑 **タグを付けたら、開いている入れ物にその場で落ちる**(user 要望 2026-08-26)。
       * ⚠ ここは**まとめてタグを付ける**経路でもある(`REQUEST_BULK_TAG` が 1 件ずつ
       *   ack を撃つ)── worker に頼み直す形だと 100 件で 100 回の全件走査になる。
       */
      const smartHits = refreshSmartHits(state.smartHits, action.lid, action.body, entryMetas);
      /**
       * 🔴 **タグを書いたら候補を捨てる**(#494 段②)── 次に欄へ焦点が当たったら
       * 集め直す。⚠ 捨てないと、**付けたばかりのタグが候補に出ない** ── user は
       * 「効いていない」と読む(押した手応えが消える型)。
       * ⚠ **その場で足すのではなく捨てる** ── 足すだけだと「外した最後の 1 件」が
       *   候補に残り続ける(片側だけ追随する形。§7)。
       */
      const tagSuggestions =
        action.rewrite.kind === 'tag' ? null : state.tagSuggestions;
      /**
       * 🔴 **留めた枠にも同じノートが出ていることがある**(#757、2026-09-08)。
       *
       * ⚠ **これが無いと、左で升を打っても・チェックを押しても・日付を書いても、
       *   右(横に留めた枠)は古い字のまま**である ── user から見れば
       *   「どちらが本当か分からない」形で、直したはずの所をもう一度直すことになる。
       *
       * 🔴 **`BODY_PERSISTED` と `REMOTE_BODY_CHANGED` には既に在ったのに、
       *   ここだけ抜けていた**(§7「同じ問いに答える口が複数あると、片方だけ直る」)。
       *   ⚠ しかも**いちばん通る経路**である ── 升を打つ・チェックを押す・日付を書くは
       *   全部 `REQUEST_BODY_REWRITE` → `BODY_REWRITTEN` を通り、
       *   `BODY_PERSISTED` は**通らない**(`store-effects.ts` が `BODY_REWRITTEN` しか出さない)。
       */
      const rewrittenShown = syncShownBodies(state, action.lid, action.body);
      return {
        state: {
          ...state,
          entryMetas,
          openBody,
          taskScan,
          smartHits,
          tagSuggestions,
          lastMove,
          lastAppend,
          notice,
          noticeOpen,
          ...rewrittenShown,
        },
        events: [],
      };
    }
  }
}
