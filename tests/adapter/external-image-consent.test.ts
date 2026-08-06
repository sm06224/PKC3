/** @vitest-environment happy-dom */
/**
 * 外部画像の設定・ノートごとの同意・確認の帯(2026-08-06、user 裁定)。
 *
 * 意味論(何が「外」か / CSP の形)は `tests/features/external-images.test.ts`。
 * ここが見るのは **保存 / この session の記憶 / 帯の出方 / 描き直しの起点**である。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  buildExternalImageBar,
  ExternalImagePolicy,
} from '../../src/adapter/ui/render/external-images';
import { DetailRenderer } from '../../src/adapter/ui/render/detail';
import type { AppState } from '../../src/adapter/state/app-state';
import { MarkdownClient } from '../../src/adapter/platform/render/markdown-client';

/** 保存先の代わり(実物の localStorage に触らない ── test が互いに干渉する)。 */
function fakeStore(initial?: string): Pick<Storage, 'getItem' | 'setItem'> & { value: string | null } {
  const box = {
    value: initial ?? null,
    getItem: (k: string) => (k === 'pkc3.external-images' ? box.value : null),
    setItem: (k: string, v: string) => {
      if (k === 'pkc3.external-images') box.value = v;
    },
  };
  return box;
}

describe('設定の保存(ExternalImagePolicy)', () => {
  it('何も保存されていなければ「常に確認」', () => {
    expect(new ExternalImagePolicy(fakeStore()).getMode()).toBe('ask');
  });

  it('保存されていればそれを使う。壊れた値は既定に落ちる', () => {
    expect(new ExternalImagePolicy(fakeStore('never')).getMode()).toBe('never');
    expect(new ExternalImagePolicy(fakeStore('auto')).getMode()).toBe('ask');
  });

  it('選ぶと保存される。同じ値なら「変わった」と言わない', () => {
    const store = fakeStore();
    const p = new ExternalImagePolicy(store);
    expect(p.setMode('always')).toBe(true);
    expect(store.value).toBe('always');
    expect(p.setMode('always')).toBe(false); // 無駄な描き直しをさせない
    expect(p.setMode('nonsense')).toBe(false);
    expect(store.value).toBe('always');
  });

  /**
   * ⚠ 保存できない環境(プライベートモード等で投げる)でも**落ちない**。
   * この session では効いている、という位置づけ(`theme.ts` と同じ)。
   */
  it('保存が投げても落ちない(この session では効く)', () => {
    const throwing = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    const p = new ExternalImagePolicy(throwing);
    expect(p.getMode()).toBe('ask');
    expect(p.setMode('never')).toBe(true);
    expect(p.getMode()).toBe('never');
  });

  it('保存先が無くても既定で動く', () => {
    const p = new ExternalImagePolicy(null);
    expect(p.getMode()).toBe('ask');
    expect(p.setMode('always')).toBe(true);
    expect(p.allows('a')).toBe(true);
  });
});

describe('ノートごとの判定(allows)', () => {
  /**
   * 🔴 **迷子の同意で「常にオフ」が破れない**(2026-08-06、変異試験 M19 が
   * 生き延びて判明)。画面上は「常にオフ」で帯が出ないので `answer()` は
   * 呼ばれない ── だからこの守りが**効いているかどうか誰も見ていなかった**。
   * ⚠ ここが破れると、user が「オフ」にしたのに読み込むノートができる。
   */
  it('常にオフは、ノートごとの同意があっても読み込まない', () => {
    const p = new ExternalImagePolicy(fakeStore('never'));
    p.answer('a', 'allow');
    expect(p.allows('a')).toBe(false);
  });

  it('常にオン / 常にオフは聞かない', () => {
    const on = new ExternalImagePolicy(fakeStore('always'));
    const off = new ExternalImagePolicy(fakeStore('never'));
    expect(on.allows('a')).toBe(true);
    expect(on.unanswered('a')).toBe(false);
    expect(off.allows('a')).toBe(false);
    expect(off.unanswered('a')).toBe(false);
  });

  it('常に確認は既定で読み込まない。答えるとそのノートだけ変わる', () => {
    const p = new ExternalImagePolicy(fakeStore('ask'));
    expect(p.allows('a')).toBe(false);
    expect(p.unanswered('a')).toBe(true);
    expect(p.answer('a', 'allow')).toBe(true);
    expect(p.allows('a')).toBe(true);
    expect(p.unanswered('a')).toBe(false);
    // ⚠ **別のノートには効かない**(ノート単位という主張の本体)
    expect(p.allows('b')).toBe(false);
    expect(p.unanswered('b')).toBe(true);
  });

  it('「読み込まない」も覚える ── 同じ帯を出し続けない', () => {
    const p = new ExternalImagePolicy(fakeStore('ask'));
    expect(p.answer('a', 'deny')).toBe(true);
    expect(p.allows('a')).toBe(false);
    expect(p.unanswered('a')).toBe(false);
    expect(p.answer('a', 'deny')).toBe(false); // 描き直させない
  });

  /**
   * 🔴 **設定を触ったらノートごとの同意は捨てる**。残すと「常にオフにしたのに
   * このノートだけ出続ける」になり、設定が嘘になる。
   */
  it('設定を変えるとノートごとの同意は消える', () => {
    const p = new ExternalImagePolicy(fakeStore('ask'));
    p.answer('a', 'allow');
    expect(p.allows('a')).toBe(true);
    p.setMode('never');
    expect(p.allows('a')).toBe(false);
    p.setMode('ask');
    expect(p.unanswered('a')).toBe(true); // 答えは残っていない
  });
});

describe('箱からの申告', () => {
  it('累計だけ増える。減る申告は無視する', () => {
    const p = new ExternalImagePolicy(fakeStore('ask'));
    expect(p.blockedBoxCount('a')).toBe(0);
    expect(p.noteBlockedBox('a', 2)).toBe(true);
    expect(p.blockedBoxCount('a')).toBe(2);
    expect(p.noteBlockedBox('a', 2)).toBe(false); // 同じ数は「変わっていない」
    expect(p.noteBlockedBox('a', 1)).toBe(false);
    expect(p.noteBlockedBox('a', 5)).toBe(true);
    expect(p.blockedBoxCount('a')).toBe(5);
    expect(p.blockedBoxCount('b')).toBe(0);
  });

  it('答えたら数え直す(許可すれば止まらなくなる)', () => {
    const p = new ExternalImagePolicy(fakeStore('ask'));
    p.noteBlockedBox('a', 3);
    p.forgetBlockedBoxes('a');
    expect(p.blockedBoxCount('a')).toBe(0);
  });
});

describe('確認の帯(buildExternalImageBar)', () => {
  it('2 つの答えだけを置く ── 設定への近道は置かない', () => {
    const bar = buildExternalImageBar(2, 0);
    const actions = [...bar.querySelectorAll('button')].map((b) =>
      b.getAttribute('data-pkc-action'),
    );
    expect(actions).toEqual(['allow-external-images', 'deny-external-images']);
    // ⚠ 1 件の判断で全ノートの既定を動かす導線を混ぜていないこと
    expect(bar.textContent).not.toContain('今後');
    expect(bar.querySelector('select')).toBeNull();
  });

  it('何が伝わるのかを書く(件数だけの帯にしない)', () => {
    const text = buildExternalImageBar(2, 0).textContent ?? '';
    expect(text).toContain('2 件');
    expect(text).toContain('いまこれを開いた');
  });

  it('本文だけ / 箱だけ / 両方で言い方が変わる', () => {
    expect(buildExternalImageBar(2, 0).textContent).toContain('外部の画像が 2 件あります');
    expect(buildExternalImageBar(0, 3).textContent).toContain('HTML の中で外部の画像が 3 件');
    const both = buildExternalImageBar(2, 3).textContent ?? '';
    expect(both).toContain('外部の画像が 2 件、HTML の中に 3 件');
  });
});

/**
 * 詳細ペインの結線。
 *
 * ⚠ 本文の描画は `MarkdownClient`(worker が無い環境では同じ関数をその場で回す)
 * なので **非同期**である ── `await Promise.resolve()` を数回回して落ち着かせる。
 */
describe('詳細ペインとの結線', () => {
  function stateWith(body: string, lid = 'n1'): AppState {
    return {
      phase: 'ready',
      selectedLid: lid,
      openBody: { lid, body, baseline: body, persisted: body, diskAhead: false },
      entryMetas: new Map([[lid, { lid, title: '題', archetype: 'text' }]]),
      revisionPanel: null,
      error: null,
      viewMode: 'detail',
    } as unknown as AppState;
  }

  async function settle(): Promise<void> {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  }

  function mount(policy: ExternalImagePolicy): {
    region: HTMLElement;
    renderer: DetailRenderer;
  } {
    const region = document.createElement('div');
    document.body.append(region);
    const renderer = new DetailRenderer(region, null, new MarkdownClient({}), null, policy);
    return { region, renderer };
  }

  const BODY = '![a](https://example.com/x.png)\n';

  it('「常に確認」では読み込まず、帯が出る', async () => {
    const { region, renderer } = mount(new ExternalImagePolicy(fakeStore('ask')));
    renderer.render(stateWith(BODY));
    await settle();
    const img = region.querySelector('img')!;
    expect(img).not.toBeNull();
    expect(img.hasAttribute('src')).toBe(false);
    expect(region.querySelector('[data-pkc-field="external-image-bar"]')).not.toBeNull();
    region.remove();
  });

  it('「常にオン」では読み込み、帯は出ない', async () => {
    const { region, renderer } = mount(new ExternalImagePolicy(fakeStore('always')));
    renderer.render(stateWith(BODY));
    await settle();
    expect(region.querySelector('img')!.getAttribute('src')).toBe('https://example.com/x.png');
    expect(region.querySelector('[data-pkc-field="external-image-bar"]')).toBeNull();
    region.remove();
  });

  it('「常にオフ」では読み込まず、帯も出ない(聞かないと決めたので)', async () => {
    const { region, renderer } = mount(new ExternalImagePolicy(fakeStore('never')));
    renderer.render(stateWith(BODY));
    await settle();
    expect(region.querySelector('img')!.hasAttribute('src')).toBe(false);
    expect(region.querySelector('[data-pkc-field="external-image-bar"]')).toBeNull();
    region.remove();
  });

  /**
   * 🔴 **外部画像を 1 枚も持たないノートでは帯を出さない**。出すとほぼ全ノートで
   * 出ることになり、user は中身を読まずに押すようになる(帯の信用が落ちる)。
   */
  it('外部画像が無いノートでは帯を出さない', async () => {
    const { region, renderer } = mount(new ExternalImagePolicy(fakeStore('ask')));
    renderer.render(stateWith('ただの本文\n\n![b](asset:k1)\n'));
    await settle();
    expect(region.querySelector('[data-pkc-field="external-image-bar"]')).toBeNull();
    region.remove();
  });

  /**
   * 🔴 **同意が state を動かさないので、指紋を崩さないと何も起きない**。
   * これが `invalidate()` の存在理由 ── 無いと押しても 1 ドットも変わらない。
   */
  it('同意 → invalidate → render で src が載り、帯が消える', async () => {
    const policy = new ExternalImagePolicy(fakeStore('ask'));
    const { region, renderer } = mount(policy);
    const state = stateWith(BODY);
    renderer.render(state);
    await settle();
    expect(region.querySelector('img')!.hasAttribute('src')).toBe(false);

    policy.answer('n1', 'allow');
    renderer.invalidate();
    renderer.render(state);
    await settle();
    expect(region.querySelector('img')!.getAttribute('src')).toBe('https://example.com/x.png');
    expect(region.querySelector('[data-pkc-field="external-image-bar"]')).toBeNull();
    region.remove();
  });

  it('invalidate を呼ばないと描き直されない(指紋が効いている)', async () => {
    const policy = new ExternalImagePolicy(fakeStore('ask'));
    const { region, renderer } = mount(policy);
    const state = stateWith(BODY);
    renderer.render(state);
    await settle();
    policy.answer('n1', 'allow');
    renderer.render(state); // ⚠ invalidate なし
    await settle();
    expect(region.querySelector('img')!.hasAttribute('src')).toBe(false);
    region.remove();
  });

  /**
   * 箱からの申告は**帯だけ**出し直す(描き直すと箱が作り直されて中身が一度消える)。
   */
  it('箱の申告で帯が出る(本文の画像が 0 件でも)', async () => {
    const policy = new ExternalImagePolicy(fakeStore('ask'));
    const { region, renderer } = mount(policy);
    renderer.render(stateWith('```html\n<b>x</b>\n```\n'));
    await settle();
    expect(region.querySelector('[data-pkc-field="external-image-bar"]')).toBeNull();
    renderer.noteBlockedBox('n1', 2);
    const bar = region.querySelector('[data-pkc-field="external-image-bar"]');
    expect(bar).not.toBeNull();
    expect(bar!.textContent).toContain('HTML の中で外部の画像が 2 件');
    // ⚠ 箱そのものは作り直されていない(iframe は 1 個のまま)
    expect(region.querySelectorAll('iframe').length).toBe(1);
    region.remove();
  });

  /**
   * 🔴 **添付の説明文も本文と同じ扱い**(2026-08-06、変異試験 M30 が生き延びて判明)。
   * ここは別の描画経路(その場で同期に描く)なので、渡し忘れると
   * **「添付の説明に書いた追跡画像だけが設定を無視する」**という穴になる。
   */
  it('添付の説明の中の外部画像も設定に従う', async () => {
    const body =
      '---\nattachment.name: a.bin\nattachment.mime: application/octet-stream\n---\n' +
      '![絵](https://example.com/d.png)\n';
    const attachState = (lid: string): AppState =>
      ({
        phase: 'ready',
        selectedLid: lid,
        openBody: { lid, body, baseline: body, persisted: body, diskAhead: false },
        entryMetas: new Map([[lid, { lid, title: '添付', archetype: 'attachment' }]]),
        revisionPanel: null,
        error: null,
        viewMode: 'detail',
      }) as unknown as AppState;

    const off = mount(new ExternalImagePolicy(fakeStore('ask')));
    off.renderer.render(attachState('a1'));
    await settle();
    const blocked = off.region.querySelector('img')!;
    expect(blocked, '説明が描かれていない').not.toBeNull();
    expect(blocked.hasAttribute('src')).toBe(false);
    off.region.remove();

    const on = mount(new ExternalImagePolicy(fakeStore('always')));
    on.renderer.render(attachState('a2'));
    await settle();
    expect(on.region.querySelector('img')!.getAttribute('src')).toBe('https://example.com/d.png');
    on.region.remove();
  });

  it('別のノートの箱の申告では帯を出さない', async () => {
    const policy = new ExternalImagePolicy(fakeStore('ask'));
    const { region, renderer } = mount(policy);
    renderer.render(stateWith('```html\n<b>x</b>\n```\n'));
    await settle();
    renderer.noteBlockedBox('other', 2);
    expect(region.querySelector('[data-pkc-field="external-image-bar"]')).toBeNull();
    region.remove();
  });

  it('答えたノートには箱の申告でも帯を出さない', async () => {
    const policy = new ExternalImagePolicy(fakeStore('ask'));
    const { region, renderer } = mount(policy);
    renderer.render(stateWith('```html\n<b>x</b>\n```\n'));
    await settle();
    policy.answer('n1', 'deny');
    renderer.noteBlockedBox('n1', 2);
    expect(region.querySelector('[data-pkc-field="external-image-bar"]')).toBeNull();
    region.remove();
  });
});

/**
 * 🔴 **設定画面は現在の値を映す**(2026-08-06、変異試験 M31 が生き延びて判明)。
 * 器は 1 度しか組まないので、映さないと**別の面へ行って戻ったときに古い値**が
 * 見える ── user は「変えたのに戻っている」と読む(`syncTheme` と同じ理由)。
 */
describe('設定画面', () => {
  it('保存されている値が選ばれている。変えた後に再描画しても追いつく', async () => {
    const { SettingsRenderer } = await import('../../src/adapter/ui/render/settings');
    const region = document.createElement('div');
    document.body.append(region);
    const policy = new ExternalImagePolicy(fakeStore('never'));
    const monitor = { subscribe: () => () => {}, stats: () => [], recent: () => [] };
    const r = new SettingsRenderer(region, monitor as never, policy);
    const state = { viewMode: 'settings' } as unknown as AppState;
    r.render(state);
    const select = region.querySelector<HTMLSelectElement>(
      '[data-pkc-field="external-images-select"]',
    )!;
    expect(select, '選択肢が無い').not.toBeNull();
    expect(select.value).toBe('never');
    policy.setMode('always');
    r.render(state); // 2 度目は組み直さない ── それでも値は追いつく
    expect(select.value).toBe('always');
    region.remove();
  });
});

describe('binder の口', () => {
  it('設定の select と帯のボタンが services を呼ぶ', async () => {
    const { bindActions } = await import('../../src/adapter/ui/actions/binder');
    const root = document.createElement('div');
    document.body.append(root);
    const setExternalImages = vi.fn();
    const answerExternalImages = vi.fn();
    const dispatcher = {
      dispatch: vi.fn(),
      getState: () => ({ entryMetas: new Map() }) as unknown as AppState,
    };
    bindActions(root, dispatcher as never, { setExternalImages, answerExternalImages });

    const select = document.createElement('select');
    select.setAttribute('data-pkc-action', 'set-external-images');
    for (const v of ['always', 'ask', 'never']) {
      const o = document.createElement('option');
      o.value = v;
      select.append(o);
    }
    select.value = 'never';
    root.append(select, buildExternalImageBar(1, 0));
    select.dispatchEvent(new Event('change', { bubbles: true }));
    expect(setExternalImages).toHaveBeenCalledWith('never');

    root.querySelector<HTMLButtonElement>('[data-pkc-action="allow-external-images"]')!.click();
    root.querySelector<HTMLButtonElement>('[data-pkc-action="deny-external-images"]')!.click();
    expect(answerExternalImages.mock.calls).toEqual([[true], [false]]);
    root.remove();
  });
});
