/**
 * 「いま打鍵中か」を 1 か所で答える(#1467)。
 *
 * 図の先読み(`mermaid-hydrate.ts`)は、空き時間に画面の外の図を焼き進める。
 * ⚠ 長いノートでは、焼いた絵を載せるたびに文書全体の配置がやり直しになるので、
 *   **打っている最中に載せると、その打鍵の描画が遅れる**(先読みの設計コメントは
 *   「入力が来たら止める」と言っていたが、止める仕掛けが無かった)。
 *
 * 🔑 止めるのは**始める側だけ**。焼いている最中の物は終わらせる(途中で捨てると無駄になる)。
 * 🔑 画面に見えている図は止めない(`IntersectionObserver` の経路はここを通らない ──
 *   見えている図が原文のまま残るのは、先読みの遅れより悪い)。
 */

/** 最後の入力からこの時間が空いたら、打鍵は止まったと見なす。 */
export const TYPING_QUIET_MS = 1000;

let lastInputAt = Number.NEGATIVE_INFINITY;
/** ⚠ 単調な時計で測る(`Date.now` は OS の時計の巻き戻しで「未来の入力」を作り、先読みが止まり続ける)。 */
const clock = (): number => performance.now();
let installed = false;

/** 入力が来たことを控える(listener と test の両方がここを通る)。 */
export function noteTyping(now: number = clock()): void {
  lastInputAt = now;
}

/** 控えを捨てる(test 用。製品は触らない)。 */
export function resetTyping(): void {
  lastInputAt = Number.NEGATIVE_INFINITY;
}

function install(): void {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  // ⚠ capture ── 編集欄が伝播を止めても拾う。`input` は文字の入力・貼り付け・削除で飛ぶ
  document.addEventListener('input', () => noteTyping(), true);
}
// 🔑 読み込んだときに付ける(最初に聞かれたときだと、図を作った最初の打鍵を取りこぼす ──
//    smoke で実測: 打ち始めてすぐ、画面の外の図が 7 枚焼かれた)。listener は 1 本だけ
install();

/** 打鍵が止まるまでの残り時間(ms)。0 なら止まっている(= 先読みを進めてよい)。 */
export function typingQuietIn(now: number = clock()): number {
  install();
  // ⚠ 頭打ち ── 何が起きても、待つのは静かな時間 1 回ぶんまで
  return Math.min(TYPING_QUIET_MS, Math.max(0, lastInputAt + TYPING_QUIET_MS - now));
}
