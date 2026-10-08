// 1 本の run: 文書を開いて、手順(env STEPS = JSON)を順に当て、各手順のあとに観測して json に残す。
// usage: node run.mjs PACK FX DOC OUT SHOTDIR TAG   (PACK = 一式の dir / FX = 文書の dir / OUT = json の path)
// env: STEPS(JSON)/ CONSOLE_LOG(console を書き出す file)/ PKC3_JSBEAT / PKC3_STACKDUMP / PKC3_CHROMIUM(README.md)
import { writeFile } from 'node:fs/promises';
import { serve, openOffice, QT_WINDOWS } from './lib.mjs';
const [PACK, FX, DOC, OUT, SHOT, TAG] = process.argv.slice(2);
const STEPS = JSON.parse(process.env.STEPS ?? '[]');
const server = await serve(PACK); const base = `http://127.0.0.1:${server.address().port}`;
const o = await openOffice({ base, FX, docName: DOC, tag: TAG, shotdir: SHOT });
const res = { tag: TAG, doc: DOC, pack: PACK, row: o.row, obs: [] };
const flush = () => writeFile(OUT, JSON.stringify(res, null, 1));
if (o.h) {
  const { page, h } = o;
  const observe = async (label) => {
    const alive = await h.alive();
    if (!alive && h.stackdump) await h.stackdump(`observe ${label} alive=false`);
    const win = alive ? await Promise.race([page.evaluate(QT_WINDOWS), new Promise((r) => setTimeout(() => r(null), 8000))]).catch(() => null) : null;
    const fr = alive ? await h.frames(3) : null;
    const status = alive ? await h.status() : null;
    const bc = alive ? await page.evaluate('globalThis.__bcall').catch(() => null) : null;
    return { label, alive, windows: win && win.map((w) => `${w.w}x${w.h}@${w.x},${w.y}:${w.title.slice(0, 40)}`), nWin: win?.length ?? null, bytes: fr?.bytes ?? null, hashes: fr?.hashes ?? null, status, bc, faults: o.row.faults.length };
  };
  res.obs.push(await observe('opened'));
  for (const s of STEPS) {
    const b = o.row.faults.length;
    if (process.env.CONSOLE_LOG) { const { appendFileSync } = await import('node:fs'); appendFileSync(process.env.CONSOLE_LOG, `[STEP @${Date.now()}] ${s.name ?? ''}\n`); }
    if (s.click) await page.mouse.click(s.click[0], s.click[1], { button: s.btn ?? 'left', clickCount: s.n ?? 1 });
    else if (s.dbl) await page.mouse.dblclick(s.dbl[0], s.dbl[1]);
    else if (s.press) await page.keyboard.press(s.press);
    else if (s.type) await page.keyboard.type(s.type, { delay: 120 });
    else if (s.seed !== undefined) res.seedWrite = await page.evaluate((t) => globalThis.navigator.clipboard.writeText(t).then(() => 'ok', (e) => String(e)), s.seed);
    else if (s.seedhtml) res.seedWrite = await page.evaluate(async ({ t, h }) => { try { const item = new globalThis.ClipboardItem({ 'text/plain': new globalThis.Blob([t], { type: 'text/plain' }), 'text/html': new globalThis.Blob([h], { type: 'text/html' }) }); await globalThis.navigator.clipboard.write([item]); return 'ok'; } catch (e) { return String(e); } }, s.seedhtml);
    else if (s.readclip) res.clipRead = await page.evaluate(() => globalThis.navigator.clipboard.readText().then((t) => t, (e) => 'ERR ' + e));
    await page.waitForTimeout(s.wait ?? 2500);
    if (s.shot) await h.shot(s.shot);
    const ob = await observe(s.name ?? JSON.stringify(s).slice(0, 60));
    ob.step = s; ob.newFaults = o.row.faults.slice(b);
    res.obs.push(ob);
    await flush();
  }
}
res.row.trace = o.row.trace.slice(-400);
await flush();
await o.close(); server.close();
console.log('done'); process.exit(0);
