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
import { wrapSelection } from '../../features/markdown/wrap-selection';
import { autoPairFor, type AutoPair } from '../../features/markdown/text-ops';
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
  /** 貼り付けの変換(URL → リンク・HTML → Markdown・画像)と、画像の差し込み(落とした画像も)。 */
  | 'paste'
  /** Enter(`=` で終わる行)で、その行を計算する(`resolveInlineCalc`)。 */
  | 'enterCalc'
  /** 括弧の自動補完(`autoPairFor`)。⚠ 1 画面の行は `row-swap.ts` が受ける(本文・章は `binder.ts`)が、どちらも `typedPairFor` を通る。追記の欄は持たない。 */
  | 'autoPair'
  /** 書式のバー(ボタンの帯)が付く欄。⚠ 追記の欄はバーを持たず、キーだけ(user 裁定 2026-11-21)。 */
  | 'formatBar'
  /** 字を選んで括弧・引用符・`*` `_` を打つと囲む(`wrapSelection`。#2001 段 3)。⚠ 追記の欄も持つ(補完は持たないが囲むのは持つ)。 */
  | 'wrapSelection';

export const EDITING_FIELD_FEATURES: Readonly<Record<EditingFieldKind, Readonly<Record<EditingFeature, boolean>>>> = {
  editor: { enterContinue: true, tabTemplate: true, tabIndent: true, keys: true, paste: true, enterCalc: true, autoPair: true, formatBar: true, wrapSelection: true },
  row: { enterContinue: true, tabTemplate: false, tabIndent: false, keys: true, paste: true, enterCalc: true, autoPair: true, formatBar: true, wrapSelection: true },
  section: { enterContinue: true, tabTemplate: true, tabIndent: true, keys: true, paste: true, enterCalc: true, autoPair: true, formatBar: false, wrapSelection: true },
  append: { enterContinue: true, tabTemplate: false, tabIndent: true, keys: true, paste: true, enterCalc: true, autoPair: false, formatBar: false, wrapSelection: true },
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

/**
 * 🔴 **打った 1 字で何が起きるか ── 欄ごとの答えは、ここ 1 か所**(#2001 段 3)。
 * 選んでいれば囲む(`wrapSelection` を持つ欄)/ 選んでいなければ括弧を補う(`autoPair` を持つ欄)。
 * 本文・章・追記・1 画面の行の 4 つの打鍵の道が全部ここを通るので、表の真偽を替えれば欄ごとに挙動が替わる。
 * @returns `null` = 何もしない(ブラウザにそのまま打たせる)
 */
export function typedPairFor(
  name: string | null | undefined,
  sel: { readonly text: string; readonly start: number; readonly end: number },
  key: string,
): AutoPair | null {
  const s = { text: sel.text, start: sel.start, end: sel.end };
  if (sel.start !== sel.end) return fieldHas(name, 'wrapSelection') ? wrapSelection(s, key) : null;
  return fieldHas(name, 'autoPair') ? autoPairFor(s, key) : null;
}
