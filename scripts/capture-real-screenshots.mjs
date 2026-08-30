import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const mimeTypes = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};

const distDir = path.resolve('apps/desktop/dist');

const server = http.createServer((req, res) => {
  let reqPath = req.url.split('?')[0];
  if (reqPath === '/') reqPath = '/index.html';
  const filePath = path.join(distDir, reqPath);

  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
  } else {
    const indexPath = path.join(distDir, 'index.html');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    fs.createReadStream(indexPath).pipe(res);
  }
});

server.listen(14208, async () => {
  console.log('Static preview server running on port 14208');
  fs.mkdirSync('docs/screenshots', { recursive: true });

  const runChromium = (args) =>
    new Promise((resolve, reject) => {
      const proc = spawn('chromium', args, { stdio: 'inherit' });
      proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`Exit ${code}`))));
    });

  try {
    console.log('Capturing real Onboarding Wizard screenshot...');
    await runChromium([
      '--headless',
      '--disable-gpu',
      '--no-sandbox',
      '--window-size=1280,820',
      '--screenshot=docs/screenshots/iris-onboarding-wizard.png',
      'http://localhost:14208',
    ]);

    console.log('Capturing real Desktop Workspace screenshot...');
    await runChromium([
      '--headless',
      '--disable-gpu',
      '--no-sandbox',
      '--window-size=1280,820',
      '--screenshot=docs/screenshots/iris-desktop-main.png',
      'http://localhost:14208?onboarding=false',
    ]);

    console.log('Capturing real Live Desklet Widget screenshot...');
    await runChromium([
      '--headless',
      '--disable-gpu',
      '--no-sandbox',
      '--window-size=480,320',
      '--screenshot=docs/screenshots/iris-desktop-widget.png',
      'http://localhost:14208?window=widget',
    ]);

    console.log('Screenshots captured successfully!');
  } catch (err) {
    console.error('Error capturing screenshots:', err);
  } finally {
    server.close();
    process.exit(0);
  }
});
