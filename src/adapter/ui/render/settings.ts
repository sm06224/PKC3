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
import { appJobMonitor, type JobMonitor } from '@adapter/platform/job-monitor';
import { ScrollMemory } from './scroll-memory';

/** 画面の書き換えを間引く間隔。⚠ **可視化がジャンクの原因になっては本末転倒**。 */
const REFRESH_MS = 400;

export class SettingsRenderer {
  private built = false;
  private jobsBody: HTMLElement | null = null;
  private logBody: HTMLElement | null = null;
  private unsubscribe: (() => void) | null = null;
  private pending = false;
  /** ログは 400ms ごとに描き直す ── 読んでいる位置を殺さない(P8 段⑫)。 */
  private logScroll: ScrollMemory | null = null;

  constructor(
    private readonly region: HTMLElement,
    private readonly monitor: JobMonitor = appJobMonitor,
  ) {}

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
    body.append(this.buildJobs());
    this.region.append(body);
    this.syncTheme();
    this.refresh();
    void state;
  }

  /**
   * 🔑 **ジョブの可視化**(P8 段⑩。user 指示 2026-08-03「ジョブスケジューラーは
   * 可視化機構とセットでお願いします / ログもみたい」)。
   *
   * 見えるもの: どのワーカーが生きているか / 待ちと実行中の件数 /
   * 起動と使い捨ての回数 / 1 件あたりの中央値と最大 / 直近のログ。
   * ⚠ 本文の中身はログに出さない(**文字数だけ**)── ノートが漏れる。
   */
  private buildJobs(): HTMLElement {
    const wrap = document.createElement('section');
    wrap.setAttribute('data-pkc-region', 'jobs');

    const h = document.createElement('h3');
    h.textContent = '処理(ワーカー)';
    wrap.append(h);

    const note = document.createElement('p');
    note.setAttribute('data-pkc-field', 'settings-note');
    note.textContent =
      '重い処理は別スレッド(ワーカー)で動きます。しばらく使われないと自動で終了し、次に必要になったら作り直します。';
    wrap.append(note);

    const table = document.createElement('table');
    table.setAttribute('data-pkc-field', 'job-lanes');
    const thead = document.createElement('thead');
    const hr = document.createElement('tr');
    for (const label of ['名前', '状態', '待ち', '実行中', '完了', '失敗', '起動', '中央値', '最大']) {
      const th = document.createElement('th');
      th.textContent = label;
      hr.append(th);
    }
    thead.append(hr);
    this.jobsBody = document.createElement('tbody');
    table.append(thead, this.jobsBody);
    wrap.append(table);

    const lh = document.createElement('h4');
    lh.textContent = 'ログ';
    wrap.append(lh);
    this.logBody = document.createElement('ol');
    this.logBody.setAttribute('data-pkc-field', 'job-log');
    this.logScroll = new ScrollMemory(this.logBody);
    wrap.append(this.logBody);

    // ⚠ 通知は来るたびに描かない(**間引く**)── 可視化が重さの原因になる
    this.unsubscribe?.();
    this.unsubscribe = this.monitor.subscribe(() => {
      if (this.pending) return;
      this.pending = true;
      setTimeout(() => {
        this.pending = false;
        this.refresh();
      }, REFRESH_MS);
    });
    return wrap;
  }

  /** 表とログを描き直す。⚠ 設定画面が出ていないときは何もしない。 */
  private refresh(): void {
    if (!this.jobsBody || !this.logBody || !this.jobsBody.isConnected) return;
    const lanes = this.monitor.stats();
    this.jobsBody.textContent = '';
    if (lanes.length === 0) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 9;
      td.setAttribute('data-pkc-field', 'jobs-empty');
      td.textContent = 'まだ動いていません';
      tr.append(td);
      this.jobsBody.append(tr);
    }
    for (const l of lanes) {
      const tr = document.createElement('tr');
      tr.setAttribute('data-pkc-lane', l.lane);
      const cells = [
        l.lane,
        l.alive ? '動作中' : '停止中',
        String(l.queued),
        String(l.running),
        String(l.done),
        String(l.failed),
        `${l.spawns} 回(終了 ${l.kills})`,
        l.medianMs === null ? '—' : `${l.medianMs}ms`,
        l.maxMs === null ? '—' : `${l.maxMs}ms`,
      ];
      for (const c of cells) {
        const td = document.createElement('td');
        td.textContent = c;
        tr.append(td);
      }
      this.jobsBody.append(tr);
    }

    // ⚠ **書き換える前に**退避 → 入れ終わってから戻す(順番が本体)
    this.logScroll?.park();
    this.logBody.textContent = '';
    for (const e of this.monitor.recent(50)) {
      const li = document.createElement('li');
      li.setAttribute('data-pkc-phase', e.phase);
      const t = new Date(e.at);
      const hhmmss = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}:${String(t.getSeconds()).padStart(2, '0')}`;
      const parts = [hhmmss, e.lane, PHASE_LABEL[e.phase]];
      if (e.id !== undefined) parts.push(`#${e.id}`);
      if (e.ms !== undefined) parts.push(`${e.ms}ms`);
      if (e.note) parts.push(e.note);
      li.textContent = parts.join(' ');
      this.logBody.append(li);
    }
    this.logScroll?.use('log');
  }

  /** 面を畳むときに購読を切る(残すと設定を開くたびに増える)。 */
  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
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

/** ⚠ 画面に出る語は**そのまま pin される**(`tests/docs-parity.test.ts`)。 */
const PHASE_LABEL: Record<string, string> = {
  spawn: '起動',
  enqueue: '受付',
  dispatch: '送出',
  done: '完了',
  fail: '失敗',
  kill: '終了(未使用)',
  dispose: '破棄',
};
