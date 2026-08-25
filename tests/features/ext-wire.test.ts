/** @vitest-environment happy-dom */
import { describe, it, expect } from 'vitest';
import {
  EXT_PORT_TAG,
  deliveredMessage,
  parseExtRequest,
  portHandoffMessage,
  projectionMessage,
} from '../../src/features/extension/ext-wire';
import { deliveredEntryOf } from '../../src/features/extension/ext-delivery';
import type { EntryMeta } from '../../src/core/model/entry-meta';

const meta: EntryMeta = {
  lid: 'a1',
  title: 'ノート',
  archetype: 'text',
  createdAt: null,
  updatedAt: null,
  entryOrder: 1,
  status: null,
  date: null,
  archived: false,
  bodyChars: 3,
};

describe('拡張と話す封筒(#195 / C-5)', () => {
  /**
   * 🔴 **段② を足しても、拡張 → ホストは `hello` 1 語のまま。**
   *
   * ⚠ これが段② の要点である ── 実体が流れるようになっても、**始めるのは user**
   *   であって拡張ではない。`get` を 1 つ足した瞬間、user のジェスチャは
   *   「この 1 件を見せる」から「**以後ぜんぶ読んでよい**」に変わる。
   * 🔑 だから**受け付ける語の集合そのもの**を pin する(等値)。
   */
  it('🔴 受け付ける依頼は `hello` だけ(pull の口は 1 つも無い)', () => {
    expect(parseExtRequest({ t: 'hello' }).ok).toBe(true);
    for (const t of ['get', 'getEntry', 'fetch', 'read', 'getBody', 'deliver', 'entry']) {
      expect(parseExtRequest({ t }).ok, `${t} を受けてしまっている`).toBe(false);
    }
  });

  /**
   * 🔴 **「無い」ことと「わざと無い」ことは別の情報である。**
   * ⚠ ただ「知らない種別です」と返すと、拡張の作者は**綴りを間違えた**と読んで
   *   探し続ける ── だから取りに来た相手には、意図であることと**代わりの道**を言う。
   * ⚠ 対照群を同じ it に置く(本当に知らない語は普通の断り文になること)──
   *   置かないと「全部この文言」でも緑になる。
   */
  it('🔴 取りに来た相手には「意図的に無い」と代わりの道まで言う', () => {
    const pull = parseExtRequest({ t: 'getEntry' });
    expect(pull.ok).toBe(false);
    if (pull.ok) return;
    expect(pull.why).toContain('意図的');
    expect(pull.why, '代わりにどうすればよいかが書かれていない').toContain('このアプリへ送る');

    // ⚠ 対照群 ── 知らないだけの語は、普通の断り文のまま
    const unknown = parseExtRequest({ t: 'zzz-未知' });
    expect(unknown.ok).toBe(false);
    if (unknown.ok) return;
    expect(unknown.why).toContain('知らない種別');
    expect(unknown.why, '何でもかんでも「意図的」と言っている').not.toContain('意図的');
  });

  it('壊れた物で落ちない(理由を持って断る)', () => {
    for (const bad of [null, undefined, 1, 'hello', [], { t: 7 }]) {
      const r = parseExtRequest(bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.why.length).toBeGreaterThan(0);
    }
  });

  /**
   * 🔴 **封筒を組む口は 1 か所**(§7)。⚠ 2 か所で組むと、いつか綴りがずれ、
   *   受け側が**黙って捨てる**(2026-08-25 に実際に踏んだ)。
   */
  it('港の封筒は合図つきで、種別の綴りは 1 か所から出る', () => {
    expect(portHandoffMessage('n1')).toEqual({ tag: EXT_PORT_TAG, nonce: 'n1' });
    expect(projectionMessage({ entries: [], total: 0, truncated: false }).t).toBe('projection');
    expect(deliveredMessage(deliveredEntryOf(meta, 'ほんぶん')).t).toBe('entry');
  });

  it('実体の封筒は本文を持って渡る', () => {
    const m = deliveredMessage(deliveredEntryOf(meta, 'ほんぶん'));
    expect(m.t === 'entry' && m.entry.body).toBe('ほんぶん');
  });
});
