/**
 * 🔴 **PKC2 の本物の書出しを読む**(2026-08-02)。
 *
 * ここまでの P6c の test はすべて**合成 fixture**で、設計 doc にも
 * 「⚠ 8 形式すべて実体未確認 ── コードから読んだ事実であって実測ではない」と
 * 書いてあった。その但し書きを消すための test。
 *
 * fixture は **PKC2 の writer を直接動かして**作った(`tests/fixtures/pkc2/`)──
 * PKC2 をビルドして `buildPackageZip` / `buildTextBundle` /
 * `buildTextsContainerBundle` / `buildTextlogsContainerBundle` /
 * `buildMixedContainerBundle` / `buildFolderExportBundle` / `buildEntryBundle` を
 * 実データ形の container に対して呼んだ生の出力。PKC2 のソースは一切変更していない。
 *
 * 🔑 **合成 fixture では出せない性質がここで出る**:
 * - ファイル名が**日本語**(`議事録-20260731.text.zip`)── slugify が CJK を残す
 * - 内側 ZIP が **store で外側に埋まる**実バイト列
 * - manifest の field 集合が**実際に**形式ごとに違う
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readPkc2Package, peekZipFormat } from '../../src/features/import/pkc2-package';
import { readTextBundle, readTextlogBundle } from '../../src/features/import/pkc2-bundle';
import { readContainerBundle } from '../../src/features/import/pkc2-container-bundle';
import { readFolderExportBundle } from '../../src/features/import/pkc2-folder-export';
import { convertPkc2Container } from '../../src/features/import/pkc2-convert';

// ⚠ happy-dom 環境では import.meta.url がファイルパスを指さない ── cwd から引く
const load = (name: string): Blob =>
  new Blob([readFileSync(`${process.cwd()}/tests/fixtures/pkc2/${name}`)]);

type Synth = {
  entries: Array<{ lid: string; title: string; archetype: string; body: string }>;
  relations: Array<{ id: string; from: string; to: string; kind: string }>;
};

/** 変換まで通して「実際に保存される形」を得る(reader だけ見ても片手落ち)。 */
function convert(container: unknown, assetKeys?: readonly string[]) {
  let n = 0;
  return convertPkc2Container(container as never, {
    existingLids: new Set(),
    existingRelationIds: new Set(),
    orderBase: 0,
    genLid: () => `gen-${++n}`,
    genAssetKey: () => `ast-gen-${++n}`,
    genRelationId: () => `rel-gen-${++n}`,
    ...(assetKeys ? { assetKeys } : {}),
  });
}

describe('🔴 実物: pkc2-package', () => {
  it('読めて、entry / relation / 履歴 / 添付が揃う', async () => {
    const got = await readPkc2Package(load('package.pkc2.zip'));
    expect(got.manifest.format).toBe('pkc2-package');
    expect([...got.assetSources.keys()]).toEqual(['ast-shared']);
    expect(got.warnings).toEqual([]);

    const res = convert(got.container, [...got.assetSources.keys()]);
    // folder 3 + text 2 + textlog 1 + todo 1 + attachment 1
    expect(res.entries).toHaveLength(8);
    expect(res.entries.filter((e) => e.archetype === 'folder')).toHaveLength(3);
    // 🔑 **非 structural の relation も入る**(package だけが container の完全な写し)
    expect(res.relations.map((r) => r.kind).sort()).toEqual([
      'semantic',
      'structural',
      'structural',
      'structural',
      'structural',
      'structural',
      'structural',
    ]);
    // 履歴も鎖として入る
    expect(res.revisionChains).toHaveLength(1);
    expect(res.revisionChains[0]!.snapshots).toHaveLength(2);
  });
});

describe('🔴 実物: 単体 bundle', () => {
  it('.text.zip ── body.md は verbatim、添付は manifest.assets が正本', async () => {
    const got = await readTextBundle(load('single.text.zip'));
    expect([...got.assetSources.keys()]).toEqual(['ast-shared']);
    const c = got.container as Synth;
    const main = c.entries.find((e) => e.archetype === 'text')!;
    expect(main.title).toBe('議事録');
    expect(main.body).toContain('asset:ast-shared');
    expect(got.warnings).toEqual([]);
  });

  it('.textlog.zip ── CSV を TextlogBody へ逆写像し、flags 列が正本', async () => {
    const got = await readTextlogBundle(load('single.textlog.zip'));
    const c = got.container as Synth;
    const body = JSON.parse(c.entries.find((e) => e.archetype === 'textlog')!.body);
    expect(body.entries.map((e: { id: string }) => e.id)).toEqual(['l1', 'l2']);
    // 🔑 markdown が保たれ、important が flags 列から復元される
    expect(body.entries[1].text).toBe('**重要**な発見');
    expect(body.entries[1].flags).toEqual(['important']);
    expect(got.warnings).toEqual([]);
  });
});

describe('🔴 実物: batch 3 形式(段④)', () => {
  it('texts container ── archetype を持たない manifest から text と決める', async () => {
    const got = await readContainerBundle(load('texts-container.zip'));
    const c = got.container as Synth;
    expect(c.entries.filter((e) => e.archetype === 'text').map((e) => e.title)).toEqual([
      '議事録',
      '直下メモ',
    ]);
    expect(got.warnings).toEqual([]);
  });

  it('textlogs container', async () => {
    const got = await readContainerBundle(load('textlogs-container.zip'));
    const c = got.container as Synth;
    expect(c.entries.filter((e) => e.archetype === 'textlog')).toHaveLength(1);
    expect(got.warnings).toEqual([]);
  });

  it('🔑 mixed container ── 共有添付が **1 件**に畳まれる(PKC2 は 2 本作っていた)', async () => {
    const got = await readContainerBundle(load('mixed-container.zip'));
    const c = got.container as Synth;
    // 議事録 と 直下メモ が同じ ast-shared を参照している実データ
    expect([...got.assetSources.keys()]).toEqual(['ast-shared']);
    expect(c.entries.filter((e) => e.archetype === 'attachment')).toHaveLength(1);
    expect(c.entries.map((e) => e.archetype)).toEqual([
      'attachment',
      'text',
      'text',
      'textlog',
    ]);
    expect(got.warnings).toEqual([]);
  });

  it('🔑 日本語ファイル名の内側 ZIP が読める(slugify は CJK を残す)', async () => {
    // 合成 fixture では ASCII 名しか作っていなかった ── 実物で初めて通る経路
    const got = await readContainerBundle(load('mixed-container.zip'));
    expect((got.container as Synth).entries.length).toBeGreaterThan(0);
  });
});

describe('🔴 実物: folder-export(段⑤)', () => {
  it('v1 ── 階層が復元され、空フォルダも作られる', async () => {
    const got = await readFolderExportBundle(load('folder-export-v1.zip'));
    const c = got.container as Synth;
    const byLid = new Map(c.entries.map((e) => [e.lid, e]));
    const t = new Map(c.relations.map((r) => [r.to, r.from]));

    expect([...byLid.values()].filter((e) => e.archetype === 'folder').map((e) => e.title)).toEqual(
      ['仕事', '2026 年', '空フォルダ'],
    );
    // 実データの階層: 仕事 > 2026 年 > 議事録 / 作業ログ、仕事 > 直下メモ
    expect(t.get('f-2026')).toBe('f-root');
    expect(t.get('f-empty')).toBe('f-root');
    expect(t.get('n-1')).toBe('f-2026');
    expect(t.get('g-1')).toBe('f-2026');
    expect(t.get('n-2')).toBe('f-root');
    expect(got.warnings).toEqual([]);
  });

  it('🔑 v2 ── `.entry.zip` を名指しで飛ばし、残りの階層は保つ', async () => {
    const got = await readFolderExportBundle(load('folder-export-v2.zip'));
    const c = got.container as Synth;
    const t = new Map(c.relations.map((r) => [r.to, r.from]));

    // todo は段⑥ 待ちなので入らないが、**それ以外は v1 と同じ**
    expect(c.entries.some((e) => e.title === 'やること')).toBe(false);
    expect(t.get('n-1')).toBe('f-2026');
    expect(t.get('n-2')).toBe('f-root');
    // 何を飛ばしたかを名指しで言う(PKC2 は無言 skip だった)
    expect(got.warnings.some((w) => w.includes('.entry.zip'))).toBe(true);
  });

  it('🔴 v2 の manifest が実際に version 2 + other_count を持つ', async () => {
    const got = await readFolderExportBundle(load('folder-export-v2.zip'));
    expect((got.manifest as { version: number }).version).toBe(2);
    // other_count と実際の skip 数が一致するので**照合 warning は出ない**
    expect(got.warnings.filter((w) => w.includes('ノート以外 件数'))).toEqual([]);
  });
});

describe('🔴 実物: 形式判別', () => {
  it('peekZipFormat が全形式を正しく名乗る', async () => {
    const cases: Array<[string, string]> = [
      ['package.pkc2.zip', 'pkc2-package'],
      ['single.text.zip', 'pkc2-text-bundle'],
      ['single.textlog.zip', 'pkc2-textlog-bundle'],
      ['texts-container.zip', 'pkc2-texts-container-bundle'],
      ['textlogs-container.zip', 'pkc2-textlogs-container-bundle'],
      ['mixed-container.zip', 'pkc2-mixed-container-bundle'],
      ['folder-export-v1.zip', 'pkc2-folder-export-bundle'],
      ['folder-export-v2.zip', 'pkc2-folder-export-bundle'],
      ['single.entry.zip', 'pkc2-entry-bundle'], // 段⑥(まだ受理しない)
    ];
    for (const [file, format] of cases) {
      expect(await peekZipFormat(load(file)), file).toBe(format);
    }
  });
});
