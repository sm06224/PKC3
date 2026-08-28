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
   * 🔴 **画像の見せ方**(#527 案 A。user 指示 2026-08-28
   * 「**別ウィンドウで実寸で開いて拡大縮小できるようにしてほしい**」)。
   *
   * | 値 | 何が起きるか | 誰が使うか |
   * |---|---|---|
   * | `'contain'`(既定) | 窓に**収まるまで縮める** | 添付の画像(#192。**1 バイトも変えない**) |
   * | `'natural'` | **実寸で出し、拡大縮小できる** | 図(#527) |
   *
   * ⚠ **既定を `'contain'` にしてある**のは、添付の見え方を変えないためである
   *   ── あちらは「1 枚の絵を横に置く」用途で、収まっているのが正しい。
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
 * 🔴 **実寸で出し、拡大縮小できるようにする**(#527 案 A)。
 *
 * ⚠ **`transform: scale()` を使わない** ── 拡大した分だけ**送れる**必要があるので、
 *   `width` を直に動かして**ブラウザの scroll に任せる**ほうが素直である
 *   (`transform` だと器の大きさが変わらず、はみ出した所へ届かない ──
 *   #527 と #523 で 2 度踏んだ「見えない所へ届く手段が無い」と同じ形になる)。
 * 🔴 **ボタンを置く**(不可侵指示「マウスだけで完結し、キーボードは近道」)──
 *   `Ctrl+ホイール` だけにすると**キーボードが要る**ことになる。
 * ⚠ **素のホイールは送りのまま**にする ── 実寸の図は窓より大きいのが普通なので、
 *   奪うと**見えない所へ届かなくなる**。拡大はボタンと `Ctrl+ホイール` から。
 */
function addZoom(doc: Document, img: HTMLImageElement): void {
  const bar = doc.createElement('div');
  bar.setAttribute('data-pkc-field', 'asset-window-zoom');
  let z = 1;
  // ⚠ **`naturalWidth` は読み込み後にしか入らない**ので、当てるのは load の後
  const apply = (): void => {
    const w = img.naturalWidth;
    if (w > 0) img.style.width = `${Math.round(w * z)}px`;
    pct.textContent = `${Math.round(z * 100)}%`;
  };
  const set = (next: number): void => {
    // ⚠ 上下限を置く ── 0 倍にすると**消えて戻せなくなる**
    z = Math.max(0.1, Math.min(8, next));
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
  const pct = doc.createElement('span');
  pct.setAttribute('data-pkc-field', 'asset-window-zoom-pct');
  bar.append(
    button('−', '小さくする', () => set(z / 1.25)),
    button('＋', '大きくする', () => set(z * 1.25)),
    button('等倍', '実寸に戻す', () => set(1)),
    pct,
  );
  doc.body.append(bar);
  // ⚠ 既に読み込み済み(cache)なら `load` は来ない ── 両方から当てる
  img.addEventListener('load', apply);
  if (img.complete) apply();
  // 🔑 近道は `Ctrl`(mac は `Command`)+ ホイール ── 素のホイールは送りのまま
  doc.addEventListener(
    'wheel',
    (ev) => {
      if (!ev.ctrlKey && !ev.metaKey) return;
      ev.preventDefault();
      set(ev.deltaY < 0 ? z * 1.1 : z / 1.1);
    },
    { passive: false },
  );
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
      ? natural
        ? /**
           * 🔴 **実寸で出す**(#527 案 A)── `max-width` を当てない。
           * ⚠ はみ出した分は **`overflow:auto` で送れる**ようにする ──
           *   送れないと「大きく見えるが端が見えない」になり、
           *   #527 / #523 で 2 度直した穴をここで作り直すことになる。
           */
          'html,body{margin:0;height:100%;background:#1b1b1b;overflow:auto}' +
          'img{display:block}' +
          // 拡大縮小の帯 ── 常に手前・小さく(絵の邪魔をしない)
          '[data-pkc-field="asset-window-zoom"]{position:fixed;top:8px;right:8px;' +
          'display:flex;gap:4px;align-items:center;background:#000a;padding:4px 6px;' +
          'border-radius:4px;font:12px system-ui,sans-serif;color:#ddd}' +
          '[data-pkc-field="asset-window-zoom"] button{font:inherit;cursor:pointer;' +
          'background:#333;color:#eee;border:1px solid #555;border-radius:3px;padding:2px 7px}'
        : // 画像を器いっぱいに引き伸ばさない ── `contain` で原寸比を保つ
          'html,body{margin:0;height:100%;background:#1b1b1b;display:grid;place-items:center}' +
          'img{max-width:100%;max-height:100%;object-fit:contain}'
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
    if (natural) addZoom(doc, img);
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
    'この browser は PDF を画面に出せません。元の画面の「ダウンロード」から保存して開いてください。';
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
