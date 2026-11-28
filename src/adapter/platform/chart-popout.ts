/**
 * 🔴 **GPU グラフの別ウィンドウ ── 親(メインウィンドウ)側のセッション管理**(v4.1 PR-9、#2095 後半)。
 *
 * ## 作りの要点(`pdf-window.ts` / `view-window.ts` と同じ向き)
 *
 * - **`noopener` で開く**(`CHART_POPOUT_FEATURES`)── 閉じた瞬間に別プロセスごとメモリと GPU のメモリが還る。
 *   代償は handle も opener も失うこと ── だから**同一 origin の放送**で話す(窓が自分で `hello` と言ってくる)。
 * - **開けたかは `hello` で分かる**。`CHART_POPOUT_HELLO_MS` のうちに来なければ「開けなかった」と読み、
 *   セッションを片付けて理由を返す(無言の dead click にしない)。
 * - **放送は全タブに届く** ── 自分が開いた窓の token だけ受ける(他のタブの別ウィンドウと混線させない)。
 * - 🔴 **定常コスト 0**: 別ウィンドウが 1 枚も無い間は放送路を開かない(0 本)。最後のセッションが閉じたら即 `close()`。
 *   配色の見張り・`pagehide` の口も、セッションが在る間だけ張る。親が静止している間に送る便りは 0 通。
 *
 * 封筒・検め・詰め直しは `@features/chart/gpu-chart-sync`(別ウィンドウ側と同じ 1 組)。
 */
import {
  CHART_POPOUT_FEATURES,
  CHART_POPOUT_HELLO_MS,
  CHART_SYNC_CHANNEL,
  CHART_THEME_ATTRS,
  formatChartPopoutUrl,
  makeChartSyncMessage,
  parseChartSyncMessage,
  type ChartInitPayload,
  type ChartThemeAttrs,
  type ChartUpdatePayload,
} from '@features/chart/gpu-chart-sync';

/** 開けなかったときの字。⚠ 画面の字なので標準の IT 用語で。 */
export const CHART_POPOUT_BLOCKED = '別ウィンドウを開けませんでした(ブラウザのポップアップ設定を確認してください)';
export const CHART_POPOUT_UNSUPPORTED = 'このブラウザでは、グラフを別ウィンドウで開けません';
/** 親が閉じた・別のノートへ移ったときに別ウィンドウへ渡す理由。 */
export const SOURCE_CLOSED_NOTE = '元のノートから切り離されました(表示中のグラフは引き続き操作できます)';

export interface ChartBroadcaster {
  postMessage(data: unknown): void;
  close(): void;
  onmessage: ((ev: MessageEvent) => void) | null;
}

/** 1 枚の別ウィンドウとのやり取り(呼び側 ── グラフの器 ── が持つ)。 */
export interface ChartPopoutSessionHooks {
  /** `hello` が来たときに渡す一式(⚠ その時点の現在地で作る ── 開いている間に読み進めても古くならない)。 */
  readonly init: (token: string) => ChartInitPayload;
  /** 別ウィンドウで「前へ / 次へ」を押した(本文をその場所へ動かす ── 双方向)。 */
  readonly onJump?: (index: number, key: string, token: string) => void;
  /** 別ウィンドウが名乗った(開けた)。 */
  readonly onReady?: (token: string) => void;
  /** セッションが終わった(別ウィンドウを閉じた・開けなかった・親が片付けた)。 */
  readonly onEnd?: (why: 'closed' | 'blocked' | 'host', token: string) => void;
}

export type ChartPopoutOpenResult = { readonly ok: true; readonly token: string } | { readonly ok: false; readonly reason: string };

export interface ChartPopoutDeps {
  /** 放送路を作る(既定 `BroadcastChannel`。無い環境では `null`)。 */
  readonly makeChannel?: (name: string) => ChartBroadcaster | null;
  /** 窓を開く(既定 `window.open`)。⚠ `noopener` は `features` に入っている ── 戻り値は見ない。 */
  readonly openWindow?: (url: string, features: string) => void;
  /** 開くアドレスの base(`#` を含まない)。 */
  readonly baseUrl?: () => string;
  readonly newToken?: () => string;
  readonly setTimer?: (fn: () => void, ms: number) => unknown;
  readonly clearTimer?: (h: unknown) => void;
  /** 今の配色(`<html>` の 3 つの属性)。 */
  readonly readTheme?: () => ChartThemeAttrs;
  /** 配色の変化を見張る(返り値で止める)。セッションが在る間だけ呼ばれる。 */
  readonly watchTheme?: (fn: () => void) => () => void;
  /** 親が閉じる(`pagehide`)を見張る(返り値で止める)。セッションが在る間だけ呼ばれる。 */
  readonly watchPageHide?: (fn: () => void) => () => void;
}

interface Session {
  readonly token: string;
  readonly hooks: ChartPopoutSessionHooks;
  helloTimer: unknown;
  ready: boolean;
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

function defaultToken(): string {
  const c = globalThis.crypto;
  const raw = c !== undefined && 'randomUUID' in c ? c.randomUUID() : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  // ⚠ 合図の綴りは `[A-Za-z0-9_-]{8,64}`(`permalink.ts`)
  return `c${raw.replace(/[^A-Za-z0-9_-]/g, '')}`.slice(0, 64);
}

function htmlEl(): HTMLElement | null {
  return typeof document === 'object' ? document.documentElement : null;
}

/** `<html>` の 3 つの属性を読む。 */
export function readThemeAttrs(el: Element | null = htmlEl()): ChartThemeAttrs {
  return {
    theme: el?.getAttribute('data-pkc-theme') ?? null,
    tone: el?.getAttribute('data-pkc-tone') ?? null,
    accent: el?.getAttribute('data-pkc-accent') ?? null,
  };
}

function defaultWatchTheme(fn: () => void): () => void {
  const el = htmlEl();
  const MO = (globalThis as { MutationObserver?: typeof MutationObserver }).MutationObserver;
  if (el === null || MO === undefined) return () => undefined;
  const mo = new MO(() => fn());
  mo.observe(el, { attributes: true, attributeFilter: [...CHART_THEME_ATTRS] });
  return () => mo.disconnect();
}

function defaultWatchPageHide(fn: () => void): () => void {
  if (typeof window !== 'object') return () => undefined;
  const on = (): void => fn();
  window.addEventListener('pagehide', on);
  window.addEventListener('beforeunload', on);
  return () => {
    window.removeEventListener('pagehide', on);
    window.removeEventListener('beforeunload', on);
  };
}

function defaultBaseUrl(): string {
  // ⚠ 断片を落とした今のアドレス(`deep-link.ts` の `currentBaseUrl` と同じ作法)。読むのは開く瞬間だけ
  return typeof document === 'object' ? document.baseURI.split('#')[0]! : '';
}

export class ChartPopoutHost {
  private ch: ChartBroadcaster | null = null;
  private readonly sessions = new Map<string, Session>();
  private stopTheme: (() => void) | null = null;
  private stopPageHide: (() => void) | null = null;
  private lastTheme = '';
  private readonly makeChannel: (name: string) => ChartBroadcaster | null;
  private readonly openWindow: (url: string, features: string) => void;
  private readonly baseUrl: () => string;
  private readonly newToken: () => string;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (h: unknown) => void;
  private readonly readTheme: () => ChartThemeAttrs;
  private readonly watchTheme: (fn: () => void) => () => void;
  private readonly watchPageHide: (fn: () => void) => () => void;

  constructor(deps: ChartPopoutDeps = {}) {
    this.makeChannel = deps.makeChannel ?? defaultChannel;
    this.openWindow =
      deps.openWindow ??
      ((url, features): void => {
        // 🔴 `noopener` を外さない(閉じたとき別プロセスごと還る ── `CHART_POPOUT_FEATURES`)
        window.open(url, '_blank', features);
      });
    this.baseUrl = deps.baseUrl ?? defaultBaseUrl;
    this.newToken = deps.newToken ?? defaultToken;
    this.setTimer = deps.setTimer ?? ((fn, ms): unknown => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((h): void => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.readTheme = deps.readTheme ?? (() => readThemeAttrs());
    this.watchTheme = deps.watchTheme ?? defaultWatchTheme;
    this.watchPageHide = deps.watchPageHide ?? defaultWatchPageHide;
  }

  /** 生きているセッションの数(test の観測点)。 */
  get sessionCount(): number {
    return this.sessions.size;
  }
  /** 放送路を開いているか(定常コスト 0 の観測点)。 */
  get channelOpen(): boolean {
    return this.ch !== null;
  }
  has(token: string): boolean {
    return this.sessions.has(token);
  }
  isReady(token: string): boolean {
    return this.sessions.get(token)?.ready === true;
  }

  /**
   * 🔴 **別ウィンドウを開く**。放送路はここで初めて開く(遅延)。
   * ⚠ 放送路を作れない環境では窓を開かずに理由を返す(開いても話せない窓を残さない)。
   */
  open(hooks: ChartPopoutSessionHooks): ChartPopoutOpenResult {
    const ch = this.ensureChannel();
    if (ch === null) return { ok: false, reason: CHART_POPOUT_UNSUPPORTED };
    const token = this.newToken();
    const url = formatChartPopoutUrl(this.baseUrl(), token);
    if (url === null) {
      this.releaseIfIdle();
      return { ok: false, reason: CHART_POPOUT_UNSUPPORTED };
    }
    const s: Session = { token, hooks, helloTimer: null, ready: false };
    this.sessions.set(token, s);
    this.armWatchers();
    s.helloTimer = this.setTimer(() => {
      s.helloTimer = null;
      if (s.ready || !this.sessions.has(token)) return;
      this.endSession(token, 'blocked');
    }, CHART_POPOUT_HELLO_MS);
    try {
      this.openWindow(url, CHART_POPOUT_FEATURES);
    } catch {
      this.endSession(token, 'blocked');
      return { ok: false, reason: CHART_POPOUT_BLOCKED };
    }
    return { ok: true, token };
  }

  /** 現在地・データの変化を送る。⚠ 名乗る前(`hello` 前)は送らない ── 名乗ったときの `init` がその時点の一式を持つ。 */
  pushUpdate(token: string, payload: ChartUpdatePayload): boolean {
    const s = this.sessions.get(token);
    if (s === undefined || !s.ready) return false;
    this.post(makeChartSyncMessage({ kind: 'update', token, payload }));
    return true;
  }

  /** 配色を全ての別ウィンドウへ(変わったときだけ)。 */
  pushTheme(theme: ChartThemeAttrs = this.readTheme()): number {
    const key = `${theme.theme}|${theme.tone}|${theme.accent}`;
    if (key === this.lastTheme) return 0;
    this.lastTheme = key;
    let n = 0;
    for (const s of this.sessions.values()) {
      if (!s.ready) continue;
      this.post(makeChartSyncMessage({ kind: 'theme', token: s.token, payload: theme }));
      n += 1;
    }
    return n;
  }

  /** 元のノートから切り離す(別ウィンドウはグラフを残したまま、案内を 1 行出す)。セッションは閉じる。 */
  notifySourceClosed(token: string, reason: string = SOURCE_CLOSED_NOTE): void {
    const s = this.sessions.get(token);
    if (s === undefined) return;
    if (s.ready) this.post(makeChartSyncMessage({ kind: 'source-closed', token, payload: { reason } }));
    this.endSession(token, 'host');
  }

  /** セッションを閉じる(便りは送らない)。 */
  closeSession(token: string): void {
    if (this.sessions.has(token)) this.endSession(token, 'host');
  }

  /** 全部片付ける(親が閉じるとき)── 生きている別ウィンドウへ `source-closed` を送ってから閉じる。 */
  dispose(reason: string = SOURCE_CLOSED_NOTE): void {
    for (const token of [...this.sessions.keys()]) this.notifySourceClosed(token, reason);
    this.releaseIfIdle();
  }

  // ── 内側

  private ensureChannel(): ChartBroadcaster | null {
    if (this.ch !== null) return this.ch;
    const ch = this.makeChannel(CHART_SYNC_CHANNEL);
    if (ch === null) return null;
    ch.onmessage = (ev: MessageEvent): void => this.receive(ev.data);
    this.ch = ch;
    return ch;
  }

  private post(msg: Record<string, unknown>): void {
    try {
      this.ch?.postMessage(msg);
    } catch {
      /* 送れなくても続ける(閉じた放送路) */
    }
  }

  private armWatchers(): void {
    if (this.stopTheme === null) {
      this.lastTheme = '';
      const t = this.readTheme();
      this.lastTheme = `${t.theme}|${t.tone}|${t.accent}`;
      this.stopTheme = this.watchTheme(() => this.pushTheme());
    }
    if (this.stopPageHide === null) this.stopPageHide = this.watchPageHide(() => this.dispose());
  }

  /** セッションが 0 件なら放送路と見張りを全部返す(定常コスト 0)。 */
  private releaseIfIdle(): void {
    if (this.sessions.size > 0) return;
    this.stopTheme?.();
    this.stopTheme = null;
    this.stopPageHide?.();
    this.stopPageHide = null;
    const ch = this.ch;
    this.ch = null;
    if (ch !== null) {
      ch.onmessage = null;
      try {
        ch.close();
      } catch {
        /* 閉じられなくても続ける */
      }
    }
  }

  private endSession(token: string, why: 'closed' | 'blocked' | 'host'): void {
    const s = this.sessions.get(token);
    if (s === undefined) return;
    this.sessions.delete(token);
    if (s.helloTimer !== null) this.clearTimer(s.helloTimer);
    s.helloTimer = null;
    this.releaseIfIdle();
    try {
      s.hooks.onEnd?.(why, token);
    } catch {
      /* 呼び側の失敗で片付けを止めない */
    }
  }

  private receive(data: unknown): void {
    const m = parseChartSyncMessage(data);
    if (m === null) return;
    // 🔴 自分が開いた窓の token だけ(他のタブの別ウィンドウと混線させない)
    const s = this.sessions.get(m.token);
    if (s === undefined) return;
    switch (m.kind) {
      case 'hello': {
        if (s.helloTimer !== null) this.clearTimer(s.helloTimer);
        s.helloTimer = null;
        s.ready = true;
        let init: ChartInitPayload;
        try {
          init = s.hooks.init(s.token);
        } catch {
          this.notifySourceClosed(s.token);
          return;
        }
        this.post(makeChartSyncMessage({ kind: 'init', token: s.token, payload: init }));
        s.hooks.onReady?.(s.token);
        return;
      }
      case 'jump':
        if (s.ready) s.hooks.onJump?.(m.payload.index, m.payload.key, s.token);
        return;
      case 'closed':
        this.endSession(s.token, 'closed');
        return;
      default:
        // 親 → 別ウィンドウの便り(自分の放送の写し等)は受けない
        return;
    }
  }
}

let shared: ChartPopoutHost | null = null;

/** このタブの 1 つの管理役(⚠ 作るだけでは放送路を開かない ── 開くのは最初の `open`)。 */
export function chartPopoutHost(): ChartPopoutHost {
  shared ??= new ChartPopoutHost();
  return shared;
}

/** test 用: 管理役を差し替える(`null` で次に作り直す)。 */
export function setChartPopoutHostForTest(host: ChartPopoutHost | null): void {
  shared?.dispose();
  shared = host;
}
