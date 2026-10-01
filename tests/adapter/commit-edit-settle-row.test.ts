/** @vitest-environment happy-dom */
/**
 * 🔴 **「編集を保存する」は、開いている行の欄の打ちかけを先に state へ届ける**(#1219)。
 *
 * 実マウスは `mousedown` で焦点が動いて行の欄が `blur` し、行の確定が先に走る。
 * `mousedown` の無い押し方(`el.click()` / 支援技術の押下)は焦点が動かないので、
 * 打ちかけが state に無いまま `COMMIT_EDIT` が走り、保存に入らなかった。
 *
 * ⚠ ここで見るのは**配線**だけ(行の確定の規則は `row-swap.test.ts`、実ブラウザでの
 *   「保存に入る」は `live-editor.smoke.spec.ts`)。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { KeymapStore } from '../../src/adapter/ui/render/keymap';
import { resetAppDialogForTest } from '../../src/adapter/ui/render/app-dialog';

function fakeStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

function setup() {
  document.body.innerHTML = '';
  resetAppDialogForTest();
  const root = document.createElement('div');
  document.body.append(root);
  buildShell(root);
  const d = new Dispatcher();
  bindActions(root, d, { showStatus: () => undefined }, new KeymapStore(fakeStorage()));
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [], relations: [] });
  return { root, d };
}

/** 焦点のある欄 + 保存ボタンを置き、`blur` が起きた時点の state の `error` を記録する。 */
function arrange(field: string) {
  const { root, d } = setup();
  const ta = document.createElement('textarea');
  ta.setAttribute('data-pkc-field', field);
  const btn = document.createElement('button');
  btn.setAttribute('data-pkc-action', 'commit-edit');
  root.append(ta, btn);
  ta.focus();
  const blurs: (string | null)[] = [];
  ta.addEventListener('blur', () => blurs.push(d.getState().error));
  return { d, btn, ta, blurs };
}

beforeEach(() => {
  document.body.innerHTML = '';
  resetAppDialogForTest();
});

describe('commit-edit ── 行の欄の打ちかけを先に届ける(#1219)', () => {
  it('🔴 行の欄に焦点があれば、保存の処理(COMMIT_EDIT)より前に blur する', () => {
    const { d, btn, blurs } = arrange('row-source');
    btn.click();
    expect(blurs, '行の欄が blur しなかった(打ちかけが保存に入らない)').toHaveLength(1);
    // 編集中でない台なので COMMIT_EDIT は error を立てる ── blur の時点ではまだ立っていない = 先に走った
    expect(blurs[0], 'blur が COMMIT_EDIT より後になった').toBeNull();
    expect(d.getState().error, '前提: 保存の処理が走っていない').not.toBeNull();
  });

  it('対照群: 2 列の全文欄(input で state に届いている)は blur させない', () => {
    const { btn, blurs } = arrange('editor-body');
    btn.click();
    expect(blurs).toEqual([]);
  });
});
