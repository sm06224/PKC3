/** @vitest-environment node */
import { readFileSync } from 'node:fs';
import { describe, it } from 'vitest';
import { THEMES } from '../../src/adapter/ui/render/theme';
import { dL, layerPairs, poor, themeTokens } from '../helpers/boundary-model';
const css = readFileSync('src/styles/tokens.css', 'utf8');
describe('measure', () => {
  it('table', () => {
    const rows: string[] = [];
    for (const t of THEMES) {
      const p = layerPairs(themeTokens(css, t.id));
      rows.push(
        t.id.padEnd(14) +
          Object.entries(p)
            .map(([k, [a, b]]) => `${k}:${dL(a, b).toFixed(2)}/${dL(poor(a), poor(b)).toFixed(2)}`)
            .join('  '),
      );
    }
    require('node:fs').writeFileSync(process.env.OUT ?? '/dev/null', rows.join('\n'));
  });
});
