/**
 * 🔴 **マニュアルを「アプリ」として独立した窓で開く**(#645。user 要望 2026-08-31)。
 *
 * > 「**ヘルプの中からマニュアルをアプリとして出してください。
 * > ちっとも改善していません。少しはこちらの要望を尊重してください**」
 *
 * ## 段②(2026-09-02):窓の中身は build 時に焼いた **`manual.html`**
 *
 * 段①は `about:blank` を開いて opener 側から DOM を組んでいた(`asset-window.ts` と同じ作法)。
 * それは 2 つが**原理的に**できなかった ── **F5 で白紙**になる / **設定で選んだ配色が届かない**
 * (表は `features/help/manual-page.ts`)。いまは:
 *
 * 1. `window.open('', name)` で窓を**同期で**掴む(user の操作の中で ── ポップアップ阻止を避ける)
 * 2. 既に**同じ版**で組んであれば、触らずに前へ出す(読んでいた所を失わない)
 * 3. `manual.html` が隣に在る(`pageUrl`)なら **`location.replace` でそこへ移す** ── 組まない
 * 4. 隣に無い(持ち歩ける 1 枚 = portable)なら、段①のとおり `about:blank` に組む
 *
 * 🔑 **PKC をもう 1 枚読み込まない。** `view-window.ts` は面を別窓で開くが、
 *   それは #292 で否定された形(「**ユーザーはもう一つ PKC が開いて混乱すると
 *   思う**」)であり、しかも開いた先でもマニュアルは `60vh` の箱のままである。
 * 🔑 器の見た目・帯の字・版の属性は `features/help/manual-page.ts` が正本 ──
 *   焼いた page と `about:blank` の窓で**同じ値**を使う(経路ごとに増やさない)。
 *
 * ## 🔴 開くのは同期、中身は後から
 *
 * ⚠ `window.open` を `await` の**後**に呼ぶと、ポップアップ阻止に掛かる
 *   (user の操作から離れるため)。だから **開く → 待つ → 詰める** の順にする。
 * ⚠ 待っている間の窓は白紙にしない ── 「マニュアルを開いています…」を先に出す。
 *
 * ## ⚠ 開けなかったら**理由を出す**
 *
 * 阻止されたときに黙って何もしないと、**押しても何も起きないボタン**になる
 * (この repo がいちばん嫌う形)。`null` を返して、呼び側に言わせる。
 */
import BODY_CSS from 'virtual:pkc-body-css';
import { buildManualDoc, type ManualTocItem } from '@features/help/manual-doc';
import type { ManualSection } from '@features/help/manual-find';
import {
  MANUAL_BUILT_ATTR,
  MANUAL_CHROME_CSS,
  MANUAL_TIP,
  MANUAL_WINDOW_TITLE,
  manualBuildTag,
} from '@features/help/manual-page';

// ⚠ 正本は `features/help/manual-page.ts`。既存の import 先を壊さないために再 export する
export { MANUAL_BUILT_ATTR, MANUAL_WINDOW_TITLE };

/** 窓の名前。⚠ **固定する** ── 2 回押しても 2 枚目を積まず、その窓が前へ出る。 */
export const MANUAL_WINDOW_NAME = 'pkc3-manual';

/**
 * 開いた直後の大きさ。⚠ `popup` と寸法を渡さないと**別タブ**になるブラウザが在る
 * (`asset-window.ts` の実測由来)。
 * 🔑 マニュアルは**読み物**なので、目次(左)と本文(右)が並ぶ幅を取る。
 */
const SIZE = { width: 1100, height: 900 };

export interface OpenManualWindowDeps {
  /** 窓の題名。 */
  readonly title: string;
  /** 帯に出す版の行(`versionText()`)。⚠ 入れ替えの判定には使わない(下の `tag`)。 */
  readonly version: string;
  /** マニュアルの源文。 */
  readonly text: string;
  /**
   * 🔴 **窓に刻む印**(`manualBuildTag(version, text)`)。同じ印の窓は前へ出すだけ、
   * 違えば入れ替える。⚠ 版の行そのものを使わない ── `/dev/` では版の字が変わらない
   * (`manual-page.ts` の `manualBuildTag` の注記)。省略時はここで組む。
   */
  readonly tag?: string;
  /** 源文の節(`manualSections(text)`)。 */
  readonly sections: readonly ManualSection[];
  /** 本文を描く口。⚠ **失敗したら素の原文**を出す(白紙にしない)。 */
  readonly render: (text: string) => Promise<string>;
  /**
   * 🔴 焼いた 1 枚(`manual.html`)の URL。**`null` = 隣に無い**(持ち歩ける 1 枚)。
   *
   * ⚠ 在るなら**組まずにそこへ移す** ── F5 で読み直せて、設定の配色が効く。
   * ⚠ 呼び側が決める(ここでは fetch しない)── 「隣に在るか」は build の形で
   *   決まっており、実行時に探ると dev の SPA fallback(`index.html` が 200 で返る)に
   *   騙されて **PKC をもう 1 枚**開く。
   */
  readonly pageUrl: string | null;
  /** いまアプリが出している見え方(2 回目に当て直す / 開く瞬間の地の色)。 */
  readonly appearance?: ManualAppearance;
  /** 素の別窓を開く(既定 `window.open`)。⚠ test が差せる。 */
  readonly open?: (url: string, target: string, features: string) => Window | null;
}

/**
 * 🔴 **いまアプリが出している見え方**(2026-09-02、動線レビュー I1 / I5。user 裁定「推奨で実装」)。
 *
 * ⚠ 焼いた page は開いたときに `localStorage` を読んで配色を立てるが、**開いている間に
 *   設定を変えても窓は変わらない**。user が「変わらない」と読む前に、**もう一度押したとき**
 *   ここで当て直す(読み直さないので、読んでいた所は失わない)。
 * ⚠ `bg` / `fg` は「マニュアルを開いています…」の一瞬に使う ── 素の `about:blank` は白いので、
 *   暗い配色の user には**白い窓が一瞬光る**(I5)。
 */
export interface ManualAppearance {
  /** `data-pkc-theme` の値(無ければ触らない)。 */
  readonly theme: string | null;
  /**
   * user が**選んだ**大きさ(`text-scale.ts` の `chosenTextScale` を px にしたもの)。
   * ⚠ `null` = 選んでいない → 外して CSS の既定へ戻す(焼いた page の boot script と同じ門。
   *   「効いている 13px」を渡すと、何も変えずに押しただけで 14px から縮む ── 2026-09-02 hotfix)。
   */
  readonly textSize: string | null;
  /**
   * 地と字の色(`--bg` / `--fg` の computed 値)。無ければ UA の色のまま。
   * ⚠ 使うのは**焼いた page へ移す経路だけ**(`about:blank` に組む経路には配色の規則が無い)。
   */
  readonly bg: string | null;
  readonly fg: string | null;
}

/** 開いた 1 枚。⚠ 呼び側が閉じたいときのため(既定では誰も閉じない)。 */
export interface ManualWindowHandle {
  close(): void;
  /**
   * 🔴 **既に開いていた窓を前へ出しただけか**(#645)。
   *
   * ⚠ 呼び側はこれを見て**知らせを出す** ── `focus()` が窓を手前へ出せるかは
   *   ブラウザ次第で、出せなかった回は「押しても何も起きない」に見える。
   *   ⚠ ここでは判断しない(この module は文言を持たない)。
   */
  readonly reused: boolean;
  /**
   * 🔴 **古い印の窓を入れ替えたか**(動線レビュー I3)。`true` なら user は
   * 読んでいた所を失っている ── 呼び側が「新しい版に入れ替えた」と一言出す。
   * ⚠ 初めて開いた回は `false`(失ったものが無い)。
   */
  readonly swapped: boolean;
}

/**
 * 見え方を窓へ当て直す。⚠ 触れない窓(別 origin)では黙る ── 当て直せないだけで、
 * 前へ出すことはできる。
 */
function applyAppearance(win: Window, a: ManualAppearance | undefined): void {
  if (a === undefined) return;
  try {
    const root = win.document.documentElement;
    if (a.theme !== null) root.setAttribute('data-pkc-theme', a.theme);
    if (a.textSize !== null) root.style.setProperty('--pkc-text-size', a.textSize);
    else root.style.removeProperty('--pkc-text-size');
  } catch {
    // 触れない窓 ── 当て直せない
  }
}

/**
 * その窓が**どの版で**組まれているか。無ければ `null`。
 * ⚠ user が窓を別の origin へ動かしていると `document` に触れない ── 例外を
 *   「組まれていない」に畳む(次の 1 手 = 移す / 組む、で正しい状態へ戻る)。
 */
function builtVersion(win: Window): string | null {
  try {
    return win.document.body?.getAttribute(MANUAL_BUILT_ATTR) ?? null;
  } catch {
    return null;
  }
}

/**
 * マニュアルの窓を開く。開けなければ `null`(呼び側が理由を出す)。
 *
 * ⚠ **描画に失敗しても窓は残す** ── 素の原文を出す。閉じてしまうと
 *   「押したのに何も出なかった」と見分けが付かない。
 */

/**
 * 🔴 **開いた窓を手前へ出す**(#649 の着地後レビュー ②)。⚠ **判定は 1 か所**(§7)──
 * 直す前は**再利用の経路だけ**が `focus()` を呼んでいたので、
 * 「マニュアルが新しくなったので、ウィンドウを入れ替えました」と言った回は
 * **入れ替わった窓が後ろに居たまま**だった(user が見ているのはアプリの画面なので、
 * 言われたものが画面のどこにも無い)。
 *
 * ⚠ **前へ出せない環境が在る** ── 例外は飲む(呼び側が「見えないときは切り替えて
 * ください」と知らせるので、ここで言うことは無い)。
 */
function bringToFront(win: Window): void {
  try {
    win.focus();
  } catch {
    // 前へ出せない環境が在る ── 呼び側が知らせを出すので、ここでは黙ってよい
  }
}

export async function openManualWindow(
  deps: OpenManualWindowDeps,
): Promise<ManualWindowHandle | null> {
  const open = deps.open ?? ((u, t, f) => globalThis.open?.(u, t, f) ?? null);
  const tag = deps.tag ?? manualBuildTag(deps.version, deps.text);
  /**
   * 🔴 **URL は空にする ── `'about:blank'` を渡してはいけない**(2026-08-31、実測)。
   *
   * ⚠ 名前つきの窓に **`'about:blank'` を渡すと、その窓を navigate し直す** ──
   *   つまり **2 回目に押すたび、組んだ中身が丸ごと消える**。実測(実ブラウザ、
   *   同じ窓へ 2 回 `window.open`):
   *
   *   | 渡した URL | 同じ窓が返るか | 1 回目に書けたか | **2 回目の後も残るか** |
   *   |---|---|---|---|
   *   | `'about:blank'` | ✅ | ✅ | 🔴 **消える** |
   *   | `''`(空) | ✅ | ✅ | ✅ **残る** |
   *
   * 🔑 空の URL は「**navigate しない**」の意である(HTML 仕様)。新しく開くときは
   *   どのみち `about:blank` になるので、失うものは無い。
   * ⚠ 段②でも `pageUrl` を**ここに渡さない** ── 渡すと 2 回目に押すたび page を読み直し、
   *   読んでいた所を失う。移すのは「同じ版で組まれていない」と分かってからである。
   */
  const win = open('', MANUAL_WINDOW_NAME, `popup,width=${SIZE.width},height=${SIZE.height}`);
  if (!win) return null;
  /**
   * 🔴 **2 回目は、読んでいた所のまま前に出す**(着地前の設計レビューが拾った)。
   *
   * ⚠ 窓の名前は固定なので `window.open` は**同じ窓を返す** ── そこで無条件に
   *   組み直すと、**読んでいた場所が毎回いちばん上へ戻る**(user から見れば
   *   「押したら読んでいた所を見失った」である)。
   * 🔑 既に組んであるなら**触らずに前へ出すだけ**にする。焼いた page も
   *   `<body>` に同じ属性を持つので、**同じ式**で見分けられる。
   */
  const before = builtVersion(win);
  if (before === tag) {
    /**
     * 🔑 **前へ出す前に、いまの見え方を当て直す**(I1)── 設定で配色や文字の大きさを
     *   変えたあとに押した回は、読み直さずに(読んでいた所のまま)新しい見え方になる。
     */
    applyAppearance(win, deps.appearance);
    bringToFront(win);
    return { close: () => closeQuietly(win), reused: true, swapped: false };
  }
  // 🔑 古い印の窓が在った = 入れ替える(user は読んでいた所を失う ── 呼び側が一言出す)
  const swapped = before !== null;
  let doc: Document | null;
  try {
    doc = win.document;
    doc.title = deps.title;
    // ⚠ **開いた瞬間に「待っている」と分かる形にする**(白紙を見せない)
    doc.body.textContent = 'マニュアルを開いています…';
  } catch {
    // 触れない窓(user が別の origin へ動かした)── 書けないが、移すことはできる
    doc = null;
  }

  if (deps.pageUrl !== null) {
    /**
     * 🔑 **移るまでの一瞬も、選んだ配色の地で出す**(I5)── 素の `about:blank` は白いので、
     *   暗い配色の user には 1100×900 の白い窓が光ってから暗い page に変わっていた。
     * 🔴 **この経路だけ**に置く(2026-09-02 hotfix)── `about:blank` に組む経路には
     *   配色の規則が無く(`fillManualWindow` は UA の色で組む)、そこへ暗い地を先に置くと
     *   **組み上がった瞬間に暗 → 明へ裏返る**(避けたかった「光る」が向きを変えて残る)。
     * ⚠ `<style>` ではなく inline の 2 宣言 ── この document は直後に捨てられる(移す)。
     */
    if (doc !== null) {
      if (deps.appearance?.bg) doc.documentElement.style.background = deps.appearance.bg;
      if (deps.appearance?.fg) doc.documentElement.style.color = deps.appearance.fg;
    }
    /**
     * 🔴 **焼いた 1 枚へ移す ── 組まない**(段②)。
     * ⚠ `replace` にする ── `href =` だと `about:blank` が履歴に残り、
     *   「戻る」で白紙へ戻れてしまう。
     */
    win.location.replace(deps.pageUrl);
    bringToFront(win);
    return { close: () => closeQuietly(win), reused: false, swapped };
  }
  // ⚠ 触れない窓には組めない ── `null` で呼び側に理由を出させる(無言で終えない)
  if (doc === null) return null;

  let html: string;
  try {
    html = await deps.render(deps.text);
  } catch {
    html = '';
  }
  // ⚠ 待っている間に user が閉じたかもしれない ── 触る前に確かめる
  if (win.closed) return null;
  fillManualWindow(doc, {
    title: deps.title,
    version: deps.version,
    tag,
    html,
    text: deps.text,
    sections: deps.sections,
  });
  // 🔑 組んだ窓にも字の大きさを当てる(この経路には配色の規則が無いので、効くのは大きさだけ)
  applyAppearance(win, deps.appearance);
  bringToFront(win);
  return { close: () => closeQuietly(win), reused: false, swapped };
}

/** ⚠ 閉じられない窓(user が自分で開いた等)でも、例外で呼び側を落とさない。 */
function closeQuietly(win: Window): void {
  try {
    win.close();
  } catch {
    // 閉じられなくても、呼び側にできることは無い
  }
}

/**
 * 窓の中身を組む(`about:blank` の経路 = 持ち歩ける 1 枚)。
 * ⚠ **`export` している**のは test がこの 1 手だけを見られるようにするため
 *   (窓を開かずに、組み上がった document を検められる)。
 * ⚠ 焼いた page(`manual-page.ts`)と**同じ名前の面**(`manual-window-*`)を作る ──
 *   smoke / 呼び側は経路を区別せずに同じ selector で見る。
 */
export function fillManualWindow(
  doc: Document,
  parts: {
    title: string;
    version: string;
    /** `<body>` に刻む印(`manualBuildTag`)。⚠ 焼いた page と同じ属性に同じ印。 */
    tag: string;
    /** 描けた本文の HTML。⚠ 空なら素の原文へ落ちる。 */
    html: string;
    text: string;
    sections: readonly ManualSection[];
  },
): void {
  // ⚠ **組み直せる形にする**(版が上がったら入れ替える)── 足すだけだと style が積む。
  //    ⚠ **題名はこの後で入れる** ── `head` を空にすると `<title>` ごと消える
  //    (先に入れると、組み直した窓の題名が空になる ── unit が落ちて気づいた)
  doc.head.textContent = '';
  doc.title = parts.title;
  const style = doc.createElement('style');
  style.textContent = `${BODY_CSS}\n${MANUAL_CHROME_CSS}`;
  doc.head.append(style);

  doc.body.textContent = '';
  // 🔑 **組んだ版を刻む** ── 2 回目に押したとき、組み直すかどうかがこれで決まる
  doc.body.setAttribute(MANUAL_BUILT_ATTR, parts.tag);
  const head = doc.createElement('div');
  head.setAttribute('data-pkc-field', 'manual-window-head');
  const name = doc.createElement('strong');
  name.textContent = parts.title;
  const ver = doc.createElement('span');
  ver.textContent = parts.version;
  const tip = doc.createElement('span');
  tip.textContent = MANUAL_TIP;
  head.append(name, ver, tip);
  doc.body.append(head);

  const body = doc.createElement('div');
  body.setAttribute('data-pkc-region', 'manual-window-body');
  const toc = doc.createElement('nav');
  toc.setAttribute('data-pkc-region', 'manual-window-toc');
  toc.setAttribute('aria-label', '目次');
  const main = doc.createElement('div');
  main.setAttribute('data-pkc-region', 'manual-window-main');
  // ⚠ 本文の見た目は `.pkc-md-rendered` を起点にした規則が持つ(器の class が要る)
  main.className = 'pkc-md-rendered';
  body.append(toc, main);
  doc.body.append(body);

  if (parts.html === '') {
    /**
     * 🔴 **描けなかったとき**(ワーカーが無い / 失敗)。
     * ⚠ 素の原文を出す ── 白紙にしない。目次は**出さない**
     *   (飛び先が無いので、出すと全部 dead click になる)。
     */
    const pre = doc.createElement('pre');
    pre.setAttribute('data-pkc-field', 'manual-window-raw');
    pre.textContent = parts.text;
    main.append(pre);
    return;
  }
  const built = buildManualDoc(parts.html, parts.sections);
  main.innerHTML = built.html;
  for (const item of built.toc) toc.append(tocButton(doc, main, item));
}

/**
 * 目次の 1 行(`about:blank` の経路)。
 *
 * 🔴 **`<a href="#…">` にしない**(2026-08-31、実ブラウザの probe で判明)。
 * ⚠ この窓は `about:blank` なので、**開いた側の base URL を引き継ぐ** ──
 *   素の断片リンクを押すと、窓が `about:blank` から
 *   **`http://…/#m-100`(= アプリ本体)へ navigate** し、マニュアルが丸ごと消えた
 *   (実測)。⚠ しかも「PKC がもう 1 枚」という、この窓が避けている当の形になる。
 * 🔑 `<button>` なら**そもそも navigate しない**。鍵でも辿れる(この repo の
 *   ヘルプの探した結果と同じ流儀 ── `help.ts` の `findRow`)。
 * ⚠ 焼いた page(実 URL)では断片が page の中で解決するので、そちらは `<a>` でよい。
 */
function tocButton(doc: Document, main: HTMLElement, item: ManualTocItem): HTMLButtonElement {
  const b = doc.createElement('button');
  b.type = 'button';
  b.textContent = item.label;
  b.setAttribute('data-pkc-level', String(item.level));
  b.setAttribute('data-pkc-target', item.targetId);
  b.addEventListener('click', () => {
    // ⚠ **その窓の document から引く**(opener の document ではない)
    const head = main.querySelector<HTMLElement>(`[id="${CSS.escape(item.targetId)}"]`);
    head?.scrollIntoView({ block: 'start' });
  });
  return b;
}
