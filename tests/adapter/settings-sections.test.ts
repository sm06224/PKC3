/** @vitest-environment happy-dom */
/**
 * 設定(システム)画面の「節の登録表」(#1382)。
 *
 * 🔑 守る主張:
 * 1. 登録表の並び = 画面の並び(`build` が返した根が、登録の順に DOM に並ぶ)
 * 2. 🔴 **登録した節の `sync` は、最初の組み立ての直後にも、以後の `render()` のたびにも呼ばれる**
 *    (器は 1 度しか組まないので、映す口を呼び忘れると古い値が見える ── CLAUDE.md §7)
 * 3. 名前は一意。同じ `group` の節は、登録の順に 1 つの `dl` へ並ぶ(`dt` の並びで pin)
 * 4. 🔴 **チェック・選択欄の節は、保存(または `html` の属性)が変わって `render()` し直すと画面が追随する**
 *    (`sync` を空にする変異が落ちる)
 *
 * ⚠ 守っていないもの:各節の説明文の中身(節ごとの test が持つ ── `settings-agents.test.ts` ほか)。
 *   DOM の出力が移す前と 1 バイトも違わないことは、移した日の一回限りの比較で確かめた(常設の test ではない)。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SettingsRenderer } from '@adapter/ui/render/settings';
import { AgentGrants } from '@adapter/platform/agent-grants';
import { AgentTabStatus } from '@adapter/platform/agent-tab-status';
import { SameOriginGrants } from '@adapter/platform/same-origin-grants';
import { ExtensionGrants } from '@adapter/platform/extension-grants';
import { NoticeStore } from '@adapter/platform/notice-store';
import { initialState } from '@adapter/state/app-state';
import { EditorModeStore } from '@adapter/ui/render/editor-mode';
import { OpenInEditStore } from '@adapter/ui/render/open-in-edit';
import { AlarmEnabledStore } from '@adapter/ui/render/alarm-enabled';
import { VoiceBoostStore } from '@adapter/ui/render/voice-boost';
import { PhoneLinksStore } from '@adapter/ui/render/phone-links';
import { DateLinksStore } from '@adapter/ui/render/date-links';
import { RelativeDaysStore } from '@adapter/ui/render/relative-days';
import { ColorSwatchStore } from '@adapter/ui/render/color-swatch';
import { MissingLinksStore } from '@adapter/ui/render/missing-links';
import { CodeCollapseStore } from '@adapter/ui/render/code-collapse';
import { InlineCodeCopyStore } from '@adapter/ui/render/inline-code-copy';
import { PdfReaderStore } from '@adapter/ui/render/pdf-reader-setting';
import { TooNarrowOkStore } from '@adapter/ui/render/too-narrow';
import { PasteSourceStore } from '@adapter/ui/render/paste-source';
import { ExternalImagePolicy } from '@adapter/ui/render/external-images';
import { chooseTextScale } from '@adapter/ui/render/text-scale';
import { chooseColumnRule } from '@adapter/ui/render/column-rule';
import { chooseProseAlign } from '@adapter/ui/render/prose-align';
import { choosePageFormat } from '@adapter/ui/render/page-format';
import { chooseTagBadge } from '@adapter/ui/render/tag-badge';
import { chooseReadColumns } from '@adapter/ui/render/read-columns';
import { chooseOpenPlace } from '@adapter/ui/render/open-place';
import { chooseAppOpenTarget } from '@adapter/ui/render/app-open-target';
import { chooseTheme, THEMES } from '@adapter/ui/render/theme';
import { TEXT_SCALES } from '@features/text-scale';
import { COLUMN_RULES } from '@features/column-rule';
import { PROSE_ALIGNS } from '@features/prose-align';
import { PAGE_FORMATS } from '@features/page-format';
import { TAG_BADGES } from '@features/tag-badge';
import { READ_COLUMN_CHOICES } from '@features/read-columns';
import { OPEN_PLACES } from '@features/open-place';
import { APP_OPEN_TARGETS } from '@features/launcher/open-target';
import { EDITOR_MODES } from '@features/editor-mode';
import { PASTE_SOURCES } from '@features/markdown/paste-source';
import { EXTERNAL_IMAGE_MODES } from '@features/markdown/external-images';

function fakeStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

/** 位置引数(末尾に足す決まり)── 設定の store は全部 fake の保存を渡す(localStorage に触れない)。 */
function setup() {
  document.body.innerHTML = '';
  const region = document.createElement('div');
  document.body.append(region);
  const sameOrigin = new SameOriginGrants(fakeStorage());
  const extension = new ExtensionGrants(fakeStorage());
  const agent = new AgentGrants(fakeStorage());
  const mem = new Map<string, string>();
  const stores = {
    externalImages: new ExternalImagePolicy(fakeStorage()),
    notices: new NoticeStore({
      get: (k) => mem.get(k) ?? null,
      set: (k, v) => void mem.set(k, v),
      remove: (k) => void mem.delete(k),
    }),
    editorMode: new EditorModeStore(fakeStorage()),
    openInEdit: new OpenInEditStore(fakeStorage()),
    pasteSource: new PasteSourceStore(fakeStorage()),
    alarm: new AlarmEnabledStore(fakeStorage()),
    tooNarrow: new TooNarrowOkStore(fakeStorage()),
    phoneLinks: new PhoneLinksStore(fakeStorage()),
    voiceBoost: new VoiceBoostStore(fakeStorage()),
    dateLinks: new DateLinksStore(fakeStorage()),
    missingLinks: new MissingLinksStore(fakeStorage()),
    codeCollapse: new CodeCollapseStore(fakeStorage()),
    inlineCodeCopy: new InlineCodeCopyStore(fakeStorage()),
    relativeDays: new RelativeDaysStore(fakeStorage()),
    colorSwatch: new ColorSwatchStore(fakeStorage()),
    pdfReader: new PdfReaderStore(fakeStorage()),
  };
  const args: unknown[] = Array.from({ length: 21 }, () => undefined);
  args[1] = stores.externalImages;
  args[2] = stores.notices;
  args[3] = stores.editorMode;
  args[4] = stores.openInEdit;
  args[5] = sameOrigin;
  args[6] = extension;
  args[7] = stores.pasteSource;
  args[8] = stores.alarm;
  args[9] = stores.tooNarrow;
  args[10] = stores.phoneLinks;
  args[11] = stores.voiceBoost;
  args[13] = stores.dateLinks;
  args[14] = stores.missingLinks;
  args[15] = stores.codeCollapse;
  args[16] = stores.inlineCodeCopy;
  args[17] = stores.relativeDays;
  args[18] = stores.colorSwatch;
  args[20] = stores.pdfReader;
  const Ctor = SettingsRenderer as unknown as new (...a: unknown[]) => SettingsRenderer;
  const renderer = new Ctor(region, ...args, agent, new AgentTabStatus());
  return { region, renderer, sameOrigin, extension, agent, stores };
}

/** 登録表の全 id(並びが画面の並び)。節を足したらここへ 1 行足す。 */
const ALL_IDS = [
  'messages',
  'theme',
  'page-format',
  'prose-align',
  'text-scale',
  'read-columns',
  'column-rule',
  'tag-badge',
  'editor-mode',
  'open-in-edit',
  'phone-links',
  'date-links',
  'relative-days',
  'color-swatch',
  'missing-links',
  'code-collapse',
  'inline-code-copy',
  'pdf-reader',
  'paste-source',
  'alarm-enabled',
  'voice-boost',
  'open-place',
  'app-open-target',
  'external-images',
  'same-origin',
  'extensions',
  'agents',
  'opened-history',
  'search-history',
  'copy-history',
  'too-narrow',
  'persist',
  'notices',
  'notice-list',
];

/** 各 `dl` の `dt` の並び(= 同じ group の節が登録の順に並ぶ)。 */
const DT_ORDER: Record<string, string[]> = {
  'settings-user': [
    '配色',
    'ページ設定',
    '本文の置き場所',
    '文字の大きさ',
    '本文の段組み',
    '段の境界線',
    '本文のタグの見せ方',
  ],
  'settings-edit': [
    '編集の仕方',
    '開いたときの状態',
    '本文の電話番号',
    '本文の日付',
    '日付までの日数',
    '色コードの見本',
    'リンク先が無いリンク',
    '長いコードブロック',
    '文中の短いコード',
    'PDF',
  ],
  'settings-notify': ['予定の知らせ', '音を聞きやすくする'],
  'settings-open-ways': ['zip ファイルを開く場所', 'アプリの開き方'],
  'settings-too-narrow': ['狭い画面の断り書き'],
  'settings-persist': ['PKC3 のデータ'],
  'settings-notices': ['お知らせ'],
};

describe('設定画面の節の登録表(#1382)', () => {
  afterEach(() => {
    // 設定を `html` の属性へ当てた test が、次の test へ漏れないようにする
    for (const a of [...document.documentElement.attributes]) {
      if (a.name.startsWith('data-pkc-')) document.documentElement.removeAttribute(a.name);
    }
  });

  it('名前は一意で、並びは登録のとおり(取り違え・削除・並べ替え・改名が鳴る)', () => {
    const { renderer } = setup();
    const ids = renderer.registeredSections().map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(ALL_IDS);
  });

  it('🔴 同じ group の節は登録の順に 1 つの dl へ並ぶ(dt の並びで見る ── 2 つ入れ替えると落ちる)', () => {
    const { region, renderer } = setup();
    renderer.render(initialState);
    for (const [name, expected] of Object.entries(DT_ORDER)) {
      const sec = region.querySelector(`[data-pkc-region="${name}"]`);
      expect(sec, name).not.toBeNull();
      const dts = [...sec!.querySelectorAll(':scope > dl > dt')].map((d) => d.textContent);
      expect(dts, name).toEqual(expected);
    }
  });

  it('🔴 位置引数で渡した台帳が、実際に画面へ届いている(引数がずれたら落ちる)', () => {
    const { region, renderer, sameOrigin, extension, agent } = setup();
    const KA = 'ast-' + 'a'.repeat(64);
    const KB = 'ast-' + 'b'.repeat(64);
    sameOrigin.grant(KA);
    extension.grant(KB);
    agent.setAlways('write');
    renderer.render(initialState);
    const keys = (field: string): (string | null)[] =>
      [...region.querySelectorAll(`[data-pkc-field="${field}"] li`)].map((li) =>
        li.getAttribute('data-pkc-asset-key'),
      );
    expect(keys('same-origin-list')).toEqual([KA]);
    expect(keys('extension-list')).toEqual([KB]);
    expect(
      [...region.querySelectorAll('[data-pkc-field="agent-list"] li')].map((li) =>
        li.getAttribute('data-pkc-agent-scope'),
      ),
    ).toEqual(['write']);
  });

  it('🔴 登録表の並び = 画面の並び(build が返した根が、登録の順に DOM に並ぶ)', () => {
    const { region, renderer } = setup();
    const built: { id: string; el: Node }[] = [];
    for (const s of renderer.registeredSections()) {
      const orig = s.build.bind(s);
      vi.spyOn(s, 'build').mockImplementation(() => {
        const out = orig();
        const first = Array.isArray(out) ? out[0] : out;
        if (first !== undefined) built.push({ id: s.id, el: first });
        return out;
      });
    }
    renderer.render(initialState);
    // 全部の節が build を 1 度ずつ呼ぶ(ファイルへ移していない節は、もう無い)
    expect(built.map((b) => b.id).sort()).toEqual([...ALL_IDS].sort());
    for (const b of built) expect(region.contains(b.el), b.id).toBe(true);
    // 登録の順に文書順で並ぶ
    const byId = (id: string): Node => built.find((b) => b.id === id)!.el;
    for (let i = 1; i < ALL_IDS.length; i++) {
      const prev = byId(ALL_IDS[i - 1]!);
      const cur = byId(ALL_IDS[i]!);
      expect(
        prev.compareDocumentPosition(cur) & Node.DOCUMENT_POSITION_FOLLOWING,
        `${ALL_IDS[i - 1]} → ${ALL_IDS[i]}`,
      ).toBeTruthy();
    }
  });

  it('🔴 登録した節の sync は、最初の組み立ての直後にも、以後の render() のたびにも呼ばれる', () => {
    const { renderer } = setup();
    const spies = renderer
      .registeredSections()
      .map((s) => ({ id: s.id, spy: vi.spyOn(s, 'sync') }));
    expect(spies.length).toBe(ALL_IDS.length);

    renderer.render(initialState); // 組み立て + 最初の sync
    for (const { id, spy } of spies) expect(spy, `${id}: 組み立て直後`).toHaveBeenCalledTimes(1);

    renderer.render({ ...initialState, messagesUnread: 2 }); // 以後
    for (const { id, spy } of spies) {
      expect(spy, `${id}: 以後の render`).toHaveBeenCalledTimes(2);
      // 最新の state が渡る(古い state を握らない)
      expect(spy.mock.calls[1]![0]!.messagesUnread, id).toBe(2);
    }
  });

  describe('🔴 sync は画面を実際に追随させる(空の sync・違う欄への sync が落ちる)', () => {
    const checked = (region: HTMLElement, field: string): boolean =>
      region.querySelector<HTMLInputElement>(`[data-pkc-field="${field}"]`)!.checked;

    it('チェックの節:保存を反転して render し直すと、チェックも反転する', () => {
      const { region, renderer, stores } = setup();
      type Flip = { enabled(): boolean; setEnabled(on: boolean): void };
      const rows: [string, Flip][] = [
        ['open-in-edit', stores.openInEdit],
        ['alarm-enabled', stores.alarm],
        ['voice-boost', stores.voiceBoost],
        ['phone-links', stores.phoneLinks],
        ['date-links', stores.dateLinks],
        ['relative-days', stores.relativeDays],
        ['color-swatch', stores.colorSwatch],
        ['missing-links', stores.missingLinks],
        ['code-collapse', stores.codeCollapse],
        ['inline-code-copy', stores.inlineCodeCopy],
        ['pdf-reader', stores.pdfReader],
        ['too-narrow-enabled', stores.tooNarrow],
        ['notices-enabled', stores.notices],
      ];
      renderer.render(initialState);
      for (const [f, s] of rows) expect(checked(region, f), `${f}: 最初`).toBe(s.enabled());
      /**
       * ⚠ **1 節ずつ**反転する(着地前レビュー)── 全部を同時に反転すると、既定値が同じ
       *   2 節の store を取り違えても(missing-links ↔ code-collapse など)緑のまま通る。
       *   その節だけが反転し、**他の行は動かない**ことを見る。
       */
      for (const [f, s] of rows) {
        const before = rows.map(([g]) => checked(region, g));
        s.setEnabled(!s.enabled());
        renderer.render(initialState);
        rows.forEach(([g], j) => {
          const want = g === f ? !before[j] : before[j];
          expect(checked(region, g), `${f} だけを反転したとき、${g}`).toBe(want);
        });
      }
    });

    it('段組みの節:読む面の幅に応じて「いまの画面では N 段で出ています」を書き直す(sync が映す)', () => {
      const { region, renderer } = setup();
      const host = document.createElement('div');
      host.setAttribute('data-pkc-field', 'detail-body');
      host.style.fontSize = '16px';
      let width = 2400;
      host.getBoundingClientRect = () => ({ width }) as DOMRect;
      document.body.append(host);
      const note = (): string =>
        region.querySelector('[data-pkc-field="read-columns-effective"]')?.textContent ?? '';
      chooseReadColumns(document.documentElement, '2');
      renderer.render(initialState);
      expect(note(), '広い面で 2 段').toContain('2 段で出ています');
      width = 300;
      renderer.render(initialState);
      expect(note(), '狭い面では 1 段に畳んだと言う').toContain('狭いので');
    });

    it('選択欄・ボタン列の節:保存(または html の属性)を変えて render し直すと、選ばれている物が変わる', () => {
      const { region, renderer, stores } = setup();
      const html = document.documentElement;
      renderer.render(initialState);
      const sel = (field: string): string =>
        region.querySelector<HTMLSelectElement>(`[data-pkc-field="${field}"]`)!.value;
      const pressed = (field: string): string[] =>
        [...region.querySelectorAll(`[data-pkc-field="${field}"] button[aria-pressed="true"]`)].map(
          (b) => b.textContent ?? '',
        );
      const labelOf = (list: readonly { id: string; label: string }[], id: string): string =>
        list.find((c) => c.id === id)!.label;
      const lastOf = <T,>(a: readonly T[]): T => a[a.length - 1]!;

      // 変える前の値(= 最後の選択肢以外)を控え、最後の選択肢へ変える
      const nextThemeId = lastOf(THEMES).id;
      chooseTheme(html, nextThemeId);
      choosePageFormat(html, lastOf(PAGE_FORMATS).id);
      chooseProseAlign(html, lastOf(PROSE_ALIGNS).id);
      chooseTextScale(html, lastOf(TEXT_SCALES).id);
      chooseReadColumns(html, lastOf(READ_COLUMN_CHOICES).id as never);
      chooseColumnRule(html, lastOf(COLUMN_RULES).id);
      chooseTagBadge(html, lastOf(TAG_BADGES).id);
      stores.editorMode.setMode(lastOf(EDITOR_MODES).id);
      stores.pasteSource.set(lastOf(PASTE_SOURCES).id);
      stores.externalImages.setMode(lastOf(EXTERNAL_IMAGE_MODES).id);
      const prevPlace = localStorage.getItem('pkc3.open-place');
      const prevTarget = localStorage.getItem('pkc3.app-open-target');
      try {
        chooseOpenPlace(lastOf(OPEN_PLACES).id);
        chooseAppOpenTarget(lastOf(APP_OPEN_TARGETS).id);
        renderer.render({ ...initialState, persistState: 'denied' });

        expect(sel('theme-select')).toBe(nextThemeId);
        expect(sel('page-format-select')).toBe(lastOf(PAGE_FORMATS).id);
        expect(pressed('prose-align-select')).toEqual([labelOf(PROSE_ALIGNS, lastOf(PROSE_ALIGNS).id)]);
        expect(pressed('text-scale-select')).toEqual([labelOf(TEXT_SCALES, lastOf(TEXT_SCALES).id)]);
        expect(pressed('read-columns-select')).toEqual([
          labelOf(READ_COLUMN_CHOICES, lastOf(READ_COLUMN_CHOICES).id),
        ]);
        expect(pressed('column-rule-select')).toEqual([labelOf(COLUMN_RULES, lastOf(COLUMN_RULES).id)]);
        expect(sel('tag-badge-select')).toBe(lastOf(TAG_BADGES).id);
        expect(sel('editor-mode-select')).toBe(lastOf(EDITOR_MODES).id);
        expect(sel('paste-source-select')).toBe(lastOf(PASTE_SOURCES).id);
        expect(pressed('external-images-select')).toEqual([
          labelOf(EXTERNAL_IMAGE_MODES, lastOf(EXTERNAL_IMAGE_MODES).id),
        ]);
        expect(pressed('open-place-select')).toEqual([labelOf(OPEN_PLACES, lastOf(OPEN_PLACES).id)]);
        expect(sel('app-open-target-select')).toBe(lastOf(APP_OPEN_TARGETS).id);
        // 保存の状態(state)── 文言が state から引かれる
        const persist = region.querySelector('[data-pkc-field-persist="persist-state"]')!;
        expect(persist.textContent).toContain('データを消すことがあります');
        renderer.render({ ...initialState, persistState: 'persisted' });
        expect(persist.textContent).toContain('消さない扱いにしています');
      } finally {
        if (prevPlace === null) localStorage.removeItem('pkc3.open-place');
        else localStorage.setItem('pkc3.open-place', prevPlace);
        if (prevTarget === null) localStorage.removeItem('pkc3.app-open-target');
        else localStorage.setItem('pkc3.app-open-target', prevTarget);
      }
    });

    it('「本文の日付」を切ると「日付までの日数」の前提の説明が出る(sync と change の両方が同じ関数を呼ぶ)', () => {
      const { region, renderer, stores } = setup();
      const prereq = (): Element | null =>
        region.querySelector('[data-pkc-region="relative-days-prereq"]');
      renderer.render(initialState);
      expect(prereq()).toBeNull(); // 日付は既定で入
      stores.dateLinks.setEnabled(false);
      renderer.render(initialState);
      expect(prereq()).not.toBeNull();
      // 画面でチェックを切り替えた瞬間にも出入りする(保存を待たない)
      const box = region.querySelector<HTMLInputElement>('[data-pkc-field="date-links"]')!;
      box.checked = true;
      box.dispatchEvent(new Event('change', { bubbles: true }));
      expect(prereq()).toBeNull();
      box.checked = false;
      box.dispatchEvent(new Event('change', { bubbles: true }));
      expect(prereq()).not.toBeNull();
    });
  });
});
