/**
 * ランチャーのアプリに貸した保存領域を、**PKC3 側から読む**(P8 段⑭)。
 *
 * 🔑 PKC3 と外殻(blob:)は**同じ origin** なので、外殻が書いた
 * `localStorage` はここからそのまま読める ── 起動時に seed として焼き込む。
 *
 * ⚠ **ノートのデータではない**。書き出し(export)には含めない ──
 * container にも添付にも入らないので、何もしなければ自然にそうなる。
 * 「アプリの保存データを復元で取り込むか」は設計 doc §3 の論点で、
 * **既定は取り込まない**(= ここに手を入れない)。
 */
import { appStoragePrefix } from '@features/launcher/app-storage-shim';

/**
 * 1 アプリぶんの保存内容を読む。
 * ⚠ 読めない環境(プライベートブラウズ等)でも**空で返す** ── 起動そのものは
 * 続けたい(保存が効かないだけで、アプリは動く)。
 */
export function readAppStorage(appId: string): Readonly<Record<string, string>> {
  const prefix = appStoragePrefix(appId);
  const out: Record<string, string> = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k === null || !k.startsWith(prefix)) continue;
      const v = localStorage.getItem(k);
      if (v !== null) out[k.slice(prefix.length)] = v;
    }
  } catch {
    // 使えない環境でも落ちない
  }
  return out;
}

/**
 * 1 アプリぶんを捨てる(添付を消したときの後始末)。
 * ⚠ **前方一致で消す** ── 鍵の一覧を別に持つと、片方だけ残って幽霊が出る。
 */
export function clearAppStorage(appId: string): void {
  const prefix = appStoragePrefix(appId);
  try {
    const doomed: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k !== null && k.startsWith(prefix)) doomed.push(k);
    }
    for (const k of doomed) localStorage.removeItem(k);
  } catch {
    // 使えない環境でも落ちない
  }
}
