/**
 * Dispatcher(PKC2 流儀の維持): dispatch → reduce → state listener 通知 → event 発火。
 * onState / onEvent は unsubscribe を返す(短命購読は teardown で必ず呼ぶ規約)。
 *
 * **再入の線形化(review G)**: listener 内からの dispatch は queue に積まれ、
 * 進行中の drain loop が順に処理する。これにより listener は常に
 * 「単調に新しくなる state」を観測し、「最後に受け取った state が最新でない」
 * 逆転が起きない。
 */
import {
  initialState,
  reduce,
  type AppState,
  type Dispatchable,
  type DomainEvent,
} from './app-state';

export type StateListener = (state: AppState) => void;
export type EventListener = (event: DomainEvent) => void;

export class Dispatcher {
  private state: AppState;
  private readonly stateListeners = new Set<StateListener>();
  private readonly eventListeners = new Set<EventListener>();
  private readonly pending: Dispatchable[] = [];
  private draining = false;
  /** batch の入れ子の深さ。0 より大きい間は state listener への通知を溜める。 */
  private batchDepth = 0;
  private batchDirty = false;

  constructor(state: AppState = initialState) {
    this.state = state;
  }

  getState(): AppState {
    return this.state;
  }

  dispatch(action: Dispatchable): void {
    this.pending.push(action);
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.pending.length > 0) {
        const next = this.pending.shift();
        if (!next) break;
        const { state, events } = reduce(this.state, next);
        const changed = state !== this.state;
        this.state = state;
        if (changed) {
          if (this.batchDepth > 0) this.batchDirty = true;
          else this.notifyState(state);
        }
        for (const ev of events) for (const l of [...this.eventListeners]) l(ev);
      }
    } finally {
      this.draining = false;
    }
  }

  /**
   * 複数件の dispatch をまとめる。reducer は 1 件ずつ即座に走る(`getState()` は常に最新)が、
   * **state listener への通知は最後に 1 回だけ**(最終 state)。event listener は従来どおり 1 件ずつ即発火。
   * 入れ子可(最も外側の終了時に 1 回)。fn が throw しても finally で通知してから再 throw する。
   */
  batch<T>(fn: () => T): T {
    this.batchDepth += 1;
    try {
      return fn();
    } finally {
      this.batchDepth -= 1;
      if (this.batchDepth === 0 && this.batchDirty) {
        this.batchDirty = false;
        this.notifyState(this.state);
      }
    }
  }

  private notifyState(state: AppState): void {
    for (const l of [...this.stateListeners]) l(state);
  }

  onState(listener: StateListener): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  onEvent(listener: EventListener): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }
}
