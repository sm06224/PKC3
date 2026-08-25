/**
 * 🔴 **いま開いている拡張の台帳**(#195 / C-5 段②)。
 *
 * ## なぜ台帳が要るのか
 *
 * 段① まで、港は `launchTile` が**ローカル変数で握っていた**だけだった ──
 * 開いて、窓が閉じたら `close()` する、で足りていた(押し出しは中から起こるので)。
 * ⚠ 段② は**外から**起こる:user が情報ペインで「このアプリへ送る」を押す。
 * 🔑 だから「**いまどのアプリが開いているか**」を、`launchTile` の外から
 *   引ける場所が 1 つ要る。
 *
 * ## ⚠ 幽霊を残さない
 *
 * 🔴 **閉じたら必ず外す。** 外し忘れると、一覧に**閉じた窓が残る** ──
 * user は押せてしまい、`deliver` は `false` を返し、画面には
 * 「送れませんでした」だけが出る(**なぜかは分からない**)。
 * 🔑 だから `track()` は**外すことまで込みの link** を返す ── 呼び側は
 *   今までどおり `close()` を呼ぶだけでよく、**外し忘れようがない**
 *   (CLAUDE.md「作る場所と返す場所を 1 対にする」= `createUrl` / `revokeUrl` と同じ倒し方)。
 *
 * ## ⚠ 同じアプリを 2 枚開いたら、2 行出る
 *
 * 🔑 鍵は `appId` ではなく**通し番号**にしてある ── `appId`(タイルの lid)で
 *   持つと、2 枚目を開いた瞬間に 1 枚目が台帳から消え、**1 枚目へは二度と
 *   送れなくなる**(窓は開いたままなのに)。
 * ⚠ 題名が同じ 2 行は user には見分けにくいが、**送り先が消えるよりはよい** ──
 *   消えるほうは「押せない」ではなく「**押しても違う窓に届く**」形で壊れる。
 */

import type { ExtHostLink } from './extension-host';
import type { ExtDeliveredEntry } from '@features/extension/ext-delivery';

/** 一覧に出す 1 枚。⚠ 窓そのものは渡さない(呼び側に触らせない)。 */
export interface OpenExtension {
  /** 🔑 台帳の中だけで使う通し番号。⚠ `appId` ではない(上の「2 枚開いたら」)。 */
  readonly id: string;
  /** タイルの lid。⚠ 同じ値の行が複数あってよい。 */
  readonly appId: string;
  /** 画面に出す名前。 */
  readonly title: string;
}

export interface ExtLinkRegistry {
  /**
   * 台帳に載せ、**外すことまで込みの link** を返す。
   * ⚠ 返ってきたほうを使うこと(元の `link` を握ると外れない)。
   */
  track: (app: { appId: string; title: string }, link: ExtHostLink) => ExtHostLink;
  /** いま開いている拡張(開いた順)。 */
  list: () => readonly OpenExtension[];
  /**
   * 1 枚へ実体を渡す。
   * @returns 渡せたか。⚠ `false` = その id がもう無い / 港が繋がっていない
   */
  deliver: (id: string, entry: ExtDeliveredEntry) => boolean;
}

export function createExtLinkRegistry(): ExtLinkRegistry {
  /** ⚠ **挿入順を保つ**ので `Map`(一覧の並びが開いた順になる)。 */
  const open = new Map<string, { app: OpenExtension; link: ExtHostLink }>();
  let serial = 0;

  return {
    track: (app, link) => {
      serial += 1;
      const id = `ext-${serial}`;
      open.set(id, { app: { id, appId: app.appId, title: app.title }, link });
      return {
        push: link.push,
        deliver: link.deliver,
        connected: link.connected,
        close: () => {
          // 🔑 **先に外してから閉じる** ── 逆順にすると、`close()` が投げたときに
          //    台帳へ幽霊が残る(閉じた窓が一覧に出続ける)
          open.delete(id);
          link.close();
        },
      };
    },
    list: () => [...open.values()].map((v) => v.app),
    deliver: (id, entry) => open.get(id)?.link.deliver(entry) ?? false,
  };
}

/**
 * 🔑 **常駐の台帳は 1 つ**(`appExtensionGrants` と同じ形)。
 *
 * ⚠ 窓は 1 タブに複数開けるが、**開いているのはこのタブだけが知っている** ──
 *   別タブの窓へ送る道は作らない(港はこのタブが握っているので、そもそも届かない)。
 */
export const appExtLinks: ExtLinkRegistry = createExtLinkRegistry();
