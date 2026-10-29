/** @vitest-environment happy-dom */
/**
 * 🔴 **#88: Office の初回の案内(外部の画像)は、全入口の合流点で出る**(レビュー指摘)。
 *
 * 直す前は添付の画面の「Office で開く」ボタン(`open-office`)だけが既読にしていた。ところが Office の入口は
 * 添付のボタン / 組み込みタイル / PC のファイル選択 / 控えの復元 … と多く、どれから開いても案内は 1 回出て、既読になるべきである。
 * 入口ごとに配ると足すたびに取りこぼすので、**窓を開く依頼の合流点 `OfficeWindow.open()` の `onOpen`** に 1 か所置いた。
 * ここでは**実物の `OfficeWindow`**に各入口を繋ぎ、最初の 1 回だけ言うことを見る(対照群: 二度目は黙る)。
 */
import { describe, expect, it, vi } from 'vitest';
import { OfficeWindow } from '../../src/adapter/platform/office/office-window';
import { createOfficeOpener } from '../../src/adapter/platform/office/office-open';
import { openOfficeTile, openReservedLocal, type OfficeTileDeps } from '../../src/adapter/platform/office/office-tile-open';
import { openLocalOffice } from '../../src/adapter/platform/office/open-local-office';
import { LocalOfficeFiles } from '../../src/adapter/platform/office/local-office-files';
import {
  announceOfficeImageNote,
  OfficeImageNoteStore,
  OFFICE_IMAGE_NOTE,
} from '../../src/adapter/ui/render/office-image-note';
import type { LaunchedHandle } from '../../src/adapter/platform/launched-files';
import type { LocalFileItem } from '../../src/adapter/platform/local-folder';

const memory = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};

/** 実物の窓 + 案内。放送と窓の生成だけを偽物にする。 */
function world() {
  const said: string[] = [];
  const store = new OfficeImageNoteStore(memory());
  const opened: string[] = [];
  const officeWindow = new OfficeWindow({
    openWindow: (url) => void opened.push(url),
    makeChannel: () => ({ postMessage: () => undefined, close: () => undefined, onmessage: null }),
    baseUrl: 'https://x/',
    onOpen: () => void announceOfficeImageNote(store, (t) => said.push(t)),
  });
  return { said, store, officeWindow, opened };
}

const handle = { kind: 'file', createWritable: async () => ({ write: async () => {}, close: async () => {} }) } as unknown as LaunchedHandle;
const OK = { crossOriginIsolated: true, sharedArrayBuffer: true, jspi: true, decompressionStream: true };

describe('どの入口から開いても、最初の 1 回だけ案内が出る (#88)', () => {
  it('🔴 添付の「Office で開く」(createOfficeOpener)', () => {
    const w = world();
    const opener = createOfficeOpener({
      officeWindow: w.officeWindow,
      isPackInstalled: () => true,
      readAsset: async () => new Uint8Array([1, 2, 3]),
      capability: () => OK,
    });
    const r = opener.open({ assetKey: 'k', name: '報告.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', lid: 'a' });
    expect(r.ok, '前提: 開く依頼が通っている').toBe(true);
    expect(w.said).toEqual([OFFICE_IMAGE_NOTE]);
    expect(w.store.seen()).toBe(true);
  });

  const tileDeps = (w: ReturnType<typeof world>, over: Partial<OfficeTileDeps> = {}): OfficeTileDeps => ({
    officeWindow: w.officeWindow,
    local: new LocalOfficeFiles(),
    shadows: {
      mayHaveLocal: () => false,
      findLocal: async () => null,
      orphans: () => [],
      readById: async () => null,
      discardById: async () => undefined,
    },
    askLocal: async () => null,
    askList: async () => null,
    // main.ts の `openOfficeTilePlain` が文書なしで開く形と同じ
    openPlain: () => void w.officeWindow.open({}),
    notify: () => undefined,
    afterRestore: () => undefined,
    ...over,
  });

  it('🔴 ランチャーの組み込みタイル(openOfficeTile)', () => {
    const w = world();
    openOfficeTile(tileDeps(w));
    expect(w.said).toEqual([OFFICE_IMAGE_NOTE]);
  });

  it('🔴 PC のファイル選択(窓を先に確保 → openReservedLocal)', async () => {
    const w = world();
    // main.ts の `LocalFolder.reserve`: 押した瞬間に窓を確保する
    w.officeWindow.open({ name: '見積.xlsx', expectDocument: true });
    const local = new LocalOfficeFiles();
    const item = { handle, file: new File([new Uint8Array([1, 2])], '見積.xlsx'), reserved: true } as unknown as LocalFileItem;
    const deps = tileDeps(w, { local });
    await openLocalOffice(
      {
        usable: () => true,
        local,
        officeWindow: w.officeWindow,
        openTile: () => void openOfficeTile(deps),
        openReserved: (plain) => openReservedLocal({ ...deps, openPlain: plain }),
        notify: () => undefined,
      },
      item,
    );
    expect(w.said, '確保した窓の開き時点で 1 回だけ言う').toEqual([OFFICE_IMAGE_NOTE]);
  });

  it('🔴 PC のファイル選択(窓を確保できなかった回 → タイルと同じ口)', async () => {
    const w = world();
    const local = new LocalOfficeFiles();
    const item = { handle, file: new File([new Uint8Array([1, 2])], '見積.xlsx') } as unknown as LocalFileItem;
    const deps = tileDeps(w, { local });
    await openLocalOffice(
      {
        usable: () => true,
        local,
        officeWindow: w.officeWindow,
        openTile: () => void openOfficeTile(deps),
        openReserved: () => undefined,
        notify: () => undefined,
      },
      item,
    );
    expect(w.said).toEqual([OFFICE_IMAGE_NOTE]);
  });

  it('🔴 対照群: 二度目以降はどの入口からも黙る(既読)/ 別の入口で既読にしたあとも黙る', () => {
    const w = world();
    openOfficeTile(tileDeps(w));
    openOfficeTile(tileDeps(w));
    w.officeWindow.open({ name: 'a.docx', expectDocument: true });
    expect(w.said).toHaveLength(1);
  });

  it('案内が落ちても窓は開く(案内の失敗で Office を開けなくしない)', () => {
    const opened: string[] = [];
    const win = new OfficeWindow({
      openWindow: (u) => void opened.push(u),
      makeChannel: () => ({ postMessage: () => undefined, close: () => undefined, onmessage: null }),
      baseUrl: 'https://x/',
      onOpen: () => {
        throw new Error('案内が壊れた');
      },
    });
    expect(win.open({}).kind).toBe('opened');
    expect(opened).toHaveLength(1);
  });

  it('設定を触っただけ・窓を開かないうちは既読にならない', () => {
    const w = world();
    expect(w.store.seen()).toBe(false);
    expect(w.said).toEqual([]);
    void vi;
  });
});

describe('案内の字は断定しない (#88)', () => {
  it('🔴 窓の中の読み込みを止めている根拠がコードに無いので、「表示されないことがあります」と言う', () => {
    expect(OFFICE_IMAGE_NOTE).toContain('表示されないことがあります');
    expect(OFFICE_IMAGE_NOTE).not.toContain('表示されません(');
  });
});

describe('main.ts の配線(原文 pin)', () => {
  it('🔴 本物の OfficeWindow が onOpen で案内を出す(main.ts はどの test からも実行されない)', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('src/main.ts', 'utf-8');
    expect(src).toMatch(/new OfficeWindow\(\{[\s\S]{0,900}onOpen: \(\) => void announceOfficeImageNote\(appOfficeImageNote,/);
  });
});
