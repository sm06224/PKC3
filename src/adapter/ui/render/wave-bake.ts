/**
 * 🔴 **波形は「描いたら焼く」**(#1232。CLAUDE.md 2026-08-03)── 山の配列を canvas に 1 度だけ描き、
 * **PNG の `<img>` 1 枚**にして画面に置く(合成だけで済む)。canvas 自体は画面に残さない。
 *
 * ⚠ 返すのは ObjectURL。**表示の寿命の終わり(別の録音を鳴らす / 面を閉じる)で revoke する**のは
 *   呼び側(`captures.ts`)の仕事 ── 2026-07-27 の不可侵指示(生成物の即破棄)。
 * ⚠ canvas を作れない環境(test の happy-dom)は `null` ── 帯は出さない。
 */
export const WAVE_HEIGHT = 40;

/**
 * ⚠ 横は山 1 つ = 1 画素、**縦だけ `devicePixelRatio` 倍**で焼く(画像は CSS で枠いっぱいに伸ばす ──
 *   縦の線の太さ・上下の輪郭が高 DPR でも粗くならない。横を DPR 倍にしても山の数は増えないので意味がない)。
 */
export async function bakeWavePng(
  peaks: Float32Array,
  color: string,
  dpr: number = typeof devicePixelRatio === 'number' ? devicePixelRatio : 1,
): Promise<string | null> {
  if (peaks.length === 0) return null;
  const H = Math.max(1, Math.round(WAVE_HEIGHT * (dpr > 0 && Number.isFinite(dpr) ? Math.min(dpr, 3) : 1)));
  const canvas = document.createElement('canvas');
  canvas.width = peaks.length;
  canvas.height = H;
  const g = canvas.getContext('2d');
  if (g === null || typeof canvas.toBlob !== 'function') return null;
  g.fillStyle = color;
  const mid = H / 2;
  for (let i = 0; i < peaks.length; i++) {
    // ⚠ 小さい音も 1px は描く(無音の区間と見分けるため、極小の山は 1px の線にする)
    const h = Math.max(1, Math.round(peaks[i]! * H));
    g.fillRect(i, mid - h / 2, 1, h);
  }
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  // 🔑 焼いたら canvas の画素は捨てる(幅 0 にして backing store を返す)
  canvas.width = 0;
  canvas.height = 0;
  return blob === null ? null : URL.createObjectURL(blob);
}
