/**
 * 選択の履歴(戻る・進む)── #190 / 台帳 #180 の B-4。
 *
 * 🔴 **pure module**。ブラウザの履歴(`history.back`)は使わない ── PKC3 は
 * 単一ページで、戻るはアプリ内の**選択**の話である(URL を汚さない = 不可侵の
 * 「クエリパラメータを抜け穴にしない」と同じ向き)。
 *
 * 意味論は браузер の履歴と同じにする(user が知っている挙動に合わせる):
 * - 新しく選ぶと、**進む側は捨てられる**(枝を作らない)
 * - 同じものを続けて選んでも積まない
 * - 戻る・進むで動いたときは**積まない**(でないと戻れなくなる)
 */
export interface SelectionHistory {
  /** 過去(古い順)。末尾が「いま」。 */
  readonly past: readonly string[];
  /** 未来(戻ったぶん)。⚠ 新しく選ぶと捨てる。 */
  readonly future: readonly string[];
}

export const EMPTY_HISTORY: SelectionHistory = Object.freeze({ past: [], future: [] });

/** いま選んでいるもの(履歴の上では末尾)。 */
export function current(h: SelectionHistory): string | null {
  return h.past.length === 0 ? null : (h.past[h.past.length - 1] ?? null);
}

/**
 * 新しく選んだ。⚠ **同じものは積まない**(打鍵や再描画で同じ lid が何度も来る)。
 * ⚠ 上限を置く ── 置かないと長いセッションで無限に伸びる。
 */
export const HISTORY_MAX = 50;

export function pushSelection(h: SelectionHistory, lid: string): SelectionHistory {
  if (current(h) === lid) return h;
  const past = [...h.past, lid];
  return {
    past: past.length > HISTORY_MAX ? past.slice(past.length - HISTORY_MAX) : past,
    future: [], // 新しい選択で枝を捨てる
  };
}

export function canGoBack(h: SelectionHistory): boolean {
  return h.past.length >= 2;
}

export function canGoForward(h: SelectionHistory): boolean {
  return h.future.length >= 1;
}

/** 戻る。⚠ 戻れないときは**そのまま返す**(呼び側が「変わらなかった」と分かる)。 */
export function goBack(h: SelectionHistory): SelectionHistory {
  if (!canGoBack(h)) return h;
  const past = h.past.slice(0, -1);
  const moved = h.past[h.past.length - 1] as string;
  return { past, future: [moved, ...h.future] };
}

export function goForward(h: SelectionHistory): SelectionHistory {
  if (!canGoForward(h)) return h;
  const [next, ...rest] = h.future as [string, ...string[]];
  return { past: [...h.past, next], future: rest };
}

/**
 * 消えた lid を履歴から落とす。⚠ 削除・取込のあとに呼ぶ ── 落とさないと
 * 「戻る」が**存在しないノート**へ飛び、無言で何も起きない dead click になる。
 * ⚠ 連続した重複も畳む(間の 1 件だけ消えた場合)。
 */
export function pruneHistory(
  h: SelectionHistory,
  exists: (lid: string) => boolean,
): SelectionHistory {
  const dedupe = (xs: readonly string[]): string[] => {
    const out: string[] = [];
    for (const x of xs) {
      if (!exists(x)) continue;
      if (out.length > 0 && out[out.length - 1] === x) continue;
      out.push(x);
    }
    return out;
  };
  return { past: dedupe(h.past), future: dedupe(h.future) };
}
