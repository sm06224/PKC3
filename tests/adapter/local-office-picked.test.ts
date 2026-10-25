/** @vitest-environment happy-dom */
/**
 * 🔴 **選んで開いた手元の Office ファイル(PC タブの行 / 「Office のファイルを開く…」)**(#432)。
 *
 * 守ること: ①Office の行は Office の口へ渡り、使えない環境だけ添付に落ちる ②書き込みの許可は**開く操作の中**で訊く
 * ③許可が無い / 書く口が無い / handle が無い file は、保存を失わずダウンロードに保存する
 * ④書き戻せるときはダウンロードしない(対照群)。
 */
import { describe, expect, it } from 'vitest';
import {
  LocalOfficeFiles,
  requestWritePermission,
} from '@adapter/platform/office/local-office-files';
import { openLocalOffice } from '@adapter/platform/office/open-local-office';
import { createLocalFileOpener, type OpenLocalFileDeps } from '@adapter/ui/actions/open-local-file';
import { fileKindOf } from '@features/local-folder/folder-entries';
import type { LaunchedHandle } from '@adapter/platform/launched-files';
import type { LocalFileItem } from '@adapter/platform/local-folder';
import { PcFolderPlaceStore } from '@adapter/ui/render/pc-folder-place';

interface Fake {
  handle: LaunchedHandle;
  written: Uint8Array[];
  asked: string[];
}

function fake(perm: 'granted' | 'prompt' | 'denied', grantOnRequest = true, writable = true): Fake {
  const written: Uint8Array[] = [];
  const asked: string[] = [];
  let state: string = perm;
  const handle: LaunchedHandle = {
    kind: 'file',
    queryPermission: async () => state,
    requestPermission: async () => {
      asked.push('request');
      if (grantOnRequest) state = 'granted';
      return grantOnRequest ? 'granted' : 'denied';
    },
    ...(writable
      ? {
          createWritable: async () => ({
            write: async (d: unknown) => void written.push(d as Uint8Array),
            close: async () => {},
          }),
        }
      : {}),
  };
  return { handle, written, asked };
}

const bytes = new Uint8Array([1, 2, 3]);

describe('requestWritePermission', () => {
  it('許可済みなら訊かずに true / prompt なら requestPermission を訊いて結果を返す', async () => {
    const a = fake('granted');
    expect(await requestWritePermission(a.handle)).toBe(true);
    expect(a.asked).toEqual([]);
    const b = fake('prompt', true);
    expect(await requestWritePermission(b.handle)).toBe(true);
    expect(b.asked).toEqual(['request']);
    const c = fake('prompt', false);
    expect(await requestWritePermission(c.handle)).toBe(false);
  });

  it('書く口が無い handle(input で選んだ file)は false。訊きもしない', async () => {
    const f = fake('prompt', true, false);
    expect(await requestWritePermission(f.handle)).toBe(false);
    expect(f.asked).toEqual([]);
  });

  it('許可を訊いて投げられても false(落ちない)', async () => {
    const h: LaunchedHandle = {
      createWritable: async () => ({ write: async () => {}, close: async () => {} }),
      queryPermission: async () => {
        throw new Error('x');
      },
    };
    expect(await requestWritePermission(h)).toBe(false);
  });
});

describe('保存 ── 書き戻す / ダウンロードに保存する', () => {
  it('書き戻せるときは元の file へ書き、ダウンロードしない(対照群)', async () => {
    const dl: string[] = [];
    const files = new LocalOfficeFiles((n) => void dl.push(n));
    const f = fake('granted');
    const st = files.stage(f.handle, 'a.docx', bytes, 1, true);
    files.take();
    expect(await files.writeBack(st.token, bytes)).toBe(true);
    expect(f.written).toHaveLength(1);
    expect(dl).toEqual([]);
  });

  it('許可が断られたら、ダウンロードに保存する(元の file には書かない)', async () => {
    const dl: { n: string; b: Uint8Array }[] = [];
    const files = new LocalOfficeFiles((n, b) => void dl.push({ n, b }));
    const f = fake('prompt', false);
    const st = files.stage(f.handle, 'a.docx', bytes, 1, false);
    expect(st.writable, '書けない開き方なのに writable').toBe(false);
    files.take();
    expect(await files.writeBack(st.token, bytes)).toBe('downloaded');
    expect(f.written, '断られたのに書いた').toEqual([]);
    expect(dl).toEqual([{ n: 'a.docx', b: bytes }]);
  });

  it('書く口が無い handle(input で選んだ file)は unsupported → ダウンロード', async () => {
    const dl: string[] = [];
    const files = new LocalOfficeFiles((n) => void dl.push(n));
    const f = fake('granted', true, false);
    const st = files.stage(f.handle, 'b.xlsx', bytes, 1);
    files.take();
    expect(await files.writeBack(st.token, bytes)).toBe('downloaded');
    expect(dl).toEqual(['b.xlsx']);
  });

  it('ダウンロードの口が無ければ、従来どおり理由を返す(保存を偽らない)', async () => {
    const files = new LocalOfficeFiles();
    const f = fake('granted', true, false);
    const st = files.stage(f.handle, 'b.xlsx', bytes, 1);
    files.take();
    expect(await files.writeBack(st.token, bytes)).toBe('unsupported');
  });

  it('元の file が動かされた(reopen)ときはダウンロードにしない(従来どおり開き直しを案内)', async () => {
    const dl: string[] = [];
    const files = new LocalOfficeFiles((n) => void dl.push(n));
    const h: LaunchedHandle = {
      queryPermission: async () => 'granted',
      createWritable: async () => {
        throw new DOMException('gone', 'NotFoundError');
      },
    };
    const st = files.stage(h, 'a.docx', bytes, 1);
    files.take();
    expect(await files.writeBack(st.token, bytes)).toBe('reopen');
    expect(dl).toEqual([]);
  });
});

describe('openLocalOffice', () => {
  const item = (h: LaunchedHandle, name = 'r.docx'): LocalFileItem => ({
    file: new File([bytes], name, { lastModified: 5 }),
    handle: h,
  });

  it('使える環境では、書く許可を訊いてから控えて、Office のタイルと同じ口を開く', async () => {
    const f = fake('prompt', true);
    const log: string[] = [];
    const files = new LocalOfficeFiles();
    const r = await openLocalOffice(
      { usable: () => true, local: files, openTile: () => void log.push(`open:${files.pendingName()}`) },
      item(f.handle),
    );
    expect(r).toBe(true);
    expect(f.asked, '開く操作の中で許可を訊いていない').toEqual(['request']);
    expect(log, '控えてから開く').toEqual(['open:r.docx']);
    expect(files.peek()).toEqual({ name: 'r.docx', size: 3, modifiedAt: 5 });
    expect(files.take()!.writable).toBe(true);
  });

  it('許可を断られても開く。ただし書き戻せない開き方(writable=false)', async () => {
    const f = fake('prompt', false);
    const files = new LocalOfficeFiles();
    expect(await openLocalOffice({ usable: () => true, local: files, openTile: () => {} }, item(f.handle))).toBe(true);
    expect(files.take()!.writable).toBe(false);
  });

  it('使えない環境では何もしない(false ── 呼び手が添付にする)', async () => {
    const files = new LocalOfficeFiles();
    let opened = false;
    const r = await openLocalOffice(
      { usable: () => false, local: files, openTile: () => void (opened = true) },
      item(fake('granted').handle),
    );
    expect(r).toBe(false);
    expect(opened).toBe(false);
    expect(files.pendingName()).toBeNull();
  });
});

describe('PC タブの Office の行', () => {
  it('Office は route=office で書き戻せる側。Markdown 以外の添付は従来どおり書き戻せない(対照群)', () => {
    expect(fileKindOf('報告.docx')).toMatchObject({ route: 'office', writeBack: true, label: 'Office' });
    for (const n of ['a.xlsx', 'b.PPTX']) expect(fileKindOf(n).route).toBe('office');
    expect(fileKindOf('a.pdf')).toMatchObject({ route: 'attachment', writeBack: false });
    expect(fileKindOf('a.png').writeBack).toBe(false);
  });

  function opener(openOffice?: OpenLocalFileDeps['openOffice']) {
    const log: string[] = [];
    const deps: OpenLocalFileDeps = {
      openNote: async () => {},
      importContact: async () => null,
      openContacts: () => {},
      wait: async () => void log.push('wait'),
      isPresent: () => false,
      select: () => {},
      attach: async (f) => {
        log.push(`attach:${f.name}`);
        return 'att-1';
      },
      say: () => {},
      ...(openOffice === undefined ? {} : { openOffice }),
    };
    return { open: createLocalFileOpener(deps), log };
  }
  const it1 = (name: string): LocalFileItem => ({ file: new File(['x'], name), handle: { kind: 'file' } });

  it('Office の口が引き受けたら添付にしない', async () => {
    const { open, log } = opener(async (i) => {
      log.push(`office:${i.file.name}`);
      return true;
    });
    await open(it1('報告.docx'));
    expect(log).toEqual(['office:報告.docx']);
  });

  it('引き受けなかった(使えない環境)ら従来どおり添付 / Office 以外は口を呼ばない', async () => {
    const { open, log } = opener(async () => false);
    await open(it1('報告.docx'));
    expect(log).toEqual(['wait', 'attach:報告.docx']);
    const b = opener(async () => {
      throw new Error('Office 以外で呼ばれた');
    });
    await b.open(it1('猫.png'));
    expect(b.log).toEqual(['wait', 'attach:猫.png']);
  });
});

describe('開いている階層の記憶の store', () => {
  const mem = () => {
    const m = new Map<string, string>();
    return { m, st: { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) } };
  };
  it('書いた値が読める。壊れた値は憶えていない扱い', () => {
    const { m, st } = mem();
    const s = new PcFolderPlaceStore(st);
    expect(s.get()).toBeNull();
    s.set({ root: '資料', path: ['下', '奥'] });
    expect(new PcFolderPlaceStore(st).get()).toEqual({ root: '資料', path: ['下', '奥'] });
    for (const bad of ['not json', '{"r":1,"p":[]}', '{"r":"a","p":[1]}', '{"r":"","p":[]}', '{"r":"a"}']) {
      m.set('pkc3.pc-folder-place', bad);
      expect(new PcFolderPlaceStore(st).get(), bad).toBeNull();
    }
  });
  it('保存が無い環境でも、この session では効く', () => {
    const s = new PcFolderPlaceStore(null);
    s.set({ root: 'a', path: [] });
    expect(s.get()).toEqual({ root: 'a', path: [] });
  });
});
