/** @vitest-environment happy-dom */
/**
 * 🔴 **畳んだら、聞き耳が 1 つも残らない**(#876)。
 *
 * ⚠ 直す前は `addEventListener` と `removeEventListener` を**手で 2 か所に並べて**
 *   いたので、**7 件が外されないまま残っていた**(`paste` と掴んで落とす 6 本)。
 *   ⚠ `removeEventListener` は**参照が一致しないと黙って何もしない**ので、
 *   例外も警告も出ない ── 数えて初めて分かる。
 *
 * 🔑 `tests/repo-hygiene.test.ts` の門は**字**を見る(迂回していないか)。
 *   ⚠ 字だけでは「本当に外れたか」は言えないので、**ここは実際に撃って見る**
 *   (CLAUDE.md §2「分岐を書いたら、実際に走らせた記録を持つ」)。
 */
import { describe, expect, it, vi } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { buildShell } from '../../src/adapter/ui/render/shell';

/** 畳む前 / 後で、同じ event を撃って**張り付いた数**を数える。 */
function setup() {
  const root = document.createElement('div');
  document.body.append(root);
  buildShell(root);
  const d = new Dispatcher();
  const seen: string[] = [];
  const raw = d.dispatch.bind(d);
  d.dispatch = ((a: Parameters<typeof raw>[0]) => {
    seen.push((a as { type: string }).type);
    return raw(a);
  }) as typeof d.dispatch;

  /** `root` に張られている聞き耳を数える(happy-dom は数を持たないので、包んで数える)。 */
  const live = new Set<string>();
  const addRaw = root.addEventListener.bind(root);
  const removeRaw = root.removeEventListener.bind(root);
  root.addEventListener = ((t: string, h: EventListener, c?: boolean) => {
    live.add(`${t}:${String(c === true)}:${h.name}`);
    addRaw(t, h, c);
  }) as typeof root.addEventListener;
  root.removeEventListener = ((t: string, h: EventListener, c?: boolean) => {
    live.delete(`${t}:${String(c === true)}:${h.name}`);
    removeRaw(t, h, c);
  }) as typeof root.removeEventListener;

  const detach = bindActions(root, d, {});
  return { root, d, seen, live, detach };
}

describe('畳んだら聞き耳が残らない(#876)', () => {
  it('🔴 `root` へ張った物は、畳むと 1 つも残らない', () => {
    const h = setup();
    // 前提 ── 本当に張っている(ここが崩れると以降は何も見ていない)
    expect(h.live.size, '前提が崩れている(1 つも張っていない)').toBeGreaterThan(5);
    const was = h.live.size;
    h.detach();
    expect(
      [...h.live].sort(),
      `畳んだのに残っている(張ったのは ${String(was)} 件):\n${[...h.live].join('\n')}`,
    ).toEqual([]);
  });

  /**
   * 🔴 **対照群 ── 畳む前は本当に効いている。**
   * ⚠ これが無いと、上の test は「最初から張っていなかった」でも通る。
   */
  it('🔴 畳む前は効き、畳んだ後は効かない(掴んで落とす)', () => {
    const h = setup();
    const fire = (): void => {
      const ev = new Event('dragover', { bubbles: true, cancelable: true });
      h.root.dispatchEvent(ev);
    };
    const before = vi.fn();
    h.root.addEventListener('dragover', before);
    fire();
    // ⚠ 受け口が本当に走ったかは、`preventDefault` の有無では読めない happy-dom が
    //    在るので、**張った数**で見る(上の test と同じ観測点)
    expect(h.live.has('dragover:false:onDragOver'), '前提が崩れている').toBe(true);
    h.detach();
    expect(h.live.has('dragover:false:onDragOver'), '畳んでも掴んで落とすが生きている').toBe(false);
    fire();
  });
});
