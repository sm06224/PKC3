/** @vitest-environment happy-dom */
/**
 * P8 段⑦: **図を書き出す**。
 *
 * > user 指示 2026-08-03「**mermaid 図のエクスポートをさせるとき以外は PNG ラスタを
 * > キャッシュして…**」
 *
 * 🔴 この指示は「**書き出しの導線が在る**」前提だったが、`renderToSvg()` は
 * 書かれたまま**呼び出し元が 0 件**だった(死んだコード)。ここが繋がりの観測点。
 *
 * ⚠ 「ボタンが在るか」で止めない ── **押した結果 service に何が渡るか**まで見る
 * (原文と「何枚目か」)。渡る中身が違うと、別の図が落ちてくる。
 */
import { describe, expect, it, vi } from 'vitest';
import { bindActions, type BinderServices } from '../../src/adapter/ui/actions/binder';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { safeName, diagramFileName } from '../../src/features/export/file-name';
import { downloadBlob, downloadUrl } from '../../src/adapter/platform/download';

/** 描画後の姿を組む(`hydrateMermaid` が作る形と同じ)。 */
function withDiagrams(sources: string[]): { root: HTMLElement; d: Dispatcher } {
  const root = document.createElement('div');
  root.setAttribute('data-pkc-region', 'detail');
  for (const src of sources) {
    const host = document.createElement('div');
    host.setAttribute('data-pkc-mermaid-src', src);
    const btn = document.createElement('button');
    btn.setAttribute('data-pkc-action', 'export-diagram');
    btn.setAttribute('data-pkc-field', 'diagram-save');
    host.append(btn);
    root.append(host);
  }
  document.body.append(root);
  return { root, d: new Dispatcher() };
}

describe('図の書き出し(P8 段⑦)', () => {
  it('🔴 押した図の**原文**と**何枚目か**が渡る', () => {
    const { root, d } = withDiagrams(['graph TD\n A-->B', 'pie\n "x": 1']);
    const exportDiagram = vi.fn();
    bindActions(root, d, { exportDiagram } satisfies BinderServices);

    const buttons = root.querySelectorAll<HTMLElement>('[data-pkc-action="export-diagram"]');
    buttons[1]!.click();
    // ⚠ 1 枚目を渡していないこと(index も原文も)を**両方**見る ── 片方だけだと
    // 「常に 0 を渡す」実装が原文の一致で素通りする
    expect(exportDiagram).toHaveBeenCalledWith('pie\n "x": 1', 1);
    buttons[0]!.click();
    expect(exportDiagram).toHaveBeenLastCalledWith('graph TD\n A-->B', 0);
  });

  it('原文の無い器では何も起きない(空の図を書き出さない)', () => {
    const { root, d } = withDiagrams([]);
    const host = document.createElement('div');
    host.setAttribute('data-pkc-mermaid-src', '');
    const btn = document.createElement('button');
    btn.setAttribute('data-pkc-action', 'export-diagram');
    host.append(btn);
    root.append(host);
    const exportDiagram = vi.fn();
    bindActions(root, d, { exportDiagram });
    btn.click();
    expect(exportDiagram).not.toHaveBeenCalled();
  });
});

describe('書き出す名前(P8 段⑦)', () => {
  it('図は 1 始まりで数える(user の数え方)', () => {
    expect(diagramFileName('設計メモ', 0)).toBe('設計メモ-図1.svg');
    expect(diagramFileName('設計メモ', 2)).toBe('設計メモ-図3.svg');
  });

  it('🔴 題名の記号は落ちるが、**日本語と絵文字は壊れない**', () => {
    expect(safeName('a/b:c*d?e"f<g>h|i j')).toBe('a-b-c-d-e-f-g-h-i-j');
    // ⚠ サロゲートペアを割ると絵文字が壊れる(`slice` を使うと実際に割れる)
    const long = '🍎'.repeat(70);
    expect([...safeName(long)]).toHaveLength(60);
    expect(safeName(long)).not.toContain('�');
  });

  it('空になる題名でも名前が消えない(隠しファイルを作らない)', () => {
    expect(diagramFileName('///', 0)).toBe('pkc3-図1.svg');
  });

  it('制御文字は落ちる(生バイトのファイル名を作らない)', () => {
    // 生バイトのまま書かない(`tests/repo-hygiene.test.ts` が止める)
    expect(safeName('あ\u0001い\u007fう')).toBe('あ-い-う');
  });
});

describe('落とさせ方(P8 段⑦)', () => {
  it('🔴 click の直後に URL を捨てない(DL が中断する)', () => {
    vi.useFakeTimers();
    const release = vi.fn();
    downloadUrl('x.svg', 'blob:fake', release);
    // ⚠ ここが本丸 ── 直後に捨てる実装だと**大きい図が落ちきらない**
    expect(release).not.toHaveBeenCalled();
    vi.advanceTimersByTime(999);
    expect(release).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2);
    expect(release).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('⚠ `<a>` を DOM に残さない(押すたびに増えていかない)', () => {
    const before = document.querySelectorAll('a[download]').length;
    const created: string[] = [];
    const revoked: string[] = [];
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
      const u = `blob:n${created.length}`;
      created.push(u);
      return u;
    });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation((u) => void revoked.push(u));
    vi.useFakeTimers();
    downloadBlob('a.svg', new Blob(['<svg/>'], { type: 'image/svg+xml' }));
    expect(document.querySelectorAll('a[download]').length).toBe(before);
    vi.advanceTimersByTime(1001);
    expect(revoked).toEqual(created);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
});
