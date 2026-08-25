/**
 * 🔴 **拡張へ港を渡し、見取り図を押し出す**(#195 / C-5 段①)。
 *
 * 設計と実測は `docs/development/pkc-extension-host-design-2026-08.md` §4。
 *
 * ## 港の渡し方は**測って決まった**(2026-08-25)
 *
 * 外殻(`window.open` した別窓)からは「用意ができた」と言えない ──
 * `launch-tile.ts` が **`win.opener = null`** しているからである(外殻自体は信用
 * できるが、その中のアプリが `parent.opener` へ投げられる)。だから**本体タブが
 * 渡す側**になる。3 本を同じ回で比べた結果:
 *
 * | 腕 | headless_shell | 実 Chromium |
 * |---|---|---|
 * | 毎回新しい channel で送り直す | 10/10(常に 2 回目) | 6/6 |
 * | `readyState === 'complete'` を待つ | **0/10** | **0/6** |
 * | 🔑 **外殻の印を読んで 1 回** | **10/10**(28〜60ms) | **6/6** |
 *
 * 🔴 `readyState` が使えないのは、**`window.open('')` の窓が `about:blank` の時点で
 * `'complete'` になる**からである ── **放っておいても真になる観測点**(CLAUDE.md §4)。
 *
 * ## 🔴 許可が無ければ**港そのものを渡さない**
 *
 * ⚠ 「渡してから中身で断る」形にしない ── 港が在る限り、次に語彙を足した人が
 * 「もう繋がっているから」で通してしまう。**繋がない**のがいちばん強い断り方である。
 *
 * ## ⚠ 窓が閉じたら手を切る
 *
 * 押し出しの購読を残すと、閉じた窓へ投げ続けることになる(例外は握り潰されるので
 * **黙って無駄が積もる**)。`close()` で購読も港も捨てる。
 */

import { EXT_PORT_TAG, EXT_READY_FLAG, parseExtRequest, projectionMessage } from '@features/extension/ext-wire';
import { buildProjection } from '@features/extension/ext-projection';
import type { EntryMeta } from '@core/model/entry-meta';

export interface ExtHostDeps {
  /** 相手の窓(`launch-tile.ts` が握っている handle)。 */
  readonly win: Window;
  /** いまの一覧を返す。⚠ **呼ぶたびに読む**(古い写しを抱えない)。 */
  readonly metas: () => Iterable<EntryMeta>;
  /** 印を待つ間隔(ms)。⚠ 測定では 28〜60ms で立った。 */
  readonly pollMs?: number;
  /** 諦めるまで(ms)。⚠ 諦めたことは `onGiveUp` で言う(無言で終わらない)。 */
  readonly timeoutMs?: number;
  /** 断ったこと・諦めたことを数えるため。 */
  readonly onReject?: (why: string) => void;
  /** 印が立たないまま時間切れ。 */
  readonly onGiveUp?: () => void;
  /** ⚠ test が差せる(実時間を待たない)。 */
  readonly sleep?: (ms: number) => Promise<void>;
}

/** 開いている拡張 1 つとの繋がり。 */
export interface ExtHostLink {
  /** 見取り図を押し直す(一覧が変わったとき)。⚠ 港が無ければ何もしない。 */
  push: () => void;
  /** 手を切る(窓が閉じた / 許可が外れた)。 */
  close: () => void;
  /** ⚠ test 用 ── 港が繋がったか。 */
  connected: () => boolean;
}

const DEFAULT_POLL_MS = 10;
const DEFAULT_TIMEOUT_MS = 5000;

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * 港を渡して、見取り図の受け答えを始める。
 *
 * ⚠ **許可の判定はここに書かない** ── 呼び側(boot)が `ExtensionGrants` で決めて、
 *   許されたときだけこれを呼ぶ。ここに 2 つ目の判定を置くと、片方だけ直る形になる。
 */
export function connectExtension(deps: ExtHostDeps): ExtHostLink {
  const pollMs = deps.pollMs ?? DEFAULT_POLL_MS;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const sleep = deps.sleep ?? wait;
  let port: MessagePort | null = null;
  let closed = false;

  const send = (): void => {
    if (port === null) return;
    port.postMessage(projectionMessage(buildProjection(deps.metas())));
  };

  void (async () => {
    const deadline = Date.now() + timeoutMs;
    // 🔑 **外殻の印を読んでから 1 回だけ渡す**(測定で決めた形)
    for (;;) {
      if (closed) return;
      let ready: boolean;
      try {
        ready = (deps.win as unknown as Record<string, unknown>)[EXT_READY_FLAG] === 1;
      } catch {
        // 窓が閉じた / 触れない ── 諦める側に落とす(印は立っていない)
        ready = false;
      }
      if (ready) break;
      if (Date.now() >= deadline) {
        deps.onGiveUp?.();
        return;
      }
      await sleep(pollMs);
    }
    if (closed) return;
    const channel = new MessageChannel();
    port = channel.port1;
    port.onmessage = (ev: MessageEvent): void => {
      const parsed = parseExtRequest(ev.data);
      // ⚠ **黙って捨てない**(理由を数えられる形にする)
      if (!parsed.ok) {
        deps.onReject?.(parsed.why);
        return;
      }
      send();
    };
    port.start?.();
    try {
      deps.win.postMessage({ tag: EXT_PORT_TAG }, '*', [channel.port2]);
    } catch {
      // 窓が閉じた直後など ── 繋がらなかっただけ
      port = null;
      deps.onGiveUp?.();
    }
  })();

  return {
    push: send,
    connected: () => port !== null,
    close: () => {
      closed = true;
      if (port !== null) {
        port.onmessage = null;
        port.close();
        port = null;
      }
    },
  };
}
