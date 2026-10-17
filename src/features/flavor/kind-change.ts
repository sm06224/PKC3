/**
 * 🔴 **作ったノートの種類を、あとから変える**(台帳 #1852 I2 / 依頼 157。Gemini 回答 = 推薦 ②)。
 *
 * ## user の物語
 *
 * 普通の文書(ノート)で書き始めたものを、時刻付きの記録(ログ)にしたくなる。直す前は、種類は作るときにしか
 * 選べず、新しく作って本文を貼り直すしかなかった。
 *
 * ## 何が変わるか
 *
 * **本文は 1 バイトも変わらない。** 全部の本文は PKC-Markdown で、種類は「見せ方と追記のしかた」(フレーバー)だけを
 * 決める(founding 裁定)。ノート ⇄ ログでは、追記の足し方(ログは日時の見出しつき)と、見出しの扱い
 * (ログの `## 日時` は「行」)が変わる。
 *
 * ## 切り替えられる範囲
 *
 * ⚠ **ノートとログの間だけ。** フォルダ・スマートフォルダ・スタック・添付・テンプレート・表は、種類が「見せ方」ではなく
 * 中身の構造(入れ物・参照の並び・ファイルの情報・csv)を決めるので、変えると壊れる ── 変える口を出さない。
 * 🔑 戻せる(もう一度押せば元の種類に戻る。本文が動かないので損も無い)。
 */
import { archetypeLabel } from './archetype-label';

/** 変える先。⚠ ここに無い種類は変えられない。 */
const KIND_CHANGE_TARGET: Readonly<Record<string, string>> = {
  text: 'textlog',
  textlog: 'text',
};

/** その種類のノートを変えられるか。 */
export function canChangeKind(archetype: string | null): boolean {
  return archetype !== null && KIND_CHANGE_TARGET[archetype] !== undefined;
}

/** 変える先の種類。変えられなければ `null`。 */
export function kindChangeTarget(archetype: string): string | null {
  return KIND_CHANGE_TARGET[archetype] ?? null;
}

/** 確認に出す 1 文(画面で何が起きるかの言葉)。 */
export function kindChangeQuestion(title: string, from: string, to: string): string {
  const name = title === '' ? 'このノート' : `「${title}」`;
  const how =
    to === 'textlog'
      ? '追記すると日時の見出しがつくようになります。'
      : '追記が日時の見出しなしの普通の追記になります。';
  return `${name}を「${archetypeLabel(from)}」から「${archetypeLabel(to)}」に変えます。本文はそのまま残ります。${how}もう一度押せば元に戻せます。`;
}

/** 変えたあとの知らせ。 */
export function kindChangedNotice(to: string): string {
  return `種類を「${archetypeLabel(to)}」に変えました`;
}
