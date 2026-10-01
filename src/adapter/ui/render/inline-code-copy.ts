/**
 * Markdown プレビュー内のインラインコード（`code`）ワンクリックコピー (Issue #1148).
 *
 * コマンドや識別子、設定値など、本文中のインラインコードをクリックして
 * 即座にクリップボードへコピーできるようにする。
 *
 * 規律:
 * - `pre > code` (コードブロック) は `copy-md-block` があるため対象外。
 * - `a > code` (リンク内) はリンク遷移を妨げないため対象外。
 * - テキスト選択中のクリックは誤爆防止のためコピーしない。
 * - 冪等性: 何度呼んでも二重にリスナーを張らない。
 */
import { copyPlainText } from '@adapter/platform/clipboard';
import { flashCopied } from '../actions/copy-md-block';

export const INLINE_CODE_ATTR = 'data-pkc-inline-code';
const INLINE_CODE_TITLE = 'クリックでコピー';

const KEY = 'pkc3.inline-code-copy';

function readStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

/**
 * **文中の短いコードを押すとコピーするか**(#1087)。切ると押しても何も起きず、ふつうの字として選べる。
 *
 * ⚠ **既定は入**(`missing-links` と同じ ── 入のまま配ってあった機能の**逃げ道**を足すだけで、
 *   何も選んでいない人の見え方は変えない。#1087)。
 * ⚠ **flag ではない**(正規設定)── 開放先は user で、畳む予定も無い。
 * ⚠ **container に入れない** ── ノートのデータではなく、この端末の読み方である。
 * ⚠ 保存の値は `0`(切)だけを書く側で意味づける ── 鍵が無い / 読めない端末は「入」。
 */
export class InlineCodeCopyStore {
  /** 保存が読めない環境の控え(この session では効いている)。既定は「入」。 */
  private fallback = true;

  constructor(
    private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null = readStorage(),
  ) {}

  /** ⚠ **読むたびに保存を見る**(`MissingLinksStore` と同じ理由 ── 書き手が複数)。 */
  enabled(): boolean {
    // 🔴 **保存が無い環境では控えを読む**(`?.` では `catch` に入らない)
    if (this.storage === null) return this.fallback;
    try {
      return this.storage.getItem(KEY) !== '0';
    } catch {
      return this.fallback;
    }
  }

  setEnabled(on: boolean): void {
    this.fallback = on;
    try {
      this.storage?.setItem(KEY, on ? '1' : '0');
    } catch {
      // 保存できないだけ ── この session では効いている(控えが持つ)
    }
  }
}

/** アプリ共有の 1 個。⚠ 読む側は必ずこれを引く。 */
export const appInlineCodeCopy = new InlineCodeCopyStore();

/** 付けた click の受け手(外すときに同じ物を返す)。 */
const HANDLERS = new WeakMap<HTMLElement, (ev: MouseEvent) => void>();

/**
 * プレビュー画面内のインラインコードにワンクリックコピー機能を適用する。
 */
export function applyInlineCodeCopy(root: HTMLElement): void {
  const codes = root.querySelectorAll<HTMLElement>('code');
  for (const code of codes) {
    // 既存の装飾済みならスキップ (冪等性)
    if (code.hasAttribute(INLINE_CODE_ATTR)) continue;

    // コードブロック内 (`pre > code`) は除外 (ブロック側で copy-md-block を持つ)
    if (code.closest('pre') !== null) continue;

    // リンク内 (`a > code`) は除外 (リンク遷移優先)
    if (code.closest('a') !== null) continue;

    const text = code.textContent?.trim() ?? '';
    if (text === '') continue;

    code.setAttribute(INLINE_CODE_ATTR, 'true');
    code.setAttribute('title', INLINE_CODE_TITLE);

    const onClick = (ev: MouseEvent): void => {
      // テキスト選択中(ドラッグによる文字列選択)の場合はコピーを抑止
      const selection = window.getSelection();
      if (selection && selection.toString().trim().length > 0) return;

      const raw = code.textContent ?? '';
      if (raw === '') return;

      ev.preventDefault();
      ev.stopPropagation();

      void copyPlainText(raw).then((ok) => {
        if (ok) flashCopied(code);
      });
    };
    HANDLERS.set(code, onClick);
    code.addEventListener('click', onClick);
  }
}

/**
 * 🔴 **付けたコピーの口を全部外す**(設定を切ったとき。#1087)。
 *
 * ⚠ 本文の塊は `applyBlocks` が**変わったものだけ**差し替えるので、切り替えた直後の描き直しでも
 *   既存の `<code>` は**そのまま残る** ── 受け手が付いたままだと、切ったのに押すとコピーされる。
 * ⚠ 外すのは**自分が付けた物だけ**(属性・受け手・title は自分の字のときだけ)。
 */
export function clearInlineCodeCopy(root: HTMLElement): void {
  for (const code of root.querySelectorAll<HTMLElement>(`code[${INLINE_CODE_ATTR}]`)) {
    const onClick = HANDLERS.get(code);
    if (onClick !== undefined) code.removeEventListener('click', onClick);
    HANDLERS.delete(code);
    code.removeAttribute(INLINE_CODE_ATTR);
    if (code.getAttribute('title') === INLINE_CODE_TITLE) code.removeAttribute('title');
  }
}
