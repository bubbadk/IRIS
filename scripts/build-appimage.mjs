import { spawn } from 'node:child_process';

// linuxdeploy's bundled strip cannot parse modern Arch/CachyOS .relr.dyn sections.
// Retain dependency symbols instead of corrupting/failing to package those libraries.
// Upstream option: https://github.com/linuxdeploy/linuxdeploy/issues/72
const child = spawn('pnpm', ['--filter', '@iris/desktop', 'exec', 'tauri', 'build', '--bundles', 'appimage', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, NO_STRIP: process.env.NO_STRIP ?? '1' },
});
child.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
child.on('exit', (code) => { process.exitCode = code ?? 1; });
