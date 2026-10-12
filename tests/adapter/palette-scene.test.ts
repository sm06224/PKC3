/** @vitest-environment happy-dom */
/**
 * 🔴 **「操作を探す」の各行の右端に、場面の名前を薄く出す / 押せない行は隠さず理由つきで灰色にする**
 * (#582 段③。🟣 Gemini の回答 = #1163 の依頼 16 の補足 答え 2・3)。
 *
 * 守るもの:
 *  ① **全命令が場面を持つ** ── 表(`scene-labels.ts`)と `KEY_COMMANDS` の id が過不足なく一致する(足した人が表に足し忘れると落ちる)
 *  ② 場面の名前は**用語集の語だけ**(`ui-terms.ts`)。使っていない場面名が表に残らない
 *  ③ 一覧の行(`paletteRows`)・「操作を探す」の画面・左の `>` の一覧の**3 つとも**、全行が場面を右端に出す
 *  ④ **押せない行は 1 つも隠さない**(全命令が一覧に居る)。灰色の行は**必ず理由**を持ち、理由は「いまは押せません。」で始まり、
 *     最後の逃げ字(`GENERIC_NOT_READY`)には落ちない(説明を持たない命令が居ない)
 *  ⑤ 色:場面の名前は**行の名前とは別の控えめな色**(CSS に受け皿が有る ── 属性の検査ではなく規則の検査。実ブラウザの色は smoke)
 */
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { bindActions, commandRowsFor } from '../../src/adapter/ui/actions/binder';
import { KeymapStore } from '../../src/adapter/ui/render/keymap';
import { resetAppDialogForTest } from '../../src/adapter/ui/render/app-dialog';
import { paintCommandList } from '../../src/adapter/ui/render/command-list';
import { KEY_COMMANDS, resolveBindings } from '../../src/features/keymap';
import {
  GENERIC_NOT_READY,
  NOT_READY_PREFIX,
  paletteRows,
} from '../../src/features/palette/palette-rows';
import { COMMAND_SCENE, SCENES, sceneOf } from '../../src/features/palette/scene-labels';
import { STANDARD_TERMS, TYPE_TERMS } from '../../src/features/ui-terms';

function setup() {
  document.body.innerHTML = '';
  resetAppDialogForTest();
  const root = document.createElement('div');
  document.body.append(root);
  buildShell(root);
  const d = new Dispatcher();
  const store = new KeymapStore();
  bindActions(root, d, {}, store);
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [], relations: [] });
  return { root, d, store };
}

beforeEach(() => {
  document.body.innerHTML = '';
  resetAppDialogForTest();
});

describe('① 全命令が場面を持つ', () => {
  it('表の id と KEY_COMMANDS の id が過不足なく一致する(足し忘れも、消えた命令の残りも落ちる)', () => {
    const ids = KEY_COMMANDS.map((c) => c.id).sort();
    expect(KEY_COMMANDS.length, '空振り防止:命令が十分な数ある').toBeGreaterThan(100);
    expect(Object.keys(COMMAND_SCENE).sort()).toEqual(ids);
    for (const id of ids) expect(sceneOf(id), `${id} に場面が無い`).not.toBeNull();
  });

  it('表に無い id は null(空の字を黙って出さない)', () => {
    expect(sceneOf('no-such-command')).toBeNull();
  });
});

describe('② 場面の名前は用語集の語だけ', () => {
  const GLOSSARY = new Set([...STANDARD_TERMS, ...TYPE_TERMS].map((t) => t.term));

  it('SCENES の全語が用語集に在る', () => {
    for (const s of SCENES) expect(GLOSSARY.has(s), `${s} が用語集(ui-terms.ts)に無い`).toBe(true);
  });

  it('SCENES の全語を、少なくとも 1 つの命令が使っている(使っていない場面名が残らない)・表の語は全部 SCENES にある', () => {
    const used = new Set(Object.values(COMMAND_SCENE));
    for (const s of SCENES) expect(used.has(s), `${s} を使う命令が 1 つも無い`).toBe(true);
    for (const s of used) expect((SCENES as readonly string[]).includes(s), `${s} が SCENES に無い`).toBe(true);
  });
});

describe('③ 3 つの面すべてで、全行が場面を出す', () => {
  it('paletteRows の全行が、表どおりの場面を持つ', () => {
    const bindings = resolveBindings({});
    const rows = paletteRows('', bindings, new Set());
    expect(rows.length).toBe(KEY_COMMANDS.length);
    for (const r of rows) expect(r.scene, `${r.id} の行に場面が無い`).toBe(sceneOf(r.id));
  });

  it('「操作を探す」の画面:全行が右端の場面(palette-scene)を持つ', async () => {
    const { root } = setup();
    root.querySelector<HTMLElement>('[data-pkc-action="open-palette"]')!.click();
    await new Promise((r) => setTimeout(r, 10));
    const rows = [...document.querySelectorAll<HTMLElement>('[data-pkc-field="palette-row"]')];
    expect(rows.length, '空振り防止:行が出ている').toBeGreaterThan(100);
    for (const row of rows) {
      const id = row.getAttribute('data-pkc-command')!;
      const scene = row.querySelector('[data-pkc-field="palette-scene"]');
      expect(scene?.textContent, `${id}: 場面が出ていない`).toBe(sceneOf(id));
    }
  });

  it('左の `>` の一覧:全行が場面(command-scene)を持つ', () => {
    const { root, d, store } = setup();
    const host = document.createElement('div');
    document.body.append(host);
    const rows = commandRowsFor(root, d, store, '', null);
    paintCommandList(host, rows);
    const els = [...host.querySelectorAll<HTMLElement>('[data-pkc-field="command-row"]')];
    expect(els.length).toBe(rows.length);
    for (const el of els) {
      const id = el.getAttribute('data-pkc-command')!;
      expect(el.querySelector('[data-pkc-field="command-scene"]')?.textContent, `${id}: 場面が出ていない`).toBe(sceneOf(id));
    }
  });

  it('場面だけが変わっても左の一覧は描き直す(指紋に場面が入っている)', () => {
    const host = document.createElement('div');
    const row = { id: 'a', label: 'A', keys: [], ready: true, why: '', scene: 'ノート' };
    expect(paintCommandList(host, [row])).toBe(true);
    expect(paintCommandList(host, [row])).toBe(false);
    expect(paintCommandList(host, [{ ...row, scene: '予定' }]), '場面が変わったのに描き直さない').toBe(true);
    expect(host.querySelector('[data-pkc-field="command-scene"]')?.textContent).toBe('予定');
  });
});

describe('④ 押せない行は隠さず、理由つきで灰色にする', () => {
  it('何も開いていない画面でも、全命令が一覧に居て、押せない行は全部「理由つき」で灰色', async () => {
    const { root, d, store } = setup();
    const rows = commandRowsFor(root, d, store, '', null, true);
    // 隠していない:パレット自身を除く全命令が居る
    expect(rows.map((r) => r.id).sort()).toEqual(
      KEY_COMMANDS.map((c) => c.id).filter((id) => id !== 'open-palette').sort(),
    );
    const grey = rows.filter((r) => !r.ready);
    const ready = rows.filter((r) => r.ready);
    expect(grey.length, '空振り防止:灰色の行がある').toBeGreaterThan(50);
    expect(ready.length, '空振り防止:押せる行もある(全部灰色の画面で緑にならない)').toBeGreaterThan(5);
    for (const r of grey) {
      expect(r.why.startsWith(NOT_READY_PREFIX), `${r.id}: 理由が「いまは押せません。」で始まっていない`).toBe(true);
      const reason = r.why.slice(NOT_READY_PREFIX.length);
      expect(reason.length, `${r.id}: 理由が空`).toBeGreaterThan(4);
      expect(reason, `${r.id}: 最後の逃げ字に落ちている(説明を持たない)`).not.toBe(GENERIC_NOT_READY);
    }
    // 押せる行に「いまは押せません」は付かない(見分けの印が逆転していない)
    for (const r of ready) expect(r.why.startsWith(NOT_READY_PREFIX), `${r.id}: 押せるのに押せない顔`).toBe(false);

    // 画面でも:灰色の行は disabled で、理由が見える
    root.querySelector<HTMLElement>('[data-pkc-action="open-palette"]')!.click();
    await new Promise((r) => setTimeout(r, 10));
    const shown = [...document.querySelectorAll<HTMLButtonElement>('[data-pkc-field="palette-row"]')];
    for (const el of shown) {
      const id = el.getAttribute('data-pkc-command')!;
      const row = rows.find((r) => r.id === id)!;
      expect(el.disabled, `${id}: 灰色の印が画面とずれている`).toBe(!row.ready);
      if (!row.ready)
        expect(el.querySelector('[data-pkc-field="palette-why"]')?.textContent, `${id}: 画面に理由が出ていない`).toBe(row.why);
    }
  });

  it('逃げ字(GENERIC_NOT_READY)は「説明の無い全域の命令」にだけ出る ── 無説明の命令を足すと落ちる', () => {
    for (const c of KEY_COMMANDS) {
      if (!c.contexts.includes('global')) continue;
      expect((c.note ?? '').length, `${c.id}: 全域の命令に説明(押せない理由を兼ねる)が無い`).toBeGreaterThan(0);
    }
  });
});

describe('⑤ 場面の名前に色の受け皿がある(CSS の規則)', () => {
  const css = readFileSync('src/styles/app.css', 'utf-8');
  /** コメントを落とす(注釈が検査を満たさない)。 */
  const code = css.replace(/\/\*[\s\S]*?\*\//g, '');

  it('palette-scene / command-scene に、控えめな色と右寄せの規則が在る', () => {
    for (const f of ['palette-scene', 'command-scene']) {
      const m = new RegExp(`\\[data-pkc-field='${f}'\\][^{]*\\{([^}]*)\\}`).exec(code);
      expect(m, `${f} の規則が無い(属性だけ付けて見た目の規則が無い形)`).not.toBeNull();
      expect(m![1], `${f}: 色が控えめでない`).toMatch(/color:\s*var\(--muted\)/);
    }
    expect(code).toMatch(/\[data-pkc-field='palette-label'\]\s*\+\s*\[data-pkc-field='palette-scene'\][^{]*\{[^}]*margin-inline-start:\s*auto/);
    expect(code).toMatch(/\[data-pkc-field='command-label'\]\s*\+\s*\[data-pkc-field='command-scene'\][^{]*\{[^}]*margin-inline-start:\s*auto/);
  });
});
