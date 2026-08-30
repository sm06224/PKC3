/**
 * 添付を**別の窓で見る**(#192 で画像、2026-08-15 に PDF を追加)── 見ながら書くため。
 *
 * 🔴 **不可侵指示(2026-07-27)の当の場所**: 生成物(ObjectURL)は
 * **表示の寿命終端で破棄する**。ここは寿命が**別 window の生死**になるので、
 * 「開いた側が閉じたら revoke」を確実にやる ── やらないと、閉じたあとも
 * blob が heap と disk cache に残り続ける。
 *
 * ⚠ **`window.closed` は poll でしか分からない**(別 window の close は event で
 * 飛んでこない)。`waitForWindowClose` が既にその作法を持っているので、
 * ここで 2 本目を書かない(§7)。
 *
 * ⚠ **窓が開けなかったとき(popup 阻止)は、その場で捨てる** ── 捨て忘れると、
 * 「押しても何も出ないうえに、押した数だけ blob が積もる」という最悪の形になる。
 *
 * 🔑 **Document Picture-in-Picture を優先する**(あれば)── 常に手前に留まるので
 * 「見ながら書く」という目的そのものに合う。⚠ **無い環境が普通**(Chromium 以外)
 * なので、無ければ素の別窓へ落ちる。どちらでも寿命の扱いは同じ。
 *
 * ## PDF について(2026-08-15、user 報告「PDF ビューアが動作しない」)
 *
 * 🔴 **`about:blank` を開いて中をこちらで組む。** ObjectURL へ直接 navigate する形
 * (PKC2 の `window.open(blobUrl)`)でも描画はされるが、**窓の題名が blob の UUID に
 * なる**ので、user から見て「何の PDF か」が分からない(PKC2 の実物がそうなっている)。
 * ⚠ 実測(2026-08-15、この箱の chromium): 直接 navigate / 自前の器 のどちらでも
 * 内蔵ビューアは立ち上がる ── **選べるなら題名が出るほうを採る**。
 *
 * ⚠ **PDF に Document PiP は使わない。** PiP の窓は小さく常に手前へ留まる作りで、
 * 「1 枚の絵を横に置く」には合うが、**頁を繰って読む**には狭すぎる。
 * ⚠ **PDF に sandbox を付けない**(`<object>` は script を実行しない)。
 */
import { waitForWindowClose } from './window-close';

/** 別窓に見えている 1 つ。⚠ `close()` は**呼ばれなくても**寿命は守られる。 */
export interface AssetWindowHandle {
  /** こちらから閉じる(閉じれば ObjectURL も戻る)。 */
  close(): void;
}

/** 別窓に出せるもの。⚠ 判定は `features/asset/asset-preview-kind.ts` が持つ。 */
export type AssetWindowKind = 'image' | 'pdf';

export interface OpenAssetWindowDeps {
  /** 中身の ObjectURL と、その捨て方(`lendObjectUrl` が返す組)。 */
  lent: { url: string; dispose: () => void };
  /** 窓の題名(= 添付の名前)。⚠ **文字として入れる**(HTML を組み立てない)。 */
  title: string;
  /** 画像か PDF か。⚠ 窓の大きさと中の要素が変わる。 */
  kind: AssetWindowKind;
  /**
   * 🔴 **開いた直後の大きさ**(#527。user 指示 2026-08-28
   * 「**別ウィンドウで実寸で開いて拡大縮小できるようにしてほしい**」)。
   *
   * | 値 | 開いた直後 | 誰が使うか |
   * |---|---|---|
   * | `'contain'`(既定) | 窓に**収まるまで縮める** | 添付の一覧から押したとき(#192 の見え方のまま) |
   * | `'natural'` | **実寸**(1:1) | 画面の絵を押したとき(図 / 本文の画像) |
   *
   * 🔑 **拡大縮小はどちらでもできる**(2026-08-28 に揃えた)── 違うのは
   *   **開いた直後の大きさだけ**である。⚠ 1 稿目は `'natural'` のときだけ
   *   帯を出していたので、**添付の写真を大きくする道が無かった**。
   * ⚠ **既定を `'contain'` にしてある**のは、添付の見え方を変えないためである
   *   ── 大きな写真をいきなり実寸で出すと**隅しか見えない**。
   *   帯の **等倍** を押せば実寸になる(そして **収める** で戻れる)。
   * ⚠ `'pdf'` には効かない(あちらは器いっぱいが正しい)。
   */
  fit?: 'contain' | 'natural';
  /**
   * 🔴 **窓の名前**(添付ごとに 1 枚)。2026-08-15 に flake で判明 ──
   * `'_blank'` だと、**閉じ切っていない前の窓を使い回す**ことがあり、
   * 一瞬だけ前の添付の中身が見える(実測: PDF の窓に画像を出す直前の状態が読めた)。
   * ⚠ 名前を分ければ、開き直しは**その添付の窓**に出る(積み上がらない)。
   */
  windowName?: string;
  /** 素の別窓を開く(既定 `window.open`)。⚠ test が差せる。 */
  open?: (url: string, target: string, features: string) => Window | null;
  /** Document PiP(無い環境が普通 ── 既定は `documentPictureInPicture`)。 */
  requestPip?: (opts: { width: number; height: number }) => Promise<Window>;
  /** 閉じるのを待つ(既定は `waitForWindowClose`。⚠ test が時計を差せる)。 */
  waitClose?: (win: { closed: boolean }) => Promise<void>;
}

/**
 * 窓の大きさ。⚠ **PKC2 の実測が根拠**: `'_blank'` だけだと多くのブラウザで
 * **別タブ**になるので、`popup` + 具体的な寸法を渡して「別窓」にする hint を出す
 * (PKC2 `action-binder.ts:11444-11447` の user 報告由来 hotfix)。
 */
const SIZE: Record<AssetWindowKind, { width: number; height: number }> = {
  image: { width: 480, height: 360 },
  // 🔑 PDF は**頁を読む**ので大きく開く(PKC2 は 1280×800)。⚠ 画面より大きい値を
  //    渡すとブラウザが縮めるだけなので、A4 縦が読める比率を優先する
  pdf: { width: 1000, height: 860 },
};

/**
 * 🔴 **拡大縮小と、掴み送り**(#527。user 指示 2026-08-28
 * 「**別ウィンドウで実寸で開いて拡大縮小できるようにしてほしい**」)。
 *
 * ⚠ **`transform: scale()` を使わない** ── 拡大した分だけ**送れる**必要があるので、
 *   `width` を直に動かして**ブラウザの scroll に任せる**ほうが素直である
 *   (`transform` だと器の大きさが変わらず、はみ出した所へ届かない ──
 *   #527 と #523 で 2 度踏んだ「見えない所へ届く手段が無い」と同じ形になる)。
 * 🔴 **ボタンを置く**(不可侵指示「マウスだけで完結し、キーボードは近道」)──
 *   `Ctrl+ホイール` だけにすると**キーボードが要る**ことになる。
 * ⚠ **素のホイールは送りのまま**にする ── 実寸の図は窓より大きいのが普通なので、
 *   奪うと**見えない所へ届かなくなる**。拡大はボタンと `Ctrl+ホイール` から。
 *
 * ## 🔴 **収める ⇄ 実寸は往復できる**(2026-08-28、#527 の残り)
 *
 * 添付の窓は**収めて**開く(#192 からの見え方 ── 大きな写真をいきなり実寸で出すと
 * **隅しか見えない**)。そこへ拡大縮小を足すので、**帰り道**が要る:
 *
 * | 押すと | 何が起きるか |
 * |---|---|
 * | **＋ / −** | いま見えている大きさから 1 段ずつ変わる(⚠ 収めていたなら**その見かけの倍率から**) |
 * | **等倍** | **実寸**(1:1) |
 * | **収める** | 窓に**収まるまで縮めた形**へ戻る |
 *
 * ⚠ **片道の操作を作らない**(不可侵指示 2026-08-23)── 「実寸にはできるが
 *   収めるには開き直すしかない」だと、動線を 1 つ失う。
 */
function addZoom(doc: Document, img: HTMLImageElement, startFit: boolean): void {
  const bar = doc.createElement('div');
  bar.setAttribute('data-pkc-field', 'asset-window-zoom');
  /** 倍率。⚠ `null` = **収めている**(大きさは CSS が決める)。 */
  let z: number | null = startFit ? null : 1;
  const pct = doc.createElement('span');
  pct.setAttribute('data-pkc-field', 'asset-window-zoom-pct');
  // ⚠ **`naturalWidth` は読み込み後にしか入らない**ので、当てるのは load の後
  const apply = (): void => {
    if (z === null) {
      // 収める ── 大きさの指定を**外す**(CSS の `max-width/height` に任せる)
      img.style.width = '';
      doc.body.setAttribute('data-pkc-fit', 'contain');
      pct.textContent = '全体';
      return;
    }
    doc.body.removeAttribute('data-pkc-fit');
    const w = img.naturalWidth;
    if (w > 0) img.style.width = `${Math.round(w * z)}px`;
    pct.textContent = `${Math.round(z * 100)}%`;
  };
  /**
   * いまの見かけの倍率。⚠ **収めているとき**に ＋ を押したら、
   * `1.25 倍`(実寸より大きい)ではなく**見えている大きさの 1.25 倍**にする
   * ── そうしないと、収まっていた絵が押した瞬間に**跳ねる**。
   */
  const shownRatio = (): number => {
    const w = img.naturalWidth;
    const shown = img.clientWidth;
    return w > 0 && shown > 0 ? shown / w : 1;
  };
  const step = (factor: number): void => {
    set((z ?? shownRatio()) * factor);
  };
  const set = (next: number): void => {
    // ⚠ 上下限を置く ── 0 倍にすると**消えて戻せなくなる**
    z = Math.max(0.1, Math.min(8, next));
    apply();
  };
  const fit = (): void => {
    z = null;
    apply();
  };
  const button = (label: string, title: string, on: () => void): HTMLButtonElement => {
    const b = doc.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.title = title;
    b.addEventListener('click', on);
    return b;
  };
  bar.append(
    button('−', '小さくする', () => step(1 / 1.25)),
    button('＋', '大きくする', () => step(1.25)),
    button('実寸', '実寸で見る', () => set(1)),
    button('収める', 'ウィンドウに収まる大きさに戻す', fit),
    pct,
  );
  doc.body.append(bar);
  /**
   * ⚠ **その場で 1 度当てる** ── `load` を待って当てると、読み込みの間だけ
   *   **収める指定が無い状態**で描かれる(大きな添付が一瞬**実寸で出てから縮む**)。
   * ⚠ そのうえで `load` でも当てる ── `naturalWidth` は**読み込み後にしか入らない**
   *   ので、実寸の幅はここでは書けない。
   */
  apply();
  img.addEventListener('load', apply);
  // 🔑 近道は `Ctrl`(mac は `Command`)+ ホイール ── 素のホイールは送りのまま
  doc.addEventListener(
    'wheel',
    (ev) => {
      if (!ev.ctrlKey && !ev.metaKey) return;
      ev.preventDefault();
      step(ev.deltaY < 0 ? 1.1 : 1 / 1.1);
    },
    { passive: false },
  );
  addPan(doc, img);
}

/**
 * 🔴 **掴み送り**(#527 の「位置の掴み送り」)── 絵を掴んで動かすと送れる。
 *
 * ⚠ **scrollbar だけでは足りない** ── 拡大した絵を見るときは
 *   「見たい所へ寄せる」が主な操作で、端の細い棒を掴ませるのは動線として弱い。
 * ⚠ **native の画像ドラッグを止める**(`preventDefault`)── 止めないと
 *   ブラウザが**画像そのものを掴んで運ぶ**動き(ghost)を始めて、送りにならない。
 * 🔴 **送る先は `body`** ── この窓の CSS が `html` を `hidden`、`body` を `auto` に
 *   しているので、はみ出した絵を抱えているのは `body` である。
 *   ⚠ `document.scrollingElement`(= `html`)を動かすと**1px も動かない**
 *   (2026-08-28、実ブラウザで踏んだ)。
 * ⚠ 収めているときは送る余地が無いので、掴んでも**何も起きない**(害は無い)。
 */
function addPan(doc: Document, img: HTMLImageElement): void {
  let from: { x: number; y: number; left: number; top: number } | null = null;
  const box = (): Element => doc.body;
  img.style.cursor = 'grab';
  img.addEventListener('mousedown', (ev) => {
    // ⚠ 左ボタンだけ(右押しは文脈メニュー、中押しは貼り付け ── 奪わない)
    if (ev.button !== 0) return;
    ev.preventDefault();
    const el = box();
    from = { x: ev.clientX, y: ev.clientY, left: el.scrollLeft, top: el.scrollTop };
    img.style.cursor = 'grabbing';
  });
  doc.addEventListener('mousemove', (ev) => {
    if (from === null) return;
    const el = box();
    el.scrollLeft = from.left - (ev.clientX - from.x);
    el.scrollTop = from.top - (ev.clientY - from.y);
  });
  // ⚠ **窓の外で放しても終わる** ── `img` に付けると、外へ出て放したときに
  //   掴んだままになり、次に触った瞬間に絵が飛ぶ
  const release = (): void => {
    if (from === null) return;
    from = null;
    img.style.cursor = 'grab';
  };
  doc.addEventListener('mouseup', release);
  doc.addEventListener('mouseleave', release);
}

/** 窓の中身を組む。⚠ **`innerHTML` を使わない**(題名は user の文字である)。 */
function fill(
  doc: Document,
  url: string,
  title: string,
  kind: AssetWindowKind,
  fit: 'contain' | 'natural' = 'contain',
): void {
  doc.title = title;
  const natural = kind === 'image' && fit === 'natural';
  const style = doc.createElement('style');
  // ⚠ 地は無彩色(user 指示「地は無彩色、色は情報にだけ使う」)
  style.textContent =
    kind === 'image'
      ? /**
         * 🔴 **同じ 1 枚の CSS で「収める」と「実寸」の両方を持つ**(#527)。
         *
         * ⚠ 2026-08-28 の 1 稿目は**別々の CSS**にしていたので、収める ⇄ 実寸を
         *   往復するには**窓を開き直す**しかなかった(= 片道の操作)。
         *   いまは `body[data-pkc-fit="contain"]` の有無で切り替わる。
         * ⚠ はみ出した分は **`overflow:auto` で送れる**ようにする ──
         *   送れないと「大きく見えるが端が見えない」になり、
         *   #527 / #523 で 2 度直した穴をここで作り直すことになる。
         * ⚠ 収めているときは、絵が器を超えないので**棒は出ない**
         *   (#192 からの見え方を変えない)。
         */
        /**
         * 🔴 **送るのは `body` 1 つに決める**(2026-08-28、実ブラウザで測って判明)。
         * ⚠ 1 稿目は `html` と `body` の**両方**を `overflow:auto` にしていたので、
         *   はみ出した絵を実際に抱えるのは **`body`** のほうだった ── そこで
         *   掴み送りが `document.scrollingElement`(= `html`)を動かしても
         *   **1px も動かない**(実ブラウザの smoke が教えた。値は 0 → 0)。
         * 🔑 `html` を `hidden` にして**送り手を 1 つ**にする ── どこを動かせば
         *   よいかが**読まなくても決まる**(§7「同じ判定が 2 か所」を作らない)。
         */
        'html{margin:0;height:100%;overflow:hidden}' +
        'body{margin:0;height:100%;background:#1b1b1b;overflow:auto}' +
        'img{display:block}' +
        // 収める ── 器いっぱいに引き伸ばさず、原寸比のまま真ん中へ
        'body[data-pkc-fit="contain"]{display:grid;place-items:center;overflow:hidden}' +
        'body[data-pkc-fit="contain"] img{max-width:100%;max-height:100%;object-fit:contain}' +
        // 拡大縮小の帯 ── 常に手前・小さく(絵の邪魔をしない)
        '[data-pkc-field="asset-window-zoom"]{position:fixed;top:8px;right:8px;' +
        'display:flex;gap:4px;align-items:center;background:#000a;padding:4px 6px;' +
        'border-radius:4px;font:12px system-ui,sans-serif;color:#ddd}' +
        '[data-pkc-field="asset-window-zoom"] button{font:inherit;cursor:pointer;' +
        'background:#333;color:#eee;border:1px solid #555;border-radius:3px;padding:2px 7px}'
      : // 🔴 PDF は**器いっぱい**にする(user 報告の症状は「小さすぎて読めない」だった)
        'html,body{margin:0;height:100%;background:#1b1b1b}' +
        'object{display:block;width:100%;height:100%;border:0}' +
        'p{margin:0;padding:1rem;color:#ddd;font:14px system-ui,sans-serif}';
  doc.head.append(style);
  doc.body.textContent = '';
  if (kind === 'image') {
    const img = doc.createElement('img');
    img.src = url;
    img.alt = title;
    img.setAttribute('data-pkc-field', 'asset-window-image');
    doc.body.append(img);
    /**
     * 🔴 **拡大縮小は「収める」で開いた窓にも出す**(#527 の残り、2026-08-28)。
     * ⚠ 1 稿目は実寸(図)のときだけ出していたので、**添付の写真は
     *   大きくする道が無かった** ── user の頼み(「対象は画像だけでなく
     *   レンダリング結果全部」)の半分しか満たしていない。
     * ⚠ 開いた直後の見え方は**変えていない**(収める側は収めたまま出る)。
     */
    addZoom(doc, img, !natural);
    return;
  }
  const obj = doc.createElement('object');
  obj.setAttribute('data-pkc-field', 'asset-window-pdf');
  obj.type = 'application/pdf';
  obj.data = url;
  /**
   * 🔴 **出せなかったときに空白を残さない**(PKC2 の判断を採る ──
   * `<object>` の fallback 検出はブラウザ差が大きく当てにならないので、
   * **中に断り文を置いて**ブラウザ自身に出させる)。
   */
  const p = doc.createElement('p');
  p.textContent =
    'このブラウザでは PDF を表示できません。PKC の画面に戻り、添付の「ダウンロード」から保存して開いてください';
  obj.append(p);
  doc.body.append(obj);
}

/**
 * 添付を別窓で開く。
 * @returns 開けたら handle、開けなければ `null`(⚠ そのとき `lent` は**捨て済み**)
 */
export async function openAssetWindow(
  deps: OpenAssetWindowDeps,
): Promise<AssetWindowHandle | null> {
  const { lent, title, kind } = deps;
  const fit = deps.fit ?? 'contain';
  const waitClose = deps.waitClose ?? ((w) => waitForWindowClose(w));
  /**
   * 🔴 **実寸で見るときは大きく開く**(#527 案 A)── 480×360 では
   * 「大きく見る」ために開いたのに**縮めて見る**ことになる。
   */
  const size = kind === 'image' && fit === 'natural' ? SIZE.pdf : SIZE[kind];
  /**
   * ⚠ PDF は PiP を使わない(狭すぎて頁が読めない ── file 冒頭の注記)。
   * 🔴 **実寸の画像も同じ理由で使わない**(#527 案 A)── PiP の窓は小さく作られる
   *   ので、「大きく見る」という目的そのものと逆になる。
   */
  const pip =
    kind === 'image' && fit !== 'natural'
      ? (deps.requestPip ??
        (typeof globalThis !== 'undefined' &&
        (globalThis as { documentPictureInPicture?: { requestWindow?: unknown } })
          .documentPictureInPicture?.requestWindow !== undefined
          ? (opts: { width: number; height: number }) =>
              (
                globalThis as unknown as {
                  documentPictureInPicture: {
                    requestWindow(o: { width: number; height: number }): Promise<Window>;
                  };
                }
              ).documentPictureInPicture.requestWindow(opts)
          : undefined))
      : undefined;

  let win: Window | null = null;
  if (pip) {
    try {
      win = await pip(size);
    } catch {
      // ⚠ PiP は user 操作の文脈が要る / 既に 1 枚出ていると失敗する ──
      //    落とさずに素の別窓へ落ちる(押して無反応にしない)
      win = null;
    }
  }
  if (!win) {
    const open = deps.open ?? ((u, t, f) => globalThis.open?.(u, t, f) ?? null);
    // ⚠ `about:blank` を開いて**こちらで組む** ── ObjectURL を直接開くと、
    //    窓の題名が blob の URL になり、user から見て「何の添付か」が分からない
    win = open(
      'about:blank',
      deps.windowName ?? '_blank',
      `popup,width=${size.width},height=${size.height}`,
    );
  }
  if (!win) {
    // 🔴 **開けなかったら、その場で捨てる**(押した数だけ blob が積もらない)
    lent.dispose();
    return null;
  }
  /**
   * ⚠ **組み立てで落ちても貸出を漏らさない**(2026-08-15、着地前レビューで指摘)。
   * 直す前は `fill()` が投げると `waitClose` の登録に**到達しない**ので、
   * 誰も revoke しないまま窓だけ残った(呼び側の `catch` も報告するだけ)。
   */
  try {
    fill(win.document, lent.url, title, kind, fit);
  } catch (e) {
    lent.dispose();
    try {
      win.close();
    } catch {
      // 閉じられなくても、貸出はもう返してある
    }
    throw e;
  }
  // ⚠ 待ちは投げっぱなしにしない(reject が unhandled にならないようにする)
  void waitClose(win).then(
    () => lent.dispose(),
    () => lent.dispose(),
  );
  return {
    close: () => {
      try {
        win.close();
      } catch {
        // 既に閉じている ── `waitClose` 側が捨てる
      }
    },
  };
}
