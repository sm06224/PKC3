/**
 * 設定の面に置く **Office 一式の設置・状態・削除**(#88 / 統合設計 O6-a)。
 *
 * 🔴 user 裁定 2026-08-10:「**実行したい人が手動で設定した際に追加ダウンロードと
 * idb とか opfs に配備して、以降の起動はローカルからにしてください**」──
 * **勝手に取りに行かない**。押した人にだけ 77MB を取らせる。
 *
 * ## 導線は 2 つ、どちらも一級
 *
 * | 押すもの | 何をするか |
 * |---|---|
 * | **取得して入れる** | 同一 origin の配布元(`../office-pack/`)から取る |
 * | **ファイルから入れる** | 手元の zip を選ぶ。⚠ **CORS の外なので必ず通る** |
 *
 * ⚠ 後者は保険ではない ── user 裁定「うまくいかない場合は、ローカルとかを介して
 * ユーザーができればいいです」の側であり、配布元が無くても成立する唯一の道である。
 *
 * ## 🔴 器は 1 度だけ組み、字だけ差し替える
 *
 * 設定の面は `hidden` で常駐する(閉じても捨てない)。組み直すと
 * **押している最中のボタンが作り直されて無言の dead click になる** ──
 * この repo が 2026-08-07 に 3 面で踏んだ形なので、`sync()` で字だけ書き換える。
 */
import type { OfficePackMeta } from '@adapter/platform/office/office-pack';
import { appOfficePack, type OfficePackState } from './office-entry-view';
import { readOfficeCapability, missingCapabilities } from '@features/office/office-entry';

/** 「入っている」を 1 行で言う。⚠ 版・大きさ・日付は**腐りやすい数字**なので実体から出す。 */
export function packStatusText(meta: OfficePackMeta | null): string {
  if (meta === null) return '入っていません';
  const mb = Math.round((meta.totalBytes / (1024 * 1024)) * 10) / 10;
  const at = new Date(meta.installedAt);
  const date = Number.isNaN(at.getTime())
    ? '日時不明'
    : `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;
  const from = meta.source === 'url' ? '配布元から' : 'ファイルから';
  return `入っています ── ${meta.version} / ${mb}MB / ${date} に${from}設置`;
}

/**
 * この端末で Office 表示が動くか、を 1 行で言う。
 *
 * ⚠ **設置とは別の軸**である。入れても動かない環境があるので、
 * 「入っています」だけ出すと user は「なのに開けない」と迷う。
 */
export function packCapabilityText(): string {
  const missing = missingCapabilities(readOfficeCapability(globalThis));
  if (missing.length === 0) return 'この環境では動きます';
  return `この環境では動きません ── ${missing.join(' / ')}`;
}

/** 設置 / 削除の結果を受けた後、画面をどう合わせるか。 */
export interface PackResultUi {
  /** 添付の面を描き直す(**中央は別経路**なので、設定の面だけ直すと古い値が残る)。 */
  redrawDetail: () => void;
  notify: (message: string) => void;
}

/**
 * 🔴 **設置 / 削除の後始末を 1 か所に持つ**(#88 / O6-a)。
 *
 * ⚠ `main.ts` に書くと**どの test からも実行されない**(CLAUDE.md 2026-08-08)。
 * ここが守るのは 3 つ:
 *  ① 成功したときだけ控えを書き換える(失敗で「入った」ことにしない)
 *  ② 🔴 **成功したら中央も描き直す** ── 添付の入口と設定の面は**別経路**で、
 *     設定だけ直すと「入れたのに設置カードが出たまま」になる
 *  ③ 成否によらず**必ず何か言う** ── 押して無反応、を作らない
 */
export function applyPackResult(
  state: OfficePackState,
  result: { ok: true; meta: OfficePackMeta | null; message: string } | { ok: false; message: string },
  ui: PackResultUi,
): void {
  if (result.ok) {
    state.setMeta(result.meta);
    ui.redrawDetail();
  }
  ui.notify(result.message);
}

function button(action: string, label: string, field: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.setAttribute('data-pkc-action', action);
  b.setAttribute('data-pkc-field', field);
  b.textContent = label;
  return b;
}

export interface OfficePackPanel {
  readonly root: HTMLElement;
  /** 状態が変わったら呼ぶ(器は組み直さない)。 */
  sync(): void;
  dispose(): void;
}

/**
 * 設定の面へ入れる節を組む。
 *
 * ⚠ 呼び側は `sync()` を**自分で呼ばなくてよい** ── 変化は `OfficePackState` が
 * 放送する。ただし面を作り直すときは `dispose()` で購読を切ること
 * (`docs/development/stale-listener-prevention.md` と同じ規約)。
 */
export function buildOfficePackPanel(state: OfficePackState = appOfficePack): OfficePackPanel {
  const root = document.createElement('section');
  root.setAttribute('data-pkc-region', 'settings-office');
  const head = document.createElement('h3');
  head.textContent = 'Office 表示';
  root.append(head);

  const intro = document.createElement('p');
  intro.setAttribute('data-pkc-field', 'settings-note');
  intro.textContent =
    'Word / Excel / PowerPoint の添付を、別の窓で開いて読めるようにします。'
    + '約 77MB のひとそろいをこの端末に入れます ── 一度入れれば、次からは端末の中から起動します。';
  root.append(intro);

  const status = document.createElement('p');
  status.setAttribute('data-pkc-field', 'office-pack-status');
  const capability = document.createElement('p');
  capability.setAttribute('data-pkc-field', 'office-pack-capability');
  root.append(status, capability);

  const row = document.createElement('div');
  row.setAttribute('data-pkc-field', 'office-pack-actions');
  const fromUrl = button('install-office-pack', '取得して入れる', 'office-pack-url');
  fromUrl.title = '同じ場所に置いてある配布元から取ります';
  // ⚠ **input を先に作る**(ボタンが指す先が無い状態を一瞬も作らない)
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.zip,application/zip';
  input.hidden = true;
  // ⚠ `data-pkc-action` は**付けない**。受け取りは binder の `change` 側が
  //    `data-pkc-field` で拾う(`attach-input` / `import-input` と同じ作法)──
  //    action を書くと、中身の空な受け手を 1 つ増やすことになる
  input.setAttribute('data-pkc-field', 'office-pack-input');
  const fromFile = button('choose-office-pack', 'ファイルから入れる', 'office-pack-file');
  fromFile.title = '手元の lo-wasm-qt6.zip を選びます(配布元に届かない環境でも入ります)';
  const remove = button('remove-office-pack', '削除', 'office-pack-remove');
  remove.title = 'この端末からひとそろいを消します(ノートや添付は消えません)';
  row.append(fromUrl, fromFile, remove, input);
  root.append(row);

  const progress = document.createElement('p');
  progress.setAttribute('data-pkc-field', 'office-pack-progress');
  progress.hidden = true;
  root.append(progress);

  const sync = (): void => {
    const meta = state.getMeta();
    status.textContent = packStatusText(meta);
    capability.textContent = packCapabilityText();
    const busy = state.progress() !== '';
    progress.hidden = !busy;
    progress.textContent = state.progress();
    /**
     * ⚠ **設置中は押せなくする。** 93MB を 2 本走らせると quota も帯域も倍食う。
     * 🔑 実体側にも同じ門が在る(`OfficePackInstaller.isRunning`)── 画面の
     *   `disabled` は**見た目の親切**であって、守っているのは実体側である
     *   (`disabled` は DevTools で外せる)。
     */
    fromUrl.disabled = busy;
    fromFile.disabled = busy;
    // ⚠ 入っていないのに「削除」を押せると、押しても何も起きないボタンになる
    remove.disabled = busy || meta === null;
  };
  sync();
  const off = state.onChange(sync);

  return { root, sync, dispose: () => { off(); } };
}
