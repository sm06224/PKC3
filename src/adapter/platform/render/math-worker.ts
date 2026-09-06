/**
 * 数式を描くワーカー(#707)。
 *
 * > user 指示 2026-08-03(不可侵)「**基本的に重い処理はワーカーにしてください**」
 *
 * 🔑 KaTeX の `renderToString` は **DOM を 1 行も触らない**(文字列 → 文字列)ので、
 * そのままここへ持って来られる ── markdown の描画をワーカーへ出せたのと同じ理由。
 *
 * 🔴 **ここへ置くと、KaTeX が主の塊に入らない** ── `import()` はこの worker の
 * 塊にだけ効くので、数式を 1 つも書いていない user は **1 バイトも読み込まない**。
 * ⚠ 「配る量は気にしない。効くのは定常」(user 指示 2026-08-03)の**定常の側**である。
 *
 * ⚠ **まとめて受ける** ── 1 文書に数式が 100 個あるとき、1 個ずつ往復すると
 * 100 往復になる。呼び側が集めて 1 回で投げる。
 *
 * ⚠ **例外を握り潰さない** ── 1 つが壊れても残りは返す(`ok:false` を混ぜる)。
 * 落ちたものは呼び側が**原文のまま残す**ので、白紙にはならない。
 */

export interface MathJob {
  /** 描く式(TeX)。`display` は中央寄せの形か。 */
  items: readonly { tex: string; display: boolean }[];
}

/** 1 件の結果。⚠ `ok:false` でも `error` を必ず載せる(理由を画面へ出すため)。 */
export type MathResult = { ok: true; html: string } | { ok: false; error: string };

const ctx = self as unknown as {
  onmessage: ((ev: MessageEvent<{ id: number; payload: MathJob }>) => void) | null;
  postMessage(msg: unknown): void;
};

ctx.onmessage = (ev): void => {
  const { id, payload } = ev.data;
  void (async (): Promise<void> => {
    try {
      // ⚠ **遅延 import** ── 依頼が 1 件も来なければ読み込まない
      const katex = (await import('katex')).default;
      const out: MathResult[] = payload.items.map((it) => {
        try {
          return {
            ok: true,
            html: katex.renderToString(it.tex, {
              displayMode: it.display,
              /**
               * 🔴 **投げさせる**(着地前レビュー 2026-09-06・欠陥 3)。
               *
               * ⚠ 1 稿目は `throwOnError: false` だった。名前に反して
               *   **「投げない」ではなく「赤い字の span を返す」**である
               *   (`katex.mjs` の `makeSpan(['katex-error'])` + `color:#cc0000` の
               *   inline style + `title` に**英語**のエラー)。
               * 🔴 それは `ok: true` で返るので、呼び側が**打った字を捨てて**
               *   赤字に差し替えていた ── `math-hydrate.ts` の docstring と
               *   `app.css` の注記と マニュアルが揃って
               *   「**式が壊れていても打った字が残る**」と書いているのに、
               *   **実装だけが違うことをしていた**。
               * 🔑 投げさせて `ok:false` で返せば、呼び側が原文を残す ──
               *   3 つの記述と実装が同じことを言う形になる。
               * ⚠ 面は落ちない(下の `catch` が 1 件ずつ受ける)。
               */
              throwOnError: true,
              // ⚠ 読み上げのために MathML も出す(KaTeX の既定)
              output: 'htmlAndMathml',
              strict: false,
            }),
          };
        } catch (e) {
          return { ok: false, error: String(e).slice(0, 200) };
        }
      });
      ctx.postMessage({ id, ok: true, result: out });
    } catch (e) {
      // ⚠ KaTeX 自体が読めなかった ── 呼び側は原文のまま残す
      ctx.postMessage({ id, ok: false, error: String(e) });
    }
  })();
};
