/**
 * 🔴 **Markdown に直して貼ったあとの小さな知らせ(トースト)**(#1379。「プレーンテキストに変更」を 1 クリックで)。
 *
 * ## なぜ要るか
 *
 * 貼った字を Markdown に直す知らせは、これまでメッセージの一覧に積むだけで、**戻す道が案内文**
 * (Ctrl+Z / Ctrl+Shift+V)だけだった。一度崩れた(または直された)字を、貼った直後に **1 クリック**で
 * 書式なしの字へ置き換えられるようにする。
 *
 * ## ⚠ 置き場(CLAUDE.md §2-3)
 *
 * - 画面下のステータスバーには出さない(状態の行を一時メッセージの置き場にしない)。
 * - 文は従来どおり **システムのメッセージ**にも 1 件残る(呼び側 `leaveMessage`)。ここはその上に重なる
 *   **小さな浮き札**で、**数秒で消える**。読み返したければメッセージにある。
 * - **焦点を奪わない**(`mousedown` を止める)── 貼ったあとも本文の欄で打ち続けられる。
 *   ボタンは Tab でも届く(消える前に押せる)。
 * - 1 度に 1 つ。次の貼り付けで置き換わる。**マウスを載せている間は消えない**。
 *
 * ## 🔑 pure な DOM 部品
 *
 * 時計は差し込める(test が実時間を待たない)。何を戻すか(欄・範囲・平文)は呼び側が持つ ──
 * ここは出して・消すだけである。
 */

export const PASTE_TOAST_REGION = 'paste-toast';

const KEY = 'pkc3.paste-toast';

function readStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

/**
 * **書式つきの字を直して貼ったとき、小さな知らせ(トースト)を出すか**(#1379)。
 *
 * ⚠ **既定は出す**。切っても、貼った字を Markdown に直したことはメッセージの一覧に残る(知らせが消えるだけ)。
 * ⚠ **flag ではない**(正規設定)── 開放先は user で、畳む予定も無い。container に入れない(この端末の読み方)。
 * ⚠ 保存の値は `0`(切)だけを書く側で意味づける ── 鍵が無い / 読めない端末は「出す」。
 */
export class PasteToastStore {
  private fallback = true;
  private saveFailed = false;

  constructor(
    private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null = readStorage(),
  ) {}

  /** ⚠ 読むたびに保存を見る(書き手が複数)。🔴 保存が無い環境では控えを読む(`?.` では `catch` に入らない)。 */
  enabled(): boolean {
    if (this.storage === null || this.saveFailed) return this.fallback;
    try {
      return this.storage.getItem(KEY) !== '0';
    } catch {
      return this.fallback;
    }
  }

  setEnabled(on: boolean): void {
    this.fallback = on;
    this.saveFailed = false;
    try {
      this.storage?.setItem(KEY, on ? '1' : '0');
    } catch {
      // 🔴 書けなかった ── 次に書けるまで、読みは控え(書いた値)を返す(戻らない)
      this.saveFailed = true;
    }
  }
}

/** アプリ共有の 1 個。⚠ 読む側は必ずこれを引く。 */
export const appPasteToast = new PasteToastStore();

/** 出しておく時間(ms)。⚠ 1 文 + ボタン 1 つを読んで押せる長さ(結果の知らせの 6 秒より少し長い)。 */
export const PASTE_TOAST_VISIBLE_MS = 8000;

export interface PasteToastOptions {
  /** 知らせの 1 文。⚠ 貼った中身は入れない。 */
  readonly message: string;
  /** ボタンの字。 */
  readonly actionLabel: string;
  /**
   * ボタンを押したときの実行。**戻せなかった理由**を返すと、トーストの字をそれに替えてボタンを畳む
   * (黙って何も起きない、を作らない)。戻せたら `null`(トーストは閉じる)。
   */
  readonly onAction: () => string | null;
  readonly ttlMs?: number;
  /** test が差す時計。 */
  readonly setTimer?: (fn: () => void, ms: number) => unknown;
  readonly clearTimer?: (h: unknown) => void;
}

/** 出す。返り値は「消す」関数。 */
export function showPasteToast(host: HTMLElement, opts: PasteToastOptions): () => void {
  const doc = host.ownerDocument;
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  // 1 度に 1 つ ── 前のがあれば捨てる(時計も一緒に止まる)
  for (const old of Array.from(host.querySelectorAll(`[data-pkc-region="${PASTE_TOAST_REGION}"]`))) {
    old.dispatchEvent(new Event('pkc-toast-dismiss'));
  }

  const box = doc.createElement('div');
  box.setAttribute('data-pkc-region', PASTE_TOAST_REGION);
  box.setAttribute('role', 'status');
  box.setAttribute('aria-live', 'polite');
  const text = doc.createElement('span');
  text.setAttribute('data-pkc-field', 'paste-toast-text');
  text.textContent = opts.message;
  const btn = doc.createElement('button');
  btn.type = 'button';
  btn.setAttribute('data-pkc-field', 'paste-toast-action');
  btn.textContent = opts.actionLabel;
  // 焦点を本文の欄から奪わない(戻すとき、欄の選択範囲を使う)
  btn.addEventListener('mousedown', (ev) => ev.preventDefault());
  box.append(text, btn);
  // 🔴 入れ物(`status-stack`)の**先頭**へ ── 状態バーの真上に積む(下に回すと、状態バーの下に出る)
  host.prepend(box);

  let timer: unknown = null;
  const dismiss = (): void => {
    if (timer !== null) clearTimer(timer);
    timer = null;
    box.remove();
  };
  const arm = (): void => {
    if (timer !== null) clearTimer(timer);
    timer = setTimer(dismiss, opts.ttlMs ?? PASTE_TOAST_VISIBLE_MS);
  };
  btn.addEventListener('click', () => {
    const why = opts.onAction();
    if (why === null) {
      dismiss();
      return;
    }
    // 戻せなかった ── 理由を言い、ボタンは畳む(押しても同じ結果なので)
    text.textContent = why;
    btn.hidden = true;
    arm();
  });
  box.addEventListener('pkc-toast-dismiss', dismiss);
  // 読んでいる間は消さない
  box.addEventListener('mouseenter', () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  });
  box.addEventListener('mouseleave', arm);
  arm();
  return dismiss;
}
