/** @vitest-environment happy-dom */
/**
 * 🔴 **ふつうの付箋に、板の上から字を入れる**(#1662 1。Gemini 裁定 = #1163 依頼 48 の 1 = A)。
 *
 * 直す前は、「ここに付箋を置く」で出るのは空の付箋で、字を入れるには「編集」へ入り、付箋が座標に置かれず
 * 上から並ぶ原文の中に打つしか無かった。いまは付箋をダブルクリックすると小さな欄が開く(Enter で確定・Esc でやめる)。
 *
 * 見るのは 4 つ: ①書換の記法(中身だけ・構造を壊す字は断る・別の窓が先に直していたら断る)
 * ②画面の入口(ダブルクリックで欄が開く / 置いたノートの付箋・付箋の中の押せる物では開かない)
 * ③確定すると本文の書換が頼まれる ④Esc は何も書かない。
 */
import { describe, expect, it } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { initialState, type AppState, type DomainEvent } from '../../src/adapter/state/app-state';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { applyPlaceLayout } from '../../src/adapter/ui/render/place-board';
import { applyBodyRewrite, type BodyRewrite } from '../../src/features/markdown/body-rewrite';
import { placeTextOf, setPlaceText } from '../../src/features/markdown/place-notation';

const BOARD = [
  ':::format{#p1 .pkc-place x=120 y=40 w=320 h=200}',
  '買い出し',
  '- 牛乳',
  ':::',
  '',
  ':::format{#p2 .pkc-place x=460 y=40 w=240 h=120}',
  '',
  ':::',
  '',
  ':::format{#p3 .pkc-place entry=n2 x=700 y=40}',
  ':::',
].join('\n');

describe('付箋の字の記法(#1662 1)', () => {
  it('中身は開き行と閉じの間 ── 空の付箋は空 / 別のノートを置いた付箋は字を持たない', () => {
    expect(placeTextOf(BOARD, 0)).toBe('買い出し\n- 牛乳');
    expect(placeTextOf(BOARD, 5)).toBe('');
    expect(placeTextOf(BOARD, 9), '置いたノートの付箋に字の口を出した').toBeNull();
    expect(placeTextOf(BOARD, 1), '開き行でない行を付箋と読んだ').toBeNull();
  });

  it('🔴 書き換えるのは中身だけ ── 開き行(位置・大きさ)も隣の付箋も 1 バイトも動かない', () => {
    const next = setPlaceText(BOARD, { line: 5, openLine: BOARD.split('\n')[5]! }, '', 'りんご\nみかん')!;
    expect(next).toBe(BOARD.replace(':::format{#p2 .pkc-place x=460 y=40 w=240 h=120}\n\n:::', ':::format{#p2 .pkc-place x=460 y=40 w=240 h=120}\nりんご\nみかん\n:::'));
    // 戻せる(双方向): 空にすると、置いたときと同じ空行 1 本に戻る
    const back = setPlaceText(next, { line: 5, openLine: next.split('\n')[5]! }, 'りんご\nみかん', '')!;
    expect(back).toBe(BOARD);
  });

  it('字が前と同じなら本文をそのまま返す(書く物が無い ≠ 競合)', () => {
    expect(setPlaceText(BOARD, { line: 0, openLine: BOARD.split('\n')[0]! }, '買い出し\n- 牛乳', '買い出し\n- 牛乳\n')).toBe(BOARD);
  });

  it('🔴 別の窓が先にこの付箋の字を直していたら、黙って上書きせず断る', () => {
    expect(setPlaceText(BOARD, { line: 0, openLine: BOARD.split('\n')[0]! }, '古い字', '新しい字')).toBeNull();
  });

  it('🔴 付箋の枠を壊す字は断る(行頭の ::: で早く閉じる / 閉じない ``` で下の本文を飲む)', () => {
    const t = { line: 5, openLine: BOARD.split('\n')[5]! };
    expect(setPlaceText(BOARD, t, '', 'あ\n:::\nい')).toBeNull();
    expect(setPlaceText(BOARD, t, '', '```\nコード')).toBeNull();
    // 対照群: 閉じた囲みなら入れられる(断る理由が「枠を壊すから」であって、記号が嫌なのではない)
    expect(setPlaceText(BOARD, t, '', '```\nコード\n```')).not.toBeNull();
  });

  it('開き行が掴んだ時点と違うときは書かない(別の窓が行を動かした形)', () => {
    expect(setPlaceText(BOARD, { line: 5, openLine: ':::format{#zz .pkc-place}' }, '', 'あ')).toBeNull();
  });
});

const RENDERED = [
  '<div class="pkc-format-block pkc-place" id="p1" data-pkc-format-block data-pkc-h="200" data-pkc-w="320" data-pkc-x="120" data-pkc-y="40" data-pkc-source-line="0" data-pkc-source-end="3"><p>買い出し</p></div>',
  '<div class="pkc-format-block pkc-place" id="p2" data-pkc-format-block data-pkc-h="120" data-pkc-w="240" data-pkc-x="460" data-pkc-y="40" data-pkc-source-line="5" data-pkc-source-end="7"></div>',
  '<div class="pkc-format-block pkc-place" id="p3" data-pkc-format-block data-pkc-entry="n2" data-pkc-x="700" data-pkc-y="40" data-pkc-source-line="9" data-pkc-source-end="10"></div>',
].join('\n');

function setup() {
  document.body.innerHTML = '';
  const root = document.createElement('div');
  root.setAttribute('data-pkc-slot', 'root');
  root.innerHTML = '<div data-pkc-region="detail"><div data-pkc-field="detail-body" class="pkc-md-rendered"></div></div>';
  document.body.append(root);
  const host = root.querySelector<HTMLElement>('[data-pkc-field="detail-body"]')!;
  host.innerHTML = RENDERED;
  applyPlaceLayout(host, () => null, 0);
  const metas = new Map(
    ['n1', 'n2'].map((lid, i) => [
      lid,
      { lid, title: lid, archetype: 'text', createdAt: null, updatedAt: null, entryOrder: i + 1, status: null, date: null, archived: false },
    ]),
  ) as unknown as AppState['entryMetas'];
  const d = new Dispatcher({
    ...initialState,
    cid: 'c1',
    phase: 'ready',
    selectedLid: 'n1',
    entryMetas: metas,
    openBody: { lid: 'n1', body: BOARD, baseline: BOARD, persisted: BOARD, diskAhead: false },
  });
  const events: DomainEvent[] = [];
  d.onEvent((e) => void events.push(e));
  bindActions(root, d, {});
  const sticky = (id: string): HTMLElement => host.querySelector<HTMLElement>(`#${id}`)!;
  const dbl = (el: Element): void => void el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
  const field = (): HTMLTextAreaElement | null =>
    host.querySelector<HTMLTextAreaElement>('[data-pkc-field="place-inline-input"]');
  return { d, events, host, sticky, dbl, field };
}

const tick = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await new Promise((r) => setTimeout(r, 5));
};
const key = (el: Element, k: string, shift = false): void =>
  void el.dispatchEvent(new KeyboardEvent('keydown', { key: k, shiftKey: shift, bubbles: true, cancelable: true }));

describe('付箋をダブルクリックして字を入れる(#1662 1)', () => {
  it('🔴 空の付箋をダブルクリックすると欄が開き、Enter で確定すると本文の書換が頼まれる', async () => {
    const s = setup();
    expect(s.sticky('p2').getAttribute('data-pkc-place-line'), '前提が崩れている: 付箋に行番号が焼かれていない').toBe('5');
    s.dbl(s.sticky('p2'));
    expect(s.field(), 'ダブルクリックしても欄が開かない').not.toBeNull();
    expect(s.field()!.value).toBe('');
    s.field()!.value = 'りんご';
    key(s.field()!, 'Enter');
    await tick();
    const ev = s.events.find((e) => e.type === 'REQUEST_BODY_REWRITE');
    expect(ev, '書換が頼まれていない').toBeDefined();
    const rw = (ev as { rewrite: BodyRewrite }).rewrite;
    expect(rw).toMatchObject({ kind: 'place-text', line: 5, text: 'りんご' });
    expect(applyBodyRewrite(BOARD, rw)).toContain(':::format{#p2 .pkc-place x=460 y=40 w=240 h=120}\nりんご\n:::');
    expect(s.field(), '確定したのに欄が残っている').toBeNull();
  });

  it('字の入った付箋は、いまの字が入った欄が開く / Shift+Enter は確定せず改行の口', async () => {
    const s = setup();
    s.dbl(s.sticky('p1'));
    expect(s.field()!.value).toBe('買い出し\n- 牛乳');
    key(s.field()!, 'Enter', true);
    await tick();
    expect(s.events.some((e) => e.type === 'REQUEST_BODY_REWRITE'), 'Shift+Enter で確定した').toBe(false);
    expect(s.field(), 'Shift+Enter で欄が閉じた').not.toBeNull();
  });

  it('🔴 Esc は何も書かず欄を閉じる', async () => {
    const s = setup();
    s.dbl(s.sticky('p2'));
    s.field()!.value = '書きかけ';
    key(s.field()!, 'Escape');
    await tick();
    expect(s.field()).toBeNull();
    expect(s.events.some((e) => e.type === 'REQUEST_BODY_REWRITE')).toBe(false);
  });

  it('字を変えずに確定したら、何も書かずに閉じる', async () => {
    const s = setup();
    s.dbl(s.sticky('p1'));
    key(s.field()!, 'Enter');
    await tick();
    expect(s.field()).toBeNull();
    expect(s.events.some((e) => e.type === 'REQUEST_BODY_REWRITE')).toBe(false);
  });

  it('🔴 枠を壊す字は、書換を頼まずに理由を出して欄に字を残す', async () => {
    const s = setup();
    s.dbl(s.sticky('p2'));
    s.field()!.value = 'あ\n:::\nい';
    key(s.field()!, 'Enter');
    await tick();
    expect(s.events.some((e) => e.type === 'REQUEST_BODY_REWRITE')).toBe(false);
    expect(s.field()!.value, '字が消えた').toBe('あ\n:::\nい');
    expect(s.d.getState().error ?? '').toContain('付箋に入れられません');
  });

  it('⚠ 置いたノートの付箋・編集中は欄を開かない(編集中は理由を言う)', () => {
    const s = setup();
    s.dbl(s.sticky('p3'));
    expect(s.field(), '置いたノートの付箋に字の欄を出した').toBeNull();
    s.d.dispatch({ type: 'START_EDIT' });
    s.dbl(s.sticky('p2'));
    expect(s.field(), '編集中に欄を開いた').toBeNull();
    expect(s.d.getState().error ?? '').toContain('付箋の字を直してください');
  });
});
