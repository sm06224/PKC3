import { WRITE_QUOTA_REFUSAL, WRITE_QUOTA_REFUSAL_BODY_SAVE, WRITE_QUOTA_REFUSAL_EDITING } from './storage/write-quota';
/** 空きが足りないときの案内(ボタンの名前は画面の字〔`commands.ts`〕と揃える)。 */
const QUOTA_JA = '保存できる空き容量が足りません。システムの「使われていない添付を消す」で空きを作ってから、もう一度お試しください';

/** ブラウザ / SQLite の「空きが無い」の綴り(起動の失敗の字〔`boot-failure-text.ts`〕も同じ判定を使う)。 */
export const QUOTA_MESSAGE = /QuotaExceededError|SQLITE_FULL|disk is full|quota (has been )?exceeded/i;

/** 本文の保存が空きで落ちたとき(順番: 空きを作る → 「ノートを保存し直す」→ 整理)。 */
const QUOTA_JA_BODY_SAVE =
  '保存できる空き容量が足りません。まず、このタブの外で空きを作ってください。' +
  '空きができたら、本文の上の「ノートを保存し直す」を押してください。そのあと、システムの「使われていない添付を消す」で整理できます';

/** ブラウザ / SQLite の「空きが無い」で本文の保存が断られ、編集の画面へ戻したとき。 */
const QUOTA_JA_EDITING =
  '保存できる空き容量が足りません。まず、このタブの外で空きを作ってください。' +
  '書きかけの字は編集の画面に残してあります。空きができたら、もう一度「編集を保存する」を押してください';

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
  [QUOTA_MESSAGE, QUOTA_JA],
];

/** 英語の理由を、分かる物だけ日本語にする(分からない物はそのまま)。 */
export function errorMessageJa(raw: string): string {
  for (const [re, ja] of ERROR_JA) if (re.test(raw)) return `${ja}(${raw})`;
  return raw;
}

/**
 * 🔴 **「空きが足りない」で落ちたか**(取り込みが、書く前に止まるために使う)。
 * ブラウザ(`QuotaExceededError`)/ SQLite(`SQLITE_FULL`)/ 保存の係の断り(`WRITE_QUOTA_REFUSAL`)の 3 つを同じに扱う。
 */
export function isQuotaFailure(e: unknown): boolean {
  if (e instanceof Error && e.name === 'QuotaExceededError') return true;
  const raw = e instanceof Error ? e.message : String(e);
  return QUOTA_MESSAGE.test(raw) || raw.includes(WRITE_QUOTA_REFUSAL);
}

export function errorText(e: unknown): string {
  // ⚠ ブラウザの DOMException は種類が name にだけ載る(message は「The quota has been exceeded.」など)
  if (e instanceof Error && e.name === 'QuotaExceededError') return errorMessageJa(`QuotaExceededError: ${e.message}`);
  return errorMessageJa(e instanceof Error ? e.message : String(e));
}

/**
 * 本文の保存(`REQUEST_PERSIST`)が失敗したときの字(#1087)。
 * 🔑 空きが足りない失敗だけ、空きを作った**後**の一手を足す ── 失敗した保存は自動では再送されず、
 *   本文の上の「ノートを保存し直す」(`detail.ts`)を押すまで disk に届かない。
 *   ⚠ `errorText` 本体には足さない(同じ文が、保存し直しのボタンが無い場面〔添付・書き出し〕にも出る)。
 */
export function bodySaveErrorText(e: unknown): string {
  const text = errorText(e);
  // ⚠ worker の断り(`WRITE_QUOTA_REFUSAL`)は「ノートを保存し直す」を言わない(添付などにも出る字)ので、
  //   本文の保存の失敗では順番つきの版(空きを作る → 保存し直す → 整理)へ差し替える(#1087 D4)
  if (text.includes(WRITE_QUOTA_REFUSAL)) return text.replace(WRITE_QUOTA_REFUSAL, WRITE_QUOTA_REFUSAL_BODY_SAVE);
  // ブラウザ / SQLite の「空きが無い」── 整理(使われていない添付を消す)は保存し直しの後でないと始められない
  if (text.includes(QUOTA_JA)) return text.replace(QUOTA_JA, QUOTA_JA_BODY_SAVE);
  return text;
}

/**
 * 🔴 **空きが足りなくて本文の保存が断られ、編集の画面へ戻したとき**の字(台帳 #1852 束 S1、依頼 104-1 B)。
 * ⚠ 「ノートを保存し直す」ではなく「編集を保存する」を言う(戻した先の画面にあるボタン)。
 *   空きの失敗でなければ `null`(従来の `bodySaveErrorText` のまま)。
 */
export function bodySaveEditingText(e: unknown): string | null {
  if (!isQuotaFailure(e)) return null;
  const text = errorText(e);
  if (text.includes(WRITE_QUOTA_REFUSAL)) return text.replace(WRITE_QUOTA_REFUSAL, WRITE_QUOTA_REFUSAL_EDITING);
  return QUOTA_JA_EDITING;
}

/**
 * 図の書き出し(SVG)が失敗したときの字(#1087)。
 * 🔑 `String(e)` ではなく `errorText` を通す ── 「Error: …」の英語の前置きを付けず、分かる物は日本語にする。
 * 🔴 **原文はメッセージに積まない**(`caution-events.ts` の `messageTextOfOpError`)── mermaid の構文エラーは
 *   図の原文の一部を引用するので、画面の 1 行には出ても、バグ報告に貼る集積地には固定の先頭だけを積む。
 * 🔑 長さの上限は 200 字(mermaid の構文エラーは何行にもなる)。⚠ 日本語の案内は `errorText` が前に置くので、
 *   切れるのは末尾の原文のほうである。
 */
export const DIAGRAM_EXPORT_FAIL_HEAD = '図を書き出せませんでした';
export function diagramExportErrorText(e: unknown): string {
  return `${DIAGRAM_EXPORT_FAIL_HEAD}: ${errorText(e).slice(0, 200)}`;
}
