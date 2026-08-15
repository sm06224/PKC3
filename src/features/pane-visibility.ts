/**
 * ペインの表示・非表示(#197 / 台帳 #180 の D-1)。
 *
 * 🔴 **中央は畳めない。** 畳めるのは左(一覧)と右(付随情報)だけ ── 中央は
 * 「いま開いているノート」であり、これが消せると 1 画面で完結しなくなる。
 *
 * ⚠ user 指示「**同じものが常に同じ場所にある(モードで配置が変わらない)**」と
 * 擦れるので、**畳んだ状態を覚える**までやる(毎回配置が変わる画面にしない)。
 * 覚える先は `adapter/ui/render/pane-visibility.ts`(`editor-mode.ts` と同じ分け方 ──
 * ここは純関数だけ)。
 */
export const PANES = ['sidebar', 'inspector'] as const;

export type PaneId = (typeof PANES)[number];

/** 押しボタンに出す名前。⚠ 変えたらマニュアルも直す(`docs-parity`)。 */
export const PANE_LABELS: Readonly<Record<PaneId, string>> = {
  sidebar: '一覧',
  inspector: '情報',
};

export function isPaneId(v: string): v is PaneId {
  return (PANES as readonly string[]).includes(v);
}

/**
 * 畳む・戻すを 1 手で。⚠ **並びは `PANES` の順に正規化する** ── 押した順で
 * 保存すると、同じ状態が 2 通りの文字列になり、保存の比較が効かなくなる。
 */
export function togglePane(hidden: readonly PaneId[], id: PaneId): PaneId[] {
  const next = new Set(hidden);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return PANES.filter((p) => next.has(p));
}

/**
 * 保存の形。⚠ **空なら空文字**(区切りだけの文字列を書かない)。
 * ⚠ 知らない名前は捨てる ── 面の名前が変わった後の古い保存で画面が壊れない。
 */
export function encodeHidden(hidden: readonly PaneId[]): string {
  return PANES.filter((p) => hidden.includes(p)).join(' ');
}

export function decodeHidden(raw: string | null | undefined): PaneId[] {
  if (!raw) return [];
  const seen = new Set(raw.split(/\s+/).filter(isPaneId));
  return PANES.filter((p) => seen.has(p));
}
