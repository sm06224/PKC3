import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fakeS3 } from '../helpers/fake-s3';

/** 作り物の S3 互換サーバ(Node の HTTP・別 origin)── `sync-s3` と `visual-audit` が共有する。 */
export const SECRET = { accessKeyId: 'SMOKE-KEY-ID-4a4', secretAccessKey: 'smoke/SECRET+key=4a4' };
export const PASS = 'smoke-パスフレーズ-4b-φ-2026';

export interface MockS3 {
  url: string;
  s3: ReturnType<typeof fakeS3>;
  cors: boolean;
  race: boolean;
  server: Server;
}

export async function startMockS3(): Promise<MockS3> {
  const m = { cors: true, race: false } as MockS3;
  m.s3 = fakeS3(SECRET, {
    beforePut: (key) => {
      if (!m.race) return;
      m.race = false;
      m.s3.objects.set(key, { body: new TextEncoder().encode('別の端末が書いた'), etag: '"racer"', mtime: new Date().toISOString() });
    },
  });
  m.server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      void (async () => {
        const origin = req.headers.origin ?? '';
        const corsHeaders: Record<string, string> = m.cors
          ? { 'access-control-allow-origin': origin, 'access-control-expose-headers': 'ETag', vary: 'Origin' }
          : {};
        if (req.method === 'OPTIONS') {
          res.writeHead(
            m.cors ? 204 : 403,
            m.cors
              ? {
                  ...corsHeaders,
                  'access-control-allow-methods': 'GET, PUT, DELETE, HEAD',
                  'access-control-allow-headers': req.headers['access-control-request-headers'] ?? '',
                  'access-control-max-age': '0',
                }
              : {},
          );
          res.end();
          return;
        }
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers[k] = v;
        const body = Buffer.concat(chunks);
        const r = await m.s3.fetch(`http://${req.headers.host ?? ''}${req.url ?? '/'}`, {
          method: req.method ?? 'GET',
          headers,
          ...(req.method === 'PUT' ? { body: new Uint8Array(body) } : {}),
        });
        const out: Record<string, string> = { ...corsHeaders };
        const etag = r.headers.get('etag');
        if (etag !== null) out.etag = etag;
        res.writeHead(r.status, out);
        res.end(Buffer.from(await r.arrayBuffer()));
      })();
    });
  });
  await new Promise<void>((resolve) => m.server.listen(0, '127.0.0.1', resolve));
  m.url = `http://127.0.0.1:${String((m.server.address() as AddressInfo).port)}`;
  return m;
}

