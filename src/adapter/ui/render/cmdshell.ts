/**
 * 🔴 **コマンドシェルの画面**(#274。user 指示 2026-08-19「同じようにコマンドシェルも必要です」)。
 *
 * ## どこに在るか
 *
 * - 別ウィンドウ(アプリの一覧のタイル / 「操作を探す」の「コマンドシェルへ移る」)── 基本の出し先
 * - 左のペインのタブ「シェル」── 別ウィンドウが塞がれたときの退避先も、中央ではなくこのタブ
 *   (補助的なものが主の作業領域を奪わない)
 * 2 つは同じ部品(`ShellPaneRenderer`)で、**履歴と出力は同じ session を共有**する(同じ窓の中で
 * 左のタブとウィンドウ表示を行き来しても、続きが残る)。
 *
 * ## 構え
 *
 * 現在地 → 出力(コマンドごとの塊。表の行を押すとそのノートを開く / 塊ごとにコピー)→ 打つ欄 + 補完の候補。
 * 規則は `features/shell/` の 1 本(コマンド表)で、ここは描くだけ。実行は `actions/shell-run.ts`。
 * 2 ペインのコマンドライン(#241)も同じ session 型・同じ塊の描き方(`paintShellBlock`)を使う。
 */
import { pushShellHistory } from '@features/shell/history';
import type { Completion } from '@features/shell/complete';
import type { ShellTable } from '@features/shell/types';
import { pathOf } from '@features/shell/resolve';
import type { AppState } from '@adapter/state/app-state';
import { appShellHistory, type ShellHistoryStore } from './shell-history-store';

/** 出力に残す塊の数。⚠ 手違い(巨大な表を何十回も出す)の検出で、超えたら古いほうから消す。 */
export const SHELL_BLOCK_MAX = 60;

export interface ShellBlock {
  readonly id: number;
  /** 描き直しの合図(中身を変えるたびに増える)。 */
  rev: number;
  /** 打った行(プロンプトつき)。 */
  prompt: string;
  lines: string[];
  table: ShellTable | null;
  /** 断り・失敗。 */
  failed: boolean;
  /** 非同期の結果待ち(SQL・全文検索)。 */
  pending: boolean;
  /** 🔴 この塊へのひとこと(「コピーしました」など)。⚠ 結果ではないので、コピーする字には入れない。 */
  note: string;
}

export class ShellSession {
  readonly blocks: ShellBlock[] = [];
  /**
   * 🔴 **履歴は端末の保存 1 本**(シェルと 2 ペインのコマンドラインで共通)。
   * ⚠ session ごとに写しを持つと、片方が保存を上書きして、もう片方の履歴を潰す(先に打った側の行が消える)。
   *   読むたびに保存を引き、積むときも保存の最新に足す。
   */
  get history(): string[] {
    return this.store.get();
  }
  set history(list: string[]) {
    this.store.set(list);
  }
  /** シェルの現在地(`null` = ルート)。2 ペインでは使わない(焦点のペインの場所を使う)。 */
  cwd: string | null = null;
  /** 直前の一覧の ID(`#3` で引く)。 */
  last: string[] = [];
  /** 履歴のどこを見ているか。`-1` = 打ちかけ。 */
  at = -1;
  draft = '';
  /** 全消去などで「全部描き直す」合図。 */
  epoch = 0;
  private nextId = 1;
  private readonly listeners = new Set<() => void>();

  constructor(
    readonly name: 'shell' | 'dual',
    private readonly store: ShellHistoryStore = appShellHistory,
  ) {
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private notify(): void {
    for (const fn of this.listeners) fn();
  }

  begin(prompt: string): ShellBlock {
    const block: ShellBlock = { id: this.nextId, rev: 0, prompt, lines: [], table: null, failed: false, pending: false, note: '' };
    this.nextId += 1;
    this.blocks.push(block);
    while (this.blocks.length > SHELL_BLOCK_MAX) this.blocks.shift();
    this.notify();
    return block;
  }

  update(block: ShellBlock, patch: Partial<Pick<ShellBlock, 'lines' | 'table' | 'failed' | 'pending' | 'note'>>): void {
    Object.assign(block, patch);
    block.rev += 1;
    this.notify();
  }

  /** 行を足す(結果の文を後から継ぐ)。 */
  say(block: ShellBlock, line: string, failed = false): void {
    this.update(block, { lines: [...block.lines, line], failed: block.failed || failed });
  }

  clear(): void {
    this.blocks.length = 0;
    this.epoch += 1;
    this.notify();
  }

  find(id: number): ShellBlock | undefined {
    return this.blocks.find((b) => b.id === id);
  }

  /** 履歴に積む(端末に保存)。 */
  remember(line: string): void {
    this.store.set(pushShellHistory(this.store.get(), line));
    this.at = -1;
    this.draft = '';
  }
}

export const appShellSession = new ShellSession('shell');
export const appDualShellSession = new ShellSession('dual');

export function sessionByName(name: string | null): ShellSession | null {
  if (name === 'shell') return appShellSession;
  if (name === 'dual') return appDualShellSession;
  return null;
}

/** 塊をコピー用の字にする(行 + 表はタブ区切り)。 */
export function shellBlockText(block: ShellBlock): string {
  const out = [...block.lines];
  if (block.table !== null) {
    out.push(block.table.columns.join('\t'));
    for (const r of block.table.rows) out.push(r.join('\t'));
  }
  return out.join('\n');
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, field?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (field !== undefined) e.setAttribute('data-pkc-field', field);
  return e;
};

/** 表を描く。`maxRows` で行を切る(2 ペインの小さい出力用)。 */
function paintTable(table: ShellTable, maxRows: number | null, openAction: string): HTMLElement {
  const wrap = el('div', 'shell-table-wrap');
  const t = el('table', 'shell-table');
  const head = el('tr');
  for (const c of table.columns) {
    const th = el('th');
    th.textContent = c;
    head.append(th);
  }
  const thead = el('thead');
  thead.append(head);
  const body = el('tbody');
  const rows = maxRows === null ? table.rows : table.rows.slice(0, maxRows);
  rows.forEach((r, i) => {
    const tr = el('tr');
    const lid = table.lids[i] ?? null;
    const recall = table.recall?.[i] ?? null;
    if (lid !== null) {
      // 🔑 新しい action を作らない: 既存の「ノートを選ぶ」/「別のウィンドウで開く」をそのまま押す
      tr.setAttribute('data-pkc-action', openAction);
      tr.setAttribute('data-pkc-entry', lid);
      tr.title = '押すとこのノートを開きます';
    } else if (recall !== null) {
      tr.setAttribute('data-pkc-action', 'shell-recall');
      tr.setAttribute('data-pkc-text', recall);
      tr.title = '押すと入力欄にこのコマンドを入れます';
    }
    for (const cell of r) {
      const td = el('td');
      td.textContent = cell;
      tr.append(td);
    }
    body.append(tr);
  });
  t.append(thead, body);
  wrap.append(t);
  if (maxRows !== null && table.rows.length > maxRows) {
    const more = el('p', 'shell-more');
    more.textContent = `ほか ${String(table.rows.length - maxRows)} 行(シェルのタブ / ウィンドウで全部見られます)`;
    wrap.append(more);
  }
  return wrap;
}

/** 塊 1 つを描く。⚠ 文は `textContent` で入れる(題名やエラー文を HTML として読ませない)。 */
export function paintShellBlock(block: ShellBlock, opts: { maxRows?: number; openAction?: string } = {}): HTMLElement {
  const root = el('section', 'shell-block');
  root.setAttribute('data-pkc-block', String(block.id));
  root.setAttribute('data-pkc-rev', String(block.rev));
  root.setAttribute('data-pkc-state', block.pending ? 'pending' : block.failed ? 'failed' : 'done');
  const head = el('div', 'shell-prompt-line');
  const prompt = el('span', 'shell-echo');
  prompt.textContent = block.prompt;
  head.append(prompt);
  if (block.lines.length > 0 || block.table !== null) {
    const copy = el('button');
    copy.type = 'button';
    copy.setAttribute('data-pkc-action', 'shell-copy-block');
    copy.setAttribute('data-pkc-field', 'shell-copy-block');
    copy.textContent = 'コピー';
    copy.title = 'この結果(表はタブ区切り)をクリップボードへコピーします';
    head.append(copy);
  }
  root.append(head);
  if (block.note !== '') {
    const note = el('p', 'shell-note');
    note.setAttribute('role', 'status');
    note.textContent = block.note;
    root.append(note);
  }
  for (const line of block.lines) {
    const p = el('p', 'shell-line');
    p.textContent = line;
    root.append(p);
  }
  if (block.pending) {
    const p = el('p', 'shell-line');
    p.setAttribute('data-pkc-pending', '');
    p.textContent = '実行しています…';
    root.append(p);
  }
  if (block.table !== null && block.table.rows.length > 0) root.append(paintTable(block.table, opts.maxRows ?? null, opts.openAction ?? 'select-entry'));
  return root;
}

/** 補完の候補を描く(押すと入力欄へ入れる)。 */
export function paintCompletion(host: HTMLElement, completion: Completion | null): void {
  host.textContent = '';
  if (completion === null || completion.items.length === 0) {
    host.hidden = true;
    return;
  }
  host.hidden = false;
  for (const it of completion.items) {
    const b = el('button', 'shell-candidate');
    b.type = 'button';
    b.setAttribute('data-pkc-action', 'shell-pick');
    b.setAttribute('data-pkc-from', String(completion.from));
    b.setAttribute('data-pkc-to', String(completion.to));
    b.setAttribute('data-pkc-insert', it.insert);
    const name = el('span', 'shell-candidate-label');
    name.textContent = it.label;
    b.append(name);
    if (it.hint !== '') {
      const hint = el('span', 'shell-candidate-hint');
      hint.textContent = it.hint;
      b.append(hint);
    }
    host.append(b);
  }
}

/** 履歴の一覧を候補の場所に出す(「履歴」ボタン)。 */
export function paintHistoryMenu(host: HTMLElement, history: readonly string[]): void {
  host.textContent = '';
  if (history.length === 0) {
    host.hidden = true;
    return;
  }
  host.hidden = false;
  for (const line of history.slice(0, 15)) {
    const b = el('button', 'shell-candidate');
    b.type = 'button';
    b.setAttribute('data-pkc-action', 'shell-recall');
    b.setAttribute('data-pkc-text', line);
    const name = el('span', 'shell-candidate-label');
    name.textContent = line;
    b.append(name);
    host.append(b);
  }
}

/** 打つ欄 + 実行 + 履歴 + 補完の候補。シェルと 2 ペインのコマンドラインで同じ形。 */
export function buildShellPrompt(sessionName: 'shell' | 'dual'): HTMLElement {
  const region = document.createElement('div');
  region.setAttribute('data-pkc-region', 'shell-prompt');
  region.setAttribute('data-pkc-session', sessionName);
  const complete = document.createElement('div');
  complete.setAttribute('data-pkc-region', 'shell-complete');
  complete.hidden = true;
  const row = document.createElement('div');
  row.setAttribute('data-pkc-region', 'shell-input-row');
  const ps = el('span', 'shell-ps');
  ps.textContent = '>';
  ps.setAttribute('aria-hidden', 'true');
  const input = el('input', 'shell-input');
  input.type = 'text';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.setAttribute('autocapitalize', 'off');
  input.setAttribute('aria-label', sessionName === 'dual' ? '2 ペインのコマンド' : 'コマンド');
  input.placeholder =
    sessionName === 'dual' ? '選んだ行へのコマンド(例: mv 資料 / rm / tag add 重要)。help で一覧' : 'コマンドを打つ(help で一覧。Tab で補完、↑ ↓ で履歴)';
  const run = el('button', 'shell-run');
  run.type = 'button';
  run.setAttribute('data-pkc-action', 'shell-run');
  run.textContent = '実行';
  run.title = 'Enter でも実行できます';
  const hist = el('button', 'shell-history-menu');
  hist.type = 'button';
  hist.setAttribute('data-pkc-action', 'shell-history-menu');
  hist.textContent = '履歴';
  hist.title = '打ったコマンドの履歴を出します(押すと入力欄に入ります)';
  const histClear = el('button', 'shell-history-clear');
  histClear.type = 'button';
  histClear.setAttribute('data-pkc-action', 'shell-history-clear');
  histClear.textContent = '履歴を消す';
  histClear.title = 'この端末に保存してあるコマンドの履歴を、すべて消します';
  row.append(ps, input, run, hist, histClear);
  if (sessionName === 'shell') {
    const clear = el('button', 'shell-clear');
    clear.type = 'button';
    clear.setAttribute('data-pkc-action', 'shell-clear');
    clear.textContent = '出力を消す';
    clear.title = '画面の出力を消します(履歴は残ります)';
    row.append(clear);
  }
  region.append(complete, row);
  return region;
}

/** 中央・左のペインのどちらにも出すシェル本体。 */
export class ShellPaneRenderer {
  private built = false;
  private readonly cwdLine = el('div', 'shell-cwd');
  private readonly log = el('div', 'shell-log');
  private readonly els = new Map<number, HTMLElement>();
  private seenEpoch = -1;
  private unsubscribe: (() => void) | null = null;
  private shown = '';
  private state: AppState | null = null;

  constructor(
    private readonly host: HTMLElement,
    private readonly variant: 'window' | 'pane',
    private readonly session: ShellSession = appShellSession,
  ) {}

  render(state: AppState): void {
    this.state = state;
    if (!this.built) this.build();
    this.paintCwd();
    this.sync();
  }

  /** 現在地の行。🔴 `cd` は state を動かさず session だけを動かすので、`render` だけでなく `sync` からも塗る。 */
  private paintCwd(): void {
    const state = this.state;
    if (state === null) return;
    const cwd = this.session.cwd !== null && state.entryMetas.has(this.session.cwd) ? this.session.cwd : null;
    // 消えたフォルダを現在地に持ち続けない(次のコマンドがルートで動く)
    if (cwd !== this.session.cwd) this.session.cwd = cwd;
    const text = `現在地: ${pathOf({ metas: state.entryMetas, relations: state.relations }, cwd)}`;
    if (this.cwdLine.textContent !== text) this.cwdLine.textContent = text;
  }

  /** 非表示の間は購読を外す(隠れた画面を、コマンドの結果のたびに描き直さない)。 */
  onHidden(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private build(): void {
    this.built = true;
    const h = this.host;
    h.setAttribute('data-pkc-region', 'cmdshell');
    h.setAttribute('data-pkc-variant', this.variant);
    if (this.variant === 'window') {
      const title = el('h2', 'pane-title');
      title.textContent = 'コマンドシェル';
      h.append(title);
    }
    this.log.setAttribute('role', 'log');
    this.log.setAttribute('aria-live', 'polite');
    h.append(this.cwdLine, this.log, buildShellPrompt('shell'));
    const intro = el('p', 'shell-intro');
    intro.textContent = 'help でコマンドの一覧を出せます。ノートを探す・開く・作る・追記する、移す・コピー・ゴミ箱、SQL、「操作を探す」の操作の呼び出しができます。';
    this.log.append(intro);
    this.attach();
  }

  private attach(): void {
    if (this.unsubscribe !== null) return;
    this.unsubscribe = this.session.subscribe(() => {
      this.sync();
    });
  }

  /** session を DOM に合わせる。変わった塊だけ作り直す。 */
  sync(): void {
    if (!this.built) return;
    this.attach();
    this.paintCwd();
    if (this.seenEpoch !== this.session.epoch) {
      this.seenEpoch = this.session.epoch;
      for (const e of this.els.values()) e.remove();
      this.els.clear();
    }
    const alive = new Set<number>();
    let tail: Element | null = this.log.querySelector('[data-pkc-field="shell-intro"]');
    for (const b of this.session.blocks) {
      alive.add(b.id);
      const cur = this.els.get(b.id);
      if (cur !== undefined && cur.getAttribute('data-pkc-rev') === String(b.rev)) {
        tail = cur;
        continue;
      }
      // 別ウィンドウ(中央)の表の行は付箋のウィンドウで開く(その窓にはノートを映す所が無い)。左のタブは、このウィンドウで選ぶ
      const next = paintShellBlock(b, { openAction: this.variant === 'window' ? 'open-note-window' : 'select-entry' });
      if (cur !== undefined) cur.replaceWith(next);
      else if (tail !== null) tail.after(next);
      else this.log.prepend(next);
      this.els.set(b.id, next);
      tail = next;
    }
    for (const [id, e] of this.els) {
      if (!alive.has(id)) {
        e.remove();
        this.els.delete(id);
      }
    }
    // 最新の出力が見えるところまで送る(塊が増えた・変わった回だけ。読み返している最中は動かさない)
    const sig = this.session.blocks.map((b) => `${String(b.id)}.${String(b.rev)}`).join(',');
    if (sig !== this.shown) {
      this.shown = sig;
      this.log.scrollTop = this.log.scrollHeight;
    }
  }
}
