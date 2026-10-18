/**
 * Markdown でまとめて書き出すとき、ノート同士のリンク(`[題名](entry:…)`)を書き出したファイルへのリンクに書き換える
 * (#1163 依頼 116-3 = A)。
 *
 * 直す前は `entry:…` のまま出たので、ほかのアプリで開くと押しても何も開かなかった。
 * - 一緒に書き出したノートへのリンク … そのファイル(`題名.md`)を指す相対のリンクにする
 * - 書き出さなかったノートへのリンク … リンクの字(題名)だけ残す(押せないリンクを残さない)
 * - `![](entry:…)` の埋め込み … 触らない(ファイルを画像として読ませられない。数えて言う)
 * ⚠ 章への飛び先(`#h/…`)はファイル側に対応する綴りが無いので落とす。
 * 🔑 宛先の走査は `link-scan.ts` の 1 本(コード・行内コードの中は触らない)。
 */
import { scanLinks } from '@features/markdown/link-scan';

/** `entry:<lid>` と、その後ろの飛び先(`#…`)。 */
const NOTE_DEST = /^entry:([^#\s]+)(#.*)?$/i;

/** ファイル名を、リンクの宛先に使える形へ(空白・日本語・括弧を %xx にする)。 */
export function fileNameToLinkDest(name: string): string {
  return encodeURI(name).replace(/\(/g, '%28').replace(/\)/g, '%29');
}

export interface NoteLinkRewrite {
  text: string;
  /** ファイルへのリンクに書き換えた数。 */
  toFile: number;
  /** 題名の字だけにした数(書き出さなかったノートへのリンク)。 */
  toText: number;
  /** 触らなかった数(`![](entry:…)` の埋め込み)。 */
  untouched: number;
}

/**
 * @param fileOf 書き出すノートの lid から、書き出す `.md` のファイル名を引く(書き出さないノートは `undefined`)
 */
export function rewriteNoteLinks(text: string, fileOf: (lid: string) => string | undefined): NoteLinkRewrite {
  if (!/entry:/i.test(text)) return { text, toFile: 0, toText: 0, untouched: 0 };
  const { sites } = scanLinks(text);
  let out = '';
  let cursor = 0;
  let toFile = 0;
  let toText = 0;
  let untouched = 0;
  for (const site of sites) {
    const m = NOTE_DEST.exec(site.dest);
    if (m === null) continue;
    if (site.image) {
      untouched++;
      continue;
    }
    const file = fileOf(m[1]!);
    if (file !== undefined) {
      // 宛先だけ差し替える(参照形式の定義行・HTML の href も同じ)
      if (site.destStart < cursor) continue;
      out += text.slice(cursor, site.destStart) + fileNameToLinkDest(file);
      cursor = site.destEnd;
      toFile++;
      continue;
    }
    // 書き出さなかったノート: 角括弧のリンクだけ、題名の字に畳む(定義行・HTML は触らない)
    if (site.kind !== 'inline' || site.labelStart < cursor) {
      untouched++;
      continue;
    }
    out += text.slice(cursor, site.labelStart) + text.slice(site.labelStart + 1, site.start);
    cursor = site.end;
    toText++;
  }
  return { text: out + text.slice(cursor), toFile, toText, untouched };
}
