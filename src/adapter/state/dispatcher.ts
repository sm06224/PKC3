/**
 * Dispatcher(PKC2 流儀の維持): dispatch → reduce → state listener 通知 → event 発火。
 * onState / onEvent は unsubscribe を返す(短命購読は teardown で必ず呼ぶ規約)。
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

  constructor(state: AppState = initialState) {
    this.state = state;
  }

  getState(): AppState {
    return this.state;
  }

  dispatch(action: Dispatchable): void {
    const { state, events } = reduce(this.state, action);
    const changed = state !== this.state;
    this.state = state;
    if (changed) for (const l of [...this.stateListeners]) l(state);
    for (const ev of events) for (const l of [...this.eventListeners]) l(ev);
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
