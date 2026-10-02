/** @vitest-environment happy-dom */
/**
 * システムの「音声認識」の節(#772 段②)。
 *
 * 守りたい主張:
 *  ① 🔴 **ボタンの字は大きさと 1 行の説明つき**で、数は定数から出る
 *  ② 🔴 **メモリの案内は「ボタンの下」に、押す前に出る**。ボタンは押せるまま
 *     (`deviceMemory` が読める端末だけ。読めなければ何も出さない)
 *  ③ 状態で出る物が切り替わる(まだ / 取り込み済み / 取り込み中)
 *  ④ 器は 1 度だけ組み、字と hidden だけ差し替える(押している最中のボタンを作り直さない)
 *  ⑤ 押し所が binder を通って実体まで届く / 設定の面の「保存領域」に実際に載っている
 *  ⑥ 🔴 案内の字(「システム → 音声認識」)が、画面に実在する名前と一致する
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  applyAsrResult,
  asrInstalledText,
  AsrPackState,
  buildAsrPackPanel,
} from '../../src/adapter/ui/render/asr-pack-panel';
import { SettingsRenderer } from '../../src/adapter/ui/render/settings';
import { JobMonitor } from '../../src/adapter/platform/job-monitor';
import { bindActions, type BinderServices } from '../../src/adapter/ui/actions/binder';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { initialState, viewModeLabel } from '../../src/adapter/state/app-state';
import { ASR_PARTS, asrMemoryNote, asrPartLabel } from '../../src/features/asr/asr-parts';
import { ASR_SECTION_LABEL } from '../../src/features/asr/asr-text';
import { asrMissingText } from '../../src/adapter/ui/actions/capture-transcribe';
import type { AsrInstalled } from '../../src/adapter/platform/asr/asr-pack-store';

const light = ASR_PARTS[0]!;
const accurate = ASR_PARTS[1]!;

const group = (bytes = 100_000_000) => ({
  version: 'v1',
  installedAt: new Date(2026, 9, 2).getTime(),
  totalBytes: bytes,
  files: [],
});
const INSTALLED_LIGHT: AsrInstalled = { runtime: group(), parts: { light: group(97_000_000) } };

const row = (root: HTMLElement, id: string): HTMLElement =>
  root.querySelector<HTMLElement>(`[data-pkc-field="asr-part"][data-pkc-part="${id}"]`)!;
const q = <T extends HTMLElement>(el: HTMLElement, field: string): T =>
  el.querySelector<T>(`[data-pkc-field="${field}"]`)!;

describe('部品 2 択の見え方', () => {
  it('🔴 ① ボタンは 2 つで、字は定数から出る(大きさ・秒つき)', () => {
    const p = buildAsrPackPanel(new AsrPackState(), { deviceMemory: () => undefined });
    expect(p.root.querySelector('h4')?.textContent).toBe(ASR_SECTION_LABEL);
    for (const part of ASR_PARTS) {
      const b = q<HTMLButtonElement>(row(p.root, part.id), 'asr-install');
      expect(b.textContent).toBe(asrPartLabel(part));
      expect(b.getAttribute('data-pkc-action')).toBe('install-asr-part');
      expect(b.getAttribute('data-pkc-part')).toBe(part.id);
      expect(b.hidden).toBe(false);
      expect(b.disabled).toBe(false);
    }
  });

  it('🔴 ② メモリが足りない見込みの端末では、案内がボタンの「下」に出て、ボタンは押せるまま', () => {
    const p = buildAsrPackPanel(new AsrPackState(), { deviceMemory: () => 2 });
    document.body.append(p.root);
    // 軽いほう(必要 4GB)も重いほう(必要 8GB)も、2GB の端末では足りない
    for (const part of ASR_PARTS) {
      const r = row(p.root, part.id);
      const note = q(r, 'asr-memory-note');
      const b = q<HTMLButtonElement>(r, 'asr-install');
      expect(note.hidden).toBe(false);
      expect(note.textContent).toBe(asrMemoryNote(part, 2));
      expect(note.textContent).toContain('2 GB');
      // 「下」= 文書の順でボタンの後ろ
      expect(b.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING, '案内がボタンの上に出ている').toBeTruthy();
      expect(b.disabled, '案内が出た端末でボタンを塞いだ').toBe(false);
      expect(b.hidden).toBe(false);
    }
  });

  it('🔴 ② 足りる端末・読めない端末では、案内を出さない(空の行も置かない)', () => {
    // 軽い = 4GB で足りて、重い = 8GB では足りない境目の端末
    const mid = buildAsrPackPanel(new AsrPackState(), { deviceMemory: () => light.needMemoryGb });
    expect(q(row(mid.root, 'light'), 'asr-memory-note').hidden).toBe(true);
    expect(q(row(mid.root, 'accurate'), 'asr-memory-note').hidden).toBe(false);
    const big = buildAsrPackPanel(new AsrPackState(), { deviceMemory: () => accurate.needMemoryGb });
    for (const part of ASR_PARTS) expect(q(row(big.root, part.id), 'asr-memory-note').hidden).toBe(true);
    // 読めない(Firefox / Safari)
    const unknown = buildAsrPackPanel(new AsrPackState(), { deviceMemory: () => undefined });
    for (const part of ASR_PARTS) {
      expect(q(row(unknown.root, part.id), 'asr-memory-note').hidden).toBe(true);
      expect(q(row(unknown.root, part.id), 'asr-memory-note').textContent).toBe('');
    }
  });

  it('🔴 ② 既定は navigator.deviceMemory を読む(差し替えなければ実際の値)', () => {
    vi.stubGlobal('navigator', { ...navigator, deviceMemory: 1 });
    try {
      const p = buildAsrPackPanel(new AsrPackState());
      expect(q(row(p.root, 'light'), 'asr-memory-note').textContent).toContain('1 GB');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('状態で切り替わる', () => {
  it('③ 取り込み済み:取り込むボタンは隠れ、「取り込み済み」と消すボタンが出る(案内は出さない)', () => {
    const s = new AsrPackState();
    const p = buildAsrPackPanel(s, { deviceMemory: () => 1 });
    s.setInstalled(INSTALLED_LIGHT);
    const r = row(p.root, 'light');
    expect(q(r, 'asr-install').hidden).toBe(true);
    expect(q(r, 'asr-installed').hidden).toBe(false);
    expect(q(r, 'asr-installed').textContent).toBe(asrInstalledText(light, INSTALLED_LIGHT));
    expect(q(r, 'asr-installed').textContent).toContain('取り込み済み');
    expect(q(r, 'asr-installed').textContent).toContain('2026-10-02');
    const rm = q<HTMLButtonElement>(r, 'asr-remove');
    expect(rm.hidden).toBe(false);
    expect(rm.textContent).toBe(`${light.label}を消す`);
    expect(rm.getAttribute('data-pkc-part')).toBe('light');
    // 入れた後にメモリの案内を出さない(もう押す前ではない)
    expect(q(r, 'asr-memory-note').hidden).toBe(true);
    // もう一方は影響を受けない
    const other = row(p.root, 'accurate');
    expect(q(other, 'asr-install').hidden).toBe(false);
    expect(q(other, 'asr-remove').hidden).toBe(true);
    expect(q(other, 'asr-installed').hidden).toBe(true);
  });

  it('消えたら元へ戻る(双方向 ── 入れたら外せる / 外したら入れ直せる)', () => {
    const s = new AsrPackState();
    const p = buildAsrPackPanel(s, { deviceMemory: () => undefined });
    s.setInstalled(INSTALLED_LIGHT);
    s.setInstalled({ runtime: null, parts: {} });
    const r = row(p.root, 'light');
    expect(q(r, 'asr-install').hidden).toBe(false);
    expect(q(r, 'asr-remove').hidden).toBe(true);
    expect(q(r, 'asr-installed').textContent).toBe('');
  });

  it('🔴 取り込み中:進みの 1 行と「取り込みをやめる」が出て、2 択とも押せない。終わったら戻る', () => {
    const s = new AsrPackState();
    const p = buildAsrPackPanel(s, { deviceMemory: () => undefined });
    const progress = q(p.root, 'asr-progress');
    const cancel = q<HTMLButtonElement>(p.root, 'asr-cancel');
    expect(progress.hidden).toBe(true);
    expect(cancel.hidden).toBe(true);
    s.setProgress('取り込み中 42%');
    expect(progress.hidden).toBe(false);
    expect(progress.textContent).toBe('取り込み中 42%');
    expect(cancel.hidden, 'やめる道が無い').toBe(false);
    expect(cancel.getAttribute('data-pkc-action')).toBe('cancel-asr-install');
    for (const part of ASR_PARTS) {
      expect(q<HTMLButtonElement>(row(p.root, part.id), 'asr-install').disabled).toBe(true);
    }
    s.setProgress('');
    expect(progress.hidden).toBe(true);
    expect(cancel.hidden).toBe(true);
    for (const part of ASR_PARTS) {
      expect(q<HTMLButtonElement>(row(p.root, part.id), 'asr-install').disabled).toBe(false);
    }
  });

  it('🔴 ④ 器は組み直さない ── 同じボタンの要素のまま字と hidden だけが変わる', () => {
    const s = new AsrPackState();
    const p = buildAsrPackPanel(s, { deviceMemory: () => undefined });
    const before = q(row(p.root, 'light'), 'asr-install');
    s.setProgress('取り込み中 1%');
    s.setInstalled(INSTALLED_LIGHT);
    s.setProgress('');
    expect(q(row(p.root, 'light'), 'asr-install'), '押している最中のボタンが作り直された').toBe(before);
  });

  it('dispose で購読を切る(切った後の変化を拾わない)', () => {
    const s = new AsrPackState();
    const p = buildAsrPackPanel(s, { deviceMemory: () => undefined });
    p.dispose();
    s.setProgress('取り込み中 1%');
    expect(q(p.root, 'asr-progress').hidden, '切ったのに追いかけた').toBe(true);
  });
});

describe('後始末(applyAsrResult)', () => {
  it('🔴 成功したときだけ控えを書き換え、成否によらず必ず何か言う', () => {
    const s = new AsrPackState();
    const notify = vi.fn();
    applyAsrResult(s, { ok: false, message: '取得できません' }, { notify });
    expect(s.getInstalled(), '失敗なのに「入った」ことになった').toEqual({ runtime: null, parts: {} });
    expect(notify).toHaveBeenCalledWith('取得できません');
    applyAsrResult(s, { ok: true, installed: INSTALLED_LIGHT, message: '取り込みました' }, { notify });
    expect(s.isPartInstalled('light')).toBe(true);
    expect(s.isPartInstalled('accurate')).toBe(false);
    expect(notify).toHaveBeenLastCalledWith('取り込みました');
  });
});

describe('⑤ 押し所が実体まで届く', () => {
  function harness() {
    const root = document.createElement('div');
    document.body.append(root);
    const services: BinderServices = {
      installAsrPart: vi.fn(),
      cancelAsrInstall: vi.fn(),
      removeAsrPart: vi.fn(),
    };
    bindActions(root, new Dispatcher(), services);
    const s = new AsrPackState();
    const panel = buildAsrPackPanel(s, { deviceMemory: () => undefined });
    root.append(panel.root);
    return { services, panel, s };
  }
  const click = (el: Element): void => void el.dispatchEvent(new Event('click', { bubbles: true }));

  it('🔴 取り込むは、押したボタンの部品の id を運ぶ(2 択で取り違えない)', () => {
    const { services, panel } = harness();
    click(q(row(panel.root, 'accurate'), 'asr-install'));
    expect(services.installAsrPart).toHaveBeenCalledTimes(1);
    expect(services.installAsrPart).toHaveBeenCalledWith('accurate');
    click(q(row(panel.root, 'light'), 'asr-install'));
    expect(services.installAsrPart).toHaveBeenLastCalledWith('light');
  });

  it('🔴 やめる / 消すが届く', () => {
    const { services, panel, s } = harness();
    s.setProgress('取り込み中 5%');
    click(q(panel.root, 'asr-cancel'));
    expect(services.cancelAsrInstall).toHaveBeenCalledTimes(1);
    s.setProgress('');
    s.setInstalled(INSTALLED_LIGHT);
    click(q(row(panel.root, 'light'), 'asr-remove'));
    expect(services.removeAsrPart).toHaveBeenCalledWith('light');
  });
});

describe('⑤ 設定の面(システム)に実際に載っている', () => {
  it('🔴 「保存領域」の中に節が出て、「表示」の節には混ざらない', () => {
    const region = document.createElement('div');
    document.body.append(region);
    new SettingsRenderer(region, new JobMonitor()).render(initialState);
    const section = region.querySelector('[data-pkc-region="settings-asr"]');
    expect(section, 'システムに音声認識の節が無い').not.toBeNull();
    for (const a of ['install-asr-part']) {
      expect(section!.querySelectorAll(`[data-pkc-action="${a}"]`).length).toBe(ASR_PARTS.length);
    }
    // 「この端末に部品を置くかどうか」= 保存領域の判断(Office 表示と同じ階)
    expect(section!.closest('[data-pkc-region="settings-storage"]')).not.toBeNull();
    expect(section!.closest('[data-pkc-region="settings-user"]')).toBeNull();
    // 目次(h3 を走査して作る)に入れ子の節名が増えていない = h3 を足していない
    expect(section!.querySelector('h3')).toBeNull();
  });

  /**
   * 🔴 **案内の字が、画面に実在する名前を指している**(#996 の作法 ── 手で書かず、描かせて引く)。
   * 「システム → 音声認識 で取り込んでください」の 2 語が、実際に描かれる面の名前と同じ。
   */
  it('🔴 ⑥ 案内の「システム」「音声認識」は、描かれる面の見出しと同じ字', () => {
    const region = document.createElement('div');
    document.body.append(region);
    new SettingsRenderer(region, new JobMonitor()).render(initialState);
    const title = region.querySelector('[data-pkc-field="pane-title"]')?.textContent;
    const head = region.querySelector('[data-pkc-region="settings-asr"] h4')?.textContent;
    expect(title, '面の見出しが、案内が言う入口の名前と違う').toBe(viewModeLabel('settings'));
    expect(head, '節の見出しが、案内が言う名前と違う').toBe(ASR_SECTION_LABEL);
    expect(asrMissingText()).toContain(`${title} → ${head}`);
  });
});

describe('main.ts の配線(原文 pin。弱い検査だと自覚して使う)', () => {
  const MAIN = readFileSync('src/main.ts', 'utf-8');

  it('🔴 4 つの口が実体へ配線され、進みと後始末は控えへ繋がっている', () => {
    for (const name of ['transcribeCapture:', 'installAsrPart:', 'cancelAsrInstall:', 'removeAsrPart:']) {
      expect(MAIN, `${name} が配線されていない(押しても無言)`).toContain(name);
    }
    expect(MAIN, '進みを画面へ流していない').toContain('appAsrPack.setProgress(');
    expect(MAIN, '後始末は取り出した判断を通る').toContain('applyAsrResult(');
    expect(MAIN, '起動時に入っている部品を控えへ写していない').toContain('appAsrPack.setInstalled(');
  });

  it('🔴 取り先は定数(ASR_PACK_BASE)から渡す(main に綴りを書かない)', () => {
    expect(MAIN).toContain('base: ASR_PACK_BASE');
  });
});

