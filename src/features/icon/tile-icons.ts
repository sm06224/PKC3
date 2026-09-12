/**
 * 🔴 **アプリのタイルに付ける目印の一覧**(#770 段②、2026-09-12)。
 *
 * > user 要望 2026-09-07:「**アプリで使えるアイコンにも使用したい /
 * > なので、アイコン入力の補助としてパレット機能も欲しい**」
 *
 * ## ⚠ ここは「選ばせる物」だけを持つ ── 受け取る物はもっと広い
 *
 * | | 何を決めるか |
 * |---|---|
 * | `PKC_SYMBOLS`(`symbols.ts`) | **絵の在処**(名前 → 符号位置)。打てば**全部当たる** |
 * | この file | **押して選べる物と、その順番と、日本語の名前** |
 *
 * 🔑 2 つを分けるのは、**選ばせないが当たる**絵が在るからである ── たとえば
 *   `trash` は画面の他の場所で**必ず「削除」**を意味し、**赤**が当たっている。
 *   一覧に並べると「押したら消える物」に見えるので**並べない**。
 *   ⚠ ただし打った人には当てる ── **動線は減らさない**(user 裁定 2026-08-07)。
 *
 * ## ⚠ 名前は**日本語**で出す
 *
 * 図案名(`terminal` / `calculate`)は**内部語**である(`symbols.ts` の注記)。
 * user が見るのは画面なので、`title` と読み上げに出すのは**日本語の名前**にする。
 */
import type { IconName } from './symbols';

export interface TileIconChoice {
  /** 図案の名前(内部語)。`attachment.app_icon` に入る値でもある。 */
  readonly name: IconName;
  /** 画面に出す名前(日本語)。⚠ `title` と読み上げに使う。 */
  readonly label: string;
}

/**
 * 押して選べる目印。⚠ **並び順は意味の近い物どうし**で置く
 * (道具 → 計算と図 → 文書 → 人 → 時間 → 場所 → 音と映像 → 暮らし → しくみ)。
 *
 * ⚠ **操作の意味が固まっている絵は入れない** ── `trash`(削除)/ `close`(やめる)/
 *   `check`(確定)/ `plus`(足す)/ `pencil`(書く)/ 山形(送り)など。
 *   一覧に並べると、目印ではなく**押せる操作**に見える。
 */
export const TILE_ICON_CHOICES: readonly TileIconChoice[] = [
  { name: 'terminal', label: '端末' },
  { name: 'computer', label: 'パソコン' },
  { name: 'phone', label: '携帯' },
  { name: 'code', label: 'コード' },
  { name: 'database', label: 'データ' },
  { name: 'tools', label: '道具' },
  { name: 'calculator', label: '電卓' },
  { name: 'grid', label: '表' },
  { name: 'chart', label: 'グラフ' },
  { name: 'dashboard', label: '盤' },
  { name: 'page', label: '文書' },
  { name: 'note', label: 'メモ' },
  { name: 'book', label: '本' },
  { name: 'news', label: 'ニュース' },
  { name: 'form', label: 'フォーム' },
  { name: 'list', label: '一覧' },
  { name: 'check-box', label: 'やること' },
  { name: 'person', label: '人' },
  { name: 'mail', label: 'メール' },
  { name: 'chat', label: 'チャット' },
  { name: 'calendar', label: '予定表' },
  { name: 'clock', label: '時計' },
  { name: 'timer', label: 'タイマー' },
  { name: 'map', label: '地図' },
  { name: 'flight', label: '旅行' },
  { name: 'globe', label: 'ウェブ' },
  { name: 'music', label: '音楽' },
  { name: 'movie', label: '動画' },
  { name: 'camera', label: '写真' },
  { name: 'mic', label: '録音' },
  { name: 'monitor', label: '画面' },
  { name: 'palette', label: '絵' },
  { name: 'cart', label: '買い物' },
  { name: 'money', label: 'お金' },
  { name: 'work', label: '仕事' },
  { name: 'school', label: '学び' },
  { name: 'home', label: '家' },
  { name: 'food', label: '食事' },
  { name: 'sunny', label: '天気' },
  { name: 'science', label: '実験' },
  { name: 'pets', label: 'ペット' },
  { name: 'fitness', label: '運動' },
  { name: 'game', label: 'ゲーム' },
  { name: 'star', label: 'お気に入り' },
  { name: 'folder', label: 'フォルダ' },
  { name: 'search', label: '探す' },
  { name: 'key', label: '鍵' },
  { name: 'link', label: 'リンク' },
  { name: 'translate', label: '翻訳' },
];
