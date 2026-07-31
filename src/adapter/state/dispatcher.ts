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
        if (changed) for (const l of [...this.stateListeners]) l(state);
        for (const ev of events) for (const l of [...this.eventListeners]) l(ev);
      }
    } finally {
      this.draining = false;
    }
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
