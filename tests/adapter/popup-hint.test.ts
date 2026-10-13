/** @vitest-environment happy-dom */
/**
 * 🔴 **外部リンクを初めて押したとき、1 度だけ「開かないときは」を言う**(依頼 69-B2)。
 *
 * 守るもの:①初回に言う ②2 回目は言わない(憶える)③リンクは止めない
 * ④アプリ内リンク・文書内の飛び先では言わない ⑤憶えた事実が localStorage の鍵に載る
 */
import { describe, expect, it } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { PopupHintStore, POPUP_HINT_TEXT } from '../../src/adapter/ui/render/popup-hint';

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
  };
}

function setup(store: PopupHintStore) {
  const root = document.createElement('div');
  document.body.append(root);
  root.innerHTML = `
    <div class="pkc-md-rendered">
      <a id="ext" href="https://example.com/" target="_blank" rel="noopener noreferrer">外</a>
      <a id="anchor" href="#sec">内</a>
      <a id="entry" href="entry:abc" data-pkc-action="x">ノート</a>
    </div>`;
  const said: string[] = [];
  const off = bindActions(
    root,
    new Dispatcher(),
    { showStatus: (t: string) => void said.push(t) },
    undefined,
    undefined,
    store,
  );
  // 実際の遷移(happy-dom は fetch を試みる)を止める。⚠ binder の後に登録し、
  // binder が止めたかどうかを先に記録してから止める
  root.addEventListener('click', (ev) => {
    stoppedByBinder = ev.defaultPrevented;
    ev.preventDefault();
  });
  return { root, said, off };
}

let stoppedByBinder = false;

/** 押す。返り値は「既定動作が止められたか」。 */
function press(root: HTMLElement, id: string): boolean {
  const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
  root.querySelector(`#${id}`)!.dispatchEvent(ev);
  return stoppedByBinder;
}

describe('外部リンクの初回の案内 (依頼 69-B2)', () => {
  it('🔴 初めて押すと 1 度だけ言い、リンクは止めない', () => {
    const s = memoryStorage();
    const { root, said, off } = setup(new PopupHintStore(s));
    const prevented = press(root, 'ext');
    expect(said).toEqual([POPUP_HINT_TEXT]);
    expect(prevented, 'リンクを止めている(新しいタブが開かなくなる)').toBe(false);
    // 2 回目は言わない
    press(root, 'ext');
    expect(said).toHaveLength(1);
    // 憶えた事実は端末の保存に載る(読み込み直しても言わない)
    expect(s.map.get('pkc3.popup-hint-shown')).toBe('1');
    off();
  });

  it('🔴 前に言った端末(保存に印がある)では、最初から言わない', () => {
    const s = memoryStorage();
    s.map.set('pkc3.popup-hint-shown', '1');
    const { root, said, off } = setup(new PopupHintStore(s));
    press(root, 'ext');
    expect(said).toEqual([]);
    off();
  });

  it('対照群: 文書内の飛び先とノートへのリンクでは言わない(言ったことにもしない)', () => {
    const s = memoryStorage();
    const { root, said, off } = setup(new PopupHintStore(s));
    press(root, 'anchor');
    press(root, 'entry');
    expect(said).toEqual([]);
    expect(s.map.has('pkc3.popup-hint-shown')).toBe(false);
    // それでも外部リンクを押せば言う(上の 2 つで使い切っていない)
    press(root, 'ext');
    expect(said).toEqual([POPUP_HINT_TEXT]);
    off();
  });

  it('保存が使えない端末でも、その session の間は 1 度だけ', () => {
    const { root, said, off } = setup(new PopupHintStore(null));
    press(root, 'ext');
    press(root, 'ext');
    expect(said).toEqual([POPUP_HINT_TEXT]);
    off();
  });
});
