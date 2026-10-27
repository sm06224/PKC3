/**
 * 🔴 **外からファイルをドラッグして窓に入っている間だけ、ドロップできる所を細い線で示す**(#1380)。
 *
 * ⚠ Gemini 裁定「いまのまま」(画面全体の枠は本文の邪魔)を、user 指示 2026-10-26
 *   「全部やるのです」で**上書き**して入れた。だから裁定の理由(本文の邪魔にしない)は守る形にした:
 *   重ねる物・動く物を作らない。
 *
 * ## 何が起きるか
 * - デスクトップからファイルをドラッグして PKC3 の窓に入ると、左の一覧と中央のペインの**縁**に
 *   2px の強調色の線が出て、「いまドロップするとどうなるか」の 1 行が出る。
 * - 1 行の出し先は**ステータスバーが見えていればそこ**。ふだん(ready で通知なし)は
 *   ステータスバーが畳まれていて、字を足すと現れて**左と中央が縮む**ので、畳まれているときは
 *   出さずに、左の一覧の下端に `position: fixed` + `pointer-events: none` の小さなラベルで出す
 *   (`paintFileDragLabel`)。本文の上には置かない・配置は動かない。
 * - 離れる / ドロップ / Esc で捨てる / 他の操作に移る、のどれでも**必ず消える**。
 *
 * ## 守ること
 * - 線は `outline` + 負の `outline-offset` だけ(CSS は `[data-pkc-file-drag]` 条件つきの 1 組)。
 * - **内部のドラッグでは出さない**: ① `Files` が無い ② `application/x-pkc-*`(ノート・塊・タイル・カード)
 *   ③ 窓の中で始まったドラッグ(`dragstart` を拾う ── 窓内の `<img>` / リンクのドラッグは Chromium が
 *   `Files` を載せることがある)。
 * - 字は `routeFiles` と**同じ振り分け関数**(`partitionDrop`)で決める ── 字と実際の動きを食い違わせない。
 * - 状態は **root ごと**に持つ(module の大域変数にしない)。
 *
 * ## 消し忘れを作らない
 * - `dragleave` は子要素をまたぐたびに撃たれ、Chromium は `relatedTarget` を埋めないことがある
 *   → `relatedTarget` ではなく **dragenter / dragleave の数え**で「窓の中にいる間」を持つ。
 * - 数えがずれても残らないよう、`drop` / `dragend` / `Escape` / ドラッグ中は来ないはずの
 *   `mousemove`・`pointermove` でも畳む。
 */

/** 窓の中を外のファイルが通っている間、root に付く目印。 */
export const FILE_DRAG_ATTR = 'data-pkc-file-drag';
/** 畳まれたステータスバーの代わりに字を出すラベル。 */
export const FILE_DRAG_LABEL_FIELD = 'file-drag-label';

export const DROP_LINE_ATTACH = 'ドロップすると添付になります';
export const DROP_LINE_IMAGE_LINK = 'ドロップするとここに画像のリンクが入ります';
export const DROP_LINE_MIXED = 'ドロップすると画像のリンクはここに入り、それ以外は添付になります';

/**
 * 🔑 **ドロップしたファイルの振り分け**(`routeFiles` と字の決定が**同じ 1 本**を通る)。
 * 本文の欄の上なら画像は「その場に参照を差し込む」、それ以外(と本文の外の全部)は添付。
 */
export function partitionDrop<T>(
  items: readonly T[],
  inBody: boolean,
  isImage: (t: T) => boolean,
): { images: T[]; rest: T[] } {
  const images = inBody ? items.filter(isImage) : [];
  const rest = items.filter((t) => !images.includes(t));
  return { images, rest };
}

/** 「いまドロップするとどうなるか」の字。 */
export function dropLineFor(
  items: readonly { type: string }[],
  inBody: boolean,
  isImageMime: (mime: string) => boolean,
): string {
  const { images, rest } = partitionDrop(items, inBody, (it) => isImageMime(it.type));
  if (images.length === 0) return DROP_LINE_ATTACH;
  return rest.length === 0 ? DROP_LINE_IMAGE_LINK : DROP_LINE_MIXED;
}

interface HintState {
  active: boolean;
  line: string;
  readonly subs: Set<() => void>;
}
const states = new WeakMap<HTMLElement, HintState>();
const stateOf = (root: HTMLElement): HintState => {
  let s = states.get(root);
  if (s === undefined) {
    s = { active: false, line: '', subs: new Set() };
    states.set(root, s);
  }
  return s;
};

/** いま出す字(出さないときは空)。 */
export function fileDragHintLine(root: HTMLElement): string {
  const s = states.get(root);
  return s !== undefined && s.active ? s.line : '';
}

/** 状態や字が変わったら呼ばれる。戻り値で購読を外す。 */
export function subscribeFileDragHint(root: HTMLElement, cb: () => void): () => void {
  const s = stateOf(root);
  s.subs.add(cb);
  return () => {
    s.subs.delete(cb);
  };
}

const update = (root: HTMLElement, active: boolean, line: string): void => {
  const s = stateOf(root);
  if (active) root.setAttribute(FILE_DRAG_ATTR, '');
  else root.removeAttribute(FILE_DRAG_ATTR);
  if (s.active === active && s.line === line) return;
  s.active = active;
  s.line = active ? line : '';
  for (const cb of [...s.subs]) cb();
};

/** 外のファイルの荷物か(PKC の荷物を除く)。 */
export function isExternalFileDrag(ev: Event): boolean {
  const types = (ev as DragEvent).dataTransfer?.types;
  if (types === undefined || types === null) return false;
  const list = Array.from(types);
  if (!list.includes('Files')) return false;
  return !list.some((t) => t.startsWith('application/x-pkc-'));
}

export interface FileDragHintOptions {
  /** いまの入り先が「編集中の本文の欄」か(`routeFiles` の `isBodyInput` と同じ判定を渡す)。 */
  readonly overBody: (target: EventTarget | null) => boolean;
  /** 画像の MIME か(`routeFiles` の `isImageFile` と同じ規則を渡す)。 */
  readonly isImageMime: (mime: string) => boolean;
}

/** root に配線する。戻り値は後始末。 */
export function setupFileDragHint(root: HTMLElement, opts: FileDragHintOptions): () => void {
  const doc = root.ownerDocument;
  let depth = 0;
  /** 窓の中で始まったドラッグ(`<img>` / リンク / PKC の荷物)── 外のファイルではない。 */
  let internal = false;
  const end = (): void => {
    depth = 0;
    internal = false;
    update(root, false, '');
  };
  const onStart = (): void => {
    internal = true;
    depth = 0;
    update(root, false, '');
  };
  const onEnter = (ev: Event): void => {
    if (internal || !isExternalFileDrag(ev)) return;
    depth += 1;
    const dt = (ev as DragEvent).dataTransfer;
    const items = dt?.items ? Array.from(dt.items).filter((it) => it.kind === 'file') : [];
    update(root, true, dropLineFor(items, opts.overBody(ev.target), opts.isImageMime));
  };
  const onLeave = (ev: Event): void => {
    if (internal || !isExternalFileDrag(ev)) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0) update(root, false, '');
  };
  const onKey = (ev: Event): void => {
    if ((ev as KeyboardEvent).key === 'Escape') end();
  };
  const onIdleMove = (): void => {
    if (stateOf(root).active || internal) end();
  };
  // ⚠ capture: 内側の処理が止めても数えが狂わない。drop は内側が処理した後でも必ず畳む
  const types = ['dragstart', 'dragenter', 'dragleave', 'drop', 'dragend', 'keydown', 'mousemove', 'pointermove'];
  const fns: Record<string, (ev: Event) => void> = {
    dragstart: onStart,
    dragenter: onEnter,
    dragleave: onLeave,
    drop: end,
    dragend: end,
    keydown: onKey,
    mousemove: onIdleMove,
    pointermove: onIdleMove,
  };
  for (const t of types) doc.addEventListener(t, fns[t]!, true);
  return () => {
    for (const t of types) doc.removeEventListener(t, fns[t]!, true);
    end();
  };
}

/**
 * 畳まれたステータスバーの代わりのラベルを出す / 消す(`text` が空 = 消す)。
 * 左の一覧の下端に重ねる(`position: fixed` + `pointer-events: none`)。本文の上には置かない。
 */
export function paintFileDragLabel(root: HTMLElement, text: string): void {
  const doc = root.ownerDocument;
  let label = root.querySelector<HTMLElement>(`:scope > [data-pkc-field="${FILE_DRAG_LABEL_FIELD}"]`);
  if (text === '') {
    if (label !== null) label.hidden = true;
    return;
  }
  if (label === null) {
    label = doc.createElement('div');
    label.setAttribute('data-pkc-field', FILE_DRAG_LABEL_FIELD);
    label.setAttribute('aria-hidden', 'true');
    root.append(label);
  }
  label.textContent = text;
  const side = root.querySelector<HTMLElement>('[data-pkc-region="sidebar"]');
  const r = side?.getBoundingClientRect();
  const win = doc.defaultView;
  if (r !== undefined && win !== null && r.width > 0) {
    label.style.left = `${Math.round(r.left) + 8}px`;
    label.style.bottom = `${Math.max(8, Math.round(win.innerHeight - r.bottom) + 8)}px`;
    label.style.maxWidth = `${Math.max(80, Math.round(r.width) - 16)}px`;
  }
  label.hidden = false;
}
