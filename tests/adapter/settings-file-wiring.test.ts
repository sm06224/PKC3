/** @vitest-environment happy-dom */
/**
 * 🔴 **設定の持ち出し ── 画面との繋がり**(#414)。
 *
 * ⚠ **仕分けと文言**(何を運ぶか / 何が変わるか)は
 *   `tests/features/settings-file.test.ts`。ここが見るのは**繋がり**である ──
 *   選んだら下見が出るか / 押したら本当に書かれるか / 押せない場面で押せないか。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Dispatchable } from '../../src/adapter/state/app-state';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { SettingsRenderer } from '../../src/adapter/ui/render/settings';
import { initialState } from '../../src/adapter/state/app-state';
import { MAX_SETTING_CHARS, SETTINGS_FILE_KIND } from '../../src/features/settings/settings-file';
import { SETTINGS_NOT_PERSISTED_TEXT } from '../../src/adapter/ui/render/settings-persist-probe';

const tick = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};

function setup() {
  document.body.innerHTML = '';
  localStorage.clear();
  const root = document.createElement('div');
  document.body.append(root);
  buildShell(root);
  /**
   * ⚠ **設定の面は `buildShell` に含まれない** ── 自分で組む
   *   (`announce.test.ts` と同じ作法)。⚠ `root` の中に置く ── binder は
   *   `root` への委譲で押し口を拾うので、外に置くと**押しても何も起きない**。
   */
  const settingsHost = document.createElement('div');
  root.append(settingsHost);
  new SettingsRenderer(settingsHost).render(initialState);
  const d = new Dispatcher();
  const sent: Dispatchable[] = [];
  const raw = d.dispatch.bind(d);
  d.dispatch = ((a: Dispatchable) => {
    sent.push(a);
    return raw(a);
  }) as typeof d.dispatch;
  bindActions(root, d);
  return { root, d, sent };
}

const apply = (root: HTMLElement): HTMLButtonElement =>
  root.querySelector<HTMLButtonElement>('[data-pkc-field="settings-file-apply"]')!;
const summary = (root: HTMLElement): HTMLElement =>
  root.querySelector<HTMLElement>('[data-pkc-field="settings-file-summary"]')!;
const changes = (root: HTMLElement): HTMLElement =>
  root.querySelector<HTMLElement>('[data-pkc-field="settings-file-changes"]')!;

/** file を選んだことにする(`change` を撃つ)。 */
async function choose(root: HTMLElement, text: string): Promise<void> {
  const input = root.querySelector<HTMLInputElement>('[data-pkc-field="settings-file-input"]')!;
  const file = new File([text], 'settings.json', { type: 'application/json' });
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  input.dispatchEvent(new Event('change', { bubbles: true }));
  await tick();
}

const fileText = (entries: { key: string; value: string }[]): string =>
  JSON.stringify({ kind: SETTINGS_FILE_KIND, version: 1, entries });

beforeEach(() => {
  document.body.innerHTML = '';
  localStorage.clear();
});

describe('設定の持ち出しの配線(#414)', () => {
  it('🔴 選ぶ前は押せない(dead click を作らない)', () => {
    const { root } = setup();
    expect(apply(root).disabled, '選ぶ前から押せる').toBe(true);
    expect(summary(root).hidden, '何も選んでいないのに文が出ている').toBe(true);
  });

  /** 🔴 **選んだ時点では当てない** ── 下見を出すだけ。 */
  it('🔴 選ぶと下見が出るが、まだ当たっていない', async () => {
    const { root } = setup();
    localStorage.setItem('pkc3.theme', 'light');
    await choose(root, fileText([{ key: 'pkc3.theme', value: 'dark' }]));
    expect(summary(root).hidden, '下見が出ていない').toBe(false);
    expect(changes(root).textContent, '何が変わるかが出ていない').toContain('見た目');
    expect(apply(root).disabled, '変わるのに押せない').toBe(false);
    // 🔴 **まだ書かれていない**(押す前に当たっていたら取り消せない)
    expect(localStorage.getItem('pkc3.theme'), '選んだだけで当たった').toBe('light');
  });

  it('🔴 押すと書かれ、下見は畳まれる', async () => {
    const { root, sent } = setup();
    localStorage.setItem('pkc3.theme', 'light');
    await choose(root, fileText([{ key: 'pkc3.theme', value: 'dark' }]));
    sent.length = 0;
    apply(root).click();
    await tick();
    expect(localStorage.getItem('pkc3.theme'), '押しても書かれていない').toBe('dark');
    expect(apply(root).disabled, '押した後も押せるまま').toBe(true);
    expect(summary(root).hidden, '下見が残っている').toBe(true);
    /**
     * 🔴 **読み直しが要ることを言う** ── 鍵の割当も紙面も起動時に読むので、
     *   当てただけでは画面が変わらない。⚠ 言わないと「効かなかった」と読まれる。
     */
    const said = sent.find((a) => a.type === 'OP_NOTICE');
    expect(said, '何も言わずに終えた').toBeDefined();
    const msg = said?.type === 'OP_NOTICE' ? said.message : '';
    expect(msg, '読み直しが要ることを言っていない').toContain('再読み込み');
    // 🔴 入った回を「問題」(`OP_FAILED` → 未読の問題)として言わない(#1087)
    expect(
      sent.some((a) => a.type === 'OP_FAILED'),
      '成功を OP_FAILED で言った(問題の未読に数えられる)',
    ).toBe(false);
  });

  /** 🔴 一部だけ書き出せた回は、赤い帯で言う(取りこぼしを見逃させない。台帳 #1852 束 L2、依頼 120-1 A)。 */
  it('🔴 一部だけ書き出せた回は、赤い帯で言う', async () => {
    const { root, sent } = setup();
    localStorage.setItem('pkc3.theme', 'dark');
    localStorage.setItem('pkc3.messages.cap', 'x'.repeat(MAX_SETTING_CHARS + 1));
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    sent.length = 0;
    root.querySelector<HTMLElement>('[data-pkc-action="export-settings"]')!.click();
    await tick();
    vi.restoreAllMocks();
    const said = sent.find((a) => a.type === 'OP_FAILED');
    expect(said?.type === 'OP_FAILED' ? said.error : '').toContain('長すぎるので入っていません');
    // 対照:赤くなるのは一部入らなかった回だけ(全部入った回は上の test が OP_NOTICE を見る)
    expect(sent.some((a) => a.type === 'OP_NOTICE')).toBe(false);
  });

  /** 🔴 **書けなかった件数を言う**(#1087)── 全部書けなくても成功と同じ字にしない。 */
  it('🔴 この端末に保存できなかった設定は、件数で言う', async () => {
    const { root, sent } = setup();
    await choose(root, fileText([{ key: 'pkc3.theme', value: 'dark' }]));
    sent.length = 0;
    const spy = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    try {
      apply(root).click();
      await tick();
    } finally {
      spy.mockRestore();
    }
    const said = sent.find((a) => a.type === 'OP_FAILED');
    const msg = said?.type === 'OP_FAILED' ? said.error : '';
    expect(msg, '書けなかったことを言っていない').toContain('1 件はこの端末に保存できず');
    expect(localStorage.getItem('pkc3.theme'), '前提: 書けていない').toBeNull();
  });

  /** 🔴 配色の読み手が読めない値は、下見の時点で入れない(読み手は既定へ丸めるので「入れました」が偽になる)。 */
  it('🔴 知らない配色の id は、入れない(下見で弾く)', async () => {
    const { root } = setup();
    await choose(root, fileText([{ key: 'pkc3.theme', value: 'no-such-theme' }]));
    expect(apply(root).disabled, '読めない配色で押せる').toBe(true);
    expect(summary(root).textContent ?? '').toContain('中身が空か読めない形なので入れません');
    // 対照:選べる配色は押せる
    await choose(root, fileText([{ key: 'pkc3.theme', value: 'dark' }]));
    expect(apply(root).disabled, '読める配色が弾かれた').toBe(false);
  });

  /** 🔴 **運ばない鍵は、file に書いてあっても書き込まない**(許可・フラグ)。 */
  it('🔴 運ばない鍵は、file に在っても書き込まない', async () => {
    const { root } = setup();
    await choose(
      root,
      fileText([
        { key: 'pkc3.theme', value: 'dark' },
        { key: 'pkc3.same-origin-grants', value: '["https://evil.example"]' },
        { key: 'pkc3.flags', value: '{"x":true}' },
      ]),
    );
    apply(root).click();
    await tick();
    expect(localStorage.getItem('pkc3.theme')).toBe('dark');
    expect(localStorage.getItem('pkc3.same-origin-grants'), '許可を書き込んだ').toBeNull();
    expect(localStorage.getItem('pkc3.flags'), 'フラグを書き込んだ').toBeNull();
    // ⚠ 黙って捨てない ── 件数を言う
    expect(summary(root).textContent ?? '', '運ばなかった分を言っていない').not.toBe('');
  });

  it('🔴 別の形の file は、そう言って押せないままにする', async () => {
    const { root } = setup();
    await choose(root, JSON.stringify({ kind: 'pkc3-backup' }));
    expect(apply(root).disabled, '読めない file で押せる').toBe(true);
    expect(summary(root).textContent, '理由が出ていない').toContain('設定ファイルではありません');
  });

  /**
   * 🔴 #1087 A1 ── 読んだ直後に入力を空へ戻す。戻さないと、「読めない」と出た後に直した file を
   * 同じ名前で選び直しても `change` が発火しない。観測点は `value` への書込そのもの
   * (happy-dom の file 入力は値を持たないので、書込を記録する)。
   */
  it('🔴 読めない file を選んだ直後にも、入力の value が空へ戻される', async () => {
    const { root } = setup();
    const input = root.querySelector<HTMLInputElement>('[data-pkc-field="settings-file-input"]')!;
    const writes: string[] = [];
    Object.defineProperty(input, 'value', {
      configurable: true,
      get: () => '',
      set: (v: string) => {
        writes.push(v);
      },
    });
    await choose(root, '{ これは JSON ではない');
    expect(summary(root).textContent, '前提: 読めない回になっていない').toContain('読めませんでした');
    expect(writes, '読んだ後に value を空へ戻していない(同じ名前で選び直せない)').toContain('');
  });

  /** 🔴 **持ち出す物が無いのに空の file を落とさない**(押した user は「入った」と読む)。 */
  it('🔴 設定が 1 つも無ければ、落とさずに理由を出す', async () => {
    const { root, sent } = setup();
    const clicks: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLElement) {
      clicks.push(this.getAttribute('download') ?? '');
    });
    sent.length = 0;
    root.querySelector<HTMLElement>('[data-pkc-action="export-settings"]')!.click();
    await tick();
    expect(clicks, '空の file を落とした').toEqual([]);
    expect(sent.some((a) => a.type === 'OP_FAILED'), '無言で終えた').toBe(true);
    vi.restoreAllMocks();
  });

  /** 🔴 「まだありません」が偽になる 2 つの道(#1087)。 */
  it('🔴 保存できないブラウザ / 長すぎる設定だけのときは、「まだありません」と言わない', async () => {
    const errorOf = (sent: Dispatchable[]): string =>
      (sent.find((a) => a.type === 'OP_FAILED') as { error: string } | undefined)?.error ?? '';
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    // 対照群:保存できて、本当に何も無い
    let ctx = setup();
    ctx.sent.length = 0;
    ctx.root.querySelector<HTMLElement>('[data-pkc-action="export-settings"]')!.click();
    await tick();
    expect(errorOf(ctx.sent)).toContain('持ち出せる設定がまだありません');

    // 長すぎる設定だけが在る
    ctx = setup();
    localStorage.setItem('pkc3.theme', 'x'.repeat(MAX_SETTING_CHARS + 1));
    ctx.sent.length = 0;
    ctx.root.querySelector<HTMLElement>('[data-pkc-action="export-settings"]')!.click();
    await tick();
    expect(errorOf(ctx.sent)).toContain('長すぎるので入りません');
    expect(errorOf(ctx.sent)).not.toContain('まだありません');

    // 保存できないブラウザ
    ctx = setup();
    const spy = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('private mode');
    });
    ctx.sent.length = 0;
    ctx.root.querySelector<HTMLElement>('[data-pkc-action="export-settings"]')!.click();
    await tick();
    spy.mockRestore();
    expect(errorOf(ctx.sent)).toContain(SETTINGS_NOT_PERSISTED_TEXT);
    expect(errorOf(ctx.sent)).not.toContain('まだありません');
    vi.restoreAllMocks();
  });

  it('🔴 設定が在れば、日付つきの名前で落ちる', async () => {
    const { root } = setup();
    localStorage.setItem('pkc3.theme', 'dark');
    const clicks: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLElement) {
      clicks.push(this.getAttribute('download') ?? '');
    });
    root.querySelector<HTMLElement>('[data-pkc-action="export-settings"]')!.click();
    await tick();
    expect(clicks, '落ちていない').toHaveLength(1);
    // 🔑 形だけでなく**実値**(端末の暦日)と一致させる(#709)── `\d{4}-\d{2}-\d{2}` は
    //    UTC の日付でも満たされる。⚠ 期待値は実装と別の綴り(local の getter)で組む。
    //    UTC と JST で答えが分かれる場面は `tests/adapter/export-day-stamp.test.ts`
    const now = new Date();
    const today = [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, '0'),
      String(now.getDate()).padStart(2, '0'),
    ].join('-');
    expect(clicks[0], '名前の日付が端末の暦日でない').toBe(`PKC3-settings-${today}.json`);
    vi.restoreAllMocks();
  });
});
