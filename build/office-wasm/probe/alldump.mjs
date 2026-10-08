// 全 target(page + dedicated worker = pthread)に raw CDP で attach し、Debugger を先に有効にしておき、
// 固まった瞬間に全部へ Debugger.pause を送って stack を集める(#1408)。Node 22 の global WebSocket を使う。
import { readFile } from 'node:fs/promises';
export async function connectAll(profileDir, log, { attachTimeoutMs = 20000 } = {}) {
  let port = null, path = null;
  for (let i = 0; i < 50 && port === null; i += 1) { try { const t = (await readFile(`${profileDir}/DevToolsActivePort`, 'utf8')).split('\n'); port = Number(t[0]); path = t[1]; } catch { await new Promise((r) => setTimeout(r, 200)); } }
  if (port === null) throw new Error('DevToolsActivePort not found');
  const ws = new globalThis.WebSocket(`ws://127.0.0.1:${port}${path}`);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = (e) => rej(new Error('ws error ' + (e.message ?? ''))); });
  let seq = 0; const pending = new Map(); const sessions = new Map(); // sessionId -> { type, url, targetId, enabled }
  const waiters = []; // { sessionId, method, resolve }
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (process.env.PKC3_CDP_DEBUG && d.method) log?.(`evt ${d.method} sid=${(d.sessionId||'').slice(0,8)} ${d.method==='Debugger.paused'?'':JSON.stringify(d.params).slice(0,120)}`);
    if (d.id !== undefined && pending.has(d.id)) { const p = pending.get(d.id); pending.delete(d.id); if (d.error) p.rej(new Error(JSON.stringify(d.error))); else p.res(d.result); return; }
    if (d.method === 'Target.attachedToTarget') { const { sessionId, targetInfo } = d.params; sessions.set(sessionId, { type: targetInfo.type, url: targetInfo.url, targetId: targetInfo.targetId, enabled: false }); onAttached(sessionId).catch(() => {}); }
    if (d.method === 'Target.detachedFromTarget') sessions.delete(d.params.sessionId);
    for (let i = waiters.length - 1; i >= 0; i -= 1) { const w = waiters[i]; if (w.method === d.method && (w.sessionId === undefined || w.sessionId === d.sessionId)) { waiters.splice(i, 1); w.resolve(d); } }
  };
  const send = (method, params = {}, sessionId, timeoutMs = 15000) => new Promise((res, rej) => {
    const id = ++seq; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error(`timeout ${method}`)); } }, timeoutMs);
  });
  const waitEvent = (method, sessionId, timeoutMs) => new Promise((res) => { const w = { method, sessionId, resolve: res }; waiters.push(w); setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) { waiters.splice(i, 1); res(null); } }, timeoutMs); });
  const onAttached = async (sessionId) => {
    const s = sessions.get(sessionId); if (!s) return;
    if (s.type === 'page' || s.type === 'iframe') await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sessionId).then(() => log?.(`setAutoAttach ok on ${sessionId.slice(0,8)}`), (e) => log?.(`setAutoAttach err ${String(e).slice(0,120)}`));
    try { await send('Debugger.enable', {}, sessionId, attachTimeoutMs); s.enabled = true; } catch (e) { s.enabled = String(e).slice(0, 80); }
    log?.(`attached ${s.type} ${sessionId.slice(0, 8)} ${String(s.url).slice(-50)} enabled=${s.enabled}`);
  };
  // browser-level: attach to every page target now; future pages come via setAutoAttach on browser session
  await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }).catch(() => {});
  const { targetInfos } = await send('Target.getTargets');
  for (const t of targetInfos) { if (t.type === 'page' && !t.attached) { const r = await send('Target.attachToTarget', { targetId: t.targetId, flatten: true }); if (!sessions.has(r.sessionId)) { sessions.set(r.sessionId, { type: t.type, url: t.url, targetId: t.targetId, enabled: false }); await onAttached(r.sessionId); } } }
  // 全 target へ同時に pause を送り、各 target の結果を順に並べる(順に待つと 16 worker × 8 s = 2 分かかり、その間に状態が動く)
  const dumpAll = async (why, { perTargetMs = 8000 } = {}) => {
    const entries = [...sessions.entries()];
    const t0 = Date.now();
    const results = await Promise.all(entries.map(async ([sid, s]) => {
      const out = [];
      if (s.enabled !== true) { out.push(`## ${s.type} ${sid.slice(0, 8)} ${String(s.url).slice(-40)}: debugger not enabled (${s.enabled})`); return out; }
      const pausedP = waitEvent('Debugger.paused', sid, perTargetMs);
      send('Debugger.pause', {}, sid, perTargetMs).catch((e) => log?.(`pause err ${sid.slice(0,8)} ${String(e).slice(0,100)}`));
      const ev = await pausedP;
      if (!ev) { out.push(`## ${s.type} ${sid.slice(0, 8)} ${String(s.url).slice(-40)}: NO PAUSE in ${perTargetMs}ms (blocked in Atomics.wait? or idle)`); return out; }
      const frames = (ev.params.callFrames ?? []).map((f, i) => `#${i} ${f.functionName || '?'} @${String(f.url || '').split('/').pop().slice(0, 30)}:${f.location?.lineNumber ?? '?'}:${f.location?.columnNumber ?? '?'}`);
      out.push(`## ${s.type} ${sid.slice(0, 8)} ${String(s.url).slice(-40)}: paused at +${Date.now() - t0}ms reason=${ev.params.reason} frames=${frames.length}`);
      out.push(...frames.slice(0, 40));
      send('Debugger.resume', {}, sid, 5000).catch(() => {});
      return out;
    }));
    return [`(dumpAll ${why}: ${entries.length} targets, ${Date.now() - t0}ms total)`, ...results.flat()];
  };
  return { send, sessions, dumpAll, close: () => ws.close() };
}
