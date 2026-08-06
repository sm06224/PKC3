/**
 * markdown を描くワーカー(P8 段⑨)。
 *
 * > user 指示 2026-08-03(不可侵)「**基本的に重い処理はワーカーにしてください**」
 *
 * 🔑 `renderMarkdown` は **DOM を 1 行も触らない**(文字列 → 文字列)ので、
 * そのままここへ持って来られる ── features 層が browser API を持たない、という
 * このリポジトリの層規約が、そのまま「ワーカーへ出せる」を意味していた。
 *
 * ⚠ 返すのは HTML **文字列**。`innerHTML` への流し込み(= HTML の parse)は
 * メインスレッドに残る ── そこは DOM なので動かせない。重いのは markdown の
 * tokenize と render のほうである。
 *
 * ⚠ 例外を握り潰さない ── 落ちたら `ok:false` で返す(呼び側が同期描画へ
 * 落とせるように。**黙って白紙**にしない)。
 */
import {
  renderMarkdown,
  type RenderMarkdownOptions,
  type SourceRange,
} from '@features/markdown/markdown-render';

export interface MarkdownJob {
  text: string;
  opts: RenderMarkdownOptions;
  /**
   * 🔴 **行の対応表も返す**(2026-08-05。ライブエディタ S5)。
   * ⚠ `opts.collectRanges` を**そのまま渡せない** ── 配列を渡して mutate させる
   * 形なので、構造化複製を跨いだら結果が戻らない。ここで受けて結果に載せる。
   */
  withRanges?: boolean;
}

interface Incoming {
  id: number;
  payload: MarkdownJob;
}

const ctx = self as unknown as {
  onmessage: ((ev: MessageEvent<Incoming>) => void) | null;
  postMessage(msg: unknown): void;
};

ctx.onmessage = (ev: MessageEvent<Incoming>): void => {
  const { id, payload } = ev.data;
  try {
    if (payload.withRanges === true) {
      const ranges: SourceRange[] = [];
      const html = renderMarkdown(payload.text, { ...payload.opts, collectRanges: ranges });
      ctx.postMessage({ id, ok: true, result: { html, ranges } });
      return;
    }
    ctx.postMessage({ id, ok: true, result: renderMarkdown(payload.text, payload.opts) });
  } catch (e) {
    ctx.postMessage({ id, ok: false, error: String(e) });
  }
};
