/**
 * 🔴 **選択同期(#2066 段 5-B)の写しの係** ── 正本(worker の `__sync__:<cid>` の行)を読み、画面の写し(`state.syncScope`)を入れる。
 *
 * 🔴 **定常の手間はゼロ**:
 * - 同期が切の間は worker に何も聞かず、写しを `null` にするだけ。
 * - 範囲が「ワークスペース全体」の間は worker が設定だけを返し(ノートを読まない)、閉包も計算しない。
 * - エントリの作成・削除・移動・つながり・本文の保存のたびの読み直しは、**選んだエントリだけ同期しているときだけ**、束ねて 1 回にする。
 *
 * - 読みは世代で守る(古い読みの結果が、後から届いて新しい写しを巻き戻さない)。
 * - 付け外し(`syncSetSelectiveScope`)は worker の 1 つの tx。済んだら読み直す。失敗は黙らずに知らせて、正本を読み直す。
 * ⚠ 判断(閉包・言葉)は `features/sync/selective-view.ts`。ここは配線だけ。
 */
import { errorText } from '@features/error-text';
import { buildSyncScopeView, selectiveActive, SELECTIVE_CLEAR_LABEL, type SyncScopeView } from '@features/sync/selective-view';
import type { SyncRelatedMode, SyncScopeMode } from '@features/sync/sync-state';
import type { ResultMap, StorageRequest } from '@adapter/platform/storage/protocol';

type ScopeOp = 'syncSelectiveView' | 'syncSetSelectiveScope';

export interface SyncScopeDeps {
  cid: string;
  /** 設定「端末間の同期」。 */
  enabled(): boolean;
  request<O extends ScopeOp>(req: Extract<StorageRequest, { op: O }>): Promise<ResultMap[O]>;
  /** worker が入 / 切を知っていることを保つ(失敗は throw)。 */
  ensureConfigured?(): Promise<void>;
  /** 飛んでいる書込が着地してから読む。 */
  settle?(): Promise<void>;
  /** 写しを画面へ(`SET_SYNC_SCOPE`)。 */
  publish(view: SyncScopeView | null): void;
  /** いまの写し。 */
  current(): SyncScopeView | null;
  /** 確認(`false` = やめる)。 */
  confirm?(message: string, opts: { okLabel: string; cancelLabel: string; danger?: boolean }): Promise<boolean>;
  /** 失敗を知らせる(メッセージへ)。 */
  reportProblem?(text: string): void;
  /** 束ねの待ち(test では差し替える)。戻り = 取り消し。 */
  later?(fn: () => void, ms: number): () => void;
}

/** エントリが動いたときの読み直しの束ね(ms)。 */
export const SCOPE_REFRESH_DELAY_MS = 300;

export const SELECTIVE_CLEAR_CONFIRM = '同期対象の直接指定をすべて外しますか?\nノート自体は消えません。他の端末のノートも削除されません。';

export class SyncScopeKeeper {
  private gen = 0;
  private cancelPending: (() => void) | null = null;

  constructor(private readonly deps: SyncScopeDeps) {}

  /** 正本を読み直して写しを入れる。⚠ 同期が切なら worker に聞かずに `null`。 */
  async refresh(): Promise<void> {
    this.cancelPending?.();
    this.cancelPending = null;
    const gen = ++this.gen;
    if (!this.deps.enabled()) {
      this.deps.publish(null);
      return;
    }
    try {
      await this.deps.ensureConfigured?.();
      await this.deps.settle?.();
      const raw = await this.deps.request({ op: 'syncSelectiveView', cid: this.deps.cid });
      if (gen !== this.gen) return;
      // 読んでいる間に切にされた ── 写しを出さない
      if (!this.deps.enabled()) {
        this.deps.publish(null);
        return;
      }
      this.deps.publish(buildSyncScopeView(raw));
    } catch (e) {
      if (gen !== this.gen) return;
      this.deps.reportProblem?.(`同期対象の状態を読めませんでした: ${errorText(e)}`);
    }
  }

  /**
   * エントリが動いた(作成・削除・移動・つながり・本文の保存)。⚠ **選んだエントリだけ同期しているときだけ**、束ねて読み直す。
   * 同期が切・ワークスペース全体のときは何もしない(定常の手間ゼロ)。
   */
  onEntriesChanged(): void {
    if (!this.deps.enabled()) return;
    const cur = this.deps.current();
    // ⚠ 写しが無い(前の読みが失敗した)ときは読み直す ── 回復の契機を残す。ワークスペース全体なら何もしない
    if (cur !== null && !selectiveActive(cur)) return;
    if (this.cancelPending !== null) return;
    const later = this.deps.later ?? ((fn: () => void, ms: number) => {
      const t = setTimeout(fn, ms);
      return () => clearTimeout(t);
    });
    this.cancelPending = later(() => {
      this.cancelPending = null;
      void this.refresh();
    }, SCOPE_REFRESH_DELAY_MS);
  }

  /**
   * 画面に戻った(別のタブで範囲・直接指定を変えたかもしれない)。⚠ 同期が入なら範囲によらず 1 回読み直す
   * (ワークスペース全体のときの worker は設定の行だけを読む)。切なら何もしない。
   */
  onVisible(): void {
    if (!this.deps.enabled()) return;
    void this.refresh();
  }

  private async write(change: { mode?: SyncScopeMode; related?: SyncRelatedMode; add?: string[]; remove?: string[] }): Promise<boolean> {
    if (!this.deps.enabled()) return false;
    try {
      await this.deps.ensureConfigured?.();
      await this.deps.request({ op: 'syncSetSelectiveScope', cid: this.deps.cid, ...change });
      return true;
    } catch (e) {
      this.deps.reportProblem?.(`同期対象の設定を保存できませんでした: ${errorText(e)}`);
      return false;
    } finally {
      // 🔴 成否どちらでも正本を読み直す(画面だけ変わって保存されていない、を残さない)
      await this.refresh();
    }
  }

  setMode(mode: SyncScopeMode): Promise<boolean> {
    return this.write({ mode });
  }

  setRelated(related: SyncRelatedMode): Promise<boolean> {
    return this.write({ related });
  }

  /** 直接指定に足す / 外す(双方向)。 */
  setDirect(lid: string, on: boolean): Promise<boolean> {
    return this.write(on ? { add: [lid] } : { remove: [lid] });
  }

  /** 直接指定を全部外す(確認つき)。ノートは消えない。 */
  async clearAll(): Promise<boolean> {
    const cur = this.deps.current();
    if (cur === null || cur.directLids.size === 0) return false;
    const ok = this.deps.confirm === undefined ? true : await this.deps.confirm(SELECTIVE_CLEAR_CONFIRM, { okLabel: SELECTIVE_CLEAR_LABEL, cancelLabel: 'やめる' });
    if (!ok) return false;
    return this.write({ remove: [...cur.directLids] });
  }
}

/**
 * 🔴 **係の配線**(#2066 段 5-B。`main.ts` から呼ぶ ── `main.ts` は test から実行されないので、判断はここに置く)。
 * - エントリ・つながりが変わったら(参照で見る)`onEntriesChanged`(選択同期のときだけ束ねて読み直す)
 * - 画面に戻ったら `onVisible`
 * 戻り = 外す口。
 */
export function wireSyncScope(
  keeper: Pick<SyncScopeKeeper, 'onEntriesChanged' | 'onVisible'>,
  src: {
    getState(): { readonly entryMetas: unknown; readonly relations: unknown };
    onState(cb: (st: { readonly entryMetas: unknown; readonly relations: unknown }) => void): () => void;
    onVisible(cb: () => void): () => void;
  },
): () => void {
  let seenMetas = src.getState().entryMetas;
  let seenRelations = src.getState().relations;
  const offState = src.onState((st) => {
    if (st.entryMetas === seenMetas && st.relations === seenRelations) return;
    seenMetas = st.entryMetas;
    seenRelations = st.relations;
    keeper.onEntriesChanged();
  });
  const offVisible = src.onVisible(() => keeper.onVisible());
  return () => {
    offState();
    offVisible();
  };
}
