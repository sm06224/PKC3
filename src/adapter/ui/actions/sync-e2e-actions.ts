/**
 * 🔴 **端末間の同期の暗号化の画面操作**(#2000 段 4b-B)。`binder.ts` の `data-pkc-action` の受け手が呼ぶ ── 欄を読んで、
 * 実体(`SyncFolder` の暗号化の口)へ渡し、結果の字を欄の下(`sync-e2e-result`)へ出す。
 * ⚠ **秘密の欄(パスフレーズ・回復キー)は、読んだらすぐ空にする**。この file はそれらを保存しない・メッセージに出さない・console に出さない。
 */
import { passphraseProblem, sameRecoveryKey } from '@features/sync/passphrase';
import type { E2EResult, E2ESetupStart, E2EVia } from '@adapter/platform/sync-folder';
import { downloadBlob } from '@adapter/platform/download';
import { confirmInApp, confirmRecoveryKeyInApp } from '../render/app-dialog';
import { appSyncFolderView } from '../render/sync-folder-view';

/** 実体の口(`main.ts` が渡す)。 */
export interface SyncE2EServices {
  setEncrypt(on: boolean): Promise<E2EResult>;
  e2eBeginSetup(passphrase: string, remember: boolean): Promise<E2ESetupStart>;
  e2eUnlock(via: E2EVia, remember: boolean): Promise<E2EResult>;
  e2eSetRemember(remember: boolean): Promise<E2EResult>;
  e2eChangePassphrase(via: E2EVia, next: string): Promise<E2EResult>;
  acceptPeerAgain(device: string): Promise<boolean>;
}

export const SYNC_E2E_OFF_CONFIRM =
  'この端末で暗号化をやめます。自分のファイルを平文で書き直し、暗号化したファイル(.enc)を消します。この端末の暗号化キーは忘れます(置き場の暗号化キーの束は残ります)。ほかの端末が暗号化したままだと、その端末のファイルは読めなくなります。';
export const SYNC_E2E_ACCEPT_CONFIRM =
  '相手の端末のファイルが、取り込み済みのものより古い(または同じ連番で中身が違う)ため、取り込んでいません。相手の端末が古いバックアップから戻した場合は、受け入れ直してください。第三者が古いファイルを差し戻した可能性があるときは、受け入れ直さないでください(古い内容に戻ります)。受け入れ直しますか。';

const panelOf = (target: HTMLElement): HTMLElement | null => target.closest<HTMLElement>('[data-pkc-region="sync-e2e"]');
const fieldOf = <T extends HTMLElement>(panel: HTMLElement, name: string): T | null => panel.querySelector<T>(`[data-pkc-field="${name}"]`);

function show(panel: HTMLElement, text: string): void {
  const p = fieldOf(panel, 'sync-e2e-result');
  if (p !== null) p.textContent = text;
}

/** 秘密の欄を読んで、すぐ空にする。 */
function take(panel: HTMLElement, name: string): string {
  const el = fieldOf<HTMLInputElement>(panel, name);
  if (el === null) return '';
  const v = el.value;
  el.value = '';
  return v;
}

const peek = (panel: HTMLElement, name: string): string => fieldOf<HTMLInputElement>(panel, name)?.value ?? '';

function viaOf(panel: HTMLElement, viaField: string, secret: string): E2EVia {
  return fieldOf<HTMLSelectElement>(panel, viaField)?.value === 'recovery' ? { recoveryKey: secret } : { passphrase: secret };
}

/** 「開く」の入力の種類(パスフレーズ ↔ 回復キー)を切り替える(欄の字・見え方)。 */
export function runSetVia(target: HTMLElement): void {
  const panel = panelOf(target);
  if (panel === null || !(target instanceof HTMLSelectElement)) return;
  const unlock = target.getAttribute('data-pkc-field') === 'sync-e2e-unlock-via';
  const input = fieldOf<HTMLInputElement>(panel, unlock ? 'sync-e2e-unlock-secret' : 'sync-e2e-change-current');
  if (input === null) return;
  input.value = '';
  input.type = target.value === 'recovery' ? 'text' : 'password';
  input.placeholder = target.value === 'recovery' ? 'XXXX-XXXX-…(32 文字)' : '';
}

export async function runSetEncrypt(target: HTMLElement, sf: SyncE2EServices): Promise<void> {
  const panel = panelOf(target);
  if (panel === null || !(target instanceof HTMLInputElement)) return;
  const kind = panel.getAttribute('data-pkc-e2e-kind');
  const v = appSyncFolderView.view();
  const connected = kind === 's3' ? v?.kind === 's3' : v?.kind === 'folder';
  // 接続していない S3 = 接続のボタンが読む「選び方」だけ(何も起こさない)
  if (!connected) return;
  const on = target.checked;
  if (!on && (await confirmInApp(panel, SYNC_E2E_OFF_CONFIRM, { okLabel: '暗号化をやめる', cancelLabel: 'やめる', danger: true })) !== 'ok') {
    target.checked = true;
    return;
  }
  show(panel, on ? '暗号化をオンにしています…' : '暗号化をオフにしています…');
  const r = await sf.setEncrypt(on);
  show(panel, r.text);
  if (!r.ok) target.checked = !on;
}

export async function runSetup(target: HTMLElement, sf: SyncE2EServices): Promise<void> {
  const panel = panelOf(target);
  if (panel === null) return;
  const problem = passphraseProblem(peek(panel, 'sync-e2e-pass'), peek(panel, 'sync-e2e-pass2'));
  if (problem !== null) {
    show(panel, problem);
    return;
  }
  const remember = !(fieldOf<HTMLInputElement>(panel, 'sync-e2e-ask-setup')?.checked ?? false);
  const pass = take(panel, 'sync-e2e-pass');
  take(panel, 'sync-e2e-pass2');
  const hint = fieldOf(panel, 'sync-e2e-hint');
  if (hint !== null) hint.textContent = '';
  show(panel, 'パスフレーズから暗号化キーを作っています…');
  const start = await sf.e2eBeginSetup(pass, remember);
  if (start.kind === 'refused') {
    show(panel, start.text);
    return;
  }
  const answer = await confirmRecoveryKeyInApp(panel, start.recoveryKey, sameRecoveryKey, (name, text) =>
    downloadBlob(name, new Blob([text], { type: 'text/plain;charset=utf-8' })),
  );
  if (answer !== 'ok') {
    start.cancel();
    show(panel, '設定をやめました(置き場には何も書いていません)');
    return;
  }
  const r = await start.commit();
  show(panel, r.text);
}

export async function runUnlock(target: HTMLElement, sf: SyncE2EServices): Promise<void> {
  const panel = panelOf(target);
  if (panel === null) return;
  if (peek(panel, 'sync-e2e-unlock-secret') === '') {
    show(panel, 'パスフレーズ(または回復キー)を入力してください');
    return;
  }
  const remember = !(fieldOf<HTMLInputElement>(panel, 'sync-e2e-ask-unlock')?.checked ?? false);
  const secret = take(panel, 'sync-e2e-unlock-secret');
  show(panel, '開いています…');
  show(panel, (await sf.e2eUnlock(viaOf(panel, 'sync-e2e-unlock-via', secret), remember)).text);
}

export async function runSetRemember(target: HTMLElement, sf: SyncE2EServices): Promise<void> {
  const panel = panelOf(target);
  if (panel === null || !(target instanceof HTMLInputElement)) return;
  const ask = target.checked;
  const r = await sf.e2eSetRemember(!ask);
  show(panel, r.text);
  if (!r.ok) target.checked = !ask;
}

export async function runChange(target: HTMLElement, sf: SyncE2EServices): Promise<void> {
  const panel = panelOf(target);
  if (panel === null) return;
  if (peek(panel, 'sync-e2e-change-current') === '') {
    show(panel, 'いまのパスフレーズ(または回復キー)を入力してください');
    return;
  }
  const problem = passphraseProblem(peek(panel, 'sync-e2e-change-new'), peek(panel, 'sync-e2e-change-new2'));
  if (problem !== null) {
    show(panel, problem);
    return;
  }
  const cur = take(panel, 'sync-e2e-change-current');
  const next = take(panel, 'sync-e2e-change-new');
  take(panel, 'sync-e2e-change-new2');
  const hint = fieldOf(panel, 'sync-e2e-change-hint');
  if (hint !== null) hint.textContent = '';
  show(panel, '変更しています…');
  show(panel, (await sf.e2eChangePassphrase(viaOf(panel, 'sync-e2e-change-via', cur), next)).text);
}

export async function runAcceptPeer(target: HTMLElement, sf: SyncE2EServices): Promise<void> {
  const panel = panelOf(target);
  const device = target.getAttribute('data-pkc-device') ?? '';
  if (panel === null || device === '') return;
  if ((await confirmInApp(panel, SYNC_E2E_ACCEPT_CONFIRM, { okLabel: '受け入れ直す', cancelLabel: 'やめる', danger: true })) !== 'ok') return;
  const done = await sf.acceptPeerAgain(device);
  show(panel, done ? `端末 ${device.slice(0, 8)} を受け入れ直しました。次の同期から再読み込みします` : `端末 ${device.slice(0, 8)} の記録は、すでにありません`);
}
