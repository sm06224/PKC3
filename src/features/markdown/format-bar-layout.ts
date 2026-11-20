/**
 * 書式の帯の並び(#1982 段 3)。⚠ **帯に何を直接出し、何を「その他 ▾」へ入れるかの正本はここ 1 つ**
 * (描く側 `render/format-bar.ts` は並べるだけ。表と画面がずれると「押せないボタン」になる)。
 *
 * 🔑 方針は「普段使いは出す、副次は 1 段奥」。本文が主役で、道具は静かに退く:
 *   直接出すのは 見出し | 太字・斜体・コード・リンク | 箇条書き・番号・チェック・引用 | 表・ノートリンク・添付 の 4 塊。
 *   それ以外(図・コードブロック・数式・注意書き・日付・テンプレート・アイコン・整える・探す・置換)は「その他 ▾」の一覧。
 * ⚠ 純関数・定数だけ(browser API を持たない)。書式そのものの字と説明は `text-ops.ts` の `FORMAT_OPS` が正本。
 */
import { BAR_FORMAT_OPS, type FormatOp } from './text-ops';

/** 帯の 1 項目。書式(`FORMAT_OPS` の op)か、先に聞く / 全文に効く道具(action の名前)。 */
export type BarItem = { readonly op: FormatOp } | { readonly action: string };

const op = (o: FormatOp): BarItem => ({ op: o });
const act = (a: string): BarItem => ({ action: a });

/** 直接出す塊。⚠ 塊の間は CSS が少し空ける(区切り線は引かない)。 */
export const FORMAT_BAR_GROUPS: readonly (readonly BarItem[])[] = [
  [op('h1'), op('h2'), op('h3')],
  [op('bold'), op('italic'), op('code'), op('link')],
  [op('ul'), op('ol'), op('task'), op('quote')],
  [op('table'), act('insert-entry-link'), act('insert-attachment')],
];

/** 「その他 ▾」の塊(塊の名前は一覧の間の空きに使う)。 */
export const FORMAT_BAR_MORE_GROUPS: readonly { readonly group: string; readonly items: readonly BarItem[] }[] = [
  {
    group: 'insert',
    items: [
      act('insert-diagram'),
      op('codeblock'),
      op('math'),
      act('insert-callout'),
      act('insert-date'),
      act('insert-snippet'),
      act('insert-icon'),
    ],
  },
  { group: 'tidy', items: [act('renumber-lists'), act('sort-tasks'), act('calc-line')] },
  { group: 'find', items: [act('find-in-note'), act('toggle-replace')] },
];

/** 項目の識別子(書式は `op:<op>` / 道具は `action:<name>`)。テストと突合に使う。 */
export function barItemId(item: BarItem): string {
  return 'op' in item ? `op:${item.op}` : `action:${item.action}`;
}

/** 直接出す項目(並び順)。 */
export function visibleBarItems(): readonly BarItem[] {
  return FORMAT_BAR_GROUPS.flat();
}

/** 「その他 ▾」の項目(並び順)。 */
export function moreBarItems(): readonly BarItem[] {
  return FORMAT_BAR_MORE_GROUPS.flatMap((g) => g.items);
}

/**
 * 表(`BAR_FORMAT_OPS`)の書式のうち、並びのどこにも居ないもの。⚠ 空であること(= 足した書式が帯から消えない)。
 */
export function formatOpsMissingFromLayout(): FormatOp[] {
  const placed = new Set(
    [...visibleBarItems(), ...moreBarItems()].flatMap((i) => ('op' in i ? [i.op] : [])),
  );
  return BAR_FORMAT_OPS.map((f) => f.op).filter((o) => !placed.has(o));
}
