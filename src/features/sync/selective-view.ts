/**
 * 🔴 **選択同期(#2066 段 5-B)の画面の写し** ── 設定・情報ペイン・右クリック・一覧が同じ 1 つの写しを読む。
 *
 * - 写しは同期が入のときだけ作る(切 = `null`)。範囲が「ワークスペース全体」(`'all'`)のときは閉包を計算せず、理由の表は空。
 * - 閉包は書き出しと同じ `resolveSelectiveClosure`(同じ問いに 2 か所で答えない)。
 * - 画面の言葉(理由の名前・件数の要約)もここ 1 か所に置く。
 *
 * ⚠ pure module。worker の読み(`syncSelectiveView`)の結果を受けて組むだけ。
 */
import { resolveSelectiveClosure, type SelectiveReason } from './selective-sync';
import type { SyncRelatedMode, SyncScopeMode } from './sync-state';
import { isReservedSyncLid } from './sync-guard';

export interface SelectiveCounts {
  readonly total: number;
  readonly direct: number;
  readonly descendant: number;
  readonly related: number;
  readonly ancestor: number;
}

export interface SyncScopeView {
  readonly mode: SyncScopeMode;
  readonly related: SyncRelatedMode;
  /** 直接指定(生きていない lid も含む ── 設定の行そのまま)。 */
  readonly directLids: ReadonlySet<string>;
  /** 対象のノート → 理由(`'all'` のときは空)。 */
  readonly reasons: ReadonlyMap<string, SelectiveReason>;
  /** `descendant` のノート → それを含めている直接指定の親フォルダ(いちばん近い物)。 */
  readonly via: ReadonlyMap<string, string>;
  readonly counts: SelectiveCounts;
  /** 中身の指紋(同じなら state を差し替えない)。 */
  readonly key: string;
}

export interface SelectiveViewInput {
  readonly selective: { readonly mode: SyncScopeMode; readonly related: SyncRelatedMode; readonly directLids: readonly string[] };
  readonly notes: ReadonlyArray<{ readonly lid: string; readonly archetype: string; readonly parentLid: string | null }>;
  readonly relations: ReadonlyArray<{ readonly from: string; readonly to: string; readonly kind: string }>;
  readonly bodyRefs: Readonly<Record<string, readonly string[]>>;
}

const ZERO: SelectiveCounts = { total: 0, direct: 0, descendant: 0, related: 0, ancestor: 0 };

/** worker の読みから写しを組む。⚠ `'all'` のときは閉包を計算しない。 */
export function buildSyncScopeView(input: SelectiveViewInput): SyncScopeView {
  const { mode, related } = input.selective;
  const directLids = new Set(input.selective.directLids);
  const head = JSON.stringify([mode, related, [...directLids].sort()]);
  if (mode !== 'selective') return { mode, related, directLids, reasons: new Map(), via: new Map(), counts: ZERO, key: head };
  const closure = resolveSelectiveClosure({
    notes: input.notes,
    relations: input.relations,
    bodyRefs: input.bodyRefs,
    directLids,
    relatedMode: related,
  });
  const counts = { total: 0, direct: 0, descendant: 0, related: 0, ancestor: 0 };
  for (const r of closure.reasons.values()) {
    counts.total++;
    counts[r]++;
  }
  const parent = new Map(input.notes.map((n) => [n.lid, n.parentLid] as const));
  const via = new Map<string, string>();
  for (const [lid, r] of closure.reasons) {
    if (r !== 'descendant') continue;
    const seen = new Set<string>([lid]);
    let p = parent.get(lid) ?? null;
    while (p !== null && !seen.has(p)) {
      if (closure.reasons.get(p) === 'direct') {
        via.set(lid, p);
        break;
      }
      seen.add(p);
      p = parent.get(p) ?? null;
    }
  }
  const key = JSON.stringify([head, [...closure.reasons].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)), [...via].sort()]);
  return { mode, related, directLids, reasons: closure.reasons, via, counts, key };
}

/** 選択同期の画面を出すか(同期が入 かつ 選んだエントリだけ同期)。⚠ 4 つの画面がこの 1 つを使う。 */
export function selectiveActive(view: SyncScopeView | null | undefined): view is SyncScopeView {
  return view != null && view.mode === 'selective';
}

/** 理由 → 画面の言葉。 */
export const SELECTIVE_REASON_LABELS: Readonly<Record<SelectiveReason, string>> = {
  direct: '同期対象(直接指定)',
  descendant: '同期対象(親フォルダ配下)',
  related: '同期対象(関連エントリとして同伴)',
  ancestor: '同期対象(親フォルダの階層のみ)',
};

export const SELECTIVE_OUTSIDE_LABEL = '同期対象外(この端末のみ)';

/** 一覧の印の説明(`title`)。 */
export const SELECTIVE_REASON_HINTS: Readonly<Record<SelectiveReason, string>> = {
  direct: '同期対象として直接選んだエントリです',
  descendant: '同期対象のフォルダの中にあるため、同期対象に含まれます',
  related: '同期対象のエントリとつながっているため、一緒に同期します',
  ancestor: '同期対象のエントリの置き場所を相手の端末で再現するため、フォルダだけを同期します(中の他のエントリは含みません)',
};

export const SELECTIVE_ADD_LABEL = '同期対象にする';
export const SELECTIVE_REMOVE_LABEL = '同期対象から外す';
export const SELECTIVE_CLEAR_LABEL = '選択をすべて外す';

export const SELECTIVE_EMPTY_TEXT = 'まだ同期対象が選ばれていません。一覧の右クリックメニューや情報ペインから選べます';

/** 件数の要約。0 件なら案内。 */
export function selectiveSummaryText(c: SelectiveCounts): string {
  if (c.total === 0) return SELECTIVE_EMPTY_TEXT;
  return `同期対象: 合計 ${c.total} 件(直接指定 ${c.direct} / フォルダ配下 ${c.descendant} / 関連 ${c.related} / 親フォルダ ${c.ancestor})`;
}

/**
 * 右クリックのメニューの材料(`EntryMenuContext.syncDirect`)。⚠ 選択同期が効いていない・system 領域のノートは `{}`(= 出さない)。
 */
export function selectiveMenuCtx(view: SyncScopeView | null | undefined, lid: string): { syncDirect?: boolean } {
  if (!selectiveActive(view) || isReservedSyncLid(lid)) return {};
  return { syncDirect: view.directLids.has(lid) };
}
