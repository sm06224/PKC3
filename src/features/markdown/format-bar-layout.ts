/**
 * 書式の帯の並び(#1982 段 3)。⚠ **帯に何を直接出し、何を「その他 ▾」へ入れるかの正本はここ 1 つ**
 * (描く側 `render/format-bar.ts` は並べるだけ。表と画面がずれると「押せないボタン」になる)。
 *
 * 🔑 方針は「普段使いは出す、副次は 1 段奥」。本文が主役で、道具は静かに退く:
 *   直接出すのは 見出し | 太字・斜体・取り消し線・下線・ハイライト・文字色 ▾・コード・リンク |
 *   箇条書き・番号・チェック・引用・配置 ▾ | 表・ノートリンク・添付・ページ設定 ▾ の 4 塊(v4.0 Phase 1 / PR-04 で文字装飾と ▾ を足した)。
 *   「文字色 ▾」「配置 ▾」は押すと一覧が出る(色・揃え・字下げは選ぶ物が多いので 1 段奥)。「ページ設定 ▾」は小さなパネルを開く。
 *   それ以外(図・コードブロック・数式・注意書き・日付・テンプレート・アイコン・改ページ・整える・探す・置換)は「その他 ▾」の一覧。
 * ⚠ 純関数・定数だけ(browser API を持たない)。書式そのものの字と説明は `text-ops.ts` の `FORMAT_OPS` が正本。
 */
import { BAR_FORMAT_OPS, type FormatOp } from './text-ops';
import { TEXT_COLORS, type TextColorId } from './word-format';

/** 押すと一覧が出る ▾ のボタン(文字色 / 配置)。 */
export type FormatMenuId = 'color' | 'align';

/**
 * 帯の 1 項目。書式(`FORMAT_OPS` の op)か、先に聞く / 全文に効く道具(action の名前)か、
 * 一覧を開く ▾(`menu`)か、文字色の見本(`color`。`null` = 色を解除)。
 */
export type BarItem =
  | { readonly op: FormatOp }
  | { readonly action: string }
  | { readonly menu: FormatMenuId }
  | { readonly color: TextColorId | null };

const op = (o: FormatOp): BarItem => ({ op: o });
const act = (a: string): BarItem => ({ action: a });
const menu = (m: FormatMenuId): BarItem => ({ menu: m });

/** 直接出す塊。⚠ 塊の間は CSS が少し空ける(区切り線は引かない)。 */
export const FORMAT_BAR_GROUPS: readonly (readonly BarItem[])[] = [
  [op('h1'), op('h2'), op('h3')],
  [op('bold'), op('italic'), op('strike'), op('underline'), op('highlight'), menu('color'), op('code'), op('link')],
  [op('ul'), op('ol'), op('task'), op('quote'), menu('align')],
  [op('table'), act('insert-entry-link'), act('insert-attachment'), act('open-page-setup')],
];

/**
 * 🔴 **▾ の一覧の中身**(並び順もここが正本)。字と説明は描く側(`render/format-bar.ts`)の表。
 * ⚠ 色は見本の表(`TEXT_COLORS`)から作る ── ここで色を書き写さない。末尾は「色を解除」(片道にしない)。
 */
export const FORMAT_BAR_MENUS: Readonly<Record<FormatMenuId, readonly BarItem[]>> = {
  color: [...TEXT_COLORS.map((c): BarItem => ({ color: c.id })), { color: null }],
  align: [
    op('align-left'),
    op('align-center'),
    op('align-right'),
    op('align-clear'),
    op('indent-more'),
    op('indent-less'),
  ],
};

/** 「その他 ▾」の塊(塊の名前は一覧の間の空きに使う)。 */
export const FORMAT_BAR_MORE_GROUPS: readonly { readonly group: string; readonly items: readonly BarItem[] }[] = [
  {
    group: 'insert',
    items: [
      act('insert-diagram'),
      // 🔴 v4.0 Phase 2 / PR-08: HTML ツールのテンプレート(「図を挿入」と同じ 2 段の一覧)
      act('insert-widget-template'),
      op('codeblock'),
      op('math'),
      act('insert-callout'),
      act('insert-date'),
      act('insert-snippet'),
      act('insert-icon'),
      op('pagebreak'),
    ],
  },
  { group: 'tidy', items: [act('renumber-lists'), act('sort-tasks'), act('calc-line')] },
  { group: 'find', items: [act('find-in-note'), act('toggle-replace')] },
];

/** 項目の識別子(書式は `op:<op>` / 道具は `action:<name>`)。テストと突合に使う。 */
export function barItemId(item: BarItem): string {
  if ('op' in item) return `op:${item.op}`;
  if ('action' in item) return `action:${item.action}`;
  if ('menu' in item) return `menu:${item.menu}`;
  return `color:${item.color ?? 'none'}`;
}

/** 直接出す項目(並び順)。 */
export function visibleBarItems(): readonly BarItem[] {
  return FORMAT_BAR_GROUPS.flat();
}

/** 「その他 ▾」の項目(並び順)。 */
export function moreBarItems(): readonly BarItem[] {
  return FORMAT_BAR_MORE_GROUPS.flatMap((g) => g.items);
}

/** ▾ の一覧(文字色 / 配置)の項目(並び順。文字色 → 配置)。 */
export function menuBarItems(): readonly BarItem[] {
  return (Object.keys(FORMAT_BAR_MENUS) as FormatMenuId[]).flatMap((m) => FORMAT_BAR_MENUS[m]);
}

/**
 * 表(`BAR_FORMAT_OPS`)の書式のうち、並びのどこにも居ないもの。⚠ 空であること(= 足した書式が帯から消えない)。
 */
export function formatOpsMissingFromLayout(): FormatOp[] {
  const placed = new Set(
    [...visibleBarItems(), ...menuBarItems(), ...moreBarItems()].flatMap((i) => ('op' in i ? [i.op] : [])),
  );
  return BAR_FORMAT_OPS.map((f) => f.op).filter((o) => !placed.has(o));
}
