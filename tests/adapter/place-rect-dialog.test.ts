/** @vitest-environment happy-dom */
/**
 * 🔴 **枠の「位置と大きさ…」の窓と、テンプレートの窓**(#529 W2 / W4)。
 *
 * 見るのは 3 つ(どれか 1 つ欠けると「押しても何も起きない」になる):
 *
 * | | 何を |
 * |---|---|
 * | 右クリックの一覧 | 板の上に「位置と大きさ…」、本文の上に「テンプレートから板を置く…」が出るか |
 * | 受け手(`binder.ts`) | その 2 つの受け手が在るか |
 * | 窓 | 全角数字を受ける / 通らない値では**閉じずに**理由を出す / やめるで何も返さない |
 */
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  pickPlaceRectInApp,
  pickPlaceTemplateInApp,
  resetAppDialogForTest,
} from '../../src/adapter/ui/render/app-dialog';
import { ADD_PLACE_TEMPLATE_ACTION, blockMenuActions } from '../../src/features/entry-actions';
import { PLACE_TEMPLATES } from '../../src/features/markdown/place-template';
import { cancelDialogRows, openDialog } from './dialog-helper';

async function settle(): Promise<void> {
  for (let i = 0; i < 40; i += 1) await Promise.resolve();
}

describe('右クリックの一覧', () => {
  it('🔴 板の上には「位置と大きさ…」が出て、板でなければ出ない', () => {
    const board = blockMenuActions({ board: true, shape: 'rect' });
    expect(board.find((a) => a.action === 'place-rect')?.label).toBe('位置と大きさ…');
    expect(blockMenuActions({ board: false }).map((a) => a.action)).not.toContain('place-rect');
  });

  it('⚠ 消すは最後のまま(確認を挟む物を真ん中に置かない)', () => {
    const acts = blockMenuActions({ board: true, shape: 'rect' }).map((a) => a.action);
    expect(acts[acts.length - 1]).toBe('remove-place');
  });

  it('🔴 「テンプレートから板を置く…」の綴りは add-place-template', () => {
    expect(ADD_PLACE_TEMPLATE_ACTION).toEqual({
      action: 'add-place-template',
      label: 'テンプレートから板を置く…',
    });
  });
});

describe('受け手(binder.ts)', () => {
  const binder = readFileSync('src/adapter/ui/actions/binder.ts', 'utf-8');
  // ⚠ 注釈を落としてから見る ── 解説に綴りを書くと、受け手が無くても緑になる
  const code = binder.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('🔴 2 つの受け手が在り、右クリックの一覧にも載っている', () => {
    expect(code).toContain("'place-rect': (");
    expect(code).toContain("'add-place-template': (");
    expect(code, '一覧に載っていない').toContain('ADD_PLACE_TEMPLATE_ACTION,');
  });
});

describe('テンプレートの窓(pickPlaceTemplateInApp)', () => {
  let host: HTMLElement;
  beforeEach(() => {
    document.body.innerHTML = '';
    resetAppDialogForTest();
    host = document.createElement('div');
    document.body.append(host);
  });

  it('🔴 PLACE_TEMPLATES の数だけ行が並び、押した行の id が答え', async () => {
    const p = pickPlaceTemplateInApp(host);
    const rows = [...openDialog()!.querySelectorAll<HTMLButtonElement>('[data-pkc-field="pick-place-template"]')];
    expect(rows.map((r) => r.textContent)).toEqual(PLACE_TEMPLATES.map((t) => expect.stringContaining(t.label)));
    expect(rows).toHaveLength(3);
    rows[1]!.click();
    expect(await p).toBe('flow3');
  });

  it('🔴 やめるなら何も選ばない(null)', async () => {
    const p = pickPlaceTemplateInApp(host);
    await cancelDialogRows();
    expect(await p).toBeNull();
  });
});

describe('位置と大きさの窓(pickPlaceRectInApp)', () => {
  let host: HTMLElement;
  beforeEach(() => {
    document.body.innerHTML = '';
    resetAppDialogForTest();
    host = document.createElement('div');
    document.body.append(host);
  });

  const input = (key: string): HTMLInputElement =>
    openDialog()!.querySelector<HTMLInputElement>(`[data-pkc-place-rect-key="${key}"]`)!;
  const ok = (): HTMLButtonElement => openDialog()!.querySelector('[data-pkc-field="dialog-ok"]')!;
  const errorLine = (): HTMLElement => openDialog()!.querySelector('[data-pkc-field="place-rect-error"]')!;
  const INITIAL = { x: '10', y: '20', w: '240', h: '120' };

  it('🔴 いまの値が 4 欄に入った状態で開く', async () => {
    const p = pickPlaceRectInApp(host, INITIAL);
    expect(['x', 'y', 'w', 'h'].map((k) => input(k).value)).toEqual(['10', '20', '240', '120']);
    await cancelDialogRows();
    await p;
  });

  it('🔴 全角数字で打っても通り、数で返る', async () => {
    const p = pickPlaceRectInApp(host, INITIAL);
    input('x').value = '１２０';
    input('y').value = '４０';
    input('w').value = '３２０';
    input('h').value = '２００';
    ok().click();
    expect(await p).toEqual({ x: 120, y: 40, w: 320, h: 200 });
  });

  it('🔴 通らない値では閉じず、理由を出し、その欄へ焦点を返す。直して決めれば通る', async () => {
    const p = pickPlaceRectInApp(host, INITIAL);
    input('w').value = '-5';
    ok().click();
    await settle();
    // 閉じていない
    expect(openDialog(), '通らないのに閉じた').not.toBeNull();
    expect(errorLine().hidden).toBe(false);
    expect(errorLine().textContent).toContain('幅');
    expect(errorLine().textContent).toContain('0 以上');
    expect(document.activeElement).toBe(input('w'));
    // 直して決める
    input('w').value = '300';
    ok().click();
    expect(await p).toEqual({ x: 10, y: 20, w: 300, h: 120 });
  });

  it('🔴 非数・小数・上限超えも閉じずに断る', async () => {
    const p = pickPlaceRectInApp(host, INITIAL);
    for (const bad of ['あ', '1.5', '100001']) {
      input('x').value = bad;
      ok().click();
      await settle();
      expect(openDialog(), `${bad} で閉じた`).not.toBeNull();
      expect(errorLine().hidden, `${bad} の理由が出ていない`).toBe(false);
    }
    await cancelDialogRows();
    expect(await p).toBeNull();
  });

  it('🔴 空欄で決めれば、その札は値に入らない(変えない)', async () => {
    const p = pickPlaceRectInApp(host, { x: '10', y: '20', w: '', h: '' });
    ok().click();
    expect(await p).toEqual({ x: 10, y: 20 });
  });

  it('🔴 やめる / Escape は null(何も書かない)── 打った値があっても', async () => {
    const p = pickPlaceRectInApp(host, INITIAL);
    input('x').value = '999';
    await cancelDialogRows();
    expect(await p).toBeNull();

    resetAppDialogForTest();
    const p2 = pickPlaceRectInApp(host, INITIAL);
    input('x').value = '999';
    openDialog()!.close();
    await settle();
    expect(await p2).toBeNull();
  });

  it('Enter で決まる(日本語入力の変換中の Enter は決めない)', async () => {
    const p = pickPlaceRectInApp(host, INITIAL);
    input('y').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true }));
    await settle();
    expect(openDialog(), '変換確定の Enter で決まった').not.toBeNull();
    input('y').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(await p).toEqual({ x: 10, y: 20, w: 240, h: 120 });
  });
});
