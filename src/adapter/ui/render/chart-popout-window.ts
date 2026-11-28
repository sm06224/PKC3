/**
 * 🔴 **GPU グラフの別ウィンドウ(ビューア側)**(v4.1 PR-9、#2095 後半)。
 *
 * `main.ts` が起動のいちばん最初(storage / OPFS / worker / サイドバーより前)で `#pkc?chart=<token>` を見つけたら、
 * 通常の起動をせずにここだけを動かす ── **DB を握らない・他のタブと書き込みの権利を取り合わない・すぐ開く**。
 *
 * - 描くのは既存の `mountGpuChart`(`gpu-lease.ts` 経由・Three.js は遅延読込・2D の簡易表示)── 2 本目の描画を作らない。
 * - 上部の見出し(`chart-popout-head`): 題名 / 連動の表示 / 前へ・次へ / 追従 ON ⇄ 固定中 / 状態の行。
 * - 中央の描画域(`chart-popout-stage`): 窓の大きさに合わせて広がる(大きさの変化はグラフ自身の `ResizeObserver` が描き直す)。
 * - 閉じるとき(`pagehide` / `beforeunload`)に `closed` を送り、グラフと放送路を返す(GPU のメモリ・見張り・放送路を全部返す)。
 * - 親が切り離した(`source-closed`)ら、今のグラフは残したまま案内を 1 行出し、放送路を閉じる(以後の便りは 0 通)。
 */
import {
  CHART_POPOUT_HELLO_MS,
  CHART_SYNC_CHANNEL,
  chartPopoutTitle,
  makeChartSyncMessage,
  parseChartSyncMessage,
  popoutBindLabel,
  type ChartFrameMeta,
  type ChartThemeAttrs,
  type ChartUpdatePayload,
} from '@features/chart/gpu-chart-sync';
import type { ChartBindMode, GpuChartSpec } from '@features/chart/gpu-chart-spec';
import { mountGpuChart, type GpuChartView } from './gpu-chart';
import type { ChartBroadcaster } from '@adapter/platform/chart-popout';

/** 名乗ってから一式が届くまでの字。 */
export const POPOUT_WAITING_TEXT = 'メインウィンドウからグラフを受け取っています…';
/** 一式が届かなかったときの字(親が閉じた・読み直して切り離された)。 */
export const POPOUT_NO_SOURCE_TEXT = 'メインウィンドウと接続できませんでした。メインウィンドウからもう一度「別ウィンドウで開く」を押してください';
export const POPOUT_CONNECTED_TEXT = 'メインウィンドウと連動しています';
export const POPOUT_FIXED_TEXT = 'グラフを固定しています(メインウィンドウを読み進めても切り替わりません)';
export const POPOUT_UNSUPPORTED_TEXT = 'このブラウザでは、メインウィンドウと連動できません';

export interface ChartPopoutWindowDeps {
  readonly makeChannel?: (name: string) => ChartBroadcaster | null;
  readonly mount?: (host: HTMLElement, spec: GpuChartSpec) => GpuChartView;
  readonly setTimer?: (fn: () => void, ms: number) => unknown;
  readonly clearTimer?: (h: unknown) => void;
  /** `pagehide` を聞く窓(既定 `window`)。 */
  readonly win?: Pick<Window, 'addEventListener' | 'removeEventListener'> | null;
}

export interface ChartPopoutWindowHandle {
  /** 追従 ON か(test の観測点)。 */
  readonly following: boolean;
  /** 親と繋がっているか。 */
  readonly connected: boolean;
  readonly view: GpuChartView | null;
  /** いま見せている時点の番号。 */
  readonly index: number;
  setFollowing(on: boolean): void;
  step(dir: 1 | -1): void;
  /** 閉じる(`pagehide` と同じ)。 */
  close(): void;
}

function defaultChannel(name: string): ChartBroadcaster | null {
  const BC = (globalThis as { BroadcastChannel?: typeof BroadcastChannel }).BroadcastChannel;
  if (BC === undefined) return null;
  try {
    return new BC(name) as unknown as ChartBroadcaster;
  } catch {
    return null;
  }
}

function applyThemeAttrs(el: HTMLElement, t: ChartThemeAttrs): void {
  const set = (name: string, v: string | null): void => {
    if (v === null) el.removeAttribute(name);
    else if (el.getAttribute(name) !== v) el.setAttribute(name, v);
  };
  set('data-pkc-theme', t.theme);
  set('data-pkc-tone', t.tone);
  set('data-pkc-accent', t.accent);
}

/**
 * 🔴 **別ウィンドウを起こす**。`root` を中身ごと置き換える。
 */
export function bootChartPopoutWindow(root: HTMLElement, token: string, deps: ChartPopoutWindowDeps = {}): ChartPopoutWindowHandle {
  const doc = root.ownerDocument;
  const html = doc.documentElement;
  const mount = deps.mount ?? mountGpuChart;
  const setTimer = deps.setTimer ?? ((fn, ms): unknown => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h): void => clearTimeout(h as ReturnType<typeof setTimeout>));
  const win = deps.win === undefined ? (typeof window === 'object' ? window : null) : deps.win;

  html.setAttribute('data-pkc-chart-popout', '');
  root.replaceChildren();
  root.classList.add('pkc-chart-popout');
  root.setAttribute('data-pkc-region', 'chart-popout');

  // ── 上部の見出し
  const head = doc.createElement('header');
  head.className = 'pkc-chart-popout-head';
  head.setAttribute('data-pkc-region', 'chart-popout-head');
  const titleEl = doc.createElement('div');
  titleEl.className = 'pkc-chart-popout-title';
  titleEl.setAttribute('data-pkc-field', 'chart-popout-title');
  const chartTitleEl = doc.createElement('strong');
  const noteTitleEl = doc.createElement('span');
  noteTitleEl.className = 'pkc-chart-popout-note';
  titleEl.append(chartTitleEl, noteTitleEl);
  const mkBtn = (field: string, text: string, tip: string): HTMLButtonElement => {
    const b = doc.createElement('button');
    b.type = 'button';
    b.className = 'pkc-gpu-chart-btn';
    b.setAttribute('data-pkc-variant', 'ghost');
    b.setAttribute('data-pkc-field', field);
    b.textContent = text;
    b.title = tip;
    return b;
  };
  const bindLabel = mkBtn('chart-popout-bind', '', 'メインウィンドウの本文をこの場所へ移動します');
  bindLabel.classList.add('pkc-gpu-chart-bind-label');
  const prev = mkBtn('chart-popout-prev', '◀ 前へ', '前の場所のグラフを表示し、メインウィンドウの本文もその場所へ移動します');
  const next = mkBtn('chart-popout-next', '次へ ▶', '次の場所のグラフを表示し、メインウィンドウの本文もその場所へ移動します');
  const follow = mkBtn('chart-popout-follow', '追従 ON', '');
  const spacer = doc.createElement('span');
  spacer.className = 'pkc-gpu-chart-spacer';
  const bindGroup = doc.createElement('div');
  bindGroup.className = 'pkc-chart-popout-bind';
  bindGroup.append(bindLabel, prev, next, follow);
  bindGroup.hidden = true;
  const status = doc.createElement('p');
  status.className = 'pkc-chart-popout-status';
  status.setAttribute('data-pkc-field', 'chart-popout-status');
  status.setAttribute('role', 'status');
  status.textContent = POPOUT_WAITING_TEXT;
  head.append(titleEl, spacer, bindGroup, status);

  // ── 中央の描画域
  const stage = doc.createElement('main');
  stage.className = 'pkc-chart-popout-stage';
  stage.setAttribute('data-pkc-region', 'chart-popout-stage');
  const emptyEl = doc.createElement('p');
  emptyEl.className = 'pkc-gpu-chart-empty';
  emptyEl.setAttribute('data-pkc-field', 'chart-popout-empty');
  emptyEl.hidden = true;
  stage.append(emptyEl);
  root.append(head, stage);

  let view: GpuChartView | null = null;
  let following = true;
  let connected = false;
  let detached = false;
  let closed = false;
  let bindMode: ChartBindMode | undefined;
  let frames: readonly ChartFrameMeta[] = [];
  let index = -1;
  /** 固定中に届いた最新の便り(固定を解いた瞬間にこれへ追従する)。 */
  let latest: ChartUpdatePayload | null = null;
  let waitTimer: unknown = null;

  const ch = (deps.makeChannel ?? defaultChannel)(CHART_SYNC_CHANNEL);
  let channel: ChartBroadcaster | null = ch;

  const post = (msg: Record<string, unknown>): void => {
    try {
      channel?.postMessage(msg);
    } catch {
      /* 閉じた放送路 */
    }
  };
  const closeChannel = (): void => {
    const c = channel;
    channel = null;
    if (c === null) return;
    c.onmessage = null;
    try {
      c.close();
    } catch {
      /* 続ける */
    }
  };

  const syncControls = (): void => {
    const bound = bindMode !== undefined;
    bindGroup.hidden = !bound;
    follow.setAttribute('aria-pressed', following ? 'false' : 'true');
    follow.textContent = following ? '追従 ON' : '固定中';
    follow.title = following
      ? 'メインウィンドウで本文を読み進めるとグラフが切り替わります。押すと今のグラフに固定します'
      : 'グラフを固定しています。押すとメインウィンドウで今読んでいる場所のグラフに戻ります';
    const live = connected && !detached;
    prev.disabled = !live || index <= 0;
    next.disabled = !live || index < 0 || index >= frames.length - 1;
    follow.disabled = !live;
    bindLabel.disabled = !live || index < 0;
    root.setAttribute('data-pkc-chart-popout-following', following ? 'true' : 'false');
    root.setAttribute('data-pkc-chart-popout-index', String(index));
  };

  const setStatus = (text: string): void => {
    status.textContent = text;
  };

  /** データを見せる(無ければ理由を出し、古い絵を隠す)。 */
  const showSpec = (spec: GpuChartSpec | null, reason: string | undefined, animate: boolean): void => {
    if (spec === null) {
      if (view !== null) view.setEmpty(reason ?? 'この場所には対象データがありません');
      else {
        emptyEl.textContent = reason ?? 'この場所には対象データがありません';
        emptyEl.hidden = false;
      }
      return;
    }
    emptyEl.hidden = true;
    if (view === null) {
      view = mount(stage, spec);
      // 🔑 描画域を窓いっぱいに(高さは CSS の flex が決める ── 本文用の固定の高さを外す)
      const s = view.element.querySelector<HTMLElement>('[data-pkc-gpu-chart-stage]');
      if (s !== null) s.style.height = '';
      return;
    }
    view.setEmpty(null);
    view.updateData(spec, { animate, resetViewport: true });
  };

  const applyUpdate = (u: ChartUpdatePayload): void => {
    if (u.framesMeta !== undefined) frames = u.framesMeta;
    index = u.index;
    bindLabel.textContent = popoutBindLabel(bindMode, u.label, u.index, frames.length || u.total);
    showSpec(u.spec, u.emptyReason, u.animate);
    syncControls();
  };

  const onMessage = (data: unknown): void => {
    const m = parseChartSyncMessage(data);
    // 🔴 自分の token だけ(他のタブの別ウィンドウ宛ての便りと混線させない)
    if (m === null || m.token !== token || closed) return;
    switch (m.kind) {
      case 'init': {
        if (waitTimer !== null) clearTimer(waitTimer);
        waitTimer = null;
        connected = true;
        const p = m.payload;
        applyThemeAttrs(html, p.theme);
        doc.title = chartPopoutTitle(p.chartTitle, p.noteTitle);
        chartTitleEl.textContent = p.chartTitle.trim() === '' ? 'グラフ' : p.chartTitle;
        noteTitleEl.textContent = p.noteTitle;
        bindMode = p.bindMode;
        frames = p.framesMeta ?? [];
        index = p.currentIndex;
        bindLabel.textContent = popoutBindLabel(bindMode, p.currentLabel, p.currentIndex, frames.length);
        showSpec(p.spec, p.emptyReason, false);
        setStatus(bindMode === undefined ? '' : POPOUT_CONNECTED_TEXT);
        syncControls();
        return;
      }
      case 'update': {
        if (!connected) return;
        const u = m.payload;
        latest = u;
        // 🔑 固定中は控えに置くだけ(押した「前へ / 次へ」の返事だけは見せる)
        if (!following && u.requested !== true) {
          if (u.framesMeta !== undefined) frames = u.framesMeta;
          syncControls();
          return;
        }
        applyUpdate(u);
        return;
      }
      case 'theme':
        applyThemeAttrs(html, m.payload);
        return;
      case 'source-closed':
        detached = true;
        setStatus(m.payload.reason);
        root.setAttribute('data-pkc-chart-popout-detached', '');
        // 🔑 以後は便りが来ない ── 放送路を閉じる(定常コスト 0)
        closeChannel();
        syncControls();
        return;
      default:
        return;
    }
  };

  const sendJump = (i: number): void => {
    const f = frames[i];
    if (f === undefined || !connected || detached) return;
    post(makeChartSyncMessage({ kind: 'jump', token, payload: { index: i, key: f.key } }));
  };

  const step = (dir: 1 | -1): void => {
    if (frames.length === 0) return;
    const i = Math.max(0, Math.min(frames.length - 1, (index < 0 ? 0 : index) + dir));
    if (i === index) return;
    sendJump(i);
  };
  const setFollowing = (on: boolean): void => {
    following = on;
    if (on && latest !== null) applyUpdate({ ...latest, animate: true });
    setStatus(detached ? status.textContent ?? '' : bindMode === undefined ? '' : on ? POPOUT_CONNECTED_TEXT : POPOUT_FIXED_TEXT);
    syncControls();
  };

  const onPrev = (): void => step(-1);
  const onNext = (): void => step(1);
  const onFollow = (): void => setFollowing(!following);
  const onLabel = (): void => sendJump(index);
  prev.addEventListener('click', onPrev);
  next.addEventListener('click', onNext);
  follow.addEventListener('click', onFollow);
  bindLabel.addEventListener('click', onLabel);

  const close = (): void => {
    if (closed) return;
    closed = true;
    if (waitTimer !== null) clearTimer(waitTimer);
    waitTimer = null;
    if (!detached) post(makeChartSyncMessage({ kind: 'closed', token }));
    closeChannel();
    view?.dispose();
    view = null;
    win?.removeEventListener('pagehide', close);
    win?.removeEventListener('beforeunload', close);
    prev.removeEventListener('click', onPrev);
    next.removeEventListener('click', onNext);
    follow.removeEventListener('click', onFollow);
    bindLabel.removeEventListener('click', onLabel);
  };
  win?.addEventListener('pagehide', close);
  win?.addEventListener('beforeunload', close);

  if (channel === null) {
    setStatus(POPOUT_UNSUPPORTED_TEXT);
  } else {
    channel.onmessage = (ev: MessageEvent): void => onMessage(ev.data);
    // 🔑 名乗る(親はこれで「開けた」と分かり、すぐ一式を返す)
    post(makeChartSyncMessage({ kind: 'hello', token }));
    waitTimer = setTimer(() => {
      waitTimer = null;
      if (connected || closed) return;
      setStatus(POPOUT_NO_SOURCE_TEXT);
      root.setAttribute('data-pkc-chart-popout-detached', '');
      closeChannel();
    }, CHART_POPOUT_HELLO_MS);
  }
  syncControls();

  return {
    get following() {
      return following;
    },
    get connected() {
      return connected && !detached;
    },
    get view() {
      return view;
    },
    get index() {
      return index;
    },
    setFollowing,
    step,
    close,
  };
}
