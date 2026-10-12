/**
 * 🔴 **長大なノートの判定**(#1467、裁定 21 = A。#1163 コメント 6125362939)。
 *
 * 20,000 行のノートは、開くだけで本文全体の style + layout(約 750 ms)を同期に払う。
 * 画面の外の塊の配置を飛ばす(`content-visibility: auto`)のは、**この長さを超えたノートだけ**にする
 * ── 5,000 行以下のノートは 1 ピクセルも変えない。
 * 🔑 しきい値と数え方はここ **1 か所**(読む面の器に印を付ける判定。§7)。
 */
export const LONG_NOTE_LINES = 5000;

/**
 * 本文が {@link LONG_NOTE_LINES} 行を**超える**か(ちょうど 5,000 行は含めない)。
 * 行数 = 改行の数 + (最後が改行で終わらなければ 1)── 末尾の改行 1 つで「1 行増えた」ことにしない
 * (`.md` を取り込むと末尾が改行の本文が多い。5,000 行の file は 5,000 行と数える)。
 */
export function isLongNote(body: string): boolean {
  // split すると 20,000 行ぶんの配列を作るので、数えるだけにする
  let newlines = 0;
  let at = -1;
  while ((at = body.indexOf('\n', at + 1)) !== -1) {
    // 改行が LONG_NOTE_LINES を超えたら、末尾の扱いに関わらず超えている
    if (++newlines > LONG_NOTE_LINES) return true;
  }
  const lines = newlines + (body.length > 0 && !body.endsWith('\n') ? 1 : 0);
  return lines > LONG_NOTE_LINES;
}
