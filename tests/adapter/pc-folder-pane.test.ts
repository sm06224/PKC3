/** @vitest-environment happy-dom */
/**
 * 🔴 **左の列のタブ「PC」の画面**(#215 段①②。🟣 Gemini 裁定 2026-10-01)。
 *
 * ⚠ 見るのは **user が何を見て、何を押せるか** ──
 *   ①タブが 6 枚目に在る(API の無いブラウザでも出たまま)②字 ③行の目印(書き戻せる / 書き戻せない)
 *   ④フォルダの行は押せない ⑤**消す・改名・移動のボタンは 1 つも無い** ⑥押した先が binder に届く。
 */
import { describe, expect, it } from 'vitest';
import { BROWSE_TABS, BrowseRouter } from '@adapter/ui/render/browse';
import { BROWSE_MODES, browseScanOf, homeTabOf, isBrowseMode } from '@adapter/ui/render/browse-mode';
import { BROWSE_ICONS } from '@adapter/ui/render/icons';
import { buildShell } from '@adapter/ui/render/shell';
import { initialState } from '@adapter/state/app-state';
import { Dispatcher } from '@adapter/state/dispatcher';
import { PC_CONTACT_NOTE, PC_DIRECTORY_NOTE, PC_STATS_NOTE } from '@features/local-folder/folder-entries';
import { isIconName } from '@features/icon/symbols';
import { bindActions } from '@adapter/ui/actions/binder';
import {
  LocalFolder,
  type DirectoryHandleLike,
  type FolderEntryHandle,
} from '@adapter/platform/local-folder';

/** ⚠ `getFile` を呼んだ回数を数える(#1271 ── 一覧を出すだけでは 0 回でなければならない)。 */
let getFileCalls = 0;
const file = (name: string): FolderEntryHandle => ({
  kind: 'file',
  name,
  getFile: async () => {
    getFileCalls += 1;
    return new File(['abc'], name, { lastModified: Date.UTC(2026, 8, 30) });
  },
});

function dir(entries: FolderEntryHandle[], perm = { state: 'granted' }): DirectoryHandleLike {
  return {
    name: '資料',
    values: async function* () {
      for (const e of entries) yield e;
    },
    queryPermission: async () => perm.state,
  };
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

function setup(picker: (() => Promise<DirectoryHandleLike>) | null): {
  folder: LocalFolder;
  pane: HTMLElement;
  router: BrowseRouter;
  repaint: () => void;
  root: HTMLElement;
  opened: string[];
} {
  const root = document.createElement('div');
  document.body.append(root);
  const regions = buildShell(root);
  const opened: string[] = [];
  let repaint: () => void = () => {};
  const folder = new LocalFolder({
    picker,
    open: async (i) => void opened.push(i.file.name),
    fail: () => {},
    onChange: () => repaint(),
  });
  const router = new BrowseRouter(regions.sidebar, regions.browseHost, 'pc', undefined, null, () => {}, folder);
  repaint = () => router.render(initialState, 'pc');
  router.render(initialState, 'pc');
  const pane = regions.browseHost.querySelector<HTMLElement>('[data-pkc-browse-pane="pc"]')!;
  return { folder, pane, router, repaint, root, opened };
}

const text = (p: HTMLElement): string => p.textContent ?? '';
const q = (p: HTMLElement, sel: string): HTMLElement | null => p.querySelector<HTMLElement>(sel);

describe('タブ「PC」', () => {
  it('🔴 6 枚目(末尾)で、図案が「フォルダ」のタブと違う', () => {
    expect(BROWSE_TABS).toHaveLength(6);
    expect(BROWSE_TABS[5]).toEqual({ mode: 'pc', label: 'PC' });
    expect(BROWSE_ICONS.pc, '図案が無い').toBeTruthy();
    expect(BROWSE_ICONS.pc, 'フォルダのタブと同じ絵').not.toBe(BROWSE_ICONS.filer);
    expect(isBrowseMode('pc')).toBe(true);
    expect([...BROWSE_MODES].sort()).toEqual(BROWSE_TABS.map((t) => t.mode).sort());
  });

  it('🔴 左の列にタブが出る(帯のボタンとして押せる)', () => {
    const { root } = setup(null);
    const tab = root.querySelector('[data-pkc-action="set-browse"][data-pkc-browse="pc"]');
    expect(tab, 'タブが出ていない').not.toBeNull();
    expect(tab!.textContent).toContain('PC');
  });

  it('🔴 開いたときに集め直す頼みは無く、別窓の面も無い(左だけ)', () => {
    expect(browseScanOf('pc')).toBeNull();
    expect(homeTabOf('pc' as never)).toBeNull();
  });
});

describe('API の無いブラウザ', () => {
  it('🔴 タブは出したまま、中に理由と行き先 ── 押せないボタンは置かない', () => {
    const { pane, root } = setup(null);
    expect(root.querySelector('[data-pkc-browse="pc"]'), 'タブが消えた').not.toBeNull();
    expect(text(pane)).toBe('このブラウザでは使えません(Chrome / Edge で開いてください)');
    expect(pane.querySelectorAll('button'), 'dead click').toHaveLength(0);
  });
});

describe('繋ぐ前 / 繋いだ後', () => {
  it('🔴 繋ぐ前は説明と「フォルダを選ぶ…」だけ', () => {
    const { pane } = setup(async () => dir([]));
    const pick = q(pane, '[data-pkc-action="pc-pick-folder"]');
    expect(pick?.textContent).toBe('フォルダを選ぶ…');
    expect(pane.querySelectorAll('button')).toHaveLength(1);
    expect(q(pane, '[data-pkc-field="pc-list"]')).toBeNull();
  });

  it('🔴 選ぶと帯にフォルダ名と「切る」、行に 名前 / 種類 / 大きさ「—」/ 更新日「—」(一覧では file を読まない #1271)', async () => {
    getFileCalls = 0;
    const { pane, folder } = setup(async () => dir([file('メモ.md'), file('猫.png')]));
    await folder.pick();
    await settle();
    expect(q(pane, '[data-pkc-field="pc-folder-name"]')?.textContent).toBe('資料');
    expect(q(pane, '[data-pkc-action="pc-cut-folder"]')?.textContent).toBe('切る');
    expect(q(pane, '[data-pkc-field="pc-note"]')?.textContent).toBe('2 件');
    const rows = [...pane.querySelectorAll<HTMLElement>('[data-pkc-pc-row]')];
    expect(rows).toHaveLength(2);
    const md = rows[0]!;
    expect(q(md, '[data-pkc-field="pc-name"]')?.textContent).toBe('メモ.md');
    const meta = q(md, '[data-pkc-field="pc-meta"]')?.textContent ?? '';
    // 🔴 大きさ・更新日は読まない ── 実値(3 B / 2026/09/30)が出ていたら getFile を撃っている
    expect(meta).toBe('Markdown · — · —');
    expect(q(md, '[data-pkc-field="pc-meta"]')?.getAttribute('title'), '「—」のわけがホバーに無い').toBe(PC_STATS_NOTE);
    expect(getFileCalls, '一覧を出しただけで getFile が呼ばれた(クラウド同期のフォルダで実体を一斉に取りに行く)').toBe(0);
  });

  it('🔴 書き戻せない種類(画像)の行にだけ「書き戻せません」── Markdown には出さない', async () => {
    const { pane, folder } = setup(async () => dir([file('メモ.md'), file('猫.png'), file('報告.pdf')]));
    await folder.pick();
    await settle();
    const byName = (n: string): HTMLElement =>
      [...pane.querySelectorAll<HTMLElement>('[data-pkc-pc-row]')].find(
        (r) => q(r, '[data-pkc-field="pc-name"]')?.textContent === n,
      )!;
    expect(q(byName('メモ.md'), '[data-pkc-field="pc-readonly"]'), '書き戻せる Markdown に目印が出ている').toBeNull();
    expect(q(byName('猫.png'), '[data-pkc-field="pc-readonly"]')?.textContent).toBe('書き戻せません');
    expect(q(byName('報告.pdf'), '[data-pkc-field="pc-readonly"]')?.textContent).toBe('書き戻せません');
  });

  it('🔴 行のボタンは pc-open-file で、並べた中での位置を持つ(フォルダの行は押せない)', async () => {
    const entries: FolderEntryHandle[] = [{ kind: 'directory', name: '下' }, file('a.md')];
    const { pane, folder } = setup(async () => dir(entries));
    await folder.pick();
    await settle();
    const rows = [...pane.querySelectorAll<HTMLElement>('[data-pkc-pc-row]')];
    expect(q(rows[0]!, 'button'), 'フォルダの行が押せる見た目').toBeNull();
    const btn = q(rows[1]!, '[data-pkc-action="pc-open-file"]')!;
    expect(btn.getAttribute('data-pkc-pc-index')).toBe('1');
  });

  it('🔴 vCard の行には「連絡先として取り込みます」が見える字で出る(ホバーだけにしない)/ 他の種類には出ない', async () => {
    const { pane, folder } = setup(async () => dir([file('名刺.vcf'), file('メモ.md'), file('猫.png')]));
    await folder.pick();
    await settle();
    const rowOf = (n: string): HTMLElement =>
      [...pane.querySelectorAll<HTMLElement>('[data-pkc-pc-row]')].find(
        (r) => q(r, '[data-pkc-field="pc-name"]')?.textContent === n,
      )!;
    const note = q(rowOf('名刺.vcf'), '[data-pkc-field="pc-contact-note"]');
    expect(note?.textContent, 'vCard の行に字が出ていない').toBe(PC_CONTACT_NOTE);
    expect(PC_CONTACT_NOTE).toBe('連絡先として取り込みます');
    expect(q(rowOf('メモ.md'), '[data-pkc-field="pc-contact-note"]')).toBeNull();
    expect(q(rowOf('猫.png'), '[data-pkc-field="pc-contact-note"]')).toBeNull();
  });

  it('🔴 サブフォルダの行は、ホバーに理由と行き先が在り、押すと同じ字が状態の行へ出る(場所は動かない)', async () => {
    const { pane, folder } = setup(async () => dir([{ kind: 'directory', name: '下' }, file('a.md')]));
    await folder.pick();
    await settle();
    const row = pane.querySelector<HTMLElement>('[data-pkc-pc-row="0"]')!;
    expect(row.title).toBe(PC_DIRECTORY_NOTE);
    expect(PC_DIRECTORY_NOTE).toContain('中へは入りません');
    expect(PC_DIRECTORY_NOTE, '次にすること(切ってから選ぶ)が無い').toContain('切ってから');
    expect(row.getAttribute('data-pkc-action')).toBe('pc-dir-note');
    // 押す(binder を通す)
    const d = new Dispatcher();
    const off = bindActions(document.body, d, { localFolder: folder });
    const before = folder.view().folderName;
    row.click();
    off();
    expect(d.getState().notice, '押しても無言').toBe(PC_DIRECTORY_NOTE);
    expect(folder.view().folderName, '場所が動いた').toBe(before);
    // 対照群:ファイルの行には付かない
    expect(pane.querySelector('[data-pkc-pc-row="1"]')!.hasAttribute('data-pkc-action')).toBe(false);
  });

  it('🔴 200 件で切れて「さらに表示」── 押すと足される', async () => {
    const many = Array.from({ length: 230 }, (_, i) => file(`f${String(i).padStart(3, '0')}.md`));
    const { pane, folder } = setup(async () => dir(many));
    await folder.pick();
    await settle();
    expect(pane.querySelectorAll('[data-pkc-pc-row]')).toHaveLength(200);
    expect(q(pane, '[data-pkc-field="pc-note"]')?.textContent).toBe('230 件のうち先頭 200 件を表示しています');
    const more = q(pane, '[data-pkc-action="pc-more"]')!;
    expect(more.textContent).toContain('さらに表示');
    await folder.more();
    await settle();
    expect(pane.querySelectorAll('[data-pkc-pc-row]')).toHaveLength(230);
    expect(q(pane, '[data-pkc-action="pc-more"]'), '全部出したのに残っている').toBeNull();
  });

  it('🔴 0 件のフォルダは理由を言う(白紙にしない)', async () => {
    const { pane, folder } = setup(async () => dir([]));
    await folder.pick();
    expect(q(pane, '[data-pkc-field="pc-note"]')?.textContent).toBe('このフォルダにはファイルがありません');
  });

  it('🔴 「切る」で繋ぐ前へ戻る', async () => {
    const { pane, folder } = setup(async () => dir([file('a.md')]));
    await folder.pick();
    folder.cut();
    expect(q(pane, '[data-pkc-action="pc-pick-folder"]')).not.toBeNull();
    expect(q(pane, '[data-pkc-field="pc-list"]')).toBeNull();
  });

  it('🔴 許可が切れたら、その 1 行と「フォルダを選ぶ…」', async () => {
    const perm = { state: 'granted' };
    const { pane, folder } = setup(async () => dir([file('a.md')], perm));
    await folder.pick();
    perm.state = 'prompt';
    await folder.open(0);
    expect(q(pane, '[data-pkc-field="pc-note"]')?.textContent).toBe(
      '許可が切れました ── もう一度フォルダを選んでください',
    );
    expect(q(pane, '[data-pkc-action="pc-pick-folder"]')).not.toBeNull();
    expect(q(pane, '[data-pkc-field="pc-list"]')).toBeNull();
  });

  it('🔴 読み込み中は件数を出し、「切る」が押せる', async () => {
    let release: () => void = () => {};
    const wait = new Promise<void>((r) => (release = r));
    const d: DirectoryHandleLike = {
      name: '資料',
      values: async function* () {
        yield file('a.md');
        await wait;
      },
      queryPermission: async () => 'granted',
    };
    const { pane, folder } = setup(async () => d);
    const picking = folder.pick();
    await settle();
    expect(q(pane, '[data-pkc-field="pc-note"]')?.textContent).toContain('読み込んでいます');
    expect(q(pane, '[data-pkc-action="pc-cut-folder"]'), '読み込み中に「切る」が無い').not.toBeNull();
    folder.cut();
    release();
    await picking;
  });

  it('🔴 同じ版では描き直さない(押している最中に行を作り直さない)', async () => {
    const { pane, folder, router } = setup(async () => dir([file('a.md')]));
    await folder.pick();
    await settle();
    const before = q(pane, '[data-pkc-pc-row]');
    router.render(initialState, 'pc');
    expect(q(pane, '[data-pkc-pc-row]'), '同じ版で行が作り直された').toBe(before);
  });
});

describe('🔴 行頭の種類の絵(#1272)', () => {
  // ⚠ 期待は**手で書いた表**(`iconFor` の表を種にしない ── 実装の配列から 1 つ落とすと
  //   描く側も見る側も同時に縮んで緑になる)。ここが user に見える対応の正本。
  const EXPECTED: ReadonlyArray<readonly [name: string, kind: 'file' | 'directory', symbol: string]> = [
    ['下', 'directory', 'folder'],
    ['メモ.md', 'file', 'note'],
    ['長い.markdown', 'file', 'note'],
    ['猫.png', 'file', 'camera'],
    ['猫.JPG', 'file', 'camera'],
    ['図.svg', 'file', 'camera'],
    ['報告.pdf', 'file', 'page'],
    ['曲.mp3', 'file', 'music'],
    ['曲.wav', 'file', 'music'],
    ['映像.mp4', 'file', 'movie'],
    ['映像.webm', 'file', 'movie'],
    ['資料.pptx', 'file', 'presentation'],
    ['表.xlsx', 'file', 'presentation'],
    ['文書.docx', 'file', 'presentation'],
    ['名刺.vcf', 'file', 'person'],
    ['メモ.txt', 'file', 'clip'],
    ['何か.zip', 'file', 'clip'],
    ['拡張子なし', 'file', 'clip'],
  ];

  async function listed(): Promise<HTMLElement> {
    const handles: FolderEntryHandle[] = EXPECTED.map(([name, kind]) =>
      kind === 'directory' ? { kind: 'directory', name } : file(name),
    );
    const { pane, folder } = setup(async () => dir(handles));
    await folder.pick();
    await settle();
    return pane;
  }

  it('🔴 全部の種類で、行の先頭に正しい絵が在る(全数)', async () => {
    const pane = await listed();
    const rows = [...pane.querySelectorAll<HTMLElement>('[data-pkc-pc-row]')];
    expect(rows, '行の数(全部並んでいる)').toHaveLength(EXPECTED.length);
    const bySymbol = new Map<string, string>();
    for (const r of rows) {
      const name = q(r, '[data-pkc-field="pc-name"]')?.textContent ?? '';
      const head = q(r, '[data-pkc-field="pc-head"]')!;
      const icon = head.firstElementChild as HTMLElement | null;
      expect(icon?.hasAttribute('data-pkc-icon'), `${name}: 名前の前に絵が無い`).toBe(true);
      bySymbol.set(name, icon!.getAttribute('data-pkc-symbol') ?? '');
    }
    for (const [name, , symbol] of EXPECTED) {
      expect(bySymbol.get(name), `${name} の絵`).toBe(symbol);
    }
  });

  it('🔴 絵は名前の外に在る ── 名前の textContent に字が混ざらない / 絵は読み上げない', async () => {
    const pane = await listed();
    for (const r of pane.querySelectorAll<HTMLElement>('[data-pkc-pc-row]')) {
      const name = q(r, '[data-pkc-field="pc-name"]')!;
      expect(name.querySelector('[data-pkc-icon]'), '絵が名前の中に入っている').toBeNull();
      const icon = q(r, '[data-pkc-icon]')!;
      expect(icon.textContent, '絵の器に字が入っている(ボタンの textContent に混ざる)').toBe('');
      expect(icon.getAttribute('aria-hidden')).toBe('true');
    }
  });

  it('🔴 書体に在る名前だけを使っている(無い名前は豆腐になる)', async () => {
    const pane = await listed();
    for (const el of pane.querySelectorAll<HTMLElement>('[data-pkc-pc-row] [data-pkc-icon]')) {
      expect(isIconName(el.getAttribute('data-pkc-symbol') ?? ''), el.getAttribute('data-pkc-symbol') ?? '').toBe(true);
    }
  });
});

describe('🔴 消す・改名・移動のボタンを置かない(裁定)', () => {
  it('どの状態でも、押し口は 選ぶ / 切る / さらに表示 / 開く / フォルダの行の返事 の 5 種だけ', async () => {
    const seen = new Set<string>();
    const many = Array.from({ length: 230 }, (_, i) => file(`f${i}.md`));
    const states: Array<() => Promise<HTMLElement>> = [
      async () => setup(null).pane,
      async () => setup(async () => dir([])).pane,
      async () => {
        const s = setup(async () => dir([{ kind: 'directory', name: 'd' }, ...many]));
        await s.folder.pick();
        await settle();
        return s.pane;
      },
    ];
    for (const make of states) {
      const pane = await make();
      for (const el of pane.querySelectorAll('[data-pkc-action]')) seen.add(el.getAttribute('data-pkc-action')!);
    }
    expect([...seen].sort()).toEqual([
      'pc-cut-folder',
      'pc-dir-note',
      'pc-more',
      'pc-open-file',
      'pc-pick-folder',
    ]);
    // ⚠ 空振り防止 ── 5 種とも実際に出ている(消す・改名・移動は 1 つも無い)
    expect(seen.size).toBe(5);
  });
});

describe('押した先が届く(binder)', () => {
  it('🔴 4 つの押し口が LocalFolder の対応する操作へ繋がっている', async () => {
    const calls: string[] = [];
    const fake = {
      pick: async () => void calls.push('pick'),
      cut: () => void calls.push('cut'),
      more: async () => void calls.push('more'),
      open: async (i: number) => void calls.push(`open:${i}`),
    };
    const root = document.createElement('div');
    document.body.append(root);
    root.innerHTML = [
      '<button data-pkc-action="pc-pick-folder">a</button>',
      '<button data-pkc-action="pc-cut-folder">b</button>',
      '<button data-pkc-action="pc-more">c</button>',
      '<button data-pkc-action="pc-open-file" data-pkc-pc-index="7">d</button>',
      '<button data-pkc-action="pc-open-file">e</button>',
    ].join('');
    const off = bindActions(root, new Dispatcher(), { localFolder: fake });
    for (const b of root.querySelectorAll<HTMLElement>('button')) b.click();
    off();
    // ⚠ 添字の無い行(壊れた DOM)は何も呼ばない
    expect(calls).toEqual(['pick', 'cut', 'more', 'open:7']);
  });

  it('🔴 取り込みの最中は行を押せない(他の取込と同じ門)', async () => {
    const calls: string[] = [];
    const fake = {
      pick: async () => {},
      cut: () => {},
      more: async () => {},
      open: async (i: number) => void calls.push(`open:${i}`),
    };
    const root = document.createElement('div');
    document.body.append(root);
    root.innerHTML = '<button data-pkc-action="pc-open-file" data-pkc-pc-index="0">d</button>';
    const dispatcher = new Dispatcher();
    const off = bindActions(root, dispatcher, { localFolder: fake, busy: () => true });
    root.querySelector<HTMLElement>('button')!.click();
    off();
    expect(calls, '取り込み・書き出しの最中に取り込みが走った').toEqual([]);
    expect(dispatcher.getState().error ?? '').toContain('実行中');
  });
});
