/** @vitest-environment node */
/**
 * 「自分のパソコンで動かす」の実行部(#532 段 B)。
 *
 * 🔴 ここで守るのは **欠けた一式を渡さないこと**である。1 file 欠けた zip は、
 * 展開して起動して初めて「白い画面」として症状が出る ── そのとき user には
 * **何が起きたのか分からない**。落ちる場所は「組んでいるあいだ」でなければならない。
 */
import { describe, expect, it } from 'vitest';
import { downloadSelfhostBundle, type SelfhostDeps } from '../../src/adapter/ui/actions/selfhost';
import { PRECACHE_LIST_FILE } from '../../src/features/selfhost/precache-list';
import { SELFHOST_ROOT, SELFHOST_SITE } from '../../src/features/selfhost/bundle';

/** 配っている物を持つ、偽の origin。 */
function server(files: Record<string, string>): SelfhostDeps['fetchFile'] {
  return async (path: string) => {
    const key = path.replace(/^\.\//, '');
    const body = files[key];
    if (body === undefined) return new Response('not found', { status: 404 });
    return new Response(body, { status: 200 });
  };
}

function deps(files: Record<string, string>): {
  d: SelfhostDeps;
  got: { name: string; blob: Blob }[];
  said: string[];
} {
  const got: { name: string; blob: Blob }[] = [];
  const said: string[] = [];
  return {
    got,
    said,
    d: {
      fetchFile: server(files),
      download: (name, blob) => got.push({ name, blob }),
      notify: (m) => said.push(m),
      stamp: () => '2026-09-09',
    },
  };
}

const HEALTHY = {
  [PRECACHE_LIST_FILE]: JSON.stringify(['./index.html', './assets/a-AAAAAAAA.js']),
  'index.html': '<!doctype html>',
  'assets/a-AAAAAAAA.js': 'console.log(1)',
  // ⚠ **precache の一覧には出てこない**(SW は自分を焼かない)が、配るのに要る
  'sw.js': 'self.addEventListener("fetch", () => {});',
};

/** ZIP の中の名前を読む(中央ディレクトリではなく local header を走査する)。 */
async function namesIn(blob: Blob): Promise<string[]> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  const dec = new TextDecoder();
  const out: string[] = [];
  for (let i = 0; i + 30 <= buf.length; i += 1) {
    if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x03 && buf[i + 3] === 0x04) {
      const nameLen = buf[i + 26]! | (buf[i + 27]! << 8);
      const size = buf[i + 18]! | (buf[i + 19]! << 8) | (buf[i + 20]! << 16) | (buf[i + 21]! << 24);
      out.push(dec.decode(buf.subarray(i + 30, i + 30 + nameLen)));
      i += 30 + nameLen + size - 1;
    }
  }
  return out;
}

describe('自分のパソコンで動かす ── 一式を組む', () => {
  it('配っている物が全部 site の下に入り、起動の口も同梱される', async () => {
    const { d, got } = deps(HEALTHY);
    await downloadSelfhostBundle(d);
    expect(got).toHaveLength(1);
    expect(got[0]!.name).toBe('pkc3-selfhost-2026-09-09.zip');
    const names = await namesIn(got[0]!.blob);
    expect(names).toContain(`${SELFHOST_ROOT}/${SELFHOST_SITE}/index.html`);
    expect(names).toContain(`${SELFHOST_ROOT}/${SELFHOST_SITE}/assets/a-AAAAAAAA.js`);
    expect(names).toContain(`${SELFHOST_ROOT}/start-windows.cmd`);
    expect(names).toContain(`${SELFHOST_ROOT}/start-mac-linux.sh`);
    expect(names).toContain(`${SELFHOST_ROOT}/はじめに.txt`);
    // 🔴 これが無いと、落とした一式は**オフラインでも分離でも**動かない
    expect(names, 'Service Worker が入っていない').toContain(
      `${SELFHOST_ROOT}/${SELFHOST_SITE}/sw.js`,
    );
  });

  /**
   * ⚠ **在れば入れる**(`portable-template.html`)── 配る workflow が後から置く物で、
   *   無い配信もある。取れなかったことを**欠品に数えない**。
   */
  it('持ち歩ける 1 枚の雛形は、在れば入り、無くても組める', async () => {
    const withTpl = { ...HEALTHY, 'portable-template.html': '<!doctype html>' };
    const a = deps(withTpl);
    await downloadSelfhostBundle(a.d);
    expect(await namesIn(a.got[0]!.blob)).toContain(
      `${SELFHOST_ROOT}/${SELFHOST_SITE}/portable-template.html`,
    );
    // ⚠ **対照群** ── 無い配信でも落ちない(規則が「必須」に化けていない)
    const b = deps(HEALTHY);
    await downloadSelfhostBundle(b.d);
    expect(b.got).toHaveLength(1);
  });

  it('🔴 1 件でも取れなければ、欠けた一式を渡さない', async () => {
    const broken: Record<string, string> = { ...HEALTHY };
    delete broken['assets/a-AAAAAAAA.js'];
    const { d, got } = deps(broken);
    await expect(downloadSelfhostBundle(d)).rejects.toThrow('1 件取れませんでした');
    expect(got, '欠けたまま落としている').toHaveLength(0);
  });

  it('一覧が読めなければ、そこで止まる', async () => {
    const { d, got } = deps({ 'index.html': 'x' });
    await expect(downloadSelfhostBundle(d)).rejects.toThrow(PRECACHE_LIST_FILE);
    expect(got).toHaveLength(0);
  });

  it('🔴 一覧が空なら組まない(中身の無い zip を配らない)', async () => {
    const { d, got } = deps({ [PRECACHE_LIST_FILE]: '[]' });
    await expect(downloadSelfhostBundle(d)).rejects.toThrow('空です');
    expect(got).toHaveLength(0);
  });

  it('押した直後と、落ちた後に、画面へ言う(無言にしない)', async () => {
    const { d, said } = deps(HEALTHY);
    await downloadSelfhostBundle(d);
    expect(said).toHaveLength(2);
    expect(said[0]).toContain('組んでいます');
    expect(said[1]).toContain('http://localhost:8787');
  });
});
