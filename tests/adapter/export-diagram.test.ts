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

  it('🔴 Windows の予約名を避ける(P8 段⑬ review L-2)', () => {
    // ⚠ 判定は「最初の `.` より前」に掛かる ── `CON.pkc3.zip` も保存できない。
    //    「拡張子を付けているから安全」は誤り
    expect(safeName('CON')).toBe('CON-file');
    expect(safeName('nul')).toBe('nul-file'); // 大文字小文字を区別しない
    expect(safeName('COM1')).toBe('COM1-file');
    expect(safeName('LPT9')).toBe('LPT9-file');
    // ⚠ 予約名を**含むだけ**の題名は普通に通す(過剰に書き換えない)
    expect(safeName('CONTENTS')).toBe('CONTENTS');
    expect(safeName('会議CON')).toBe('会議CON');
    // 図の名前は接尾辞が付くので、そもそも予約名にならない
    expect(diagramFileName('CON', 0)).toBe('CON-file-図1.svg');
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

/**
 * P8 段⑬ review L-1: 🔴 **失敗しても URL の寿命は終わらせる**。
 *
 * `click()` が投げる経路(拡張機能 / DL 抑止 / detached document)で、かつては
 * `<a>` が body に残り `release` が**永久に呼ばれなかった** ── 即破棄規律
 * (user 指示 2026-07-27、不可侵)に穴が開いていた。
 */
describe('書き出しが失敗したとき(P8 段⑬)', () => {
  it('🔴 click が投げても `<a>` は消え、URL は解放される', () => {
    vi.useFakeTimers();
    const before = document.querySelectorAll('a[download]').length;
    const release = vi.fn();
    // ⚠ **投げる形**を作る ── HTMLAnchorElement 自体の click を差す
    const spy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => {
        throw new Error('拒否された');
      });
    expect(() => downloadUrl('x.svg', 'blob:fake', release)).toThrow('拒否された');
    spy.mockRestore();
    expect(document.querySelectorAll('a[download]').length, '<a> が残った').toBe(before);
    vi.advanceTimersByTime(1001);
    expect(release, 'URL が永久に解放されない').toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});

/**
 * P8 段⑬ review M-3: 🔴 **無言で待たせない**。
 *
 * ベクタは原文から焼き直すので、mermaid 本体の読み込みを含めて秒が掛かる。
 * 何も起きないように見えると user は連打する。
 */
describe('書き出し中の見え方(P8 段⑬)', () => {
  function pending(): { root: HTMLElement; btn: HTMLButtonElement; settle: (ok: boolean) => void } {
    const root = document.createElement('div');
    root.setAttribute('data-pkc-region', 'detail');
    const host = document.createElement('div');
    host.setAttribute('data-pkc-mermaid-src', 'graph TD\n A-->B');
    const btn = document.createElement('button');
    btn.setAttribute('data-pkc-action', 'export-diagram');
    const label = document.createElement('span');
    label.setAttribute('data-pkc-field', 'label');
    label.textContent = '図を保存';
    btn.append(label);
    host.append(btn);
    root.append(host);
    document.body.append(root);

    let settle!: (ok: boolean) => void;
    const p = new Promise<void>((resolve, reject) => {
      settle = (ok) => (ok ? resolve() : reject(new Error('失敗')));
    });
    bindActions(root, new Dispatcher(), { exportDiagram: () => p });
    return { root, btn, settle };
  }

  it('🔴 押している間は押せなくなり、そう見える', async () => {
    const { root, btn, settle } = pending();
    btn.click();
    expect(btn.disabled, '書き出し中も押せてしまう(連打できる)').toBe(true);
    expect(btn.textContent).toContain('書き出し中');
    expect(btn.hasAttribute('data-pkc-busy')).toBe(true);

    settle(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(btn.disabled).toBe(false);
    expect(btn.textContent, '押せる状態の文言に戻っていない').toContain('図を保存');
    root.remove();
  });

  it('🔴 失敗しても押せる状態へ戻す(死んだボタンを残さない)', async () => {
    const { root, btn, settle } = pending();
    btn.click();
    expect(btn.disabled).toBe(true);
    settle(false);
    await new Promise((r) => setTimeout(r, 0));
    expect(btn.disabled, '失敗したまま押せないボタンが残った').toBe(false);
    expect(btn.textContent).toContain('図を保存');
    root.remove();
  });
});
