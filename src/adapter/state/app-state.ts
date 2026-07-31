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
 */
export interface OpenBody {
  lid: string;
  body: string;
  baseline: string;
  persisted: string;
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
  error: null,
};

export type UserAction =
  | { type: 'SELECT_ENTRY'; lid: string }
  | { type: 'SET_VIEW_MODE'; mode: ViewMode }
  | { type: 'START_EDIT' }
  | { type: 'UPDATE_OPEN_BODY'; body: string }
  | { type: 'COMMIT_EDIT' }
  | { type: 'CANCEL_EDIT' };

export type SystemCommand =
  | { type: 'SYS_BOOTED'; cid: string; metas: EntryMeta[]; relations: Relation[] }
  | { type: 'BODY_LOADED'; lid: string; body: string }
  | { type: 'BODY_LOAD_FAILED'; lid: string; error: string }
  | { type: 'BODY_PERSISTED'; lid: string; body: string }
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
  | { type: 'APP_ERROR'; error: string };

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
      // 選択が変わったら旧 openBody は破棄(速やかな破棄の原則)し、新 body を要求
      return {
        state: { ...state, selectedLid: action.lid, openBody: null },
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
          openBody: {
            lid: action.lid,
            body: action.body,
            baseline: action.body,
            persisted: action.body,
          },
        },
        events: [],
      };
    }
    case 'BODY_LOAD_FAILED': {
      if (state.selectedLid !== action.lid) return { state, events: [] };
      return {
        state,
        events: [{ type: 'APP_ERROR', error: `body load failed: ${action.error}` }],
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
      const next: AppState = {
        ...state,
        phase: 'ready',
        openBody: { lid, body, baseline: body, persisted },
      };
      // 変わっていないなら書かない(PKC2 #1024 の教訓を最初から)
      if (body === baseline) return { state: next, events: [] };
      const meta = state.entryMetas.get(lid);
      if (!meta) {
        // openBody は SELECT_ENTRY(存在検査済)経由でしか確立しない ── ここに
        // 来たら不変量違反。書かずに可視エラーで終える(黙って捨てない)
        return {
          state: { ...state, phase: 'ready' },
          events: [{ type: 'APP_ERROR', error: `commit: unknown entry ${lid}` }],
        };
      }
      // 抽出はイベント発火時(= この reduce)に同期で行い、行全体を確定して運ぶ
      const ext = extractMeta(meta.archetype, body);
      const changed =
        meta.status !== ext.status ||
        meta.date !== ext.date ||
        meta.archived !== ext.archived;
      // 抽出値が変わったときだけ Map を作り直す ── sidebar は参照 fingerprint で
      // 差分検出するため、無変化 commit で参照を壊さない
      const entryMetas = changed
        ? new Map(state.entryMetas).set(lid, { ...meta, ...ext })
        : state.entryMetas;
      const entry: EntryUpsert = {
        lid,
        title: meta.title,
        archetype: meta.archetype,
        body,
        entryOrder: meta.entryOrder,
        status: ext.status,
        date: ext.date,
        archived: ext.archived,
      };
      return {
        state: { ...next, entryMetas },
        events: [{ type: 'PERSIST_ENTRY', entry }],
      };
    }
    case 'CANCEL_EDIT': {
      if (state.phase !== 'editing' || !state.openBody) return { state, events: [] };
      return {
        state: {
          ...state,
          phase: 'ready',
          openBody: { ...state.openBody, body: state.openBody.baseline },
        },
        events: [],
      };
    }
    case 'BODY_PERSISTED': {
      // ack された内容を disk 事実として記録(選択が移って openBody が破棄
      // 済みなら捨てる ── stale ack で別 entry の作業域を汚さない)
      if (!state.openBody || state.openBody.lid !== action.lid)
        return { state, events: [] };
      if (state.openBody.persisted === action.body) return { state, events: [] };
      return {
        state: {
          ...state,
          openBody: { ...state.openBody, persisted: action.body },
        },
        events: [],
      };
    }
    case 'SYS_ERROR':
      return {
        state: { ...state, phase: 'error', error: action.error },
        events: [{ type: 'APP_ERROR', error: action.error }],
      };
  }
}
