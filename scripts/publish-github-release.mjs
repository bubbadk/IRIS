import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

async function main() {
  console.log('Retrieving GitHub credentials...');
  const credOut = execSync('echo "url=https://github.com" | git credential fill', {
    encoding: 'utf-8',
  });

  const lines = credOut.split('\n');
  let token = '';
  for (const line of lines) {
    if (line.startsWith('password=')) {
      token = line.replace('password=', '').trim();
    }
  }

  if (!token) {
    throw new Error('No GitHub token found in git credentials.');
  }

  const repo = 'bubbadk/IRIS';
  const tag = 'v0.1.0-alpha';

  console.log(`Checking existing releases for ${repo}...`);
  const listRes = await fetch(`https://api.github.com/repos/${repo}/releases`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'IRIS-Release-Publisher',
    },
  });

  const releases = await listRes.json();
  let release = Array.isArray(releases) ? releases.find((r) => r.tag_name === tag) : null;

  if (!release) {
    console.log(`Creating new release ${tag}...`);
    const createRes = await fetch(`https://api.github.com/repos/${repo}/releases`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'IRIS-Release-Publisher',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        tag_name: tag,
        target_commitish: 'main',
        name: 'IRIS v0.1.0-alpha',
        body: `## IRIS v0.1.0-alpha (Public Alpha)

**Intelligent Reasoning & Integration System** — The spatial operating environment for autonomous AI agents.

### ✨ What's Included in this Release:
- 🛸 **Floating Desktop Desklet (Live HUD)**: Frosted glass capsule with live status pulse, activity ticker, and system telemetry.
- 🤖 **Multi-Agent Cortex**: Autonomous sub-agent delegation, planning, and tool orchestration.
- 🔌 **Model Context Protocol (MCP) & Skills**: Built-in support for stdio/SSE/HTTP tool servers.
- 🛡️ **Interactive Workspace & Diff Viewer**: Direct patch inspection and permission safety gates.
- 🧠 **Vector Memory & Dreaming**: Semantic graph indexing and background consolidation.
- 🌐 **100% Model Agnostic**: Native support for Ollama, OpenRouter, Anthropic Claude, OpenAI, and Google Gemini.

### 📦 Release Binaries
- \`iris-v0.1.0-alpha-linux-x86_64.tar.gz\`: Linux x86_64 pre-compiled production binary bundle.`,
        draft: false,
        prerelease: true,
      }),
    });

    if (!createRes.ok) {
      const errText = await createRes.text();
      throw new Error(`Failed to create release: ${createRes.status} ${errText}`);
    }

    release = await createRes.json();
    console.log(`Release created: ${release.html_url}`);
  } else {
    console.log(`Found existing release: ${release.html_url}`);
  }

  const assetPath = path.resolve('iris-v0.1.0-alpha-linux-x86_64.tar.gz');
  if (!fs.existsSync(assetPath)) {
    throw new Error(`Asset file not found: ${assetPath}`);
  }

  const assetName = 'iris-v0.1.0-alpha-linux-x86_64.tar.gz';
  const uploadUrlTemplate = release.upload_url; // e.g. https://uploads.github.com/repos/bubbadk/IRIS/releases/12345/assets{?name,label}
  const uploadUrl = uploadUrlTemplate.replace(/\{\?name,label\}/, `?name=${encodeURIComponent(assetName)}`);

  console.log(`Uploading ${assetName} (${(fs.statSync(assetPath).size / 1024 / 1024).toFixed(2)} MB)...`);
  const fileBuffer = fs.readFileSync(assetPath);

  const uploadRes = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'IRIS-Release-Publisher',
      'Content-Type': 'application/gzip',
    },
    body: fileBuffer,
  });

  if (!uploadRes.ok) {
    const errText = await uploadRes.text();
    console.warn(`Upload response: ${uploadRes.status} ${errText}`);
  } else {
    const assetInfo = await uploadRes.json();
    console.log(`Asset uploaded successfully! Download URL: ${assetInfo.browser_download_url}`);
  }

  console.log(`Release is live at: ${release.html_url}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
