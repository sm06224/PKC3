/**
 * ノートに埋め込んだウィジェット(` ```html id="…" ` / ` ```react id="…" `)の保存領域を、**親(PKC3)の側で**読み書きする
 * (v4.0 Phase 2 / PR-07)。
 *
 * 🔑 置き場所は PKC3 の origin の `localStorage`(ランチャーのアプリの保存領域 `app-storage.ts` と同じ考え方)。
 *   名前空間は `widgetStoragePrefix(lid, widgetId)` 1 か所で決める(`.` を符号化して越境させない)。
 * 🔴 **上限は親でも数える**(`WIDGET_STORAGE_LIMIT`)── 箱の中の shim の上限は「本物の意味論を見せる」ためのもので、
 *   箱は shim を使わずに `parent.postMessage` を直に投げられる。信頼できるのはこちら側だけ。
 * ⚠ **ノートのデータではない** ── 書き出し・バックアップには含めない(アプリの保存領域と同じ扱い)。
 * ⚠ 使えない環境(プライベートブラウズ等)でも落ちない ── 保存が効かないだけで、ウィジェットは動く。
 */
import {
  WIDGET_STORAGE_LIMIT,
  WIDGET_STORAGE_ROOT,
  WIDGET_TOTAL_STORAGE_LIMIT,
  widgetEntryPrefix,
  widgetStoragePrefix,
} from '@features/markdown/widget-bridge';

/** 箱から届く保存の差分(親が検証した後の形)。 */
export type WidgetStorageOp =
  | { readonly op: 'set'; readonly key: string; readonly value: string }
  | { readonly op: 'remove'; readonly key: string }
  | { readonly op: 'clear' };

/**
 * 使用量(字数)を数える ── このウィジェットの分と、全ウィジェットの合計。
 * 🔴 **毎回数える**(覚えない)── 覚えると、別のタブが同じウィジェットへ書いた分を数え落とし、
 *   親の上限が実際より緩く働く(PR-07 レビュー)。1 つ 512 KB・合計 2 MB までなので、走査は軽い。
 */
function usage(prefix: string): { readonly mine: number; readonly total: number } {
  let mine = 0;
  let total = 0;
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k === null || !k.startsWith(WIDGET_STORAGE_ROOT)) continue;
    const n = k.length + (localStorage.getItem(k) ?? '').length;
    total += n;
    if (k.startsWith(prefix)) mine += n - prefix.length;
  }
  return { mine, total };
}

function keysWith(prefix: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k !== null && k.startsWith(prefix)) out.push(k);
  }
  return out;
}

/** 1 ウィジェットぶんの保存内容(箱へ `seed` として焼く)。 */
export function readWidgetStorage(lid: string, widgetId: string): Readonly<Record<string, string>> {
  const prefix = widgetStoragePrefix(lid, widgetId);
  const out: Record<string, string> = {};
  try {
    for (const k of keysWith(prefix)) {
      const v = localStorage.getItem(k);
      if (v !== null) out[k.slice(prefix.length)] = v;
    }
  } catch {
    // 使えない環境でも落ちない
  }
  return out;
}

/** 保存が 1 件でも在るか(「状態を初期化」を押せるか)。 */
export function hasWidgetStorage(lid: string, widgetId: string): boolean {
  try {
    return keysWith(widgetStoragePrefix(lid, widgetId)).length > 0;
  } catch {
    return false;
  }
}

/**
 * 差分を 1 つ当てる。上限を超える書込・書けなかった書込は `false`(箱へ返して像を巻き戻させる)。
 * 🔴 `lid` / `widgetId` は**親の DOM が持っている値**を渡すこと(箱の名乗りを使わない)。
 */
export function applyWidgetStorageOp(lid: string, widgetId: string, op: WidgetStorageOp): boolean {
  const prefix = widgetStoragePrefix(lid, widgetId);
  try {
    if (op.op === 'set') {
      const key = String(op.key);
      const value = String(op.value);
      const { mine, total } = usage(prefix);
      const prev = localStorage.getItem(prefix + key);
      const delta = key.length + value.length - (prev === null ? 0 : key.length + prev.length);
      // 🔑 1 つあたり(鍵と値の字数)と、全ウィジェットの合計(前置きの字数も含めて数える)の 2 つの門
      if (mine + delta > WIDGET_STORAGE_LIMIT) return false;
      const fullDelta = delta + (prev === null ? prefix.length : 0);
      if (total + fullDelta > WIDGET_TOTAL_STORAGE_LIMIT) return false;
      localStorage.setItem(prefix + key, value);
      return true;
    }
    if (op.op === 'remove') {
      const key = String(op.key);
      localStorage.removeItem(prefix + key);
      return true;
    }
    clearWidgetStorage(lid, widgetId);
    return true;
  } catch {
    // ⚠ 書けなかった(origin の枠が一杯など)── 断る(箱は像を巻き戻す)
    return false;
  }
}

/** 1 ウィジェットぶんを捨てる(「状態を初期化」)。⚠ 前方一致で消す(鍵の一覧を別に持たない)。 */
export function clearWidgetStorage(lid: string, widgetId: string): void {
  const prefix = widgetStoragePrefix(lid, widgetId);
  try {
    for (const k of keysWith(prefix)) localStorage.removeItem(k);
  } catch {
    // 使えない環境でも落ちない
  }
}

/**
 * 1 ノートぶんのウィジェットの保存を全部捨てる。
 * 🔴 呼ぶのは**ノートが戻せなくなるとき**(ゴミ箱を空にする)だけ ── ゴミ箱へ送っただけでは消さない
 *   (戻したノートのウィジェットが 0 件になる。`store-port.ts` の `purgeTrash` と同じ意味論)。
 */
export function clearEntryWidgetStorage(lid: string): void {
  const prefix = widgetEntryPrefix(lid);
  try {
    for (const k of keysWith(prefix)) localStorage.removeItem(k);
  } catch {
    // 使えない環境でも落ちない
  }
}

