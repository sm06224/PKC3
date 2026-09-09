/** @vitest-environment node */
/**
 * 「自分のパソコンで動かす」一式(#532 段 B)の中身を縛る。
 *
 * 🔴 ここで守るのは **user のノートが消えたように見えないこと**である ──
 * origin(住所)が変わると OPFS も IndexedDB も別物になるので、
 * スクリプトが「空いている番号を探す」形になった瞬間、
 * **前に書いたノートが 1 件も見えなくなる**(設計 doc §3)。
 * ⚠ だから「動くか」ではなく「**住所を動かさないか**」を先に pin する。
 */
import { describe, expect, it } from 'vitest';
import {
  README_TXT,
  SELFHOST_ORIGIN,
  SELFHOST_PORT,
  SELFHOST_ROOT,
  SELFHOST_SITE,
  SERVE_MJS,
  SERVE_PY,
  START_CMD,
  START_PS1,
  START_SH,
  planSiteFiles,
  selfhostExtras,
  selfhostZipName,
  siteEntryName,
} from '../../src/features/selfhost/bundle';
import { parsePrecacheList, precacheEntryPath } from '../../src/features/selfhost/precache-list';

/** 起動する側 3 本(この 3 本が住所を決める)。 */
const STARTERS: readonly (readonly [string, string])[] = [
  ['serve.py', SERVE_PY],
  ['serve.mjs', SERVE_MJS],
  ['start.ps1', START_PS1],
];

describe('🔴 住所を動かさない(動くと user のノートが見えなくなる)', () => {
  it('3 本とも、同じ 1 つの番号だけを持つ', () => {
    for (const [name, text] of STARTERS) {
      const ports = [...text.matchAll(/\b(\d{4,5})\b/g)].map((m) => m[1]);
      expect(ports.length, `${name} が番号を 1 つも持っていない`).toBeGreaterThan(0);
      expect(new Set(ports), `${name} に別の番号が混ざっている`).toEqual(
        new Set([String(SELFHOST_PORT)]),
      );
    }
  });

  it('🔴 3 本とも「空いている番号を探す」を持たない', () => {
    // ⚠ 直したい衝動が出るのはここ ── 親切に見えて、いちばん怖い壊れ方をする
    for (const [name, text] of STARTERS) {
      expect(text, `${name} が番号を足している`).not.toMatch(/port\s*\+\+|PORT\s*\+\s*1|\$port \+ 1/i);
    }
  });

  it('埋まっていたら、番号を変えずに止める理由が出る', () => {
    for (const [name, text] of STARTERS) {
      // ⚠ 字を丸ごと一致させない ── Windows は「使われているか、**許可がありません**」と
      //    2 つの理由を出す必要がある(HttpListener は権限でも始まらない)。
      //    ここで縛りたいのは**理由を出すこと**であって、文言の同一ではない
      expect(text, `${name} に理由が無い`).toMatch(/ポート.*使われて|使われて.*ポート|\$port が使われて/);
      expect(text, `${name} が「見えなくなる」を言っていない`).toContain('見えなくなります');
    }
  });

  it('user に見せる住所と、開ける住所が同じ字', () => {
    expect(SELFHOST_ORIGIN).toBe(`http://localhost:${String(SELFHOST_PORT)}`);
    expect(README_TXT).toContain(SELFHOST_ORIGIN);
    expect(SERVE_PY).toContain(SELFHOST_ORIGIN);
    expect(SERVE_MJS).toContain(SELFHOST_ORIGIN);
    expect(START_PS1).toContain(SELFHOST_ORIGIN);
  });

  it('🔴 ほかの端末からは読めない(LAN に晒さない)', () => {
    // ⚠ LAN の住所は secure context ではないので、届いても SW も OPFS も動かない
    expect(SERVE_PY).toContain("'127.0.0.1'");
    expect(SERVE_MJS).toContain("'127.0.0.1'");
    expect(SERVE_PY).not.toContain('0.0.0.0');
    expect(SERVE_MJS).not.toContain('0.0.0.0');
  });
});

describe('入口 ── 在るかではなく、走るかで選ぶ', () => {
  it('🔴 python3 / python / node を、実際に走らせて選ぶ', () => {
    // ⚠ macOS の /usr/bin/python3 も Windows の python3 も「殻」が在り、
    //    `command -v` は成功する ── 走らせないと見分けられない
    expect(START_SH).toContain('python3 -c ""');
    expect(START_SH).toContain('node -e ""');
    expect(START_SH, '在るかで判定している').not.toMatch(/command -v|which /);
  });

  it('1 つも無ければ、何を入れればよいかを出して止まる', () => {
    expect(START_SH).toContain('Python 3');
    expect(START_SH).toContain('Node.js');
    expect(START_SH).toContain('exit 1');
  });

  it('Windows は実行ポリシーを user に触らせない', () => {
    expect(START_CMD).toContain('-ExecutionPolicy Bypass');
    expect(START_CMD).toContain('start.ps1');
  });

  it('Windows 向けの 2 本は CRLF(メモ帳で 1 行にならない)', () => {
    for (const [name, text] of [
      ['start-windows.cmd', START_CMD],
      ['start.ps1', START_PS1],
      ['はじめに.txt', README_TXT],
    ] as const) {
      expect(text.includes('\r\n'), `${name} が LF のまま`).toBe(true);
      expect(text.replace(/\r\n/g, ''), `${name} に裸の LF がある`).not.toContain('\n');
    }
  });
});

describe('zip に入る物', () => {
  it('site の下に置き、根に散らかさない', () => {
    expect(siteEntryName('./assets/index-AAAAAAAA.js')).toBe(
      `${SELFHOST_ROOT}/${SELFHOST_SITE}/assets/index-AAAAAAAA.js`,
    );
    for (const name of selfhostExtras().keys()) {
      expect(name.startsWith(`${SELFHOST_ROOT}/`), `${name} が根に出ている`).toBe(true);
    }
  });

  it('🔴 絶対 path は受けない(どこに置いても動く、が崩れた合図)', () => {
    expect(() => precacheEntryPath('/assets/index-AAAAAAAA.js')).toThrow('根に決め打ち');
  });

  it('重複を畳み、並びを固定する(同じ入力から同じ zip)', () => {
    expect(planSiteFiles(['./b.js', './a.js', 'b.js'])).toEqual(['a.js', 'b.js', 'sw.js']);
  });

  /**
   * 🔴 **`sw.js` を必ず入れる**(2026-09-09、実地の probe で見つけた)。
   *
   * ⚠ 「配る物の一覧 = precache の一覧」ではない ── `sw.js` は**自分を precache
   *   しない**ので一覧に現れない。落ちた一式にこれが無いと、
   *   ①オフラインで開かない ②**分離(COOP/COEP)が生まれない**(= Office が動かない。
   *   それはセルフホストする理由そのものである)。
   * ⚠ しかも症状は console の 404 が 1 行だけで、**画面はふつうに起動して見える**。
   */
  it('🔴 Service Worker(sw.js)が一式に入る ── 無いと分離もオフラインも死ぬ', () => {
    expect(planSiteFiles(['./index.html'])).toContain('sw.js');
    // ⚠ 二重に入れない(ZipWriter は同名を断るので、入ると組めなくなる)
    expect(planSiteFiles(['./index.html', './sw.js']).filter((f) => f === 'sw.js')).toHaveLength(1);
  });

  it('🔴 空の一覧は組ませない(中身の無い zip を配らない)', () => {
    expect(() => planSiteFiles([])).toThrow('1 つも無い');
    expect(() => parsePrecacheList('[]')).toThrow('空です');
    expect(() => parsePrecacheList('{}')).toThrow('配列ではありません');
    expect(() => parsePrecacheList('[1]')).toThrow('文字列でない');
  });

  it('名前に日付が入る(古い一式と混ざっても見分けられる)', () => {
    expect(selfhostZipName('2026-09-09')).toBe('pkc3-selfhost-2026-09-09.zip');
  });

  it('起動の入口が 3 OS ぶん揃っている', () => {
    const names = [...selfhostExtras().keys()].map((n) => n.slice(SELFHOST_ROOT.length + 1));
    expect(new Set(names)).toEqual(
      new Set(['serve.py', 'serve.mjs', 'start-mac-linux.sh', 'start-windows.cmd', 'start.ps1', 'はじめに.txt']),
    );
  });
});
