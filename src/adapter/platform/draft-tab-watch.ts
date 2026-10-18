/**
 * 別のウィンドウ(付箋・アプリのウィンドウ)が書きかけのまま閉じたことを、本体へ知らせる(依頼 219・329)。
 *
 * 何が起きていたか:書きかけの字は、どのウィンドウも約 1 秒ごとにこの端末へ控える(`draft-writer.ts`)。
 * ところが「保存していない編集が残っています」の 1 行を聞くのは本体の起動のときだけだった ──
 * 本体を開いたままの人は、付箋を書きかけで閉じても、次に PKC3 を起動し直すまで気づけなかった。
 *
 * 🔑 仕組みは 2 つだけ:
 * 1. 別のウィンドウは、開いたときに自分の印(`draft-store.ts` の生きているタブの印)を放送する。
 * 2. 本体はその印の Web Locks を待つ(取れるのはそのウィンドウが閉じたとき)── 取れたら 1 行を読み直す。
 * ⚠ Web Locks が無い端末では閉じたことを見分けられない ── 従来どおり、次の起動で聞く(黙って嘘をつかない)。
 * ⚠ 放送するのは**印だけ**。控えの中身(本文・題名)は放送路に乗せない(端末の外へ出さない判断と同じ向き)。
 */
import type { Broadcaster } from './storage/store-proxy';

export const DRAFT_TABS_CHANNEL = 'pkc3-draft-tabs';
/** 便りの種別。⚠ 名前を付ける ── 将来この路に別の便りが乗っても取り違えない。 */
export const DRAFT_TAB_OPEN = 'draft-tab-open';

export type MakeDraftChannel = (name: string) => Broadcaster;

function openChannel(make: MakeDraftChannel | undefined): Broadcaster | null {
  if (make !== undefined) return make(DRAFT_TABS_CHANNEL);
  if (typeof BroadcastChannel !== 'function') return null;
  return new BroadcastChannel(DRAFT_TABS_CHANNEL) as unknown as Broadcaster;
}

/** 別のウィンドウが、自分の印を本体へ知らせる(1 度だけ)。同じコレクションの本体だけが聞く。 */
export function announceDraftTab(tab: string, cid: string, make?: MakeDraftChannel): void {
  const ch = openChannel(make);
  if (ch === null) return;
  ch.postMessage({ kind: DRAFT_TAB_OPEN, tab, cid });
  ch.close();
}

/**
 * そのウィンドウが閉じるまで待つ。閉じたら `true`。
 * 待てない端末(Web Locks が無い)は**永久に待つ**のではなく `false` で返す ── 閉じたとは言わない。
 */
export async function waitDraftTabEnd(tab: string): Promise<boolean> {
  try {
    const locks = navigator.locks;
    if (!locks) return false;
    // 生きているタブは shared で握っている(`holdTabLock`)── exclusive が取れるのは全員が手放した後
    return await locks.request(`pkc3-draft-tab:${tab}`, { mode: 'exclusive' }, async () => true);
  } catch {
    return false;
  }
}

export interface DraftTabWatchDeps {
  readonly cid: string;
  readonly make?: MakeDraftChannel;
  /** 閉じるまで待つ(既定は {@link waitDraftTabEnd})。 */
  readonly waitEnd?: (tab: string) => Promise<boolean>;
  /** 閉じた。 */
  readonly onEnded: (tab: string) => void;
}

/** 本体が聞く。止めるときは返り値を呼ぶ。 */
export function watchDraftTabs(deps: DraftTabWatchDeps): () => void {
  const ch = openChannel(deps.make);
  if (ch === null) return () => {};
  const waitEnd = deps.waitEnd ?? waitDraftTabEnd;
  const seen = new Set<string>();
  ch.onmessage = (ev: MessageEvent) => {
    const w = ev.data as { kind?: unknown; tab?: unknown; cid?: unknown } | null;
    if (w === null || typeof w !== 'object') return;
    if (w.kind !== DRAFT_TAB_OPEN || typeof w.tab !== 'string' || w.cid !== deps.cid) return;
    // 同じ印を 2 度待たない(放送が重なっても、閉じたときの 1 行は 1 度)
    if (seen.has(w.tab)) return;
    seen.add(w.tab);
    const tab = w.tab;
    void waitEnd(tab).then(
      (ended) => {
        if (ended) deps.onEnded(tab);
      },
      () => {},
    );
  };
  return () => {
    ch.onmessage = null;
    ch.close();
  };
}
