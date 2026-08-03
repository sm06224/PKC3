/**
 * 設定の画面(P8 段④)。
 *
 * > user 指示 2026-08-03「**テーマは設定系の画面にしまってください。
 * > 普段から必要ではない**」
 *
 * 🔑 **画面**であって、かぶせる窓ではない ── 「同じものが常に同じ場所にある」
 * という業務画面の作法に従い、ほかの面と同じ場所(中央)に出す。
 *
 * ⚠ ここは**めったに来ない場所**。だから常時見える帯からは外したが、
 * 押す導線そのものは畳まない(操作の帯に「設定」を置く)。
 */
import type { AppState } from '@adapter/state/app-state';
import { THEMES } from './theme';

export class SettingsRenderer {
  private built = false;

  constructor(private readonly region: HTMLElement) {}

  render(state: AppState): void {
    if (this.built) {
      // 配色は user 操作でしか変わらない ── 毎 state で組み直さない
      this.syncTheme();
      return;
    }
    this.built = true;
    this.region.textContent = '';

    const head = document.createElement('div');
    head.setAttribute('data-pkc-field', 'pane-title');
    head.textContent = '設定';
    this.region.append(head);

    const body = document.createElement('div');
    body.setAttribute('data-pkc-region', 'settings-body');

    const dl = document.createElement('dl');
    const dt = document.createElement('dt');
    dt.textContent = '配色';
    const dd = document.createElement('dd');
    const select = document.createElement('select');
    select.setAttribute('data-pkc-action', 'set-theme');
    select.setAttribute('data-pkc-field', 'theme-select');
    select.setAttribute('aria-label', '配色');
    for (const t of THEMES) {
      const opt = document.createElement('option');
      opt.value = t.id;
      opt.textContent = t.label;
      select.append(opt);
    }
    dd.append(select);
    const note = document.createElement('p');
    note.setAttribute('data-pkc-field', 'settings-note');
    note.textContent =
      '最初は OS の設定に従います。一度選ぶと、この端末ではそちらを覚えています。';
    dd.append(note);
    dl.append(dt, dd);
    body.append(dl);
    this.region.append(body);
    this.syncTheme();
    void state;
  }

  /** ⚠ 画面の値を**いまの配色に合わせる**(合わせないと画面が嘘をつく)。 */
  private syncTheme(): void {
    const select = this.region.querySelector<HTMLSelectElement>(
      '[data-pkc-field="theme-select"]',
    );
    const cur = document.documentElement.getAttribute('data-pkc-theme');
    if (select && cur !== null && select.value !== cur) select.value = cur;
  }
}
