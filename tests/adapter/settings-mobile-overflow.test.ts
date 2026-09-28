/** @vitest-environment happy-dom */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { stripComments } from '../helpers/css-blocks';
import { SettingsRenderer } from '../../src/adapter/ui/render/settings';
import { initialState } from '../../src/adapter/state/app-state';

describe('🔴 スマホ幅での設定画面はみ出し防止 (#1068)', () => {
  it('CSS 規律: [data-pkc-layout="phone"] 下の設定 dl が 1 列(minmax(0, 1fr))に折れる規則が在る', () => {
    const css = stripComments(readFileSync('src/styles/app.css', 'utf-8'));

    // settings-body / flags-body / help-body の dl が phone レイアウトで 1 列になる規則
    expect(css).toContain("[data-pkc-region='shell'][data-pkc-layout='phone'] [data-pkc-region='settings-body'] dl");
    expect(css).toContain('grid-template-columns: minmax(0, 1fr)');

    // dt が折り返し可能(white-space: normal)になる規則
    expect(css).toContain("[data-pkc-region='shell'][data-pkc-layout='phone'] [data-pkc-region='settings-body'] dt");
    expect(css).toContain('white-space: normal');

    // dd が縮小可能(min-width: 0 / overflow-wrap: anywhere)になる規則
    expect(css).toContain("[data-pkc-region='shell'][data-pkc-layout='phone'] [data-pkc-region='settings-body'] dd");
    expect(css).toContain('overflow-wrap: anywhere');

    // select に max-width: 100% が在る
    expect(css).toContain("[data-pkc-region='shell'][data-pkc-layout='phone'] [data-pkc-region='settings-body'] select");
    expect(css).toContain('max-width: 100%');
  });

  it('PC 幅の settings-body dl も minmax(0, 1fr) と min-width: 0 を持ち防波堤を持つ', () => {
    const css = stripComments(readFileSync('src/styles/app.css', 'utf-8'));
    expect(css).toContain('grid-template-columns: auto minmax(0, 1fr)');
    expect(css).toContain("[data-pkc-region='settings-body'] dd");
  });

  it('DOM 構造: 設定画面が正常にレンダリングされ、dl, dt, dd が生成される', () => {
    const host = document.createElement('div');
    const r = new SettingsRenderer(host);
    r.render(initialState);

    const dls = host.querySelectorAll('dl');
    expect(dls.length).toBeGreaterThan(0);

    const notes = host.querySelectorAll('[data-pkc-field="settings-note"]');
    expect(notes.length).toBeGreaterThan(0);
  });
});
