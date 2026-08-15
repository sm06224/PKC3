/**
 * 画像を**別の窓で見る**(#192 / 台帳 #180 の D-2)── 添付を見ながら書くため。
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
 */
import { waitForWindowClose } from './window-close';

/** 別窓に見えている 1 枚。⚠ `close()` は**呼ばれなくても**寿命は守られる。 */
export interface ImageWindowHandle {
  /** こちらから閉じる(閉じれば ObjectURL も戻る)。 */
  close(): void;
}

export interface OpenImageWindowDeps {
  /** 画像の ObjectURL と、その捨て方(`lendObjectUrl` が返す組)。 */
  lent: { url: string; dispose: () => void };
  /** 窓の題名(= 添付の名前)。⚠ **文字として入れる**(HTML を組み立てない)。 */
  title: string;
  /** 素の別窓を開く(既定 `window.open`)。⚠ test が差せる。 */
  open?: (url: string, target: string, features: string) => Window | null;
  /** Document PiP(無い環境が普通 ── 既定は `documentPictureInPicture`)。 */
  requestPip?: (opts: { width: number; height: number }) => Promise<Window>;
  /** 閉じるのを待つ(既定は `waitForWindowClose`。⚠ test が時計を差せる)。 */
  waitClose?: (win: { closed: boolean }) => Promise<void>;
}

/** 窓の中身を組む。⚠ **`innerHTML` を使わない**(題名は user の文字である)。 */
function fill(doc: Document, url: string, title: string): void {
  doc.title = title;
  const style = doc.createElement('style');
  // ⚠ 地は無彩色(user 指示「地は無彩色、色は情報にだけ使う」)。画像を器いっぱいに
  //   引き伸ばさない ── `contain` で原寸比を保つ
  style.textContent =
    'html,body{margin:0;height:100%;background:#1b1b1b;display:grid;place-items:center}' +
    'img{max-width:100%;max-height:100%;object-fit:contain}';
  const img = doc.createElement('img');
  img.src = url;
  img.alt = title;
  img.setAttribute('data-pkc-field', 'image-window-image');
  doc.head.append(style);
  doc.body.textContent = '';
  doc.body.append(img);
}

/**
 * 画像を別窓で開く。
 * @returns 開けたら handle、開けなければ `null`(⚠ そのとき `lent` は**捨て済み**)
 */
export async function openImageWindow(
  deps: OpenImageWindowDeps,
): Promise<ImageWindowHandle | null> {
  const { lent, title } = deps;
  const waitClose = deps.waitClose ?? ((w) => waitForWindowClose(w));
  const pip =
    deps.requestPip ??
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
      : undefined);

  let win: Window | null = null;
  if (pip) {
    try {
      win = await pip({ width: 480, height: 360 });
    } catch {
      // ⚠ PiP は user 操作の文脈が要る / 既に 1 枚出ていると失敗する ──
      //    落とさずに素の別窓へ落ちる(押して無反応にしない)
      win = null;
    }
  }
  if (!win) {
    const open = deps.open ?? ((u, t, f) => globalThis.open?.(u, t, f) ?? null);
    // ⚠ `about:blank` を開いて**こちらで組む** ── ObjectURL を直接開くと、
    //    窓の題名が blob の URL になり、user から見て「何の画像か」が分からない
    win = open('about:blank', '_blank', 'popup,width=480,height=360');
  }
  if (!win) {
    // 🔴 **開けなかったら、その場で捨てる**(押した数だけ blob が積もらない)
    lent.dispose();
    return null;
  }
  fill(win.document, lent.url, title);
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
