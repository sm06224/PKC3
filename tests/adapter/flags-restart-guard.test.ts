/** @vitest-environment happy-dom */
/**
 * 🔴 **フラグの再読み込みは、編集中なら確かめてから**(#1087)。
 * 更新のカードは打ちかけを守るのに、フラグの切り替えだけ確かめずに読み込み直していた。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { FlagsRenderer } from '../../src/adapter/ui/render/flags';
import { FlagStore } from '../../src/adapter/platform/flag-store';
import { defineFlag } from '../../src/features/flags';

const BOOT = defineFlag('test.guard.boot', {
  default: false,
  foldWhen: 'この test が消えるとき',
  summary: '起動時に決まる見本(確かめの test)',
  needsRestart: true,
});

let region: HTMLElement;
beforeEach(() => {
  localStorage.clear();
  document.body.textContent = '';
  region = document.createElement('div');
  document.body.append(region);
});

const flush = async (): Promise<void> => {
  for (let i = 0; i < 4; i++) await Promise.resolve();
};

const setup = (editing: boolean, answer: boolean) => {
  const seen: string[] = [];
  const log: string[] = [];
  const r = new FlagsRenderer(region, new FlagStore(''), (url) => seen.push(url), () => 'https://e/');
  r.setRestartGuard({
    isEditing: () => editing,
    confirmDiscard: () => {
      log.push('ask');
      return Promise.resolve(answer);
    },
    onDeclined: () => log.push('declined'),
  });
  r.render();
  return { r, seen, log };
};

describe('🔴 フラグの再読み込みは、編集中なら確かめてから', () => {
  it('編集中でなければ、確かめずにその場で読み込み直す(同期)', () => {
    const { r, seen, log } = setup(false, false);
    r.setFlag(BOOT.name, true);
    expect(seen).toHaveLength(1);
    expect(log).toEqual([]);
  });

  it('編集中は確かめ、承知されたら読み込み直す', async () => {
    const { r, seen, log } = setup(true, true);
    r.setFlag(BOOT.name, true);
    expect(seen, '確かめる前に読み込み直した').toHaveLength(0);
    await flush();
    expect(log).toEqual(['ask']);
    expect(seen).toHaveLength(1);
  });

  it('編集中に断られたら読み込み直さない。設定は保存され、断ったと伝える', async () => {
    const { r, seen, log } = setup(true, false);
    r.setFlag(BOOT.name, true);
    await flush();
    expect(seen, '断られたのに読み込み直した').toHaveLength(0);
    expect(log).toEqual(['ask', 'declined']);
    expect(new FlagStore('').isOn(BOOT.name), '保存が消えた').toBe(true);
  });

  it('すべて既定に戻す(再読み込みが要るとき)も同じ確かめを通る', async () => {
    const { r, seen, log } = setup(true, false);
    r.setFlag(BOOT.name, true);
    await flush();
    log.length = 0;
    r.resetFlags();
    await flush();
    expect(seen).toHaveLength(0);
    expect(log).toEqual(['ask', 'declined']);
  });
});
