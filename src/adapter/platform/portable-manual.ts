/**
 * 🔴 **持ち歩ける 1 枚(portable)に焼き込んだマニュアルの page を、`blob:` URL で開く**
 * (#648 段③。user 裁定 2026-09-04「全部推薦で」)。
 *
 * ## なぜ要るのか
 *
 * 段②の窓は隣の `manual.html` へ移るが、持ち歩ける 1 枚には**隣が無い**(1 個の HTML で
 * 完結している)。だから段①の `about:blank` に組む経路へ落ちていて、**F5 で白紙** /
 * **配色は明暗の 2 種だけ** ── 段②が直した当の 2 つが、1 枚ではそのままだった。
 *
 * 🔑 `build/portable/fold.mjs` が `manual.html` の中身を **JSON の `<script>`** として
 *   1 枚の中へ焼き込む(`data-pkc-manual-page`)。ここはそれを取り出して `Blob` にし、
 *   `URL.createObjectURL` の **`blob:` URL** を `manual-window.ts` の `pageUrl` へ渡す ──
 *   窓は実 URL を持つので、**F5 で読み直せて**、`tokens.css` を丸ごと持つので
 *   **配色 9 種が効く**(段②と同じ page が、同じ経路で開く)。
 * ⚠ `data:` は使えない ── script からの top-level の `data:` への navigate はブラウザが
 *   止める(Chrome 60〜)。`blob:` は同じ origin の実 URL として扱われる。
 *
 * ## 🔴 中身の寿命(不可侵指示 2026-07-27「生成物はライフサイクル終端で即破棄」)
 *
 * - 焼き込んだ字(約 350 KB)は**取り出すまで DOM の中に置く** ── boot で取り出して
 *   JS の文字列に持つと、押されもしないマニュアルが起動時から heap に載る。
 *   `takeEmbeddedManualPage` は取り出した瞬間に `<script>` を DOM から外す(DB 画像の
 *   `takeEmbeddedImage` と同じ作法)。
 * - `Blob` の bytes は heap ではなくブラウザの blob 置き場に居る。URL の寿命は
 *   **窓 1 枚**である ── 窓が開いている間は同じ URL を返し(押すたび新しい blob を作ると、
 *   古い URL を握っている窓の F5 が壊れる)、**窓が閉じたら `revokeObjectURL` して器を空にする**。
 *   次に押したときは新しく作る。
 * - 🔴 閉じたことは **`win.closed` を 1 秒間隔で見張って**知る(`watch`)。`location.replace`
 *   の先の document には listener を張れない(navigate で Window が入れ替わる)ので、
 *   見張りしか手が無い。⚠ 見張りは窓が閉じたら**必ず止める**(常駐を残さない)。
 *   ⚠ 開いている間は revoke しない(F5 が効く、を壊さない)。
 * - ⚠ 見張りが鳴る前(1 秒の内)に閉じて押し直した回のために、`url()` は先に見張りの
 *   窓を検める ── 閉じていれば古い URL を返さず、その場で回収して新しく作る(そうしないと
 *   新しい窓が古い URL で開き、1 秒後の見張りがそれを消す)。
 * - 帰結:**アプリの側を読み直した後は、開いたままの窓で F5 が効かない**(ブラウザが
 *   opener の unload で URL を回収する)。その場合は窓を閉じてもう一度押せばよい ──
 *   マニュアル §4-4 に書いてある。
 *
 * ## 🔑 見え方は blob に**焼いてから**開く
 *
 * 焼いた page の boot script は `localStorage` から配色を読むが、`file://` から作った
 * `blob:` の document は**保存に触れないことがある**(opaque origin)。だから opener が
 * いま出している配色と文字の大きさを `<html>` の属性として**焼き込んでから** blob にする
 * ── boot script は保存が読めなければ**その属性を採る**(`manual-page.ts`)。F5 でも
 * 同じ blob が読まれるので、見え方はそのまま残る。
 * ⚠ 焼くのは**最初に開くとき**の見え方 ── 後で設定を変えても blob は作り直さない
 *   (作り直すと読んでいた所を失う)。2 回目に押した回は `manual-window.ts` が
 *   **生きている窓へ当て直す**ので、開いている間は追従する。
 */
import type { ManualAppearance } from './manual-window';

/**
 * 焼き込みの `<script>` を探す綴り。⚠ `build/portable/shell-scan.mjs` の `MANUAL_PAGE_ATTR`
 * と同じ ── 突き合わせは `tests/adapter/portable-manual.test.ts`(本物どうしで往復する)。
 */
export const MANUAL_PAGE_SELECTOR = 'script[data-pkc-manual-page]';

/**
 * 焼き込んだマニュアルの page(HTML 全文)を取り出し、**その場で DOM から外す**。
 * ⚠ 無い / 壊れている(JSON でない・空)なら `null` ── 呼び側は `about:blank` に組む
 *   逃げ道へ落ちる(段①のまま。白紙にはしない)。
 */
export function takeEmbeddedManualPage(doc: Document): string | null {
  const el = doc.querySelector(MANUAL_PAGE_SELECTOR);
  if (el === null) return null;
  const text = el.textContent ?? '';
  el.remove();
  try {
    const v: unknown = JSON.parse(text);
    return typeof v === 'string' && v !== '' ? v : null;
  } catch {
    return null;
  }
}

function escapeAttr(s: string): string {
  return s.replace(/&/gu, '&amp;').replace(/"/gu, '&quot;').replace(/</gu, '&lt;');
}

/**
 * いまの見え方を `<html>` の属性として焼く(配色 = `data-pkc-theme` / 文字の大きさ =
 * `--pkc-text-size`)。⚠ 値が `null` の側は触らない(boot script の既定に任せる)。
 * ⚠ `<html …>` が見つからなければ**そのまま返す**(壊れた page を更に壊さない)。
 */
export function bakeAppearance(html: string, a: ManualAppearance | undefined): string {
  if (a === undefined) return html;
  const attrs: string[] = [];
  if (a.theme !== null) attrs.push(` data-pkc-theme="${escapeAttr(a.theme)}"`);
  if (a.textSize !== null) attrs.push(` style="--pkc-text-size:${escapeAttr(a.textSize)}"`);
  if (attrs.length === 0) return html;
  return html.replace(/<html\b([^>]*)>/iu, (_m, rest: string) => `<html${rest}${attrs.join('')}>`);
}

export interface PortableManualPage {
  /**
   * 焼き込んだ page の `blob:` URL。**無ければ `null`**(焼き込みの無い 1 枚 = 段①へ)。
   * ⚠ 窓が開いている間は同じ URL を返す(上の「寿命」)。閉じた後に呼べば新しく作る。
   */
  url(appearance?: ManualAppearance): string | null;
  /**
   * 🔴 窓を開いたら呼ぶ ── 閉じたら `revokeObjectURL` して器を空にする(見張りは 1 秒間隔)。
   * ⚠ 同じ窓で何度呼んでも見張りは 1 本。URL を渡していない(素の PKC3)なら何もしない。
   */
  watch(win: { readonly closed: boolean }): void;
}

/** 見張りの間隔(ms)。⚠ 窓が閉じてから最長これだけ blob が残る ── 1 秒なら user には見えない。 */
export const MANUAL_WINDOW_WATCH_MS = 1000;

export interface PortableManualPageDeps {
  /** `URL.createObjectURL`(test が差せる)。 */
  readonly createUrl?: (blob: Blob) => string;
  /** `URL.revokeObjectURL`(test が差せる)。 */
  readonly revokeUrl?: (url: string) => void;
}

/**
 * opener の document ごとに 1 つ作る(`main.ts`)。
 * ⚠ 焼き込みは document に 1 つしか無いので、取り出した HTML は**器の中に控える**
 *   (2 枚目の窓のために再び blob を作れるように)。控えるのは JS の文字列 1 本 = 約 400 KB
 *   ── 最初に押すまでは DOM に置いたまま(上の「寿命」)。
 */
export function portableManualPage(
  doc: Document,
  deps: PortableManualPageDeps = {},
): PortableManualPage {
  const createUrl = deps.createUrl ?? ((blob) => URL.createObjectURL(blob));
  const revokeUrl = deps.revokeUrl ?? ((u) => URL.revokeObjectURL(u));
  /** 焼き込みの HTML(取り出したら控える。`undefined` = まだ取り出していない / `null` = 無い)。 */
  let html: string | null | undefined;
  let url: string | null = null;
  let watched: { readonly closed: boolean } | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  const stopWatching = (): void => {
    if (timer !== null) clearInterval(timer);
    timer = null;
    watched = null;
  };
  /** 窓の寿命が終わっていれば、URL を返して器を空にする。 */
  const release = (): void => {
    stopWatching();
    if (url !== null) revokeUrl(url);
    url = null;
  };
  /** 見張っている窓が既に閉じていれば、その場で回収する(見張りが鳴るのを待たない)。 */
  const sweep = (): void => {
    if (watched !== null && watched.closed) release();
  };

  return {
    url(appearance) {
      sweep();
      if (url !== null) return url;
      if (html === undefined) html = takeEmbeddedManualPage(doc);
      if (html === null) return null;
      url = createUrl(
        new Blob([bakeAppearance(html, appearance)], { type: 'text/html;charset=utf-8' }),
      );
      return url;
    },
    watch(win) {
      if (url === null) return;
      if (watched === win && timer !== null) return;
      stopWatching();
      watched = win;
      timer = setInterval(sweep, MANUAL_WINDOW_WATCH_MS);
    },
  };
}
