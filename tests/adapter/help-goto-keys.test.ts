/** @vitest-environment happy-dom */
/**
 * 🔴 **`?` で一覧まで送る合図は、マニュアルを描き終えてから送る**(#1145。⚠9)。
 * 先に送ると、10 万字ぶんの高さが無い間の位置に着いて、描き終えると一覧が遠くへ流れる。
 */
import { describe, expect, it } from 'vitest';
import { HELP_GOTO_KEYS_EVENT, HelpRenderer } from '../../src/adapter/ui/render/help';

describe('ヘルプの「一覧まで送る」合図', () => {
  it('描き終える前は送らず、描き終えたら送る', async () => {
    document.body.textContent = '';
    const region = document.createElement('div');
    document.body.append(region);
    let finish: (html: string) => void = () => undefined;
    const port = {
      render: () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    };
    new HelpRenderer(region, port).render();
    const keys = region.querySelector<HTMLElement>('[data-pkc-region="help-keymap"]')!;
    let scrolled = 0;
    keys.scrollIntoView = () => {
      scrolled += 1;
    };
    region.dispatchEvent(new CustomEvent(HELP_GOTO_KEYS_EVENT));
    await new Promise((r) => setTimeout(r, 20));
    expect(scrolled, 'マニュアルを描き終える前に送った').toBe(0);
    finish('<p>マニュアル</p>');
    await new Promise((r) => setTimeout(r, 50));
    expect(scrolled, '描き終えても送っていない').toBeGreaterThan(0);
  });
});
