/** @vitest-environment happy-dom */
/**
 * システムの「音源分離」の節(#674 / #949。レビュー裁定: 取り込んで残し、設定から消せる ── 片道にしない)。
 *
 * 守りたい主張:
 *  ① 状態で出る物が切り替わる(まだ: 取り込む / 入っている: 取り込み済み + 消す / 取得中: 進み + やめる)
 *  ② 器は 1 度だけ組み、字と hidden だけ差し替える(押している最中のボタンを作り直さない)
 *  ③ 🔴 押し所が binder を通って実体まで届く(取り込む・やめる・消す)
 *  ④ 設定の面の「保存領域」の中に実際に載っている
 *  ⑤ main.ts の配線(原文 pin。弱い検査だと自覚して使う)
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  applyStemResult,
  buildStemModelPanel,
  StemModelState,
  stemInstalledText,
  STEM_SECTION_LABEL,
} from '../../src/adapter/ui/render/stem-model-panel';
import { SettingsRenderer } from '../../src/adapter/ui/render/settings';
import { JobMonitor } from '../../src/adapter/platform/job-monitor';
import { bindActions, type BinderServices } from '../../src/adapter/ui/actions/binder';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { initialState } from '../../src/adapter/state/app-state';
import { STEM_MODELS } from '../../src/features/audio/stem-model';

const model = STEM_MODELS[0]!;
const INSTALLED = { [model.id]: { bytes: 66_000_000, url: 'https://huggingface.co/x/m.onnx', installedAt: new Date(2026, 9, 29).getTime() } };

const q = <T extends HTMLElement>(el: HTMLElement, field: string): T => el.querySelector<T>(`[data-pkc-field="${field}"]`)!;

describe('見え方', () => {
  it('① まだ: 取り込むボタンだけ(大きさは目録から)/ 入っている: 取り込み済み(大きさ・日付・取得元)+ 消す / 取得中: 進み + やめる', () => {
    const s = new StemModelState();
    const p = buildStemModelPanel(s);
    expect(p.root.querySelector('h4')?.textContent).toBe(STEM_SECTION_LABEL);
    const install = q<HTMLButtonElement>(p.root, 'stem-install');
    expect(install.hidden).toBe(false);
    expect(install.textContent).toContain(model.label);
    expect(install.textContent).toMatch(/\d+(\.\d)? MB/);
    expect(q(p.root, 'stem-remove').hidden).toBe(true);
    expect(q(p.root, 'stem-installed').hidden).toBe(true);
    expect(q(p.root, 'stem-cancel').hidden).toBe(true);

    s.setInstalled(INSTALLED);
    expect(install.hidden, '入っているのに取り込むが残る').toBe(true);
    expect(q(p.root, 'stem-remove').hidden).toBe(false);
    const text = q(p.root, 'stem-installed').textContent;
    expect(text).toContain('取り込み済み');
    expect(text).toContain('2026-10-29');
    expect(text).toContain('huggingface.co');
    expect(text).toBe(stemInstalledText(model, INSTALLED));

    s.setInstalled({});
    s.setProgress('huggingface.co から取得しています… 5%');
    expect(q(p.root, 'stem-progress').hidden).toBe(false);
    expect(q(p.root, 'stem-cancel').hidden).toBe(false);
    expect(install.disabled, '取得中に取り込むが押せる').toBe(true);
    expect(q<HTMLButtonElement>(p.root, 'stem-remove').disabled).toBe(true);
  });

  it('② 器は組み直さない(同じボタン要素のまま字と hidden だけ替わる)', () => {
    const s = new StemModelState();
    const p = buildStemModelPanel(s);
    const install = q(p.root, 'stem-install');
    s.setInstalled(INSTALLED);
    s.setInstalled({});
    expect(q(p.root, 'stem-install')).toBe(install);
  });

  it('applyStemResult: 成功したときだけ控えを書き換え、成否によらず何か言う', () => {
    const s = new StemModelState();
    const notify = vi.fn();
    applyStemResult(s, { ok: false, message: 'だめ' }, { notify });
    expect(s.isInstalled(model.id)).toBe(false);
    expect(notify).toHaveBeenLastCalledWith('だめ');
    applyStemResult(s, { ok: true, installed: INSTALLED, message: 'ok' }, { notify });
    expect(s.isInstalled(model.id)).toBe(true);
  });
});

describe('③ 押し所が実体まで届く', () => {
  it('🔴 取り込む(モデルの id を運ぶ)/ やめる / 消す(両方向がある)', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const services: BinderServices = { installStemModel: vi.fn(), cancelStemInstall: vi.fn(), removeStemModel: vi.fn() };
    bindActions(root, new Dispatcher(), services);
    const s = new StemModelState();
    const p = buildStemModelPanel(s);
    root.append(p.root);
    const click = (el: Element): void => void el.dispatchEvent(new Event('click', { bubbles: true }));
    click(q(p.root, 'stem-install'));
    expect(services.installStemModel).toHaveBeenCalledWith(model.id);
    s.setProgress('取得中');
    click(q(p.root, 'stem-cancel'));
    expect(services.cancelStemInstall).toHaveBeenCalledTimes(1);
    s.setProgress('');
    s.setInstalled(INSTALLED);
    click(q(p.root, 'stem-remove'));
    expect(services.removeStemModel).toHaveBeenCalledWith(model.id);
  });
});

describe('④ 設定の面に実際に載っている', () => {
  it('🔴 「保存領域」の中に節が出る(音声認識の隣)', () => {
    const region = document.createElement('div');
    document.body.append(region);
    new SettingsRenderer(region, new JobMonitor()).render(initialState);
    const section = region.querySelector('[data-pkc-region="settings-stem"]');
    expect(section).not.toBeNull();
    expect(section!.closest('[data-pkc-region="settings-storage"]')).not.toBeNull();
    expect(section!.previousElementSibling?.getAttribute('data-pkc-region')).toBe('settings-asr');
    expect(section!.querySelector('h4')?.textContent).toBe(STEM_SECTION_LABEL);
  });
});

describe('⑤ main.ts の配線(原文 pin)', () => {
  const MAIN = readFileSync('src/main.ts', 'utf-8');
  it('🔴 3 つの口が配線され、控えと後始末は判断を通る。起動時に入っているモデルを控えへ写す', () => {
    for (const name of ['installStemModel:', 'cancelStemInstall:', 'removeStemModel:']) {
      expect(MAIN, `${name} が配線されていない(押しても無言)`).toContain(name);
    }
    expect(MAIN).toContain('appStemModel.setProgress(');
    expect(MAIN).toContain('applyStemResult(');
    expect(MAIN).toContain('appStemModel.setInstalled(');
    expect(MAIN, '録音から押したときも同じ installer を通る').toContain('stemInstaller.obtain(');
    expect(MAIN, '録音から取り込んだ回も控えへ写す').toMatch(/!r\.fromStore\) void stemInstaller\.readInstalled\(stemIds\)/);
  });
});
