/**
 * 🔴 **計った時間の面**(#683 ①。user 要望 2026-09-03
 * 「**時間を測る**・画面録画・録音も…組み込みアプリにしたい」)。
 *
 * ## どこに在るか ── 左の列のタブと、別ウィンドウの面の 2 か所
 *
 * 録ったもの(`captures.ts`)・連絡先と同じ形。⚠ この描画器は同じ document に 2 つ生きうる
 * (左のタブ + 中央の面)ので、`data-pkc-region` を焼かない(器の印は器の側が持つ)。
 *
 * ## 正本は本文である
 *
 * タイマーを止めると、計っていたノートの本文へ `- 作業 2026-08-27 06:40–07:03(23:11)` が 1 行入る。
 * この面はそれを**集めて日ごとに並べる**だけで、**名前を付ける・消すも本文の行を書き換える**
 * (別の保存先を持たない ── `features/timer/work-log.ts`)。計っている途中のものは画面下の帯に出る。
 *
 * | 押すと | 何が起きるか |
 * |---|---|
 * | ノートの名前 | そのノートを開く(`select-entry`) |
 * | 名前を直す | 小窓で打った名前が行の終わりに入る(`timer-run-rename`) |
 * | 名前を外す | 行の終わりの名前を外す(名前がある行だけ) |
 * | 消す | その行を本文から消す。画面の下の「元に戻す」で戻る(`timer-run-delete`) |
 */
import type { AppState } from '@adapter/state/app-state';
import {
  groupWorkRuns,
  spanMs,
  totalText,
  visibleWorkRuns,
  type WorkRun,
} from '@features/timer/work-log';

/** 行の対象を運ぶ属性。⚠ 綴りはここ 1 か所(binder は import する)。 */
export const TIMER_RUN_LINE_ATTR = 'data-pkc-run-line';
/** 「名前を外す」の印(同じ action を、小窓を出さずに空の名前で撃つ)。 */
export const TIMER_RUN_CLEAR_ATTR = 'data-pkc-timer-clear';

export class TimersRenderer {
  private readonly host: HTMLElement;
  private last = ' ';
  private note: HTMLElement | null = null;
  private body: HTMLElement | null = null;

  constructor(host: HTMLElement) {
    this.host = host;
  }

  private ensureFrame(): HTMLElement {
    if (this.body !== null) return this.body;
    const note = document.createElement('p');
    note.setAttribute('data-pkc-field', 'timers-note');
    const body = document.createElement('div');
    body.setAttribute('data-pkc-field', 'timers-body');
    this.host.append(note, body);
    this.note = note;
    this.body = body;
    return body;
  }

  render(state: AppState): void {
    const body = this.ensureFrame();
    const scan = state.workLogScan;
    const query = state.filterQuery;
    const titleOf = (lid: string): string => state.entryMetas.get(lid)?.title ?? '';
    // 消えたノート・(出していなければ)片付けたノートの行は出さない
    const alive = (scan?.runs ?? []).filter((r) => {
      const m = state.entryMetas.get(r.lid);
      return m !== undefined && (state.showArchived || !m.archived);
    });
    const runs = visibleWorkRuns(alive, query, titleOf);
    const print = [
      state.workLogScanFailed ? 'failed' : scan === null ? 'pending' : 'ok',
      scan?.truncated === true ? 't' : '',
      query,
      runs.map((r) => `${r.lid}|${r.line}|${r.from}|${r.to}|${r.span}|${r.label}|${titleOf(r.lid)}`).join('\u0001'),
    ].join('\u0002');
    if (print === this.last) return;
    this.last = print;

    this.note!.textContent = this.noteText(state, alive.length, runs);
    body.textContent = '';
    if (runs.length === 0) {
      // 🔴 行き止まりを作らない ── 絞りで 0 件のときは、絞りを外す道を出す(連絡先と同じ)
      if (query !== '' && alive.length > 0) {
        const clear = document.createElement('button');
        clear.type = 'button';
        clear.setAttribute('data-pkc-action', 'clear-entry-filter');
        clear.setAttribute('data-pkc-field', 'timers-clear-filter');
        clear.textContent = '絞りを外す';
        clear.title = '一覧の絞り込みを空にして、計った時間を全部出します。';
        body.append(clear);
      }
      return;
    }
    for (const day of groupWorkRuns(runs)) {
      const section = document.createElement('section');
      section.setAttribute('data-pkc-field', 'timers-day');
      const head = document.createElement('h3');
      head.setAttribute('data-pkc-field', 'timers-day-head');
      head.textContent = `${day.day}(${day.runs.length} 件・合計 ${totalText(day.totalMs)})`;
      const list = document.createElement('ul');
      list.setAttribute('data-pkc-field', 'timers-list');
      for (const r of day.runs) list.append(this.row(r, titleOf(r.lid)));
      section.append(head, list);
      body.append(section);
    }
  }

  private noteText(state: AppState, alive: number, shown: readonly WorkRun[]): string {
    if (state.workLogScanFailed) return '計った時間を集められませんでした(開き直すと試し直します)';
    const scan = state.workLogScan;
    if (scan === null) return '計った時間を集めています…';
    if (alive === 0)
      return '計った時間はまだありません。ノートの「時間を計る」を押して止めると、そのノートの本文に入り、ここに並びます。計っている途中のものは画面の下に出ます。';
    if (shown.length === 0) return '絞り込みに一致する計った時間がありません';
    const total = shown.reduce((s, r) => s + spanMs(r.span), 0);
    const cut = scan.truncated ? '(多いので途中まで集めました)' : '';
    return `${shown.length} 件・合計 ${totalText(total)}${cut}`;
  }

  private row(r: WorkRun, title: string): HTMLLIElement {
    const li = document.createElement('li');
    li.setAttribute('data-pkc-work-run', `${r.lid}:${r.line}`);
    const when = document.createElement('span');
    when.setAttribute('data-pkc-field', 'timers-when');
    // 同じ日なら時刻だけ(見出しに日付が出ている)。日をまたいだら終わりの日付も出す
    const end = r.to.slice(0, 10) === r.from.slice(0, 10) ? r.to.slice(11) : r.to;
    when.textContent = `${r.from.slice(11)}–${end}(${r.span})`;
    li.append(when);
    if (r.label !== '') {
      const name = document.createElement('span');
      name.setAttribute('data-pkc-field', 'timers-name');
      name.textContent = r.label;
      li.append(name);
    }
    // 🔑 ノートの名前は**そのノートを開く** ── 既存の `select-entry` を通す(開く口を増やさない)
    const open = document.createElement('button');
    open.type = 'button';
    open.setAttribute('data-pkc-action', 'select-entry');
    open.setAttribute('data-pkc-entry', r.lid);
    open.setAttribute('data-pkc-field', 'timers-note-open');
    open.textContent = title === '' ? '(無題)' : title;
    open.title = 'このノートを開きます';
    li.append(open);

    const tools = document.createElement('span');
    tools.setAttribute('data-pkc-field', 'timers-tools');
    // ⚠ 口(`data-pkc-action`)は字で書く(変数で配ると、出口の全数検査が追えない)
    const tool = (label: string, hint: string): HTMLButtonElement => {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('data-pkc-entry', r.lid);
      b.setAttribute(TIMER_RUN_LINE_ATTR, String(r.line));
      b.textContent = label;
      b.title = hint;
      return b;
    };
    const rename = tool('名前を直す', 'この計測に名前を付けます(本文の行の終わりに入ります)');
    rename.setAttribute('data-pkc-action', 'timer-run-rename');
    tools.append(rename);
    if (r.label !== '') {
      const clear = tool('名前を外す', '付けた名前を外します(時間の行は残ります)');
      clear.setAttribute('data-pkc-action', 'timer-run-rename');
      clear.setAttribute(TIMER_RUN_CLEAR_ATTR, '');
      tools.append(clear);
    }
    const del = tool('消す', 'この計測の行を本文から消します(画面の下の「元に戻す」で戻せます)');
    del.setAttribute('data-pkc-action', 'timer-run-delete');
    tools.append(del);
    li.append(tools);
    return li;
  }
}

