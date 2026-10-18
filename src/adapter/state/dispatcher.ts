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
      this.drain();
    } finally {
      this.draining = false;
    }
  }

  private drain(): void {
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
  }

  /**
   * batch の終わりの通知。dispatch と同じ drain ループ(`draining = true`)の中で配る ──
   * 通知中に listener が dispatch しても queue に積まれ、全 listener が配り終えてから順に処理される
   * (入れ子の drain が新しい state を先に配り、外側が古い state を後から配る逆転を作らない)。
   */
  private flush(): void {
    if (!this.batchDirty || this.draining) return;
    this.batchDirty = false;
    this.draining = true;
    try {
      this.notifyState(this.state);
      this.drain();
    } finally {
      this.draining = false;
    }
  }

  /**
   * 複数件の dispatch をまとめる。reducer は 1 件ずつ即座に走る(`getState()` は常に最新)が、
   * **state listener への通知は最後に 1 回だけ**(最終 state)。event listener は従来どおり 1 件ずつ即発火。
   * 入れ子可(最も外側の終了時に 1 回)。fn が throw しても finally で通知してから再 throw する
   * (通知側も throw したときは元の例外を優先し、通知の例外は console へ出す)。
   * ⚠ **listener の中(drain の最中)から呼んだ batch は効かない** ── dispatch は queue に積まれるだけで、
   *   reducer が走るのは外側の drain に戻ってからなので、通常どおり 1 件ずつ通知される(壊れはしない)。
   */
  batch<T>(fn: () => T): T {
    this.batchDepth += 1;
    let threw = false;
    try {
      return fn();
    } catch (e) {
      threw = true;
      throw e;
    } finally {
      this.batchDepth -= 1;
      if (this.batchDepth === 0) {
        if (threw) {
          try {
            this.flush();
          } catch (e2) {
            console.error('Dispatcher.batch: state listener threw after batch failure', e2);
          }
        } else this.flush();
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
