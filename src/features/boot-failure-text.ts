/**
 * 🔴 **起動に失敗したときの字**(#1087)。
 *
 * ⚠ 直す前は、例外の英語をそのまま出していた(「起動に失敗しました: db user_version 5 is newer than supported 4」)。
 *   いちばん多い原因(新しいバージョンで保存したデータを、古いバージョンで開いた)でも、
 *   何が起きたか・データが無事か・どうすればよいかが読めなかった。
 * 🔑 原因が分かる物だけを日本語にする。分からない物は**詳細を消さない**(バグ報告の手がかり)。
 */
import { errorMessageJa, QUOTA_MESSAGE } from './error-text';
import { looksCorrupt } from './storage/db-corruption';

const NEWER_DB = /db user_version (\d+) is newer than supported (\d+)/;
/** 保存領域を開けない(ほかのタブが握っている・権限・ブラウザの状態)。 */
const CANT_OPEN = /SQLITE_CANTOPEN|unable to open database file/i;
/** このブラウザには、データを保存する機能が無い(古いブラウザ・一部のプライベートモード)。 */
const NO_OPFS = /Missing required OPFS APIs/i;

export function bootFailureText(message: string): string {
  if (NEWER_DB.test(message)) {
    return (
      'この PKC3 より新しいバージョンで保存されたデータなので、このバージョンでは開けません。' +
      'データは変えていません。新しいバージョンの PKC3 で開いてください。' +
      `(詳細: ${message})`
    );
  }
  /**
   * 🔴 **起動できていないので、アプリの中の画面を案内しない**(#1087 D5)。
   * 空き容量の不足の案内(`errorMessageJa`)は「システムの『使われていない添付を消す』」を押させるが、
   * アプリが開いていないこの画面では押せない ── ブラウザや端末の側で空きを作って、読み込み直してもらう。
   */
  if (QUOTA_MESSAGE.test(message)) {
    return (
      'ブラウザの保存領域に空きがないため、起動できませんでした。' +
      'この端末の空き容量を増やして(使っていないアプリやファイルを消す)、ページを再読み込みしてください。' +
      `(詳細: ${message})`
    );
  }
  /**
   * 🔴 **英語のまま出さない**(#1087 D5)── 起動の途中で止まっただけで、起動できていない間は何も消していない。
   * 原因はまだ切り分けていないので、**原因を名乗らない**(`db-corruption.ts` の方針)。
   */
  if (looksCorrupt(message) || CANT_OPEN.test(message)) {
    return (
      '保存されているデータを開けませんでした。データは削除していません。' +
      '同じ PKC3 を開いているほかのタブやウィンドウがあれば閉じて、ページを再読み込みしてください。' +
      `(詳細: ${message})`
    );
  }
  if (NO_OPFS.test(message)) {
    return (
      'このブラウザでは、PKC3 がデータを保存する機能を使えません。データは削除していません。' +
      'プライベートモードではない通常のウィンドウで、最新のブラウザを使って開き直してください。' +
      `(詳細: ${message})`
    );
  }
  // 🔑 分かる英語は日本語にする(元の英語は括弧に残る ── errorMessageJa)
  return `起動に失敗しました: ${errorMessageJa(message)}`;
}
