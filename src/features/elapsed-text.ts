/**
 * 🔴 **経過した時間の見せ方は、この 1 本だけが作る**(#279)。
 *
 * ⚠ **`features/asset/capture-text.ts` から出した**(#413 が最初に書いた)──
 *   タイマーが 2 本目を書くところだった。⚠ 同じ量を 2 通りの形で出すと、
 *   **収録の帯は `12:34`、タイマーの帯は `12 分 34 秒`** のように割れて、
 *   user は「別の量を見ている」と思う(#454 と同じ型)。
 *
 * ⚠ **pure module**。⚠ **時計を読まない** ── 経過は呼び側が引き算して渡す。
 *   🔑 これは「背面のタブでも狂わない」ための形でもある(#279)──
 *   **刻みを数えず、時刻の差分で数える**ので、ここは差分しか受け取らない。
 */

/** 2 桁に揃える。 */
const two = (n: number): string => String(n).padStart(2, '0');

/**
 * 経過(`0:07` / `12:34` / `1:02:03`)。
 * ⚠ 1 時間を超えたら**時を出す** ── 出さないと「62:03」になって読めない。
 * ⚠ 負の値は 0 に倒す(時計が巻き戻ることがある)。
 */
export function elapsedText(ms: number): string {
  const all = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(all / 3600);
  const m = Math.floor((all % 3600) / 60);
  const s = all % 60;
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
}

/**
 * 🔴 **`elapsedText` の逆**(#1232 段 b)── 文字起こしの行頭の `0:15` から、再生を始める位置(ms)を読む。
 *
 * ⚠ 綴りは `elapsedText` が作る形だけ(`m:ss` / `h:mm:ss`)。**秒は 2 桁・60 未満**、時が付くとき分も 2 桁・60 未満。
 *   別の綴り(`0:5` / `0:75` / `1:2:3` / 空)は **`null`**(呼び側は字のまま残す)。
 * ⚠ ミリ秒を扱う場所を増やさない ── 割り算は `elapsedText`、掛け算はここの 1 本だけが持つ。
 */
export function parseElapsed(text: string): number | null {
  const m = /^(?:(\d{1,2}):([0-5]\d)|([0-5]?\d)):([0-5]\d)$/.exec(text);
  if (m === null) return null;
  const h = m[1] === undefined ? 0 : Number(m[1]);
  const min = Number(m[1] === undefined ? m[3] : m[2]);
  const sec = Number(m[4]);
  return (h * 3600 + min * 60 + sec) * 1000;
}

/**
 * ミリ秒 → 秒(`HTMLMediaElement.currentTime` の単位)。⚠ 割り算をここに置くのは、
 * 「ミリ秒を扱う場所を増やさない」検査(`tests/features/elapsed-text.test.ts`)が `/ 1000` を数えるため。
 */
export function msToSeconds(ms: number): number {
  return ms / 1000;
}
