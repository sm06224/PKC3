/**
 * 🔴 **この端末に、設定を保存できるか**(#1087)。
 *
 * ⚠ 設定の保存先(`localStorage`)を使えないブラウザ(プライベートブラウズ / 「すべての Cookie をブロック」)では、
 *   配色・文字の大きさ・ページ設定など 20 を超える設定が、どれも**黙って**保存に失敗する
 *   (各 store の `catch` は「この session では効いている」で止まる)。設定の字は「この端末で覚えます」と
 *   言っているので、次に開くと元に戻り、約束が黙って破れる。
 * 🔑 store ごとに知らせを足さない ── 失敗の原因は 1 つ(保存先が使えない)なので、システムの画面で
 *   **1 度だけ**言う(判定もここ 1 か所)。
 * ⚠ 読めるだけでは足りない(書くと例外になるブラウザがある)── 書いて消すまでを試す。
 */
const PROBE_KEY = 'pkc3.settings-probe';

export function canPersistSettings(storage: () => Storage | null): boolean {
  try {
    const s = storage();
    if (s === null) return false;
    s.setItem(PROBE_KEY, '1');
    s.removeItem(PROBE_KEY);
    return true;
  } catch {
    return false;
  }
}

/** 保存できないときに「設定」の見出しの下へ出す 1 行。 */
export const SETTINGS_NOT_PERSISTED_TEXT =
  'このブラウザは設定を保存できない状態です(プライベートブラウズ中など)。ここで変えた設定は、PKC3 を閉じると元に戻ります';

export function defaultSettingsStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}
