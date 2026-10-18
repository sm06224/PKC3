/**
 * 🔴 **板の付箋を動かした直後の「元に戻す」の知らせ**(依頼 118-2 / 236。Gemini の回答「推薦どおり」= 要る)。
 *
 * ## 何が起きていたか
 *
 * 付箋の移動・大きさ・回転・色・形・グループの解除は、本文の開き行の札だけを書き直す(履歴を伸ばさない amend)。
 * 間違えてドラッグしても、元の位置が分からず戻す道が無かった。
 *
 * ## 作り
 *
 * この書換の回だけ、書く**前**の本文を履歴の版として積み(`checkpoint`)、画面の下の知らせの隣に
 * 「元に戻す」を出す。押すと**直前の 1 手**が戻る(ゴミ箱へ移した直後・表の行を消した直後と同じ口 ── `restore-revision`)。
 * 新しい書込の道は作らない。
 *
 * ⚠ 出すのは**本文が実際に変わった回だけ**(`newBody === body` の回は呼び手が先に返す)。
 * ⚠ 付箋を消す・線を消す・字を直す・テンプレートで置く回は別の枝で既に履歴に積んでいる(ここへ足さない)。
 */
import type { BodyRewrite } from './body-rewrite';

/**
 * この書換が「元に戻す」を出す回なら、知らせの字。出さない回は `null`。
 * 🔑 字は**何をしたか**で言う(色・回転・大きさ・形・位置は別の言葉)。
 */
export function placeUndoNotice(rewrite: BodyRewrite): string | null {
  switch (rewrite.kind) {
    case 'place-move':
    case 'place-move-group':
      return '付箋を動かしました';
    case 'place-size':
      return '付箋の大きさを変えました';
    case 'place-rect':
      return '付箋の位置と大きさを変えました';
    case 'place-raise':
      return '付箋を前へ出しました';
    case 'place-lower':
      return '付箋を後ろへ送りました';
    case 'place-shape':
      return '付箋の形を変えました';
    case 'place-group':
      return '付箋をグループにしました';
    case 'place-ungroup':
      return '付箋のグループを解きました';
    case 'place-style': {
      const st = rewrite.style;
      if (st.rotate !== undefined) return '付箋の回転を変えました';
      if (st.size !== undefined) return '付箋の文字の大きさを変えました';
      if (st.width !== undefined) return '線の太さを変えました';
      if (st.arrow !== undefined) return '線の矢じりを変えました';
      return '色を変えました';
    }
    default:
      return null;
  }
}
