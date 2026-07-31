/** @vitest-environment happy-dom */
import { describe, expect, it } from 'vitest';
import {
  installHtmlSandboxResizer,
  HTML_SANDBOX_RESIZE_MSG_TYPE,
} from '../../src/features/markdown/html-sandbox';

function iframeWithId(id: string): HTMLIFrameElement {
  const iframe = document.createElement('iframe');
  iframe.setAttribute('data-pkc-html-render-id', id);
  document.body.append(iframe);
  return iframe;
}

function post(data: unknown): void {
  window.dispatchEvent(new MessageEvent('message', { data }));
}

describe('installHtmlSandboxResizer (P3-5 結線)', () => {
  it('resize message で対応 iframe の高さが追従し、cap でクランプされる', () => {
    const off = installHtmlSandboxResizer();
    const iframe = iframeWithId('pkc-html-render-abc');
    post({ type: HTML_SANDBOX_RESIZE_MSG_TYPE, id: 'pkc-html-render-abc', height: 420 });
    expect(iframe.style.height).toBe('420px');
    post({ type: HTML_SANDBOX_RESIZE_MSG_TYPE, id: 'pkc-html-render-abc', height: 999999 });
    expect(iframe.style.height).toBe('5000px'); // HTML_SANDBOX_MAX_HEIGHT
    iframe.remove();
    off();
  });

  it('型不一致 / 未知 id / teardown 後は何もしない', () => {
    const off = installHtmlSandboxResizer();
    const iframe = iframeWithId('pkc-html-render-x');
    post({ type: HTML_SANDBOX_RESIZE_MSG_TYPE, id: 'pkc-html-render-x', height: 'tall' });
    post({ type: 'other', id: 'pkc-html-render-x', height: 100 });
    post({ type: HTML_SANDBOX_RESIZE_MSG_TYPE, id: 'unknown', height: 100 });
    expect(iframe.style.height).toBe('');
    off();
    post({ type: HTML_SANDBOX_RESIZE_MSG_TYPE, id: 'pkc-html-render-x', height: 100 });
    expect(iframe.style.height).toBe(''); // teardown 済み
    iframe.remove();
  });
});
