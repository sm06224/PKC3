/** @vitest-environment happy-dom */
/**
 * 🔴 **貼付の切替が、設定画面から触れる**(user 指示 2026-08-25)。
 *
 * > 「**無言でHTMLペーストを取得する以外のスイッチ経路を用意するなど、
 * > 実用とデバッグを兼用する工夫をしなさい / そのために設定やフラグはあるんだから!**」
 *
 * ⚠ ここが守るのは「**設定に在って、押せて、映る**」の 3 つである ──
 * 判定は `tests/features/paste-source.test.ts`、貼付の配線は
 * `tests/adapter/paste-text.test.ts`。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { SettingsRenderer } from '@adapter/ui/render/settings';
import { PasteSourceStore } from '@adapter/ui/render/paste-source';
import { bindActions } from '@adapter/ui/actions/binder';
import { Dispatcher } from '@adapter/state/dispatcher';
import { initialState } from '@adapter/state/app-state';
import { PASTE_SOURCES } from '@features/markdown/paste-source';

function fakeStorage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
  };
}

function setup(stored?: string) {
  document.body.textContent = '';
  const host = document.createElement('div');
  document.body.append(host);
  const storage = fakeStorage();
  if (stored !== undefined) storage.map.set('pkc3.paste-source', stored);
  const store = new PasteSourceStore(storage);
  const r = new SettingsRenderer(
    host,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    store,
  );
  r.render(initialState);
  const select = host.querySelector<HTMLSelectElement>('[data-pkc-field="paste-source-select"]');
  return { host, store, select, storage, r };
}

beforeEach(() => {
  document.body.textContent = '';
});

describe('設定画面に在る', () => {
  it('🔴 4 択が並ぶ(自動 / ウェブページの形だけ / リッチテキストを優先 / 変換しない)', () => {
    const { select } = setup();
    expect(select, '設定に貼付の切替が無い').not.toBeNull();
    expect([...select!.options].map((o) => o.value)).toEqual(PASTE_SOURCES.map((s) => s.id));
  });

  it('⚠ どれを選べばよいか分かる説明が付いている', () => {
    const { select } = setup();
    for (const o of [...select!.options]) expect(o.title.length).toBeGreaterThan(8);
  });

  it('🔴 診断のフラグへの導線が説明に在る(2 つで 1 組であることが分かる)', () => {
    const { host } = setup();
    const section = host.querySelector('[data-pkc-region="settings-paste-source"]')!;
    expect(section.textContent, 'フラグとの対が説明されていない').toContain('何が届いて');
  });
});

describe('保存した値が映る', () => {
  it('🔴 保存済みの選択が、開いたときに出ている(古い値を見せない)', () => {
    const { select } = setup('rtf');
    expect(select!.value, '保存した設定が画面に映っていない').toBe('rtf');
  });

  it('壊れた保存値は既定に落ちる(落ちない)', () => {
    const { select, store } = setup('でたらめ');
    expect(store.get()).toBe('auto');
    expect(select!.value).toBe('auto');
  });
});

describe('押すと変わる', () => {
  it('🔴 選ぶと保存され、次に開いたときも残る', () => {
    const { host, storage } = setup();
    const dispatcher = new Dispatcher();
    let asked: string | null = null;
    bindActions(host, dispatcher, {
      setPasteSource: (id) => {
        asked = id;
      },
    });
    const select = host.querySelector<HTMLSelectElement>('[data-pkc-field="paste-source-select"]')!;
    select.value = 'rtf';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    expect(asked, '選んでも呼ばれていない').toBe('rtf');

    // 呼び側(main)がやることを再現 ── 保存して、次に開くと映る
    const store = new PasteSourceStore(storage);
    expect(store.set('rtf')).toBe(true);
    expect(storage.map.get('pkc3.paste-source')).toBe('rtf');
    expect(new PasteSourceStore(storage).get()).toBe('rtf');
  });

  it('⚠ 同じ値を選び直しても「変わった」と言わない(無駄に描き直さない)', () => {
    const storage = fakeStorage();
    const store = new PasteSourceStore(storage);
    expect(store.set('rtf')).toBe(true);
    expect(store.set('rtf')).toBe(false);
  });

  it('⚠ 保存できない環境でも、この session では効く(黙って戻さない)', () => {
    const store = new PasteSourceStore({
      getItem: () => null,
      setItem: () => {
        throw new Error('保存できません');
      },
    });
    expect(store.set('plain')).toBe(true);
    expect(store.get()).toBe('plain');
  });
});
