/**
 * reducer の slice: ノートの作成・削除・改名・親 / 並び / 関係 / タグ(#1383)。
 *
 * 🔑 `app-state.ts` の `reduceCore` から**機械的に移した**(case 本体は 1 文字も変えていない)。
 *   `reduceCore` は label を列挙してここへ渡す ── `switch` の網羅検査は両側で効く
 *   (`reduceCore` に label が無ければ `reduceEntries` に届かず、ここに case が無ければ tsc が落ちる)。
 * ⚠ 履歴・2 ペインの掃除・バックリンクは `reduceWithHistory` の 1 か所で見る(ここでは見ない)。
 */

import {
  type AppState,
  type Dispatchable,
  type DomainEvent,
  EMPTY_TITLE_NOTE,
  type ReduceResult,
  hasSameRelation,
  phaseBlockReason,
  removeEntryFromState,
  successorInShownRows,
} from '../app-state';
import type { EntryMeta } from '@core/model/entry-meta';
import { NO_KINDS, entryFilterOf, visibleOrder } from '@features/filter/title-filter';
import { extractMeta, seedBodyFor } from '@features/flavor';
import { kindChangeTarget } from '@features/flavor/kind-change';
import { STRUCTURAL } from '@features/relation/kinds';
import { reorderSibling, structuralParentsLookup, wouldMakeCycle } from '@features/relation/tree';
import { SMART_ARCHETYPE } from '@features/smart/smart-spec';

export type EntriesAction = Extract<Dispatchable, { type: 'CREATE_ENTRY' | 'DELETE_ENTRY' | 'DELETE_ENTRIES' | 'RENAME_ENTRY_TITLE' | 'SET_ENTRY_ARCHETYPE' | 'SET_ENTRY_PARENT' | 'SET_ENTRY_ORDER' | 'MOVE_ENTRY_ORDER' | 'ADD_RELATION' | 'SET_ENTRY_ARCHETYPE_ROLLBACK' | 'ROLLBACK_ENTRY_PARENT' | 'ROLLBACK_RELATION' | 'REMOVE_RELATION' | 'BULK_TAG' | 'RENAME_SMART_TAG' }>;

export function reduceEntries(state: AppState, action: EntriesAction): ReduceResult {
  switch (action.type) {
    case 'CREATE_ENTRY': {
      // ready 限定(ただし keepSelection 時は編集中でも編集状態を保ったまま作成可能 ── #1085)。
      // lid 衝突は作らない(binder 生成の単調 lid が壊れた場合の防波堤)
      // 🔑 `keepSelection` は「読んでいる物を退かさない」なので、編集にも入らない
      const keep = action.keepSelection === true;
      if (state.phase !== 'ready' && !(state.phase === 'editing' && keep)) return { state, events: [] };
      if (state.entryMetas.has(action.lid)) {
        return {
          // ⚠ 英語の内部文と ID を画面に出さない(#1087)── 新しい ID は押すたびに作り直すので、もう一度で通る
          state: { ...state, error: 'ノートを作れませんでした(同じ番号のノートがすでにありました)。もう一度押してください' },
          events: [],
        };
      }
      const body = action.body ?? seedBodyFor(action.archetype);
      const wantsEdit = action.edit !== false && !keep;
      const ext = extractMeta(action.archetype, body);
      const lastLid = state.order[state.order.length - 1];
      const entryOrder = lastLid
        ? (state.entryMetas.get(lastLid)?.entryOrder ?? 0) + 1
        : 1;
      const meta: EntryMeta = {
        lid: action.lid,
        title: action.title,
        archetype: action.archetype,
        createdAt: null, // worker が datetime('now') を刻む(次 boot で読み戻る)
        updatedAt: null,
        entryOrder,
        status: ext.status,
        date: ext.date,
        archived: ext.archived,
        // ⚠ worker が同じ本文から数え直す値と**同じ式**で置く(§7)
        bodyChars: body.length,
      };
      /**
       * 🔴 **いま見ているフォルダの中に作る**(2026-08-05)。
       * ⚠ 入れ先が folder でない / 実在しないなら**黙ってルートに作る** ──
       *    ここで作成ごと断ると、user は「押しても何も起きない」を見る
       *    (作れないより、意図と違う場所に見えているほうが直せる)。
       * ⚠ 自己辺は作らない(作った当人が入れ先になることはあり得ないが、
       *    lid 生成が壊れたときの防波堤)。
       */
      const parentMeta =
        action.parentLid != null && action.parentLid !== action.lid && action.relationId
          ? state.entryMetas.get(action.parentLid)
          : undefined;
      const parentLid =
        parentMeta && parentMeta.archetype === 'folder' ? (action.parentLid as string) : null;
      const relations =
        parentLid === null
          ? state.relations
          : [
              ...state.relations,
              {
                id: action.relationId as string,
                fromLid: parentLid,
                toLid: action.lid,
                kind: STRUCTURAL,
                // ⚠ 時刻は worker が刻む(SET_ENTRY_PARENT と同じ約束)
                createdAt: null,
                updatedAt: null,
              },
            ];
      /**
       * 🔴 **添付の作成は絞りを外さない**(#668 D)。
       *
       * 下の「絞り込みを解除する」の理由(review M-2 / #411)は「**作った物が絞りに
       * 弾かれて一生一覧に出ない** → user が Esc で消してしまう」である ── ⚠ 添付には
       * 当たらない。添付は**開いていたノートの本文に入る**(#666)ので一覧で見せる
       * 必要が無く、編集に入らないので Esc の掃除も無い。
       * ⚠ むしろ外すと害が出る:「探す」に打っていた字と種類の札が、写真を 1 枚
       *   足しただけで**黙って消える**(user は絞りを打ち直す)。
       * 🔑 判定は archetype 1 つ ── 添付を作る経路(取込 / 録音 / 画面録画 /
       *   ランチャーのタイル)は全部ここを通る。
       */
      const keepFilter = action.archetype === 'attachment';
      // 作成 = 即永続(PKC2 と同じ)。この初回 PERSIST が失敗した場合、editing 中の
      // 無変更 commit は skip するが、行は upsert なので次の変更 commit が自己修復する
      // (二重故障窓のみ残る ── SYS_ERROR が可視。P3-7a 設計判断)
      return {
        state: {
          ...state,
          relations,
          phase: keep ? state.phase : wantsEdit ? 'editing' : 'ready', // keepSelection 時は相を維持(#1085)、既定は作成 → 即編集(PKC2 の遷移)
          entryMetas: new Map(state.entryMetas).set(action.lid, meta),
          order: [...state.order, action.lid],
          selectedLid: keep ? state.selectedLid : action.lid,
          // 🔴 **絞り込みを解除する**(review M-2)。既定題名は絞り込み語に一致
          // しないので、絞り込み中に作ると **一生一覧に出ない** entry ができていた
          // (実証: 保存しても出ず、「効かなかった」と思って Esc を押すと
          // 新規未編集 cancel の掃除で entry ごと消える)。
          // ⚠ 欄の文字も消える ── 書き戻しは sidebar が持つ
          filterQuery: keepFilter || keep ? state.filterQuery : '',
          /**
           * 🔴 **種類の絞りも外す**(#411)── **同じ事故が軸を変えて戻ってくる**。
           * 「添付だけ」を出しているときに「ノート」を作ると、作った物は
           * 札に弾かれて**一生一覧に出ない**。user は「効かなかった」と思って
           * Esc を押し、新規未編集 cancel の掃除で **entry ごと消える**
           * (review M-2 で `filterQuery` について実証済みの経路そのもの)。
           */
          kindFilter: keepFilter || keep ? state.kindFilter : NO_KINDS,
          freshLid: wantsEdit ? action.lid : null, // 非編集作成は fresh 掃除の対象外
          // 🔴 **`error` はここで消さない**(設計 doc §7、段②a)。
          // ⚠ 退かさない作成では、開いている本文もそのまま(新しい物は選ばれていないので持たない)
          openBody: keep
            ? state.openBody
            : {
                lid: action.lid,
                body,
                baseline: body,
                persisted: body, // 楽観(ack 前)── 上記コメントの範囲で許容
                diskAhead: false,
              },
        },
        events: [
          {
            type: 'PERSIST_ENTRY',
            entry: {
              lid: action.lid,
              title: action.title,
              archetype: action.archetype,
              body,
              entryOrder,
              status: ext.status,
              date: ext.date,
              archived: ext.archived,
            },
            /**
             * 🔴 **居場所は同じ tx で書く**(#258)。直す前は `REQUEST_SET_PARENT` を
             * 後ろに並べる **2 手**で、effect が 1 件ずつ worker へ流すので
             * 「行を書く → ack → 辺を書く」の隙にタブを閉じると**親だけ飛んだ**
             * (フォルダの中に作ったのにルートに現れる)。⚠ 並びを入れ替えても直らない
             * (行の無いところへ辺を張ることになる)── **1 tx にする**のが答え。
             */
            ...(parentLid === null
              ? {}
              : { parent: { parentLid, relationId: action.relationId as string } }),
          },
          /**
           * 🔴 **作って即編集の経路でも雛形を集める**(#196 / B-2)。
           *
           * ⚠ 2026-08-25 に**実ブラウザの smoke が拾った** ── `START_EDIT` にだけ
           *   置いていたので、**作成から入った編集では短縮語が 1 つも当たらなかった**。
           *   unit は「編集」を押す経路しか通しておらず、**この経路は 1 度も
           *   走っていなかった**(CLAUDE.md §2)。
           * 🔑 「編集に入る」は 2 経路ある ── 片方だけに置くと、もう片方が黙って死ぬ。
           */
          ...(wantsEdit ? [{ type: 'REQUEST_SNIPPET_SCAN' as const }] : []),
        ],
      };
    }
    case 'DELETE_ENTRY': {
      if (state.phase !== 'ready') return { state, events: [] };
      if (!state.entryMetas.has(action.lid)) return { state, events: [] };
      // UI からは即時に消す(楽観)── worker 側 op は relations / revisions 込みの
      // 同 tx 掃除(P3-6b)。失敗は OP_FAILED 通知(reload で再出現 = 非破壊)
      return removeEntryFromState(state, action.lid, [
        { type: 'REQUEST_DELETE', lid: action.lid },
      ]);
    }
    case 'DELETE_ENTRIES': {
      if (state.phase !== 'ready') return { state, events: [] };
      // ⚠ 居ないものは黙って落とす(消えた行を選んだまま押しても事故にしない)
      const targets = action.lids.filter((lid) => state.entryMetas.has(lid));
      if (targets.length === 0) return { state, events: [] };
      /**
       * ⚠ **1 件ずつ `removeEntryFromState` を畳む**(規則を 2 つ書かない)。
       * 後継の選択・履歴の掃除・ゴミ箱の畳みは、そちらが 1 か所で持っている。
       * ⚠ 事象(`REQUEST_DELETE`)は**まとめて 1 回**の worker op にせず 1 件ずつ出す
       * ── 既存の効果の口をそのまま使い、片方だけ失敗しても残りが進む。
       */
      let next = state;
      const events: DomainEvent[] = [];
      /**
       * 🔴 **後継は最後に 1 回だけ選ぶ**(#1087)。1 件ずつ選ぶと、消す途中の後継ごとに本文の読み出し
       *   (`REQUEST_BODY`)が積まれ、3000 件で 2999 回読んでいた(しかも毎回 `visibleOrder` を作り直す)。
       * 🔑 規則は 1 件ずつ消したときと同じ:消す位置の次(居なければ手前の最後)── 消す物を除いた
       *   見えている並びで、位置は「選んでいた物より前に残る数」。
       */
      let successor: string | null = null;
      const removesSelected = state.selectedLid !== null && targets.includes(state.selectedLid);
      if (removesSelected) {
        const gone = new Set(targets);
        const before = visibleOrder(
          state.order,
          (l) => state.entryMetas.get(l),
          entryFilterOf(state.filterQuery, state.searchHits, state.kindFilter),
        );
        const vIdx = before.indexOf(state.selectedLid!);
        // 🔴 まず左の列に出ている行から選ぶ(#1087。1 件ずつ消す側と同じ規則)。居なければ従来どおり
        const shown = successorInShownRows(state, state.selectedLid!, gone);
        if (shown !== undefined) {
          successor = shown;
        } else if (vIdx >= 0) {
          const kept = before.filter((l) => !gone.has(l));
          const pos = before.slice(0, vIdx).filter((l) => !gone.has(l)).length;
          successor = kept[Math.min(pos, kept.length - 1)] ?? null;
        }
      }
      for (const lid of targets) {
        const r = removeEntryFromState(next, lid, [{ type: 'REQUEST_DELETE', lid }], {
          pickSuccessor: false,
        });
        next = r.state;
        events.push(...r.events);
      }
      if (removesSelected && successor !== null) events.push({ type: 'REQUEST_BODY', lid: successor });
      // ⚠ 消したものが印に残らない(`removeEntryFromState` が 1 件ずつ外している)
      return {
        state: {
          ...next,
          selectedLid: removesSelected ? successor : next.selectedLid,
          selection: [],
          selectionAnchor: null,
        },
        events,
      };
    }
    case 'RENAME_ENTRY_TITLE': {
      if (state.phase !== 'ready' && state.phase !== 'editing')
        return { state, events: [] };
      const meta = state.entryMetas.get(action.lid);
      const title = action.title.trim();
      // 🔴 空は元のまま ── ただし**黙らず言う**(本文は触らない。保存の経路はこの後も同じ)
      if (meta && title === '') return { state: { ...state, notice: EMPTY_TITLE_NOTE }, events: [] };
      if (!meta || title === meta.title) return { state, events: [] };
      // title はローカルが唯一の知識源なので楽観更新(sidebar が即応)。
      // 永続化は effect が disk body を読んで行全体を書く(REQUEST_RENAME)。
      // 直後に COMMIT_EDIT が続く場合も、更新済み meta から行を組むので title は保たれる
      return {
        state: {
          ...state,
          entryMetas: new Map(state.entryMetas).set(action.lid, { ...meta, title }),
          freshLid: state.freshLid === action.lid ? null : state.freshLid,
        },
        events: [
          {
            type: 'REQUEST_RENAME',
            lid: action.lid,
            title,
            oldTitle: meta.title,
            skipLids: state.phase === 'editing' && state.openBody ? [state.openBody.lid] : [],
            archetype: meta.archetype,
            entryOrder: meta.entryOrder,
          },
        ],
      };
    }
    case 'SET_ENTRY_ARCHETYPE': {
      // 編集中は変えない ── 開いている下書きの種類(追記・見出しの扱い)が途中で変わる。理由を言う(黙って断らない)
      if (state.phase !== 'ready') {
        return {
          state: { ...state, error: `${phaseBlockReason(state.phase) ?? ''}種類を変えてください` },
          events: [],
        };
      }
      const meta = state.entryMetas.get(action.lid);
      if (!meta || meta.archetype === action.archetype) return { state, events: [] };
      // ⚠ 変えられるのはノート ⇄ ログだけ(`kindChangeTarget`)。それ以外は手を付けない
      if (kindChangeTarget(meta.archetype) !== action.archetype) return { state, events: [] };
      // 種類は画面が先に変わる(題名の改名と同じ楽観更新)。永続化は effect が disk の本文を読んで行を書く
      return {
        state: {
          ...state,
          entryMetas: new Map(state.entryMetas).set(action.lid, { ...meta, archetype: action.archetype }),
        },
        events: [
          {
            type: 'REQUEST_SET_ARCHETYPE',
            lid: action.lid,
            title: meta.title,
            archetype: action.archetype,
            oldArchetype: meta.archetype,
            entryOrder: meta.entryOrder,
          },
        ],
      };
    }
    case 'SET_ENTRY_PARENT': {
      // 🔴 **フォルダ整理の唯一の入口**(2026-08-05、user 報告
      // 「フォルダ整理のための導線がない」)。直す前は UI どころか
      // action・reducer・effect のどこにも relation を編集する経路が無く、
      // フォルダは作れるのに**永久に空**だった。
      if (state.phase !== 'ready') return { state, events: [] };
      const child = state.entryMetas.get(action.lid);
      if (!child) return { state, events: [] };
      const parentLid = action.parentLid;
      if (parentLid !== null) {
        const parent = state.entryMetas.get(parentLid);
        // ⚠ 入れ先は**実在するフォルダ**でなければならない(木の規約 ──
        //    `resolveCanonicalParents` は非 folder 親の辺を無視するので、
        //    ここで通すと「移したのに動かない」黙りになる)
        if (!parent || parent.archetype !== 'folder') return { state, events: [] };
        if (parentLid === action.lid) return { state, events: [] }; // 自分の中へは入れない
        // 🔴 **自分の子孫の中へは入れない**(輪ができて木でなくなる)。
        //    ⚠ 判定はここでやる ── worker は metas を持たないので木を知らない
        // 🔴 辿るのは正準親だけではなく**居場所の辺すべて**(多重親の別の鎖に自分が居ても輪になる)。
        //    ⚠ 訪問済みで止める ── disk に輪が残った器を開いたとき(#1087 ゴミ箱の見直し)に回り続けない。
        //    判定は `wouldMakeCycle` 1 本(worker の tx の門と同じ)
        if (wouldMakeCycle(action.lid, parentLid, structuralParentsLookup(state.relations))) {
          return { state, events: [] };
        }
      }
      // 楽観更新 ── 画面(ファイラ)は state.relations から描くので、
      // ここで直さないと「押したのに動かない」に見える
      const kept = state.relations.filter(
        (r) => !(r.kind === STRUCTURAL && r.toLid === action.lid),
      );
      // 🔴 移す前の居場所(書けなかったときに戻す。依頼 115-4 A)
      const removedBefore = state.relations.filter(
        (r) => r.kind === STRUCTURAL && r.toLid === action.lid,
      );
      /**
       * 🔴 **2 本目以降の親**(台帳 #1852 G1 / 依頼 227 A)── 「元に戻す」が、入っていたフォルダ全部へ戻すための口。
       * 1 本目と同じ検め(実在するフォルダ・自分でない・輪にならない)を通った分だけ張る。重複は 1 本に畳む。
       */
      const extraParents: { parentLid: string; relationId: string }[] = [];
      if (parentLid !== null) {
        const lookup = structuralParentsLookup(state.relations);
        for (const extra of action.alsoIn ?? []) {
          const ep = state.entryMetas.get(extra.parentLid);
          if (!ep || ep.archetype !== 'folder') continue;
          if (extra.parentLid === action.lid || extra.parentLid === parentLid) continue;
          if (extraParents.some((x) => x.parentLid === extra.parentLid)) continue;
          if (wouldMakeCycle(action.lid, extra.parentLid, lookup)) continue;
          extraParents.push(extra);
        }
      }
      const relations =
        parentLid === null
          ? kept
          : [
              ...kept,
              {
                id: action.relationId,
                fromLid: parentLid,
                toLid: action.lid,
                kind: STRUCTURAL,
                // ⚠ 時刻は **worker が刻む**(`datetime('now')`)。ここは楽観表示の
                //    ための仮値で、次の再読込で本物に置き換わる
                createdAt: null,
                updatedAt: null,
              },
              ...extraParents.map((x) => ({
                id: x.relationId,
                fromLid: x.parentLid,
                toLid: action.lid,
                kind: STRUCTURAL,
                createdAt: null,
                updatedAt: null,
              })),
            ];
      // ⚠ 何も変わらないなら書かない(同じ親へ落としても永続化が走らない)
      if (
        relations.length === state.relations.length &&
        relations.every((r, i) => r === state.relations[i])
      ) {
        return { state, events: [] };
      }
      return {
        state: { ...state, relations },
        events: [
          {
            type: 'REQUEST_SET_PARENT',
            lid: action.lid,
            parentLid,
            relationId: action.relationId,
            ...(extraParents.length > 0 ? { alsoIn: extraParents } : {}),
            ...(removedBefore.length > 0 ? { previous: removedBefore } : {}),
          },
        ],
      };
    }
    case 'SET_ENTRY_ORDER': {
      if (state.phase !== 'ready') return { state, events: [] };
      const meta = state.entryMetas.get(action.lid);
      if (!meta) return { state, events: [] };
      let entryMetas: Map<string, EntryMeta>;
      let order: string[];
      if (action.entryOrder === 'end') {
        const lastLid = state.order[state.order.length - 1];
        if (lastLid === undefined || lastLid === action.lid) return { state, events: [] };
        const last = state.entryMetas.get(lastLid);
        const entryOrder = (last?.entryOrder ?? 0) + 1;
        entryMetas = new Map(state.entryMetas).set(action.lid, { ...meta, entryOrder });
        order = [...state.order.filter((l) => l !== action.lid), action.lid];
      } else {
        if (!Number.isFinite(action.entryOrder) || meta.entryOrder === action.entryOrder)
          return { state, events: [] };
        entryMetas = new Map(state.entryMetas).set(action.lid, { ...meta, entryOrder: action.entryOrder });
        // ⚠ 並びの規則は boot と同じ 1 本(entryOrder 昇順・同値は lid)
        order = [...entryMetas.values()]
          .sort((a, b) => a.entryOrder - b.entryOrder || a.lid.localeCompare(b.lid))
          .map((m) => m.lid);
      }
      const set = entryMetas.get(action.lid)!;
      return {
        state: { ...state, entryMetas, order },
        events: [
          {
            type: 'REQUEST_REORDER',
            entries: [{ lid: set.lid, title: set.title, archetype: set.archetype, entryOrder: set.entryOrder }],
          },
        ],
      };
    }
    case 'MOVE_ENTRY_ORDER': {
      /**
       * 🔴 **並べ替え**(2026-08-06。user 報告 2-10「並べ替えの手段が無い」)。
       *
       * ⚠ 規則は `reorderSibling` が 1 本で持つ(features 層)── reducer に
       *   2 つ目の並べ方を書かない。ここがやるのは
       *   「metas の値を書き換えて、`order` を**同じ規則で**引き直す」だけ。
       */
      if (state.phase !== 'ready') return { state, events: [] };
      const moves = reorderSibling(
        action.lid,
        action.direction,
        state.entryMetas,
        state.relations,
      );
      if (moves.length === 0) return { state, events: [] }; // 端 ── 黙って何もしない
      const entryMetas = new Map(state.entryMetas);
      const rows: Array<{ lid: string; title: string; archetype: string; entryOrder: number }> = [];
      for (const mv of moves) {
        const m = entryMetas.get(mv.lid);
        if (!m) continue;
        entryMetas.set(mv.lid, { ...m, entryOrder: mv.entryOrder });
        rows.push({
          lid: mv.lid,
          title: m.title,
          archetype: m.archetype,
          entryOrder: mv.entryOrder,
        });
      }
      if (rows.length === 0) return { state, events: [] };
      // ⚠ 並びの規則は boot と同じ 1 本(entryOrder 昇順・同値は lid)
      const order = [...entryMetas.values()]
        .sort((a, b) => a.entryOrder - b.entryOrder || a.lid.localeCompare(b.lid))
        .map((m) => m.lid);
      return {
        state: { ...state, entryMetas, order },
        events: [{ type: 'REQUEST_REORDER', entries: rows }],
      };
    }
    /**
     * 🔴 **関係を作る**(#185)。
     * ⚠ 自分自身へは張らない / 同じ組・同じ種類は 2 本作らない(押すたびに増えない)。
     * ⚠ 居場所は弾く ── 型でも弾いているが、**実行時にも**弾く
     *   (dispatch は型を通らない経路からも来る)。
     */
    case 'ADD_RELATION': {
      if (state.phase !== 'ready') return { state, events: [] };
      if (action.kind === STRUCTURAL) return { state, events: [] };
      const { fromLid, toLid, kind } = action;
      if (fromLid === toLid) return { state, events: [] };
      if (!state.entryMetas.has(fromLid) || !state.entryMetas.has(toLid))
        return { state, events: [] };
      if (hasSameRelation(state.relations, fromLid, toLid, kind)) return { state, events: [] };
      return {
        state: {
          ...state,
          /**
           * ⚠ 時刻は **null** で置く ── **disk が正**(worker が `datetime('now')` を
           * 入れる)。ここで `new Date()` を呼ぶと reducer が純関数でなくなり、
           * しかも**画面と disk で違う値**を持つことになる。
           */
          relations: [
            ...state.relations,
            { id: action.id, fromLid, toLid, kind, createdAt: null, updatedAt: null },
          ],
        },
        events: [{ type: 'REQUEST_RELATION_UPSERT', id: action.id, fromLid, toLid, kind }],
      };
    }
    /**
     * 🔴 **保存に失敗した関係を画面から巻き戻す**。⚠ 画面が先に動くので、disk が断ったら
     * 画面だけに残る(再読み込みで逆に見える)。足した物は外し、消した物は戻す。冪等。
     */
    case 'SET_ENTRY_ARCHETYPE_ROLLBACK': {
      const meta = state.entryMetas.get(action.lid);
      if (!meta || meta.archetype !== action.from) return { state, events: [] };
      return {
        state: { ...state, entryMetas: new Map(state.entryMetas).set(action.lid, { ...meta, archetype: action.to }) },
        events: [],
      };
    }
    case 'ROLLBACK_ENTRY_PARENT': {
      // ⚠ いまの居場所を外して、移す前の居場所を戻す。移した後にさらに動かしていても、書けなかった分は disk に無いので同じ扱い
      const kept = state.relations.filter(
        (r) => !(r.kind === STRUCTURAL && r.toLid === action.lid),
      );
      return { state: { ...state, relations: [...kept, ...action.previous] }, events: [] };
    }
    case 'ROLLBACK_RELATION': {
      if (action.change === 'added') {
        if (!state.relations.some((r) => r.id === action.id)) return { state, events: [] };
        return { state: { ...state, relations: state.relations.filter((r) => r.id !== action.id) }, events: [] };
      }
      if (state.relations.some((r) => r.id === action.relation.id)) return { state, events: [] };
      return { state: { ...state, relations: [...state.relations, action.relation] }, events: [] };
    }
    /** 関係を消す。⚠ 居ない id でも**黙って成功**(冪等 ── 2 回押しても壊れない)。 */
    case 'REMOVE_RELATION': {
      if (state.phase !== 'ready') return { state, events: [] };
      const target = state.relations.find((r) => r.id === action.id);
      if (!target) return { state, events: [] };
      // ⚠ 居場所はここから消させない ── 消すとファイラの階層が壊れ、戻す導線が無い
      if (target.kind === STRUCTURAL) return { state, events: [] };
      return {
        state: { ...state, relations: state.relations.filter((r) => r.id !== action.id) },
        events: [{ type: 'REQUEST_RELATION_DELETE', id: action.id, relation: target }],
      };
    }
    /**
     * 🔴 **選んだ全部にタグを付ける / 外す**(#402 ①)。
     *
     * > user の物語: フォルダで 12 件選んだ。全部に `#請求済` を付けたい。
     * > いま一括でできるのは「ゴミ箱へ」だけで、**12 回開いて 12 回書く**。
     *
     * ⚠ ready 限定(編集中の裏書換を作らない ── `TOGGLE_TASK` と同じ)。
     * ⚠ **居ない lid は落とす**(消えたノートへ書きに行かない)。
     * ⚠ 空の相手・空のタグでは**何も撃たない**(押して無反応にならないよう、
     *   帯の側がそもそも押せない形にしてある)。
     */
    case 'BULK_TAG': {
      if (state.phase !== 'ready') return { state, events: [] };
      // ⚠ 空の名前は落とす(打った字の割り方は `splitTags` が持つ ── ここは受けるだけ)
      const tags = action.tags.map((t) => t.trim()).filter((t) => t !== '');
      if (tags.length === 0) return { state, events: [] };
      const targets = action.lids
        .map((lid) => state.entryMetas.get(lid))
        .filter((m): m is EntryMeta => m !== undefined)
        .map((m) => ({
          lid: m.lid,
          title: m.title,
          archetype: m.archetype,
          entryOrder: m.entryOrder,
        }));
      if (targets.length === 0) return { state, events: [] };
      return {
        state,
        events: [
          {
            type: 'REQUEST_BULK_TAG',
            tags,
            mode: action.mode,
            targets,
            ...(action.field === undefined ? {} : { field: action.field }),
            ...(action.afterPrevious === true ? { afterPrevious: true } : {}),
            ...(action.renameFirst === true ? { renameFirst: true } : {}),
          },
        ],
      };
    }
    case 'RENAME_SMART_TAG': {
      if (state.phase !== 'ready') return { state, events: [] };
      const from = action.from.trim();
      const to = action.to === null ? null : action.to.trim();
      if (from === '' || to === '') return { state, events: [] };
      const targets = [...state.entryMetas.values()]
        .filter((m) => m.archetype === SMART_ARCHETYPE)
        .map((m) => ({ lid: m.lid, title: m.title, archetype: m.archetype, entryOrder: m.entryOrder }));
      if (targets.length === 0) return { state, events: [] };
      return { state, events: [{ type: 'REQUEST_SMART_TAG_RENAME', from, to, targets }] };
    }
  }
}
