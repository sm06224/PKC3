/**
 * 🔴 **手元のファイルを Office へ回すかどうか**(#432。user 要望 2026-08-26)。
 *
 * > 「**LibreOffice を単独で普通にローカルファイルを開いて編集できる動線欲しいよね**」
 *
 * ## ⚠ `isOfficeAttachment` を流用しない(同じ file の冒頭がそう戒めている)
 *
 * `office-entry.ts` の判定は「**添付の器に入口を出すか**」で、**取りこぼしのほうが痛い**
 * ので広く拾う(false-keep)。⚠ こちらは「**このファイルを Office へ回すか、
 * markdown として取り込むか**」の**振り分け**なので、誤差の向きが違う ──
 * 広く拾うと、markdown として取り込むはずの物が Office へ流れて**取り込まれない**。
 *
 * 🔑 だから**狭く当てる**(拡張子の完全一致だけ。MIME は見ない)。
 * ⚠ MIME を見ないのは、OS 経由の `File.type` が `application/octet-stream` に
 *   落ちることがあり、**落ちた側に倒すと markdown が Office へ流れる**からである。
 *
 * ## 🔴 一覧は `manifest.webmanifest` と**必ず一致させる**
 *
 * OS が PKC3 へ渡してくるのは manifest の `file_handlers` が宣言した種類だけである。
 * ⚠ 片方だけ足すと:
 * - **manifest だけ**足す → OS は PKC3 を起動するのに**誰も受け取らない** ──
 *   user から見ると「ダブルクリックしたのに『開けるファイルがありませんでした』」。
 *   ⚠ **関連付けを奪ったうえで何もしない**ので、他のアプリで開く道まで塞ぐ
 * - **こちらだけ**足す → 届かないので何も起きない(害は無いが、直したつもりになる)
 *
 * ⚠ **2026-08-26 に訂正**:当初ここに「markdown として取り込まれて文字化けした
 *   ノートになる」と書いたが**誤り**だった ── `import-file.ts:33` が
 *   `isMarkdownFileName` で濾しているので、`.docx` は**黙って捨てられる**。
 *   🔑 害の向きは「ゴミが増える」ではなく「**何も起きない**」である
 *   (深刻度を測らずに書いた ── CLAUDE.md §4)。
 * 🔑 `tests/features/office-launch.test.ts` が**両者を集合で突き合わせる**。
 *
 * ⚠ **pure module**。browser API を持たない。
 */
import { missingCapabilities, type OfficeCapability } from './office-entry';
import { OFFICE_PACK_APPROX } from './office-pack-size';

/**
 * Office へ回す拡張子。⚠ **manifest と同じ集合**にする(上の 🔴)。
 *
 * ⚠ `.csv` は入れない ── PKC3 は csv を自前で表として描くので、
 *   ここで拾うと user の動線を横取りする(`office-entry.ts` と同じ判断)。
 * ⚠ `.odg`(図)と flat XML(`.fodt` など)は入れない ── 添付として開く道は在るが、
 *   **OS の関連付けを取りに行くほど使われていない**(取りに行くと、他のアプリから
 *   関連付けを奪う)。⚠ 必要になったら**両方**に足す。
 */
export const OFFICE_LAUNCH_EXTS: readonly string[] = [
  '.docx',
  '.xlsx',
  '.pptx',
  '.doc',
  '.xls',
  '.ppt',
  '.odt',
  '.ods',
  '.odp',
  '.rtf',
];

/**
 * このファイルは Office へ回すか。
 *
 * ⚠ **拡張子だけで見る**(上の 🔑)。⚠ 大小は無視する ── OS から来る名前は
 *   `報告書.DOCX` のこともある。
 */
export function isOfficeLaunchFile(fileName: string): boolean {
  const name = fileName.trim().toLowerCase();
  return OFFICE_LAUNCH_EXTS.some((ext) => name.endsWith(ext));
}

/**
 * 🔴 **手元のファイルから開いた回の合言葉**(#432 段②)。
 *
 * Office の窓は、渡された合言葉を保存のときにそのまま返す(#205)。いままでは
 * **添付の lid** だけが入っていたので、返ってきた合言葉は必ず PKC のノートを指した。
 * ⚠ 手元のファイルはノートではないので、**別の名前空間**にする。
 *
 * 🔑 `lid` は英数字と `-` だけ(`generateLid`)なので、**`:` を含む綴りは
 *   絶対に lid と衝突しない** ── 取り違えると、user の文書が
 *   **知らないノートへ上書きされる**(いちばん取り返しがつかない形)。
 */
const LOCAL_PREFIX = 'local:';

export const localFileToken = (id: string): string => `${LOCAL_PREFIX}${id}`;

/** その合言葉は「手元のファイル」か。⚠ 空文字(合言葉なし)は false。 */
export const isLocalFileToken = (token: string): boolean => token.startsWith(LOCAL_PREFIX);

/** 合言葉から id を取り出す。⚠ 手元のファイルでなければ `null`。 */
export const localFileId = (token: string): string | null =>
  isLocalFileToken(token) ? token.slice(LOCAL_PREFIX.length) : null;

/**
 * 🔴 **どこへ保存されるかを、開く前に言う**(#432 段③)。
 *
 * ⚠ これが無いと「`Ctrl+S` がどこへ行ったか」が user に分からない ──
 *   手元のファイルを直したつもりが PKC のノートになっていた(あるいはその逆)は、
 *   **気づくのが数日後**になる種類の事故である。
 */
export const localOpenNotice = (fileName: string): string =>
  `「${fileName}」を Office で開きます。保存すると、この元のファイルへ書き戻します。`;

/**
 * 書き戻せないときの断り。
 *
 * ⚠ **黙って落とさない**(#432 の「先に決めておくこと」)── 書き戻せないまま
 *   開くと、user は直したものを**行方不明**にする。
 */
export const cannotWriteBackNotice = (fileName: string): string =>
  `「${fileName}」は開けますが、元のファイルへは書き戻せません(この環境が対応していません)。`;

/**
 * 書き戻せなかった理由(区別できたものだけ)。
 * `denied` = 書き込みの許可が得られなかった / `reopen` = 元のファイルが動かされたなどで開き直す必要がある /
 * `unsupported` = このブラウザでは元のファイルへ書けない。
 */
export type LocalWriteFailure = 'denied' | 'reopen' | 'unsupported';

/**
 * 🔴 **元のファイルへ書き戻せなかったときの知らせ**(理由が分かれば理由を言う)。
 *
 * ⚠ 行方を 1 文で言う ── 保存に失敗したとき、user がいちばん知りたいのは「書いた内容はどこに在るか」。
 *   書き戻せなかった保存は取り込み用の置き場から捨てない(`office-save-back.ts`)ので、PKC3 の中に残っている。
 */
export function localSaveFailedNotice(fileName: string, reason: LocalWriteFailure | null): string {
  const why =
    reason === 'denied'
      ? '書き込みの許可が得られなかったためです。'
      : reason === 'reopen'
        ? '元のファイルが動かされたか閉じられたため、もう一度開き直す必要があります。'
        : reason === 'unsupported'
          ? 'このブラウザでは元のファイルへ書き戻せません。'
          : '';
  return `元のファイルへ保存できませんでした(「${fileName}」)。${why}編集した内容は PKC3 の中に残してあります。`;
}

/**
 * 🔴 **Office を押した時点の知らせ**(書き戻せるかで言い分ける)。
 *
 * ⚠ 書き戻せないファイルに「元のファイルへ書き戻します」と言うと、保存した内容の行方を取り違える。
 *   受け取ったときの断り(`cannotWriteBackNotice`)と同じ字にする。
 */
export const openingNotice = (fileName: string, writable: boolean): string =>
  writable ? localOpenNotice(fileName) : cannotWriteBackNotice(fileName);

/**
 * 🔴 **OS から Office のファイルを渡されたときの知らせ**(受け取った直後)。
 *
 * ⚠ 一式が無い・動かないブラウザには Office のタイルが出ない(`isOfficeUsable`)ので、
 *   「アプリの『Office』を押してください」と言うと行き止まりになる。取り込む道か、動くブラウザを案内する。
 */
export function stagedLaunchNotice(input: {
  readonly fileName: string;
  readonly writable: boolean;
  readonly packInstalled: boolean;
  readonly capability: OfficeCapability;
}): string {
  const { fileName: name } = input;
  if (missingCapabilities(input.capability).length > 0) {
    return `「${name}」は、このブラウザでは Office で開けません。Chrome か Edge で開いてください。`;
  }
  if (!input.packInstalled) {
    return `「${name}」を開くには Office 表示の一式(${OFFICE_PACK_APPROX})が要ります。システム → 保存領域 → Office 表示 で取り込んでください。`;
  }
  return input.writable
    ? `「${name}」を開けます。アプリの「Office」を押してください`
    : cannotWriteBackNotice(name);
}
