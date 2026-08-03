/**
 * 描いた HTML を**差分で**面へ当てる(P8 段⑩)。
 *
 * > user 指示 2026-08-03「**1 打鍵ではなく、3 秒周期で差分反映してください /
 * > 1 打鍵では、そんなことしたら、重たくなるし、レンダリングで画面がガクガクする**」
 *
 * 🔴 「ガクガク」の実体は頻度ではなく**1 回の重さ**である:
 *  - `innerHTML` の丸ごと差し替えは 300KB の HTML を毎回 parse する
 *  - DOM が全部作り直されるので **scroll 位置が飛ぶ**
 *  - 図(mermaid)の `<img>` も捨てられ、**焼き直しのあいだ絵が消える**
 *
 * ここは**変わった塊だけ**を作り直す。触っていない図はそのまま生き残る。
 *
 * ⚠ 塊は「要素 1 個」とは限らない ── 塊の末尾には**改行のテキストノード**が付く。
 * だから位置は `children` の添字ではなく、**塊ごとのノード列**で覚える
 * (`children` で数えると、当てるたびに改行が落ちて `innerHTML` が食い違う ──
 *  実際にそう壊れた)。
 *
 * ⚠ 戻り値の `inserted` は「**新しく入った要素**」── 呼び側はそこにだけ図の
 * 面倒を見る(全体に掛け直すと、生きている `<img>` の ObjectURL を revoke する)。
 */
import { splitTopLevelBlocks, diffBlocks } from '@features/markdown/html-blocks';

/** いま面に出ているもの。⚠ **呼び側が持ち回る**(DOM から読み直さない)。 */
export interface BlockView {
  blocks: readonly string[];
  /** 塊 i を作っているノード列(要素 + 後ろの空白)。 */
  nodes: readonly (readonly Node[])[];
}

export const EMPTY_VIEW: BlockView = { blocks: [], nodes: [] };

export interface ApplyResult {
  /** 新しく DOM に入った要素(図の hydrate 対象)。 */
  inserted: Element[];
  /** 実際に作り直した塊の数(0 = 何も触っていない)。計測と test の観測点。 */
  replaced: number;
  view: BlockView;
}

/** 1 塊ぶんの HTML をノード列にする。 */
function parseBlock(html: string): Node[] {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  return [...tpl.content.childNodes];
}

/** 丸ごと置く(初回・食い違い時)。 */
function replaceAll(host: HTMLElement, blocks: readonly string[]): ApplyResult {
  host.textContent = '';
  const nodes: Node[][] = [];
  const inserted: Element[] = [];
  for (const b of blocks) {
    const ns = parseBlock(b);
    for (const n of ns) {
      host.append(n);
      if (n instanceof Element) inserted.push(n);
    }
    nodes.push(ns);
  }
  return { inserted, replaced: blocks.length, view: { blocks, nodes } };
}

/** 覚えているノード列が**まだ DOM と合っているか**(外から書き換えられていないか)。 */
function intact(host: HTMLElement, view: BlockView): boolean {
  if (view.blocks.length !== view.nodes.length || view.blocks.length === 0) return false;
  let count = 0;
  for (const ns of view.nodes) {
    for (const n of ns) {
      if (n.parentNode !== host) return false;
      count += 1;
    }
  }
  return count === host.childNodes.length;
}

export function applyBlocks(host: HTMLElement, html: string, view: BlockView): ApplyResult {
  const next = splitTopLevelBlocks(html);
  if (!intact(host, view)) return replaceAll(host, next);

  // ⚠ 変わっていないときの早期 return は**置いていない** ── 下の一般経路が
  // そのまま「何も取り除かず何も入れない」になるので、挙動が同じ分岐は死んでいる
  // (変異試験で「消しても誰も気づかない」ことを確認した)
  const patch = diffBlocks(view.blocks, next);

  // 取り除く(prefix の直後から removed 個ぶんのノードを全部)
  const oldNodes = view.nodes;
  for (let k = 0; k < patch.removed; k++) {
    for (const n of oldNodes[patch.prefix + k]!) (n as ChildNode).remove();
  }
  // 入れる(⚠ **真ん中だけ** parse する ── ここが効いている所)
  const anchor = oldNodes[patch.prefix + patch.removed]?.[0] ?? null;
  const inserted: Element[] = [];
  const middleNodes: Node[][] = [];
  for (const b of patch.middle) {
    const ns = parseBlock(b);
    for (const n of ns) {
      host.insertBefore(n, anchor);
      if (n instanceof Element) inserted.push(n);
    }
    middleNodes.push(ns);
  }
  const nodes = [
    ...oldNodes.slice(0, patch.prefix),
    ...middleNodes,
    ...oldNodes.slice(patch.prefix + patch.removed),
  ];
  return { inserted, replaced: patch.middle.length, view: { blocks: next, nodes } };
}
