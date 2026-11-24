/**
 * 🔴 **端末間の同期の暗号化の欄**(#2000 段 4b-B。user 裁定)── S3 互換の保管先の節と同期フォルダの節が**同じ欄**を持つ。
 *
 * - 「中身を暗号化する」(S3 は既定オン / フォルダは既定オフ)
 * - 設定(置き場に暗号化キーが無いとき): パスフレーズを 2 回 → 回復キーを 1 度だけ見せて打ち直し(`confirmRecoveryKeyInApp`)→ 完了
 * - 開く(置き場に在るとき): パスフレーズか回復キー
 * - 開いているとき: 「開くたびにパスフレーズを入れる」/ 「パスフレーズを変更」
 * - 巻き戻しの疑いで取り込んでいない端末の「この端末を受け入れ直す」
 * ⚠ パスフレーズ・回復キーの欄は、押したときに読んですぐ空にする(画面にも設定にも残さない。欄の字は設定の保存に入れない)。
 */
import { PASSPHRASE_HINT, PASSPHRASE_MIN_LENGTH, passphraseStrength } from '@features/sync/passphrase';
import type { SyncFolderView } from '@adapter/platform/sync-folder';

export type E2EPanelKind = 's3' | 'folder';
export const SYNC_E2E_REGION = 'sync-e2e';
export const SYNC_E2E_ON_LABEL = '中身を暗号化する';
export const SYNC_E2E_ASK_LABEL = '開くたびにパスフレーズを入れる';
export const SYNC_E2E_SETUP_LABEL = '暗号化を設定する';
export const SYNC_E2E_UNLOCK_LABEL = '開く';
export const SYNC_E2E_CHANGE_LABEL = 'パスフレーズを変更';
export const SYNC_E2E_ACCEPT_LABEL = 'この端末を受け入れ直す';
export const SYNC_E2E_ON_TITLE =
  'ノートの中身を、この端末で暗号化してから保管先へ置きます(保管先の運営者や、ファイルを覗いた人には読めません)。同じ保管先を使う全部の端末でオンにしてください';

const field = (el: HTMLElement, name: string): HTMLElement => {
  el.setAttribute('data-pkc-field', name);
  return el;
};

function button(action: string, label: string, title: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.setAttribute('data-pkc-action', action);
  b.textContent = label;
  b.title = title;
  return b;
}

function secretInput(name: string, label: string, autocomplete = 'off'): { row: HTMLLabelElement; input: HTMLInputElement } {
  const row = document.createElement('label');
  const span = document.createElement('span');
  span.textContent = label;
  const input = document.createElement('input');
  input.type = 'password';
  field(input, name);
  input.setAttribute('autocomplete', autocomplete);
  input.spellcheck = false;
  row.append(span, input);
  return { row, input };
}

function viaSelect(name: string): HTMLSelectElement {
  const sel = document.createElement('select');
  field(sel, name);
  sel.setAttribute('data-pkc-action', 'set-sync-e2e-via');
  for (const [v, t] of [['passphrase', 'パスフレーズ'], ['recovery', '回復キー']] as const) {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = t;
    sel.append(o);
  }
  return sel;
}

function checkRow(name: string, action: string | null, label: string, title: string): { row: HTMLLabelElement; box: HTMLInputElement } {
  const row = document.createElement('label');
  const box = document.createElement('input');
  box.type = 'checkbox';
  field(box, name);
  if (action !== null) box.setAttribute('data-pkc-action', action);
  row.append(box, document.createTextNode(` ${label}`));
  row.title = title;
  return { row, box };
}

const ASK_TITLE =
  'オンにすると、暗号化キーをこの端末に置きません。画面を開くたびにパスフレーズを入れるまで、同期は待ちます(共用のパソコン向け)。オフなら、この端末に取り出せない形で置いて、自動で同期します';

/** 欄を組む(1 度だけ。中の見え方は `syncE2EPanel` が合わせる)。 */
export function buildE2EPanel(kind: E2EPanelKind): HTMLElement {
  const panel = document.createElement('div');
  panel.setAttribute('data-pkc-region', SYNC_E2E_REGION);
  panel.setAttribute('data-pkc-e2e-kind', kind);
  const on = checkRow('sync-e2e-on', 'set-sync-e2e', SYNC_E2E_ON_LABEL, SYNC_E2E_ON_TITLE);
  on.box.checked = kind === 's3';
  const status = field(document.createElement('p'), 'sync-e2e-status');

  // ── 設定(置き場に暗号化キーが無いとき)
  const setup = field(document.createElement('div'), 'sync-e2e-setup');
  const setupNote = document.createElement('p');
  setupNote.textContent = `この置き場の暗号化のパスフレーズを決めます(${String(PASSPHRASE_MIN_LENGTH)} 文字以上)。次に回復キーを見せるので、必ず保存してください。パスフレーズと回復キーを両方なくすと、暗号化したノートは読めなくなります。`;
  const p1 = secretInput('sync-e2e-pass', 'パスフレーズ', 'new-password');
  const p2 = secretInput('sync-e2e-pass2', 'もう一度', 'new-password');
  const hint = field(document.createElement('p'), 'sync-e2e-hint');
  hint.setAttribute('aria-live', 'polite');
  const askSetup = checkRow('sync-e2e-ask-setup', null, SYNC_E2E_ASK_LABEL, ASK_TITLE);
  p1.input.addEventListener('input', () => {
    hint.textContent = p1.input.value === '' ? '' : PASSPHRASE_HINT[passphraseStrength(p1.input.value)];
  });
  setup.append(
    setupNote,
    p1.row,
    p2.row,
    hint,
    askSetup.row,
    button('start-sync-e2e-setup', SYNC_E2E_SETUP_LABEL, 'パスフレーズから暗号化キーを作り、回復キーを見せます(確認が済むまで、保管先には何も書きません)'),
  );

  // ── 開く(置き場に在るとき)
  const unlock = field(document.createElement('div'), 'sync-e2e-unlock');
  const unlockNote = document.createElement('p');
  unlockNote.textContent = 'この置き場の暗号化キーを開きます。ほかの端末で決めたパスフレーズ(忘れたときは回復キー)を入れてください。';
  const uvia = viaSelect('sync-e2e-unlock-via');
  const usecret = secretInput('sync-e2e-unlock-secret', '入力');
  const uask = checkRow('sync-e2e-ask-unlock', null, SYNC_E2E_ASK_LABEL, ASK_TITLE);
  uask.box.addEventListener('change', () => uask.box.setAttribute('data-pkc-touched', '1'));
  unlock.append(unlockNote, uvia, usecret.row, uask.row, button('unlock-sync-e2e', SYNC_E2E_UNLOCK_LABEL, '暗号化キーを開いて、同期を再開します'));

  // ── 開いているとき
  const opened = field(document.createElement('div'), 'sync-e2e-open');
  const ask = checkRow('sync-e2e-ask', 'set-sync-e2e-remember', SYNC_E2E_ASK_LABEL, ASK_TITLE);
  const change = document.createElement('details');
  field(change, 'sync-e2e-change');
  const sum = document.createElement('summary');
  sum.textContent = SYNC_E2E_CHANGE_LABEL;
  const cvia = viaSelect('sync-e2e-change-via');
  const cur = secretInput('sync-e2e-change-current', 'いまの入力');
  const n1 = secretInput('sync-e2e-change-new', '新しいパスフレーズ', 'new-password');
  const n2 = secretInput('sync-e2e-change-new2', 'もう一度', 'new-password');
  const chint = field(document.createElement('p'), 'sync-e2e-change-hint');
  n1.input.addEventListener('input', () => {
    chint.textContent = n1.input.value === '' ? '' : PASSPHRASE_HINT[passphraseStrength(n1.input.value)];
  });
  change.append(
    sum,
    cvia,
    cur.row,
    n1.row,
    n2.row,
    chint,
    button('change-sync-e2e-passphrase', '変更する', '暗号化キーを新しいパスフレーズで包み直します(ノートのファイルは書き直しません。ほかの端末の開き直しには新しいパスフレーズを使います)'),
  );
  opened.append(ask.row, change);

  // ── 受け入れ直す
  const refused = field(document.createElement('div'), 'sync-e2e-refused');

  const result = field(document.createElement('p'), 'sync-e2e-result');
  result.setAttribute('aria-live', 'polite');
  panel.append(on.row, status, setup, unlock, opened, refused, result);
  return panel;
}

const STATUS_NOTE = {
  off: '暗号化していません(保管先には、ノートの中身がそのまま置かれます)',
  unavailable: 'このブラウザでは暗号化を使えません(暗号化したい接続は、平文では書かずに止まります)',
  unknown: '暗号化の状態を確かめています…',
  broken: '置き場の暗号化キーの束(keyring.json)を読めません(別のものが置かれているか、内容が正しくありません)',
  none: 'この置き場にはまだ暗号化キーがありません。パスフレーズを決めてください',
  locked: '暗号化キーが開かれていません。パスフレーズを入れると同期を再開します',
  open: '暗号化しています(暗号化キーを開いています)',
} as const;

/** 見え方を合わせる。`v` = いまの同期の姿(`null` = まだ繋がっていない)、`connected` = この節の同期先に繋がっているか。 */
export function syncE2EPanel(panel: HTMLElement, v: SyncFolderView | null, opts: { connected: boolean; enabled: boolean }): void {
  const q = <T extends HTMLElement>(name: string): T => panel.querySelector<T>(`[data-pkc-field="${name}"]`) as T;
  const e = v?.e2e ?? null;
  const connected = opts.connected && e !== null;
  const on = q<HTMLInputElement>('sync-e2e-on');
  if (connected && e !== null) {
    if (on.checked !== e.on) on.checked = e.on;
  }
  // 接続していない間: S3 は接続前の選択として押せる / フォルダは選んでから
  on.disabled = !opts.enabled || (panel.getAttribute('data-pkc-e2e-kind') === 'folder' && !connected) || (connected && e !== null && !e.available);
  let status: string;
  let phase: 'off' | 'unknown' | 'broken' | 'none' | 'locked' | 'open' | 'hidden' = 'hidden';
  if (!connected) {
    status = panel.getAttribute('data-pkc-e2e-kind') === 's3' ? (on.checked ? '接続すると、暗号化して同期します(接続のあとで、パスフレーズを決めます)' : '暗号化しません(保管先には、ノートの中身がそのまま置かれます)') : '同期フォルダを選んでから、暗号化できます';
  } else if (e === null || !e.available) {
    status = STATUS_NOTE.unavailable;
  } else if (!e.on) {
    status = STATUS_NOTE.off;
    phase = 'off';
  } else if (e.open) {
    status = STATUS_NOTE.open;
    phase = 'open';
  } else if (e.keyring === 'none') {
    status = STATUS_NOTE.none;
    phase = 'none';
  } else if (e.keyring === 'present') {
    status = STATUS_NOTE.locked;
    phase = 'locked';
  } else if (e.keyring === 'broken') {
    status = STATUS_NOTE.broken;
    phase = 'broken';
  } else {
    status = STATUS_NOTE.unknown;
    phase = 'unknown';
  }
  const st = q('sync-e2e-status');
  if (st.textContent !== status) st.textContent = status;
  panel.setAttribute('data-pkc-state', phase);
  const show = (name: string, yes: boolean): void => {
    const el = q(name);
    if (el.hidden === yes) el.hidden = !yes;
  };
  show('sync-e2e-setup', phase === 'none');
  show('sync-e2e-unlock', phase === 'locked');
  show('sync-e2e-open', phase === 'open');
  const refusedList = q('sync-e2e-refused');
  const refused = connected ? (e?.refused ?? []) : [];
  const key = refused.join(',');
  if (refusedList.getAttribute('data-pkc-refused') !== key) {
    refusedList.setAttribute('data-pkc-refused', key);
    refusedList.replaceChildren();
    for (const dev of refused) {
      const row = document.createElement('div');
      const label = document.createElement('span');
      label.textContent = `端末 ${dev.slice(0, 8)} のファイルは、古いファイルの差し戻しの疑いで取り込んでいません`;
      const b = button('accept-sync-e2e-peer', SYNC_E2E_ACCEPT_LABEL, '相手の端末が古いバックアップから戻したときだけ押します。次の同期から、その端末のファイルを再読み込みします');
      b.setAttribute('data-pkc-device', dev);
      row.append(label, b);
      refusedList.append(row);
    }
  }
  refusedList.hidden = refused.length === 0;
  const ask = q<HTMLInputElement>('sync-e2e-ask');
  if (e !== null && ask.checked !== e.ask) ask.checked = e.ask;
  // 開き直すときの初期値 = この端末の選び方(「開くたびに入れる」の端末が、開き直しで黙って「自動」へ変わらない)
  const askUnlock = q<HTMLInputElement>('sync-e2e-ask-unlock');
  if (e !== null && askUnlock.getAttribute('data-pkc-touched') !== '1' && askUnlock.checked !== e.ask) askUnlock.checked = e.ask;
}
