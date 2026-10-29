/**
 * 🔴 **PKC を「アプリとして入れて」開いているか**(#884 段③)。
 *
 * ブラウザのタブで使っているときは false。入れたアプリの窓(`display-mode` が
 * standalone / minimal-ui / window-controls-overlay)か、iOS のホーム画面から
 * 開いたとき(`navigator.standalone`)に true。
 *
 * ⚠ 使うのは「アプリの開き方」の選択肢を出すかの判定だけ(`appOpenChoicesVisible`)。
 * ⚠ `matchMedia` が無い環境(古い WebView / test)は false ── 呼び側の
 *   「既定と違う値を選んである人には出す」で、選んだ値を戻せない片道は防ぐ。
 */
/**
 * ⚠ `fullscreen` は含めない ── F11 でブラウザを全画面にしただけでも `display-mode: fullscreen` が立つ。
 *   アプリとして入れた窓ではないので、入れている扱いにしてはいけない。
 */
const INSTALLED_MODES = ['standalone', 'minimal-ui', 'window-controls-overlay'];

export function isInstalledApp(): boolean {
  try {
    if (
      typeof navigator !== 'undefined' &&
      (navigator as { standalone?: boolean }).standalone === true
    ) {
      return true;
    }
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
    return INSTALLED_MODES.some((m) => window.matchMedia(`(display-mode: ${m})`).matches);
  } catch {
    return false;
  }
}
