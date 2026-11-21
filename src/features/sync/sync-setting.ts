/**
 * 🔴 **端末間の同期(#2000)── 設定「端末間の同期」の鍵と、切のときの断り文**。
 *
 * - 鍵 `pkc3.sync`(`'1'` = 入 / それ以外 = 切)。⚠ **既定は切**: 切の間は同期の行を 1 本も書かず、同期の入口(書き出し・取り込み)も出さない。
 * - 正規の設定であって **フラグではない**(flags の 15 枠は使わない。`tests/flag-budget.test.ts`)。
 * - ⚠ **端末ごとの設定**(設定ファイルでは移さない側 = `SKIPPED_KEYS`)。同期のオン・オフまで別の端末へ運ぶと意味が変わる。
 *
 * ⚠ pure module。保存は adapter の `SyncEnabledStore`。
 */
export const SYNC_ENABLED_KEY = 'pkc3.sync';

/** 設定の画面の名前(設定画面の項目の見出しと、断り文が同じ字を使う)。 */
export const SYNC_SETTING_LABEL = '端末間の同期';

/** 切のときに差分ファイルを取り込もうとしたときの断り文(場所と押す物まで言う)。 */
export const SYNC_OFF_REFUSAL =
  `「${SYNC_SETTING_LABEL}」がオフになっているため、差分ファイル(.pkc3-diff.zip)は取り込めません。` +
  `設定の「${SYNC_SETTING_LABEL}」をオンにしてから、もう一度取り込んでください`;
