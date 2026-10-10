/**
 * 🔴 **検索した語の記録**の節(#1172)── 「記録」の h3 の中。
 * (#1382 で `settings.ts` から移した。中身は変えていない。)
 */
import { buildSettingsNote } from './note';
import type { SettingsSection } from './section';

export function createSearchHistorySection(): SettingsSection {
  return {
    id: 'search-history',
    group: 'history',
    /**
     * 🔴 **検索した語の記録**(#1172)── 「最近開いたノートの記録」の隣。
     * ⚠ 左の列の「本文ごと探す」欄に出る**候補**の元である。**この端末にだけ**残し、
     *   書き出しにもバックアップにも入らない(`search-history-store.ts`)。
     * ⚠ 記録を作ったら消す口も作る(上の開いた記録と同じ理由)。押すとその場で消え、
     *   消えたことは字で言う。
     */
    build(): HTMLElement {
      const wrap = document.createElement('section');
      wrap.setAttribute('data-pkc-region', 'settings-search-history');
      const h = document.createElement('h4');
      h.textContent = '検索した語の記録';
      const note = buildSettingsNote(
        '「本文ごと探す」欄の候補に使う記録です(この端末だけ・8 件まで)。',
      );
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.setAttribute('data-pkc-action', 'clear-search-history');
      btn.textContent = '検索した語の記録を消す';
      btn.title = 'この端末にだけ残り、書き出しにも、ほかの端末にも持っていきません。';
      wrap.append(h, note, btn);
      return wrap;
    },
    sync(): void {
      // 状態に依らない固定の節(映すものは無い)
    },
  };
}
