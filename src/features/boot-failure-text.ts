/**
 * 🔴 **起動に失敗したときの字**(#1087)。
 *
 * ⚠ 直す前は、例外の英語をそのまま出していた(「起動に失敗しました: db user_version 5 is newer than supported 4」)。
 *   いちばん多い原因(新しいバージョンで保存したデータを、古いバージョンで開いた)でも、
 *   何が起きたか・データが無事か・どうすればよいかが読めなかった。
 * 🔑 原因が分かる物だけを日本語にする。分からない物は**詳細を消さない**(バグ報告の手がかり)。
 */
const NEWER_DB = /db user_version (\d+) is newer than supported (\d+)/;

export function bootFailureText(message: string): string {
  if (NEWER_DB.test(message)) {
    return (
      'この PKC3 より新しいバージョンで保存されたデータなので、このバージョンでは開けません。' +
      'データは変えていません。新しいバージョンの PKC3 で開いてください。' +
      `(詳細: ${message})`
    );
  }
  return `起動に失敗しました: ${message}`;
}
