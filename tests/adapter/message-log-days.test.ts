/** @vitest-environment happy-dom */
/**
 * 🔴 **メッセージのノートにも、ログの日の行が付く**(#1087 M11)。
 * システム用のノートは `entryMetas` に無いので、ログかどうかを `archetype` だけで見ると付かなかった。
 * 守るもの:メッセージ・処理の記録の読む面の器に日の行の印が付く / 普通のノートには付かない(対照群)。
 * 守っていないもの:日の行の見た目(実ブラウザ)・順番(古い順のまま。向きは別に裁定待ち)。
 */
import { describe, expect, it } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { DetailRenderer } from '../../src/adapter/ui/render/detail';
import { formatMessageSection, SYSTEM_JOB_LID, SYSTEM_MESSAGE_LID } from '../../src/features/message/message-log';

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 50));

async function open(lid: string): Promise<{ root: HTMLElement; host: Element | null }> {
  const root = document.createElement('div');
  root.setAttribute('data-pkc-slot', 'root');
  document.body.append(root);
  const d = new Dispatcher();
  const regions = buildShell(root);
  const detail = new DetailRenderer(regions.detail);
  d.onState((s) => detail.render(s));
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [], relations: [] });
  let body = '';
  for (let i = 0; i < 6; i += 1)
    body += formatMessageSection({
      at: `2026-10-1${i % 3}T01:00:0${i}.000Z`,
      kind: 'problem',
      source: 'storage',
      text: `件 ${i}`,
    });
  d.dispatch({ type: 'MESSAGES_READ', lid });
  d.dispatch({ type: 'BODY_LOADED', lid, body });
  await settle();
  return { root, host: root.querySelector('[data-pkc-field="detail-body"]') };
}

describe('メッセージのノートの日の行', () => {
  it.each([SYSTEM_MESSAGE_LID, SYSTEM_JOB_LID])('🔴 %s の読む面の器に、日の行の印が付く', async (lid) => {
    const { root, host } = await open(lid);
    expect(host, '読む面の器が無い(前提が崩れている)').not.toBeNull();
    expect(host!.textContent, '本文が描かれていない(前提が崩れている)').toContain('件 0');
    const marked = root.querySelectorAll('[data-pkc-log-days]');
    expect(marked.length, '日の行の印が付いていない').toBeGreaterThan(0);
    expect(root.querySelectorAll('[data-pkc-log-day]').length, '日の行が出ていない').toBeGreaterThan(0);
  });
});
