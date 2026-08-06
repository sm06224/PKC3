/**
 * 🔴 **確認が「出ていない」ことを検出する**(2026-08-06。user 報告 minor
 * 「確認ダイアログが抑止されるとボタンが恒久的に無反応」)。
 *
 * Chromium は user が「このページにこれ以上ダイアログを表示させない」を選ぶと、
 * 以後の `window.confirm()` を**何も表示せずに即 false** で返す。PKC3 の
 * 確認つき操作(削除 / ゴミ箱を空にする / 強制解放 / 素のまま起動 / 未使用添付の
 * 掃除)はどれも false = 取り消し扱いなので、**押しても 1 ドットも変わらない
 * ボタン**になる ── しかもその状態はタブを閉じるまで戻らない。
 *
 * ## 判定
 * **抑止を解除する手段は無い**(仕様どおり)。だからここがするのは
 * 「**黙らせない**」ことだけ ── 押した操作が消えた理由を言う。
 *
 * ⚠ 判定は**時間**で行う。人間が押して返るまでには最低でも数百 ms 掛かるが、
 * 抑止された `confirm` は**同期に**返る(0ms 台)。⚠ 閾値は緩めに取る ──
 * 誤って「抑止された」と言うほうが、黙って何も起きないより害が小さい
 * (どちらの場合も**操作は進めない**ので、安全側は変わらない)。
 *
 * ⚠ 逆向きの誤りは作れない ── `ok === true` のときは何も言わない。
 */

/** これより速く false が返ったら「表示されていない」と見なす(ms)。 */
export const SUPPRESSED_MS = 8;

export interface ConfirmResult {
  /** user が受けたか。⚠ 抑止されているときは常に false。 */
  ok: boolean;
  /** ダイアログが表示されなかった疑いがあるか(理由を出す側の合図)。 */
  suppressed: boolean;
}

export interface AskConfirmOptions {
  /** `window.confirm` の差し替え(test)。`undefined` を返す = confirm が無い環境。 */
  ask?: (message: string) => boolean | undefined;
  now?: () => number;
  /**
   * confirm が**無い**環境での既定(headless / 埋め込み)。
   * ⚠ 呼び側の倒し方をそのまま持ち込む ── 単発の削除は通す(`true`)、
   * 一括・不可逆は通さない(`false`)。ここで一律にしない。
   */
  whenAbsent: boolean;
}

export function askConfirm(message: string, opts: AskConfirmOptions): ConfirmResult {
  const ask =
    opts.ask ??
    ((m: string) =>
      typeof window !== 'undefined' && typeof window.confirm === 'function'
        ? window.confirm(m)
        : undefined);
  const now = opts.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
  const started = now();
  const answer = ask(message);
  if (answer === undefined) return { ok: opts.whenAbsent, suppressed: false };
  if (answer) return { ok: true, suppressed: false };
  return { ok: false, suppressed: now() - started < SUPPRESSED_MS };
}

/** 抑止されたときに出す 1 行(文言は 1 か所)。 */
export const SUPPRESSED_MESSAGE =
  '確認のダイアログがブラウザで止められているため、この操作は実行できません。' +
  'ページを再読込すると確認が出るようになります。';
