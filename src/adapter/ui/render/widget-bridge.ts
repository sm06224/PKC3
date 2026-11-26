/**
 * ノートに埋め込んだ HTML / React のウィジェットと親(PKC3)をつなぐ口(v4.0 Phase 2 / PR-07、ビジョン 5-A)。
 *
 * ## 3 つの仕事
 *
 * 1. **テーマの配信** ── 箱(sandbox iframe)が `pkc-widget-ready` を送ってきたら、いまの配色を返す。
 *    親の配色が変わったら(`<html>` の `data-pkc-theme` / `data-pkc-tone` / `data-pkc-accent`)、生きている箱すべてへ
 *    新しい値を送る。🔑 **箱は読み直さない**(`srcdoc` を変えない ── 中で動いている状態が消えない)。
 * 2. **保存の受け口** ── `id=` の在る箱の `localStorage` の差分を受けて、親の `localStorage` へ書く。
 * 3. **`id=` の在る ` ```html ` の箱を置く**(`hydrateWidgets`)── 見えたときに、前回の保存を `seed` に焼いて置く。
 * 4. **同じノートのデータの問い合わせに答える**(PR-08)── 登録した箱にだけ、その箱を置いたノート 1 件の本文から
 *    前書きと表を組んで返す(`extractWidgetNoteContext`)。他のノート・設定・他のウィジェットの保存は返さない。
 * 5. **「ノートへ保存」「状態を初期化」**(PR-08)── user が親のボタンを押したときだけ、本文の
 *    ` ```json widget-state="…" ` を書く / 消す(書くのは reducer → `REQUEST_BODY_REWRITE` の 1 本)。
 *    🔴 箱から本文を書く口は無い(自動・黙っての書込を作らない)。
 *
 * ## 🔴 セキュリティの不変条件
 *
 * - 送り主は **`event.source === iframe.contentWindow`** だけで決める(`resolveSandboxSender` と同じ規律)。
 *   `event.origin` は使わない(`allow-same-origin` の無い箱は `"null"` で、安全な箱も攻撃者の箱も同じ値)。
 * - 保存先は**親の DOM 側に登録した `(lid, widgetId)`** だけから決める ── 箱が名乗る id / lid は読まない。
 *   登録の無い箱(`id=` の無い箱・別の文書の箱)の保存要求は**黙って捨てる**。
 * - 上限(512 KB)は親でも数える(`applyWidgetStorageOp`)。
 *
 * ## 定常のコスト
 *
 * - 配色の見張り(`MutationObserver`)は**箱が 1 つでも `ready` を送ってきたとき**に初めて付ける ──
 *   箱の無いノートだけを読んでいる間は何も見張らない。
 */
import {
  buildHtmlSandboxDoc,
  resolveSandboxSender,
  restoreSandboxHeights,
  WIDGET_FRAME_ATTR,
} from '@features/markdown/html-sandbox';
import {
  WIDGET_CONTEXT_REQ_MSG_TYPE,
  WIDGET_CONTEXT_RES_MSG_TYPE,
  WIDGET_ID_ATTR,
  WIDGET_LIVE_ATTR,
  WIDGET_SEED_ATTR,
  WIDGET_READY_MSG_TYPE,
  WIDGET_SRC_ATTR,
  WIDGET_STORAGE_MESSAGE,
  WIDGET_THEME_MSG_TYPE,
  widgetFrameId,
  widgetPrelude,
  widgetThemeFrom,
  widgetThemePreludeScript,
  type WidgetTheme,
} from '@features/markdown/widget-bridge';
import {
  applyWidgetStorageOp,
  clearWidgetStorage,
  hasWidgetStorage,
  readWidgetStorage,
  type WidgetStorageOp,
} from '@adapter/platform/widget-storage';
import {
  hasWidgetStateBlock,
  parseWidgetStateJson,
  readWidgetStateBlock,
  WIDGET_STATE_BLOCK_LIMIT,
  widgetStateJson,
  widgetStateTooLargeNote,
} from '@features/markdown/widget-state-block';
import {
  emptyWidgetNoteContext,
  extractWidgetNoteContext,
  type WidgetNoteContext,
} from '@features/markdown/widget-context';
import { confirmInApp } from './app-dialog';
import { watchVisible } from './visible-watch';
import { typingQuietIn } from './typing-gate';
import { registerLiveScope, type MermaidScope } from './mermaid-hydrate';

/**
 * 本文の器に付ける「このノートの lid」。🔑 ウィジェットの保存先はここから引く(箱の名乗りは使わない)。
 * ⚠ 付いていない面(書き出し・lid の決まらない面)では、`id=` の在る箱も**保存しない**(テーマ連動だけ)。
 */
export const WIDGET_LID_ATTR = 'data-pkc-widget-lid';

/**
 * 🔴 **ウィジェットとノートの本文をつなぐ口**(PR-08。`main.ts` が 1 回だけ渡す)。
 *
 * ⚠ 本文を書く口(`saveState` / `removeState`)は**親のボタンからしか呼ばない**(箱の合図からは呼ばない)。
 *   書込は reducer(`SET_WIDGET_STATE`)→ `REQUEST_BODY_REWRITE` の 1 本を通る(門・履歴・別のタブの編集の確認も同じ)。
 */
export interface WidgetNoteHost {
  /** そのノートのいまの本文(読む面で開いているノートの物だけ。読めなければ `null`)。 */
  bodyOf(lid: string): string | null;
  /** 本文を書けない理由の文(書けるなら `null`。`bodyWriteBlockReason` と同じ判定。字は言い切りの文で返す)。 */
  writeBlockReason(lid: string): string | null;
  /** 状態ブロックを書く(「ノートへ保存」)。 */
  saveState(lid: string, widgetId: string, state: Readonly<Record<string, string>>): void;
  /** 状態ブロックを消す(「状態を初期化」)。 */
  removeState(lid: string, widgetId: string): void;
  /** 断りを知らせる。 */
  fail(message: string): void;
}

let noteHost: WidgetNoteHost | null = null;

/** 本文との口を渡す(`null` で外す ── test 用)。 */
export function setWidgetNoteHost(host: WidgetNoteHost | null): void {
  noteHost = host;
}

/**
 * 「状態を初期化」で本文のブロックを消すよう頼んだウィジェット(`lid\0widgetId`)。
 * 🔴 消す書込が終わる前に箱を置き直しても、**消すはずのブロックから古い値を復活させない**。
 * ⚠ 「ノートへ保存」を押し直したら外す(また本文のブロックを正とする)。
 */
const blockSuppressed = new Set<string>();
const suppressKey = (lid: string, widgetId: string): string => `${lid}\u0000${widgetId}`;

/**
 * 🔴 **箱の初期値を決める**(PR-08 の復元の優先順)。
 * 1. この端末の保存(`localStorage`)が 1 件でも在れば、それ(端末での最新の操作)。
 * 2. 無ければ、本文の ` ```json widget-state="…" `(別の端末へ同期した直後など)。
 *    🔑 読んだ値は**この端末の保存へ写す** ── 箱は変わった鍵だけを送ってくるので、写さないと次に置いたとき
 *    変えなかった鍵が消える(端末の保存が 1 件でも在れば 1. が勝つため)。
 * 3. どちらも無ければ空。
 */
export function resolveWidgetSeed(lid: string, widgetId: string): Readonly<Record<string, string>> {
  const local = readWidgetStorage(lid, widgetId);
  if (Object.keys(local).length > 0) return local;
  if (blockSuppressed.has(suppressKey(lid, widgetId))) return local;
  const body = noteHost?.bodyOf(lid) ?? null;
  if (body === null) return local;
  const block = readWidgetStateBlock(body, widgetId);
  if (block === null) return local;
  for (const [key, value] of Object.entries(block)) applyWidgetStorageOp(lid, widgetId, { op: 'set', key, value });
  return block;
}

/** 器(placeholder / React の器)から、親の DOM が持つ lid を引く。 */
export function widgetLidOf(host: Element): string | null {
  const lid = host.closest(`[${WIDGET_LID_ATTR}]`)?.getAttribute(WIDGET_LID_ATTR) ?? '';
  return lid === '' ? null : lid;
}

interface FrameReg {
  readonly lid: string;
  readonly widgetId: string;
  /** 保存が変わったとき(「状態を初期化」の押せる / 押せないを合わせる)。 */
  readonly onChange: () => void;
  /** 箱をはじめから置き直す(器の lid が変わったとき ── `remountStaleWidgets`)。 */
  readonly remount: () => void;
}

/** 保存してよい箱(親が置いた `id=` の在る箱だけ)。 */
const registry = new Map<HTMLIFrameElement, FrameReg>();

/**
 * 保存してよい箱として登録する。⚠ 登録は**親が箱を置いたとき**だけ(箱の申告では登録しない)。
 * @returns 登録の解除
 */
export function registerWidgetFrame(frame: HTMLIFrameElement, reg: FrameReg): () => void {
  registry.set(frame, reg);
  return () => {
    if (registry.get(frame) === reg) registry.delete(frame);
  };
}

/**
 * 🔴 **器の lid と、箱を置いたときの lid が食い違う箱を置き直す**。
 *
 * 差分描画(`applyBlocks`)は**別のノートへ移っても同じ HTML の塊を持ち越す** ── 2 つのノートに同じウィジェットを
 * 書いていると、前のノートの lid で登録した箱がそのまま残り、**前のノートの領域へ書き続ける**。
 * 本文の器の lid を付け替えた直後にこれを呼ぶ(受け口でも照合して断る ── 二重の門)。
 */
export function remountStaleWidgets(root: ParentNode): number {
  let n = 0;
  for (const [f, reg] of [...registry]) {
    if (!f.isConnected || !root.contains(f)) continue;
    if (widgetLidOf(f) === reg.lid) continue;
    reg.remount();
    n += 1;
  }
  return n;
}

/** test 用:登録の数(箱を外したときに残っていないか)。 */
export function widgetFrameCount(): number {
  return registry.size;
}

/** 親のいまの配色(箱へ送る値)。 */
export function currentWidgetTheme(doc: Document): WidgetTheme {
  const root = doc.documentElement;
  const style = doc.defaultView?.getComputedStyle(root) ?? null;
  return widgetThemeFrom((name) => style?.getPropertyValue(name) ?? '', root.getAttribute('data-pkc-tone'));
}

function postTheme(frame: HTMLIFrameElement, theme: WidgetTheme): void {
  try {
    frame.contentWindow?.postMessage({ type: WIDGET_THEME_MSG_TYPE, tone: theme.tone, tokens: theme.tokens }, '*');
  } catch {
    // 外れかけの箱でも落ちない
  }
}

/** 生きている箱すべてへ配色を送る(箱は読み直さない)。 */
export function broadcastWidgetTheme(doc: Document): number {
  const theme = currentWidgetTheme(doc);
  const frames = doc.querySelectorAll<HTMLIFrameElement>(`iframe[${WIDGET_FRAME_ATTR}]`);
  for (const f of frames) postTheme(f, theme);
  return frames.length;
}

/** 配色を決める `<html>` の属性(`theme.ts` / `appearance-choice.ts`)。 */
const THEME_ATTRS = ['data-pkc-theme', 'data-pkc-tone', 'data-pkc-accent'] as const;

/** 同じ本文を何度も組み直さない(箱が続けて問い合わせても、本文が変わらない限り 1 回)。 */
let contextCache: { body: string; context: WidgetNoteContext } | null = null;

/**
 * 🔴 **その箱に返してよい「同じノートのデータ」**。登録の無い箱・持ち越された箱・本文の読めないときは空。
 * ⚠ 本文は**登録した lid**から引く(箱の名乗りは使わない)。
 */
export function widgetContextFor(frame: HTMLIFrameElement): WidgetNoteContext {
  const reg = registry.get(frame);
  if (reg === undefined || !frame.isConnected || widgetLidOf(frame) !== reg.lid) return emptyWidgetNoteContext();
  const body = noteHost?.bodyOf(reg.lid) ?? null;
  if (body === null) return emptyWidgetNoteContext();
  if (contextCache === null || contextCache.body !== body) {
    contextCache = { body, context: extractWidgetNoteContext(body) };
  }
  // ⚠ 写しを返す(postMessage が複製するが、呼び手に共有の物を渡さない)
  return JSON.parse(JSON.stringify(contextCache.context)) as WidgetNoteContext;
}

function postContext(target: MessageEventSource | null, reqId: number, context: WidgetNoteContext): void {
  if (target === null) return;
  const w = target as Window;
  if (typeof w.postMessage !== 'function') return;
  try {
    w.postMessage({ type: WIDGET_CONTEXT_RES_MSG_TYPE, reqId, context }, '*');
  } catch {
    // 外れかけの箱でも落ちない
  }
}

function isStorageOp(d: Record<string, unknown>): WidgetStorageOp | null {
  if (d.op === 'set' && typeof d.key === 'string' && typeof d.value === 'string')
    return { op: 'set', key: d.key, value: d.value };
  if (d.op === 'remove' && typeof d.key === 'string') return { op: 'remove', key: d.key };
  if (d.op === 'clear') return { op: 'clear' };
  return null;
}

/**
 * 親の側の受け口を付ける(`main.ts` で 1 回)。
 * @returns 外す関数
 */
export function installWidgetBridge(targetWindow: Window = window): () => void {
  const doc = targetWindow.document;
  let observer: MutationObserver | null = null;
  let pending = false;

  const startWatching = (): void => {
    if (observer !== null || typeof MutationObserver !== 'function') return;
    const mo = new MutationObserver(() => {
      // 🔑 1 回の切り替えで属性が 2〜3 個変わる ── 1 回にまとめて送る
      if (pending) return;
      pending = true;
      setTimeout(() => {
        pending = false;
        broadcastWidgetTheme(doc);
      }, 0);
    });
    mo.observe(doc.documentElement, { attributes: true, attributeFilter: [...THEME_ATTRS] });
    observer = mo;
  };

  const handler = (event: MessageEvent): void => {
    const data: unknown = event.data;
    if (!data || typeof data !== 'object') return;
    const d = data as Record<string, unknown>;

    if (d.type === WIDGET_READY_MSG_TYPE) {
      if (typeof d.id !== 'string') return;
      // 🔴 送り主の同一性で引く(名乗りと実体が食い違えば null)
      const frame = resolveSandboxSender(doc, event.source, d.id);
      if (frame === null || !frame.hasAttribute(WIDGET_FRAME_ATTR)) return;
      startWatching();
      postTheme(frame, currentWidgetTheme(doc));
      return;
    }

    if (d.type === WIDGET_CONTEXT_REQ_MSG_TYPE) {
      const reqId = d.reqId;
      if (typeof reqId !== 'number' || !Number.isInteger(reqId)) return;
      /**
       * 🔴 送り主は 2 段で照合する ── ①`event.source === iframe.contentWindow`(`resolveSandboxSender`)
       *   ②その箱が**登録した箱**であること(`widgetContextFor`)。どちらかで外れたら**空の答え**を返す
       *   (待たせて止めない。中身は 1 字も渡さない)。
       */
      const frame = typeof d.id === 'string' ? resolveSandboxSender(doc, event.source, d.id) : null;
      if (frame === null) {
        postContext(event.source, reqId, emptyWidgetNoteContext());
        return;
      }
      postContext(frame.contentWindow, reqId, widgetContextFor(frame));
      return;
    }

    if (d.tag === WIDGET_STORAGE_MESSAGE) {
      if (event.source === null) return;
      // 🔴 **登録した箱の中から**送り主を探す(id で引かない ── 名乗りは信頼しない)
      let frame: HTMLIFrameElement | null = null;
      let reg: FrameReg | null = null;
      for (const [f, r] of registry) {
        if (f.contentWindow === event.source) {
          frame = f;
          reg = r;
          break;
        }
      }
      if (frame === null || reg === null || !frame.isConnected) return;
      const op = isStorageOp(d);
      // 🔴 器の lid が置いたときと違う(別のノートへ持ち越された箱)── 書かせない
      const lidNow = widgetLidOf(frame);
      if (op === null) return; // `quota` の合図など(箱の中で既に例外を投げている)
      // 🔑 保存先は**登録した (lid, widgetId)**。箱が載せてきた lid / id は 1 字も使わない
      const ok = lidNow === reg.lid ? applyWidgetStorageOp(reg.lid, reg.widgetId, op) : false;
      if (typeof d.seq === 'number') {
        try {
          frame.contentWindow?.postMessage({ tag: WIDGET_STORAGE_MESSAGE, op: 'ack', seq: d.seq, ok }, '*');
        } catch {
          // 外れかけの箱でも落ちない
        }
      }
      reg.onChange();
    }
  };
  targetWindow.addEventListener('message', handler);
  return () => {
    targetWindow.removeEventListener('message', handler);
    observer?.disconnect();
    observer = null;
  };
}

/**
 * ウィジェットの上のバー(親の側の UI)──「ノートへ保存」と「状態を初期化」(片道の操作を作らない ── 保存できるなら消せる)。
 *
 * - **ノートへ保存**: 端末の保存が在り、かつノートを書けるときに押せる。押すと本文の ` ```json widget-state="…" ` を
 *   書く / 差し替える(1 回だけ。履歴に残る)。
 * - **状態を初期化**: 端末の保存か本文の状態ブロックが在るときに押せる。確認してから端末の保存を消し、
 *   本文に状態ブロックが在れば**それも消す**(端末だけ消して、置き直したときに本文から古い値が戻る矛盾を作らない)。
 */
export function attachWidgetResetBar(
  host: HTMLElement,
  lid: string,
  widgetId: string,
  remount: () => void,
): { readonly sync: () => void; readonly remove: () => void } {
  const doc = host.ownerDocument;
  const bar = doc.createElement('div');
  bar.className = 'pkc-widget-bar';
  bar.setAttribute('data-pkc-field', 'widget-bar');
  const save = doc.createElement('button');
  save.type = 'button';
  save.textContent = 'ノートへ保存';
  save.setAttribute('data-pkc-variant', 'ghost');
  save.setAttribute('data-pkc-field', 'widget-save');
  const btn = doc.createElement('button');
  btn.type = 'button';
  btn.textContent = '状態を初期化';
  btn.title = 'このウィジェットに保存した状態を消して、はじめの状態に戻します';
  btn.setAttribute('data-pkc-variant', 'ghost');
  btn.setAttribute('data-pkc-field', 'widget-reset');
  const bodyHasBlock = (): boolean => {
    const body = noteHost?.bodyOf(lid) ?? null;
    return body !== null && hasWidgetStateBlock(body, widgetId);
  };
  const sync = (): void => {
    const local = hasWidgetStorage(lid, widgetId);
    const blocked = noteHost === null ? 'ノートを開き直してください' : noteHost.writeBlockReason(lid);
    save.disabled = !local || blocked !== null;
    save.title =
      blocked !== null
        ? `いまはノートに保存できません。${blocked}`
        : !local
          ? 'まだ保存する状態がありません(ウィジェットを操作すると保存できるようになります)'
          : 'ウィジェットの状態をノートの本文に書き残します(別の端末への同期や書き出した HTML でも、続きから使えます)';
    btn.disabled = !local && !bodyHasBlock();
  };
  save.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    const h = noteHost;
    if (h === null) return;
    const state = readWidgetStorage(lid, widgetId);
    if (Object.keys(state).length === 0) return;
    const json = widgetStateJson(state);
    // 🔑 断る理由は押した時点で言う(書く側 `upsertWidgetStateBlock` と同じ上限)
    if (json.length > WIDGET_STATE_BLOCK_LIMIT) {
      h.fail(widgetStateTooLargeNote(json.length));
      return;
    }
    const blocked = h.writeBlockReason(lid);
    if (blocked !== null) {
      h.fail(blocked);
      return;
    }
    blockSuppressed.delete(suppressKey(lid, widgetId));
    h.saveState(lid, widgetId, state);
  });
  btn.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    const withBlock = bodyHasBlock();
    if (withBlock) {
      const blocked = noteHost?.writeBlockReason(lid) ?? null;
      if (blocked !== null) {
        noteHost?.fail(blocked);
        return;
      }
    }
    const msg =
      `ウィジェット「${widgetId}」に保存した状態を消して、はじめの状態に戻します` +
      (withBlock ? '(ノートに保存済みの状態ブロックも削除します)' : '');
    void confirmInApp(btn, msg, {
      okLabel: '初期化する',
      danger: true,
    }).then((answer) => {
      if (answer !== 'ok') return;
      clearWidgetStorage(lid, widgetId);
      if (withBlock) {
        // ⚠ 置き直す前に印を付ける(書込が終わる前の本文から古い値を拾わない)
        blockSuppressed.add(suppressKey(lid, widgetId));
        noteHost?.removeState(lid, widgetId);
      }
      sync();
      remount();
    });
  });
  bar.append(save, btn);
  host.prepend(bar);
  sync();
  return { sync, remove: () => bar.remove() };
}

/**
 * 🔴 **箱が読み直されたときに、古い `seed` で起き上がらせない**。
 *
 * `srcdoc` には**置いたときの**保存を焼いてある。器ごと DOM から外れて戻る(編集画面から戻る等)と箱は
 * 同じ `srcdoc` で読み直されるので、そのままだと**置いた後に保存した値が消えて見える**(カウンターが 2 → 0)。
 * 2 回目以降の読み込みで、焼いた値と今の保存が違えば、今の保存で焼き直す(もう 1 回だけ読み直す)。
 */
export function keepWidgetSeedFresh(
  frame: HTMLIFrameElement,
  lid: string,
  widgetId: string,
  baked: Readonly<Record<string, string>>,
  rebuild: (seed: Readonly<Record<string, string>>) => string,
): void {
  let loads = 0;
  let bakedJson = JSON.stringify(baked);
  frame.addEventListener('load', () => {
    loads += 1;
    if (loads === 1) return;
    // 🔑 置くときと同じ優先順(端末の保存 → 本文の状態ブロック)で引き直す(PR-08)
    const now = resolveWidgetSeed(lid, widgetId);
    const nowJson = JSON.stringify(now);
    if (nowJson === bakedJson) return;
    bakedJson = nowJson;
    loads = 0;
    frame.srcdoc = rebuild(now);
  });
}

/**
 * `id=` の在る箱の部品(テーマの prelude + 保存の shim + 登録の材料)を、器から決める。
 * ⚠ lid の決まらない面では**保存しない**(箱の中ではその場限りの `localStorage` として動き、親は書かない)。
 */
export function widgetMountParts(
  host: HTMLElement,
  iframeId: string,
): {
  readonly lid: string | null;
  readonly widgetId: string | null;
  readonly prelude: string;
  readonly seed: Readonly<Record<string, string>>;
} {
  const widgetId = host.getAttribute(WIDGET_ID_ATTR);
  if (widgetId === null) return { lid: null, widgetId: null, prelude: widgetThemePreludeScript(iframeId), seed: {} };
  // 🔴 保存つきの面で描いた器だけが lid を引く(埋め込み・プレビューの器は保存しない ── 別ノートへ越境させない)
  const lid = host.getAttribute(WIDGET_LIVE_ATTR) === '1' ? widgetLidOf(host) : null;
  /**
   * 🔴 lid の決まらない面(編集中のプレビューなど)でも **shim は入れる**(中身は空・親は登録しないので保存されない)。
   * ⚠ 入れないと、`localStorage.getItem` を 1 行目に書いたウィジェットが**その場で例外で止まる**
   *   (opaque origin では読むだけで投げる ── 実ブラウザの smoke で踏んだ)。
   */
  if (lid === null) {
    // 🔑 保存しない面でも、本文の状態ブロックを初期値にする(React の器に添えた写し。PR-08)
    const seed = parseWidgetStateJson(host.getAttribute(WIDGET_SEED_ATTR) ?? '') ?? {};
    return { lid: null, widgetId, prelude: widgetPrelude(iframeId, widgetId, seed), seed };
  }
  const seed = resolveWidgetSeed(lid, widgetId);
  return { lid, widgetId, prelude: widgetPrelude(iframeId, widgetId, seed), seed };
}

/** `id=` の在る ` ```html ` の器を、見えたときに箱で埋める(`react-sandbox.ts` と同じ寿命の作法)。 */
export function hydrateWidgets(root: ParentNode | readonly ParentNode[]): MermaidScope {
  const roots: readonly ParentNode[] = Array.isArray(root) ? (root as readonly ParentNode[]) : [root as ParentNode];
  const hosts: HTMLElement[] = [];
  for (const r of roots) {
    if (r instanceof Element && r.matches(`[${WIDGET_SRC_ATTR}]`)) hosts.push(r as HTMLElement);
    hosts.push(...r.querySelectorAll<HTMLElement>(`[${WIDGET_SRC_ATTR}]`));
  }
  if (hosts.length === 0) return { dispose: () => undefined, prune: () => 0, flush: () => Promise.resolve() };

  let disposed = false;
  interface Mounted {
    frame: HTMLIFrameElement;
    loaded: Promise<void>;
    unregister: () => void;
  }
  const mounted = new Map<HTMLElement, Mounted>();
  /** 器 → 「状態を初期化」のバー(⚠ 置き直しても 1 本のまま)。 */
  const bars = new Map<HTMLElement, { sync: () => void; remove: () => void }>();
  const occurrences = new Map<string, number>();
  const occOf = new WeakMap<HTMLElement, number>();
  const timers = new Set<ReturnType<typeof setTimeout>>();

  const unmount = (host: HTMLElement, keepBar: boolean): void => {
    const m = mounted.get(host);
    if (!m) return;
    m.unregister();
    m.frame.remove();
    if (!keepBar) {
      bars.get(host)?.remove();
      bars.delete(host);
    }
    mounted.delete(host);
  };

  const place = (host: HTMLElement): void => {
    if (disposed || mounted.has(host) || !host.isConnected) return;
    const content = host.getAttribute(WIDGET_SRC_ATTR) ?? '';
    const wid = host.getAttribute(WIDGET_ID_ATTR) ?? '';
    let n = occOf.get(host);
    if (n === undefined) {
      const key = `${wid}\u0000${content}`;
      n = occurrences.get(key) ?? 0;
      occurrences.set(key, n + 1);
      occOf.set(host, n);
    }
    const iframeId = widgetFrameId('html', wid, content, n);
    const parts = widgetMountParts(host, iframeId);
    const doc = host.ownerDocument;
    const f = doc.createElement('iframe');
    f.className = 'pkc-html-render pkc-widget-frame';
    f.setAttribute('data-pkc-html-render-id', iframeId);
    f.setAttribute('sandbox', 'allow-scripts');
    f.setAttribute('referrerpolicy', 'no-referrer');
    f.setAttribute(WIDGET_FRAME_ATTR, '');
    f.title = 'ウィジェット';
    f.style.cssText = 'width:100%;border:0;height:0;display:block;';
    const ext = host.getAttribute('data-pkc-widget-ext') === '1';
    f.srcdoc = buildHtmlSandboxDoc(content, iframeId, ext, parts.prelude);
    if (parts.lid !== null && parts.widgetId !== null) {
      const wid2 = parts.widgetId;
      keepWidgetSeedFresh(f, parts.lid, wid2, parts.seed, (seed) =>
        buildHtmlSandboxDoc(content, iframeId, ext, widgetPrelude(iframeId, wid2, seed)),
      );
    }
    let bar = bars.get(host) ?? null;
    if (bar === null && parts.lid !== null && parts.widgetId !== null) {
      bar = attachWidgetResetBar(host, parts.lid, parts.widgetId, () => {
        unmount(host, true);
        place(host);
      });
      bars.set(host, bar);
    }
    bar?.sync();
    host.append(f);
    const unregister =
      parts.lid !== null && parts.widgetId !== null
        ? registerWidgetFrame(f, {
            lid: parts.lid,
            widgetId: parts.widgetId,
            onChange: () => bar?.sync(),
            remount: () => {
              unmount(host, false);
              place(host);
            },
          })
        : () => undefined;
    mounted.set(host, {
      frame: f,
      loaded: new Promise<void>((resolve) => f.addEventListener('load', () => setTimeout(resolve, 300), { once: true })),
      unregister,
    });
    restoreSandboxHeights([f]);
    host.setAttribute('data-pkc-widget-state', 'ready');
  };

  const io =
    typeof IntersectionObserver === 'function'
      ? watchVisible((host) => {
          // 🔑 打っている間は新しい箱を始めない(打鍵のたびに箱を組まない)
          const wait = typingQuietIn();
          if (wait > 0) {
            const t = setTimeout(() => {
              timers.delete(t);
              place(host);
            }, wait);
            timers.add(t);
            return;
          }
          place(host);
        })
      : null;
  for (const h of hosts) {
    if (io !== null) io.observe(h);
    else place(h);
  }

  return registerLiveScope({
    dispose() {
      disposed = true;
      io?.disconnect();
      for (const t of timers) clearTimeout(t);
      timers.clear();
      for (const h of [...mounted.keys()]) unmount(h, false);
    },
    prune() {
      for (const h of [...mounted.keys()]) if (!h.isConnected) unmount(h, false);
      return hosts.filter((h) => h.isConnected).length;
    },
    /** 印刷など:見えていない器の箱も作り、読み込みの終わりまで待つ。 */
    async flush(r: ParentNode) {
      const targets = hosts.filter((h) => r === (h as unknown as ParentNode) || r.contains(h));
      for (const h of targets) place(h);
      await Promise.all(
        targets.map((h) => {
          const done = mounted.get(h)?.loaded;
          if (!done) return Promise.resolve();
          return Promise.race([done, new Promise<void>((resolve) => setTimeout(resolve, 3000))]);
        }),
      );
    },
  });
}
