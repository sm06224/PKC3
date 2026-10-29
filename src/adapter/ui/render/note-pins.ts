/**
 * 🔴 **ピン留めしたノートの固定エリア**(#1377)。左の列の一覧(`browse-host`)の**すぐ上**に常時出る。
 *
 * - 更新順・絞り込み・フォルダの移動に関わらず**いつも同じ場所**に並ぶ(一覧の面を替えても消えない)
 * - 行を押すとそのノートを開く(`select-entry` ── 一覧の行と同じ 1 本)
 * - 各行の「外す」でピン留めを外す(`unpin-note`)。留める口は行の右クリックの「ピン留めする」(`pin-note`)
 *   ── **置けるなら外せる**
 * - 何もピン留めしていなければ**畳む**(空の帯が場所を取らない)
 *
 * ⚠ 2 ペインの「ブックマーク」の帯とは別物(あちらは 2 ペインだけ)。
 * ⚠ 表示は `textContent` だけ(題名は user の入力 ── HTML として読まない)。
 * 🔑 描き直しは姿(指紋)が変わったときだけ ── 押している最中に作り直さない。
 */
import type { AppState } from '@adapter/state/app-state';
import { appNotePins, type NotePinStore } from '@adapter/platform/note-pin-store';
import { livePinLids } from '@features/relation/note-pins';
import { buildPressedButton } from './choice-buttons';

export const NOTE_PINS_REGION = 'note-pins';

export class NotePinBar {
  private lastPrint = '';
  private lastState: AppState | null = null;
  private readonly off: () => void;

  constructor(
    private readonly host: HTMLElement,
    private readonly store: NotePinStore = appNotePins,
  ) {
    host.hidden = true;
    // 別のタブの書込・自分の操作でピンが変わったら描き直す(状態が動かなくても)
    this.off = store.onChange(() => {
      if (this.lastState !== null) this.render(this.lastState);
    });
  }

  dispose(): void {
    this.off();
  }

  render(state: AppState): void {
    this.lastState = state;
    const lids = livePinLids(this.store.list(), state.cid, (lid) => state.entryMetas.has(lid));
    const print = JSON.stringify([
      lids.map((lid) => [lid, state.entryMetas.get(lid)?.title ?? '', state.selectedLid === lid]),
    ]);
    if (print === this.lastPrint) return;
    this.lastPrint = print;
    this.host.hidden = lids.length === 0;
    this.host.textContent = '';
    if (lids.length === 0) return;

    const head = document.createElement('span');
    head.setAttribute('data-pkc-field', 'note-pins-label');
    head.textContent = 'ピン留め';
    this.host.append(head);
    for (const lid of lids) {
      const title = state.entryMetas.get(lid)?.title ?? '';
      const shown = title === '' ? '(無題)' : title;
      const row = document.createElement('div');
      row.setAttribute('data-pkc-field', 'note-pin-row');
      const open = buildPressedButton({
        action: 'select-entry',
        dataAttr: 'data-pkc-entry',
        value: lid,
        label: shown,
        pressed: state.selectedLid === lid,
        title: `「${shown}」を開きます`,
      });
      open.setAttribute('data-pkc-field', 'note-pin-open');
      const unpin = document.createElement('button');
      unpin.type = 'button';
      unpin.setAttribute('data-pkc-action', 'unpin-note');
      unpin.setAttribute('data-pkc-field', 'note-pin-remove');
      unpin.setAttribute('data-pkc-entry', lid);
      unpin.textContent = '外す';
      unpin.title = `「${shown}」のピン留めを外します(ノートは消えません)`;
      row.append(open, unpin);
      this.host.append(row);
    }
  }
}
