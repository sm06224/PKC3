/**
 * P7 段⑧: **boot が終わる前に別タブが交代させた**タブを救う。
 *
 * 🔴 段⑤ のレビュー(round-1 M-4)で「塞いでいない窓」として記録した経路を塞ぐ。
 * 起きる順番:
 *
 * 1. タブ B が lease 待ち(「別のタブで開いています…」)で止まる
 *    ── **storage worker はまだ作っていない**
 * 2. タブ A が「再読込」を押す → 新 SW が activate → **旧 build の cache を削除**
 *    + `clients.claim()` で B も新 SW に取られる
 * 3. B は「押していないタブは再読込しない」(段⑤ の設計)ので留まる。
 *    更新の案内も出ない ── 見張りは `startApp` の解決後にしか張られない
 * 4. A が閉じて B が lease を取る → **旧 build の hash 付き URL** で
 *    storage worker を作る → 新 cache に無い → network → Pages はツリーごと
 *    差し替わっていて 404 → **B は起動不能**
 *
 * → **boot が終わっていないタブは、交代に気づいたら黙って読み直す**。
 * ⚠ この判断が安全なのは「まだ何も持っていない」から ── 下書きも選択も無い。
 * 逆に boot 済みのタブを勝手に読み直すのは段⑤ が禁じたこと(下書きを巻き込む)。
 *
 * ⚠ **初回インストールと区別する**。初回の SW も `claim()` するので
 * `controllerchange` は来るが、それは「交代」ではない ── **登録時点で
 * 制御されていたか**で分ける(制御が無かった = 初回)。
 */

/** `navigator.serviceWorker` のうち、ここが要る部分だけ。 */
export interface PrebootTarget {
  readonly controller: unknown;
  addEventListener(type: 'controllerchange', listener: () => void): void;
}

export interface PrebootGuard {
  /** boot が終わった(以後は勝手に読み直さない)。 */
  booted(): void;
}

/**
 * boot 前の交代を見張る。⚠ **`startApp` より前**に呼ぶ ── lease 待ちで
 * 止まっている窓こそが対象なので、boot の解決を待っては意味がない。
 */
export function reloadOnPrebootSwap(container: PrebootTarget, reload: () => void): PrebootGuard {
  // ⚠ ここで読む。`controllerchange` の中で読むと**もう新しい方**になっている
  const hadController = Boolean(container.controller);
  let booted = false;
  let reloaded = false;
  container.addEventListener('controllerchange', () => {
    if (!hadController) return; // 初回インストールの claim(交代ではない)
    if (booted || reloaded) return; // boot 済みのタブは巻き込まない(段⑤)
    reloaded = true;
    reload();
  });
  return {
    booted() {
      booted = true;
    },
  };
}
