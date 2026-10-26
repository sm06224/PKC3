/** @vitest-environment happy-dom */
/**
 * 🔴 **再生中の文字起こしの行を光らせる**(#1232。user 指示 2026-10-26「全部やるのです」)。
 *
 * 見るのは user が見ること:
 * ①時刻の行は 1 行ごとに 1 つの器で包まれる(行の字は 1 文字も消えず、光る単位が行になる)
 * ②再生位置が進むと、**位置以前でいちばん後ろの行**だけが光る(最初の行より前は誰も光らない)
 * ③位置を飛ばしても(seeked)追う ④別の添付の行は光らない ⑤同じ行のままなら DOM に触れない
 */
import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { bindActions } from '../../src/adapter/ui/actions/binder';

const TRANSCRIPT = '0:05 はじめに\n0:15 つぎに\n0:40 おわりに\n';

function detail(root: HTMLElement) {
  const host = document.createElement('div');
  const prose = document.createElement('div');
  prose.setAttribute('data-pkc-prose', '');
  prose.innerHTML = renderMarkdown(TRANSCRIPT, { interactiveSeek: true });
  const preview = document.createElement('div');
  preview.setAttribute('data-pkc-field', 'attachment-preview');
  const media = document.createElement('audio');
  media.setAttribute('data-pkc-field', 'attachment-media');
  let t = 0;
  Object.defineProperty(media, 'currentTime', { get: () => t, set: (v: number) => (t = v), configurable: true });
  preview.append(media);
  host.append(prose, preview);
  root.append(host);
  const move = (sec: number, type: 'timeupdate' | 'seeked' = 'timeupdate'): void => {
    t = sec;
    media.dispatchEvent(new Event(type));
  };
  const lines = (): HTMLElement[] => [...prose.querySelectorAll<HTMLElement>('[data-pkc-seek-line]')];
  const active = (): string[] =>
    lines().flatMap((l) => (l.hasAttribute('data-pkc-seek-active') ? [l.textContent ?? ''] : []));
  return { host, prose, media, move, lines, active };
}

function setup() {
  const root = document.createElement('div');
  document.body.append(root);
  buildShell(root);
  bindActions(root, new Dispatcher(), {});
  return root;
}

describe('時刻の行の器(描画)', () => {
  it('🔴 時刻の行ごとに 1 つの器で包まれ、字は 1 文字も消えない', () => {
    const html = renderMarkdown(TRANSCRIPT, { interactiveSeek: true });
    expect((html.match(/data-pkc-seek-line/g) ?? []).length).toBe(3);
    const box = document.createElement('div');
    box.innerHTML = html;
    expect([...box.querySelectorAll('[data-pkc-seek-line]')].map((l) => l.textContent)).toEqual([
      '0:05 はじめに',
      '0:15 つぎに',
      '0:40 おわりに',
    ]);
  });
  it('🔴 旗を立てない面(書き出し・印刷・別窓)には器を出さない(1 バイトも変わらない)', () => {
    expect(renderMarkdown(TRANSCRIPT, {})).not.toContain('data-pkc-seek-line');
  });
  it('時刻でない行には器を出さない。強調を含む行も閉じが揃う', () => {
    const box = document.createElement('div');
    box.innerHTML = renderMarkdown('0:05 **強い**字\nふつうの行\n0:20 次\n', { interactiveSeek: true });
    const lines = [...box.querySelectorAll('[data-pkc-seek-line]')];
    expect(lines.map((l) => l.textContent)).toEqual(['0:05 強い字', '0:20 次']);
    expect(box.textContent).toContain('ふつうの行');
    // 器の外に「ふつうの行」が出ている(包んだのは時刻の行だけ)
    expect(lines.some((l) => l.textContent?.includes('ふつうの行'))).toBe(false);
  });
});

describe('再生位置に合わせて光る', () => {
  it('🔴 位置以前でいちばん後ろの行だけが光る。最初の行より前は誰も光らない', () => {
    const root = setup();
    const d = detail(root);
    d.move(2);
    expect(d.active(), '最初の行より前なのに光っている').toEqual([]);
    d.move(5);
    expect(d.active()).toEqual(['0:05 はじめに']);
    d.move(16.2);
    expect(d.active()).toEqual(['0:15 つぎに']);
    d.move(300);
    expect(d.active()).toEqual(['0:40 おわりに']);
  });

  it('飛ばした(seeked)ときも追い、巻き戻すと前の行へ戻る(光るのは常に 1 行)', () => {
    const root = setup();
    const d = detail(root);
    d.move(41, 'seeked');
    expect(d.active()).toEqual(['0:40 おわりに']);
    d.move(6, 'seeked');
    expect(d.active()).toEqual(['0:05 はじめに']);
    expect(d.prose.querySelectorAll('[data-pkc-seek-active]')).toHaveLength(1);
  });

  it('🔴 別の添付の行は光らない(同じ詳細の中だけ)', () => {
    const root = setup();
    const a = detail(root);
    const b = detail(root);
    a.move(20);
    expect(a.active()).toEqual(['0:15 つぎに']);
    expect(b.active(), '別の添付の行が光った').toEqual([]);
  });

  it('同じ行のままなら DOM に触れない(1 秒に数回の更新で属性を付け直さない)', () => {
    const root = setup();
    const d = detail(root);
    d.move(16);
    const line = d.lines()[1]!;
    const writes: string[] = [];
    const orig = line.setAttribute.bind(line);
    line.setAttribute = ((n: string, v: string) => {
      writes.push(n);
      orig(n, v);
    }) as typeof line.setAttribute;
    d.move(17);
    d.move(18);
    expect(writes, '同じ行を何度も付け直している').toEqual([]);
    expect(d.active()).toEqual(['0:15 つぎに']);
  });

  it('再生機でない物の timeupdate・説明の無い再生機では何も起きない(落ちない)', () => {
    const root = setup();
    const lone = document.createElement('audio');
    lone.setAttribute('data-pkc-field', 'attachment-media');
    root.append(lone);
    expect(() => lone.dispatchEvent(new Event('timeupdate'))).not.toThrow();
    const other = document.createElement('audio');
    root.append(other);
    expect(() => other.dispatchEvent(new Event('timeupdate'))).not.toThrow();
  });
});
