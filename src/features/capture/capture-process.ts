/**
 * 🔴 **録ったものを仕上げる道具の一覧と、押せる形の門**(#952 A2・A4・A5・B1・B4・B5・B6、#674・#949・#683②)。
 *
 * 「音/動画」の行に出す道具を、ここ 1 か所の表で持つ(押し所の出し分け・名前・説明・用語集が同じ表を引く)。
 * 結果はいつも**新しい添付**か**元のノートの本文の末尾への追記**で、元の録音・録画のバイトは変えない。
 *
 * ⚠ **pure module**(`features/` 層)。mime だけで決める粗い門で、中を開いてから断られうる。
 */
import type { CaptureItem } from './capture-item';
import { canExtractFromVideo, canTrimCapture } from './capture-trim-gate';

export type ProcessTool =
  | 'fold-still'
  | 'chapters'
  | 'contact-sheet'
  | 'denoise'
  | 'separate'
  | 'speakers'
  | 'balance'
  | 'fix-speakers';

export interface ProcessToolSpec {
  readonly id: ProcessTool;
  /** メニューの項目の字。 */
  readonly label: string;
  /** 項目の説明(メニューの下の欄に出る)。 */
  readonly title: string;
  /** 新しい添付の名前に入れる語(`録画 (静止区間をまとめた).webm`)。添付を作らない道具は `null`。 */
  readonly nameTag: string | null;
  /** 押している間の字。 */
  readonly busyText: string;
  /** メニューの塊(見出し)。⚠ 表の中で同じ塊は隣り合って並べる(メニューは並びのまま塊に切る)。 */
  readonly group: string;
}

/** 行に 1 つだけ置くボタンの字(押すと道具の一覧が出る)。 */
export const PROCESS_MENU_LABEL = '仕上げ ▾';
/** そのボタンの説明。 */
export const PROCESS_MENU_TITLE =
  '録ったものを仕上げる道具の一覧を出します(結果は新しい添付かノートへの追記で、元の録音・録画は変わりません)。';

export const PROCESS_GROUP_VIDEO = '映像';
export const PROCESS_GROUP_AUDIO = '音を作る';
export const PROCESS_GROUP_NOTE = 'ノートに書く';

export const PROCESS_TOOLS: readonly ProcessToolSpec[] = [
  {
    id: 'fold-still',
    label: '静止区間をまとめる',
    title:
      '画面がほとんど動いていない区間(次のキーフレームまで続く所)の映像を取り除いて、1 枚の絵のままにした新しい動画を保存します。残した絵は元と同じで、長さと音も変わりません(元の動画は残ります)。',
    nameTag: '静止区間をまとめた',
    busyText: '静止している区間を探しています…',
    group: PROCESS_GROUP_VIDEO,
  },
  {
    id: 'contact-sheet',
    label: 'コンタクトシートを作る',
    title: '場面ごとの静止画を並べ、文字起こしがあれば添えた 1 枚の画像を新しい添付として保存します(元の動画はそのまま残ります)。',
    nameTag: 'コンタクトシート',
    busyText: 'コンタクトシートを作っています…',
    group: PROCESS_GROUP_VIDEO,
  },
  {
    id: 'denoise',
    label: '雑音を減らす',
    title: '背景の雑音を減らした新しい音を保存します(元の録音・録画はそのまま残ります)。',
    nameTag: '雑音を減らした',
    busyText: '雑音を減らしています…',
    group: PROCESS_GROUP_AUDIO,
  },
  {
    id: 'separate',
    label: '話し声とそれ以外に分ける',
    title:
      '話し声と、それ以外(背景の音楽・環境音)を別々の新しい音として保存します(2 つを足すとほぼ元に戻ります。元の録音・録画は残ります)。',
    nameTag: null,
    busyText: '話し声とそれ以外を分けています…',
    group: PROCESS_GROUP_AUDIO,
  },
  {
    id: 'balance',
    label: '声の大きさをそろえる',
    title: 'マイクから遠い人の声と近い人の声の大きさをそろえた新しい音を保存します(元はそのまま残ります)。',
    nameTag: '声の大きさをそろえた',
    busyText: '声の大きさをそろえています…',
    group: PROCESS_GROUP_AUDIO,
  },
  {
    id: 'chapters',
    label: 'チャプターを刻む',
    title: '場面が変わる所(動画)や、無音で区切れる所(音)を見つけて、ノートの本文の末尾に時刻つきの一覧を足します。',
    nameTag: null,
    busyText: 'チャプターを探しています…',
    group: PROCESS_GROUP_NOTE,
  },
  {
    id: 'speakers',
    label: '話者を分ける',
    title: '誰が話している区間かを分けて、ノートの本文の末尾に時刻つきの一覧を足します(文字起こしがあれば、話者つきの文字起こしも足します)。',
    nameTag: null,
    busyText: '話者を分けています…',
    group: PROCESS_GROUP_NOTE,
  },
  {
    id: 'fix-speakers',
    label: '話者を直す',
    title: 'ノートの「話者」の一覧にある話者の名前を付け替えたり、区間の話者を直したりします。',
    nameTag: null,
    busyText: '話者を直しています…',
    group: PROCESS_GROUP_NOTE,
  },
];

export function processToolOf(id: string): ProcessToolSpec | undefined {
  return PROCESS_TOOLS.find((t) => t.id === id);
}

/** 音を持つ形か(音の録音、または音が opus の動画)。 */
function hasUsableAudio(item: CaptureItem): boolean {
  if (item.assetKey === null) return false;
  if (item.kind === 'audio') return true;
  return canExtractFromVideo(item, 'audio');
}

/**
 * 🔴 **その道具が使える形か**(押し所を出す前に呼ぶ ── 使えない形には出さない)。
 * `fix-speakers` だけは本文に話者の一覧があるときに出す(`hasSpeakerSection`)。
 */
export function canProcess(item: CaptureItem, tool: ProcessTool, hasSpeakerSection = false): boolean {
  if (item.assetKey === null) return false;
  switch (tool) {
    case 'fold-still':
    case 'contact-sheet':
      return item.kind === 'video' && canTrimCapture(item);
    case 'chapters':
      return item.kind === 'video' ? canTrimCapture(item) || hasUsableAudio(item) : true;
    case 'denoise':
    case 'separate':
    case 'speakers':
    case 'balance':
      return hasUsableAudio(item);
    case 'fix-speakers':
      return hasSpeakerSection;
  }
}

/**
 * 🔴 **仕上げた添付の名前**。`録画.webm` + 静止区間をまとめた → `録画 (静止区間をまとめた).webm`。
 * 拡張子の前に入れる(後ろに付けると書き出したとき OS が種類を見失う)。`ext` を渡すと拡張子を替える(画像など)。
 */
export function processedCaptureName(name: string, tag: string, ext?: string): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return ext === undefined ? `${name} (${tag})` : `${name} (${tag}).${ext}`;
  const stem = name.slice(0, dot);
  return `${stem} (${tag})${ext === undefined ? name.slice(dot) : `.${ext}`}`;
}
