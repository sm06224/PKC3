/**
 * 「許すページの一覧」が変わったとき、組み込み先の AI への登録を合わせ直す配線(#1407)。
 *
 * 🔑 `main.ts` はどの test からも実行されないので、判断はここに取り出してある。
 *
 * - 一覧から**外れた** origin は `revoke`(WebMCP の登録・飛んでいる依頼・ダイアログを今すぐ畳む)。
 *   何が外れたかは**前回の一覧との差**で採る ── 画面から外したときも、別のタブが書き換えたとき(`storage` event)も同じ道。
 * - そのあと `sync`(足された origin で「常に許す」済みのものを登録する)。
 * - 別のタブの書込は `storage` event で来る(自分のタブの書込では来ない)── key が一覧の物か、全消去(`null`)のときだけ受ける。
 */
import { EMBED_ORIGINS_KEY, type EmbedOriginsStore } from './embed-origins';
import type { AgentEmbed } from './agent-embed';

export function wireEmbedOrigins(
  store: EmbedOriginsStore,
  embed: Pick<AgentEmbed, 'revoke' | 'sync'>,
  win: Pick<Window, 'addEventListener'>,
): void {
  let last = store.list();
  store.onChange(() => {
    const now = store.list();
    for (const o of last) if (!now.includes(o)) embed.revoke(o);
    last = now;
    embed.sync();
  });
  win.addEventListener('storage', (ev) => {
    if (ev.key !== EMBED_ORIGINS_KEY && ev.key !== null) return;
    store.notifyExternal();
  });
}
