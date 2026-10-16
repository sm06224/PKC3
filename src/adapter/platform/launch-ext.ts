/**
 * 🔴 **アプリを起動するときの「拡張の口」の配線を 1 か所に置く**(L2)。
 *
 * 起動の入口は 2 つある ── 添付の詳細(`launchAsset`)と、一覧のタイル(`launchLauncherTile`)。
 * ⚠ 直す前は詳細の入口だけが `ext` を渡していて、**拡張を許可したアプリを一覧のタイルから
 *   開くと港が渡らなかった**(許可したのに、一覧から開くと繋がらない)。
 * 🔑 同じ配線を 2 か所に書き写すと片方だけ直った日に同じ穴が戻るので、**組む口は 1 つ**。
 *   ここは `main.ts` から取り出してある(`main.ts` はどの test からも実行されない)。
 *
 * ⚠ **聞くかどうか・描き直すかは呼び側が決める**(`confirm` / `afterGrant`)。
 *   タイルは「憶えた許可を使う」だけなので、**聞かない**(`confirm` は常に断る。
 *   `launchTile` は `opts.extension` が立たない限り `confirm` を呼ばないので、実際は呼ばれない)。
 */
import type { LaunchDeps } from '@adapter/ui/launch-tile';
import type { ExtLinkRegistry } from '@adapter/platform/extension-links';
import { connectExtension, type ExtHostDeps } from '@adapter/platform/extension-host';

export interface LaunchExtParts {
  /** 許可の台帳(`appExtensionGrants`)。 */
  readonly grants: {
    isGranted: (assetKey: string | null) => boolean;
    grant: (assetKey: string | null) => boolean;
  };
  /** 開いている拡張の台帳(`appExtLinks`)。 */
  readonly links: ExtLinkRegistry;
  /** 見取り図の元。⚠ 呼ぶたびに読む。 */
  readonly metas: ExtHostDeps['metas'];
  readonly onWrite: ExtHostDeps['onWrite'];
  readonly nonce: () => string;
  /** 聞く。⚠ タイルは `async () => false`(許可を新しく出さない)。 */
  readonly confirm: (title: string) => Promise<boolean>;
  /** 憶えた直後に描き直す(許可は state に無いので、呼び側が倒す)。 */
  readonly afterGrant?: () => void;
}

export function buildLaunchExt(p: LaunchExtParts): NonNullable<LaunchDeps['ext']> {
  return {
    granted: (assetKey) => p.grants.isGranted(assetKey ?? null),
    grant: (assetKey) => {
      const ok = p.grants.grant(assetKey ?? null);
      p.afterGrant?.();
      return ok;
    },
    confirm: p.confirm,
    connect: (win, nonce, app) =>
      p.links.track(
        app,
        connectExtension({
          win,
          // 🔴 外殻に焼いたものと**同じ合図**(別々に作ると外殻が港を捨てる)
          nonce,
          metas: p.metas,
          onWrite: p.onWrite,
        }),
      ),
    nonce: p.nonce,
  };
}
