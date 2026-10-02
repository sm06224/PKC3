/** @vitest-environment happy-dom */
/**
 * 🔴 **パソコンのフォルダの行を押したあと、どの取り込みへ渡すか**(#215 段②)。
 *
 * ⚠ 取り込みの本体は**全部既存の口** ── ここが守るのは「**どの口へ渡すか**」と
 *   「**同じ file を 2 回押しても増えない**」と「**書き戻しの記憶に添付を混ぜない**」の 3 つ。
 *   ⚠ Markdown の「増えない」は既存の `LaunchedFiles`(`launched-files.test.ts`)が担い、
 *   ここでは**同じ handle を渡している**ことを見る(渡し方を間違えると、記憶が働かない)。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createLocalFileOpener, type OpenLocalFileDeps } from '@adapter/ui/actions/open-local-file';
import { LaunchedFiles, splitAlreadyOpen, type LaunchedHandle } from '@adapter/platform/launched-files';
import { codeOnly } from '../helpers/code-only';

function handleOf(name: string): LaunchedHandle & { name: string } {
  const h: LaunchedHandle & { name: string } = {
    name,
    kind: 'file',
    isSameEntry: async (other) => other === h,
  };
  return h;
}

function harness(): {
  deps: OpenLocalFileDeps;
  log: string[];
  present: Set<string>;
  failAttach: { on: boolean };
} {
  const log: string[] = [];
  const present = new Set<string>();
  const failAttach = { on: false };
  let n = 0;
  const deps: OpenLocalFileDeps = {
    openNote: async (items) => void log.push(`note:${items.map((i) => i.file.name).join(',')}`),
    importContact: async (f) => void log.push(`contact:${f.name}`),
    wait: async () => void log.push('wait'),
    isPresent: (lid) => present.has(lid),
    select: (lid) => void log.push(`select:${lid}`),
    attach: async (f) => {
      log.push(`attach:${f.name}`);
      if (failAttach.on) return null;
      n += 1;
      const lid = `att-${n}`;
      present.add(lid);
      return lid;
    },
    say: (t) => void log.push(`say:${t}`),
  };
  return { deps, log, present, failAttach };
}

const item = (name: string, handle = handleOf(name)): { file: File; handle: LaunchedHandle } => ({
  file: new File(['x'], name),
  handle,
});

describe('どの口へ渡すか', () => {
  it('🔴 Markdown は OS から開いたときと同じ口へ、一覧の handle そのもので渡す', async () => {
    const { deps, log } = harness();
    const open = createLocalFileOpener(deps);
    const it1 = item('メモ.md');
    let seen: unknown = null;
    deps.openNote = async (items) => {
      seen = items[0]!.handle;
      log.push('note');
    };
    await open(it1);
    expect(log).toEqual(['note']);
    // ⚠ 写しを渡すと、記憶(isSameEntry)が働かず同じ file が増える
    expect(seen).toBe(it1.handle);
  });

  it('🔴 画像 / PDF / Office / テキスト / 知らない拡張子は添付 ── Markdown の口へは渡さない', async () => {
    for (const name of ['猫.png', 'a.PDF', '報告.docx', '表.xlsx', 'メモ.txt', 'x.unknown']) {
      const { deps, log } = harness();
      await createLocalFileOpener(deps)(item(name));
      expect(log, name).toEqual(['wait', `attach:${name}`]);
    }
  });

  it('🔴 vCard はいつもの取込へ(連絡先になる)── 添付にしない', async () => {
    const { deps, log } = harness();
    await createLocalFileOpener(deps)(item('名刺.vcf'));
    expect(log).toEqual(['contact:名刺.vcf']);
  });
});

describe('同じ file を 2 回押しても増えない(添付)', () => {
  it('🔴 2 回目は取り込まず、すでに在るノートを開く', async () => {
    const { deps, log } = harness();
    const open = createLocalFileOpener(deps);
    const png = item('猫.png');
    await open(png);
    await open(png);
    expect(log.filter((l) => l.startsWith('attach:')), '2 回取り込んだ').toHaveLength(1);
    expect(log).toContain('select:att-1');
    expect(log.some((l) => l.startsWith('say:')), '黙って開き直した').toBe(true);
  });

  it('🔴 別の file(同じ名前でも)は別に取り込む ── 名前で取り違えない', async () => {
    const { deps, log } = harness();
    const open = createLocalFileOpener(deps);
    await open(item('猫.png', handleOf('猫.png')));
    await open(item('猫.png', handleOf('猫.png')));
    expect(log.filter((l) => l.startsWith('attach:'))).toHaveLength(2);
  });

  it('🔴 ごみ箱へ入れた後に押したら、取り込み直す', async () => {
    const { deps, log, present } = harness();
    const open = createLocalFileOpener(deps);
    const png = item('猫.png');
    await open(png);
    present.clear();
    await open(png);
    expect(log.filter((l) => l.startsWith('attach:'))).toHaveLength(2);
  });

  it('🔴 作れなかった回は憶えない ── 次の 1 回で取り込み直せる', async () => {
    const { deps, log, failAttach } = harness();
    const open = createLocalFileOpener(deps);
    const png = item('猫.png');
    failAttach.on = true;
    await open(png);
    failAttach.on = false;
    await open(png);
    expect(log.filter((l) => l.startsWith('attach:'))).toHaveLength(2);
    expect(log.some((l) => l.startsWith('select:'))).toBe(false);
  });

  it('🔴 添付の記憶は、書き戻しの記憶(launched)とは別の入れ物', async () => {
    // ⚠ 混ぜると、添付の lid が `write-back-file` の相手になり、画像へノートの本文が書かれる。
    //    main.ts は `launched` を 1 つしか作らず、opener は自前の `LaunchedFiles` を持つ。
    const main = codeOnly(readFileSync('src/main.ts', 'utf-8'));
    expect(main.match(/new LaunchedFiles\(\)/g), 'main に記憶が 2 つ在る').toHaveLength(1);
    const mod = codeOnly(readFileSync('src/adapter/ui/actions/open-local-file.ts', 'utf-8'));
    expect(mod.match(/new LaunchedFiles\(\)/g)).toHaveLength(1);
    // 対照群 ── 別の記憶なら、片方に入れた物はもう片方から見えない
    const a = new LaunchedFiles();
    const b = new LaunchedFiles();
    const h = handleOf('x.png');
    a.remember('l1', h, 'x.png');
    const { fresh } = await splitAlreadyOpen([{ handle: h }], b, () => true);
    expect(fresh).toHaveLength(1);
  });
});

describe('main.ts の配線(原文)', () => {
  const main = codeOnly(readFileSync('src/main.ts', 'utf-8'));

  it('🔴 Markdown は importLaunchFiles ── 取り込み・元ファイルとの結び・同じ file の判定が同じ', () => {
    const at = main.indexOf('createLocalFileOpener({');
    expect(at, '取り込みの口を組んでいない').toBeGreaterThan(-1);
    const block = main.slice(at, at + 1600);
    expect(block).toContain('openNote: importLaunchFiles');
    expect(block, '添付は待つ側の gate').toContain('withAssetGate.queued');
    expect(block).toContain('attachOne(');
    expect(block).toContain('whenAcceptingUnrefusedImport');
  });

  it('🔴 押し口と描画が同じ LocalFolder を握っている', () => {
    expect(main.match(/new LocalFolder\(/g)).toHaveLength(1);
    expect(main).toMatch(/const services: BinderServices = \{\s*(\/\/[^\n]*\n\s*)*localFolder,/);
    expect(main).toMatch(/new BrowseRouter\([\s\S]*?localFolder,\s*\);/);
    expect(main).toContain('openLocalFile = createLocalFileOpener(');
  });
});
