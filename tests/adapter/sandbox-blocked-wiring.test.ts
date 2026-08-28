/** @vitest-environment happy-dom */
/**
 * #528 段③: **箱が止めた「画像以外」を、理由つきで画面に出す**の配線。
 *
 * 🔴 **配線の test を別に置く理由**。両端はそれぞれの test が見ている ──
 * 箱の申告(`tests/features/external-images.test.ts`)と、帯を組む側
 * (`tests/adapter/external-image-consent.test.ts`)。⚠ **その間**は誰も通らない
 * (CLAUDE.md §7「A と B が合意していることは、A の test にも B の test にも
 * 書けない」)。
 *
 * ⚠ **実際に落ちていた**(2026-08-28):`installHtmlSandboxBlockedReporter` は
 * 種別を渡し、`DetailRenderer` は種別を受けるのに、**間の `CenterRouter` と
 * `main.ts` が落としていた** ── 受け側が `kinds = []` と既定を持っていたので
 * **tsc は 1 行も言わなかった**。いまは必須引数にしてあるが、
 * 「`kinds` の代わりに `[]` を渡す」変異は型では止まらないので、ここで見る。
 *
 * 🔑 だから**間に立つ役は「そのまま流す通り道」にする** ── この test の closure は
 * `main.ts` の 1 行と同じ形にしてあり、封筒を 1 バイトも組まない。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { CenterRouter } from '../../src/adapter/ui/render/center';
import { installHtmlSandboxBlockedReporter } from '../../src/features/markdown/html-sandbox';
import { appExternalImages } from '../../src/adapter/ui/render/external-images';
import type { AppState } from '../../src/adapter/state/app-state';

const LID = 'n1';

function stateWith(body: string): AppState {
  return {
    phase: 'ready',
    selectedLid: LID,
    openBody: { lid: LID, body, baseline: body, persisted: body, diskAhead: false },
    entryMetas: new Map([[LID, { lid: LID, title: '題', archetype: 'text' }]]),
    revisionPanel: null,
    error: null,
    viewMode: 'detail',
  } as unknown as AppState;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

/** 箱を 1 枚建てて、送り主として名乗れる形にする(受け口は送り主で引く)。 */
function box(id: string): object {
  const iframe = document.createElement('iframe');
  iframe.setAttribute('data-pkc-html-render-id', id);
  const win = { boxId: id };
  Object.defineProperty(iframe, 'contentWindow', { value: win, configurable: true });
  document.body.append(iframe);
  return win;
}

function post(data: unknown, source: object): void {
  const ev = new MessageEvent('message', { data });
  Object.defineProperty(ev, 'source', { value: source, configurable: true });
  window.dispatchEvent(ev);
}

afterEach(() => {
  appExternalImages.forgetBlockedBoxes(LID);
  document.body.textContent = '';
});

describe('箱の申告 → 画面(#528 段③)', () => {
  /**
   * 🔴 **本物どうしを繋ぐ 1 本**。実物の受け口が投げた物を、実物の面が受ける。
   * ⚠ closure は `main.ts` と同じ 1 行(`center.noteBlockedBox(lid, blocked, kinds)`)。
   */
  it('外部の script が止まると、その理由が本文の面に出る', async () => {
    const region = document.createElement('div');
    document.body.append(region);
    const center = new CenterRouter(region);
    center.render(stateWith('```html\n<b>x</b>\n```\n'));
    await settle();

    const win = box('pkc-html-render-aaa');
    const off = installHtmlSandboxBlockedReporter((_iframe, blocked, kinds) => {
      center.noteBlockedBox(LID, blocked, kinds);
    });
    post(
      {
        type: 'pkc-html-blocked-images',
        id: 'pkc-html-render-aaa',
        blocked: 0,
        kinds: ['script-src-elem'],
      },
      win,
    );

    const note = region.querySelector('[data-pkc-field="sandbox-blocked-note"]');
    expect(note, '箱が止めた理由が 1 行も画面に出ていない').not.toBeNull();
    expect(note!.textContent).toContain('外部のプログラム');
    off();
  });

  /**
   * ⚠ **空振り防止の対照群** ── 何も止まっていない箱では 1 行も出ない。
   * 🔑 これが無いと、「常に出す」に壊れても上の it は緑のままである。
   */
  it('何も止まっていなければ、理由の行は出ない', async () => {
    const region = document.createElement('div');
    document.body.append(region);
    const center = new CenterRouter(region);
    center.render(stateWith('```html\n<b>x</b>\n```\n'));
    await settle();

    const win = box('pkc-html-render-bbb');
    const off = installHtmlSandboxBlockedReporter((_iframe, blocked, kinds) => {
      center.noteBlockedBox(LID, blocked, kinds);
    });
    post(
      { type: 'pkc-html-blocked-images', id: 'pkc-html-render-bbb', blocked: 0, kinds: [] },
      win,
    );

    expect(region.querySelector('[data-pkc-field="sandbox-blocked-note"]')).toBeNull();
    off();
  });
});

/**
 * `main.ts` の 1 行。
 *
 * ⚠ **弱い pin だと自覚して使う**(CLAUDE.md §2「どの test からも実行されない
 * file に判断を書かない」)── boot の closure は取り出せないので原文で見る。
 * 🔑 見るのは**種別を落としていないこと** 1 点だけ(型では止まらない変異)。
 */
describe('boot の 1 行(弱い pin)', () => {
  it('main.ts は受け取った種別をそのまま中継する', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('src/main.ts', 'utf8');
    expect(src).toContain('installHtmlSandboxBlockedReporter((_iframe, blocked, kinds) => {');
    expect(src).toContain('center.noteBlockedBox(lid, blocked, kinds);');
  });
});
