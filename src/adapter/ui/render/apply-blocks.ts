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
  /**
   * 🔴 **前回 pin されていた塊の添字**(昇順。2026-08-05。ライブエディタ S4)。
   *
   * pin = 「いま編集していて、**絶対に作り直してはいけない**塊」。中に生きた
   * `<textarea>`(と IME の変換状態)が居るので、差し替えると composition が
   * **例外もイベントも出さずに死ぬ**(設計 §5 契約 2)。
   * ⚠ **最初から配列**で持つ(4 本目の柱で常時ライブな部品が N 個になる予約 ──
   * 設計 §10)。いまは 0 個か 1 個。
   */
  pin: readonly number[];
}

export const EMPTY_VIEW: BlockView = { blocks: [], nodes: [], pin: [] };

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
function replaceAll(
  host: HTMLElement,
  blocks: readonly string[],
  pin: readonly number[] = [],
): ApplyResult {
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
  return { inserted, replaced: blocks.length, view: { blocks, nodes, pin } };
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

/**
 * 1 区間ぶんを当てる(差分 → 取り除く → 真ん中だけ parse して入れる)。
 *
 * ⚠ **pin の有無で 2 実装に割らない**。pin が在るときは呼び側が区間へ切って
 * この関数を複数回呼ぶ ── 中身は 1 本のままにする(設計 §7-8)。
 *
 * @param anchor 入れる位置(この直前に入れる)。null = host の末尾
 */
function patchSegment(
  host: HTMLElement,
  oldBlocks: readonly string[],
  oldNodes: readonly (readonly Node[])[],
  newBlocks: readonly string[],
  anchor: Node | null,
): { inserted: Element[]; replaced: number; nodes: Node[][] } {
  const patch = diffBlocks(oldBlocks, newBlocks);
  for (let k = 0; k < patch.removed; k++) {
    for (const n of oldNodes[patch.prefix + k]!) (n as ChildNode).remove();
  }
  const insertBefore = oldNodes[patch.prefix + patch.removed]?.[0] ?? anchor;
  const inserted: Element[] = [];
  const middleNodes: Node[][] = [];
  for (const b of patch.middle) {
    const ns = parseBlock(b);
    for (const n of ns) {
      host.insertBefore(n, insertBefore);
      if (n instanceof Element) inserted.push(n);
    }
    middleNodes.push(ns);
  }
  return {
    inserted,
    replaced: patch.middle.length,
    nodes: [
      ...oldNodes.slice(0, patch.prefix).map((x) => [...x]),
      ...middleNodes,
      ...oldNodes.slice(patch.prefix + patch.removed).map((x) => [...x]),
    ],
  };
}

/**
 * @param pin **今回**作り直してはいけない塊の添字(`html` の塊での添字。昇順)。
 *   ⚠ 前回も pin が在り、その塊の HTML が前回と同じときだけ「守る」経路に入る
 *   (= 編集中に外からパッチが来た場合)。pin が新しく付いた / 外れた瞬間は
 *   普通の経路で入れ替える ── それが「差し替える / 元に戻す」当の操作である。
 */
export function applyBlocks(
  host: HTMLElement,
  html: string,
  view: BlockView,
  pin: readonly number[] = [],
): ApplyResult {
  const next = splitTopLevelBlocks(html);
  if (!intact(host, view)) return replaceAll(host, next, pin);

  const guarded =
    pin.length > 0 &&
    view.pin.length === pin.length &&
    pin.every((p, k) => {
      const q = view.pin[k]!;
      return next[p] !== undefined && view.blocks[q] !== undefined && next[p] === view.blocks[q];
    });

  if (!guarded) {
    // ⚠ 変わっていないときの早期 return は**置いていない** ── 下の一般経路が
    // そのまま「何も取り除かず何も入れない」になるので、挙動が同じ分岐は死んでいる
    // (変異試験で「消しても誰も気づかない」ことを確認した)
    const r = patchSegment(host, view.blocks, view.nodes, next, null);
    return {
      inserted: r.inserted,
      replaced: r.replaced,
      view: { blocks: next, nodes: r.nodes, pin },
    };
  }

  /**
   * 🔴 **pin を跨いで差分を当てない**(2026-08-05。S4)。
   *
   * `diffBlocks` は前後一致で真ん中を丸ごと入れ替えるので、**pin の前後が両方
   * 変わると pin のノードごと取り除かれる**。中に生きた `<textarea>` が居るので、
   * それは編集の消失(と IME の無言の死)になる。
   * だから pin の位置で**区間に切って**、区間ごとに同じ実装を当てる。
   */
  const inserted: Element[] = [];
  let replaced = 0;
  const nodes: Node[][] = [];
  let oldFrom = 0;
  let newFrom = 0;
  for (let k = 0; k < pin.length; k += 1) {
    const oldPin = view.pin[k]!;
    const newPin = pin[k]!;
    // pin の**手前**の区間。入れる位置は pin のノードの直前
    const anchorNode = view.nodes[oldPin]?.[0] ?? null;
    const seg = patchSegment(
      host,
      view.blocks.slice(oldFrom, oldPin),
      view.nodes.slice(oldFrom, oldPin),
      next.slice(newFrom, newPin),
      anchorNode,
    );
    inserted.push(...seg.inserted);
    replaced += seg.replaced;
    nodes.push(...seg.nodes);
    // pin 自身は**触らない**(同一オブジェクトのまま持ち越す)
    nodes.push([...(view.nodes[oldPin] ?? [])]);
    oldFrom = oldPin + 1;
    newFrom = newPin + 1;
  }
  // 最後の pin より後ろの区間
  const tail = patchSegment(
    host,
    view.blocks.slice(oldFrom),
    view.nodes.slice(oldFrom),
    next.slice(newFrom),
    null,
  );
  inserted.push(...tail.inserted);
  replaced += tail.replaced;
  nodes.push(...tail.nodes);
  return { inserted, replaced, view: { blocks: next, nodes, pin } };
}
