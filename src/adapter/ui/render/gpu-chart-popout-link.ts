/**
 * 🔴 **GPU グラフの「別ウィンドウで開く」── 親(メインウィンドウ)側の配線**(v4.1 PR-9、#2095 後半)。
 *
 * - 操作バー(`gpu-chart-bar`)へ「別ウィンドウで開く」を 1 つ足す(` ```chart live ` / `heatmap` / 添付の CSV / `"bind"` の全部)。
 * - 押すと `ChartPopoutHost.open` で `noopener` の別ウィンドウを開き、名乗りが来たらその時点の一式(`init`)を渡す。
 * - `"bind"` のグラフ: 本文の**今の閲覧位置**(親の追従 ON / 固定中に関係なく)を別ウィンドウへ配る。
 *   別ウィンドウの「前へ / 次へ」(`jump`)が来たら本文をその場所へ動かし、その時点のデータを返事として送る(双方向)。
 * - 🔑 **保存・描き直しで器が作り直されても切れない**: 器が畳まれたら、同じノートの同じ順番のグラフが
 *   `REATTACH_GRACE_MS` のうちに置き直されるのを待ち、来たらそのまま引き継いで新しいデータを送る。
 *   来なければ(別のノートへ移った・編集を始めた)`source-closed` を送ってセッションを閉じる。
 * - 開けなかったときは理由をグラフの情報の行に出し、`GPU_CHART_POPOUT_FAILED_EVENT` を上へ伝える(binder が画面下に言う)。
 */
import {
  CHART_POPOUT_BLOCKED,
  chartPopoutHost,
  readThemeAttrs,
  SOURCE_CLOSED_NOTE,
} from '@adapter/platform/chart-popout';
import type { ChartInitPayload, ChartUpdatePayload } from '@features/chart/gpu-chart-sync';
import { BOUND_EMPTY_REASON } from '@features/chart/gpu-chart-bind';
import type { ChartBindingHandle, ChartReadingPoint } from './gpu-chart-bound';
import type { GpuChartView } from './gpu-chart';

/** 開けなかったことを上へ伝える合図(binder が `OP_FAILED` で画面下に言う ── `heading-anchor.ts` と同じ作り)。 */
export const GPU_CHART_POPOUT_FAILED_EVENT = 'pkc-gpu-chart-popout-failed';
/** 器が畳まれてから、置き直されるのを待つ時間(保存・差分の描き直し)。 */
export const REATTACH_GRACE_MS = 2500;
/** 別ウィンドウにする前に名乗りを待っている間の字。 */
const OPENING_TEXT = '別ウィンドウを開いています…';

export interface ChartPopoutSource {
  readonly view: GpuChartView;
  /** 連動グラフなら連動の口。 */
  readonly binding: ChartBindingHandle | null;
  /** ノートの題名(別ウィンドウの題名に使う)。 */
  readonly noteTitle: () => string;
  /**
   * 引き継ぎの鍵(`<lid>#<本文の中のグラフの順番>`)。読む面だけが持つ ── 無ければ畳まれたら即切り離す。
   */
  readonly reattachKey: string | null;
}

export interface ChartPopoutLink {
  /** 開いているセッションの token(test の観測点)。 */
  readonly tokens: ReadonlySet<string>;
  /** ボタンを押したのと同じ。 */
  open(): boolean;
  dispose(): void;
}

interface Route {
  link: LinkImpl;
}

/** token → いま繋がっている器(引き継ぐと差し替わる)。 */
const routes = new Map<string, Route>();
/** 畳まれて置き直しを待っているセッション(鍵 → token と時計)。 */
const detached = new Map<string, { tokens: Set<string>; timer: ReturnType<typeof setTimeout> }>();
/** 画面に見えるまで置くのを待っている器(鍵 → 今すぐ置く口)。⚠ 引き継ぎ待ちが在るときに急いで置く。 */
const waitingMounts = new Map<string, () => void>();

/** 引き継ぎ待ちのセッションが在るか(在れば器を見えるまで待たずに置く)。 */
export function hasDetachedPopout(key: string | null): boolean {
  return key !== null && detached.has(key);
}

/** 見えるまで待っている器を登録する(引き継ぎ待ちが来たらすぐ置く)。返り値で外す。 */
export function registerWaitingMount(key: string | null, mountNow: () => void): () => void {
  if (key === null) return () => undefined;
  waitingMounts.set(key, mountNow);
  return () => {
    if (waitingMounts.get(key) === mountNow) waitingMounts.delete(key);
  };
}

/** 連動の時点 → 別ウィンドウへの便りの中身。 */
function updateOf(p: ChartReadingPoint, animate: boolean, extra: Partial<ChartUpdatePayload> = {}): ChartUpdatePayload {
  const frame = p.frame;
  const spec = frame?.spec ?? null;
  return {
    ...(p.signal === null ? {} : { signal: p.signal }),
    spec,
    ...(spec === null ? { emptyReason: frame?.reason ?? BOUND_EMPTY_REASON[p.mode] } : {}),
    label: frame?.label ?? '',
    index: p.index,
    total: p.total,
    animate,
    ...extra,
  };
}

class LinkImpl implements ChartPopoutLink {
  readonly tokens = new Set<string>();
  private readonly button: HTMLButtonElement;
  private readonly offReading: (() => void) | null;
  private disposed = false;
  /** token ごとに最後に送った時点(同じ場所を 2 度送らない)。 */
  private readonly sentKey = new Map<string, string>();
  /** 時点の名前の一覧を次の便りに載せる token(引き継いだ直後 ── 本文が変わっているかもしれない)。 */
  private readonly metaDirty = new Set<string>();

  constructor(private readonly src: ChartPopoutSource) {
    const view = src.view;
    const doc = view.element.ownerDocument;
    const b = doc.createElement('button');
    b.type = 'button';
    b.className = 'pkc-gpu-chart-btn';
    b.setAttribute('data-pkc-variant', 'ghost');
    b.setAttribute('data-pkc-gpu-chart-op', 'popout');
    b.setAttribute('data-pkc-field', 'gpu-chart-popout');
    b.textContent = '別ウィンドウで開く';
    b.title = src.binding === null
      ? 'このグラフを別ウィンドウで大きく表示します'
      : 'このグラフを別ウィンドウで表示します。本文を読み進めると別ウィンドウのグラフも切り替わります';
    b.addEventListener('click', this.onClick);
    const bar = view.element.querySelector('[data-pkc-field="gpu-chart-bar"]');
    (bar ?? view.element).append(b);
    this.button = b;
    this.offReading =
      src.binding === null
        ? null
        : src.binding.onReading((p, changed) => {
            for (const t of this.tokens) this.send(t, p, changed);
          });
  }

  private readonly onClick = (): void => {
    this.open();
  };

  private send(token: string, p: ChartReadingPoint, changed: boolean, extra: Partial<ChartUpdatePayload> = {}): void {
    const key = `${p.index}\u0000${p.frame?.key ?? ''}`;
    if (!changed && extra.requested !== true && this.sentKey.get(token) === key) return;
    const withMeta = (changed || this.metaDirty.has(token)) && this.src.binding !== null;
    const meta = withMeta ? { framesMeta: this.src.binding!.framesMeta() } : {};
    if (chartPopoutHost().pushUpdate(token, updateOf(p, true, { ...meta, ...extra }))) {
      this.sentKey.set(token, key);
      if (withMeta) this.metaDirty.delete(token);
    }
  }

  /** 名乗ったときに渡す一式(その時点の閲覧位置で)。 */
  initFor(token: string): ChartInitPayload {
    const { view, binding } = this.src;
    const chartTitle = view.currentSpec().title ?? '';
    const base = { noteTitle: this.src.noteTitle(), chartTitle, theme: readThemeAttrs(view.element.ownerDocument.documentElement) };
    if (binding === null) {
      return { ...base, spec: view.currentSpec(), currentIndex: -1, currentLabel: '' };
    }
    const p = binding.reading();
    this.sentKey.set(token, `${p.index}\u0000${p.frame?.key ?? ''}`);
    const spec = p.frame?.spec ?? null;
    return {
      ...base,
      spec,
      ...(spec === null ? { emptyReason: p.frame?.reason ?? BOUND_EMPTY_REASON[p.mode] } : {}),
      bindMode: p.mode,
      framesMeta: binding.framesMeta(),
      currentIndex: p.index,
      currentLabel: p.frame?.label ?? '',
    };
  }

  /** 別ウィンドウの「前へ / 次へ」: 本文を動かし、その時点のデータを返事として送る。 */
  jumpFrom(token: string, index: number): void {
    const binding = this.src.binding;
    if (binding === null) return;
    const frame = binding.frameAt(index);
    if (frame === null) return;
    const total = binding.framesMeta().length;
    this.send(token, { signal: null, index, total, frame, mode: binding.reading().mode }, false, { requested: true });
    binding.jump(index);
  }

  /** 引き継いだ(保存・描き直しで器が作り直された)── 新しいデータを送る。 */
  adopt(token: string): void {
    this.tokens.add(token);
    routes.set(token, { link: this });
    const binding = this.src.binding;
    if (binding !== null) {
      this.sentKey.delete(token);
      this.metaDirty.add(token);
      const p = binding.reading();
      // ⚠ 置き直した直後で閲覧位置がまだ届いていなければ送らない(1 つ目の時点へ一瞬戻さない ── 届いた時に送る)
      if (p.signal !== null) this.send(token, p, true);
      return;
    }
    const spec = this.src.view.currentSpec();
    chartPopoutHost().pushUpdate(token, { spec, label: '', index: -1, total: 0, animate: true });
  }

  open(): boolean {
    if (this.disposed) return false;
    const r = chartPopoutHost().open({
      init: (t) => (routes.get(t)?.link ?? this).initFor(t),
      onJump: (index, _key, t) => routes.get(t)?.link.jumpFrom(t, index),
      onReady: (t) => {
        const link = routes.get(t)?.link ?? this;
        link.clearOpening();
      },
      onEnd: (why, t) => {
        const link = routes.get(t)?.link;
        routes.delete(t);
        link?.forget(t);
        for (const [k, d] of detached) {
          if (!d.tokens.delete(t)) continue;
          if (d.tokens.size === 0) {
            clearTimeout(d.timer);
            detached.delete(k);
          }
        }
        if (why === 'blocked') (link ?? this).fail(CHART_POPOUT_BLOCKED);
      },
    });
    if (!r.ok) {
      this.fail(r.reason);
      return false;
    }
    // ⚠ 名乗りが既に届いていれば(同期の放送路)、「開いています…」は出さない
    if (chartPopoutHost().has(r.token)) {
      this.tokens.add(r.token);
      if (!routes.has(r.token)) routes.set(r.token, { link: this });
      if (!chartPopoutHost().isReady(r.token)) this.info(OPENING_TEXT);
    }
    return true;
  }

  clearOpening(): void {
    const el = this.src.view.element.querySelector<HTMLElement>('[data-pkc-gpu-chart-info="hover"]');
    if (el !== null && el.textContent === OPENING_TEXT) el.textContent = '';
  }

  forget(token: string): void {
    this.tokens.delete(token);
    this.sentKey.delete(token);
    this.metaDirty.delete(token);
  }

  private info(text: string): void {
    const el = this.src.view.element.querySelector<HTMLElement>('[data-pkc-gpu-chart-info="hover"]');
    if (el !== null) el.textContent = text;
  }

  fail(reason: string): void {
    if (this.disposed) return;
    this.info(reason);
    this.button.dispatchEvent(new CustomEvent(GPU_CHART_POPOUT_FAILED_EVENT, { bubbles: true, detail: { message: reason } }));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.offReading?.();
    this.button.removeEventListener('click', this.onClick);
    this.button.remove();
    const live = [...this.tokens];
    this.tokens.clear();
    this.sentKey.clear();
    this.metaDirty.clear();
    if (live.length === 0) return;
    const key = this.src.reattachKey;
    const host = chartPopoutHost();
    if (key === null) {
      for (const t of live) {
        routes.delete(t);
        host.notifySourceClosed(t, SOURCE_CLOSED_NOTE);
      }
      return;
    }
    // 🔑 置き直しを待つ(保存・差分の描き直し)── 来なければ切り離す
    const prev = detached.get(key);
    if (prev !== undefined) clearTimeout(prev.timer);
    const tokens = new Set([...(prev?.tokens ?? []), ...live]);
    for (const t of live) routes.delete(t);
    const timer = setTimeout(() => {
      const d = detached.get(key);
      if (d === undefined || d.timer !== timer) return;
      detached.delete(key);
      for (const t of d.tokens) chartPopoutHost().notifySourceClosed(t, SOURCE_CLOSED_NOTE);
    }, REATTACH_GRACE_MS);
    detached.set(key, { tokens, timer });
    // 見えるまで待っている同じ鍵の器があれば、今すぐ置く(画面の外でも引き継げる)
    const now = waitingMounts.get(key);
    if (now !== undefined) {
      waitingMounts.delete(key);
      queueMicrotask(now);
    }
  }
}

/**
 * 🔴 **「別ウィンドウで開く」を付ける**。引き継ぎ待ちのセッションが同じ鍵に在れば、ここで引き継ぐ。
 */
export function attachChartPopout(src: ChartPopoutSource): ChartPopoutLink {
  const link = new LinkImpl(src);
  const key = src.reattachKey;
  if (key !== null) {
    const d = detached.get(key);
    if (d !== undefined) {
      clearTimeout(d.timer);
      detached.delete(key);
      for (const t of d.tokens) {
        if (chartPopoutHost().has(t)) link.adopt(t);
      }
    }
  }
  return link;
}

/** test 用: 引き継ぎ待ち・経路を全部捨てる。 */
export function resetChartPopoutLinksForTest(): void {
  for (const d of detached.values()) clearTimeout(d.timer);
  detached.clear();
  routes.clear();
  waitingMounts.clear();
}
