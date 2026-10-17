/** @vitest-environment happy-dom */
/**
 * 🔴 「完了項目を末尾へ」は、カーソルのあるリストだけを動かす(台帳 #1852 I2 / 依頼 87-2。Gemini 回答 = 推薦 A)。
 * 引用の中のリストも並べ替える(依頼 159)。リストの外にカーソルがあるときは、これまでどおりすべてのリスト。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { bindActions } from '../../src/adapter/ui/actions/binder';

function setup() {
  document.body.innerHTML = '';
  const root = document.createElement('div');
  document.body.append(root);
  buildShell(root);
  const d = new Dispatcher();
  const said: string[] = [];
  bindActions(root, d, { showStatus: (t) => void said.push(t) });
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [], relations: [] });
  const ta = document.createElement('textarea');
  ta.setAttribute('data-pkc-field', 'editor-body');
  root.querySelector('[data-pkc-region="detail"]')!.append(ta);
  const sort = (): void => {
    const b = document.createElement('button');
    b.setAttribute('data-pkc-action', 'sort-tasks');
    root.append(b);
    b.click();
  };
  return { ta, said, sort };
}

beforeEach(() => {
  document.body.innerHTML = '';
});

const BODY = ['# 一', '- [x] a1', '- [ ] a2', '', '# 二', '- [x] b1', '- [ ] b2'].join('\n');

describe('完了項目を末尾へ(押したボタン)', () => {
  it('🔴 カーソルが 2 つ目のリストに在れば、2 つ目だけが動き、そう言う', () => {
    const { ta, said, sort } = setup();
    ta.value = BODY;
    ta.setSelectionRange(BODY.indexOf('b2'), BODY.indexOf('b2'));
    sort();
    expect(ta.value).toBe(['# 一', '- [x] a1', '- [ ] a2', '', '# 二', '- [ ] b2', '- [x] b1'].join('\n'));
    expect(said).toEqual(['このリストの完了したチェック項目を末尾へ移動しました']);
  });

  it('対照群:カーソルが見出し(リストの外)なら、すべてのリストが動く', () => {
    const { ta, said, sort } = setup();
    ta.value = BODY;
    ta.setSelectionRange(0, 0);
    sort();
    expect(ta.value).toBe(['# 一', '- [ ] a2', '- [x] a1', '', '# 二', '- [ ] b2', '- [x] b1'].join('\n'));
    expect(said).toEqual(['完了したチェック項目を末尾へ移動しました']);
  });

  it('カーソルのあるリストが既に揃っていれば、動かさずにそう言う(他のリストは崩れたまま)', () => {
    const { ta, said, sort } = setup();
    const b = ['# 一', '- [ ] a1', '- [x] a2', '', '# 二', '- [x] b1', '- [ ] b2'].join('\n');
    ta.value = b;
    ta.setSelectionRange(b.indexOf('a1'), b.indexOf('a1'));
    sort();
    expect(ta.value).toBe(b);
    expect(said).toEqual(['このリストの完了項目は既に末尾に揃っています']);
  });

  it('🔴 引用の中のチェック項目も並べ替える(以前は「並べ替えません」と断っていた)', () => {
    const { ta, said, sort } = setup();
    ta.value = '> - [x] 済\n> - [ ] 未';
    ta.setSelectionRange(2, 2);
    sort();
    expect(ta.value).toBe('> - [ ] 未\n> - [x] 済');
    expect(said).toEqual(['このリストの完了したチェック項目を末尾へ移動しました']);
  });

  it('チェック項目が無いノートでは、無いと言う(引用の中にも無い)', () => {
    const { ta, said, sort } = setup();
    ta.value = '> 引用\n- 箇条書き';
    sort();
    expect(said).toEqual(['このノートにチェック項目はありません']);
  });
});
