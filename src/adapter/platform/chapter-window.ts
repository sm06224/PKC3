/**
 * 🔴 **章を別のウィンドウで、読むだけで開く**(#1044 段4。裁定 Q3「読むだけ」)。
 *
 * 設計: `docs/development/section-edit-design-2026-09.md` §10。
 *
 * ## 🔑 アプリをもう 1 つ起動しない ── 開いた側が中身を組む
 *
 * 添付の窓(`asset-window.ts`)・マニュアルの窓(`manual-window.ts` の段①)と同じ作法:
 * **空の窓を同期で掴み、開いた側(本体 / ノートの別ウィンドウ)が DOM を組む**。
 * 🔑 **読むだけが作りで守られる** ── この窓の中には押し所の受け手(binder)も、近道の鍵も、
 *   貼り付けや落とすの受け手も**居ない**。書く口を 1 つずつ塞ぐのではなく、
 *   **書く口がそもそも存在しない**(塞ぎ忘れが起こりようがない ── CLAUDE.md
 *   「衝突は、検出するより起こらなくするほうが強い」と同じ向き)。
 *
 * ## 🔴 中身は**開いた側の `document`** で作ってから移す
 *
 * ⚠ 別の窓の `document` が作った要素は、開いた側の `instanceof HTMLElement` を
 *   **通らない**(実ブラウザで確かめた:本体で作って移した要素は通り、窓の document が
 *   作った要素は通らない)。描画・図の後付け・`blocksInRange` は `instanceof` で見るので、
 *   窓の側で作ると**黙って何もしなくなる**。🔑 だから組むのは全部こちらの `document` で、
 *   窓の `<body>` へは**移すだけ**にする。
 *
 * ## 押せる物(§10.2)
 *
 * | 押す物 | 何が起きるか |
 * |---|---|
 * | 章の中を指すページ内リンク | 窓の中でそこへ移る(ブラウザの既定のまま) |
 * | 章の**外**を指すページ内リンク | 押せない字にする(`neutralizeOffChapterLinks`) |
 * | 外のリンク | 別のタブで開く |
 * | `CHAPTER_WINDOW_ACTIONS` の口(ノート・カード・添付・図) | **開いた側で**走らせる(`onAction`) |
 * | コード・表・図の頭の ⧉ | **取り除く**(書き出した HTML・マニュアルの窓と同じ) |
 * | それ以外の `data-pkc-action` | 属性だけ外す(押せない形にする ── 中身の字は残す) |
 * | Esc | 窓を閉じる(ノートの別ウィンドウと同じ) |
 *
 * ⚠ **pure DOM**(state も dispatch も知らない)── 判断は `chapter-windows.ts`。
 */
import BODY_CSS from 'virtual:pkc-body-css';
import type { HeadingRef } from '@features/markdown/append-target';

/** 開いた直後の大きさ。⚠ `popup` と寸法を渡さないと**別タブ**になるブラウザが在る。 */
export const CHAPTER_WINDOW_SIZE = { width: 560, height: 720 } as const;

/** 組み上がった窓の `<body>` に刻む印(F5 で白くなったかをこれで見分ける)。 */
export const CHAPTER_BUILT_ATTR = 'data-pkc-chapter-built';

/** 本文の器(`data-pkc-field`)。⚠ smoke / test はここを見る。 */
export const CHAPTER_BODY_FIELD = 'chapter-window-body';

/** 窓の頭の帯(ノートの題名と「元のウィンドウで開く」)。 */
export const CHAPTER_HEAD_FIELD = 'chapter-window-head';

/** 章の代わりに出す一文(開いています / 見つかりません / もうありません)。 */
export const CHAPTER_NOTE_FIELD = 'chapter-window-note';

/** 元のウィンドウが閉じたときに頭へ出す一文。 */
export const CHAPTER_ORPHAN_FIELD = 'chapter-window-orphan';

/**
 * 🔴 **この窓から開いた側で走らせてよい口**(§10.2)。
 *
 * 🔑 **読むだけ・よそへ移るだけ**の口に限る ── どれも本文を 1 バイトも書き換えない:
 *   ノートへのリンク / カード / 添付の持ち主へ移る / 添付を保存する / 図を保存する /
 *   絵を大きく見る。
 * ⚠ 受け手の実体は `binder.ts` の `ACTIONS`(本体で押したときと**同じ受け手**)──
 *   窓のために 2 本目を書かない(CLAUDE.md §7)。
 */
export const CHAPTER_WINDOW_ACTIONS: ReadonlySet<string> = new Set([
  'navigate-entry-ref',
  'navigate-card-ref',
  'navigate-asset-ref',
  'download-asset',
  'export-diagram',
  'view-big',
]);

/** 取り除くボタン(binder の居ない面では沈黙する飾りになる)。 */
const COPY_BUTTON = '[data-pkc-action="copy-md-block"]';

/**
 * 窓の名前。⚠ **章ごとに固定**する ── 同じ章をもう一度押すと、`window.open` が
 *   **同じ窓**を返す(2 枚目を積まない)。
 * ⚠ 見出しの字をそのまま名前に入れない(長さも字の種類も決まらない)── 字と何番目かを
 *   短い指紋に畳む。衝突しても起きるのは「別の章の窓が組み直される」だけで、
 *   書く物は無い(読むだけ)。
 */
export function chapterWindowName(lid: string, ref: HeadingRef): string {
  let h = 0x811c9dc5;
  const key = `${ref.ordinal}\u0000${ref.text}`;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `pkc3-chapter-${lid.replace(/[^A-Za-z0-9_-]/g, '')}-${(h >>> 0).toString(36)}`;
}

/**
 * 窓を**同期で**掴む。⚠ `await` より前に呼ぶこと(user の操作の続きでしか開けない)。
 *
 * 🔴 **URL は空にする**(`manual-window.ts` の実測)── `'about:blank'` を渡すと、
 *   同じ名前の窓を**navigate し直して中身が消える**。空なら既存の窓はそのまま返る。
 * @returns 開けなければ `null`(ポップアップ阻止 ── 呼び側が理由を出す)
 */
export function grabChapterWindow(
  name: string,
  open: (url: string, target: string, features: string) => Window | null = (u, t, f) =>
    globalThis.open?.(u, t, f) ?? null,
): Window | null {
  return open(
    '',
    name,
    `popup,width=${CHAPTER_WINDOW_SIZE.width},height=${CHAPTER_WINDOW_SIZE.height}`,
  );
}

/**
 * 窓の見た目。⚠ 本文の見た目は `BODY_CSS`(app.css から抜いた正本)が持つ。
 * ⚠ 地と字の色は変数で受ける ── 値は開いた側でいま効いている物を写す(`copyTokens`)。
 */
const CHROME_CSS = `
html,body{margin:0}
body{background:var(--bg,Canvas);color:var(--fg,CanvasText)}
[data-pkc-field="${CHAPTER_HEAD_FIELD}"]{position:sticky;top:0;z-index:1;display:flex;gap:8px;align-items:center;padding:6px 12px;border-bottom:1px solid var(--border,rgba(128,128,128,.35));background:var(--bg,Canvas);font-size:12px;color:var(--muted,GrayText)}
[data-pkc-field="${CHAPTER_HEAD_FIELD}"] strong{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;color:var(--fg,CanvasText)}
[data-pkc-field="${CHAPTER_HEAD_FIELD}"] button{font:inherit;color:inherit;background:transparent;border:1px solid var(--border,rgba(128,128,128,.35));border-radius:4px;padding:2px 8px;cursor:pointer}
[data-pkc-field="${CHAPTER_ORPHAN_FIELD}"]{padding:6px 12px;font-size:12px;color:var(--fg,CanvasText);background:var(--muted-bg,rgba(128,128,128,.15))}
[data-pkc-field="${CHAPTER_BODY_FIELD}"]{padding:12px 16px}
[data-pkc-field="${CHAPTER_NOTE_FIELD}"]{padding:24px 16px;color:var(--muted,GrayText)}
[data-pkc-field="${CHAPTER_BODY_FIELD}"] a:not([href]){color:inherit;text-decoration:none;cursor:default}
`;

/**
 * 開いた側でいま効いている配色の値を、窓の `:root` へ写す。
 *
 * ⚠ `BODY_CSS` だけだと明暗が OS の設定に従い、**設定で選んだ配色にならない**
 *   (マニュアルの窓がそう ── `manual-window.ts` の注記)。
 * 🔑 写すのは `BODY_CSS` が使う変数と、窓の地・字・帯に使う変数だけ。
 */
function tokenNames(): string[] {
  const names = new Set<string>(['--bg', '--fg', '--muted', '--accent', '--border', '--muted-bg']);
  for (const m of BODY_CSS.matchAll(/--[\w-]+/g)) names.add(m[0]);
  return [...names];
}

function copyTokens(to: HTMLElement): void {
  let cs: CSSStyleDeclaration;
  try {
    cs = getComputedStyle(document.documentElement);
  } catch {
    return;
  }
  for (const name of tokenNames()) {
    const v = cs.getPropertyValue(name).trim();
    if (v !== '') to.style.setProperty(name, v);
  }
  // 🔑 字の大きさと書体も写す(設定で選んだ大きさが窓にも効く)
  try {
    const body = getComputedStyle(document.body);
    if (body.fontFamily) to.style.fontFamily = body.fontFamily;
    if (body.fontSize) to.style.fontSize = body.fontSize;
  } catch {
    // 読めない環境(test の素の器)── 既定のまま
  }
}

/** 窓に出す物。 */
export type ChapterWindowContent =
  | { readonly kind: 'loading' }
  | {
      readonly kind: 'chapter';
      /** 章の塊(**開いた側の `document` で作った物**)。 */
      readonly blocks: readonly Node[];
      /** 「元のウィンドウで開く」が飛ぶ先(`entry:<lid>#h/<見出しの印>`)。 */
      readonly jumpRef: string;
    }
  | { readonly kind: 'missing' }
  | { readonly kind: 'gone' };

/** 章の代わりに出す一文。⚠ 画面の字はここ 1 か所(test も引く)。 */
export const CHAPTER_WINDOW_TEXT = {
  loading: '章を開いています…',
  missing:
    'この章が見つかりません。見出しの名前が変わったか、章が消えました。元のウィンドウの見出しから開き直してください。',
  gone: 'このノートはもうありません。',
  orphan: '元のウィンドウを閉じたため、このウィンドウの中身はもう新しくなりません。',
  jump: '元のウィンドウで開く',
  offChapter: 'この章の外を指すリンクです(元のウィンドウで見てください)',
} as const;

export interface PaintChapterWindowParts {
  /** 窓の題名(「ノート名 › 見出し」)。 */
  readonly title: string;
  /** 頭の帯に出すノートの題名。 */
  readonly noteTitle: string;
  /** 組んだことを刻む印(何でもよい ── 空でないこと)。 */
  readonly key: string;
  readonly content: ChapterWindowContent;
  /** 本文の器に当てる属性(書く向き等 ── 本体の器と同じ物)。 */
  readonly bodyAttrs?: Readonly<Record<string, string>>;
}

/**
 * 窓の中身を組み直す(**毎回まるごと**)。
 * @returns 本文の器(画像・図を後から埋めるため)。窓に触れなければ `null`
 */
export function paintChapterWindow(
  win: Window,
  parts: PaintChapterWindowParts,
): HTMLElement | null {
  let doc: Document;
  try {
    doc = win.document;
    // ⚠ 触れない窓(user が別の origin へ動かした)は、ここで投げる
    void doc.body;
  } catch {
    return null;
  }
  // ⚠ **題名は head を空にした後で入れる** ── 先に入れると `<title>` ごと消える
  //    (`manual-window.ts` の `fillManualWindow` が踏んだ順番)
  doc.head.textContent = '';
  doc.title = parts.title;
  const style = document.createElement('style');
  style.textContent = `${BODY_CSS}\n${CHROME_CSS}`;
  doc.head.append(style);
  copyTokens(doc.documentElement);
  doc.documentElement.lang = 'ja';

  const orphanWas = doc.body.querySelector(`[data-pkc-field="${CHAPTER_ORPHAN_FIELD}"]`) !== null;
  doc.body.textContent = '';
  doc.body.setAttribute(CHAPTER_BUILT_ATTR, parts.key);

  const head = document.createElement('div');
  head.setAttribute('data-pkc-field', CHAPTER_HEAD_FIELD);
  const name = document.createElement('strong');
  name.textContent = parts.noteTitle;
  head.append(name);
  if (parts.content.kind === 'chapter') {
    /**
     * 🔑 **読んでいて直したくなったら、元のウィンドウのその章へ**。
     * ⚠ 受け手はノートへのリンクと**同じ口**(`navigate-entry-ref`)── 窓のための
     *   受け手を別に書かない。
     */
    const jump = document.createElement('button');
    jump.type = 'button';
    jump.setAttribute('data-pkc-action', 'navigate-entry-ref');
    jump.setAttribute('data-pkc-entry-ref', parts.content.jumpRef);
    jump.textContent = CHAPTER_WINDOW_TEXT.jump;
    head.append(jump);
  }
  doc.body.append(head);
  if (orphanWas) doc.body.append(orphanLine());

  if (parts.content.kind !== 'chapter') {
    const note = document.createElement('p');
    note.setAttribute('data-pkc-field', CHAPTER_NOTE_FIELD);
    note.textContent = CHAPTER_WINDOW_TEXT[parts.content.kind];
    doc.body.append(note);
    return null;
  }
  const host = document.createElement('div');
  host.className = 'pkc-md-rendered';
  host.setAttribute('data-pkc-field', CHAPTER_BODY_FIELD);
  host.setAttribute('data-pkc-prose', '');
  for (const [k, v] of Object.entries(parts.bodyAttrs ?? {})) host.setAttribute(k, v);
  host.append(...parts.content.blocks);
  prepareChapterBody(host);
  doc.body.append(host);
  return host;
}

function orphanLine(): HTMLElement {
  const p = document.createElement('p');
  p.setAttribute('data-pkc-field', CHAPTER_ORPHAN_FIELD);
  p.textContent = CHAPTER_WINDOW_TEXT.orphan;
  return p;
}

/**
 * 🔴 **元のウィンドウが閉じた**ことを窓に出す(§10.3)── 追従する側が居なくなったので、
 *   黙って古くならない。⚠ 既に出ていれば足さない(冪等)。
 */
export function markChapterWindowOrphaned(win: Window): void {
  try {
    const body = win.document.body;
    if (body.querySelector(`[data-pkc-field="${CHAPTER_ORPHAN_FIELD}"]`) !== null) return;
    const head = body.querySelector(`[data-pkc-field="${CHAPTER_HEAD_FIELD}"]`);
    const line = orphanLine();
    if (head !== null) head.after(line);
    else body.prepend(line);
  } catch {
    // 触れない窓 ── 言えない
  }
}

/** その窓がいま組み上がっているか(F5 で白くなったら `false`)。 */
export function chapterWindowBuilt(win: Window): boolean {
  try {
    return win.document.body?.hasAttribute(CHAPTER_BUILT_ATTR) ?? false;
  } catch {
    return false;
  }
}

/**
 * 章の本文を「読むだけの窓」向けに整える(§10.2)。
 * ⚠ **export している**のは test がこの 1 手だけを検められるようにするため。
 */
export function prepareChapterBody(host: HTMLElement): void {
  // ① ⧉ は取り除く(書き出した HTML・マニュアルの窓と同じ ── 属性名で総なめにしない)
  for (const b of Array.from(host.querySelectorAll(COPY_BUTTON))) b.remove();
  // ② 開いた側へ送れない口は、属性だけ外す(字は残す ── 押せない形にする)
  for (const el of Array.from(host.querySelectorAll('[data-pkc-action]'))) {
    const action = el.getAttribute('data-pkc-action') ?? '';
    if (!CHAPTER_WINDOW_ACTIONS.has(action)) el.removeAttribute('data-pkc-action');
  }
  neutralizeOffChapterLinks(host);
  // ③ 外のリンクは別のタブで ── 素のままだと、この窓ごと外のページへ移ってしまう
  for (const a of Array.from(host.querySelectorAll<HTMLAnchorElement>('a[href]'))) {
    if (a.hasAttribute('data-pkc-action')) continue;
    const href = a.getAttribute('href') ?? '';
    if (href.startsWith('#')) continue;
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noopener noreferrer');
  }
}

/**
 * 🔴 **章の外を指すページ内リンクを、押せない字にする**(§10.2)。
 *
 * ⚠ `:::toc` は**全文**の見出しを並べるので、章の窓では飛び先の無い行ができる ──
 *   押しても何も起きない形を残さない。⚠ **字は残す**(何を指していたかは読める)。
 */
function neutralizeOffChapterLinks(host: HTMLElement): void {
  const ids = new Set<string>();
  for (const el of Array.from(host.querySelectorAll('[id]'))) ids.add(el.id);
  for (const a of Array.from(host.querySelectorAll<HTMLAnchorElement>('a[href^="#"]'))) {
    if (a.hasAttribute('data-pkc-action')) continue;
    let id: string;
    try {
      id = decodeURIComponent((a.getAttribute('href') ?? '').slice(1));
    } catch {
      id = (a.getAttribute('href') ?? '').slice(1);
    }
    if (id === '' || ids.has(id)) continue;
    a.removeAttribute('href');
    a.title = CHAPTER_WINDOW_TEXT.offChapter;
  }
}

/**
 * 窓の押し所を配線する(**document ごとに 1 回**)。
 *
 * ⚠ F5 で document が替わるので、組み直すたびに呼んでよい(同じ document には 2 度付けない)。
 * @param onAction `CHAPTER_WINDOW_ACTIONS` の口が押されたとき(開いた側で走らせる)
 */
export function wireChapterWindow(
  win: Window,
  onAction: (el: HTMLElement) => void,
): void {
  let doc: Document;
  try {
    doc = win.document;
  } catch {
    return;
  }
  if (wired.has(doc)) return;
  wired.add(doc);
  doc.addEventListener('click', (ev) => {
    const t = ev.target as Element | null;
    if (t === null || typeof t.closest !== 'function') return;
    const el = t.closest<HTMLElement>('[data-pkc-action]');
    if (el === null) return;
    const action = el.getAttribute('data-pkc-action') ?? '';
    if (!CHAPTER_WINDOW_ACTIONS.has(action)) return;
    ev.preventDefault();
    onAction(el);
  });
  doc.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape' || ev.defaultPrevented) return;
    try {
      win.close();
    } catch {
      // 閉じられない窓(user が自分で開いた等)── できることは無い
    }
  });
}

/** 配線済みの document(F5 で替わった document には付け直す)。 */
const wired = new WeakSet<Document>();
