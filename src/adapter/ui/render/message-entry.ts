/**
 * 🔴 **メッセージの入口と、簡易メッセージ履歴(ポップオーバー)**(user 指示 2026-11-23。
 * 「最下段のステータスメッセージが表示されると非常に見にくい上に消すことも叶わないため邪魔。どの画面からも
 * ホバー / クリックで開ける簡易メッセージ履歴(ポップオーバー)と、詳細メッセージ画面(既存の system メッセージ集積地)で良いはず」)。
 *
 * ## 何がどこに出るか
 *
 * - **入口**: 左端の縦のバーの下の群の「メッセージ」ボタン(`collection-bar.ts` が登記)と、スマホ幅の上の帯(`phone-bar`)の同じボタン。
 *   どれも `data-pkc-field="message-entry"`。未読(注意 + 問題)の数のバッジ・警告色・保存中の点を持ち、
 *   説明(`aria-label` / `title`)に**いまの状態の言葉**(編集中 / 保存先の注意 / 複数タブ …)を連ねる。
 * - **ポップオーバー**(`popover="manual"`。上の層に出る): 「いまの状態」→ 最近のメッセージ(新しい順、最大 8 件)→
 *   「既読にする」「詳細メッセージ画面を開く」。詳細は既存の `open-messages`(実体は `openMessagesNote` 1 本)── 画面を二重に作らない。
 * - **開き方**: マウスのホバー(約 0.3 秒の間を置く。離れたら少し待って閉じる)/ クリック(固定。もう一度押すか × / Esc / 外を押すと閉じる)。
 *   指の端末ではクリックだけ。閉じたら焦点を入口へ戻す(Esc / ×)。
 *
 * ⚠ 状態の決め方は `status-line.ts` の `composeStatusModel` 1 本。ここは描くだけ(判断を持たない)。
 */
import { computePopoverPlacement } from '@features/status/popover-placement';
import { MESSAGE_KIND_LABEL, type RecentMessage } from '@features/message/message-log';
import { recoveryLine } from '@features/capture/capture-journal';
import { getTipTitle, setTipTitle } from './tooltip';
import { iconSpan } from './icons';
import { stateSummary, type StateItem } from './status-line';

export const MESSAGE_ENTRY_FIELD = 'message-entry';
export const MESSAGE_POPOVER_REGION = 'message-popover';
/** ポップオーバーに出す最近のメッセージの件数。 */
export const POPOVER_RECENT_LIMIT = 8;
/** ホバーで開くまでの間(ms)/ 離れてから閉じるまでの猶予(ms)。 */
export const HOVER_OPEN_DELAY_MS = 300;
export const HOVER_CLOSE_GRACE_MS = 250;

/** 入口とポップオーバーが読む、いまの状態(`main.ts` の `paint` が `composeStatusModel` から組んで渡す)。 */
export interface MessageStatusModel {
  /** 未読(注意 + 問題)の数。 */
  readonly unread: number;
  readonly state: readonly StateItem[];
  /** 復元できる途中の録音・録画の区間数。 */
  readonly captureRecovery: number;
  /** 版・保存先の説明(「いまの状態」の見出しの説明)。 */
  readonly detail: string;
}

/** 🔴 消えた浮き札の押し口(「元に戻す」等)。簡易履歴の「直前の操作」に残して、操作を片道にしない。 */
export interface KeptAction {
  readonly label: string;
  /** `data-pkc-*` の属性(`data-pkc-action` / `data-pkc-entry` / 日付 …)をそのまま写す。 */
  readonly attrs: Readonly<Record<string, string>>;
}

const KEPT_FIELDS: ReadonlySet<string> = new Set([
  'status-open',
  'status-copy-ref',
  'status-undo',
  'status-create-date',
  'status-rescue',
  'status-trash',
]);

/** 浮き札に出ている押し口(閉じる・バックアップ・OK を除く)を控える。⚠ 浮き札が消える**前**に呼ぶ。 */
export function snapshotKeptActions(status: ParentNode): KeptAction[] {
  const out: KeptAction[] = [];
  for (const b of Array.from(status.querySelectorAll<HTMLElement>('button[data-pkc-action]'))) {
    if (b.hidden || !KEPT_FIELDS.has(b.getAttribute('data-pkc-field') ?? '')) continue;
    const attrs: Record<string, string> = {};
    for (const a of Array.from(b.attributes)) if (a.name.startsWith('data-pkc-') && a.name !== 'data-pkc-field') attrs[a.name] = a.value;
    out.push({ label: b.textContent ?? '', attrs });
  }
  return out;
}

export type BadgeTone = 'none' | 'warn' | 'danger' | 'info';

/** バッジの字と色。⚠ 判断はここ 1 か所(入口が複数在っても同じ答え)。 */
export function entryBadge(model: MessageStatusModel): { text: string; tone: BadgeTone } {
  const severe = model.state.some((i) => i.severe);
  // 🔴 実害のある警告(閉じると消える)は、未読の数があっても赤い「!」を譲らない(数は説明に入る)── 見落とさせない
  if (severe) return { text: '!', tone: 'danger' };
  if (model.unread > 0) return { text: model.unread > 99 ? '99+' : String(model.unread), tone: 'warn' };
  if (model.captureRecovery > 0) return { text: '!', tone: 'info' };
  return { text: '', tone: 'none' };
}

/** 入口の説明(読み上げ名と `title`)。⚠ いまの状態の言葉を含める ── 帯が無くても状態が読める。 */
export function entryLabel(model: MessageStatusModel): string {
  const parts = [
    model.unread > 0 ? `未読 ${String(model.unread)} 件` : '',
    stateSummary(model.state),
    model.captureRecovery > 0 ? recoveryLine(model.captureRecovery) : '',
  ].filter((t) => t !== '');
  return parts.length === 0 ? 'メッセージ' : `メッセージ(${parts.join(' / ')})`;
}

/** 入口のボタンを 1 つ組み立てる(バッジ・保存中の点の器つき)。`collection-bar.ts` / `shell.ts`(スマホの帯)が使う。 */
export function decorateMessageEntry(btn: HTMLElement): void {
  btn.setAttribute('data-pkc-field', MESSAGE_ENTRY_FIELD);
  btn.setAttribute('aria-haspopup', 'dialog');
  btn.setAttribute('aria-expanded', 'false');
  if (btn.querySelector('[data-pkc-field="message-badge"]') === null) {
    const badge = btn.ownerDocument.createElement('span');
    badge.setAttribute('data-pkc-field', 'message-badge');
    badge.setAttribute('aria-hidden', 'true');
    badge.hidden = true;
    btn.append(badge);
  }
}

/** 入口のボタンの全部へ、バッジ・説明・保存中の点を当てる(同じ入口が左のバーと上の帯に在る)。 */
export function paintMessageEntries(root: ParentNode, model: MessageStatusModel): void {
  const badge = entryBadge(model);
  const label = entryLabel(model);
  const saving = model.state.some((i) => i.kind === 'saving');
  for (const btn of Array.from(root.querySelectorAll<HTMLElement>(`[data-pkc-field="${MESSAGE_ENTRY_FIELD}"]`))) {
    const el = btn.querySelector<HTMLElement>('[data-pkc-field="message-badge"]');
    if (el !== null) {
      if (el.textContent !== badge.text) el.textContent = badge.text;
      const hide = badge.text === '';
      if (el.hidden !== hide) el.hidden = hide;
      if (el.getAttribute('data-pkc-tone') !== badge.tone) el.setAttribute('data-pkc-tone', badge.tone);
    }
    if (btn.getAttribute('aria-label') !== label) btn.setAttribute('aria-label', label);
    if (getTipTitle(btn) !== label) setTipTitle(btn, label);
    if (saving) {
      if (!btn.hasAttribute('data-pkc-saving-dot')) btn.setAttribute('data-pkc-saving-dot', '');
    } else if (btn.hasAttribute('data-pkc-saving-dot')) btn.removeAttribute('data-pkc-saving-dot');
    // 🔴 複数タブ(このタブの保存はメインのタブ経由)は、説明だけでなく見た目の手掛かり(info 色の小さな点)も出す
    const multi = model.state.some((i) => i.kind === 'sync');
    if (multi) {
      if (!btn.hasAttribute('data-pkc-multitab')) btn.setAttribute('data-pkc-multitab', '');
    } else if (btn.hasAttribute('data-pkc-multitab')) btn.removeAttribute('data-pkc-multitab');
    const tone = badge.tone === 'none' ? null : badge.tone;
    if (tone === null) btn.removeAttribute('data-pkc-attention');
    else if (btn.getAttribute('data-pkc-attention') !== tone) btn.setAttribute('data-pkc-attention', tone);
  }
}

/** ポップオーバーの骨組みを 1 度だけ組む。⚠ 器は作り直さない(押している最中のボタンが消える)。 */
export function buildMessagePopover(
  doc: Document,
  slots: { readonly backup: HTMLElement; readonly captureRecovery: HTMLElement },
  lid: string,
): HTMLElement {
  const pop = doc.createElement('div');
  pop.setAttribute('data-pkc-region', MESSAGE_POPOVER_REGION);
  pop.setAttribute('popover', 'manual');
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', 'メッセージ');
  pop.tabIndex = -1;
  pop.hidden = true;

  const head = doc.createElement('div');
  head.setAttribute('data-pkc-field', 'popover-head');
  const title = doc.createElement('span');
  title.setAttribute('data-pkc-field', 'popover-title');
  title.textContent = 'メッセージ';
  const close = doc.createElement('button');
  close.type = 'button';
  close.setAttribute('data-pkc-action', 'close-message-popover');
  close.setAttribute('data-pkc-field', 'popover-close');
  close.setAttribute('aria-label', '閉じる');
  close.title = '閉じる(Esc)';
  close.textContent = '×';
  head.append(title, close);

  const stateSec = doc.createElement('section');
  stateSec.setAttribute('data-pkc-field', 'popover-state');
  const stateHead = doc.createElement('h3');
  stateHead.textContent = 'いまの状態';
  const stateList = doc.createElement('ul');
  stateList.setAttribute('data-pkc-field', 'popover-state-list');
  const stateActs = doc.createElement('div');
  stateActs.setAttribute('data-pkc-field', 'popover-state-actions');
  stateActs.append(slots.backup, slots.captureRecovery);
  stateSec.append(stateHead, stateList, stateActs);

  const keptSec = doc.createElement('section');
  keptSec.setAttribute('data-pkc-field', 'popover-kept');
  keptSec.hidden = true;
  const keptHead = doc.createElement('h3');
  keptHead.textContent = '直前の操作';
  const keptActs = doc.createElement('div');
  keptActs.setAttribute('data-pkc-field', 'popover-kept-actions');
  keptSec.append(keptHead, keptActs);

  const recentSec = doc.createElement('section');
  recentSec.setAttribute('data-pkc-field', 'popover-recent');
  const recentHead = doc.createElement('h3');
  recentHead.textContent = '最近のメッセージ';
  // 🔴 一覧は読み上げ領域にしない(`aria-live` を付けない)── 開いたとき・知らせが来たときに読み上げが暴れない
  const list = doc.createElement('ul');
  list.setAttribute('data-pkc-field', 'popover-list');
  recentSec.append(recentHead, list);

  const acts = doc.createElement('div');
  acts.setAttribute('data-pkc-field', 'popover-actions');
  const read = doc.createElement('button');
  read.type = 'button';
  read.setAttribute('data-pkc-action', 'mark-messages-read');
  read.setAttribute('data-pkc-field', 'popover-mark-read');
  read.textContent = '既読にする';
  const open = doc.createElement('button');
  open.type = 'button';
  open.setAttribute('data-pkc-action', 'open-messages');
  open.setAttribute('data-pkc-field', 'popover-open-detail');
  open.setAttribute('data-pkc-message-lid', lid);
  open.textContent = '詳細メッセージ画面を開く';
  acts.append(read, open);

  pop.append(head, stateSec, keptSec, recentSec, acts);
  return pop;
}

/** 見出しの時刻(`YYYY-MM-DD HH:MM:SS`)を、今日なら `HH:MM`、それ以外は `MM-DD HH:MM` にする。 */
export function shortTime(at: string, today: string): string {
  const day = at.slice(0, 10);
  const hm = at.slice(11, 16);
  return day === today ? hm : `${at.slice(5, 10)} ${hm}`;
}

function localToday(now: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${String(now.getFullYear())}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/** ポップオーバーの中身(いまの状態 / 最近のメッセージ)を書く。⚠ 開いている間と、開く直前だけ呼ぶ。 */
export function paintMessagePopover(
  pop: HTMLElement,
  model: MessageStatusModel,
  recent: readonly RecentMessage[],
  now: Date = new Date(),
  kept: readonly KeptAction[] = [],
): void {
  const doc = pop.ownerDocument;
  const stateList = pop.querySelector<HTMLElement>('[data-pkc-field="popover-state-list"]');
  if (stateList !== null) {
    stateList.replaceChildren();
    for (const item of model.state) {
      const li = doc.createElement('li');
      li.setAttribute('data-pkc-state', item.kind);
      if (item.severe) {
        const warn = doc.createElement('span');
        warn.setAttribute('data-pkc-field', 'status-warning');
        warn.textContent = item.text;
        li.append(warn);
      } else if (item.kind === 'editing') {
        const word = doc.createElement('span');
        word.setAttribute('data-pkc-field', 'status-state');
        if (item.phase !== undefined) word.setAttribute('data-pkc-phase', item.phase);
        word.textContent = item.text;
        li.append(word);
      } else {
        li.textContent = item.text;
      }
      stateList.append(li);
    }
    if (model.state.length === 0) {
      const li = doc.createElement('li');
      li.setAttribute('data-pkc-field', 'popover-state-empty');
      li.textContent = '通常どおり(注意はありません)';
      stateList.append(li);
    }
    const head = pop.querySelector<HTMLElement>('[data-pkc-field="popover-state"] > h3');
    if (head !== null) head.title = model.detail;
  }
  const keptSec = pop.querySelector<HTMLElement>('[data-pkc-field="popover-kept"]');
  const keptActs = pop.querySelector<HTMLElement>('[data-pkc-field="popover-kept-actions"]');
  if (keptSec !== null && keptActs !== null) {
    keptActs.replaceChildren();
    for (const k of kept) {
      const b = doc.createElement('button');
      b.type = 'button';
      for (const [n, v] of Object.entries(k.attrs)) b.setAttribute(n, v);
      b.textContent = k.label;
      keptActs.append(b);
    }
    keptSec.hidden = kept.length === 0;
  }
  const list = pop.querySelector<HTMLElement>('[data-pkc-field="popover-list"]');
  if (list !== null) {
    list.replaceChildren();
    const today = localToday(now);
    for (const m of recent.slice(0, POPOVER_RECENT_LIMIT)) {
      const li = doc.createElement('li');
      li.setAttribute('data-pkc-kind', m.kind);
      const kind = doc.createElement('span');
      kind.setAttribute('data-pkc-field', 'msg-kind');
      kind.textContent = MESSAGE_KIND_LABEL[m.kind];
      const time = doc.createElement('span');
      time.setAttribute('data-pkc-field', 'msg-time');
      time.textContent = shortTime(m.at, today);
      const text = doc.createElement('span');
      text.setAttribute('data-pkc-field', 'msg-text');
      text.textContent = m.text;
      li.append(kind, time, text);
      list.append(li);
    }
    if (recent.length === 0) {
      const li = doc.createElement('li');
      li.setAttribute('data-pkc-field', 'popover-empty');
      li.textContent = 'メッセージはまだありません';
      list.append(li);
    }
  }
}

export interface PopoverDeps {
  /** 最近のメッセージ(新しい順)。 */
  readonly recent?: () => readonly RecentMessage[];
  readonly openDelayMs?: number;
  readonly closeGraceMs?: number;
  /** ホバーで開いてよい端末か(既定: `(hover: hover)` かつ細かいポインタ)。 */
  readonly hoverCapable?: () => boolean;
}

export interface MessagePopoverController {
  setModel(model: MessageStatusModel): void;
  /** 消えた浮き札の押し口を「直前の操作」に残す(空 = 消す)。 */
  setKeptActions(list: readonly KeptAction[]): void;
  /** 最近のメッセージが変わった(開いていれば描き直す)。 */
  refresh(): void;
  /** クリックで開く / 閉じる(ホバーで開いていたら固定にする)。 */
  toggle(anchor: HTMLElement): void;
  close(returnFocus: boolean): void;
  isOpen(): boolean;
  dispose(): void;
}

const controllers = new WeakMap<HTMLElement, MessagePopoverController>();

/** その root に据えたポップオーバーの口(`binder.ts` の受け手が引く)。 */
export function messagePopoverController(root: HTMLElement): MessagePopoverController | null {
  return controllers.get(root) ?? null;
}

const EMPTY_MODEL: MessageStatusModel = { unread: 0, state: [], captureRecovery: 0, detail: '' };

export function installMessagePopover(root: HTMLElement, deps: PopoverDeps = {}): MessagePopoverController {
  const doc = root.ownerDocument;
  const win = doc.defaultView as Window & typeof globalThis;
  const openDelay = deps.openDelayMs ?? HOVER_OPEN_DELAY_MS;
  const closeGrace = deps.closeGraceMs ?? HOVER_CLOSE_GRACE_MS;
  const hoverCapable =
    deps.hoverCapable ??
    ((): boolean => {
      try {
        return typeof win.matchMedia === 'function' && win.matchMedia('(hover: hover) and (pointer: fine)').matches;
      } catch {
        return false;
      }
    });
  const canPopover = typeof win.HTMLElement.prototype.showPopover === 'function';
  const popOf = (): HTMLElement | null =>
    root.querySelector<HTMLElement>(`[data-pkc-region="${MESSAGE_POPOVER_REGION}"]`);

  let model = EMPTY_MODEL;
  let modelKey = '';
  let kept: readonly KeptAction[] = [];
  let keptKey = '[]';
  let anchor: HTMLElement | null = null;
  let mode: 'hover' | 'click' = 'click';
  let openTimer: ReturnType<typeof setTimeout> | null = null;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;

  const clearOpen = (): void => {
    if (openTimer !== null) clearTimeout(openTimer);
    openTimer = null;
  };
  const clearClose = (): void => {
    if (closeTimer !== null) clearTimeout(closeTimer);
    closeTimer = null;
  };
  const entries = (): HTMLElement[] =>
    Array.from(root.querySelectorAll<HTMLElement>(`[data-pkc-field="${MESSAGE_ENTRY_FIELD}"]`));
  const isOpen = (): boolean => anchor !== null;

  const place = (): void => {
    const pop = popOf();
    if (pop === null || anchor === null) return;
    const a = anchor.getBoundingClientRect();
    // 🔴 入口が見えていない(PC ↔ スマホ幅の切替で畳まれた)なら、(0,0) へ置かずに閉じる
    if (!anchor.isConnected || anchor.closest('[hidden]') !== null) {
      close(false);
      return;
    }
    pop.style.left = '0px';
    pop.style.top = '0px';
    pop.style.visibility = 'hidden';
    const r = pop.getBoundingClientRect();
    const p = computePopoverPlacement({
      anchor: a,
      size: { width: r.width, height: r.height },
      viewport: { width: win.innerWidth, height: win.innerHeight },
    });
    pop.style.left = `${String(Math.round(p.x))}px`;
    pop.style.top = `${String(Math.round(p.y))}px`;
    pop.setAttribute('data-pkc-side', p.side);
    pop.style.visibility = '';
  };

  const paintPop = (): void => {
    const pop = popOf();
    if (pop === null) return;
    paintMessagePopover(pop, model, deps.recent?.() ?? [], new Date(), kept);
    place();
  };

  const open = (target: HTMLElement, how: 'hover' | 'click'): void => {
    const pop = popOf();
    if (pop === null) return;
    clearOpen();
    clearClose();
    anchor = target;
    mode = how;
    pop.hidden = false;
    if (canPopover) {
      try {
        if (!pop.matches(':popover-open')) pop.showPopover();
      } catch {
        /* 接続前など。fixed のまま出す */
      }
    }
    for (const e of entries()) e.setAttribute('aria-expanded', e === target ? 'true' : 'false');
    paintPop();
    // 🔴 クリック(= 鍵盤の Enter も含む)で開いたときだけ焦点を中へ入れる。ホバーでは本文の欄から焦点を奪わない
    if (how === 'click') pop.focus({ preventScroll: true });
  };

  const close = (returnFocus: boolean): void => {
    clearOpen();
    clearClose();
    const pop = popOf();
    const was = anchor;
    anchor = null;
    if (pop !== null) {
      if (canPopover) {
        try {
          if (pop.matches(':popover-open')) pop.hidePopover();
        } catch {
          /* 閉じていた */
        }
      }
      pop.hidden = true;
    }
    for (const e of entries()) e.setAttribute('aria-expanded', 'false');
    if (returnFocus && was !== null && was.isConnected) was.focus({ preventScroll: true });
  };

  const entryOf = (t: EventTarget | null): HTMLElement | null =>
    t instanceof win.Element ? t.closest<HTMLElement>(`[data-pkc-field="${MESSAGE_ENTRY_FIELD}"]`) : null;
  const insidePop = (t: EventTarget | null): boolean => {
    const pop = popOf();
    return pop !== null && t instanceof win.Node && pop.contains(t);
  };

  const onOver = (ev: Event): void => {
    const pe = ev as PointerEvent;
    if (pe.pointerType === 'touch' || !hoverCapable()) return;
    const a = entryOf(ev.target);
    if (a !== null) {
      clearClose();
      if (isOpen() && anchor === a) return;
      if (openTimer === null) {
        openTimer = setTimeout(() => {
          openTimer = null;
          open(a, 'hover');
        }, openDelay);
      }
      return;
    }
    if (insidePop(ev.target)) clearClose();
  };
  const onOut = (ev: Event): void => {
    const pe = ev as PointerEvent;
    if (pe.pointerType === 'touch') return;
    const from = entryOf(ev.target);
    const fromPop = insidePop(ev.target);
    if (from === null && !fromPop) return;
    const to = (ev as MouseEvent).relatedTarget;
    // 入口 ↔ ポップオーバーの間を動いただけなら閉じない
    if (entryOf(to) !== null || insidePop(to)) return;
    clearOpen();
    if (isOpen() && mode === 'hover' && closeTimer === null) {
      closeTimer = setTimeout(() => {
        closeTimer = null;
        close(false);
      }, closeGrace);
    }
  };
  const onDown = (ev: Event): void => {
    if (!isOpen()) return;
    if (insidePop(ev.target) || entryOf(ev.target) !== null) return;
    close(false);
  };
  const onKey = (ev: Event): void => {
    const k = ev as KeyboardEvent;
    if (k.key !== 'Escape' || !isOpen()) return;
    const pop = popOf();
    const inside = pop !== null && doc.activeElement !== null && pop.contains(doc.activeElement);
    // 🔴 ホバーで開いただけ(固定していない)で、焦点が外にあるときの Esc は**飲まない** ── 編集の取り消し・ダイアログの Esc を妨げない
    //   (簡易履歴は閉じるが、Esc は背後へ伝える)。焦点が中に在る / クリックで固定したときだけ、Esc をここで使い切る
    if (mode === 'hover' && !inside) {
      close(false);
      return;
    }
    // 🔴 Esc は背後のノート選択解除などへ伝えない(native の dialog が保証していた性質)
    k.preventDefault();
    k.stopImmediatePropagation();
    close(true);
  };
  const onPopClick = (ev: Event): void => {
    const t = ev.target;
    if (!(t instanceof win.Element)) return;
    if (!insidePop(t)) return;
    const act = t.closest('[data-pkc-action]')?.getAttribute('data-pkc-action');
    if (act === undefined) return;
    // 🔴 「既読にする」(その場で結果が見える)と、閉じる(自分で閉じる。焦点を戻す)以外の押し口は、
    //   別の画面・ダイアログへ進むので、簡易履歴は役目を終える(開いた先の画面を覆わない。詳細メッセージ画面・バックアップ・録音の復元)
    if (act !== 'mark-messages-read' && act !== 'close-message-popover') close(false);
  };

  root.addEventListener('pointerover', onOver);
  root.addEventListener('pointerout', onOut);
  root.addEventListener('click', onPopClick);
  doc.addEventListener('pointerdown', onDown, true);
  doc.addEventListener('keydown', onKey, true);

  const ctrl: MessagePopoverController = {
    setModel(next) {
      // 🔴 同じ状態なら何もしない(打鍵ごとの state 変化で、開いている一覧を毎回作り直さない)
      const key = JSON.stringify(next);
      if (key === modelKey) return;
      modelKey = key;
      model = next;
      paintMessageEntries(root, model);
      if (isOpen()) paintPop();
    },
    setKeptActions(list) {
      const key = JSON.stringify(list);
      if (key === keptKey) return;
      keptKey = key;
      kept = list;
      if (isOpen()) paintPop();
    },
    refresh() {
      if (isOpen()) paintPop();
    },
    toggle(target) {
      if (isOpen() && anchor === target) {
        // ホバーで開いていたなら、クリックで固定する(閉じない)。固定していたなら閉じる
        if (mode === 'hover') {
          mode = 'click';
          clearClose();
          return;
        }
        close(true);
        return;
      }
      open(target, 'click');
    },
    close,
    isOpen,
    dispose() {
      clearOpen();
      clearClose();
      root.removeEventListener('pointerover', onOver);
      root.removeEventListener('pointerout', onOut);
      root.removeEventListener('click', onPopClick);
      doc.removeEventListener('pointerdown', onDown, true);
      doc.removeEventListener('keydown', onKey, true);
      controllers.delete(root);
    },
  };
  controllers.get(root)?.dispose();
  controllers.set(root, ctrl);
  return ctrl;
}

/** 入口のボタンに、図案(吹き出し)を足す(スマホの帯のボタンが使う)。 */
export function messageEntryIcon(): HTMLElement {
  return iconSpan('chat');
}
