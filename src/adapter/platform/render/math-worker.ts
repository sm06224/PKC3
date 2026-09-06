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
              // 🔴 **投げさせない** ── 1 つの書き間違いで面が落ちない
              throwOnError: false,
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
