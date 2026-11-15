/** @vitest-environment happy-dom */
/** #1163 依頼 373(推薦 C): 録音の長さを超える時刻は、再生の字にしない。 */
import { describe, expect, it } from 'vitest';
import { limitSeekLinks, watchSeekRange } from '../../src/adapter/ui/render/seek-range';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';

const TRANSCRIPT = '0:15 こんにちは\n9:30 おわり\n14:00 会議\n';

function rendered(): HTMLElement {
  const desc = document.createElement('div');
  desc.innerHTML = renderMarkdown(TRANSCRIPT, { interactiveSeek: true });
  return desc;
}
const links = (el: ParentNode) =>
  Array.from(el.querySelectorAll('.pkc-seek-link')).map((e) => e.textContent);

describe('録音の長さを超える時刻(依頼 373)', () => {
  it('前提: 長さを知る前は 3 つとも押せる字', () => {
    expect(links(rendered())).toEqual(['0:15', '9:30', '14:00']);
  });

  it('🔴 10 分の録音では 14:00 をふつうの字に戻す(字は残す)/ 内側の時刻は押せるまま', () => {
    const desc = rendered();
    expect(limitSeekLinks(desc, 10 * 60 * 1000)).toBe(1);
    expect(links(desc)).toEqual(['0:15', '9:30']);
    expect(desc.textContent, '字まで消した').toContain('14:00 会議');
  });

  it('⚠ 長さが分からない(Infinity / NaN / 0)ときは何もしない', () => {
    for (const d of [Infinity, NaN, 0]) {
      const desc = rendered();
      expect(limitSeekLinks(desc, d)).toBe(0);
      expect(links(desc)).toHaveLength(3);
    }
  });

  it('🔴 再生機が長さを読んだ(loadedmetadata)ときに絞る', () => {
    const host = document.createElement('div');
    const desc = rendered();
    const media = document.createElement('audio');
    host.append(media);
    document.body.append(host, desc);
    watchSeekRange(host, desc);
    Object.defineProperty(media, 'duration', { value: 600, configurable: true });
    media.dispatchEvent(new Event('loadedmetadata'));
    expect(links(desc)).toEqual(['0:15', '9:30']);
  });
});
