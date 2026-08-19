/**
 * 🔴 **旧ビルドの本体タブでも起動を止めない**(#286)。
 *
 * 2026-08-19 に実機で踏んだ:多重タブで**本体が旧ビルド**のとき、新しい follower が
 * 投げる `resolveContainer` を旧 worker が知らず、**起動が丸ごと失敗**した
 * (`未知の op です: resolveContainer`)。
 *
 * ⚠ この配線は `main.ts` に在ったが、あの file は**どの test からも実行されない**
 * ので、取り違えが全 test 緑のまま通る(CLAUDE.md §2)── 判断を取り出して here で試す。
 */
import { describe, expect, it } from 'vitest';
import {
  LEGACY_CID,
  isUnknownOpError,
  resolveContainerCompat,
  type ContainerPorts,
} from '../../src/adapter/platform/storage/resolve-container-compat';

/** 新しい本体(採番済みの id を返す)。 */
function modernPorts(cid = 'c-0123456789abcdef0123456789abcdef'): {
  ports: ContainerPorts;
  opened: string[];
} {
  const opened: string[] = [];
  return {
    opened,
    ports: {
      resolveContainer: async () => ({ cid }),
      openLegacyContainer: async (c) => void opened.push(c),
    },
  };
}

/** 旧ビルドの本体(その op を知らない)。 */
function legacyPorts(message = 'Error: 未知の op です: resolveContainer'): {
  ports: ContainerPorts;
  opened: Array<[string, string]>;
} {
  const opened: Array<[string, string]> = [];
  return {
    opened,
    ports: {
      resolveContainer: () => Promise.reject(new Error(message)),
      openLegacyContainer: async (c, t) => void opened.push([c, t]),
    },
  };
}

describe('器の決め方(旧ビルドの本体との互換)', () => {
  it('新しい本体なら、採番済みの id をそのまま使う', async () => {
    const { ports, opened } = modernPorts();
    const r = await resolveContainerCompat(ports, 'PKC3');
    expect(r).toEqual({ cid: 'c-0123456789abcdef0123456789abcdef', legacy: false });
    expect(opened, '新しい本体なのに旧 id を開いた').toEqual([]);
  });

  /**
   * 🔴 **これが本体**。旧ビルドの本体に断られても**起動を続ける**。
   * ⚠ 直す前は、ここで例外が上まで抜けて**アプリが開かなかった**。
   */
  it('🔴 旧ビルドの本体に断られたら、旧 id へ落ちて起動を続ける', async () => {
    const { ports, opened } = legacyPorts();
    const r = await resolveContainerCompat(ports, 'PKC3');
    expect(r).toEqual({ cid: LEGACY_CID, legacy: true });
    // ⚠ 旧本体が持っているデータの区画を**実際に開く**(開かないと空に見える)
    expect(opened, '旧 id の器を開いていない').toEqual([['default', 'PKC3']]);
  });

  /**
   * ⚠ **名指しの門が入る前のビルド**は `handler is not a function` を出す。
   * ここを落とすと、いちばん古い本体だけが救われない。
   */
  it('🔴 名指しの門が無い古いビルドの断り方も拾う', async () => {
    const { ports } = legacyPorts('TypeError: handler is not a function');
    expect((await resolveContainerCompat(ports, 'PKC3')).legacy).toBe(true);
  });

  /**
   * 🔴 **握りつぶす範囲を狭くする。**
   * ⚠ 何でも旧 id へ落とすと、採番済みの端末が一時的な失敗のたびに
   *   **空の器**を開く ── user から見れば「データが全部消えた」である。
   */
  it('🔴 「知らない op」以外の失敗は握りつぶさず、そのまま投げる', async () => {
    const opened: string[] = [];
    const ports: ContainerPorts = {
      resolveContainer: () => Promise.reject(new Error('database is locked')),
      openLegacyContainer: async (c) => void opened.push(c),
    };
    await expect(resolveContainerCompat(ports, 'PKC3')).rejects.toThrow('database is locked');
    expect(opened, '本当の失敗なのに旧 id を開いた(空の器を作る経路)').toEqual([]);
  });

  it('断りの見分け方', () => {
    expect(isUnknownOpError(new Error('未知の op です: resolveContainer'))).toBe(true);
    expect(isUnknownOpError(new Error('TypeError: handler is not a function'))).toBe(true);
    expect(isUnknownOpError(new Error('database is locked')), '広く拾いすぎ').toBe(false);
    expect(isUnknownOpError(new Error('storage worker error: load failed')), '広く拾いすぎ').toBe(
      false,
    );
  });

  /**
   * ⚠ **旧 id を開くのに失敗したら、そこは投げる** ── 「落ちたのに開いたつもり」で
   * 進むと、以後の全 op が誰も居ない区画に当たる。
   */
  it('旧 id の器も開けなかったら投げる', async () => {
    const ports: ContainerPorts = {
      resolveContainer: () => Promise.reject(new Error('未知の op です: resolveContainer')),
      openLegacyContainer: () => Promise.reject(new Error('disk full')),
    };
    await expect(resolveContainerCompat(ports, 'PKC3')).rejects.toThrow('disk full');
  });

  /**
   * 🔴 **boot が呼ぶ新しい op は、旧本体に断られても進めなければならない**
   * (#286 の再発防止)。⚠ `main.ts` は原文を読む test しか無いので、
   *   ここは**字面**で見る ── 弱いと自覚して使う。
   */
  it('🔴 boot の器の決定が、素の request 直呼びに戻っていない', async () => {
    const { readFileSync } = await import('node:fs');
    const code = readFileSync('src/main.ts', 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    expect(code.length, 'コメント落としが本体まで消した').toBeGreaterThan(1000);
    expect(code, 'boot が退避路を持たない直呼びに戻っている').not.toMatch(
      /const\s+cid\s*=\s*\(await\s+client\.request\(\{\s*op:\s*'resolveContainer'/,
    );
    expect(code, '互換の入口を通っていない').toContain('resolveContainerCompat(');
  });
});
