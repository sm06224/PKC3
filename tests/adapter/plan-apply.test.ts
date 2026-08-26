/** @vitest-environment happy-dom */
/**
 * 🔴 **整理案を貼って、下見してから当てる**(#429 段③④)。
 *
 * 純関数の規則は `tests/features/structure-plan.test.ts` が見る。ここで見るのは
 * **画面と state の間** ── 貼ると下見が出るか / 誤りで押せなくなるか /
 * 押したら**本当に構成が変わる**か。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { buildSettingsCommands } from '../../src/adapter/ui/render/commands';
import { bindActions } from '../../src/adapter/ui/actions/binder';

function meta(lid: string, title: string, archetype = 'text'): EntryMeta {
  return {
    lid,
    title,
    archetype,
    createdAt: null,
    updatedAt: null,
    entryOrder: 1,
    status: null,
    date: null,
    archived: false,
  } as EntryMeta;
}

const SET = [meta('a', '議事録'), meta('b', '見積'), meta('box', '資料', 'folder')];

function mount() {
  document.body.innerHTML = '';
  const root = document.createElement('div');
  document.body.append(root);
  buildShell(root);
  // ⚠ 設定の面は別に組む(`settings.ts` が本番でそうしている)
  root.append(buildSettingsCommands());
  const d = new Dispatcher();
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: SET, relations: [] });
  bindActions(root, d, { showStatus: () => {} });
  const ta = root.querySelector<HTMLTextAreaElement>('[data-pkc-field="plan-input"]')!;
  const type = (v: string) => {
    ta.value = v;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  };
  return {
    root,
    d,
    ta,
    type,
    apply: root.querySelector<HTMLButtonElement>('[data-pkc-field="plan-apply"]')!,
    previews: () =>
      [...root.querySelectorAll('[data-pkc-field="plan-preview"] li')].map((l) => l.textContent),
    errors: () =>
      [...root.querySelectorAll('[data-pkc-field="plan-errors"] li')].map((l) => l.textContent),
  };
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('貼ったとき', () => {
  it('🔴 何が起きるかが**題名で**並ぶ', () => {
    const m = mount();
    m.type('mv a box');
    expect(m.previews()).toHaveLength(1);
    expect(m.previews()[0]).toContain('議事録');
    expect(m.previews()[0]).toContain('資料');
  });

  it('🔴 誤りは**行番号つき**で出る', () => {
    const m = mount();
    m.type('mv a box\nmv zzz box');
    expect(m.errors()).toHaveLength(1);
    expect(m.errors()[0], '行番号が出ていない ── どこを直すか分からない').toContain('2 行目');
  });

  it('🔴 誤りが 1 行でもあれば「当てる」は押せない', () => {
    const m = mount();
    m.type('mv a box');
    expect(m.apply.disabled, '正しい案なのに押せない').toBe(false);
    m.type('mv a box\nmv zzz box');
    expect(m.apply.disabled, '誤りが在るのに押せる ── 半分だけ当たる').toBe(true);
  });

  it('🔴 貼る前は押せない(押しても何も起きないボタンを出さない)', () => {
    expect(mount().apply.disabled).toBe(true);
  });

  it('⚠ 空の枠を出さない(誤りも下見も無いときは畳む)', () => {
    const m = mount();
    const errs = m.root.querySelector<HTMLElement>('[data-pkc-field="plan-errors"]')!;
    const prev = m.root.querySelector<HTMLElement>('[data-pkc-field="plan-preview"]')!;
    expect(errs.hidden).toBe(true);
    expect(prev.hidden).toBe(true);
    m.type('mv a box');
    expect(prev.hidden).toBe(false);
    expect(errs.hidden, '誤りが無いのに枠が出ている').toBe(true);
  });

  it('直したら下見が更新される(貼り直すたびに読み直す)', () => {
    const m = mount();
    m.type('mv zzz box');
    expect(m.errors()).toHaveLength(1);
    m.type('mv a box');
    expect(m.errors(), '直したのに誤りが残っている').toHaveLength(0);
    expect(m.previews()).toHaveLength(1);
  });
});

describe('当てたとき', () => {
  it('🔴 **本当に移る**(下見だけで終わらない)', () => {
    const m = mount();
    m.type('mv a box');
    m.apply.click();
    const rel = m.d.getState().relations.filter((r) => r.toLid === 'a');
    expect(rel, '移っていない').toHaveLength(1);
    expect(rel[0]!.fromLid).toBe('box');
  });

  it('🔴 **フォルダを作って、そこへまとめて移す**が 1 回で通る', () => {
    const m = mount();
    m.type('mkdir "2026 年" as @g\nmv a @g\nmv b @g');
    m.apply.click();
    const st = m.d.getState();
    const made = [...st.entryMetas.values()].find((x) => x.title === '2026 年');
    expect(made, 'フォルダが作られていない').toBeDefined();
    expect(made!.archetype).toBe('folder');
    for (const lid of ['a', 'b']) {
      const rel = st.relations.filter((r) => r.toLid === lid);
      expect(rel, `${lid} が移っていない`).toHaveLength(1);
      expect(rel[0]!.fromLid, `${lid} が新しいフォルダの中に無い`).toBe(made!.lid);
    }
  });

  it('🔴 rename が効く', () => {
    const m = mount();
    m.type('rename a "総会(確定版)"');
    m.apply.click();
    expect(m.d.getState().entryMetas.get('a')?.title).toBe('総会(確定版)');
  });

  it('root へ戻せる', () => {
    const m = mount();
    m.type('mv a box');
    m.apply.click();
    expect(m.d.getState().relations.filter((r) => r.toLid === 'a')).toHaveLength(1);
    m.type('mv a root');
    m.apply.click();
    expect(
      m.d.getState().relations.filter((r) => r.toLid === 'a'),
      'root へ戻っていない',
    ).toHaveLength(0);
  });

  it('🔴 当てたら欄を空にする(もう一度押せるように見せない)', () => {
    const m = mount();
    m.type('mv a box');
    m.apply.click();
    expect(m.ta.value, '案が残っている ── 二重に当ててしまう').toBe('');
    expect(m.apply.disabled, '空なのに押せる').toBe(true);
    expect(m.previews(), '下見が残っている').toHaveLength(0);
  });

  /**
   * 🔴 **下見と、実際に動いたものが一致する**(#429 の芯)。
   * ⚠ ここが違うと「見た通りに動かない」── いちばん user の信用を失う形である。
   */
  it('🔴 下見に出た件数だけ、実際に変わる', () => {
    const m = mount();
    m.type('mkdir "箱" as @n\nmv a @n\nrename b "見積(改)"');
    expect(m.previews()).toHaveLength(3);
    const before = m.d.getState().entryMetas.size;
    m.apply.click();
    const st = m.d.getState();
    expect(st.entryMetas.size, 'フォルダが 1 つ増えていない').toBe(before + 1);
    expect(st.entryMetas.get('b')?.title).toBe('見積(改)');
    expect(st.relations.filter((r) => r.toLid === 'a')).toHaveLength(1);
  });

  /**
   * 🔴 **編集中は、断る理由を出して当てない**(#429 段③)。
   *
   * ⚠ **「動かないこと」だけを見ても足りない** ── reducer 側も編集中の
   *   `SET_ENTRY_PARENT` を無視するので、手前の門を外しても**構成は動かない**
   *   (変異試験 R14 が SURVIVED で教えた)。
   * 🔑 手前の門が守っているのは「**無言で拒否しない**」ことである ──
   *   だから**断り文が出ること**を見る。出ないと user は
   *   「押したのに何も起きない」としか分からない。
   */
  it('🔴 編集中は、理由を出して断る(無言の操作拒否を作らない)', () => {
    const m = mount();
    m.type('mv a box');
    // ⚠ 編集に入れるのは「選んだノートの本文が届いている」ときだけ(`START_EDIT` の門)
    m.d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    m.d.dispatch({ type: 'BODY_LOADED', lid: 'a', body: '# 議事録\n' });
    m.d.dispatch({ type: 'START_EDIT' });
    expect(m.d.getState().phase, '前提が崩れている ── 編集に入っていない').toBe('editing');
    const before = m.d.getState().relations.length;
    m.apply.click();
    expect(m.d.getState().relations.length, '編集中に当ててしまった').toBe(before);
    expect(
      m.d.getState().error,
      '無言で拒否している ── user は「押したのに何も起きない」としか分からない',
    ).toContain('編集を終了してから');
  });
});
