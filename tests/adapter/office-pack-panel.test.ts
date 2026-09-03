/** @vitest-environment happy-dom */
/**
 * O6-a: 設定の面に出る **Office 一式の設置・状態・削除**(#88)。
 *
 * 守りたい主張:
 *  ① 🔴 **状態を嘘なく言う**(入っている / 入っていない / この環境で動くか)
 *  ② 🔴 **押しても何も起きないボタンを出さない** ── 入っていなければ削除は押せない
 *  ③ 🔴 **設置中は押せない**(93MB を 2 本走らせない)
 *  ④ 🔴 **器を組み直さない** ── 状態が変わっても node は同じ(押している最中の
 *     ボタンが作り直されると無言の dead click になる)
 *  ⑤ 🔴 **成功したら中央も描き直す** ── 設定だけ直すと設置カードが残る
 *  ⑥ 押した先が実体まで届く(受け口 → services)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { SettingsRenderer } from '../../src/adapter/ui/render/settings';
import { JobMonitor } from '../../src/adapter/platform/job-monitor';
import { initialState } from '../../src/adapter/state/app-state';
import { bindActions, type BinderServices } from '../../src/adapter/ui/actions/binder';
import { OfficePackState } from '../../src/adapter/ui/render/office-entry-view';
import {
  applyPackResult,
  buildOfficePackPanel,
  packBuildText,
  packStatusText,
} from '../../src/adapter/ui/render/office-pack-panel';
import type { OfficePackMeta } from '../../src/adapter/platform/office/office-pack';

const META: OfficePackMeta = {
  version: 'lo-wasm-dev',
  build: null,
  installedAt: new Date(2026, 7, 11, 12).getTime(),
  source: 'url',
  totalBytes: 80 * 1024 * 1024,
  files: [],
};

/** 🔴 #155: どのビルドかを名指しする素性(配布元の `pack.json` の `build`)。 */
const BUILD = {
  loSha: 'fb02e9d1fc6277a4dbd493b8956c599dc5237f62',
  builtAt: '2026-08-15T18:39:00Z',
  runId: '31890208793',
  qtRef: '6.9',
  emsdk: '4.0.10',
  pkc3Commit: '1c1866b0000000000000000000000000000000aa',
};

beforeEach(() => { document.body.textContent = ''; });

describe('🔴 どのビルドかを画面で言う(#155)', () => {
  it('素性があれば sha の先頭と焼いた日時を出す', () => {
    const t = packBuildText({ ...META, build: BUILD });
    // ⚠ sha は**先頭 12 字**(全部は読めないし、突合には足りる)
    expect(t).toContain('fb02e9d1fc62');
    expect(t).not.toContain(BUILD.loSha);
    expect(t).toContain('2026-08-15T18:39:00Z');
    expect(t).toContain('31890208793');
  });

  it('🔴 素性が無い一式は「分かりません」と言う(黙って行を消さない)', () => {
    /**
     * ⚠ 行ごと消すと、user は「出ていない」と「持っていない」を区別できない ──
     * 版が使い回されたときに**古い一式を新しいと思い込む**、いちばん質の悪い形。
     */
    const t = packBuildText({ ...META, build: null });
    expect(t).toContain('分かりません');
  });

  it('入っていなければ何も言わない(空の行を置かない)', () => {
    expect(packBuildText(null)).toBe('');
  });

  it('🔴 一部しか無い素性でも、在るものだけ出す(空の断片を並べない)', () => {
    const t = packBuildText({
      ...META,
      build: { ...BUILD, builtAt: '', runId: '', qtRef: '', emsdk: '', pkc3Commit: '' },
    });
    expect(t).toBe('LibreOffice fb02e9d1fc62');
  });
});

function mount() {
  const state = new OfficePackState();
  const panel = buildOfficePackPanel(state);
  document.body.append(panel.root);
  const q = (field: string): HTMLElement | null =>
    panel.root.querySelector(`[data-pkc-field="${field}"]`);
  return { state, panel, q };
}

describe('packStatusText', () => {
  it('入っていなければそう言う', () => {
    expect(packStatusText(null)).toBe('入っていません');
  });

  it('🔴 版・大きさ・日付・出所を出す(どれも腐りやすいので実体から出す)', () => {
    const t = packStatusText(META);
    expect(t).toContain('lo-wasm-dev');
    expect(t).toContain('80.0 MB');
    expect(t).toContain('2026-08-11');
    expect(t).toContain('配布元から');
  });

  it('手元の zip から入れたら、そう言う(出所を取り違えない)', () => {
    expect(packStatusText({ ...META, source: 'file' })).toContain('ファイルから');
  });

  it('壊れた日付でも落ちない', () => {
    expect(packStatusText({ ...META, installedAt: Number.NaN })).toContain('日時不明');
  });
});

describe('設定の面(O6-a)', () => {
  /**
   * ⚠ **JSPI の有無は走らせる node で変わる**(2026-09-03、CI で落ちて判明)──
   *   Node 24 には `WebAssembly.Suspending` が在り、Node 22 には無い。
   *   この面が見たいのは「**足りないものを名指しするか**」なので、
   *   足りない側へ**固定してから**測る(CLAUDE.md §5:観測点を環境差に強い側へ寄せる)。
   */
  function withJspi<T>(present: boolean, run: () => T): T {
    const wasm = (globalThis as unknown as { WebAssembly: Record<string, unknown> })
      .WebAssembly;
    const had = wasm['Suspending'];
    try {
      if (present) wasm['Suspending'] = function Suspending(): void {};
      else delete wasm['Suspending'];
      return run();
    } finally {
      if (had === undefined) delete wasm['Suspending'];
      else wasm['Suspending'] = had;
    }
  }

  it('🔴 いまの状態と、この環境で動くかを両方出す', () => {
    const cap = withJspi(false, () => {
      const { q } = mount();
      expect(q('office-pack-status')?.textContent).toBe('入っていません');
      return q('office-pack-capability')?.textContent ?? '';
    });
    // JSPI も分離も無い ── 「動きません」と名指しで言う
    expect(cap, '足りないものを名指しする').toContain('JSPI');
  });

  /**
   * ⚠ **対照群** ── 名指しは**能力に従っている**(定数の一覧を出していない)。
   * 🔑 これが無いと「いつも JSPI と書く」実装が緑のまま通る(§1 の空振り)。
   */
  it('⚠ JSPI が在る環境では、JSPI を足りないものに数えない', () => {
    const cap = withJspi(true, () => {
      const { q } = mount();
      return q('office-pack-capability')?.textContent ?? '';
    });
    expect(cap, '在るものを「足りない」と言っている').not.toContain('JSPI');
    // ⚠ 分離は無いままなので、そちらは名指しされ続ける(空振り防止)
    expect(cap, '足りないものが 1 つも出ていない(台の空振り)').toContain('分離');
  });

  it('🔴 入っていなければ削除は押せない(押しても何も起きないボタンを出さない)', () => {
    const { state, q } = mount();
    expect((q('office-pack-remove') as HTMLButtonElement).disabled).toBe(true);
    state.setMeta(META);
    expect((q('office-pack-remove') as HTMLButtonElement).disabled).toBe(false);
  });

  it('🔴 設置中は入れる導線を止め、進捗を出す', () => {
    const { state, q } = mount();
    const progress = q('office-pack-progress')!;
    expect(progress.hidden, '何もしていないときは出さない').toBe(true);
    state.setProgress('取得中: soffice.wasm.gz(1/6)');
    expect(progress.hidden).toBe(false);
    expect(progress.textContent).toContain('1/6');
    expect((q('office-pack-url') as HTMLButtonElement).disabled).toBe(true);
    expect((q('office-pack-file') as HTMLButtonElement).disabled).toBe(true);
    state.setProgress('');
    expect(progress.hidden, '終わったら消える').toBe(true);
    expect((q('office-pack-url') as HTMLButtonElement).disabled).toBe(false);
  });

  it('🔴 状態が変わっても器は組み直さない(押している最中のボタンを差し替えない)', () => {
    const { state, q } = mount();
    const before = q('office-pack-url');
    state.setMeta(META);
    state.setProgress('取得中');
    state.setProgress('');
    expect(q('office-pack-url'), '同じ node のまま').toBe(before);
  });

  it('dispose すると、以後の変化を描かない', () => {
    const { state, panel, q } = mount();
    panel.dispose();
    state.setMeta(META);
    expect(q('office-pack-status')?.textContent, '購読を切ったら動かない').toBe('入っていません');
  });

  it('ファイルの選び口が在り、隠れている(押すのはボタンの側)', () => {
    const { q } = mount();
    const input = q('office-pack-input') as HTMLInputElement;
    expect(input.type).toBe('file');
    expect(input.hidden).toBe(true);
    // ⚠ 受け手のいない action を紛れ込ませない(受け取りは change 側)
    expect(input.hasAttribute('data-pkc-action')).toBe(false);
  });
});

describe('applyPackResult(設置 / 削除の後始末)', () => {
  function ui() {
    return { redrawDetail: vi.fn(), notify: vi.fn() };
  }

  it('🔴 成功したら控えを書き換え、中央も描き直す', () => {
    const state = new OfficePackState();
    const u = ui();
    applyPackResult(state, { ok: true, meta: META, message: '配備しました' }, u);
    expect(state.getMeta()).toBe(META);
    expect(u.redrawDetail, '設定だけ直すと設置カードが残る').toHaveBeenCalledTimes(1);
    expect(u.notify).toHaveBeenCalledWith('配備しました');
  });

  it('🔴 失敗で「入った」ことにしない', () => {
    const state = new OfficePackState();
    state.setMeta(META);
    const u = ui();
    applyPackResult(state, { ok: false, message: 'だめ' }, u);
    expect(state.getMeta(), '控えを触らない').toBe(META);
    expect(u.redrawDetail).not.toHaveBeenCalled();
  });

  it('🔴 成否によらず必ず何か言う(押して無反応を作らない)', () => {
    const state = new OfficePackState();
    const u = ui();
    applyPackResult(state, { ok: false, message: '取得できません' }, u);
    expect(u.notify).toHaveBeenCalledWith('取得できません');
  });
});

describe('受け口(binder)', () => {
  function harness() {
    const root = document.createElement('div');
    document.body.append(root);
    const services: BinderServices = {
      installOfficePack: vi.fn(),
      installOfficePackFromFile: vi.fn(),
      removeOfficePack: vi.fn(),
    };
    bindActions(root, new Dispatcher(), services);
    const panel = buildOfficePackPanel(new OfficePackState());
    root.append(panel.root);
    return { root, services, panel };
  }

  it('🔴 「取得して入れる」が実体まで届く', () => {
    const { services, panel } = harness();
    panel.root
      .querySelector('[data-pkc-action="install-office-pack"]')!
      .dispatchEvent(new Event('click', { bubbles: true }));
    expect(services.installOfficePack).toHaveBeenCalledTimes(1);
  });

  it('🔴 「ファイルから入れる」は選び口を開く(自分では入れない)', () => {
    const { services, panel } = harness();
    const input = panel.root.querySelector<HTMLInputElement>(
      '[data-pkc-field="office-pack-input"]',
    )!;
    const clicked = vi.fn();
    input.addEventListener('click', clicked);
    panel.root
      .querySelector('[data-pkc-action="choose-office-pack"]')!
      .dispatchEvent(new Event('click', { bubbles: true }));
    expect(clicked, '選び口が開く').toHaveBeenCalledTimes(1);
    expect(services.installOfficePackFromFile, 'まだ入れない').not.toHaveBeenCalled();
  });

  it('🔴 選んだ zip が実体まで届く', () => {
    const { services, panel } = harness();
    const input = panel.root.querySelector<HTMLInputElement>(
      '[data-pkc-field="office-pack-input"]',
    )!;
    const file = new File(['zip'], 'lo-wasm-qt6.zip', { type: 'application/zip' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new Event('change', { bubbles: true }));
    expect(services.installOfficePackFromFile).toHaveBeenCalledTimes(1);
    expect(
      (services.installOfficePackFromFile as ReturnType<typeof vi.fn>).mock.calls[0]![0],
    ).toBe(file);
  });

  it('何も選ばずに閉じたら、実体を呼ばない', () => {
    const { services, panel } = harness();
    const input = panel.root.querySelector<HTMLInputElement>(
      '[data-pkc-field="office-pack-input"]',
    )!;
    Object.defineProperty(input, 'files', { value: [], configurable: true });
    input.dispatchEvent(new Event('change', { bubbles: true }));
    expect(services.installOfficePackFromFile).not.toHaveBeenCalled();
  });

  it('🔴 「削除」が実体まで届く', () => {
    const { services, panel } = harness();
    const btn = panel.root.querySelector<HTMLButtonElement>(
      '[data-pkc-action="remove-office-pack"]',
    )!;
    // ⚠ 入っていないと `disabled` なので、押せる状態を作ってから見る
    btn.disabled = false;
    btn.dispatchEvent(new Event('click', { bubbles: true }));
    expect(services.removeOfficePack).toHaveBeenCalledTimes(1);
  });
});

/**
 * 🔴 **配線の原文 pin**(弱い検査だと自覚して使う ── `main.ts` はどの test からも
 * 実行されない)。ここが守るのは「渡す口が在るか」だけである。
 */
describe('main.ts の配線(原文 pin)', () => {
  const MAIN = readFileSync('src/main.ts', 'utf-8');

  it('🔴 3 つの導線が実体へ配線されている', () => {
    for (const name of ['installOfficePack:', 'installOfficePackFromFile:', 'removeOfficePack:']) {
      expect(MAIN, `${name} が配線されていない(押しても無言)`).toContain(name);
    }
  });

  it('🔴 進捗の行き先が控えへ繋がっている(無反応にしない)', () => {
    expect(MAIN, '進捗を画面へ流していない').toContain('appOfficePack.setProgress(');
  });

  it('🔴 後始末は取り出した判断を通る(main.ts に書かない)', () => {
    expect(MAIN).toContain('applyPackResult(');
  });
});

/**
 * 🔴 **設定の面に実際に載っているか**。
 *
 * ⚠ 部品が完璧でも、`settings.ts` が置かなければ user には 1 つも届かない
 * (CLAUDE.md「『A を直した』と書いた瞬間に『B はどうか』を grep する」の対称側)。
 * 🔑 原文を grep せず、**実際に描かせて**確かめる ── 「名前が在るか」の検査は
 *   中身が空でも通る。
 */
describe('設定の面に載っている', () => {
  it('🔴 設定を描くと、Office の節と 3 つの導線が出る', () => {
    const region = document.createElement('div');
    document.body.append(region);
    // ⚠ 監視器は自分で `new` して渡す(共有の 1 個を汚さない)
    new SettingsRenderer(region, new JobMonitor()).render(initialState);
    const section = region.querySelector('[data-pkc-region="settings-office"]');
    expect(section, '設定に Office の節が無い').not.toBeNull();
    for (const action of ['install-office-pack', 'choose-office-pack', 'remove-office-pack']) {
      expect(section!.querySelector(`[data-pkc-action="${action}"]`), `${action} が無い`)
        .not.toBeNull();
    }
    // ⚠ 「表示」の節に混ぜない ── 見た目の好みではなく、端末に 77MB を置く判断である
    expect(section!.closest('[data-pkc-region="settings-user"]')).toBeNull();
  });
});

/**
 * 🔴 **配布元と版が違うことを、設定の面が出す**(user 裁定 2026-08-13)。
 * ⚠ 器は 1 度しか組まないので、**映さないと古い値が残る**
 *   (CLAUDE.md「同じ値を複数の描画経路へ渡すものは、経路ごとに pin する」)。
 */
describe('配布元との版ちがい', () => {
  it('同じ版なら、行ごと隠れている(空の行を出さない)', () => {
    const state = new OfficePackState();
    state.setMeta({ ...META, version: 'lo-abc-run1' });
    state.setAvailableVersion('lo-abc-run1');
    const panel = buildOfficePackPanel(state);
    const line = panel.root.querySelector('[data-pkc-field="office-pack-update"]');
    expect((line as HTMLElement).hidden).toBe(true);
    expect(line?.textContent).toBe('');
    panel.dispose();
  });

  it('🔴 違えば出る ── 両方の版と次の一歩つき', () => {
    const state = new OfficePackState();
    state.setMeta({ ...META, version: 'unknown' });
    state.setAvailableVersion('lo-abc-run1');
    const panel = buildOfficePackPanel(state);
    const line = panel.root.querySelector('[data-pkc-field="office-pack-update"]') as HTMLElement;
    expect(line.hidden).toBe(false);
    expect(line.textContent).toContain('unknown');
    expect(line.textContent).toContain('lo-abc-run1');
    expect(line.textContent).toContain('取得して入れる');
    panel.dispose();
  });

  it('🔑 後から届いても映る(器を組み直さずに)', () => {
    const state = new OfficePackState();
    state.setMeta({ ...META, version: 'unknown' });
    const panel = buildOfficePackPanel(state);
    const line = panel.root.querySelector('[data-pkc-field="office-pack-update"]') as HTMLElement;
    expect(line.hidden, 'まだ配布元を読んでいないのに出ている').toBe(true);
    state.setAvailableVersion('lo-abc-run1');
    expect(line.hidden, '放送を受けて映していない(古い値が残る)').toBe(false);
    panel.dispose();
  });

  it('⚠ 入っていなければ出さない(「入っていません」は上の行が言っている)', () => {
    const state = new OfficePackState();
    state.setAvailableVersion('lo-abc-run1');
    const panel = buildOfficePackPanel(state);
    const line = panel.root.querySelector('[data-pkc-field="office-pack-update"]') as HTMLElement;
    expect(line.hidden).toBe(true);
    panel.dispose();
  });
});
