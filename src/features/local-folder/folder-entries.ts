/**
 * 🔴 **パソコンのフォルダの一覧の、純粋な部分**(#215 段①。🟣 Gemini 裁定 2026-10-01:
 * 別のタブに並べ、押すと取り込んで開く)。
 *
 * ⚠ ここは **browser API を持たない**。`showDirectoryPicker` も handle も
 *   `adapter/platform/local-folder.ts` が持つ ── こちらは「並べる・種類を言う・
 *   字にする」だけである(`core ← features ← adapter`)。
 *
 * ## 種類と「書き戻せるか」
 *
 * 行を押すと**取り込んで開く**が、取り込まれ方は種類で違う:
 *
 * | 種類 | 取り込まれ方 | 元の file へ書き戻せるか |
 * |---|---|---|
 * | Markdown | ノートになる(元の file と結ぶ) | 🟢 **書き戻せる**(情報ペインの「元ファイルへ書き戻す」) |
 * | vCard | 連絡先のノートになる | 🔴 書き戻せない |
 * | それ以外(画像・PDF・Office・テキスト…) | 添付のノートになる | 🔴 書き戻せない |
 *
 * 🔑 **判定は取込の振り分けと同じ関数**(`isMarkdownFileName` / `isVcfFileName`)──
 *   ここで拡張子を書き直すと、「押して入る物」と「選んで入る物」が食い違う(CLAUDE.md §7)。
 */
import { isMarkdownFileName } from '@features/import/plain-markdown';
import { isVcfFileName } from '@features/contact/vcard';
import { isOfficeLaunchFile } from '@features/office/office-launch';
import { humanBytes } from '@features/human-bytes';
import { formatDate } from '@features/datetime/datetime-format';
import type { IconName } from '@features/icon/symbols';

/** 1 回に出す件数の上限(「さらに表示」で同じだけ足す)。 */
export const FOLDER_PAGE = 200;

/**
 * 🔴 **フォルダの行を押したときの返事**(#1264 §1)。⚠ 押せる見た目ではないが、押す user は居る ──
 * 何も起きずに理由も出ないと「壊れている」に見える。行の `title` と、押した後の状態の行で**同じ字**を使う。
 * ⚠ 「切る」は帯の押し口の字(`pc-folder.ts` の `band`)と揃える。
 */
export const PC_DIRECTORY_NOTE =
  '中へは入りません。このフォルダの中を見るには、切ってからそのフォルダを選んでください';

/** vCard の行に見える字で添える(ホバーだけにしない)。 */
export const PC_CONTACT_NOTE = '連絡先として取り込みます';

/**
 * 🔴 **Markdown の行にだけ**添える字(#1264 §2 改善 1。Gemini 裁定 2026-10-02)。
 * ⚠ かつては**書き戻せない全部の行**に「書き戻せません」を出していた(200 行あれば 200 回)。
 * 「できない」を全行に繰り返すより、**できる行にだけ**「できる」を 1 度ずつ言う
 * (画像・PDF などは何も添えない ── 添付になることは押した後の流れが言う)。
 */
export const PC_LINK_NOTE = '元ファイルとつながります';

/**
 * 🔴 大きさ・更新日が「—」のわけ(#1271)。一覧では file を**読まない** ── 読むと、クラウド同期の
 * フォルダ(OneDrive / iCloud / Dropbox のファイルオンデマンド)で未ダウンロードの実体が一斉に落ちてくる。
 * ホバーに出す(「—」を壊れと読ませない)。
 */
export const PC_STATS_NOTE = '大きさと更新日は、開くときに読みます(一覧ではファイルの中身を読みません)';

/** 取り込まれ方。 */
export type FolderFileRoute = 'note' | 'contact' | 'attachment';

export interface FolderFileKind {
  readonly route: FolderFileRoute;
  /** 一覧の「種類」の字。 */
  readonly label: string;
  /** 元の file へ書き戻せるか(Markdown だけ)。 */
  readonly writeBack: boolean;
  /** 行頭の絵(#1272)。⚠ 種類の判定と**同じ場所**で決める ── 絵のための拡張子判定を別に持たない。 */
  readonly icon: IconName;
}

const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.avif', '.svg'] as const;

const AUDIO_EXTS = ['.mp3', '.wav', '.m4a', '.ogg', '.oga', '.flac', '.aac', '.opus'] as const;
const VIDEO_EXTS = ['.mp4', '.webm', '.mov', '.m4v', '.mkv', '.avi', '.ogv'] as const;

const endsWithAny = (name: string, exts: readonly string[]): boolean => {
  const lower = name.toLowerCase();
  return exts.some((e) => lower.endsWith(e));
};

/**
 * その file を押したとき、どう取り込まれるか。
 * ⚠ 拡張子だけで見る(中身では決めない ── 取込の振り分けと同じ作法)。
 */
export function fileKindOf(name: string): FolderFileKind {
  if (isMarkdownFileName(name)) return { route: 'note', label: 'Markdown', writeBack: true, icon: 'note' };
  if (isVcfFileName(name)) return { route: 'contact', label: 'vCard', writeBack: false, icon: 'person' };
  if (isOfficeLaunchFile(name)) return { route: 'attachment', label: 'Office', writeBack: false, icon: 'presentation' };
  if (endsWithAny(name, IMAGE_EXTS)) return { route: 'attachment', label: '画像', writeBack: false, icon: 'camera' };
  if (endsWithAny(name, ['.pdf'])) return { route: 'attachment', label: 'PDF', writeBack: false, icon: 'page' };
  if (endsWithAny(name, ['.txt'])) return { route: 'attachment', label: 'テキスト', writeBack: false, icon: 'clip' };
  // ⚠ 音・動画は種類の字を持たない(「ファイル」のまま)── 絵だけ分ける(字を変えるのは見え方の変更)
  if (endsWithAny(name, AUDIO_EXTS)) return { route: 'attachment', label: 'ファイル', writeBack: false, icon: 'music' };
  if (endsWithAny(name, VIDEO_EXTS)) return { route: 'attachment', label: 'ファイル', writeBack: false, icon: 'movie' };
  return { route: 'attachment', label: 'ファイル', writeBack: false, icon: 'clip' };
}

/** 一覧の 1 行(列挙した物。大きさと更新日は、見える分だけ後から読む)。 */
export interface FolderEntry {
  readonly name: string;
  readonly kind: 'file' | 'directory';
}

/**
 * 並べ方 = **フォルダが先、あとは名前順**(数字は数として。「2」は「10」の前)。
 * ⚠ 元の配列は触らない。⚠ 照合は大小を区別しない(`a.md` と `B.md` は a → B の順)。
 */
export function sortFolderEntries<T extends FolderEntry>(entries: readonly T[]): T[] {
  const collator = new Intl.Collator('ja', { numeric: true, sensitivity: 'base' });
  return [...entries].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
    return collator.compare(a.name, b.name);
  });
}

/** 大きさの字。⚠ 読めていない(`null`)ときは「—」── 0 と読ませない。 */
export function folderSizeText(size: number | null): string {
  return size === null ? '—' : humanBytes(size);
}

/** 更新日の字。⚠ 読めていない(`null`)ときは「—」。 */
export function folderModifiedText(modified: number | null): string {
  return modified === null ? '—' : formatDate(new Date(modified));
}

/**
 * 行頭の絵(#1272)。フォルダ → `folder`、file は `fileKindOf` の `icon`。
 * ⚠ 描画器はこれを呼ぶだけ ── 種類 → 絵の対応は**ここ 1 か所**。
 */
export function iconFor(entry: FolderEntry): IconName {
  return entry.kind === 'directory' ? 'folder' : fileKindOf(entry.name).icon;
}
