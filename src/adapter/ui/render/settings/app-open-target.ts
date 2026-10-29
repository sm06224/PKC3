/**
 * 🔴 **アプリをどこに出すか**(#884 段①。user 要望 2026-09-13)。
 *
 * ⚠ **flag ではない**(正規設定)── 恒久の好みで、畳む予定が無い。
 * ⚠ 「書庫を開く場所」(`open-place.ts`)の**下**に置く ── どちらも「開く」の話である。
 * 🔑 **いま効く先を書く** ── 効かない所まで効くと読まれると、
 *   「設定したのに変わらない」になる。
 *
 * 🔴 **選択肢は 2 つだが、プルダウンのまま残す**(#1038 段J-2、§9 の覆る条件)。
 *   ⚠ 一度ボタンの列にして実測(`TAB_SWEEP` 全幅 + スマホ幅 360 / 390px)した
 *   ところ、**スマホ幅 360px でだけ 2 行に折れた**(390px と `TAB_SWEEP` の
 *   11 幅は 1 行のまま ──「ブラウザのタブ(既定)」の字が、狭い dd の幅では
 *   「別の窓」の隣に収まらない)。doc §9「切替ボタンの列にして…行が 2 段以上に
 *   折れる → その項目だけプルダウンへ戻す」のとおり、プルダウンへ戻した。
 * (#1382 で `settings.ts` から移した。中身は変えていない。)
 */
import { APP_OPEN_TARGETS, appOpenChoicesVisible } from '@features/launcher/open-target';
import { isInstalledApp } from '@adapter/platform/installed-app';
import { currentAppOpenTarget } from '../app-open-target';
import { buildSettingsNote } from './note';
import type { SettingsSection } from './section';

export function createAppOpenTargetSection(region: HTMLElement): SettingsSection {
  /** 🔴 #884 段③ ── 出す/出さないを DOM の `hidden` で切る。一度出したら引っ込めない(選んだ途端に消えない)。 */
  let shown = false;
  const nodes: HTMLElement[] = [];
  return {
    id: 'app-open-target',
    group: 'open',
    build(): Node[] {
      const att = document.createElement('dt');
      att.textContent = 'アプリの開き方';
      const atd = document.createElement('dd');
      const atselect = document.createElement('select');
      atselect.setAttribute('data-pkc-action', 'set-app-open-target');
      atselect.setAttribute('data-pkc-field', 'app-open-target-select');
      atselect.setAttribute('aria-label', 'アプリの開き方');
      atselect.title =
        '別のウィンドウは大きさを指定して開くので、画面より大きいときはブラウザが縮めます。' +
        'ブラウザがウィンドウを止めているときは、止められた理由が画面の下に出ます。' +
        '組み込みのアプリ(予定表・連絡先など)とマニュアルのウィンドウは、ここでは変わりません。';
      for (const c of APP_OPEN_TARGETS) {
        const opt = document.createElement('option');
        opt.value = c.id;
        opt.textContent = c.label;
        atselect.append(opt);
      }
      atd.append(atselect);
      atd.append(
        buildSettingsNote('アプリの一覧のタイルを押したとき、タブか別のウィンドウに出すかです。'),
      );
      att.setAttribute('data-pkc-field', 'app-open-target-label');
      nodes.push(att, atd);
      return [att, atd];
    },
    /**
     * ⚠ 画面の値を**いまの出し先に合わせる**(#884 段①)── `open-place` と同じ理由。
     * ⚠ ここも **DOM ではなく保存が正本**である(画面に出ない設定なので、当てる先が無い)。
     */
    sync(): void {
      const select = region.querySelector<HTMLSelectElement>(
        '[data-pkc-field="app-open-target-select"]',
      );
      const cur = currentAppOpenTarget();
      if (select && select.value !== cur) select.value = cur;
      // 🔴 #884 段③: アプリとして入れていない(ブラウザで使っている)ときは出さない。
      //   ⚠ すでに既定と違う値を選んである人には出す(戻せない片道にしない)。
      shown ||= appOpenChoicesVisible(isInstalledApp(), cur);
      for (const n of nodes) n.hidden = !shown;
    },
  };
}
