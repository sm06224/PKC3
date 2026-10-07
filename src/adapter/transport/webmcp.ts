/**
 * ブラウザの AI(WebMCP)へ、道具を**登録する**(#1407 段①)。
 *
 * ## 登録の条件は 2 つ
 *
 * 1. **flag `agent.webmcp` がオン**(既定オフ)
 * 2. **メインのタブ(holder)だけ** ── 2 枚目以降のタブ(follower)では登録しない。
 *    同じ ID・同じ道具が複数のタブに並ぶと、AI がどのタブへ呼ぶかを選べず、
 *    follower は保存領域を本体のタブ経由で触る(道具の中身が二重に回る)。
 *
 * ⚠ 入口(`document.modelContext`)が無いブラウザでは**何もしない**(登録しない・エラーも出さない)。
 *
 * ## 登録の寿命は `AbortController` 1 本
 *
 * 全部の道具を同じ `signal` で登録する ── abort すると全部まとめて消える。
 * 消すのは ①タブを閉じるとき ②メインのタブでなくなったとき(`sync(false)`)。
 * ⚠ メインのタブに**なった**ときは `sync(true)` でもう一度登録する(2 度呼んでも二重に登録しない)。
 *
 * 🔑 判断はここに在る(`main.ts` はどの test からも実行されない ── 条件を直に書くと、
 * 「follower でも登録する」型の取り違えが全 test 緑のまま通る)。`main.ts` は呼ぶだけ。
 */

import {
  resolveModelContext,
  type ModelContextLike,
  type ModelContextTool,
} from '@features/agent/webmcp-types';

export interface WebMcpDeps {
  /** flag `agent.webmcp` がオンか(呼ぶたびに読む)。 */
  enabled: () => boolean;
  /** 入口の置き場(`{ document, navigator }`)。⚠ test は偽物を渡す。 */
  host: { document?: unknown; navigator?: unknown };
  /** 登録する道具。⚠ 登録する瞬間に作る(許可の門・ストアは呼び手が束ねる)。 */
  tools: () => ModelContextTool[];
}

export interface WebMcpRegistration {
  /**
   * メインのタブかどうかを知らせる。
   * - `true` かつ flag オン かつ入口あり かつ未登録 → 登録する
   * - `false` で登録済み → 全部消す
   */
  sync: (holder: boolean) => void;
  /** 全部消す(タブを閉じるとき)。 */
  stop: () => void;
  /** いま登録しているか。 */
  active: () => boolean;
}

export function createWebMcpRegistration(deps: WebMcpDeps): WebMcpRegistration {
  let controller: AbortController | null = null;

  const stop = (): void => {
    controller?.abort();
    controller = null;
  };

  const start = (): void => {
    if (controller !== null) return; // 二重に登録しない
    if (!deps.enabled()) return;
    const modelContext: ModelContextLike | null = resolveModelContext(deps.host);
    if (modelContext === null) return; // 対応していないブラウザ ── 何もしない
    const next = new AbortController();
    controller = next;
    for (const tool of deps.tools()) {
      try {
        // ⚠ 返り値は待たない(登録の成否で起動を止めない)。落ちても黙る ── 草案の入口は
        //    ブラウザごとに挙動が違い、登録できないことは user の困りごとではない
        void Promise.resolve(modelContext.registerTool(tool, { signal: next.signal })).catch(
          () => undefined,
        );
      } catch {
        // 同期で投げる実装もある(重複した名前など)── 同じく黙る
      }
    }
  };

  return {
    sync: (holder) => {
      if (holder) start();
      else stop();
    },
    stop,
    active: () => controller !== null,
  };
}
