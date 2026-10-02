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

function rig(enabled: boolean, lendable = true, delayed = false) {
  const opened: string[] = [];
  const lends: string[] = [];
  const disposed: string[] = [];
  const fails: string[] = [];
  const notes: string[] = [];
  const posted: unknown[] = [];
  let alive = false;
  const releases: Array<() => void> = [];
  const host = new PdfReaderHost({
    onQuote: () => Promise.resolve({ ok: true, message: '' }),
    onFellBack: () => undefined,
    onLoadFailed: () => undefined,
    onOpenFailed: () => undefined,
    onLateHello: () => undefined,
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
      const lent = lendable ? { url: `blob:${key}`, dispose: () => disposed.push(key) } : null;
      // `delayed`: 貸している最中(`await` の間)を test が握る
      if (delayed) return new Promise((res) => releases.push(() => res(lent)));
      return Promise.resolve(lent);
    },
    fail: (m: string) => fails.push(m),
    note: (t: string) => notes.push(t),
  };
  return { deps, opened, lends, disposed, fails, notes, posted, host, releases, setAlive: (v: boolean) => (alive = v) };
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

  it('🔴 貸している最中の 2 回目の押しは、窓を 2 枚にしない(「もう開いています」で断る)', async () => {
    const g = rig(true, true, true);
    const first = openInPdfReader(g.deps, pdf);
    // 1 回目は貸している最中(まだ窓が無い)── 2 回目が来る
    const second = await openInPdfReader(g.deps, pdf);
    expect(second).toBe(true);
    expect(g.lends, '貸している最中に 2 回目が借りている').toEqual(['k1']);
    expect(g.notes).toEqual(['「a.pdf」はもう開いています']);
    g.releases[0]?.();
    expect(await first).toBe(true);
    expect(g.opened, '窓が 2 枚開いた').toHaveLength(1);
  });

  it('対照群: 別の添付は同時に貸せる / 貸し終われば同じ添付も押し直せる(印は残らない)', async () => {
    const g = rig(true, true, true);
    const a = openInPdfReader(g.deps, pdf);
    const b = openInPdfReader(g.deps, { ...pdf, assetKey: 'k2', name: 'b.pdf' });
    expect(g.lends).toEqual(['k1', 'k2']);
    g.releases.forEach((r) => r());
    await Promise.all([a, b]);
    expect(g.opened).toHaveLength(2);
  });

  it('貸せなかった / 貸すのが落ちた回でも、印は外れる(次の押しが「もう開いています」で塞がれない)', async () => {
    const g = rig(true, false);
    await openInPdfReader(g.deps, pdf);
    expect(g.fails).toEqual(['添付が見つかりません: a.pdf']);
    await openInPdfReader(g.deps, pdf);
    expect(g.fails).toHaveLength(2); // 2 回目も「借りに行った」(印で塞がれていない)
    expect(g.notes).toEqual([]);
    const throwing = { ...g.deps, lend: (): Promise<PdfLent | null> => Promise.reject(new Error('x')) };
    await expect(openInPdfReader(throwing, pdf)).rejects.toThrow('x');
    await openInPdfReader(g.deps, pdf);
    expect(g.fails).toHaveLength(3);
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
