/**
 * システムの中の **「音声認識」の節**(#772 段②)── 録った音を文字にする部品を、
 * この端末へ取り込む・消す。
 *
 * 🔴 裁定 2026-10-01(#772)= **端末の中だけ**で文字にする。部品は押した人にだけ取らせる
 * (勝手に取りに行かない ── Office / DuckDB の一式と同じ作法)。取った後は端末の保管(IndexedDB)
 * へ置き、**2 回目からは取らない**。
 *
 * ## 画面に出るもの(部品 2 択 ── 中身は `asr-parts.ts` の定数 1 か所)
 *
 * | 状態 | 出るもの |
 * |---|---|
 * | まだ | **ボタン 1 つ**(`軽い(約 97MB、1 分の音に約 25 秒)`)+ メモリが足りない見込みなら**ボタンの下に**1 行 |
 * | 取り込み済み | 「取り込み済み」+ **消す** ボタン(取り込むボタンは隠す) |
 * | 取り込み中 | 進み具合の 1 行 + **取り込みをやめる** ボタン |
 *
 * ⚠ **メモリの案内は押す前に出す。ボタンは押せるまま**(試すことは止めない)。
 *   出すのは `navigator.deviceMemory` が読める端末だけ(読めなければ何も出さない ── 言えないので)。
 *
 * ## 🔴 器は 1 度だけ組み、字だけ差し替える
 *
 * 設定の面は `hidden` で常駐する。組み直すと**押している最中のボタンが作り直されて
 * 無言の dead click になる**(`office-pack-panel.ts` が書いている、2026-08-07 に 3 面で踏んだ形)
 * ので、`sync()` で字と `hidden` だけを書き換える。
 */
import {
  ASR_PARTS,
  asrMemoryNote,
  asrPartLabel,
  type AsrPart,
  type AsrPartId,
} from '@features/asr/asr-parts';
import { ASR_SECTION_LABEL } from '@features/asr/asr-text';
import type { AsrInstalled } from '@adapter/platform/asr/asr-pack-store';
import { humanBytes } from '@features/human-bytes';

const EMPTY: AsrInstalled = { runtime: null, parts: {} };

/**
 * 部品の控え。⚠ 設定の面と文字にする側が**同じ値**を見る(片方だけ更新する配線を
 * 書かない ── `OfficePackState` と同じ理由)。
 */
export class AsrPackState {
  private installed: AsrInstalled = EMPTY;
  /** 取り込み中の 1 行(空 = 何もしていない)。 */
  private progressText = '';
  private readonly listeners = new Set<() => void>();

  getInstalled(): AsrInstalled {
    return this.installed;
  }

  isPartInstalled(id: AsrPartId): boolean {
    return this.installed.parts[id] !== undefined;
  }

  /** @returns 値が変わったか。 */
  setInstalled(v: AsrInstalled): boolean {
    if (this.installed === v) return false;
    this.installed = v;
    this.emit();
    return true;
  }

  progress(): string {
    return this.progressText;
  }

  setProgress(text: string): void {
    if (this.progressText === text) return;
    this.progressText = text;
    this.emit();
  }

  /** @returns 解除する関数(短命な購読者は必ず呼ぶ)。 */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }
}

export const appAsrPack = new AsrPackState();

/** 取り込み / 削除の結果を受けた後、画面をどう合わせるか。 */
export interface AsrResultUi {
  notify: (message: string) => void;
}

/**
 * 🔴 **取り込み / 削除の後始末を 1 か所に持つ**(`applyPackResult` と同じ形)。
 * ⚠ `main.ts` に書くと**どの test からも実行されない**(CLAUDE.md 2026-08-08)。
 *  ① 成功したときだけ控えを書き換える(失敗で「入った」ことにしない)
 *  ② 成否によらず**必ず何か言う**(押して無反応、を作らない)
 */
export function applyAsrResult(
  state: AsrPackState,
  result: { ok: true; installed: AsrInstalled; message: string } | { ok: false; message: string },
  ui: AsrResultUi,
): void {
  if (result.ok) state.setInstalled(result.installed);
  ui.notify(result.message);
}

/** 「入っている」を 1 行で言う。⚠ 大きさ・日付は**腐りやすい数字**なので実体から出す。 */
export function asrInstalledText(part: AsrPart, installed: AsrInstalled): string {
  const m = installed.parts[part.id];
  if (m === undefined) return '';
  const at = new Date(m.installedAt);
  const date = Number.isNaN(at.getTime())
    ? '日時不明'
    : `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;
  return `取り込み済み ── ${humanBytes(m.totalBytes)} / ${date}`;
}

function button(action: string, label: string, field: string, part?: AsrPartId): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.setAttribute('data-pkc-action', action);
  b.setAttribute('data-pkc-field', field);
  if (part !== undefined) b.setAttribute('data-pkc-part', part);
  b.textContent = label;
  return b;
}

export interface AsrPackPanel {
  readonly root: HTMLElement;
  /** 状態が変わったら呼ぶ(器は組み直さない)。 */
  sync(): void;
  dispose(): void;
}

export interface AsrPackPanelDeps {
  /** 端末のメモリ(GB)。⚠ 読めない端末では `undefined`。test が差し替える。 */
  readonly deviceMemory?: () => number | undefined;
}

function readDeviceMemory(): number | undefined {
  const n = typeof navigator === 'undefined' ? undefined : (navigator as { deviceMemory?: number }).deviceMemory;
  return typeof n === 'number' ? n : undefined;
}

/**
 * 設定の面へ入れる節を組む。
 * ⚠ 呼び側は `sync()` を自分で呼ばなくてよい(変化は `AsrPackState` が放送する)。
 *   面を作り直すときは `dispose()` で購読を切ること。
 */
export function buildAsrPackPanel(
  state: AsrPackState = appAsrPack,
  deps: AsrPackPanelDeps = {},
): AsrPackPanel {
  const memory = deps.deviceMemory ?? readDeviceMemory;
  const root = document.createElement('section');
  root.setAttribute('data-pkc-region', 'settings-asr');
  /** 🔴 見出しは h4(「保存領域」の中の 1 節 ── Office 表示と同じ階)。 */
  const head = document.createElement('h4');
  head.textContent = ASR_SECTION_LABEL;
  root.append(head);

  const intro = document.createElement('p');
  intro.setAttribute('data-pkc-field', 'settings-note');
  // 🔑 説明は **1 行 + hover**(#1017 §6.1 規則 3 ── `tests/adapter/settings-notes.test.ts` が 55 字で止める)。
  //    詳しくはマニュアル(「音声を文字にする」)。
  intro.textContent = '録った音を、この端末の中だけで文字にします(音は外へ出ません)。';
  intro.title =
    '部品を 1 度取り込めば、次からは端末の中から動きます。軽いほうは速く、当たりやすいほうは時間がかかります。';
  root.append(intro);

  interface Row {
    readonly part: AsrPart;
    readonly wrap: HTMLElement;
    readonly install: HTMLButtonElement;
    readonly installed: HTMLElement;
    readonly remove: HTMLButtonElement;
    readonly note: HTMLElement;
  }
  const rows: Row[] = [];
  for (const part of ASR_PARTS) {
    const wrap = document.createElement('div');
    wrap.setAttribute('data-pkc-field', 'asr-part');
    wrap.setAttribute('data-pkc-part', part.id);
    // 🔑 ボタンの字は**大きさと 1 行の説明つき**(数は全部 `asr-parts.ts` から出す)
    const install = button('install-asr-part', asrPartLabel(part), 'asr-install', part.id);
    install.title = 'この端末に部品を取り込みます。一度取り込めば、次からは端末の中から動きます。';
    const installed = document.createElement('span');
    installed.setAttribute('data-pkc-field', 'asr-installed');
    const remove = button('remove-asr-part', `${part.label}を消す`, 'asr-remove', part.id);
    remove.title = 'この端末から、この部品を消します(ノートや添付は消えません)。';
    // 🔴 **ボタンの下**に出す(押す前に読める位置)
    const note = document.createElement('p');
    note.setAttribute('data-pkc-field', 'asr-memory-note');
    note.hidden = true;
    wrap.append(install, installed, remove, note);
    root.append(wrap);
    rows.push({ part, wrap, install, installed, remove, note });
  }

  const progress = document.createElement('p');
  progress.setAttribute('data-pkc-field', 'asr-progress');
  progress.hidden = true;
  const cancel = button('cancel-asr-install', '取り込みをやめる', 'asr-cancel');
  cancel.title = '取り込みを途中でやめます(端末には何も書きません)。';
  cancel.hidden = true;
  root.append(progress, cancel);

  const sync = (): void => {
    const installedAll = state.getInstalled();
    const busy = state.progress() !== '';
    for (const r of rows) {
      const has = installedAll.parts[r.part.id] !== undefined;
      // 取り込み済みなら、取り込むボタンは隠す(押しても何も起きない物を出さない)
      r.install.hidden = has;
      r.installed.hidden = !has;
      r.installed.textContent = has ? asrInstalledText(r.part, installedAll) : '';
      r.remove.hidden = !has;
      /**
       * ⚠ **取り込み中は押せなくする**(270MB を 2 本走らせると quota も帯域も倍食う)。
       * 🔑 実体側にも同じ門が在る(`AsrPackInstaller.isRunning`)── `disabled` は
       *   見た目の親切で、守っているのは実体側(DevTools で外せる)。
       */
      r.install.disabled = busy;
      r.remove.disabled = busy;
      // 🔴 メモリの案内は**押す前**(= まだ取り込んでいない間)だけ。ボタンは残す
      const text = has ? null : asrMemoryNote(r.part, memory());
      r.note.hidden = text === null;
      r.note.textContent = text ?? '';
    }
    progress.hidden = !busy;
    progress.textContent = state.progress();
    cancel.hidden = !busy;
  };
  sync();
  const off = state.onChange(sync);

  return {
    root,
    sync,
    dispose: () => {
      off();
    },
  };
}
