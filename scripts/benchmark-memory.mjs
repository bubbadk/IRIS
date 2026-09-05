import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(new URL('../apps/desktop/package.json', import.meta.url));
const { createServer } = await import(require.resolve('vite'));
const root = fileURLToPath(new URL('..', import.meta.url));
const server = await createServer({ root, configFile: false, optimizeDeps: { noDiscovery: true, entries: [] }, server: { middlewareMode: true }, appType: 'custom' });
try {
  const { runRealMemoryBenchmark } = await server.ssrLoadModule('/packages/memory/src/benchmark.ts');
  const result = await runRealMemoryBenchmark();
  const sources = ['index.ts', 'temporal.ts', 'benchmark.ts', 'officialFpAmbData.ts'];
  const report = {
    metric: 'retrieved-answer coverage at top 5; not end-to-end agent answer accuracy',
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    workingTreeDirty: Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim()),
    sourceHashes: Object.fromEntries(sources.map(file => [file, createHash('sha256').update(readFileSync(resolve(root, 'packages/memory/src', file))).digest('hex')])),
    runtime: process.version,
    result,
  };
  const json = JSON.stringify(report, null, 2) + '\n';
  if (process.argv[2]) writeFileSync(resolve(process.argv[2]), json);
  else process.stdout.write(json);
} finally { await server.close(); }
