/**
 * 🔴 **書庫(zip)の中を、別の窓で見て選ぶ**(#826。user 指摘 2026-09-09)。
 *
 * > 「**zipの一覧をその場の器にするのはなんで？/ 別窓にはできないの？**」
 *
 * ⚠ #818 はその場の器(`showModal()` の `<dialog>`)だけを作った ── **開いている間は
 *   本文が 1 文字も見えない**。ところが user が書庫を開く場面は
 *   「**このノートに何が要るか確かめながら選ぶ**」ときなので、いちばん見たい物が隠れる。
 * 🔑 だから別の窓を既定にする(裁定「アプリの基本は別窓」2026-09-04)。
 *   ⚠ その場の器は**消さない** ── ポップアップを止めている user の退避先である。
 *
 * ## 🔴 掴むのは同期、中身は後から
 *
 * ⚠ `window.open` は **user の操作の続き**でしか通らない(`manual-window.ts` /
 *   `launch-tile.ts` と同じ)。ところが書庫は「読む → 目録を組む」に時間がかかるので、
 *   `await` の後に開くと**ポップアップ阻止に掛かる**。
 * 🔑 だから口を 2 つに割る:**`grabArchiveWindow`(同期・押した瞬間)→ 待つ →
 *   `pickInArchiveWindow`(組んで選ばせる)**。
 * ⚠ 待っている間の窓は**白紙にしない**(「読んでいます…」を先に出す)。
 *
 * ## ⚠ その場の器が「ついでに」やっていた 3 つ(#10 置き換えの作法)
 *
 * | `<dialog>` がやっていたこと | ここでどうするか |
 * |---|---|
 * | 周りを止める | **止めない** ── それが目的である(本文を見ながら選べる) |
 * | 2 つ目が重ならない | 🔑 **窓の名前を書庫ごとに固定**する ── 2 回押しても同じ窓が前へ出る |
 * | 閉じたら焦点を返す | 呼び側が押し所へ戻す(この module は窓しか知らない) |
 *
 * ⚠ 配色は**写す**(`--bg` / `--fg` / `--muted` / `--accent`)── ここに色の表を持つと、
 *   配色を足した日にこの窓だけ古くなる(`theme.ts` の `syncThemeColor` と同じ作法)。
 */
import { waitForWindowClose } from './window-close';

/** 一覧に出す 1 行。⚠ 何が並ぶかは `features/archive/zip-browse.ts` が決める。 */
export interface ArchiveWindowRow {
  readonly path: string;
  readonly name: string;
  readonly depth: number;
  readonly isDirectory: boolean;
  /** 大きさの字(フォルダは空)。⚠ 綴りは `human-bytes` の 1 本から来る。 */
  readonly size: string;
}

/** 開いた直後の大きさ。⚠ `popup` と寸法を渡さないと**別タブ**になるブラウザが在る。 */
const SIZE = { width: 560, height: 720 };

/**
 * 🔴 **その窓がいま何の書庫を映しているか**(#826 の着地前レビュー、動線側の欠陥 2)。
 *
 * ⚠ これが無いと、**2 回目に押すたび一覧を組み直す** ── user が付けた印が全部消える。
 *   ⚠ user が 2 回目を押す動機は「窓が後ろに隠れて見つからない」であって、
 *   「選び直したい」ではない(PKC の中から窓へ戻る道はこれしか無い)。
 * 🔑 `manual-window.ts` の `MANUAL_BUILT_ATTR` と同じ作法 ── 既に組んであるなら
 *   **触らずに前へ出すだけ**にする。
 */
export const ARCHIVE_BUILT_ATTR = 'data-pkc-archive-built';

/** 写す色。⚠ 読めない環境(test の素の器)では**空**になり、下の既定に落ちる。 */
const TOKENS = ['--bg', '--fg', '--muted', '--accent'] as const;

/**
 * 窓の名前。⚠ **書庫ごとに固定**する ── 同じ書庫を 2 回押しても 2 枚目を積まない。
 * 🔴 **書庫ごとに違う名前にする** ── 同じ名前にすると、2 つ目の書庫が 1 つ目の窓を
 *   乗っ取る(1 つ目の一覧と印が消え、待っていた呼び側が宙に浮く)。
 * ⚠ 念のため名前に使えない字を落とすが、**いまの鍵では 1 文字も落ちない**
 *   (`asset-key.ts` は `ast-` + hex / base36)── 鍵の綴りが変わった日の保険である。
 *   ⚠ 直す前は「鍵は base64 系なので `/` や `+` が来る」と書いてあったが、**事実と逆**だった。
 */
export function archiveWindowName(assetKey: string): string {
  return `pkc3-archive-${assetKey.replace(/[^A-Za-z0-9_-]/g, '')}`;
}

/** 掴んだ窓。⚠ `reused` = **もう同じ書庫の一覧が組んである**(組み直さない)。 */
export interface GrabbedArchiveWindow {
  readonly win: Window;
  readonly reused: boolean;
}

/**
 * 窓を**同期で**掴む。⚠ `await` より前に呼ぶこと。
 * @returns 掴めなければ `null`(呼び側がその場の器へ落ちる)
 */
export function grabArchiveWindow(
  title: string,
  assetKey: string,
  open: (url: string, name: string, features: string) => Window | null,
): GrabbedArchiveWindow | null {
  /**
   * 🔴 **URL は空にする ── `'about:blank'` を渡してはいけない**(`manual-window.ts` が
   *   2026-08-31 に実測した表。着地前レビュー 2026-09-09 が、こちらへ写し忘れているのを拾った)。
   *
   * ⚠ 名前つきの窓に `'about:blank'` を渡すと、**その窓を navigate し直す** ──
   *   つまり **2 回目に押すたび、組んだ一覧と付けた印が丸ごと消える**。
   * 🔑 空の URL は「**navigate しない**」の意である(HTML 仕様)。新しく開くときは
   *   どのみち `about:blank` になるので、失うものは無い。
   * ⚠ この file の冒頭は「`manual-window.ts` と同じ作法」と書いてあるのに、
   *   **いちばん高くついた 1 点だけ写していなかった** ── 名指しで引くときは、
   *   その file が**なぜそう書いているか**まで読む。
   */
  const win = open('', archiveWindowName(assetKey), `popup,width=${SIZE.width},height=${SIZE.height}`);
  /**
   * ⚠ **これを外しても答えは変わらない**(変異試験 A1 が SURVIVED で教えた)──
   *   下の `catch` が `null.document` の例外を飲み、`return win` が同じ `null` を返す。
   * 🔑 それでも置くのは、**塞がれた回に例外を作らない**ためである
   *   (ポップアップ阻止は「普通に起きること」で、異常ではない)。
   *   ⚠ 「これが無いと壊れる」とは書かない ── 実際は壊れない。
   */
  if (win === null) return null;
  /**
   * 🔴 **2 回目は前へ出す**(`manual-window.ts` の `bringToFront` と同じ)。
   * ⚠ 名前が同じなので `window.open` は**同じ窓を返す**が、それだけでは
   *   後ろに居たままのことが在る ── お知らせとマニュアルに「その窓が前に出ます」と
   *   書いた以上、**書いたことが起きる**ようにする(#649 レビュー②と同じ型)。
   */
  try {
    win.focus();
  } catch {
    // 前へ出せない環境が在る ── 開いてはいるので、黙ってよい
  }
  try {
    /**
     * 🔑 **同じ書庫が既に組んであるなら、触らない**(印も並びも読んでいた所も残す)。
     * ⚠ 判定は**印 1 つ**でよい ── 印を付けるのは一覧を組み終えた所  1 か所だけである。
     */
    if (win.document.documentElement.getAttribute(ARCHIVE_BUILT_ATTR) === assetKey) {
      return { win, reused: true };
    }
    win.document.title = `${title} の中`;
    win.document.body.textContent = '';
    const p = win.document.createElement('p');
    p.setAttribute('data-pkc-field', 'archive-window-wait');
    // ⚠ 白紙にしない ── 掴んだだけの窓は「壊れている」に見える
    p.textContent = '書庫を読んでいます…';
    win.document.body.append(p);
  } catch {
    // 組めなくても窓は掴めている ── 中身は次の段で入れ直す
  }
  return { win, reused: false };
}

/**
 * 🔴 **読めなかった理由を、窓の中に出す**(着地前レビュー 欠陥 3)。
 *
 * ⚠ 直す前は窓を**黙って閉じて**、理由は主の窓の下の 1 行に出していた ── ところが
 *   user は**開いた窓のほうを見ている**(前へ出したのだから当然である)ので、
 *   目の前の窓が消えて「窓が壊れた」と読む。理由は**見ている面**に出す。
 * ⚠ 閉じるのは user に任せる(勝手に閉じない ── 読む前に消えるのが元の問題である)。
 */
export function showArchiveWindowError(win: Window, title: string, text: string): void {
  const doc = win.document;
  if (win.closed || doc.body === null) return;
  doc.body.textContent = '';
  const h = doc.createElement('p');
  h.setAttribute('data-pkc-field', 'archive-window-title');
  h.textContent = title;
  const p = doc.createElement('p');
  p.setAttribute('data-pkc-field', 'archive-window-error');
  p.textContent = text;
  const foot = doc.createElement('div');
  foot.setAttribute('data-pkc-field', 'archive-window-foot');
  const close = doc.createElement('button');
  close.type = 'button';
  close.setAttribute('data-pkc-field', 'archive-window-close');
  close.textContent = '閉じる';
  close.addEventListener('click', () => {
    try {
      win.close();
    } catch {
      // 既に閉じている
    }
  });
  foot.append(close);
  doc.body.append(h, p, foot);
  // ⚠ **組んだ印は消す** ── 次に押したときは読み直す(理由の画面を「一覧」と読まない)
  doc.documentElement.removeAttribute(ARCHIVE_BUILT_ATTR);
  close.focus();
}

export interface ArchivePickDeps {
  /** 🔴 **どの書庫か**(組み終えた印に使う ── 2 回目に組み直さないため)。 */
  readonly assetKey: string;
  /** 窓の上に出す名前。⚠ 題名バーだけだと、窓を 2 枚開いたとき中身で見分けられない。 */
  readonly title: string;
  readonly rows: readonly ArchiveWindowRow[];
  /** 印から「実際に取り出す file の数」を数える(呼び側の 1 本)。 */
  readonly countFiles: (marks: readonly string[]) => number;
  /** 印を付け外しする(呼び側の 1 本 ── ここで数え直さない)。 */
  readonly toggle: (marks: readonly string[], path: string) => string[];
  /**
   * 🔴 **配色を写す元**(いまの PKC の根)。⚠ **省略できない** ── 省略できるようにすると、
   *   呼び側が渡し忘れた日に**この窓だけ配色が戻る**(§7「optional にすると門ごと消える」)。
   */
  readonly themeFrom: HTMLElement;
  /** 窓が閉じるのを待つ口。⚠ test が差す(既定は poll)。 */
  readonly waitClose?: (win: Window) => Promise<void>;
}

/** 根から `--bg` などを読んで写す。⚠ 読めなければ既定(OS 追従)に落ちる。 */
function colorsOf(root: HTMLElement): string {
  const view = root.ownerDocument.defaultView;
  const got: string[] = [];
  if (view !== null) {
    const cs = view.getComputedStyle(root);
    for (const t of TOKENS) {
      const v = cs.getPropertyValue(t).trim();
      if (v !== '') got.push(`${t}:${v}`);
    }
  }
  return got.join(';');
}

/**
 * 掴んだ窓に一覧を組んで、選ばれるまで待つ。
 * @returns 選んだ path。⚠ 「やめる」/ 窓を閉じた / 0 件なら `null`
 */
export function pickInArchiveWindow(win: Window, deps: ArchivePickDeps): Promise<string[] | null> {
  const doc = win.document;
  const waitClose = deps.waitClose ?? ((w) => waitForWindowClose(w));
  /**
   * 🔴 **読んでいる間に閉じられていることがある**(大きい書庫ほど起きる)。
   * ⚠ そのまま組みにいくと `doc.body` が無くて落ち、**呼び側の Promise が
   *   誰にも掴まれない例外で終わる**(押した人には何も出ない)。
   * 🔑 閉じていたら「やめた」と同じ答えを返す ── 実際 user はやめたのである。
   */
  if (win.closed || doc.body === null) return Promise.resolve(null);
  doc.body.textContent = '';

  const style = doc.createElement('style');
  style.textContent =
    `:root{color-scheme:light dark;${colorsOf(deps.themeFrom)}}` +
    'body{margin:0;font:14px system-ui,sans-serif;background:var(--bg,Canvas);' +
    'color:var(--fg,CanvasText);display:flex;flex-direction:column;height:100vh}' +
    '[data-pkc-field="archive-window-title"]{margin:0;padding:10px 12px 0;font-weight:600}' +
    '[data-pkc-field="archive-window-note"]{margin:0;padding:4px 12px 8px;' +
    'color:var(--muted,GrayText)}' +
    '[data-pkc-field="archive-window-list"]{flex:1;overflow:auto;padding:0 8px}' +
    '[data-pkc-field="archive-window-row"]{display:block;width:100%;text-align:start;' +
    'font:inherit;color:inherit;background:none;border:0;padding:6px 8px;cursor:pointer;' +
    'border-radius:6px}' +
    '[data-pkc-field="archive-window-row"][aria-pressed="true"]{' +
    'background:var(--accent,Highlight);color:var(--bg,Canvas)}' +
    '[data-pkc-field="archive-window-foot"]{display:flex;gap:8px;justify-content:flex-end;' +
    'padding:8px 12px;border-top:1px solid var(--muted,GrayText)}' +
    '[data-pkc-field="archive-window-foot"] button{font:inherit;padding:6px 14px;' +
    'cursor:pointer}';
  doc.head.append(style);

  /**
   * 🔑 **何の書庫かを窓の中にも出す**(着地前レビュー 良 1)── 題名バーだけだと、
   *   2 つの書庫を並べて開いたとき**中身で見分けられない**。
   */
  const head = doc.createElement('p');
  head.setAttribute('data-pkc-field', 'archive-window-title');
  head.textContent = deps.title;
  const note = doc.createElement('p');
  note.setAttribute('data-pkc-field', 'archive-window-note');
  note.textContent = 'フォルダを押すと、その下のファイルが全部入ります';
  const list = doc.createElement('div');
  list.setAttribute('data-pkc-field', 'archive-window-list');
  const foot = doc.createElement('div');
  foot.setAttribute('data-pkc-field', 'archive-window-foot');
  const cancel = doc.createElement('button');
  cancel.type = 'button';
  cancel.setAttribute('data-pkc-field', 'archive-window-cancel');
  cancel.textContent = 'やめる';
  const ok = doc.createElement('button');
  ok.type = 'button';
  ok.setAttribute('data-pkc-field', 'archive-window-ok');
  foot.append(cancel, ok);
  doc.body.append(head, note, list, foot);

  let marks: string[] = [];
  let focusPath: string | null = null;

  const paint = (): void => {
    list.textContent = '';
    for (const [index, row] of deps.rows.entries()) {
      const btn = doc.createElement('button');
      btn.type = 'button';
      btn.setAttribute('data-pkc-field', 'archive-window-row');
      btn.setAttribute('data-pkc-archive-index', String(index));
      btn.setAttribute('aria-pressed', marks.includes(row.path) ? 'true' : 'false');
      // ⚠ 器(`app-dialog.ts`)は `depth * 16` ── こちらは窓の縁から 8px 内側に置くので
      //    その分を足す(**同じ規則の別の器**であって、階層の刻みは同じ 16px である)
      btn.style.paddingInlineStart = `${8 + row.depth * 16}px`;
      // ⚠ フォルダの印は末尾の `/`(絵文字を UI に置かない ── `icons.test.ts`)
      btn.textContent = row.isDirectory ? `${row.name}/` : `${row.name} — ${row.size}`;
      btn.addEventListener('click', () => {
        marks = deps.toggle(marks, row.path);
        focusPath = row.path;
        paint();
      });
      list.append(btn);
    }
    const n = deps.countFiles(marks);
    ok.textContent = n === 0 ? '取り出す' : `選んだ ${n} 件を取り出す`;
    // ⚠ **0 件では押せない** ── 押しても何も起きない口を作らない
    ok.disabled = n === 0;
    if (focusPath !== null) {
      const back = deps.rows.findIndex((r) => r.path === focusPath);
      list.querySelector<HTMLButtonElement>(`[data-pkc-archive-index="${back}"]`)?.focus();
    }
  };
  paint();
  list.querySelector<HTMLButtonElement>('[data-pkc-archive-index="0"]')?.focus();
  /**
   * 🔴 **組み終えた印**(2 回目に押しても組み直さない ── 印と並びが残る)。
   * ⚠ 付けるのは**組み終えてから** ── 途中で落ちた回に「組んである」と言わない。
   */
  doc.documentElement.setAttribute(ARCHIVE_BUILT_ATTR, deps.assetKey);

  return new Promise<string[] | null>((resolve) => {
    let done = false;
    /**
     * ⚠ **答えは 1 度だけ**。⚠ そして**必ず窓を閉じる** ── 閉じないと、
     *   取り出した後も選び手が残って「もう 1 度取り出せる」ように見える。
     */
    const settle = (answer: string[] | null): void => {
      if (done) return;
      done = true;
      resolve(answer);
      try {
        win.close();
      } catch {
        // 既に閉じている
      }
    };
    ok.addEventListener('click', () => {
      settle(deps.countFiles(marks) > 0 ? [...marks] : null);
    });
    cancel.addEventListener('click', () => settle(null));
    /**
     * 🔴 **`Esc` で「やめる」**(着地前レビュー 欠陥 4)。
     * ⚠ その場の器は native の `<dialog>` なので `Esc` で閉じる ── 同じ「書庫の中を
     *   選ぶ」が、開く場所によって `Esc` の効き方が変わってはいけない
     *   (マニュアルは `Esc` を**アプリ全体の作法**として教えている)。
     */
    doc.addEventListener('keydown', (ev) => {
      if ((ev as KeyboardEvent).key === 'Escape') settle(null);
    });
    // 🔑 窓ごと閉じられた回も答えを返す(呼び側が永久に待たない)
    void waitClose(win).then(
      () => settle(null),
      () => settle(null),
    );
  });
}
