/**
 * 🔴 **最近開いた記録を消す**の節(#215 残り①)── 「記録」の h3 の中。
 * (#1382 で `settings.ts` から移した。中身は変えていない。)
 */
import { buildSettingsNote } from './note';
import type { SettingsSection } from './section';

export function createOpenedHistorySection(): SettingsSection {
  return {
    id: 'opened-history',
    group: 'history',
    /**
     * 🔴 **最近開いた記録を消す**(#215 残り①)。
     *
     * ⚠ **記録を作ったら、消す口も作る** ── 一覧の並びに「最近開いた順」を足した
     *   ということは、**この端末に「何を読んだか」が積まれる**ということである。
     *   ⚠ 積むだけ積んで消せないのは、user から物を取り上げているのと同じ。
     * ⚠ 「表示」の節には入れない ── 見た目の好みではなく、**この端末に何を残すか**の
     *   判断である(外部画像・ノートを渡して開く、と同じ並び)。
     * 🔑 押すと**その場で消える**(確かめを挟まない)── 消えて困る物ではないうえ、
     *   また開けば積み直る。⚠ 消えたことは字で言う(無言にしない)。
     */
    build(): HTMLElement {
      const wrap = document.createElement('section');
      wrap.setAttribute('data-pkc-region', 'settings-opened');
      const h = document.createElement('h4');
      h.textContent = '最近開いたノートの記録';
      const note = buildSettingsNote(
        '並び順「最近開いた順」に使う記録です(この端末だけ・消すとまた集計されます)。',
      );
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.setAttribute('data-pkc-action', 'clear-opened-history');
      btn.textContent = '最近開いた記録を消す';
      btn.title = 'この端末にだけ残り、書き出しにも、ほかの端末にも持っていきません。';
      wrap.append(h, note, btn);
      return wrap;
    },
    sync(): void {
      // 状態に依らない固定の節(映すものは無い)
    },
  };
}
