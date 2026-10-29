/**
 * システムの中の **「音源分離」の節**(#674 / #949)── 歌声と楽器を分けるモデルを、この端末へ取り込む・消す。
 *
 * 🔑 「音声認識」の節(`asr-pack-panel.ts`)と同じ作法:
 *  - 押した人にだけ取らせる(勝手に取りに行かない)。取った後は端末の保管(IndexedDB)に残し、**2 回目からは取らない**。
 *  - 取り込み・消すの**両方向**がある(片道にしない)。録音の「歌声と楽器に分ける」から押したときも、無ければここと同じ道で取り込む。
 *  - 🔴 器は 1 度だけ組み、字と `hidden` だけ差し替える(押している最中のボタンを作り直さない)。
 * 外へ出るのはモデルの取得だけ(公開の配布元から。録音は 1 バイトも送らない)。
 */
import { STEM_MODELS, stemHost, type StemModel } from '@features/audio/stem-model';
import { humanBytes } from '@features/human-bytes';
import type { StemModelInstalled } from '@adapter/platform/stems/stem-model-install';

/** 節の見出し。⚠ 案内の字もここから引く。 */
export const STEM_SECTION_LABEL = '音源分離';

/** モデルの控え。⚠ 設定の面と分離する側が同じ値を見る(`AsrPackState` と同じ理由)。 */
export class StemModelState {
  private installed: StemModelInstalled = {};
  private progressText = '';
  private readonly listeners = new Set<() => void>();

  getInstalled(): StemModelInstalled {
    return this.installed;
  }

  isInstalled(id: string): boolean {
    return this.installed[id] !== undefined;
  }

  setInstalled(v: StemModelInstalled): void {
    this.installed = v;
    this.emit();
  }

  progress(): string {
    return this.progressText;
  }

  setProgress(text: string): void {
    if (this.progressText === text) return;
    this.progressText = text;
    this.emit();
  }

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

export const appStemModel = new StemModelState();

/** 取り込み / 消すの後始末を 1 か所に持つ(成功したときだけ控えを書き換え、成否によらず何か言う)。 */
export function applyStemResult(
  state: StemModelState,
  result: { ok: true; installed: StemModelInstalled; message: string } | { ok: false; message: string },
  ui: { notify: (message: string) => void },
): void {
  if (result.ok) state.setInstalled(result.installed);
  ui.notify(result.message);
}

/** 「入っている」を 1 行で言う(大きさ・日付・取得元は実体から出す)。 */
export function stemInstalledText(model: StemModel, installed: StemModelInstalled): string {
  const m = installed[model.id];
  if (m === undefined) return '';
  const at = new Date(m.installedAt);
  const date = Number.isNaN(at.getTime())
    ? '日時不明'
    : `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;
  return `取り込み済み(${humanBytes(m.bytes)} / ${date} / ${stemHost(m.url)})`;
}

function button(action: string, label: string, field: string, model?: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.setAttribute('data-pkc-action', action);
  b.setAttribute('data-pkc-field', field);
  if (model !== undefined) b.setAttribute('data-pkc-part', model);
  b.textContent = label;
  return b;
}

export interface StemModelPanel {
  readonly root: HTMLElement;
  sync(): void;
  dispose(): void;
}

export function buildStemModelPanel(state: StemModelState = appStemModel): StemModelPanel {
  const root = document.createElement('section');
  root.setAttribute('data-pkc-region', 'settings-stem');
  const head = document.createElement('h4');
  head.textContent = STEM_SECTION_LABEL;
  root.append(head);

  const intro = document.createElement('p');
  intro.setAttribute('data-pkc-field', 'settings-note');
  // 🔑 説明は 1 行 + hover(`settings-notes.test.ts` が 55 字で止める)。詳しくはマニュアル(「歌声と楽器に分ける」)
  intro.textContent = '歌声と楽器を分けるモデルを、この端末に取り込みます(録音は外へ出ません)。';
  intro.title =
    'モデルは公開の配布元からこのブラウザが取得します。一度取り込めば次からは取得せず、ここで消せます。録音の「仕上げ ▾」から押したときも、無ければ取り込みます。';
  root.append(intro);

  interface Row {
    readonly model: StemModel;
    readonly install: HTMLButtonElement;
    readonly installed: HTMLElement;
    readonly remove: HTMLButtonElement;
  }
  const rows: Row[] = [];
  for (const model of STEM_MODELS) {
    const wrap = document.createElement('div');
    wrap.setAttribute('data-pkc-field', 'stem-model');
    wrap.setAttribute('data-pkc-part', model.id);
    const install = button('install-stem-model', `${model.label}(約 ${humanBytes(model.approxBytes)})を取り込む`, 'stem-install', model.id);
    install.title = 'この端末にモデルを取り込みます。一度取り込めば、次からは取得しません。';
    const installed = document.createElement('span');
    installed.setAttribute('data-pkc-field', 'stem-installed');
    const remove = button('remove-stem-model', `${model.label}のモデルを消す`, 'stem-remove', model.id);
    remove.title = 'この端末から、このモデルを消します(ノートや添付は消えません。使うときにもう一度取得します)。';
    wrap.append(install, installed, remove);
    root.append(wrap);
    rows.push({ model, install, installed, remove });
  }

  const progress = document.createElement('p');
  progress.setAttribute('data-pkc-field', 'stem-progress');
  progress.hidden = true;
  const cancel = button('cancel-stem-install', '取得をやめる', 'stem-cancel');
  cancel.title = '取得を途中でやめます(端末には何も書きません)。';
  cancel.hidden = true;
  root.append(progress, cancel);

  const sync = (): void => {
    const all = state.getInstalled();
    const busy = state.progress() !== '';
    for (const r of rows) {
      const has = all[r.model.id] !== undefined;
      r.install.hidden = has;
      r.installed.hidden = !has;
      r.installed.textContent = has ? stemInstalledText(r.model, all) : '';
      r.remove.hidden = !has;
      // 取得中は押せなくする(実体側にも同じ門がある ── `StemModelInstaller.isRunning`)
      r.install.disabled = busy;
      r.remove.disabled = busy;
    }
    progress.hidden = !busy;
    progress.textContent = state.progress();
    cancel.hidden = !busy;
  };
  sync();
  const off = state.onChange(sync);
  return { root, sync, dispose: off };
}
