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
 * 6. **ファイルの保存・読み込みの要求を確認バーへ回す**(#2097)── `id=` の無い直書きの ` ```html ` を含む全部の箱が対象。
 *    判断と画面は `widget-io-bar.ts`(純関数は `features/markdown/widget-io.ts`)。ここは受け口から渡すだけ。
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
  WIDGET_ASSET_ATTR,
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
import { buildStandaloneWidgetHtml, widgetExportFileName } from '@features/markdown/widget-export';
import { downloadBlob } from '@adapter/platform/download';
import {
  blockedWidgetPermissions,
  DEFAULT_WIDGET_PERMISSIONS,
  grantedWidgetPermissions,
  hasWidgetPermission,
  WIDGET_PERMISSION_LABELS,
  WIDGET_PERMISSION_SAFETY_NOTES,
  WIDGET_PERMISSIONS,
  widgetPermissionNoticeText,
  type WidgetPermissionSet,
} from '@features/markdown/widget-permissions';
import { appWidgetPermissions, type WidgetPermissionGate } from '@adapter/platform/widget-permission-grants';
import { confirmChecksInApp, confirmInApp } from './app-dialog';
import { watchVisible } from './visible-watch';
import { typingQuietIn } from './typing-gate';
import { registerLiveScope, type MermaidScope } from './mermaid-hydrate';
import { handleWidgetIoMessage } from './widget-io-bar';
import type { WidgetNoteAsset } from '@adapter/platform/widget-note-assets';

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
  /** 状態ブロックを消す(「状態を初期化」)。消せたら `true`、断られた・書けなかったら `false`。 */
  removeState(lid: string, widgetId: string): Promise<boolean>;
  /** 断りを知らせる。 */
  fail(message: string): void;
  /** ノートの題名(単体の HTML のファイル名・`<title>` に使う。#2090)。引けなければ `null`。 */
  titleOf?(lid: string): string | null;
  /**
   * 🔴 ウィジェットの「このノートへ添付」(#2097)── 取り込みの門(`withAssetGate`)を通る正規の添付の経路。
   * ⚠ 呼ぶのは確認バーのボタンを user が押したときだけ(箱の合図からは呼ばない)。添付の処理が走ったら `true`。
   */
  attachFile?(lid: string, file: File): Promise<boolean>;
  /** そのノートの添付(本文が使っている添付と、添付ノート自身のファイル。#2097)── 他のノートの添付は返さない。 */
  listNoteAssets?(lid: string): Promise<readonly WidgetNoteAsset[]>;
  /** 添付の中身(#2097)。⚠ 呼ぶのは `listNoteAssets` が返した鍵だけ。 */
  readAssetBlob?(key: string): Promise<Blob | null>;
}

let noteHost: WidgetNoteHost | null = null;

/**
 * 🔴 **添付 HTML ウィジェットの追加権限の台帳**(#2090 ②)。既定はアプリの台帳 ── test は差し替える。
 * ⚠ 読むのは `WIDGET_ASSET_ATTR` を持つ器だけ(本文に直書きした ` ```html ` には一切権限を付けない)。
 */
let permissionGate: WidgetPermissionGate = appWidgetPermissions;

/** 権限の台帳を差し替える(test 用。`null` でアプリの台帳へ戻す)。 */
export function setWidgetPermissionGate(gate: WidgetPermissionGate | null): void {
  permissionGate = gate ?? appWidgetPermissions;
}

/** いまの台帳(設定画面と同じ物を読む)。 */
export function widgetPermissionGate(): WidgetPermissionGate {
  return permissionGate;
}

/**
 * 🔴 **この器に効かせる権限**。添付 HTML ウィジェット(`WIDGET_ASSET_ATTR` に鍵)だけ台帳を引く ── それ以外は常に全部オフ。
 * ⚠ 判定はここ 1 か所(箱の組み立て・焼き直し・単体 HTML の保存が同じ答えを使う)。
 */
export function widgetPermissionsForHost(host: Element): WidgetPermissionSet {
  const key = host.getAttribute(WIDGET_ASSET_ATTR);
  if (key === null || key === '') return DEFAULT_WIDGET_PERMISSIONS;
  return permissionGate.get(key);
}

/** 置いた添付 HTML ウィジェットの器(鍵・置いたときの権限・置き直し)。⚠ 器が外れたら `hydrateWidgets` の寿命で消す。 */
interface AssetMount {
  readonly assetKey: string;
  readonly perms: WidgetPermissionSet;
  readonly remount: () => void;
}
const assetMounts = new Map<HTMLElement, AssetMount>();

/**
 * 鍵 → 置いたノートの題名(設定画面の一覧に名前を出すため。このタブの間だけの控え)。
 * ⚠ 台帳(`localStorage`)には名前を書かない ── 判断の記録に本文由来の字を残さない。
 */
const assetNoteTitles = new Map<string, string>();

/** 設定画面の一覧の名前(このタブで置いたことのある添付 HTML ウィジェットだけ引ける)。 */
export function widgetAssetLabel(assetKey: string): string | null {
  return assetNoteTitles.get(assetKey) ?? null;
}

const samePerms = (a: WidgetPermissionSet, b: WidgetPermissionSet): boolean =>
  a.externalScripts === b.externalScripts && a.network === b.network;

/**
 * 🔴 **権限が変わった添付 HTML ウィジェットを置き直す 1 本**(「権限」ダイアログ・設定画面の取り消しの両方が呼ぶ)。
 * @param assetKey `null` = 全部の添付 HTML ウィジェット
 * @param force 権限が変わっていなくても置き直す
 * @returns 置き直した数
 */
export function remountAssetWidgets(assetKey: string | null, force: boolean = false): number {
  let n = 0;
  for (const [host, m] of [...assetMounts]) {
    if (!host.isConnected) continue;
    if (assetKey !== null && m.assetKey !== assetKey) continue;
    if (!force && samePerms(m.perms, permissionGate.get(m.assetKey))) continue;
    m.remount();
    n += 1;
  }
  return n;
}

/** 案内帯の印。 */
export const WIDGET_PERM_NOTICE_FIELD = 'widget-perm-notice';

/**
 * 🔴 **箱が「CSP で止めた」と申告してきたときの受け口**(`main.ts` の `installHtmlSandboxBlockedReporter` が呼ぶ)。
 * 添付 HTML ウィジェットで、許せば通る権限が**まだ許されていない**ときだけ、その器に 1 行の案内帯と「権限を開く」を出す。
 * ⚠ 直書きの ` ```html ` の箱(器に鍵が無い)・登録していない箱には何も出さない(`false` を返す)。
 * @returns 案内帯を出した / 更新したら `true`
 */
export function notifyWidgetBlocked(iframe: HTMLIFrameElement, kinds: readonly string[]): boolean {
  if (!iframe.hasAttribute(WIDGET_FRAME_ATTR)) return false;
  const host = iframe.parentElement;
  if (host === null) return false;
  const m = assetMounts.get(host);
  const key = host.getAttribute(WIDGET_ASSET_ATTR);
  if (m === undefined || key === null || key === '' || m.assetKey !== key) return false;
  const now = permissionGate.get(key);
  const missing = blockedWidgetPermissions(kinds).filter((p) => !hasWidgetPermission(now, p));
  if (missing.length === 0) return false;
  const doc = host.ownerDocument;
  let notice = host.querySelector<HTMLElement>(`:scope > [data-pkc-field="${WIDGET_PERM_NOTICE_FIELD}"]`);
  if (notice === null) {
    notice = doc.createElement('div');
    notice.className = 'pkc-widget-perm-notice';
    notice.setAttribute('data-pkc-field', WIDGET_PERM_NOTICE_FIELD);
    notice.setAttribute('role', 'status');
    const text = doc.createElement('span');
    text.setAttribute('data-pkc-field', 'widget-perm-notice-text');
    const open = doc.createElement('button');
    open.type = 'button';
    open.textContent = '権限を開く';
    open.setAttribute('data-pkc-variant', 'ghost');
    open.setAttribute('data-pkc-field', 'widget-perm-notice-open');
    open.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      void openWidgetPermissionDialog(open, key);
    });
    notice.append(text, open);
    // 🔑 箱の直前(バーの下)に置く
    host.insertBefore(notice, iframe);
  }
  const prev = (notice.getAttribute('data-pkc-missing') ?? '').split(' ').filter((x) => x !== '');
  const all = WIDGET_PERMISSIONS.filter((p) => prev.includes(p) || missing.includes(p));
  notice.setAttribute('data-pkc-missing', all.join(' '));
  const text = notice.querySelector('[data-pkc-field="widget-perm-notice-text"]');
  if (text !== null) text.textContent = widgetPermissionNoticeText(all);
  return true;
}

/**
 * 🔴 **止めた申告の振り分け**(`main.ts` はこれを呼ぶだけ ── 判断を `main.ts` に書かない)。
 * 添付 HTML ウィジェットの案内帯で言えた種別は、ノート上部の一般の案内(「アプリとして登録」を勧める行)へ回さない
 * (同じ出来事を 2 か所で違う道に案内しない)。
 * @returns 一般の案内へ回す種別
 */
export function routeWidgetBlocked(iframe: HTMLIFrameElement, kinds: readonly string[]): readonly string[] {
  if (kinds.length === 0 || !notifyWidgetBlocked(iframe, kinds)) return kinds;
  return kinds.filter((k) => blockedWidgetPermissions([k]).length === 0);
}

/**
 * 🔴 **権限のダイアログ**(操作バーの「権限」・案内帯の「権限を開く」)。
 * 保存したら台帳を書き、権限が変わった同じ鍵の器をすべて置き直す(`remountAssetWidgets`)。
 * @returns 置き直した数(やめた・変わらなかったら 0)
 */
export async function openWidgetPermissionDialog(anchor: HTMLElement, assetKey: string): Promise<number> {
  if (assetKey === '') return 0;
  const gate = permissionGate;
  const now = gate.get(assetKey);
  const { answer, checked } = await confirmChecksInApp(anchor, {
    title: 'ウィジェットの権限',
    lead: 'この添付 HTML ウィジェットに許す権限を選んでください。',
    items: WIDGET_PERMISSIONS.map((p) => ({
      id: p,
      label: WIDGET_PERMISSION_LABELS[p].label,
      description: WIDGET_PERMISSION_LABELS[p].description,
      checked: hasWidgetPermission(now, p),
    })),
    notes: WIDGET_PERMISSION_SAFETY_NOTES,
    okLabel: '保存',
  });
  if (answer !== 'ok') return 0;
  for (const p of WIDGET_PERMISSIONS) {
    const want = checked[p] === true;
    if (want !== hasWidgetPermission(gate.get(assetKey), p)) gate.set(assetKey, p, want);
  }
  return remountAssetWidgets(assetKey);
}

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

/**
 * 🔴 **ファイルの入出力で「このノート」とする lid**(#2097)。箱を置いた読む面の lid(親の DOM)。
 * ⚠ 埋め込み(`[data-pkc-embed-ref]` ── 別のノートの塊)の中の箱は `null`(埋め込み先のノートの添付を見せない・書かない)。
 * 🔑 `id=` の無い直書きの ` ```html ` の箱(`iframe.pkc-html-render`)も同じ規則で引く。
 */
export function widgetIoLidOf(frame: Element): string | null {
  // 🔴 埋め込みの中なら、外のどこに lid が在っても `null`(埋め込みの中に別の lid の器が入れ子になっていても越境しない)
  if (frame.closest('[data-pkc-embed-ref]') !== null) return null;
  const host = frame.closest(`[${WIDGET_LID_ATTR}]`);
  if (host === null) return null;
  const lid = host.getAttribute(WIDGET_LID_ATTR) ?? '';
  return lid === '' ? null : lid;
}

interface FrameReg {
  readonly lid: string;
  /**
   * `id=` の在る箱だけ。`null` = 添付の HTML の `id=` 無し(#2090)── **同じノートの参照だけ**答え、保存は受けない。
   */
  readonly widgetId: string | null;
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
  // ⚠ 共有の物を返す(書き換えない)── 箱へは postMessage が複製して渡すので、ここで写しを作らない(レビュー指摘:毎回の深い写しが重い)
  return contextCache.context;
}

/**
 * 🔴 **問い合わせの流量の上限**(レビュー指摘)── 箱が `readTables()` を休みなく呼んでも、親の画面を塞がせない。
 * 1 つの箱につき {@link CONTEXT_MIN_INTERVAL_MS} に 1 回だけ答えを組んで送る。間に来た問い合わせはまとめて次の回に答え、
 * 待たせる数は {@link CONTEXT_MAX_PENDING} まで(超えた分は答えない ── 箱の側の待ち時間で空の答えになる)。
 */
export const CONTEXT_MIN_INTERVAL_MS = 100;
export const CONTEXT_MAX_PENDING = 16;
interface ContextThrottle {
  last: number;
  pending: number[];
  timer: ReturnType<typeof setTimeout> | null;
}
const throttles = new WeakMap<HTMLIFrameElement, ContextThrottle>();

function answerContext(frame: HTMLIFrameElement, reqId: number): void {
  let t = throttles.get(frame);
  if (t === undefined) {
    t = { last: -Infinity, pending: [], timer: null };
    throttles.set(frame, t);
  }
  const th = t;
  const flush = (): void => {
    th.timer = null;
    th.last = Date.now();
    const ids = th.pending.splice(0);
    if (ids.length === 0) return;
    // 🔑 答えは 1 回だけ組む(同じ回の問い合わせは同じ答え)
    const ctx = widgetContextFor(frame);
    for (const id of ids) postContext(frame.contentWindow, id, ctx);
  };
  if (th.pending.length >= CONTEXT_MAX_PENDING) return;
  th.pending.push(reqId);
  if (th.timer !== null) return;
  const wait = th.last + CONTEXT_MIN_INTERVAL_MS - Date.now();
  if (wait <= 0) flush();
  else th.timer = setTimeout(flush, wait);
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

    // 🔴 ファイルの入出力(#2097)── 全部の箱(`id=` の無い直書きの ```html も)が対象。判断は `widget-io-bar.ts`
    if (handleWidgetIoMessage(doc, event.source, d, { host: noteHost, lidOf: widgetIoLidOf })) return;

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
      answerContext(frame, reqId);
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
      // 🔴 `id=` の無い箱(添付の HTML。#2090)は保存の箱ではない ── 保存要求は黙って捨てる
      const regWidgetId = reg.widgetId;
      if (regWidgetId === null) return;
      const op = isStorageOp(d);
      // 🔴 器の lid が置いたときと違う(別のノートへ持ち越された箱)── 書かせない
      const lidNow = widgetLidOf(frame);
      if (op === null) return; // `quota` の合図など(箱の中で既に例外を投げている)
      // 🔑 保存先は**登録した (lid, widgetId)**。箱が載せてきた lid / id は 1 字も使わない
      const ok = lidNow === reg.lid ? applyWidgetStorageOp(reg.lid, regWidgetId, op) : false;
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
 * ウィジェットの上のバー(親の側の UI)──「ノートへ保存」と「状態を初期化」(片道の操作を作らない ── 保存できるなら消せる)、
 * 「HTML で保存」(#2090 ── そのウィジェットを単体の `.html` として手元へ落とす)。
 *
 * - `widgetId` が `null`(添付の HTML の `id=` 無し)のときは「HTML で保存」**だけ**の短いバーにする(状態を持たない)。
 * - `download` を渡さない呼び手(React のランタイムが読めていない等)には「HTML で保存」を出さない。
 *
 * - **ノートへ保存**: 端末の保存が在り、かつノートを書けるときに押せる。押すと本文の ` ```json widget-state="…" ` を
 *   書く / 差し替える(1 回だけ。履歴に残る)。
 * - **状態を初期化**: 端末の保存か本文の状態ブロックが在るときに押せる。確認してから端末の保存を消し、
 *   本文に状態ブロックが在れば**それも消す**(端末だけ消して、置き直したときに本文から古い値が戻る矛盾を作らない)。
 */
export function attachWidgetBar(
  host: HTMLElement,
  opts: {
    readonly lid: string;
    readonly widgetId: string | null;
    readonly remount: () => void;
    /** 「HTML で保存」を押したとき(⚠ 押した時点の状態・配色で組む)。 */
    readonly download?: () => void;
    /**
     * 添付 HTML ウィジェットの鍵(#2090 ②)── 在るときだけ「権限」を出す。
     * ⚠ 直書きの ` ```html ` には渡さない(権限の UI を出さない)。
     */
    readonly assetKey?: string | null;
  },
): { readonly sync: () => void; readonly remove: () => void } {
  const doc = host.ownerDocument;
  const bar = doc.createElement('div');
  bar.className = 'pkc-widget-bar';
  bar.setAttribute('data-pkc-field', 'widget-bar');
  const permKey = opts.assetKey ?? null;
  const perm = permKey === null || permKey === '' ? null : doc.createElement('button');
  const syncPerm = (): void => {
    if (perm === null || permKey === null) return;
    const n = grantedWidgetPermissions(permissionGate.get(permKey)).length;
    perm.textContent = n === 0 ? '権限' : `権限 (${String(n)})`;
    perm.title =
      n === 0
        ? 'このウィジェットに外部スクリプトの読み込み・外部への通信を許可します(既定はすべて止めています)'
        : `このウィジェットに許可している権限: ${grantedWidgetPermissions(permissionGate.get(permKey))
            .map((p) => WIDGET_PERMISSION_LABELS[p].label)
            .join('・')}`;
  };
  if (perm !== null && permKey !== null) {
    perm.type = 'button';
    perm.setAttribute('data-pkc-variant', 'ghost');
    perm.setAttribute('data-pkc-field', 'widget-permissions');
    perm.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      void openWidgetPermissionDialog(perm, permKey).then(() => syncPerm());
    });
    syncPerm();
  }
  const download = opts.download;
  const dl = download === undefined ? null : doc.createElement('button');
  if (dl !== null && download !== undefined) {
    dl.type = 'button';
    dl.textContent = 'HTML で保存';
    dl.title =
      opts.widgetId === null
        ? 'このウィジェットを 1 つの HTML ファイルとして保存します(ブラウザで直接開けます)'
        : 'このウィジェットを、いまの状態ごと 1 つの HTML ファイルとして保存します(ブラウザで直接開くと続きから使えます)';
    dl.setAttribute('data-pkc-variant', 'ghost');
    dl.setAttribute('data-pkc-field', 'widget-download');
    dl.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      download();
    });
  }
  const lid = opts.lid;
  const remount = opts.remount;
  const widgetId = opts.widgetId;
  if (widgetId === null) {
    // 🔑 状態を持たない箱 ── 「HTML で保存」(と、添付の HTML なら「権限」)だけ
    if (dl !== null) bar.append(dl);
    if (perm !== null) bar.append(perm);
    host.prepend(bar);
    return { sync: syncPerm, remove: () => bar.remove() };
  }
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
    syncPerm();
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
      const before = readWidgetStorage(lid, widgetId);
      clearWidgetStorage(lid, widgetId);
      const h = noteHost;
      if (withBlock && h !== null) {
        // ⚠ 置き直す前に印を付ける(書込が終わる前の本文から古い値を拾わない)
        const key = suppressKey(lid, widgetId);
        blockSuppressed.add(key);
        void h.removeState(lid, widgetId).then((ok) => {
          blockSuppressed.delete(key);
          if (ok) return;
          /**
           * 🔴 **本文から消せなかった回は、端末の保存も元に戻す**(レビュー指摘)── 端末だけ消えて本文のブロックが残ると、
           *   次に開いたときに古い値が本文から戻り、何が起きたか分からない。理由は知らせ(`OP_FAILED`)が言う。
           */
          for (const [k, v] of Object.entries(before)) applyWidgetStorageOp(lid, widgetId, { op: 'set', key: k, value: v });
          sync();
          remount();
        });
      }
      sync();
      remount();
    });
  });
  bar.append(save, btn);
  if (dl !== null) bar.append(dl);
  if (perm !== null) bar.append(perm);
  host.prepend(bar);
  sync();
  return { sync, remove: () => bar.remove() };
}

/**
 * 🔴 **単体の HTML を落とす**(#2090 ③)。押した時点の保存(端末の保存 → 本文の状態ブロックの順。`resolveWidgetSeed`)と
 * 親の配色を焼く。ObjectURL の作成と破棄は `downloadBlob` の 1 本(読み終えた頃に必ず revoke)。
 * @param build 単体の HTML の字を組む(HTML のウィジェットは `buildStandaloneWidgetHtml`、React は箱の文書から)
 */
export function downloadStandaloneWidget(
  doc: Document,
  where: { readonly lid: string | null; readonly widgetId: string | null; readonly assetKey: string | null },
  build: (args: {
    readonly title: string;
    readonly seed: Readonly<Record<string, string>>;
    readonly theme: WidgetTheme;
  }) => string,
): string {
  const { lid, widgetId, assetKey } = where;
  const seed = lid !== null && widgetId !== null ? resolveWidgetSeed(lid, widgetId) : {};
  const noteTitle = lid === null ? null : (noteHost?.titleOf?.(lid) ?? null);
  // 🔑 名前は id → ノートの題名 → 添付の鍵(添付のファイル名はここから引けない ── 題名のほうが user に読める)
  const name = widgetExportFileName({ widgetId, noteTitle: noteTitle ?? assetKey });
  const title = name.replace(/\.html$/, '');
  const html = build({ title, seed, theme: currentWidgetTheme(doc) });
  downloadBlob(name, new Blob([html], { type: 'text/html;charset=utf-8' }));
  return name;
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
  if (widgetId === null) {
    /**
     * 🔑 添付の HTML の `id=` 無し(#2090)── 器は保存つきの面(本文の読む面)でしか出ないので、器の lid を引く
     *   (同じノートの参照に答えるため。保存はしない ── shim を入れず、`pkcWidget.storage` も `null`)。
     */
    const lid = host.hasAttribute(WIDGET_ASSET_ATTR) ? widgetLidOf(host) : null;
    return { lid, widgetId: null, prelude: widgetThemePreludeScript(iframeId), seed: {} };
  }
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
    /** 添付 HTML ウィジェットの置き直し(`assetMounts` に登録した物 ── 外すときに照合する)。 */
    assetRemount: (() => void) | null;
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
    // 🔑 案内帯は置き直しで消す(権限を許して置き直したら、止まらなければもう出ない)
    host.querySelector(`:scope > [data-pkc-field="${WIDGET_PERM_NOTICE_FIELD}"]`)?.remove();
    if (assetMounts.get(host)?.remount === m.assetRemount) assetMounts.delete(host);
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
    const assetKey = host.getAttribute(WIDGET_ASSET_ATTR);
    /**
     * 🔴 **権限は添付 HTML ウィジェットだけ**(`widgetPermissionsForHost`)── 直書きの ` ```html ` は常に全部オフ。
     * ⚠ `sandbox="allow-scripts"` は権限に関係なく変えない(`allow-same-origin` は絶対に付けない)。
     */
    const perms = widgetPermissionsForHost(host);
    f.srcdoc = buildHtmlSandboxDoc(content, iframeId, ext, parts.prelude, perms);
    if (parts.lid !== null && parts.widgetId !== null) {
      const wid2 = parts.widgetId;
      // 🔴 焼き直しも**その時点の**権限を引き直す(古い権限で焼き直さない ── 取り消した後に開いた口で起き上がらせない)
      keepWidgetSeedFresh(f, parts.lid, wid2, parts.seed, (seed) =>
        buildHtmlSandboxDoc(content, iframeId, ext, widgetPrelude(iframeId, wid2, seed), widgetPermissionsForHost(host)),
      );
    }
    let bar = bars.get(host) ?? null;
    // 🔑 バーは `id=` の在る箱(保存・初期化・HTML で保存)と、添付の HTML の箱(HTML で保存だけ。#2090)に出す
    if (bar === null && parts.lid !== null && (parts.widgetId !== null || assetKey !== null)) {
      const lidForBar = parts.lid;
      const widForBar = parts.widgetId;
      bar = attachWidgetBar(host, {
        lid: lidForBar,
        widgetId: widForBar,
        remount: () => {
          unmount(host, true);
          place(host);
        },
        download: () => {
          downloadStandaloneWidget(doc, { lid: lidForBar, widgetId: widForBar, assetKey }, ({ title, seed, theme }) =>
            buildStandaloneWidgetHtml({
              content,
              title,
              widgetId: widForBar,
              seed,
              theme,
              allowExternalImages: ext,
              // 🔑 押した時点で許している権限をそのまま引き継ぐ(未許可なら厳格な CSP のまま)
              permissions: widgetPermissionsForHost(host),
            }),
          );
        },
        assetKey,
      });
      bars.set(host, bar);
    }
    bar?.sync();
    host.append(f);
    // 🔑 lid の決まった箱は登録する(`id=` 無しの添付の箱は同じノートの参照だけ。保存は受け口で断る)
    const unregister =
      parts.lid !== null
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
    let assetRemount: (() => void) | null = null;
    if (assetKey !== null && assetKey !== '') {
      const again = (): void => {
        unmount(host, true);
        place(host);
      };
      assetRemount = again;
      assetMounts.set(host, { assetKey, perms, remount: again });
      const title = parts.lid === null ? null : (noteHost?.titleOf?.(parts.lid) ?? null);
      if (title !== null && title !== '') assetNoteTitles.set(assetKey, title);
    }
    mounted.set(host, {
      frame: f,
      loaded: new Promise<void>((resolve) => f.addEventListener('load', () => setTimeout(resolve, 300), { once: true })),
      unregister,
      assetRemount,
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
