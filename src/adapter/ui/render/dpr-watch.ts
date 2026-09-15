/**
 * 🔴 **拡大率(`devicePixelRatio`)が変わったら知らせる**(#953)。
 *
 * ⚠ `matchMedia` に「dpr が変わった」を直接聞く口は無いので、**いまの値に
 *   一致する問い**を張り、外れたら**張り直す**(外れた = 変わった)。
 *   ブラウザのズームでも、窓を別の密度の画面へ動かしても、この形で拾える。
 *
 * 🔑 この仕掛けはもともと `mermaid-hydrate.ts`(図の焼き直し。段㉘)だけが
 *   持っていた。#953(段組みの罫線が拡大率で滲む)を直すのに
 *   `read-columns.ts` にも同じ入力が要ると分かったので、ここへ出した ──
 *   **同じ判定を 2 か所に書くと、片方だけ直して片方が壊れたままになる**
 *   (CLAUDE.md §7)。
 *
 * ⚠ **呼ぶたびに、独立した問いを 1 本張る**(呼び出し元をまたいで
 *   1 本に相乗りさせてはいない)。図の焼き直しは render のたびに作っては
 *   畳む短命な物、段組みは起動時に張って畳まない長命な物 ── 寿命が違う
 *   2 つを 1 本の観測器に相乗りさせると、片方を畳んだ拍子に
 *   もう片方まで聞こえなくなる事故を作る。**共有するのは「仕組み」であって
 *   「観測器そのもの」ではない**。
 *
 * @param onChange 拡大率が変わるたびに呼ぶ
 * @returns 外す関数(呼ぶまで張りっぱなし)
 */
export function watchDevicePixelRatio(onChange: () => void): () => void {
  let mq: MediaQueryList | null = null;
  let disposed = false;
  const onDpr = (): void => {
    arm();
    onChange();
  };
  function arm(): void {
    if (disposed || typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }
    mq?.removeEventListener('change', onDpr);
    mq = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    mq.addEventListener('change', onDpr);
  }
  arm();
  return () => {
    disposed = true;
    mq?.removeEventListener('change', onDpr);
    mq = null;
  };
}
