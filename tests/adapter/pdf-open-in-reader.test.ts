/**
 * 添付の PDF の「別のウィンドウで見る」を、**設定で選んだ人だけ** PKC の画面へ振る(#275 段①)。
 *
 * 🔴 対照群が肝である:**切なら何も借りず・何も開かず `false`(= 今までのブラウザ内蔵の窓)**、
 *   **入なら借りて窓を開いて `true`**。片方だけ見ると「常に入」「常に切」を区別できない。
 * ⚠ PDF 以外(画像)は、設定が入でも振らない。
 */
import { describe, expect, it } from 'vitest';
import { openInPdfReader } from '../../src/adapter/platform/pdf/open-in-reader';
import { PdfReaderHost, type PdfLent } from '../../src/adapter/platform/pdf/pdf-window';

function rig(enabled: boolean, lendable = true) {
  const opened: string[] = [];
  const lends: string[] = [];
  const disposed: string[] = [];
  const fails: string[] = [];
  const notes: string[] = [];
  const posted: unknown[] = [];
  let alive = false;
  const host = new PdfReaderHost({
    onQuote: () => ({ ok: true, message: '' }),
    onFellBack: () => undefined,
    onLoadFailed: () => undefined,
    onOpenFailed: () => undefined,
    makeChannel: () => ({
      postMessage: (d) => posted.push(d),
      close: () => undefined,
      onmessage: null,
    }),
    openWindow: (url) => opened.push(url),
    baseUrl: 'https://example.test/',
    newToken: () => 'tok',
    now: () => (alive ? 0 : 1e9),
  });
  const deps = {
    enabled: () => enabled,
    host: () => host,
    lend: (key: string): Promise<PdfLent | null> => {
      lends.push(key);
      return Promise.resolve(lendable ? { url: `blob:${key}`, dispose: () => disposed.push(key) } : null);
    },
    fail: (m: string) => fails.push(m),
    note: (t: string) => notes.push(t),
  };
  return { deps, opened, lends, disposed, fails, notes, posted, host, setAlive: (v: boolean) => (alive = v) };
}
const pdf = { kind: 'pdf', assetKey: 'k1', name: 'a.pdf', lid: 'att1' };

describe('openInPdfReader', () => {
  it('🔴 切(既定): false を返し、何も借りず・何も開かない(今までの窓へ)', async () => {
    const g = rig(false);
    expect(await openInPdfReader(g.deps, pdf)).toBe(false);
    expect(g.lends).toEqual([]);
    expect(g.opened).toEqual([]);
  });

  it('対照群 入: 添付を借りて PKC の画面の窓を開き、true を返す', async () => {
    const g = rig(true);
    expect(await openInPdfReader(g.deps, pdf)).toBe(true);
    expect(g.lends).toEqual(['k1']);
    expect(g.opened).toEqual(['https://example.test/pdf/host.html#tok']);
  });

  it('入でも画像は振らない(PDF だけ)', async () => {
    const g = rig(true);
    expect(await openInPdfReader(g.deps, { ...pdf, kind: 'image' })).toBe(false);
    expect(g.lends).toEqual([]);
    expect(g.opened).toEqual([]);
  });

  it('入: 添付が見つからなければ窓を開かず、理由を言って true(元の窓へ落とさない)', async () => {
    const g = rig(true, false);
    expect(await openInPdfReader(g.deps, pdf)).toBe(true);
    expect(g.opened).toEqual([]);
    expect(g.fails).toEqual(['添付が見つかりません: a.pdf']);
  });

  it('入: 同じ添付の窓が生きていれば、2 枚目を開かず前へ出すよう頼む', async () => {
    const g = rig(true);
    await openInPdfReader(g.deps, pdf);
    g.setAlive(true);
    expect(await openInPdfReader(g.deps, pdf)).toBe(true);
    expect(g.opened).toHaveLength(1);
    expect(g.lends).toEqual(['k1']); // 借り直さない
    expect(g.notes).toEqual(['「a.pdf」はもう開いています']);
    expect(JSON.stringify(g.posted)).toContain('focus-request');
  });

  it('設定は押すたびに引く(切り替えが次の押しから効く)', async () => {
    let on = false;
    const g = rig(false);
    const deps = { ...g.deps, enabled: () => on };
    expect(await openInPdfReader(deps, pdf)).toBe(false);
    on = true;
    expect(await openInPdfReader(deps, pdf)).toBe(true);
  });
});
