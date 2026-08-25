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

import {
  EXT_READY_FLAG,
  deliveredMessage,
  parseExtRequest,
  portHandoffMessage,
  projectionMessage,
  writeResultMessage,
} from '@features/extension/ext-wire';
import { parseExtWrite, type ExtWriteOp } from '@features/extension/ext-write';
import { buildProjection } from '@features/extension/ext-projection';
import type { ExtDeliveredEntry } from '@features/extension/ext-delivery';
import type { EntryMeta } from '@core/model/entry-meta';

export interface ExtHostDeps {
  /** 相手の窓(`launch-tile.ts` が握っている handle)。 */
  readonly win: Window;
  /** いまの一覧を返す。⚠ **呼ぶたびに読む**(古い写しを抱えない)。 */
  readonly metas: () => Iterable<EntryMeta>;
  /**
   * 🔴 **この起動の合図**(外殻に焼いたものと**同じ値**)。
   *
   * ⚠ **合わなければ、外殻は港を黙って捨てる** ── 2026-08-25 に踏んだ:
   *   ここが省略可能だったので、呼び側は渡さず、外殻は `m.nonce !== NONCE` で
   *   本物の港を落としていた。⚠ それでも**両側の unit は緑**だった
   *   (互いに相手を模した stub と話していたので)。
   * 🔑 だから**必須**にする ── 渡し忘れは tsc が止める。
   */
  readonly nonce: string;
  /** 印を待つ間隔(ms)。⚠ 測定では 28〜60ms で立った。 */
  readonly pollMs?: number;
  /** 諦めるまで(ms)。⚠ 諦めたことは `onGiveUp` で言う(無言で終わらない)。 */
  readonly timeoutMs?: number;
  /**
   * 🔴 **書き戻しを実際に当てる係**(#195 / C-5 段③)。
   *
   * ⚠ **optional にしない** ── 渡し忘れると「拡張が書いたつもりで何も起きない」
   *   という**いちばん気づけない形**になる。書かせない繋ぎ方をしたい呼び側は、
   *   **断りを返す関数**を書く(書かされること自体が「書かせない」の明示になる)。
   * ⚠ ここが検めるのは**語彙と渡した覚え**まで。**本文が古くないか**(別の窓が
   *   書き替えていないか)は当てる側にしか分からないので、そちらで見る。
   */
  readonly onWrite: (
    ops: readonly ExtWriteOp[],
  ) => Promise<{ ok: true; wrote: number } | { ok: false; why: string }>;
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
  /**
   * 🔴 **user が押した 1 件を渡す**(#195 / C-5 段②)。
   *
   * ⚠ **返り値を捨てない** ── 港がまだ繋がっていない(アプリが読み込み中 /
   *   時間切れ)ことは普通に起きる。⚠ そこで黙って握り潰すと、user から見て
   *   「**押したのに何も起きない**」になる ── 呼び側が帯で言えるように
   *   `false` を返す(CLAUDE.md「押しても無言、を作らない」)。
   *
   * @returns 渡せたか。`false` = 港が無い(まだ繋がっていない / もう閉じた)
   */
  deliver: (entry: ExtDeliveredEntry) => boolean;
  /**
   * ⚠ test 用 ── user がこの拡張へ渡した lid(書き戻せる集合)。
   * 🔑 **`deliver` が呼ばれた分だけ**増える ── 「取りに行く口は作らない」と
   *   同じ 1 つの原理で、user のジェスチャがこの集合を作る。
   */
  delivered: () => ReadonlySet<string>;
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
  /**
   * 🔴 **user がこの拡張へ渡した lid**(段③ の書き戻せる集合)。
   *
   * ⚠ **link ごとに持つ** ── 別のアプリへ渡した物を、こちらが書けてはいけない。
   * ⚠ **閉じたら消える**(link の寿命 = 集合の寿命)── 窓を開き直したら、
   *   user はもう一度渡すことになる。それが正しい(ジェスチャが許可である)。
   */
  const delivered = new Set<string>();

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
      /**
       * 🔴 **書き戻し**(段③)。⚠ **必ず返事をする** ── 通っても断っても、
       *   拡張の作者が「どうなったか」を知れる形にする。
       * ⚠ **渡した覚えの集合**をここで渡す(封筒は知らない情報である)。
       */
      if (parsed.request.t === 'write') {
        const checked = parseExtWrite(parsed.request.raw, delivered);
        if (!checked.ok) {
          deps.onReject?.(checked.why);
          port?.postMessage(writeResultMessage({ ok: false, why: checked.why }));
          return;
        }
        void deps.onWrite(checked.ops).then(
          (r) => {
            if (!r.ok) deps.onReject?.(r.why);
            // ⚠ 返事の途中で窓が閉じることがある ── 落とさない
            try {
              port?.postMessage(writeResultMessage(r));
            } catch {
              /* 港が閉じた ── 返す相手が居ない */
            }
          },
          (e: unknown) => {
            const why = `書き戻しに失敗しました: ${e instanceof Error ? e.message : String(e)}`;
            deps.onReject?.(why);
            try {
              port?.postMessage(writeResultMessage({ ok: false, why }));
            } catch {
              /* 同上 */
            }
          },
        );
        return;
      }
      send();
    };
    port.start?.();
    try {
      deps.win.postMessage(portHandoffMessage(deps.nonce), '*', [channel.port2]);
      /**
       * 🔴 **繋いだ時点で押す**(2026-08-25、実ブラウザの smoke が拾った)。
       *
       * ⚠ 直す前は `hello` を待っていた ── ところが**アプリの `hello` は港より
       *   先に投げられる**(アプリは `srcdoc` が読み込まれた瞬間に走るが、港は
       *   本体タブが印を読んでから渡す)。外殻は港が無い間の言葉を捨てるので、
       *   **1 回しか挨拶しないアプリには永久に何も届かなかった**。
       * 🔑 だから**押す側から始める**。`hello` は「もう一度ください」として残す
       *   ── 遅れて読み込まれたアプリは、そちらで拾える(両方の競争に勝つ)。
       */
      send();
    } catch {
      // 窓が閉じた直後など ── 繋がらなかっただけ
      port = null;
      deps.onGiveUp?.();
    }
  })();

  return {
    push: send,
    /**
     * ⚠ **`send` と同じ港を使うが、別の関数にする** ── 見取り図は
     *   「一覧が変わったら勝手に押す」物、実体は「user が押したときだけ」の物で、
     *   **起こす条件が違う**。1 つにまとめると、次に触る人が
     *   「一覧が変わったら実体も押す」と書いてしまう(段② の要点が消える)。
     */
    deliver: (entry: ExtDeliveredEntry): boolean => {
      if (port === null) return false;
      try {
        port.postMessage(deliveredMessage(entry));
        // 🔑 **渡せた分だけ**書き戻せるようになる(渡す前に増やさない)
        delivered.add(entry.lid);
        return true;
      } catch {
        // 港が既に閉じている ── 渡せなかったことを呼び側に返す(黙らない)
        return false;
      }
    },
    connected: () => port !== null,
    delivered: () => delivered,
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
