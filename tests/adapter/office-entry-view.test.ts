/** @vitest-environment happy-dom */
/**
 * O3-c: 添付の器に出す **Office の入口**(#88)。
 *
 * 守りたい主張:
 *  ① 🔴 **出るのは「押せるボタン」か「名指しの理由」のどちらかだけ** ──
 *     押しても何も起きないボタンを作らない
 *  ② 開くのに要る 3 つ(key / 名前 / MIME)が**ボタンに載っている** ──
 *     受け口は click の同期のうちに読む(本文を読み直す暇が無い)
 *  ③ Office でない添付には**何も足さない**
 *  ④ 🔴 **受け口が属性をそのまま実体へ渡す** ── ここが抜けると無言の dead click
 *  ⑤ 🔴 **添付の画面に実際に出る** ── 部品が正しくても、呼ばれていなければ
 *     user には 1 つも届かない(この repo が繰り返し踏んだ形)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { stubStamps } from '../helpers/store-stamps';
import { stubRevisionOps } from '../helpers/revision-stub';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { DetailRenderer } from '../../src/adapter/ui/render/detail';
import { bindActions, type BinderServices } from '../../src/adapter/ui/actions/binder';
import { attachmentBody } from '../../src/features/flavor/attachment-flavor';
import {
  appOfficePack,
  buildOfficeEntry,
  OfficePackState,
  type OfficeAvailabilitySource,
} from '../../src/adapter/ui/render/office-entry-view';
import type { OfficeCapability } from '../../src/features/office/office-entry';
import type { OfficePackMeta } from '../../src/adapter/platform/office/office-pack';

const OK: OfficeCapability = {
  crossOriginIsolated: true,
  sharedArrayBuffer: true,
  jspi: true,
  decompressionStream: true,
};

const META: OfficePackMeta = {
  version: 'lo-wasm-dev',
  build: null,
  installedAt: Date.UTC(2026, 7, 11),
  source: 'url',
  totalBytes: 80 * 1024 * 1024,
  files: [],
};

const DOCX = {
  name: '報告書.docx',
  mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  assetKey: 'ast-1',
  lid: 'lid-1',
};

function avail(installed: boolean, cap: OfficeCapability = OK): OfficeAvailabilitySource {
  return { isInstalled: () => installed, capability: () => cap };
}

beforeEach(() => {
  document.body.textContent = '';
  appOfficePack.setMeta(null);
});

describe('buildOfficeEntry(O3-c)', () => {
  it('🔴 配備済み・能力ありなら、押せるボタンが出る', () => {
    const el = buildOfficeEntry(DOCX, avail(true))!;
    expect(el.tagName).toBe('BUTTON');
    expect(el.getAttribute('data-pkc-action')).toBe('open-office');
    expect(el.getAttribute('data-pkc-office-state')).toBe('open');
    expect(el.querySelector('[data-pkc-field="label"]')?.textContent).toBe('Office で開く');
  });

  it('🔴 開くのに要る 4 つがボタンに載っている(同期で読めないと窓が開けない)', () => {
    const el = buildOfficeEntry(DOCX, avail(true))!;
    expect(el.getAttribute('data-pkc-asset-key')).toBe('ast-1');
    expect(el.getAttribute('data-pkc-asset-name')).toBe('報告書.docx');
    expect(el.getAttribute('data-pkc-asset-mime')).toBe(DOCX.mime);
    // 🔴 **4 つ目**(#205)── 落とすと上書き保存が新しいノートを増やす
    expect(el.getAttribute('data-pkc-office-lid'), '保存の戻り先が載っていない').toBe('lid-1');
  });

  it('🔴 未配備は「理由」であってボタンではない(押せる物を出さない)', () => {
    const el = buildOfficeEntry(DOCX, avail(false))!;
    expect(el.tagName, 'ボタンを出すと押しても何も起きない').not.toBe('BUTTON');
    expect(el.getAttribute('data-pkc-office-state')).toBe('setup');
    expect(el.textContent).toContain('77MB');
    // ⚠ 受け口を持たない `data-pkc-action` を紛れ込ませない
    expect(el.querySelector('[data-pkc-action]')).toBeNull();
    expect(el.hasAttribute('data-pkc-action')).toBe(false);
  });

  it('🔴 使えない環境は、足りないものを名指しで出す', () => {
    const el = buildOfficeEntry(DOCX, avail(true, { ...OK, jspi: false }))!;
    expect(el.getAttribute('data-pkc-office-state')).toBe('unsupported');
    expect(el.textContent, '何が足りないかを言う').toContain('JSPI');
    expect(el.tagName).not.toBe('BUTTON');
  });

  it('Office でない添付には何も足さない', () => {
    expect(
      buildOfficeEntry({ name: 'p.png', mime: 'image/png', assetKey: 'x', lid: 'l' }, avail(true)),
    ).toBeNull();
  });

  it('拡張子だけでも拾う(MIME が octet-stream に落ちる環境がある)', () => {
    const el = buildOfficeEntry(
      { name: '見積.xlsx', mime: 'application/octet-stream', assetKey: 'k', lid: 'l' },
      avail(true),
    );
    expect(el?.getAttribute('data-pkc-office-state')).toBe('open');
  });
});

describe('OfficePackState の控え', () => {
  it('🔴 変わったときだけ true を返す(描き直しの回数を増やさない)', () => {
    const a = new OfficePackState();
    expect(a.isInstalled()).toBe(false);
    expect(a.setMeta(META), '変わった').toBe(true);
    expect(a.setMeta(META), '変わっていない').toBe(false);
    expect(a.isInstalled()).toBe(true);
    expect(a.setMeta(null)).toBe(true);
  });

  it('🔴 変化は放送する(見る面が 2 つあるので、片方だけ直せない)', () => {
    const a = new OfficePackState();
    let n = 0;
    const off = a.onChange(() => { n += 1; });
    a.setMeta(META);
    a.setProgress('取得中');
    expect(n, '配備と進捗の 2 回').toBe(2);
    a.setProgress('取得中');
    expect(n, '同じ値では鳴らさない').toBe(2);
    off();
    a.setMeta(null);
    expect(n, '解除したら来ない').toBe(2);
  });

  it('能力は実機から読む(stub ではなく本物の読み手を通す)', () => {
    const a = new OfficePackState();
    // happy-dom には JSPI も分離も無い ── **足りない**と答えるのが正しい
    expect(a.capability().jspi).toBe(false);
    expect(a.capability().crossOriginIsolated).toBe(false);
  });
});

/** 添付 1 件だけの器を組んで、`DetailRenderer` に描かせる。 */
function setupDetail(body: string) {
  const root = document.createElement('div');
  document.body.append(root);
  const d = new Dispatcher();
  const regions = buildShell(root);
  const detail = new DetailRenderer(regions.detail);
  d.onState((s) => detail.render(s));
  connectStoreEffects(d, {
    ...stubRevisionOps(),
    getBody: async () => body,
    persistEntry: async () => stubStamps(),
    deleteEntry: async () => {},
    setEntryParent: async () => {},
  });
  const meta: EntryMeta = {
    lid: 'a1',
    title: '報告書',
    archetype: 'attachment',
    createdAt: null,
    updatedAt: null,
    entryOrder: 1,
    status: null,
    date: null,
    archived: false,
    bodyChars: null,
  };
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta], relations: [] });
  return { d, root };
}

const tick = (ms = 10): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('添付の画面に出る(#88 / O3-c)', () => {
  const docxBody = attachmentBody({
    name: '報告書.docx',
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    size: 12,
    assetKey: 'ast-1',
  });

  /**
   * 🔴 **部品の test は「呼ばれているか」を見ていない**(CLAUDE.md
   * 「どの test からも実行されない file に判断を書かない」の対称の反対側)。
   * ⚠ `buildOfficeEntry` が完璧でも、`detail.ts` が呼ばなければ user には
   *   1 つも届かない ── だから**画面に出ること**を別に pin する。
   */
  it('🔴 Office の添付を開くと、入口が画面に出る', async () => {
    const { d, root } = setupDetail(docxBody);
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a1' });
    await tick();
    const el = root.querySelector('[data-pkc-office]');
    expect(el, 'Office の添付なのに入口が 1 つも無い').not.toBeNull();
    // happy-dom は JSPI も分離も持たないので「使えない」側で出る ── どちらでも
    // **理由か押せるボタンのどちらか**であることが主張である
    expect(['open', 'setup', 'unsupported']).toContain(
      el!.getAttribute('data-pkc-office-state'),
    );
    // ⚠ 添付の情報の器の**中**に置く(離れた場所に出さない)
    expect(el!.closest('[data-pkc-field="attachment-info"]')).not.toBeNull();
  });

  it('Office でない添付には出ない', async () => {
    const { d, root } = setupDetail(
      attachmentBody({ name: 'p.png', mime: 'image/png', size: 3, assetKey: 'ast-2' }),
    );
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a1' });
    await tick();
    expect(root.querySelector('[data-pkc-office]')).toBeNull();
  });
});

/**
 * 🔴 **配線の原文 pin**(#88 / O3-c)。
 *
 * ⚠ **弱い検査だと自覚して使う**(CLAUDE.md「どの test からも実行されない file に
 * 判断を書かない」)。判断は `office-open.ts` に取り出して test してあるので、
 * ここが守るのは「**渡す口が在るか**」だけである ── そこが消えると、ボタンは
 * 出るのに押しても無言になる(型が optional なので tsc は黙る)。
 */
describe('main.ts の配線(原文 pin)', () => {
  const MAIN = readFileSync('src/main.ts', 'utf-8');

  it('🔴 openOffice を実体へ配線している', () => {
    expect(MAIN, '押しても実体に届かない').toContain('openOffice:');
    expect(MAIN, '開く実体を作っていない').toContain('createOfficeOpener(');
  });

  it('🔴 一式の有無を控えへ写し、写したら描き直す', () => {
    // ⚠ 写すだけでは設置カードが残る(boot の 1 枚目は「入っていない」で描かれる)
    const at = MAIN.indexOf('appOfficePack.setMeta(');
    expect(at, '控えを更新していない').toBeGreaterThan(-1);
    const after = MAIN.slice(at, at + 400);
    expect(after, '控えを更新したのに描き直していない').toContain('invalidateDetail()');
    expect(after, '描き直しを頼んだだけで描いていない').toContain('center.render(');
  });
});

describe('受け口(binder)', () => {
  /**
   * 🔴 **属性をそのまま実体へ渡す**。ここが欠けると押しても無言で終わる
   * (この repo が機械化してまで止めている形)。
   */
  it('🔴 押すと、載っている 4 つがそのまま渡る', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const d = new Dispatcher();
    const openOffice = vi.fn();
    bindActions(root, d, { openOffice } as BinderServices);
    const btn = buildOfficeEntry(DOCX, avail(true))!;
    root.append(btn);
    btn.dispatchEvent(new Event('click', { bubbles: true }));
    expect(openOffice).toHaveBeenCalledWith({
      assetKey: 'ast-1',
      name: '報告書.docx',
      mime: DOCX.mime,
      lid: 'lid-1',
    });
  });

  it('key が無いボタンでは呼ばない(空の key で開こうとしない)', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const d = new Dispatcher();
    const openOffice = vi.fn();
    bindActions(root, d, { openOffice } as BinderServices);
    const btn = document.createElement('button');
    btn.setAttribute('data-pkc-action', 'open-office');
    root.append(btn);
    btn.dispatchEvent(new Event('click', { bubbles: true }));
    expect(openOffice).not.toHaveBeenCalled();
  });

  it('🔴 押した結果、実体が受け取る名前が `BinderServices` に在る', () => {
    // ⚠ 受け口が在っても**実体を渡す口が消えれば**同じく無言になる。
    //    型は optional なので、口ごと消しても tsc は黙る
    const binder = readFileSync('src/adapter/ui/actions/binder.ts', 'utf-8');
    expect(binder, 'openOffice の口が BinderServices から消えた').toContain('openOffice?(');
  });

  it('🔴 ボタンの中の字を押しても届く(図案と文字は子要素にある)', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const d = new Dispatcher();
    const openOffice = vi.fn();
    bindActions(root, d, { openOffice } as BinderServices);
    const btn = buildOfficeEntry(DOCX, avail(true))!;
    root.append(btn);
    btn.querySelector('[data-pkc-field="label"]')!
      .dispatchEvent(new Event('click', { bubbles: true }));
    expect(openOffice, '子要素からでも受け口に届く').toHaveBeenCalledTimes(1);
  });
});
