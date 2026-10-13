/**
 * 🔴 **例外を画面の字に添えるときの 1 か所**(#1087)。
 *
 * ⚠ `String(e)` は Error を「Error: …」の形にする ── 日本語の知らせの後ろに英語の前置きが付いて出ていた
 *   (「つながりを保存できません: Error: …」)。前置きを付けず、中身(message)だけを返す。
 * 🔑 中身そのものは消さない(何が起きたかの手がかり ── バグ報告に貼られる)。
 * 🔑 **PKC3 自身が英語で投げる、user に届く物**は、ここで日本語にする(元の英語は括弧に残す)。
 *   ⚠ 投げる側(worker / 接続)の字はログ・test の手がかりなので変えない ── 画面に出る手前の 1 か所で直す。
 *   ⚠ 足すのは「投げる所と画面に出る所を両方読んだ物」だけ(2026-10-13 の調査。正本は `ERROR_JA` の表)。
 */
const ERROR_JA: readonly (readonly [RegExp, string])[] = [
  // store-client.ts ── 保存の係を止めた後(データを作り直す途中など)に書こうとした
  [/^store client terminated$/, '保存を担当する処理が止まっていたため、書き込めませんでした。ページを再読み込みしてください'],
  // ブラウザが出す、通信が無い・届かないときの例外(Chrome / Edge。PKC3 が投げる物ではないが、雛形の取得などで画面に出る)
  [/^Failed to fetch$/, 'ネットワークに接続できませんでした。つながるところで、もう一度押してください'],
  // storage-worker.ts の need() ── 起動が終わる前に頼んだ
  [/^storage worker not initialized$/, '保存の準備がまだ終わっていません。少し待ってから、もう一度お試しください'],
  // store-client.ts ── 保存の係そのものが起動できなかった
  [/^storage worker (error: |message deserialization failed)/, 'データの保存を担当する処理を起動できませんでした。ページを再読み込みしてください'],
  // worker-lease.ts ── 添付・書き出し・文字起こしなど、裏で動く処理が起動できなかった
  [/^[a-z-]+: (spawn failed|load failed$|message deserialization failed$)/, '裏で動く処理を起動できませんでした。ページを再読み込みして、もう一度お試しください'],
  // storage-worker.ts の版を読み出す所 ── 版の記録が欠けている / 壊れている
  [/^revision restore failed/, 'この版は読み出せませんでした(版の記録が欠けているか、読めない形になっています)'],
  /**
   * ブラウザ / SQLite が出す「空きが無い」── PKC3 が投げる物ではないが、出たときに次の手が要る。
   * ⚠ ボタンの名前は画面の字(`commands.ts` の「使われていない添付を消す」)と揃える。
   */
  [/QuotaExceededError|SQLITE_FULL|disk is full|quota (has been )?exceeded/i, '保存できる空き容量が足りません。システムの「使われていない添付を消す」で空きを作ってから、もう一度お試しください'],
];

/** 英語の理由を、分かる物だけ日本語にする(分からない物はそのまま)。 */
export function errorMessageJa(raw: string): string {
  for (const [re, ja] of ERROR_JA) if (re.test(raw)) return `${ja}(${raw})`;
  return raw;
}

export function errorText(e: unknown): string {
  // ⚠ ブラウザの DOMException は種類が name にだけ載る(message は「The quota has been exceeded.」など)
  if (e instanceof Error && e.name === 'QuotaExceededError') return errorMessageJa(`QuotaExceededError: ${e.message}`);
  return errorMessageJa(e instanceof Error ? e.message : String(e));
}
