/**
 * リーン集約 AppState + pure reducer(P3 設計メモ §1)。
 *
 * - 常駐は meta / order / relations / UI state / openBody(選択中 1 件の body)のみ
 * - reducer は純粋。非同期(store I/O)は effect 層(store-effects.ts)が
 *   DomainEvent を購読して行い、SystemCommand で還流する
 * - PKC2 の規約を維持: SET_VIEW_MODE は selection を消さない /
 *   selectedLid が選択の単一情報源
 */
import type { EntryMeta, Relation } from '@core/model/entry-meta';
import { extractMeta } from '@features/flavor';
import type { EntryUpsert } from '@adapter/platform/storage/schema';

export type AppPhase = 'initializing' | 'ready' | 'editing' | 'error';
export type ViewMode = 'detail' | 'calendar' | 'kanban' | 'filer' | 'launcher';

/**
 * 選択中 entry の body 作業域。3 つの内容は意味が異なる(review E の解消形):
 * - body: 編集中の現在値
 * - baseline: **最後に commit した内容**。CANCEL_EDIT の復帰先であり、
 *   「変わっていないなら書かない」(#1024)の skip 基準(= 最後に enqueue した
 *   書込内容と常に一致するので、A→B→A の再 commit も正しく書かれる)
 * - persisted: **BODY_PERSISTED で確認された disk 上の内容**。enqueue と ack を
 *   混同しない ── persist 失敗時は baseline ≠ persisted が「disk に未達」の
 *   事実として残り、エラー復帰 / retry(将来)の判定に使える
 *
 * baseline ≠ persisted には向きの異なる 2 原因がある(文字列比較では区別不能):
 * (a) 自 commit の ack 待ち(persisted が遅れている)── baseline が正
 * (b) editor 外の書込(かんばんトグル等)が ack 済み(persisted が進んでいる)
 *     ── disk が正。こちらだけ diskAhead で印を付け、無変更 commit / cancel で
 *     disk を採用する(stale baseline の巻き戻し防止 ── P3-6a review #4)
 */
export interface OpenBody {
  lid: string;
  body: string;
  baseline: string;
  persisted: string;
  diskAhead: boolean;
}

export interface AppState {
  phase: AppPhase;
  cid: string | null;
  entryMetas: ReadonlyMap<string, EntryMeta>;
  order: readonly string[];
  relations: readonly Relation[];
  openBody: OpenBody | null;
  selectedLid: string | null;
  viewMode: ViewMode;
  /** calendar の表示月(null = 今日の月を renderer 側で解決)。 */
  calendarMonth: { year: number; month: number } | null;
  /** calendar で archived todo を見せるか(PKC2 の showArchived と同じ意味論)。 */
  showArchived: boolean;
  error: string | null;
}

export const initialState: AppState = {
  phase: 'initializing',
  cid: null,
  entryMetas: new Map(),
  order: [],
  relations: [],
  openBody: null,
  selectedLid: null,
  viewMode: 'detail',
  calendarMonth: null,
  showArchived: false,
  error: null,
};

export type UserAction =
  | { type: 'SELECT_ENTRY'; lid: string }
  | { type: 'SET_VIEW_MODE'; mode: ViewMode }
  | { type: 'START_EDIT' }
  | { type: 'UPDATE_OPEN_BODY'; body: string }
  | { type: 'COMMIT_EDIT' }
  | { type: 'CANCEL_EDIT' }
  | { type: 'TOGGLE_TODO_STATUS'; lid: string }
  | { type: 'SET_CALENDAR_MONTH'; year: number; month: number }
  | { type: 'TOGGLE_SHOW_ARCHIVED' }
  | { type: 'RETRY_PERSIST' };

export type SystemCommand =
  | { type: 'SYS_BOOTED'; cid: string; metas: EntryMeta[]; relations: Relation[] }
  | { type: 'BODY_LOADED'; lid: string; body: string }
  | { type: 'BODY_LOAD_FAILED'; lid: string; error: string }
  | { type: 'BODY_PERSISTED'; lid: string; body: string }
  | {
      type: 'TODO_TOGGLED';
      lid: string;
      body: string;
      status: string | null;
      date: string | null;
      archived: boolean;
    }
  | { type: 'SYS_ERROR'; error: string };

export type Dispatchable = UserAction | SystemCommand;

/**
 * effect 層が購読する副作用要求。entry の書込は PERSIST_ENTRY(= openBody 由来)だけ。
 * PERSIST_ENTRY は**行全体(抽出列込み)を reduce 時点で確定**して運ぶ ──
 * effect 層が実行時に getState() で meta を解決する時間差窓(review C-1)を
 * 構造的に無くし、抽出(FlavorSpec.extract)を唯一の経路にする(review K)。
 */
export type DomainEvent =
  | { type: 'REQUEST_BODY'; lid: string }
  | { type: 'PERSIST_ENTRY'; entry: EntryUpsert }
  | {
      /** かんばんトグル要求。meta snapshot は発火時(reduce)に捕獲(C-1 規律)。 */
      type: 'REQUEST_TODO_TOGGLE';
      lid: string;
      title: string;
      entryOrder: number;
      nextStatus: 'open' | 'done';
    };

export interface ReduceResult {
  state: AppState;
  events: DomainEvent[];
}

export function reduce(state: AppState, action: Dispatchable): ReduceResult {
  switch (action.type) {
    case 'SYS_BOOTED': {
      const metas = new Map(action.metas.map((m) => [m.lid, m]));
      const order = [...action.metas]
        .sort((a, b) => a.entryOrder - b.entryOrder)
        .map((m) => m.lid);
      // 再 boot(コンテナ切替・error 復帰)で旧選択・旧 openBody を持ち越さない
      // (lid 偶然衝突による cross-container 上書きの防止 ── review F)
      return {
        state: {
          ...state,
          phase: 'ready',
          error: null,
          cid: action.cid,
          entryMetas: metas,
          order,
          relations: action.relations,
          selectedLid: null,
          openBody: null,
        },
        events: [],
      };
    }
    case 'SELECT_ENTRY': {
      if (state.phase === 'editing') return { state, events: [] }; // 編集中は選択遷移しない
      if (!state.entryMetas.has(action.lid)) return { state, events: [] };
      // 同一 lid でも openBody が確立していなければ再要求する
      // (読み失敗後の再クリックが自然な retry になる ── review C)
      if (state.selectedLid === action.lid && state.openBody?.lid === action.lid)
        return { state, events: [] };
      // 選択が変わったら旧 openBody は破棄(速やかな破棄の原則)し、新 body を要求。
      // 通知エラー(読み失敗等)は新しい試行でクリア(エラーは state 駆動 ──
      // 表示寿命が「次の操作まで」で終わらない、P3-5 review #3 の解消)
      return {
        state: { ...state, selectedLid: action.lid, openBody: null, error: null },
        events: [{ type: 'REQUEST_BODY', lid: action.lid }],
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
          error: null, // 読めた = 直前の読み失敗通知は用済み
          openBody: {
            lid: action.lid,
            body: action.body,
            baseline: action.body,
            persisted: action.body,
            diskAhead: false,
          },
        },
        events: [],
      };
    }
    case 'BODY_LOAD_FAILED': {
      if (state.selectedLid !== action.lid) return { state, events: [] };
      // phase は落とさない(読み失敗はアプリ死ではない ── 再クリックが retry)。
      // エラーは state に持つ: 次の成功 / 選択までステータスに残る
      return {
        state: { ...state, error: `body load failed: ${action.error}` },
        events: [],
      };
    }
    case 'SET_VIEW_MODE':
      // selection は消さない(PKC2 規約)
      if (state.phase === 'editing') return { state, events: [] };
      return { state: { ...state, viewMode: action.mode }, events: [] };
    case 'START_EDIT': {
      // openBody が現選択の body を持っているときだけ編集に入れる
      // (= 未読 body の編集・保存が構造的に不可能)
      if (state.phase !== 'ready') return { state, events: [] };
      if (!state.openBody || state.openBody.lid !== state.selectedLid)
        return { state, events: [] };
      return { state: { ...state, phase: 'editing' }, events: [] };
    }
    case 'UPDATE_OPEN_BODY': {
      if (state.phase !== 'editing' || !state.openBody) return { state, events: [] };
      return {
        state: { ...state, openBody: { ...state.openBody, body: action.body } },
        events: [],
      };
    }
    case 'COMMIT_EDIT': {
      if (state.phase !== 'editing' || !state.openBody) return { state, events: [] };
      const { lid, body, baseline, persisted } = state.openBody;
      // baseline := body(最終 commit 内容)。disk 確認は persisted が別に持つので
      // これは楽観確定ではない(review E は persisted の導入で解消)
      const { diskAhead } = state.openBody;
      const next: AppState = {
        ...state,
        phase: 'ready',
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
          state: { ...state, phase: 'ready', error: `commit: unknown entry ${lid}` },
          events: [],
        };
      }
      // 抽出はイベント発火時(= この reduce)に同期で行い、行全体を確定して運ぶ
      const { entryMetas, entry } = buildPersist(state, meta, body);
      return {
        state: { ...next, entryMetas },
        events: [{ type: 'PERSIST_ENTRY', entry }],
      };
    }
    case 'RETRY_PERSIST': {
      // persist 失敗(error phase)からの復帰: baseline(最後に commit した内容)が
      // disk(persisted)に未達なら、現 meta で行を組み直して再送する。
      // baseline ≠ persisted が「未達の証拠」── P3-5 で導入した分離の回収点
      if (state.phase !== 'error' || !state.openBody) return { state, events: [] };
      const { lid, baseline, persisted, diskAhead } = state.openBody;
      if (baseline === persisted || diskAhead) return { state, events: [] };
      const meta = state.entryMetas.get(lid);
      if (!meta) return { state, events: [] };
      const { entryMetas, entry } = buildPersist(state, meta, baseline);
      return {
        state: {
          ...state,
          phase: 'ready',
          error: null,
          entryMetas,
          openBody: { lid, body: baseline, baseline, persisted, diskAhead: false },
        },
        events: [{ type: 'PERSIST_ENTRY', entry }],
      };
    }
    case 'CANCEL_EDIT': {
      if (state.phase !== 'editing' || !state.openBody) return { state, events: [] };
      const { lid, baseline, persisted, diskAhead } = state.openBody;
      // draft 破棄。disk 先行(diskAhead)なら disk を採用(review #4)。
      // 自 commit の ack 待ちで persisted が遅れているだけなら baseline が正
      const restored = diskAhead ? persisted : baseline;
      return {
        state: {
          ...state,
          phase: 'ready',
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
    case 'TOGGLE_TODO_STATUS': {
      // ready 限定(editing 中の裏書換を作らない)。todo 以外・未知 lid は no-op
      if (state.phase !== 'ready') return { state, events: [] };
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
            type: 'REQUEST_TODO_TOGGLE',
            lid: meta.lid,
            title: meta.title,
            entryOrder: meta.entryOrder,
            nextStatus,
          },
        ],
      };
    }
    case 'TODO_TOGGLED': {
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
      return { state: { ...state, entryMetas, openBody }, events: [] };
    }
    case 'SET_CALENDAR_MONTH': {
      // 月送りの正規化(binder は 0 や 13 を送ってよい)
      let { year, month } = action;
      if (month < 1) {
        year -= 1;
        month = 12;
      } else if (month > 12) {
        year += 1;
        month = 1;
      }
      return { state: { ...state, calendarMonth: { year, month } }, events: [] };
    }
    case 'TOGGLE_SHOW_ARCHIVED':
      return { state: { ...state, showArchived: !state.showArchived }, events: [] };
    case 'BODY_PERSISTED': {
      // ack された内容を disk 事実として記録(選択が移って openBody が破棄
      // 済みなら捨てる ── stale ack で別 entry の作業域を汚さない)
      if (!state.openBody || state.openBody.lid !== action.lid)
        return { state, events: [] };
      const ob = state.openBody;
      if (ob.persisted === action.body) return { state, events: [] };
      return {
        state: { ...state, openBody: { ...ob, persisted: action.body } },
        events: [],
      };
    }
    case 'SYS_ERROR':
      // エラーは state 駆動(表示は state.error を読む)── event 通知は廃止
      return {
        state: { ...state, phase: 'error', error: action.error },
        events: [],
      };
  }
}

/**
 * meta + body から行全体を確定し、常駐 metas を追従させる(COMMIT_EDIT /
 * RETRY_PERSIST 共用)。抽出は唯一経路 extractMeta。抽出値が変わらないときは
 * entryMetas の参照を維持する(sidebar / kanban の断面指紋を無駄に壊さない)。
 */
function buildPersist(
  state: AppState,
  meta: EntryMeta,
  body: string,
): { entryMetas: ReadonlyMap<string, EntryMeta>; entry: EntryUpsert } {
  const ext = extractMeta(meta.archetype, body);
  const changed =
    meta.status !== ext.status ||
    meta.date !== ext.date ||
    meta.archived !== ext.archived;
  const entryMetas = changed
    ? new Map(state.entryMetas).set(meta.lid, { ...meta, ...ext })
    : state.entryMetas;
  return {
    entryMetas,
    entry: {
      lid: meta.lid,
      title: meta.title,
      archetype: meta.archetype,
      body,
      entryOrder: meta.entryOrder,
      status: ext.status,
      date: ext.date,
      archived: ext.archived,
    },
  };
}
