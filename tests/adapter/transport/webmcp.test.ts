/**
 * ブラウザの AI(WebMCP)への登録(#1407 段①)。
 *
 * 守る主張:
 * 1. flag オンかつメインのタブ(holder)のときだけ登録する(follower・flag オフでは 1 本も登録しない)
 * 2. 入口が無い(`document.modelContext` も `navigator.modelContext` も無い)ブラウザでは何もしない
 *    ── 例外も出さない(対応していない Chromium でも何も壊れない)
 * 3. 全部の道具を同じ signal で登録し、abort で全部消える(`stop` / follower への降格)
 * 4. 2 度呼んでも二重に登録しない / 降格後に昇格したらもう一度登録する
 * 5. 登録が落ちても(同期でも非同期でも)起動を止めない
 * 6. `main.ts` の配線(原文 pin。弱いと自覚して使う)── 作る道は C-4 と同じ 1 本
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createWebMcpRegistration } from '@adapter/transport/webmcp';
import type { ModelContextTool, ModelContextLike } from '@features/agent/webmcp-types';
import { codeOnly } from '../../helpers/code-only';

const tool = (name: string): ModelContextTool => ({
  name,
  description: `${name} の説明です`,
  inputSchema: { type: 'object', properties: {} },
  execute: async () => ({ content: [{ type: 'text', text: '' }] }),
});

function fakeModelContext() {
  const registered: Array<{ tool: ModelContextTool; signal: AbortSignal | undefined }> = [];
  const mc: ModelContextLike = {
    registerTool: (t, options) => {
      registered.push({ tool: t, signal: options?.signal });
      return Promise.resolve(undefined);
    },
  };
  /** abort されずに残っている登録(= いま AI から見えている道具)。 */
  const alive = () => registered.filter((r) => r.signal?.aborted !== true).map((r) => r.tool.name);
  return { mc, registered, alive };
}

describe('createWebMcpRegistration', () => {
  it('flag オン + holder で、4 本とも signal つきで登録する', () => {
    const f = fakeModelContext();
    const reg = createWebMcpRegistration({
      enabled: () => true,
      host: { document: { modelContext: f.mc } },
      tools: () => ['a', 'b', 'c', 'd'].map(tool),
    });
    reg.sync(true);
    expect(f.registered.map((r) => r.tool.name)).toEqual(['a', 'b', 'c', 'd']);
    expect(f.registered.every((r) => r.signal instanceof AbortSignal)).toBe(true);
    expect(reg.active()).toBe(true);
  });

  it('🔴 follower(holder でない)では 1 本も登録しない', () => {
    const f = fakeModelContext();
    const reg = createWebMcpRegistration({
      enabled: () => true,
      host: { document: { modelContext: f.mc } },
      tools: () => [tool('a')],
    });
    reg.sync(false);
    expect(f.registered).toEqual([]);
    expect(reg.active()).toBe(false);
  });

  it('🔴 flag がオフなら登録しない(holder でも)。`tools` も作らない', () => {
    const f = fakeModelContext();
    const tools = vi.fn(() => [tool('a')]);
    const reg = createWebMcpRegistration({
      enabled: () => false,
      host: { document: { modelContext: f.mc } },
      tools,
    });
    reg.sync(true);
    expect(f.registered).toEqual([]);
    expect(tools).not.toHaveBeenCalled();
  });

  it('🔴 入口が無いブラウザでは何もしない(例外も出さない)', () => {
    const tools = vi.fn(() => [tool('a')]);
    for (const host of [{}, { document: {}, navigator: {} }, { document: { modelContext: {} } }]) {
      const reg = createWebMcpRegistration({ enabled: () => true, host, tools });
      expect(() => reg.sync(true)).not.toThrow();
      expect(reg.active()).toBe(false);
    }
    expect(tools).not.toHaveBeenCalled();
  });

  it('入口は document を先に見て、無ければ navigator(旧名)へ登録する', () => {
    const nav = fakeModelContext();
    const regNav = createWebMcpRegistration({
      enabled: () => true,
      host: { document: {}, navigator: { modelContext: nav.mc } },
      tools: () => [tool('a')],
    });
    regNav.sync(true);
    expect(nav.registered).toHaveLength(1);

    const doc = fakeModelContext();
    const old = fakeModelContext();
    createWebMcpRegistration({
      enabled: () => true,
      host: { document: { modelContext: doc.mc }, navigator: { modelContext: old.mc } },
      tools: () => [tool('a')],
    }).sync(true);
    expect(doc.registered).toHaveLength(1);
    expect(old.registered, '旧名へ登録してはいけない(新しい名前が在るとき)').toHaveLength(0);
  });

  it('🔴 abort で全部消える: stop() / follower への降格', () => {
    const f = fakeModelContext();
    const reg = createWebMcpRegistration({
      enabled: () => true,
      host: { document: { modelContext: f.mc } },
      tools: () => ['a', 'b'].map(tool),
    });
    reg.sync(true);
    expect(f.alive()).toEqual(['a', 'b']);
    reg.sync(false); // 降格
    expect(f.alive()).toEqual([]);
    expect(reg.active()).toBe(false);

    // 対照群: stop() でも消える
    reg.sync(true);
    expect(f.alive()).toEqual(['a', 'b']);
    reg.stop();
    expect(f.alive()).toEqual([]);
  });

  it('二重に登録しない / 降格後の昇格ではもう一度登録する', () => {
    const f = fakeModelContext();
    const reg = createWebMcpRegistration({
      enabled: () => true,
      host: { document: { modelContext: f.mc } },
      tools: () => [tool('a')],
    });
    reg.sync(true);
    reg.sync(true);
    reg.sync(true);
    expect(f.registered).toHaveLength(1);
    reg.sync(false);
    reg.sync(true);
    expect(f.registered).toHaveLength(2);
    expect(f.alive()).toEqual(['a']);
  });

  it('flag は呼ぶたびに読む(オフだった起動の後にオンにして sync すれば登録できる)', () => {
    const f = fakeModelContext();
    let on = false;
    const reg = createWebMcpRegistration({
      enabled: () => on,
      host: { document: { modelContext: f.mc } },
      tools: () => [tool('a')],
    });
    reg.sync(true);
    expect(f.registered).toHaveLength(0);
    on = true;
    reg.sync(true);
    expect(f.registered).toHaveLength(1);
  });

  it('🔴 登録が落ちても(同期で投げる / 非同期で reject)起動を止めない・未処理の reject を出さない', async () => {
    const sync = createWebMcpRegistration({
      enabled: () => true,
      host: {
        document: {
          modelContext: {
            registerTool: () => {
              throw new Error('duplicate');
            },
          },
        },
      },
      tools: () => [tool('a'), tool('b')],
    });
    expect(() => sync.sync(true)).not.toThrow();

    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown): void => void unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    const asyncFail = createWebMcpRegistration({
      enabled: () => true,
      host: { document: { modelContext: { registerTool: () => Promise.reject(new Error('nope')) } } },
      tools: () => [tool('a')],
    });
    expect(() => asyncFail.sync(true)).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    process.off('unhandledRejection', onUnhandled);
    expect(unhandled).toEqual([]);
  });
});

/**
 * 🔴 `main.ts` はどの test からも実行されない ── 判断は上の関数に在り、ここは**配線の原文**だけを見る
 * (弱い pin と自覚して使う)。見るのは「作る道が 1 本」と「holder の扱い」。
 */
describe('main.ts の配線(原文 pin)', () => {
  const main = codeOnly(readFileSync('src/main.ts', 'utf8'));

  it('🔴 作る道は 1 本: bridge と AI の道具が同じ createEntryFromOutside を受け取る', () => {
    const uses = main.match(/createEntry:\s*createEntryFromOutside\b/g) ?? [];
    // startEmbedBridge と buildAgentTools の 2 か所(2 つ目の作成経路を作ったら 1 か所に減る)
    expect(uses).toHaveLength(2);
    // 定義は 1 つだけ(CREATE_ENTRY を dispatch する外向きの口が増えていない)
    expect(main.match(/const createEntryFromOutside\b/g)).toHaveLength(1);
    expect(main.match(/type:\s*'CREATE_ENTRY',\s*\n\s*archetype:\s*'text',\s*\n\s*lid,/g) ?? []).toHaveLength(1);
  });

  it('メインのタブだけ登録する: 起動時は followerConn === null、昇格したら sync(true)', () => {
    expect(main).toMatch(/agentRegistration\.sync\(followerConn === null\)/);
    expect(main).toMatch(/writerHolder = true;[\s\S]{0,300}agentRegistration\.sync\(true\)/);
    // タブを閉じるとき消す
    expect(main).toMatch(/'pagehide',\s*\(\)\s*=>\s*agentRegistration\.stop\(\)/);
  });

  it('flag は FLAG_WEBMCP を読む', () => {
    expect(main).toMatch(/enabled:\s*\(\)\s*=>\s*appFlags\.isOn\(FLAG_WEBMCP\.name\)/);
  });
});
