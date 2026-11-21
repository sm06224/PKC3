/**
 * 🔴 **「本文を書く欄」の判定は、ここ 1 か所**(#2001 段 2)。
 *
 * 本文を書く欄は 4 つある ── 2 ペインの全文欄(`editor-body`)/ 1 画面の行の欄(`row-source`)/
 * 章だけの欄(`section-draft-input`)/ 追記の欄(`append-input`)。
 * 以前は Enter の継ぎ足し・Tab・書式のショートカット・貼り付けが、それぞれ**欄の名前を直書きした別の集合**で
 * 欄を選んでいたので、追記の欄だけ継ぎ足しも書式のキーも抜けていた(§7「同じ判定は 1 関数へ」)。
 *
 * 🔑 欄を 1 つ足すときは `EDITING_FIELD_KINDS` と `EDITING_FIELD_FEATURES` を埋める(型が落とす)。
 *   各機能が全部の欄に対して答えを持つことは `tests/adapter/editing-field.test.ts` が全数で見る。
 * ⚠ 追記の欄の `Tab` は焦点を出す鍵でもあるので、**リストの行と複数行の選択のときだけ**握る
 *   (`features/markdown/indent-assist.ts` の戒めと同じ。キーボードだけの人が欄から出られなくなる)。
 */
import type { KeyContext } from '../../features/keymap';
import { SECTION_BOX_INPUT_FIELD } from './render/section-box';

export type EditingFieldKind = 'editor' | 'row' | 'section' | 'append';

export const EDITING_FIELD_KINDS: readonly EditingFieldKind[] = ['editor', 'row', 'section', 'append'];

/** 欄の種類ごとの `data-pkc-field`(この表が名前の正本)。 */
export const EDITING_FIELD_NAMES: Readonly<Record<EditingFieldKind, string>> = {
  editor: 'editor-body',
  row: 'row-source',
  section: SECTION_BOX_INPUT_FIELD,
  append: 'append-input',
};

export type EditingFeature =
  /** Enter でリスト / 引用の記号を続ける(`quoteOnEnter`)。 */
  | 'enterContinue'
  /** Tab で表のセル移動 / 短縮語 / 次の印へ。⚠ 追記の欄は焦点を出す鍵を守るので持たない。 */
  | 'tabTemplate'
  /** Tab / Shift+Tab で字下げ(リストの行・複数行の選択のときだけ握る)。⚠ 1 画面の行の Tab は行の確定。 */
  | 'tabIndent'
  /** 書式・行の入れ替え・字下げの鍵・日時・計算・整える操作(`editorCommand` の全部)。 */
  | 'keys'
  /** 貼り付けの変換(URL → リンク・HTML → Markdown・画像)。 */
  | 'paste';

export const EDITING_FIELD_FEATURES: Readonly<Record<EditingFieldKind, Readonly<Record<EditingFeature, boolean>>>> = {
  editor: { enterContinue: true, tabTemplate: true, tabIndent: true, keys: true, paste: true },
  row: { enterContinue: true, tabTemplate: false, tabIndent: false, keys: true, paste: true },
  section: { enterContinue: true, tabTemplate: true, tabIndent: true, keys: true, paste: true },
  append: { enterContinue: true, tabTemplate: false, tabIndent: true, keys: true, paste: true },
};

/** 欄の名前 → 種類。本文を書く欄でなければ `null`。 */
export function editingFieldKindOfName(name: string | null | undefined): EditingFieldKind | null {
  for (const k of EDITING_FIELD_KINDS) if (EDITING_FIELD_NAMES[k] === name) return k;
  return null;
}

/** 要素 → 種類(`<textarea>` だけ)。 */
export function editingFieldKind(el: unknown): EditingFieldKind | null {
  if (!(el instanceof HTMLTextAreaElement)) return null;
  return editingFieldKindOfName(el.getAttribute('data-pkc-field'));
}

/** 欄の名前に対し、機能を持つか。 */
export function fieldHas(name: string | null | undefined, feature: EditingFeature): boolean {
  const k = editingFieldKindOfName(name);
  return k !== null && EDITING_FIELD_FEATURES[k][feature];
}

/**
 * 鍵の割り当て表(`keymap.match`)へ渡す文脈。
 * ⚠ 章の欄は 1 画面の行と同じ鍵を使う(従来どおり。割り当ての重なりを増やさない)。
 */
export function keyContextOfField(kind: EditingFieldKind): KeyContext {
  return kind === 'editor' ? 'editor' : kind === 'append' ? 'append' : 'row';
}
