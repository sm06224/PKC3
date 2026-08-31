/**
 * 🔴 **マニュアルを「アプリ」として独立した窓で開く**(#645。user 要望 2026-08-31)。
 *
 * > 「**ヘルプの中からマニュアルをアプリとして出してください。
 * > ちっとも改善していません。少しはこちらの要望を尊重してください**」
 *
 * ## 作りは `asset-window.ts` と同じ ── `about:blank` を開いて**こちらで組む**
 *
 * 🔑 **PKC をもう 1 枚読み込まない。** `view-window.ts` は面を別窓で開くが、
 *   それは #292 で否定された形(「**ユーザーはもう一つ PKC が開いて混乱すると
 *   思う**」)であり、しかも開いた先でもマニュアルは `60vh` の箱のままである。
 * 🔑 **inline の script を 1 行も書かない。** 中身は opener 側から DOM API で組む
 *   ので、CSP に触れない(`asset-window.ts` と同じ作法)。目次はただの
 *   `<a href="#m-3">` なので、**script 無しで飛ぶ**。
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

/** 窓の名前。⚠ **固定する** ── 2 回押しても 2 枚目を積まず、その窓が前へ出る。 */
export const MANUAL_WINDOW_NAME = 'pkc3-manual';

/**
 * 窓の題名。⚠ **1 か所で持つ** ── タイルの字(`tiles.ts` の `manualTile`)と
 * 揃っているかは `tests/features/manual-doc.test.ts` が見る。
 */
export const MANUAL_WINDOW_TITLE = 'PKC3 マニュアル';

/**
 * 🔴 **どの版で組んだ窓か**(#645)。
 *
 * ⚠ **版で見分ける** ── 「組んであるか」だけで見ると、**アプリが新しくなっても
 *   古い本文の窓が前に出続ける**(user は直したはずのマニュアルを読み続ける)。
 * ⚠ 帯の字ではなく属性で持つ ── 文言を直した日に判定が壊れないようにする。
 */
export const MANUAL_BUILT_ATTR = 'data-pkc-manual-version';

/**
 * 開いた直後の大きさ。⚠ `popup` と寸法を渡さないと**別タブ**になるブラウザが在る
 * (`asset-window.ts` の実測由来)。
 * 🔑 マニュアルは**読み物**なので、目次(左)と本文(右)が並ぶ幅を取る。
 */
const SIZE = { width: 1100, height: 900 };

/**
 * 窓の器の見た目。⚠ 本文の見た目は `BODY_CSS`(app.css から抜いた正本)が持つ。
 *
 * 🔴 **地は `color-scheme` に任せる ── 自分で色を置かない**(2026-08-31、着地前の
 * 実地調査が拾った)。⚠ 1 稿目は `background: var(--bg, #fff)` と書いていたが、
 * **`--bg` は `BODY_CSS` に入っていない**(実測: 定義されている変数 30 個のうち
 * `--fg` / `--border` / `--surface-2` は在り、`--bg` は**無い**)── つまり地は
 * 常に `#fff` に固定される一方、字は `--fg` で環境に追従するので、
 * **暗い環境では白地に白い字**になる。
 * 🔑 書き出す HTML(`pkc3-html.ts` の `:root{color-scheme:light dark}`)と
 *   **同じ倒し方**にする ── 地は UA が塗り、字は `--fg` が追う。
 */
const CHROME_CSS = [
  ':root{color-scheme:light dark}',
  'html,body{margin:0;height:100%}',
  'body{display:grid;grid-template-rows:auto 1fr;font:14px system-ui,sans-serif;',
  'color:var(--fg,CanvasText)}',
  // 帯 ── 題名と版だけ。⚠ 地は無彩色(不可侵指示)
  '[data-pkc-field="manual-window-head"]{display:flex;gap:12px;align-items:baseline;',
  'padding:8px 16px;border-bottom:1px solid var(--border,#8884)}',
  '[data-pkc-field="manual-window-head"] strong{font-size:15px}',
  '[data-pkc-field="manual-window-head"] span{opacity:.7;font-size:12px}',
  // 目次(左)と本文(右)
  '[data-pkc-region="manual-window-body"]{display:grid;grid-template-columns:280px 1fr;',
  'min-height:0}',
  '[data-pkc-region="manual-window-toc"]{overflow:auto;padding:12px 8px;',
  'border-right:1px solid var(--border,#8884);min-height:0}',
  '[data-pkc-region="manual-window-toc"] button{display:block;width:100%;text-align:left;',
  'padding:2px 6px;border:0;background:0;font:inherit;color:inherit;cursor:pointer;',
  'border-radius:3px;line-height:1.5}',
  '[data-pkc-region="manual-window-toc"] button:hover{background:var(--surface-2,#8882)}',
  '[data-pkc-region="manual-window-toc"] button:focus-visible{outline:2px solid currentColor}',
  // 🔑 段付けは `#` の数から(見出しの深さがそのまま読める)
  '[data-pkc-region="manual-window-toc"] button[data-pkc-level="1"]{font-weight:700}',
  '[data-pkc-region="manual-window-toc"] button[data-pkc-level="2"]{padding-left:14px}',
  '[data-pkc-region="manual-window-toc"] button[data-pkc-level="3"]{padding-left:28px;opacity:.9}',
  '[data-pkc-region="manual-window-toc"] button[data-pkc-level="4"]{padding-left:42px;opacity:.85}',
  '[data-pkc-region="manual-window-toc"] button[data-pkc-level="5"]{padding-left:56px;opacity:.8}',
  '[data-pkc-region="manual-window-toc"] button[data-pkc-level="6"]{padding-left:70px;opacity:.8}',
  // 🔴 **本文は窓いっぱい**(ヘルプ面の 60vh の箱がこの窓に来ないようにする)
  '[data-pkc-region="manual-window-main"]{overflow:auto;padding:16px 24px 64px;min-height:0}',
  /**
   * 🔴 **行を長くしすぎない**(着地前の設計レビューが拾った)。
   * ⚠ 窓を最大化すると、器いっぱい = **1 行が 2000px を超える**ことがある ──
   *   「大きく出す」ために開いた窓が、**かえって読みにくく**なる。
   * 🔑 上限は **76rem**(≒1216px)── 既定の窓(1100px から目次 280px を引いた
   *   820px)では**当たらない**ので、いまの見え方は 1 ドットも変わらない。
   *   効くのは「広げすぎたとき」だけである。
   * ⚠ 器そのものは器いっぱいのまま(送るのは器)── 中身の幅だけを抑える。
   */
  '[data-pkc-region="manual-window-main"] > *{max-width:76rem}',
  /**
   * 🔑 **飛んだ見出しが帯の下に隠れない** ── `scroll-margin-top` を置く。
   * ⚠ 置かないと、目次から飛んだとき見出しが**器の上端ぴったり**に来て、
   *   直前の段落と見分けにくい。
   */
  '[data-pkc-region="manual-window-main"] :is(h1,h2,h3,h4,h5,h6){scroll-margin-top:8px}',
  // 狭い窓では目次を上へ畳む(横に潰さない)
  '@media (max-width:760px){[data-pkc-region="manual-window-body"]{grid-template-columns:1fr;',
  'grid-template-rows:minmax(0,32vh) 1fr}',
  '[data-pkc-region="manual-window-toc"]{border-right:0;border-bottom:1px solid var(--border,#8884)}}',
].join('');

export interface OpenManualWindowDeps {
  /** 窓の題名。 */
  readonly title: string;
  /** 帯に出す版の行(`versionText()`)。 */
  readonly version: string;
  /** マニュアルの源文。 */
  readonly text: string;
  /** 源文の節(`manualSections(text)`)。 */
  readonly sections: readonly ManualSection[];
  /** 本文を描く口。⚠ **失敗したら素の原文**を出す(白紙にしない)。 */
  readonly render: (text: string) => Promise<string>;
  /** 素の別窓を開く(既定 `window.open`)。⚠ test が差せる。 */
  readonly open?: (url: string, target: string, features: string) => Window | null;
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
}

/**
 * マニュアルの窓を開く。開けなければ `null`(呼び側が理由を出す)。
 *
 * ⚠ **描画に失敗しても窓は残す** ── 素の原文を出す。閉じてしまうと
 *   「押したのに何も出なかった」と見分けが付かない。
 */
export async function openManualWindow(
  deps: OpenManualWindowDeps,
): Promise<ManualWindowHandle | null> {
  const open = deps.open ?? ((u, t, f) => globalThis.open?.(u, t, f) ?? null);
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
   */
  const win = open('', MANUAL_WINDOW_NAME, `popup,width=${SIZE.width},height=${SIZE.height}`);
  if (!win) return null;
  const doc = win.document;
  /**
   * 🔴 **2 回目は、読んでいた所のまま前に出す**(着地前の設計レビューが拾った)。
   *
   * ⚠ 窓の名前は固定なので `window.open` は**同じ窓を返す** ── そこで無条件に
   *   組み直すと、**読んでいた場所が毎回いちばん上へ戻る**(user から見れば
   *   「押したら読んでいた所を見失った」である)。
   * 🔑 既に組んであるなら**触らずに前へ出すだけ**にする。
   */
  if (doc.body?.getAttribute(MANUAL_BUILT_ATTR) === deps.version) {
    try {
      win.focus();
    } catch {
      // 前へ出せない環境が在る ── 呼び側が知らせを出すので、ここでは黙ってよい
    }
    return { close: () => closeQuietly(win), reused: true };
  }
  doc.title = deps.title;
  // ⚠ **開いた瞬間に「待っている」と分かる形にする**(白紙を見せない)
  doc.body.textContent = 'マニュアルを開いています…';

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
    html,
    text: deps.text,
    sections: deps.sections,
  });
  return { close: () => closeQuietly(win), reused: false };
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
 * 窓の中身を組む。
 * ⚠ **`export` している**のは test がこの 1 手だけを見られるようにするため
 *   (窓を開かずに、組み上がった document を検められる)。
 */
export function fillManualWindow(
  doc: Document,
  parts: {
    title: string;
    version: string;
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
  style.textContent = `${BODY_CSS}\n${CHROME_CSS}`;
  doc.head.append(style);

  doc.body.textContent = '';
  // 🔑 **組んだ版を刻む** ── 2 回目に押したとき、組み直すかどうかがこれで決まる
  doc.body.setAttribute(MANUAL_BUILT_ATTR, parts.version);
  const head = doc.createElement('div');
  head.setAttribute('data-pkc-field', 'manual-window-head');
  const name = doc.createElement('strong');
  name.textContent = parts.title;
  const ver = doc.createElement('span');
  ver.textContent = parts.version;
  const tip = doc.createElement('span');
  // 🔑 **この窓の取り分をその場で言う**(#636 で Ctrl+F を返した意味がここで効く)
  tip.textContent = 'Ctrl+F(Mac は ⌘+F)で、ブラウザの検索がそのまま使えます';
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
 * 目次の 1 行。
 *
 * 🔴 **`<a href="#…">` にしない**(2026-08-31、実ブラウザの probe で判明)。
 * ⚠ この窓は `about:blank` なので、**開いた側の base URL を引き継ぐ** ──
 *   素の断片リンクを押すと、窓が `about:blank` から
 *   **`http://…/#m-100`(= アプリ本体)へ navigate** し、マニュアルが丸ごと消えた
 *   (実測)。⚠ しかも「PKC がもう 1 枚」という、この窓が避けている当の形になる。
 * 🔑 `<button>` なら**そもそも navigate しない**。鍵でも辿れる(この repo の
 *   ヘルプの探した結果と同じ流儀 ── `help.ts` の `findRow`)。
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
