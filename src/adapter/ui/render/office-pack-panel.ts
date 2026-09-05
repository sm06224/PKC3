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
 * | **取得して入れる** | 同一 origin の配布元(`/office-pack/`)から取る |
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
import {
  comparePackVersion,
  packUpdateText,
} from '@adapter/platform/office/office-pack-update';
import { appOfficePack, type OfficePackState } from './office-entry-view';
import { readOfficeCapability, missingCapabilities } from '@features/office/office-entry';
import { humanBytes } from '@features/human-bytes';

/** 「入っている」を 1 行で言う。⚠ 版・大きさ・日付は**腐りやすい数字**なので実体から出す。 */
export function packStatusText(meta: OfficePackMeta | null): string {
  if (meta === null) return '入っていません';
  const at = new Date(meta.installedAt);
  const date = Number.isNaN(at.getTime())
    ? '日時不明'
    : `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;
  const from = meta.source === 'url' ? '配布元から' : 'ファイルから';
  return `入っています ── ${meta.version} / ${humanBytes(meta.totalBytes)} / ${date} に${from}設置`;
}

/**
 * 🔴 **どのビルドかを 1 行で言う**(#155)。
 *
 * ⚠ 版の文字列(`packStatusText` の側)だけでは足りない ── **使い回されることがある**。
 * 実機の不具合報告のたびに「どのビルドを見ているか」を確かめる必要があり、
 * それが無いと**直したはずの症状をもう一度追う**(2026-08-15 に実際に起きた)。
 * ⚠ 古い一式は素性を持たない ── そのときは**そう言う**(黙って行を消さない。
 * 「出ていない」と「持っていない」を user が区別できなくなる)。
 */
export function packBuildText(meta: OfficePackMeta | null): string {
  if (meta === null) return '';
  const b = meta.build;
  if (b === null) return 'どのビルドかは分かりません(この一式を入れた頃は記録していませんでした)';
  const parts: string[] = [];
  // ⚠ sha は**先頭 12 字**(全部は読めないし、突合には足りる)
  if (b.loSha !== '') parts.push(`LibreOffice ${b.loSha.slice(0, 12)}`);
  if (b.builtAt !== '') parts.push(`焼いた日時 ${b.builtAt}`);
  if (b.runId !== '') parts.push(`ビルド番号 ${b.runId}`);
  if (b.qtRef !== '') parts.push(`Qt ${b.qtRef}`);
  if (b.emsdk !== '') parts.push(`emsdk ${b.emsdk}`);
  return parts.join(' / ');
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
  /**
   * 🔴 **足りないものを並べるだけで終わらない**(#111)。
   *
   * 「分離(cross-origin isolation)」と言われて次に何をすればいいか分かる user は
   * 居ない ── 実際 2026-08-11 に、この文だけを見て「うーん??」で止まった。
   * ⚠ そもそも**こちらの落ち度で出ていた**(本番に分離を作る仕掛けが無かった)。
   * いまは初回に 1 回読み直して成立させるので、ここに残るのは
   * **本当にブラウザが足りない場合**だけである。だから次の一歩を書く。
   */
  return `この環境では動きません ── ${missing.join(' / ')}。`
    + 'Office 表示は Chrome / Edge などの新しい Chromium 系が要ります。';
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
    'Word / Excel / PowerPoint の添付を、別のウィンドウで開いて読めるようにします。'
    + '約 77MB の一式をこの端末に入れます ── 一度入れれば、次からは端末の中から起動します。';
  root.append(intro);

  const status = document.createElement('p');
  status.setAttribute('data-pkc-field', 'office-pack-status');
  /**
   * 🔴 **どのビルドか**(#155)。⚠ 版の行の**すぐ下**に置く ── 同じ問い
   * (「いま入っているのは何か」)の答えなので離さない。
   */
  const build = document.createElement('p');
  build.setAttribute('data-pkc-field', 'office-pack-build');
  const capability = document.createElement('p');
  capability.setAttribute('data-pkc-field', 'office-pack-capability');
  /**
   * 🔴 **配布元と版が違うことを言う**(user 裁定 2026-08-13「通知のみで OK」)。
   * ⚠ 空のときは**器ごと隠す**(空の行を user に出さない ── お知らせと同じ作法)。
   */
  const update = document.createElement('p');
  update.setAttribute('data-pkc-field', 'office-pack-update');
  update.hidden = true;
  root.append(status, build, capability, update);

  const row = document.createElement('div');
  row.setAttribute('data-pkc-field', 'office-pack-actions');
  const fromUrl = button('install-office-pack', '取得して入れる', 'office-pack-url');
  // ⚠ 「同じ場所」と言わない ── 配布元は**このサイトの直下**であって、
  //    いま開いている頁の隣ではない(2026-08-11 に相対 path で 404 を踏んだ跡)
  fromUrl.title = 'このサイトに置いてある配布元から取ります';
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
  fromFile.title = '手元の lo-wasm-qt6.zip を選びます(配布元につながらない環境でも入れられます)';
  const remove = button('remove-office-pack', '削除', 'office-pack-remove');
  remove.title = 'この端末からひとそろいを消します(ノートや添付は消えません)';
  /**
   * 🔴 **Office の設定を初期状態に戻す**(#634)。
   *
   * ⚠ **「削除」では戻らない** ── 一式を消しても設定は localStorage に残るので、
   *   入れ直しても同じ設定で開く。落ちる設定を保存してしまうと**出られなくなる**
   *   (user 報告 2026-08-30「リボン UI がオンで開くとクラッシュしました」)。
   * ⚠ **押せなくしない。** 何も保存されていなくても「すでに初期状態です」と答える
   *   ほうが、灰色のボタンより分かる(困っている user は必ずここを押す)。
   */
  const resetProfile = button(
    'reset-office-profile',
    'Office の設定を初期化',
    'office-pack-reset-profile',
  );
  resetProfile.title =
    'Office の中で変えた設定(ツールバーの形・表示言語など)を消して、次に開くときは素の状態から始めます。'
    + '⚠ Office で書いたマクロも消えます。ノートも一式も消えません';
  row.append(fromUrl, fromFile, remove, resetProfile, input);
  root.append(row);

  const progress = document.createElement('p');
  progress.setAttribute('data-pkc-field', 'office-pack-progress');
  progress.hidden = true;
  root.append(progress);

  const sync = (): void => {
    const meta = state.getMeta();
    status.textContent = packStatusText(meta);
    const buildText = packBuildText(meta);
    build.textContent = buildText;
    // ⚠ 入っていないときは行ごと出さない(空の行を置かない)
    build.hidden = buildText === '';
    capability.textContent = packCapabilityText();
    // ⚠ 判定は `office-pack-update.ts` に 1 つだけ。ここは字にするだけ
    const text = packUpdateText(
      comparePackVersion(meta?.version ?? null, state.getAvailableVersion()),
    );
    update.hidden = text === null;
    update.textContent = text ?? '';
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
    // ⚠ 設定の初期化は**一式が入っていなくても押せる**(落ちて開けない人が使う口
    //    なので、一式の状態で塞がない)。⚠ 設置中だけは止める
    resetProfile.disabled = busy;
  };
  sync();
  const off = state.onChange(sync);

  return { root, sync, dispose: () => { off(); } };
}
