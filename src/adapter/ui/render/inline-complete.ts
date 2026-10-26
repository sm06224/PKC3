/**
 * 🔴 **打ちながら出る補完の小窓**(#1449 `/` 記法パレット / #1450 `@` ノートリンクと日付)── 面の側。
 *
 * ## 作りの決まり
 *
 * - **root で 1 か所受ける**(`input` / `keydown` / `focusout` / `pointerdown`)── 編集欄ごとに書かない。
 *   対象は本文の 3 つの欄(2 列の `editor-body` / 1 面の行 `row-source` / 追記欄 `append-input`)。
 * - **何を出すか・挿すかは呼び手が決める**(`deps.items`)── この file は「出す・選ぶ・閉じる」だけ。
 *   一覧の元は `features/markdown/inline-complete.ts` の純関数、挿すのは帯・`Ctrl+/` と同じ関数。
 * - 小窓は `position: fixed` で caret の直下(下に収まらなければ上)。
 *
 * ## ⚠ 置き換えの作法(CLAUDE.md §10)── 欄の既定の動きを奪うのは、小窓が開いている間だけ
 *
 * - `↑` `↓` で選ぶ / `Tab` で入れる / `Esc` で閉じる(閉じた引き金は、その字を消すまで出し直さない)。
 * - `Enter` で入れるのは、`/` ではいつも、`@` では **`↑` `↓` で選んだあとだけ**
 *   (文の途中の `@` のあとで改行しようとして、意図しないリンクが入る事故を防ぐ)。
 * - 日本語入力の変換中(`isComposing` / `keyCode 229`)は何もしない。変換を始めたら閉じ、終わったときに見直す。
 * - 欄が画面から消えた(ノートを替えた)・ノート切替・編集の確定で閉じる。スクロール・サイズ変更では位置を追う。
 * - 欄の外を押す・欄を離れる・caret が動く(`←` `→` `Home` `End`)・字を選ぶと閉じる。
 * - `Esc` は小窓を閉じるだけで、編集そのものは終わらせない(`stopImmediatePropagation`)。
 */
import { detectTrigger, type CompleteTrigger } from '@features/markdown/inline-complete';

export interface CompleteItem {
  readonly title: string;
  /** 右に薄く出す添え書き(種類 / 日付など)。 */
  readonly sub?: string;
  /**
   * 選ばれたときに呼ぶ。⚠ 呼ばれる時点で、欄の選択は「引き金の字〜caret」に合わせてある
   * (`insertText` で置き換えれば 1 手で戻せる)。
   */
  readonly accept: (ta: HTMLTextAreaElement, trigger: CompleteTrigger) => void;
}

export interface InlineCompleteDeps {
  items(trigger: CompleteTrigger, ta: HTMLTextAreaElement): readonly CompleteItem[];
  /**
   * 🔴 **画面の状態が変わったら閉じるための購読**(ノート切替・編集の確定など)。
   * 渡された `close` を、閉じたい変化のときに呼ぶ。外す関数を返す。
   * ⚠ 打鍵のたびに本文の状態は変わるので、**呼び側が「閉じたい変化」だけを選ぶ**。
   */
  subscribe?(close: () => void): () => void;
}

export const COMPLETE_REGION = 'inline-complete';
const FIELDS =
  'textarea[data-pkc-field="editor-body"], textarea[data-pkc-field="row-source"], textarea[data-pkc-field="append-input"]';

const MIRROR_PROPS = [
  'boxSizing', 'width', 'overflowX', 'overflowY', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth',
  'borderLeftWidth', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'fontStyle', 'fontVariant',
  'fontWeight', 'fontStretch', 'fontSize', 'fontFamily', 'lineHeight', 'letterSpacing', 'tabSize', 'textIndent',
  'textTransform', 'wordSpacing',
] as const;

/** textarea の `index` 文字目の画面上の位置(影の div に同じ字を流して測る)。 */
export function caretPoint(ta: HTMLTextAreaElement, index: number): { x: number; y: number; h: number } {
  const doc = ta.ownerDocument;
  const view = doc.defaultView;
  const cs = view?.getComputedStyle(ta);
  const mirror = doc.createElement('div');
  if (cs !== undefined) for (const p of MIRROR_PROPS) mirror.style[p as never] = (cs[p as never] ?? '') as never;
  mirror.style.position = 'absolute';
  mirror.style.visibility = 'hidden';
  mirror.style.top = '0';
  mirror.style.left = '-9999px';
  mirror.style.whiteSpace = 'pre-wrap';
  mirror.style.overflowWrap = 'break-word';
  mirror.textContent = ta.value.slice(0, index);
  const mark = doc.createElement('span');
  mark.textContent = String.fromCharCode(0x200b);
  mirror.append(mark);
  doc.body.append(mirror);
  const rect = ta.getBoundingClientRect();
  const x = rect.left + mark.offsetLeft - ta.scrollLeft + (ta.clientLeft || 0);
  const y = rect.top + mark.offsetTop - ta.scrollTop + (ta.clientTop || 0);
  const h = mark.offsetHeight || Number.parseFloat(cs?.lineHeight ?? '') || 18;
  mirror.remove();
  return { x, y, h };
}

export function bindInlineComplete(root: HTMLElement, deps: InlineCompleteDeps): () => void {
  interface Open {
    ta: HTMLTextAreaElement;
    trigger: CompleteTrigger;
    items: readonly CompleteItem[];
    index: number;
    navigated: boolean;
    el: HTMLElement;
  }
  let open: Open | null = null;
  // Esc で閉じた引き金(欄 + 位置 + そのときの語)。同じ語のまま打ち進める間は出し直さない(語が変われば出る)
  let dismissed: { ta: HTMLTextAreaElement; start: number; query: string } | null = null;

  // 🔴 スクロール・サイズ変更の聞き手は、**小窓が開いている間だけ**張る(常時 window に張らない)
  let following = false;
  const detachFollow = (): void => {
    if (!following) return;
    following = false;
    root.ownerDocument.removeEventListener('scroll', onScroll, true);
    root.ownerDocument.defaultView?.removeEventListener('resize', follow);
  };
  const attachFollow = (): void => {
    if (following) return;
    following = true;
    root.ownerDocument.addEventListener('scroll', onScroll, true);
    root.ownerDocument.defaultView?.addEventListener('resize', follow);
  };

  const close = (): void => {
    if (open !== null) open.el.remove();
    open = null;
    detachFollow();
  };

  const paint = (o: Open): void => {
    o.el.replaceChildren();
    o.items.forEach((it, i) => {
      const row = root.ownerDocument.createElement('div');
      row.setAttribute('role', 'option');
      row.setAttribute('data-pkc-field', 'inline-complete-item');
      row.setAttribute('data-pkc-index', String(i));
      row.setAttribute('aria-selected', i === o.index ? 'true' : 'false');
      const t = root.ownerDocument.createElement('span');
      t.textContent = it.title;
      row.append(t);
      if (it.sub !== undefined && it.sub !== '') {
        const s = root.ownerDocument.createElement('span');
        s.setAttribute('data-pkc-field', 'inline-complete-sub');
        s.textContent = it.sub;
        row.append(s);
      }
      o.el.append(row);
    });
    const sel = o.el.querySelector('[aria-selected="true"]');
    (sel as { scrollIntoView?: (a?: unknown) => void } | null)?.scrollIntoView?.({ block: 'nearest' });
  };

  const place = (o: Open): void => {
    const view = root.ownerDocument.defaultView;
    const at = caretPoint(o.ta, o.trigger.start);
    const vw = view?.innerWidth ?? 1024;
    const vh = view?.innerHeight ?? 768;
    const w = o.el.offsetWidth || 220;
    const h = o.el.offsetHeight || 0;
    const left = Math.max(4, Math.min(at.x, vw - w - 4));
    // 下に収まらなければ caret の上へ
    const below = at.y + at.h + 2;
    const top = below + h > vh - 4 && at.y - h - 2 > 4 ? at.y - h - 2 : below;
    o.el.style.left = `${String(Math.round(left))}px`;
    o.el.style.top = `${String(Math.round(top))}px`;
  };

  const refresh = (ta: HTMLTextAreaElement): void => {
    if (!ta.isConnected || ta.selectionStart !== ta.selectionEnd || ta.selectionStart === null) {
      close();
      return;
    }
    const trigger = detectTrigger(ta.value, ta.selectionStart);
    if (trigger === null) {
      close();
      if (dismissed !== null && dismissed.ta === ta) dismissed = null;
      return;
    }
    if (dismissed !== null && dismissed.ta === ta && dismissed.start === trigger.start) {
      // 語を消して打ち直した(短くなった / 別の語になった)なら、閉じた記憶は捨てて出し直す
      if (trigger.query.startsWith(dismissed.query) && trigger.query.length >= dismissed.query.length) {
        close();
        return;
      }
      dismissed = null;
    }
    const items = deps.items(trigger, ta);
    // 0 件なら出さない(`/usr/bin` や `@foo` を打つ手を邪魔しない)
    if (items.length === 0) {
      close();
      return;
    }
    const sameKey =
      open !== null && open.ta === ta && open.trigger.start === trigger.start && open.trigger.kind === trigger.kind;
    if (open === null || !sameKey) {
      close();
      const el = root.ownerDocument.createElement('div');
      el.setAttribute('data-pkc-region', COMPLETE_REGION);
      el.setAttribute('role', 'listbox');
      el.setAttribute('aria-label', trigger.kind === 'slash' ? '記法の候補' : 'ノートと日付の候補');
      root.append(el);
      attachFollow();
      open = { ta, trigger, items, index: 0, navigated: false, el };
    } else {
      open.trigger = trigger;
      open.items = items;
      open.index = Math.min(open.index, items.length - 1);
    }
    paint(open);
    place(open);
  };

  const accept = (o: Open, index: number): void => {
    const it = o.items[index];
    if (it === undefined) return;
    const { ta, trigger } = o;
    const caret = ta.selectionStart ?? trigger.start;
    close();
    dismissed = null;
    ta.focus();
    ta.setSelectionRange(trigger.start, caret);
    it.accept(ta, trigger);
  };

  const fieldOf = (t: EventTarget | null): HTMLTextAreaElement | null =>
    t instanceof Element ? (t.closest(FIELDS) as HTMLTextAreaElement | null) : null;

  const onInput = (ev: Event): void => {
    const ta = fieldOf(ev.target);
    if (ta === null || (ev as InputEvent).isComposing) return;
    refresh(ta);
  };
  const onCompositionEnd = (ev: Event): void => {
    const ta = fieldOf(ev.target);
    if (ta !== null) refresh(ta);
  };
  const onKeyDown = (ev: KeyboardEvent): void => {
    // 🔴 変換中の Enter / Tab / Esc は変換のもの。`isComposing` が false で来る環境(確定の keydown)は keyCode 229 で見る
    if (open === null || ev.isComposing || ev.keyCode === 229) return;
    const o = open;
    if (!o.ta.isConnected) {
      close();
      return;
    }
    if (fieldOf(ev.target) !== o.ta) return;
    const eat = (): void => {
      ev.preventDefault();
      ev.stopImmediatePropagation();
    };
    switch (ev.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        if (ev.ctrlKey || ev.metaKey || ev.altKey || ev.shiftKey) return;
        eat();
        const n = o.items.length;
        o.index = (o.index + (ev.key === 'ArrowDown' ? 1 : n - 1)) % n;
        o.navigated = true;
        paint(o);
        return;
      }
      case 'Tab':
        if (ev.ctrlKey || ev.metaKey || ev.altKey || ev.shiftKey) return;
        eat();
        accept(o, o.index);
        return;
      case 'Enter':
        if (ev.ctrlKey || ev.metaKey || ev.altKey || ev.shiftKey) return;
        // `@` は文の途中でも出る ── 選んでいない Enter は、ふつうの改行のまま通す
        if (o.trigger.kind === 'at' && !o.navigated) {
          close();
          return;
        }
        eat();
        accept(o, o.index);
        return;
      case 'Escape':
        eat();
        dismissed = { ta: o.ta, start: o.trigger.start, query: o.trigger.query };
        close();
        return;
      case 'ArrowLeft':
      case 'ArrowRight':
      case 'Home':
      case 'End':
      case 'PageUp':
      case 'PageDown':
        close();
        return;
      default:
    }
  };
  const onPointerDown = (ev: Event): void => {
    if (open === null) return;
    const t = ev.target instanceof Element ? ev.target : null;
    const row = t?.closest<HTMLElement>('[data-pkc-field="inline-complete-item"]') ?? null;
    if (row !== null && open.el.contains(row)) {
      // 欄の焦点を奪わない(奪うと caret の位置が分からなくなる)
      ev.preventDefault();
      accept(open, Number(row.getAttribute('data-pkc-index')));
      return;
    }
    if (fieldOf(ev.target) !== open.ta) close();
  };
  const onFocusOut = (ev: Event): void => {
    if (open !== null && fieldOf(ev.target) === open.ta) close();
  };

  // caret をマウスで動かしたとき ── 引き金から離れていれば閉じる
  const onClick = (ev: Event): void => {
    if (open !== null && !open.ta.isConnected) {
      close();
      return;
    }
    const ta = fieldOf(ev.target);
    if (ta !== null && open !== null) refresh(ta);
  };
  // 🔴 変換を始めたら閉じる(変換中の候補と二重に出さない)。終わったら `compositionend` が見直す
  const onCompositionStart = (): void => close();
  // 🔴 スクロール(欄の中も含む)・サイズ変更では位置を追う。欄が消えていたら閉じる
  const follow = (): void => {
    if (open === null) return;
    if (!open.ta.isConnected) {
      close();
      return;
    }
    place(open);
  };
  const onScroll = (ev: Event): void => {
    // 小窓自身の中のスクロール(候補が多いとき)では動かさない
    if (open !== null && ev.target instanceof Node && open.el.contains(ev.target)) return;
    follow();
  };
  const unsub = deps.subscribe?.(close);

  root.addEventListener('click', onClick);
  root.addEventListener('compositionstart', onCompositionStart);
  root.addEventListener('input', onInput);
  root.addEventListener('compositionend', onCompositionEnd);
  root.addEventListener('keydown', onKeyDown, true);
  root.addEventListener('pointerdown', onPointerDown, true);
  root.addEventListener('focusout', onFocusOut);
  return () => {
    root.removeEventListener('click', onClick);
    root.removeEventListener('compositionstart', onCompositionStart);
    unsub?.();
    root.removeEventListener('input', onInput);
    root.removeEventListener('compositionend', onCompositionEnd);
    root.removeEventListener('keydown', onKeyDown, true);
    root.removeEventListener('pointerdown', onPointerDown, true);
    root.removeEventListener('focusout', onFocusOut);
    close();
  };
}
