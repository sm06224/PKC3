/** @vitest-environment happy-dom */
/**
 * 🔴 **動線が「どこにも無い」状態を作らせない**(#239)。
 *
 * user 指示 2026-08-17「左下にあっても使う頻度が低いボタンは設定画面に逃すこと」で、
 * ノート全体の操作は **左の列**と**設定**の 2 か所に分かれた。
 *
 * ⚠ この形の怖いところは、**片方から消して、もう片方へ足し忘れたときに黙ること**である:
 * - `repo-hygiene` の「受け手のいない `data-pkc-action`」は**逆向き**なので鳴らない
 *   (押す口が消えて受け手だけが残る形)
 * - 画面は普通に描かれる ── 無いものは見えないだけで、エラーも警告も出ない
 * - マニュアル突合(`docs-parity`)は**在るものの文言**を見るので、消えた物は素通りする
 *
 * 🔑 だから **合計**を pin する。片方から外したら、もう片方に足すまで落ちる。
 */
import { describe, expect, it } from 'vitest';
import {
  COLLECTION_COMMANDS,
  SETTINGS_COMMANDS,
  buildSettingsCommands,
} from '../../src/adapter/ui/render/commands';

/** 2026-08-17 の分割時点の全数。⚠ **減らすときは user の裁定が要る**(動線が減る)。 */
const ALL_ACTIONS = [
  'export-archive',
  'export-html',
  'export-markdown',
  // 🔴 可搬単一 HTML(#400 段④)── 「閲覧用 HTML」とは別の口である
  'export-portable',
  // 🔴 構成をテキストでコピー(#429 段①)── AI に整理を頼むための材料
  'export-structure',
  'import-file',
  'purge-orphan-assets',
] as const;

describe('ノート全体の操作の置き場(#239)', () => {
  it('🔴 合計が変わっていない ── どこからも消えていない', () => {
    const all = [...COLLECTION_COMMANDS, ...SETTINGS_COMMANDS].map((c) => c.action).sort();
    expect(all).toEqual([...ALL_ACTIONS]);
  });

  it('🔴 2 か所に同じものを置かない(押した場所で挙動が違う、を作らない)', () => {
    const left = COLLECTION_COMMANDS.map((c) => c.action);
    const inSettings = SETTINGS_COMMANDS.map((c) => c.action);
    expect(left.filter((a) => inSettings.includes(a))).toEqual([]);
  });

  it('🔴 左の列に残すのは「よく押す / 押せないと詰まる」もの', () => {
    // ⚠ 等値で見る ── ここが緩いと、逃がしすぎ(左が空)も素通りする
    expect(COLLECTION_COMMANDS.map((c) => c.action)).toEqual(['import-file', 'export-archive']);
  });

  it('🔴 逃がした先で、実際に押せる形で描かれている', () => {
    const el = buildSettingsCommands();
    // ⚠ **描いた物**を見る(一覧の定数を見るだけでは、描き忘れが素通りする)
    const buttons = [...el.querySelectorAll('button[data-pkc-action]')].map((b) =>
      b.getAttribute('data-pkc-action'),
    );
    expect(buttons).toEqual(SETTINGS_COMMANDS.map((c) => c.action));
    // ⚠ 畳んでいないこと(2026-08-03「主要な導線を畳まない」は生きている)
    expect(el.querySelectorAll('details')).toHaveLength(0);
    // ⚠ 説明の title も落とさない ── 元に戻せない操作が 1 つ混ざっている
    for (const c of SETTINGS_COMMANDS) {
      const btn = el.querySelector<HTMLElement>(`[data-pkc-action="${c.action}"]`);
      expect(btn?.title, `${c.action} の説明が消えた`).toBe(c.title);
    }
  });

  it('⚠ 「元に戻せません」と言い続ける(片づけの断り)', () => {
    const purge = SETTINGS_COMMANDS.find((c) => c.action === 'purge-orphan-assets');
    expect(purge?.title).toContain('元に戻せません');
  });
});
