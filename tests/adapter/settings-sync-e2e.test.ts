/** @vitest-environment happy-dom */
/**
 * 設定の「中身を暗号化する」の欄(#2000 段 4b-B。user 裁定)。
 *
 * - 見え方: 接続前の選び方(S3 は既定オン / フォルダは既定オフ・選ぶまで押せない)/ 状態ごとに 設定・開く・開いている・受け入れ直す が出入りする
 * - 🔴 回復キーの窓: 打ち直しが合うまで「完了」を押せない(大文字小文字・ハイフン・空白は問わない)/ やめる・Esc = 置き場に何も書かない
 * - 🔴 実体(`SyncFolder` + 作り物の S3)に画面から通す: 設定 → 開く → 開くたびに入れる → 変更 → オフ
 * - 🔴 パスフレーズ・回復キーが、画面を閉じたあと・localStorage・設定ファイル・メッセージ・置き場・同期の記録・console のどこにも残らない
 */
import { webcrypto } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

const saved: { name: string; text: string }[] = [];
vi.mock('../../src/adapter/platform/download', () => ({
  downloadBlob: (name: string, blob: Blob) => {
    void blob.text().then((text) => saved.push({ name, text }));
  },
  downloadUrl: () => undefined,
}));

import { S3Box, webSigCrypto } from '../../src/adapter/platform/s3-box';
import { SyncE2E } from '../../src/adapter/platform/sync-e2e';
import { SyncKeystore } from '../../src/adapter/platform/sync-keystore';
import {
  SyncFolder,
  type SyncFolderSaved,
  type SyncFolderStore,
  type SyncFolderView,
  type SyncRemoteForm,
} from '../../src/adapter/platform/sync-folder';
import { initialState } from '../../src/adapter/state/app-state';
import type { Dispatcher } from '../../src/adapter/state/dispatcher';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { SYNC_E2E_ACCEPT_CONFIRM, SYNC_E2E_OFF_CONFIRM } from '../../src/adapter/ui/actions/sync-e2e-actions';
import { resetAppDialogForTest } from '../../src/adapter/ui/render/app-dialog';
import { SyncEnabledStore } from '../../src/adapter/ui/render/sync-enabled';
import { SyncFolderViewSource, appSyncFolderView } from '../../src/adapter/ui/render/sync-folder-view';
import { createSyncFolderSection } from '../../src/adapter/ui/render/settings/sync-folder';
import { createSyncS3Section } from '../../src/adapter/ui/render/settings/sync-s3';
import { buildSettingsFile } from '../../src/features/settings/settings-file';
import { fakeS3 } from '../helpers/fake-s3';
import { memKeystoreBackend } from '../helpers/mem-keystore-backend';

const SECRET = { accessKeyId: 'AKIA-UI-CANARY-1', secretAccessKey: 'ui/SECRET+canary=9' };
const PASS = 'ui-パスフレーズ-CANARY-φ-5521';
const NEW_PASS = 'ui-あたらしい-CANARY-ω-8832';

const view = (over: Partial<SyncFolderView> = {}, e2e: Partial<SyncFolderView['e2e']> = {}): SyncFolderView => ({
  version: 1,
  phase: 'idle',
  folderName: 'my-notes/pkc3',
  kind: 's3',
  folderSupported: true,
  remoteUnavailable: null,
  remoteConfig: null,
  minutes: 5,
  lastAt: null,
  lastText: null,
  message: null,
  pending: 0,
  persist: true,
  e2e: { available: true, on: true, open: false, stored: false, ask: false, keyring: 'unknown', refused: [], ...e2e },
  ...over,
});

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, what: string, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`待ちきれない: ${what}`);
    await tick(10);
  }
}

afterEach(() => {
  resetAppDialogForTest();
  document.body.replaceChildren();
  saved.length = 0;
  vi.restoreAllMocks();
});

describe('欄の見え方', () => {
  function mount(kind: 's3' | 'folder', v: SyncFolderView) {
    const region = document.createElement('div');
    document.body.replaceChildren(region);
    const source = new SyncFolderViewSource();
    let cur = v;
    source.attach(() => cur);
    const en = new SyncEnabledStore(null);
    en.setEnabled(true);
    const section = kind === 's3' ? createSyncS3Section(region, source, en, { origin: () => 'https://n.example.org', hostname: () => 'n.example.org' }) : createSyncFolderSection(region, source, en);
    const dl = document.createElement('dl');
    dl.append(...(section.build() as Node[]));
    region.append(dl);
    section.sync(initialState);
    const panel = region.querySelector<HTMLElement>('[data-pkc-region="sync-e2e"]')!;
    const f = (n: string) => panel.querySelector<HTMLElement>(`[data-pkc-field="${n}"]`)!;
    const resync = (next: SyncFolderView) => {
      cur = next;
      section.sync(initialState);
    };
    return { region, panel, f, resync };
  }

  it('S3 は接続の前から「中身を暗号化する」が既定オン / 同期フォルダは既定オフで、フォルダを選ぶまで押せない', () => {
    const none = view({ kind: null, folderName: null, phase: 'none' });
    const s3 = mount('s3', none);
    expect((s3.f('sync-e2e-on') as HTMLInputElement).checked).toBe(true);
    expect((s3.f('sync-e2e-on') as HTMLInputElement).disabled).toBe(false);
    expect(s3.panel.textContent).toContain('中身を暗号化する');
    expect(s3.f('sync-e2e-status').textContent).toContain('接続すると、暗号化して同期します');
    const folder = mount('folder', none);
    expect((folder.f('sync-e2e-on') as HTMLInputElement).checked).toBe(false);
    expect((folder.f('sync-e2e-on') as HTMLInputElement).disabled).toBe(true);
    folder.resync(view({ kind: 'folder', folderName: 'クラウド' }, { on: false }));
    expect((folder.f('sync-e2e-on') as HTMLInputElement).disabled, '選んだら押せる').toBe(false);
    expect(folder.f('sync-e2e-status').textContent).toContain('暗号化していません');
  });

  it('状態ごとに 設定 / 開く / 開いている / 受け入れ直す が出入りする(対照群: 1 つずつ別の状態)', () => {
    const m = mount('s3', view({}, { keyring: 'none' }));
    const shown = () => ['sync-e2e-setup', 'sync-e2e-unlock', 'sync-e2e-open'].filter((n) => !m.f(n).hidden);
    expect(shown()).toEqual(['sync-e2e-setup']);
    expect(m.panel.getAttribute('data-pkc-state')).toBe('none');
    m.resync(view({}, { keyring: 'present' }));
    expect(shown()).toEqual(['sync-e2e-unlock']);
    expect(m.f('sync-e2e-status').textContent).toContain('パスフレーズを入れると同期を再開します');
    m.resync(view({}, { keyring: 'present', open: true, stored: true }));
    expect(shown()).toEqual(['sync-e2e-open']);
    expect((m.f('sync-e2e-ask') as HTMLInputElement).checked, '端末に置いている = 自動(「開くたびに入れる」はオフ)').toBe(false);
    m.resync(view({}, { keyring: 'present', open: true, ask: true }));
    expect((m.f('sync-e2e-ask') as HTMLInputElement).checked).toBe(true);
    m.resync(view({}, { on: false }));
    expect(shown()).toEqual([]);
    expect((m.f('sync-e2e-on') as HTMLInputElement).checked, '接続中は実体の状態を映す').toBe(false);
    m.resync(view({}, { keyring: 'broken' }));
    expect(m.f('sync-e2e-status').textContent).toContain('読めません');
    m.resync(view({}, { available: false }));
    expect(m.f('sync-e2e-status').textContent).toContain('このブラウザでは暗号化を使えません');

    expect(m.f('sync-e2e-refused').hidden, '対照群: 拒否中の端末が無ければ出さない').toBe(true);
    m.resync(view({}, { keyring: 'present', open: true, refused: ['aaaaaaaa11112222', 'bbbbbbbb33334444'] }));
    const btns = [...m.f('sync-e2e-refused').querySelectorAll<HTMLButtonElement>('[data-pkc-action="accept-sync-e2e-peer"]')];
    expect(btns.map((b) => b.getAttribute('data-pkc-device'))).toEqual(['aaaaaaaa11112222', 'bbbbbbbb33334444']);
    expect(btns[0]!.textContent).toBe('この端末を受け入れ直す');
    expect(m.f('sync-e2e-refused').textContent).toContain('aaaaaaaa');
  });

  it('パスフレーズの欄は伏せ字で、強さの目安を出す(入れた字そのものは出さない)', () => {
    const m = mount('s3', view({}, { keyring: 'none' }));
    const p1 = m.f('sync-e2e-pass') as HTMLInputElement;
    expect([p1.type, (m.f('sync-e2e-pass2') as HTMLInputElement).type]).toEqual(['password', 'password']);
    p1.value = 'short';
    p1.dispatchEvent(new Event('input'));
    expect(m.f('sync-e2e-hint').textContent).toContain('10 文字以上');
    p1.value = 'abcdefghijklmnopqrstuvwx';
    p1.dispatchEvent(new Event('input'));
    expect(m.f('sync-e2e-hint').textContent).toBe('十分な長さです');
    expect(m.f('sync-e2e-hint').textContent).not.toContain('abcdefgh');
  });
});

describe('回復キーの窓と欄の操作(作り物の実体)', () => {
  function harness(v: SyncFolderView, over: Partial<Record<string, unknown>> = {}) {
    const region = document.createElement('div');
    document.body.replaceChildren(region);
    const source = new SyncFolderViewSource();
    source.attach(() => v);
    appSyncFolderView.attach(() => v);
    const en = new SyncEnabledStore(null);
    en.setEnabled(true);
    const section = createSyncS3Section(region, source, en, { origin: () => 'https://n.example.org', hostname: () => 'n.example.org' });
    const dl = document.createElement('dl');
    dl.append(...(section.build() as Node[]));
    region.append(dl);
    section.sync(initialState);
    const commit = vi.fn(async () => ({ ok: true, text: '暗号化キーを作りました。暗号化して同期します' }));
    const cancel = vi.fn();
    const e2e = {
      setEncrypt: vi.fn(async () => ({ ok: true, text: 'オフにしました' })),
      e2eBeginSetup: vi.fn(async () => ({ kind: 'ready' as const, recoveryKey: 'ABCD-EFGH-JKMN-PQRS-TVWX-YZ01-2345-6789', commit, cancel })),
      e2eUnlock: vi.fn(async () => ({ ok: false, text: 'パスフレーズまたは回復キーが違います' })),
      e2eSetRemember: vi.fn(async () => ({ ok: true, text: '置きます' })),
      e2eChangePassphrase: vi.fn(async () => ({ ok: true, text: '変えました' })),
      acceptPeerAgain: vi.fn(async () => true),
      ...over,
    };
    bindActions(region, { dispatch: vi.fn(), getState: () => initialState } as unknown as Dispatcher, {
      syncFolder: { pick: vi.fn(), syncNow: vi.fn(), reconnect: vi.fn(), stop: vi.fn(), setMinutes: vi.fn(), allowPersist: vi.fn(), e2e },
    });
    const q = <T extends HTMLElement>(sel: string) => region.querySelector<T>(sel)!;
    const dialog = () => document.querySelector<HTMLDialogElement>('[data-pkc-region="app-dialog"]');
    const dq = <T extends HTMLElement>(n: string) => dialog()?.querySelector<T>(`[data-pkc-field="${n}"]`) ?? null;
    return { region, q, e2e, commit, cancel, dialog, dq, section };
  }

  async function startSetup(h: ReturnType<typeof harness>): Promise<void> {
    h.q<HTMLInputElement>('[data-pkc-field="sync-e2e-pass"]').value = PASS;
    h.q<HTMLInputElement>('[data-pkc-field="sync-e2e-pass2"]').value = PASS;
    h.q<HTMLButtonElement>('[data-pkc-action="start-sync-e2e-setup"]').click();
    await until(() => h.dq('recovery-key') !== null, '回復キーの窓');
  }

  it('🔴 設定: パスフレーズが短い / 一致しない → 実体を呼ばず理由を言う(欄は残す)', async () => {
    const h = harness(view({}, { keyring: 'none' }));
    const set = (a: string, b: string) => {
      h.q<HTMLInputElement>('[data-pkc-field="sync-e2e-pass"]').value = a;
      h.q<HTMLInputElement>('[data-pkc-field="sync-e2e-pass2"]').value = b;
      h.q<HTMLButtonElement>('[data-pkc-action="start-sync-e2e-setup"]').click();
    };
    set('short', 'short');
    expect(h.q('[data-pkc-field="sync-e2e-result"]').textContent).toContain('10 文字以上');
    set(PASS, `${PASS}x`);
    expect(h.q('[data-pkc-field="sync-e2e-result"]').textContent).toContain('一致しません');
    await tick(20);
    expect(h.e2e.e2eBeginSetup).not.toHaveBeenCalled();
    expect(h.q<HTMLInputElement>('[data-pkc-field="sync-e2e-pass"]').value, '直せるよう残す').toBe(PASS);
    expect(h.dialog(), '窓は出ない').toBeNull();
  });

  it('🔴 打ち直しが合うまで「完了」は押せない / 大文字小文字・ハイフン・空白は問わない / 合ったら確定し、窓は消えて回復キーが残らない', async () => {
    const h = harness(view({}, { keyring: 'none' }));
    await startSetup(h);
    expect(h.e2e.e2eBeginSetup).toHaveBeenCalledWith(PASS, true);
    expect(h.q<HTMLInputElement>('[data-pkc-field="sync-e2e-pass"]').value, '読んだらすぐ空').toBe('');
    expect(h.q<HTMLInputElement>('[data-pkc-field="sync-e2e-pass2"]').value).toBe('');
    expect(h.dq('recovery-key')!.textContent).toBe('ABCD-EFGH-JKMN-PQRS-TVWX-YZ01-2345-6789');
    const ok = h.dq<HTMLButtonElement>('dialog-ok')!;
    const typed = h.dq<HTMLInputElement>('recovery-retype')!;
    expect(ok.textContent).toBe('完了');
    expect(ok.disabled, '最初は押せない').toBe(true);
    const type = (t: string) => {
      typed.value = t;
      typed.dispatchEvent(new Event('input'));
    };
    type('ABCD-EFGH-JKMN');
    expect(ok.disabled, '途中').toBe(true);
    expect(h.dq('recovery-match')!.textContent).toBe('一致しません');
    type('ABCD-EFGH-JKMN-PQRS-TVWX-YZ01-2345-6780');
    expect(ok.disabled, '1 字違い').toBe(true);
    type('abcd efgh jkmn pqrs tvwx yz01 2345 6789');
    expect(ok.disabled, '小文字・空白でも合えば押せる').toBe(false);
    expect(h.dq('recovery-match')!.textContent).toBe('一致しました');
    type('ABCDEFGHJKMNPQRSTVWXYZ0123456789');
    expect(ok.disabled, 'ハイフン無しでも').toBe(false);
    expect(h.commit).not.toHaveBeenCalled();
    ok.click();
    await until(() => h.commit.mock.calls.length > 0, '確定');
    await until(() => h.dialog()?.open !== true, '窓が閉じる');
    expect(h.dialog()?.textContent ?? '', '🔴 閉じたら回復キーは窓に残らない').not.toContain('ABCD-EFGH');
    expect(h.q('[data-pkc-field="sync-e2e-result"]').textContent).toContain('暗号化キーを作りました');
    expect(document.body.textContent ?? '', '画面のどこにも残らない').not.toContain('ABCD-EFGH-JKMN');
  });

  it('🔴 「テキストファイルに保存」: pkc3-recovery-key.txt に回復キーが入る', async () => {
    const h = harness(view({}, { keyring: 'none' }));
    await startSetup(h);
    h.dq<HTMLButtonElement>('recovery-save')!.click();
    await until(() => saved.length === 1, '保存');
    expect(saved[0]!.name).toBe('pkc3-recovery-key.txt');
    expect(saved[0]!.text).toContain('ABCD-EFGH-JKMN-PQRS-TVWX-YZ01-2345-6789');
    h.dq<HTMLButtonElement>('dialog-cancel')!.click();
    await until(() => h.cancel.mock.calls.length > 0, 'やめる');
  });

  it('🔴 やめる / Esc: 確定を呼ばず、実体の確定前の材料を捨てる(置き場に何も書かない)', async () => {
    const h = harness(view({}, { keyring: 'none' }));
    await startSetup(h);
    h.dq<HTMLButtonElement>('dialog-cancel')!.click();
    await until(() => h.cancel.mock.calls.length === 1, 'やめる');
    expect(h.commit).not.toHaveBeenCalled();
    expect(h.q('[data-pkc-field="sync-e2e-result"]').textContent).toContain('何も書いていません');
    // Esc(dialog の close)
    await startSetup(h);
    h.dialog()!.close();
    await until(() => h.cancel.mock.calls.length === 2, 'Esc');
    expect(h.commit).not.toHaveBeenCalled();
  });

  it('設定を断られたら(置き場に束が在る等)窓を出さず理由を言う', async () => {
    const h = harness(view({}, { keyring: 'none' }), { e2eBeginSetup: vi.fn(async () => ({ kind: 'refused' as const, text: 'この置き場にはもう暗号化キーがあります' })) });
    h.q<HTMLInputElement>('[data-pkc-field="sync-e2e-pass"]').value = PASS;
    h.q<HTMLInputElement>('[data-pkc-field="sync-e2e-pass2"]').value = PASS;
    h.q<HTMLButtonElement>('[data-pkc-action="start-sync-e2e-setup"]').click();
    await until(() => h.q('[data-pkc-field="sync-e2e-result"]').textContent?.includes('もう暗号化キーがあります') === true, '理由');
    expect(h.dialog()?.open ?? false).toBe(false);
  });

  it('開く: パスフレーズ / 回復キーの切り替え / 読んだら欄を空にする / 違えば理由を言う / 「開くたびに入れる」を運ぶ', async () => {
    const h = harness(view({}, { keyring: 'present', ask: true }));
    const ask = h.q<HTMLInputElement>('[data-pkc-field="sync-e2e-ask-unlock"]');
    expect(ask.checked, '開くたびに入れる端末は、開き直しでも初期値がそのまま').toBe(true);
    const secret = h.q<HTMLInputElement>('[data-pkc-field="sync-e2e-unlock-secret"]');
    expect(secret.type).toBe('password');
    const via = h.q<HTMLSelectElement>('[data-pkc-field="sync-e2e-unlock-via"]');
    via.value = 'recovery';
    via.dispatchEvent(new Event('change', { bubbles: true }));
    expect(secret.type, '回復キーは見える字').toBe('text');
    secret.value = 'ABCD-EFGH';
    h.q<HTMLButtonElement>('[data-pkc-action="unlock-sync-e2e"]').click();
    await until(() => h.e2e.e2eUnlock.mock.calls.length === 1, '開く');
    expect(h.e2e.e2eUnlock).toHaveBeenCalledWith({ recoveryKey: 'ABCD-EFGH' }, false);
    expect(secret.value, '読んだら空').toBe('');
    await until(() => h.q('[data-pkc-field="sync-e2e-result"]').textContent === 'パスフレーズまたは回復キーが違います', '理由');
    // 空のまま押したら実体は呼ばない
    h.q<HTMLButtonElement>('[data-pkc-action="unlock-sync-e2e"]').click();
    expect(h.e2e.e2eUnlock).toHaveBeenCalledTimes(1);
    ask.checked = false;
    secret.value = PASS;
    via.value = 'passphrase';
    h.q<HTMLButtonElement>('[data-pkc-action="unlock-sync-e2e"]').click();
    await until(() => h.e2e.e2eUnlock.mock.calls.length === 2, '2 回目');
    expect(h.e2e.e2eUnlock).toHaveBeenLastCalledWith({ passphrase: PASS }, true);
  });

  it('開くたびにパスフレーズを入れる: 切り替えを実体へ(失敗したら戻す)', async () => {
    const h = harness(view({}, { keyring: 'present', open: true, stored: true }), { e2eSetRemember: vi.fn(async () => ({ ok: false, text: '先に開いてください' })) });
    const box = h.q<HTMLInputElement>('[data-pkc-field="sync-e2e-ask"]');
    expect(box.checked).toBe(false);
    box.click();
    await until(() => h.e2e.e2eSetRemember.mock.calls.length === 1, '切り替え');
    expect(h.e2e.e2eSetRemember).toHaveBeenCalledWith(false);
    await until(() => box.checked === false, '失敗したので戻す');
  });

  it('パスフレーズの変更: 新しい 2 欄の検査 / 読んだら全部空 / 実体へ(いまの入力の種類つき)', async () => {
    const h = harness(view({}, { keyring: 'present', open: true, stored: true }));
    const cur = h.q<HTMLInputElement>('[data-pkc-field="sync-e2e-change-current"]');
    const n1 = h.q<HTMLInputElement>('[data-pkc-field="sync-e2e-change-new"]');
    const n2 = h.q<HTMLInputElement>('[data-pkc-field="sync-e2e-change-new2"]');
    const go = () => h.q<HTMLButtonElement>('[data-pkc-action="change-sync-e2e-passphrase"]').click();
    cur.value = PASS;
    n1.value = NEW_PASS;
    n2.value = 'ちがう';
    go();
    expect(h.q('[data-pkc-field="sync-e2e-result"]').textContent).toContain('一致しません');
    expect(h.e2e.e2eChangePassphrase).not.toHaveBeenCalled();
    n2.value = NEW_PASS;
    go();
    await until(() => h.e2e.e2eChangePassphrase.mock.calls.length === 1, '変更');
    expect(h.e2e.e2eChangePassphrase).toHaveBeenCalledWith({ passphrase: PASS }, NEW_PASS);
    expect([cur.value, n1.value, n2.value], '読んだら全部空').toEqual(['', '', '']);
    const via = h.q<HTMLSelectElement>('[data-pkc-field="sync-e2e-change-via"]');
    via.value = 'recovery';
    cur.value = 'ABCD';
    n1.value = NEW_PASS;
    n2.value = NEW_PASS;
    go();
    await until(() => h.e2e.e2eChangePassphrase.mock.calls.length === 2, '回復キーで変更');
    expect(h.e2e.e2eChangePassphrase).toHaveBeenLastCalledWith({ recoveryKey: 'ABCD' }, NEW_PASS);
  });

  it('🔴 暗号化をオフにする: 確認(平文に書き直す・.enc を消す・キーを忘れる)→ やめたら何も起きず、チェックは戻る / 受けたら実体へ', async () => {
    const h = harness(view({}, { keyring: 'present', open: true, stored: true }));
    const box = h.q<HTMLInputElement>('[data-pkc-field="sync-e2e-on"]');
    expect(box.checked).toBe(true);
    box.click();
    await until(() => h.dq('dialog-body') !== null && h.dialog()!.open, '確認');
    expect(h.dq('dialog-body')!.textContent).toBe(SYNC_E2E_OFF_CONFIRM);
    for (const w of ['平文で書き直し', '.enc', '忘れます']) expect(SYNC_E2E_OFF_CONFIRM).toContain(w);
    h.dq<HTMLButtonElement>('dialog-cancel')!.click();
    await until(() => h.dialog()!.open === false, '閉じる');
    expect(h.e2e.setEncrypt).not.toHaveBeenCalled();
    expect(box.checked, 'やめたらチェックは戻る').toBe(true);
    box.click();
    await until(() => h.dialog()!.open, '確認(2 回目)');
    h.dq<HTMLButtonElement>('dialog-ok')!.click();
    await until(() => h.e2e.setEncrypt.mock.calls.length === 1, '実体へ');
    expect(h.e2e.setEncrypt).toHaveBeenCalledWith(false);
  });

  it('🔴 「この端末を受け入れ直す」: 危険の説明つきの確認 → 受けたら実体へ(やめたら何もしない)', async () => {
    const h = harness(view({}, { keyring: 'present', open: true, stored: true, refused: ['aaaaaaaa11112222'] }));
    const b = h.q<HTMLButtonElement>('[data-pkc-action="accept-sync-e2e-peer"]');
    b.click();
    await until(() => h.dialog()?.open === true, '確認');
    expect(h.dq('dialog-body')!.textContent).toBe(SYNC_E2E_ACCEPT_CONFIRM);
    expect(SYNC_E2E_ACCEPT_CONFIRM).toContain('古い内容に戻ります');
    h.dq<HTMLButtonElement>('dialog-cancel')!.click();
    await until(() => h.dialog()!.open === false, '閉じる');
    expect(h.e2e.acceptPeerAgain).not.toHaveBeenCalled();
    b.click();
    await until(() => h.dialog()?.open === true, '確認(2)');
    h.dq<HTMLButtonElement>('dialog-ok')!.click();
    await until(() => h.e2e.acceptPeerAgain.mock.calls.length === 1, '実体へ');
    expect(h.e2e.acceptPeerAgain).toHaveBeenCalledWith('aaaaaaaa11112222');
  });

  it('S3 の接続前のチェックは、接続の欄(encrypt)に運ぶ / 押しても実体は呼ばない', async () => {
    const h = harness(view({ kind: null, folderName: null, phase: 'none' }, { on: false }));
    const connectRemote = vi.fn(async () => true);
    const stop = vi.fn();
    bindActions(h.region, { dispatch: vi.fn(), getState: () => initialState } as unknown as Dispatcher, {
      syncFolder: { pick: vi.fn(), syncNow: vi.fn(), reconnect: vi.fn(), stop, setMinutes: vi.fn(), allowPersist: vi.fn(), connectRemote, e2e: h.e2e },
    });
    const box = h.q<HTMLInputElement>('[data-pkc-field="sync-e2e-on"]');
    box.click(); // 既定オン → オフ
    await tick(20);
    expect(h.e2e.setEncrypt, '接続していないので実体は呼ばない').not.toHaveBeenCalled();
    for (const [k, v] of [['endpoint', 'https://r2.example'], ['bucket', 'b'], ['access-key-id', 'ID'], ['secret', 'SEC']] as const) h.q<HTMLInputElement>(`[data-pkc-field="sync-s3-${k}"]`).value = v;
    h.q<HTMLButtonElement>('[data-pkc-action="connect-sync-s3"]').click();
    await until(() => connectRemote.mock.calls.length >= 1, '接続');
    expect((connectRemote.mock.calls[0] as unknown as [SyncRemoteForm])[0].encrypt).toBe(false);
  });
});

// ───────────── 実体に通す(作り物の S3 + 本物の SyncFolder / SyncE2E / SyncKeystore)+ 秘密が残らない ─────────────

class MemStore implements SyncFolderStore {
  map = new Map<string, SyncFolderSaved>();
  async load(cid: string) {
    return (this.map.get(cid) as SyncFolderSaved | undefined) ?? null;
  }
  async save(cid: string, v: SyncFolderSaved) {
    this.map.set(cid, { ...structuredClone({ ...v, handle: null }), handle: v.handle });
  }
  async remove(cid: string) {
    this.map.delete(cid);
  }
  private marks = new Map<string, string | null>();
  async getMark(k: string) {
    return this.marks.get(k) ?? null;
  }
  async setMark(k: string, v: string | null) {
    this.marks.set(k, v);
  }
}

describe('🔴 画面から実体へ通す + 秘密が画面・保存・メッセージ・置き場のどこにも残らない', () => {
  it('設定(回復キーの打ち直し)→ 開く(回復キー)→ 開くたびに入れる → 変更 → オフ、を作り物の S3 で通し、最後に秘密を探す', async () => {
    const stored: string[] = [];
    const store = (): Storage => ({ setItem: (k: string, v: string) => void stored.push(`${k}=${v}`), getItem: () => null, removeItem: () => undefined, clear: () => undefined, key: () => null, length: 0 }) as Storage;
    vi.stubGlobal('localStorage', store());
    vi.stubGlobal('sessionStorage', store());
    const logged: string[] = [];
    for (const m of ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logged.push(a.map((x) => (x instanceof Error ? `${x.name}: ${x.message}\n${x.stack ?? ''}` : typeof x === 'string' ? x : JSON.stringify(x))).join(' ')));
    const issued: Uint8Array[] = [];
    const c = {
      subtle: webcrypto.subtle as SubtleCrypto,
      random: (n: number) => {
        const a = webcrypto.getRandomValues(new Uint8Array(n));
        issued.push(new Uint8Array(a));
        return a;
      },
    };

    const s3 = fakeS3(SECRET);
    // 端末 2 台(UI を通すのは 1 台目 / 2 台目は実体の口で回復キーを通す)
    const mk = (cid: string) => {
      const ks = new SyncKeystore(memKeystoreBackend());
      const e2e = new SyncE2E({
        crypto: c,
        keys: {
          load: async (id) => {
            const v = await ks.openDataKey(id);
            return v === null ? null : { keyId: v.keyId, key: v.key };
          },
          save: (id, v) => ks.saveDataKey(id, v),
          remove: (id) => ks.removeDataKey(id),
        },
      });
      const says: string[] = [];
      const fails: string[] = [];
      const st = new MemStore();
      const sf = new SyncFolder({
        cid: () => cid,
        enabled: () => true,
        picker: null,
        remote: {
          unavailable: () => null,
          open: (id) => ks.open(id),
          save: (id, cfg, sec) => ks.save(id, cfg, sec),
          remove: (id) => ks.remove(id),
          box: (config, secret) => new S3Box({ config, secret, crypto: webSigCrypto(), fetch: s3.fetch }),
        },
        e2e,
        store: st,
        lock: null,
        device: async () => (cid === 'c1' ? 'a1b2c3d4e5f60718' : '0f1e2d3c4b5a6978'),
        build: async () => ({ skipped: true as const, key: '' }),
        apply: async () => {
          throw new Error('取り込まない');
        },
        say: (t) => void says.push(t),
        fail: (t) => void fails.push(t),
        onChange: () => section.sync(initialState),
        setTimer: () => 0,
        clearTimer: () => undefined,
      });
      return { ks, sf, says, fails, st, e2e };
    };
    const A = mk('c1');
    const B = mk('c2');
    const region = document.createElement('div');
    document.body.replaceChildren(region);
    const source = new SyncFolderViewSource();
    source.attach(() => A.sf.view());
    appSyncFolderView.attach(() => A.sf.view());
    const en = new SyncEnabledStore(null);
    en.setEnabled(true);
    const section = createSyncS3Section(region, source, en, { origin: () => 'https://n.example.org', hostname: () => 'n.example.org' });
    const dl = document.createElement('dl');
    dl.append(...(section.build() as Node[]));
    region.append(dl);
    section.sync(initialState);
    bindActions(region, { dispatch: vi.fn(), getState: () => initialState } as unknown as Dispatcher, {
      syncFolder: {
        pick: vi.fn(),
        syncNow: () => A.sf.syncNow(true),
        reconnect: vi.fn(),
        stop: () => A.sf.stop(),
        setMinutes: vi.fn(),
        allowPersist: vi.fn(),
        testRemote: (f) => A.sf.testRemote(f),
        connectRemote: (f) => A.sf.connectRemote(f),
        e2e: {
          setEncrypt: (on) => A.sf.setEncrypt(on),
          e2eBeginSetup: (p, r) => A.sf.e2eBeginSetup(p, r),
          e2eUnlock: (v, r) => A.sf.e2eUnlock(v, r),
          e2eSetRemember: (r) => A.sf.e2eSetRemember(r),
          e2eChangePassphrase: (v, n) => A.sf.e2eChangePassphrase(v, n),
          acceptPeerAgain: (d) => A.sf.acceptPeerAgain(d),
        },
      },
    });
    const q = <T extends HTMLElement>(sel: string) => region.querySelector<T>(sel)!;
    const result = () => q('[data-pkc-field="sync-e2e-result"]').textContent ?? '';
    const dlg = () => document.querySelector<HTMLDialogElement>('[data-pkc-region="app-dialog"]');
    const dq = <T extends HTMLElement>(n: string) => dlg()?.querySelector<T>(`[data-pkc-field="${n}"]`) ?? null;
    const fill = (k: string, v: string) => void (q<HTMLInputElement>(`[data-pkc-field="sync-s3-${k}"]`).value = v);

    // 接続(暗号化は既定オン)→ 設定の欄が出る
    fill('endpoint', 'https://s3.example.test');
    fill('bucket', 'my notes');
    fill('prefix', 'pkc3');
    fill('access-key-id', SECRET.accessKeyId);
    fill('secret', SECRET.secretAccessKey);
    q<HTMLButtonElement>('[data-pkc-action="connect-sync-s3"]').click();
    await until(() => A.sf.view().kind === 's3' && A.sf.view().e2e.keyring === 'none', '接続');
    await until(() => !q('[data-pkc-field="sync-e2e-setup"]').hidden, '設定の欄が出る');
    expect(q<HTMLInputElement>('[data-pkc-field="sync-e2e-on"]').checked).toBe(true);
    expect([...s3.objects.keys()], '設定の前: 置き場には何も無い(平文も)').toEqual([]);

    // 設定 → 回復キーを打ち直す(わざと 1 度まちがえる)
    q<HTMLInputElement>('[data-pkc-field="sync-e2e-pass"]').value = PASS;
    q<HTMLInputElement>('[data-pkc-field="sync-e2e-pass2"]').value = PASS;
    q<HTMLButtonElement>('[data-pkc-action="start-sync-e2e-setup"]').click();
    await until(() => dq('recovery-key') !== null, '回復キーの窓');
    const recovery = dq('recovery-key')!.textContent ?? '';
    expect(recovery).toMatch(/^([0-9A-Z]{4}-){7}[0-9A-Z]{4}$/);
    expect([...s3.objects.keys()], '確定の前: まだ何も書いていない').toEqual([]);
    const typed = dq<HTMLInputElement>('recovery-retype')!;
    typed.value = recovery.replace(/.$/, (ch) => (ch === '0' ? '1' : '0'));
    typed.dispatchEvent(new Event('input'));
    expect(dq<HTMLButtonElement>('dialog-ok')!.disabled).toBe(true);
    typed.value = recovery.toLowerCase().replace(/-/g, '');
    typed.dispatchEvent(new Event('input'));
    dq<HTMLButtonElement>('dialog-ok')!.click();
    await until(() => A.sf.view().e2e.open, '確定');
    await until(() => A.sf.view().phase === 'idle', '同期が回る');
    expect(s3.objects.has('pkc3/keyring.json')).toBe(true);
    expect(result()).toContain('暗号化キーを作りました');
    await until(() => !q('[data-pkc-field="sync-e2e-open"]').hidden, '開いている欄に切り替わる');
    for (const n of ['sync-e2e-pass', 'sync-e2e-pass2']) expect(q<HTMLInputElement>(`[data-pkc-field="${n}"]`).value).toBe('');

    // 2 台目(実体の口)── 回復キーで開く
    await B.sf.connectRemote({ endpoint: 'https://s3.example.test', bucket: 'my notes', region: '', prefix: 'pkc3', accessKeyId: SECRET.accessKeyId, secretAccessKey: SECRET.secretAccessKey });
    expect((await B.sf.e2eUnlock({ recoveryKey: recovery }, false)).ok).toBe(true);

    // 開くたびに入れる → 変更(いまの入力 = 回復キー)
    q<HTMLInputElement>('[data-pkc-field="sync-e2e-ask"]').click();
    await until(() => A.sf.view().e2e.ask && !A.sf.view().e2e.stored, '開くたびに入れる(端末のキーが消える)');
    expect(await A.ks.openDataKey('c1')).toBeNull();
    const det = q<HTMLDetailsElement>('[data-pkc-field="sync-e2e-change"]');
    det.open = true;
    q<HTMLSelectElement>('[data-pkc-field="sync-e2e-change-via"]').value = 'recovery';
    q<HTMLInputElement>('[data-pkc-field="sync-e2e-change-current"]').value = recovery;
    q<HTMLInputElement>('[data-pkc-field="sync-e2e-change-new"]').value = NEW_PASS;
    q<HTMLInputElement>('[data-pkc-field="sync-e2e-change-new2"]').value = NEW_PASS;
    q<HTMLButtonElement>('[data-pkc-action="change-sync-e2e-passphrase"]').click();
    await until(() => result().includes('パスフレーズを変えました'), '変更');
    expect((await B.sf.e2eUnlock({ passphrase: NEW_PASS }, false)).ok, '新しいパスフレーズで開く').toBe(true);

    // オフ(確認 → 受ける)
    q<HTMLInputElement>('[data-pkc-field="sync-e2e-on"]').click();
    await until(() => dlg()?.open === true, 'オフの確認');
    dq<HTMLButtonElement>('dialog-ok')!.click();
    await until(() => !A.sf.view().e2e.on, 'オフ');
    await until(() => dlg()?.open !== true, '確認が閉じる');

    // ── 探す ──
    const needles: { label: string; bytes: Buffer }[] = [];
    const add = (label: string, s: string): void => void needles.push({ label, bytes: Buffer.from(s) });
    add('パスフレーズ', PASS);
    add('新しいパスフレーズ', NEW_PASS);
    for (const [lab, r] of [['回復キー', recovery], ['回復キー(ハイフン無し)', recovery.replace(/-/g, '')], ['回復キー(小文字)', recovery.toLowerCase()]] as const) add(lab, r);
    const raw32 = issued.filter((x) => x.length === 32);
    expect(raw32.length, '空振り防止: 生のデータ鍵を控えている').toBeGreaterThan(0);
    for (const r of raw32) {
      const b = Buffer.from(r);
      needles.push({ label: '生のデータ鍵', bytes: b }, { label: '生のデータ鍵(hex)', bytes: Buffer.from(b.toString('hex')) }, { label: '生のデータ鍵(base64)', bytes: Buffer.from(b.toString('base64')) }, { label: '生のデータ鍵(base64url)', bytes: Buffer.from(b.toString('base64url')) });
    }
    const leaks = (hay: string | Uint8Array): string[] => {
      const h = Buffer.from(hay);
      return needles.filter((n) => h.includes(n.bytes)).map((n) => n.label);
    };
    expect(leaks(`x ${recovery} y`), '探索自体が効く(対照群)').toContain('回復キー');
    expect(leaks(`x ${PASS} y`)).toContain('パスフレーズ');

    const inputs = [...document.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input,select')].map((e) => e.value).join('\n');
    const hay: [string, string | Uint8Array][] = [
      ['画面の字', document.body.textContent ?? ''],
      ['画面の欄の値(閉じたあと)', inputs],
      ['画面の HTML', document.body.innerHTML],
      ['メッセージ', [...A.says, ...A.fails, ...B.says, ...B.fails].join('\n')],
      ['画面の姿', JSON.stringify([A.sf.view(), B.sf.view()])],
      ['同期の記録', JSON.stringify([...A.st.map.entries(), ...B.st.map.entries()])],
      ['localStorage / sessionStorage', stored.join('\n')],
      ['設定ファイル', JSON.stringify(buildSettingsFile((k) => (globalThis.localStorage as Storage).getItem(k)))],
      ['console', logged.join('\n')],
      ['保存した回復キーのファイル(保存していない = 空)', saved.map((s) => s.text).join('\n')],
    ];
    for (const [key, o] of s3.objects) hay.push([`置き場 ${key}`, o.body]);
    expect(hay.find(([k]) => k.startsWith('画面の字'))![1].toString().length, '空振り防止: 画面に字が在る').toBeGreaterThan(100);
    for (const [where, text] of hay) expect(leaks(text), `${where} に秘密が残っている`).toEqual([]);
    vi.unstubAllGlobals();
  });
});
