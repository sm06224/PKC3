/**
 * P2 probe: 非 Atomics SAHPool が COOP/COEP なし(crossOriginIsolated === false)で
 * 成立するかの実機確認(設計 doc §4.5)。
 * ⚠ これは成立確認のみ。性能数値は persistent profile で別途測る(計測規律:
 * ephemeral context の storage はメモリバックで実 I/O を踏まない)。
 */
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';

interface ProbeResult {
  ok: boolean;
  steps: Record<string, unknown>;
  error?: string;
}

async function run(): Promise<ProbeResult> {
  const steps: Record<string, unknown> = {};
  try {
    steps.crossOriginIsolated = globalThis.crossOriginIsolated === true;
    const t0 = performance.now();
    const sqlite3 = await sqlite3InitModule();
    steps.initMs = Math.round(performance.now() - t0);
    steps.libVersion = sqlite3.version.libVersion;

    const poolUtil = await sqlite3.installOpfsSAHPoolVfs({
      name: 'pkc3-probe',
      clearOnInit: true,
    });
    steps.vfs = 'opfs-sahpool';

    const db = new poolUtil.OpfsSAHPoolDb('/probe.db');
    db.exec(
      'CREATE TABLE IF NOT EXISTS entries (lid TEXT PRIMARY KEY, title TEXT, body TEXT)',
    );
    db.exec(
      "INSERT OR REPLACE INTO entries VALUES ('e1', 'hello', '# PKC-Markdown body')",
    );
    steps.rows = db.selectObjects('SELECT lid, title FROM entries');
    db.close();
    // プローブなので後始末まで(生成物はライフサイクル終端で破棄、の原則どおり)
    await poolUtil.removeVfs();
    return { ok: true, steps };
  } catch (e) {
    return { ok: false, steps, error: String(e) };
  }
}

void run().then((result) => {
  postMessage(result);
});
