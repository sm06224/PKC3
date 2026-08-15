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

/** 窓の中身を組む。⚠ **`innerHTML` を使わない**(題名は user の文字である)。 */
function fill(doc: Document, url: string, title: string, kind: AssetWindowKind): void {
  doc.title = title;
  const style = doc.createElement('style');
  // ⚠ 地は無彩色(user 指示「地は無彩色、色は情報にだけ使う」)
  style.textContent =
    kind === 'image'
      ? // 画像を器いっぱいに引き伸ばさない ── `contain` で原寸比を保つ
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
  const waitClose = deps.waitClose ?? ((w) => waitForWindowClose(w));
  const size = SIZE[kind];
  // ⚠ PDF は PiP を使わない(狭すぎて頁が読めない ── file 冒頭の注記)
  const pip =
    kind === 'image'
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
    win = open('about:blank', '_blank', `popup,width=${size.width},height=${size.height}`);
  }
  if (!win) {
    // 🔴 **開けなかったら、その場で捨てる**(押した数だけ blob が積もらない)
    lent.dispose();
    return null;
  }
  fill(win.document, lent.url, title, kind);
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
