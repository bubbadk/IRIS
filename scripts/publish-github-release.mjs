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

  // 1. Prepare asset files
  const debSrc = path.resolve('apps/desktop/src-tauri/target/release/bundle/deb/IRIS_0.1.0_amd64.deb');
  const rpmSrc = path.resolve('apps/desktop/src-tauri/target/release/bundle/rpm/IRIS-0.1.0-1.x86_64.rpm');
  const tarSrc = path.resolve('iris-v0.1.0-alpha-linux-x86_64.tar.gz');
  const binSrc = path.resolve('apps/desktop/src-tauri/target/release/iris');

  const assetsToUpload = [];

  if (fs.existsSync(tarSrc)) {
    assetsToUpload.push({ name: 'iris-v0.1.0-alpha-linux-x86_64.tar.gz', path: tarSrc, mime: 'application/gzip' });
  }
  if (fs.existsSync(debSrc)) {
    assetsToUpload.push({ name: 'iris_0.1.0_amd64.deb', path: debSrc, mime: 'application/vnd.debian.binary-package' });
  }
  if (fs.existsSync(rpmSrc)) {
    assetsToUpload.push({ name: 'iris-0.1.0-1.x86_64.rpm', path: rpmSrc, mime: 'application/x-rpm' });
  }
  if (fs.existsSync(binSrc)) {
    const rawBinPath = path.resolve('/tmp/iris-linux-x86_64');
    fs.copyFileSync(binSrc, rawBinPath);
    fs.chmodSync(rawBinPath, 0o755);
    assetsToUpload.push({ name: 'iris-linux-x86_64', path: rawBinPath, mime: 'application/octet-stream' });
  }

  console.log(`Preparing release ${tag} for ${repo}...`);
  const listRes = await fetch(`https://api.github.com/repos/${repo}/releases`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'IRIS-Release-Publisher',
    },
  });

  const releases = await listRes.json();
  let release = Array.isArray(releases) ? releases.find((r) => r.tag_name === tag) : null;

  const releaseBody = `## IRIS v0.1.0-alpha (Public Alpha Release)

**Intelligent Reasoning & Integration System** — The spatial operating environment for autonomous AI agents.

---

### 📥 Direct Downloads & Binaries

| Package | Platform / Distro | Direct Download |
| :--- | :--- | :--- |
| 📦 **Standalone Archive** | Linux (x86_64 universal) | [**Download \`.tar.gz\`**](https://github.com/${repo}/releases/download/${tag}/iris-v0.1.0-alpha-linux-x86_64.tar.gz) |
| 📦 **Debian / Ubuntu Package** | Ubuntu, Debian, Pop!_OS, Mint | [**Download \`.deb\`**](https://github.com/${repo}/releases/download/${tag}/iris_0.1.0_amd64.deb) |
| 📦 **Fedora / RHEL Package** | Fedora, RHEL, openSUSE | [**Download \`.rpm\`**](https://github.com/${repo}/releases/download/${tag}/iris-0.1.0-1.x86_64.rpm) |
| 🚀 **Standalone Executable** | Linux (x86_64 raw binary) | [**Download \`iris-linux-x86_64\`**](https://github.com/${repo}/releases/download/${tag}/iris-linux-x86_64) |

---

### ✨ What's Included in this Release:
- 🛸 **Floating Desktop Desklet (Live HUD)**: Frosted glass capsule with live status pulse, activity ticker, and system telemetry.
- 🤖 **Multi-Agent Cortex**: Autonomous sub-agent delegation, planning, and tool orchestration.
- 🔌 **Model Context Protocol (MCP) & Skills**: Built-in support for stdio/SSE/HTTP tool servers.
- 🛡️ **Interactive Workspace & Diff Viewer**: Direct patch inspection and permission safety gates.
- 🧠 **Vector Memory & Dreaming**: Semantic graph indexing and background consolidation.
- 🌐 **100% Model Agnostic**: Native support for Ollama, OpenRouter, Anthropic Claude, OpenAI, and Google Gemini.
- 🔄 **In-App Update Notifications**: Seamless alerts when new releases become available.`;

  if (!release) {
    console.log(`Creating release ${tag}...`);
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
        body: releaseBody,
        draft: false,
        prerelease: true,
      }),
    });
    release = await createRes.json();
  } else {
    console.log(`Updating release body for ${release.html_url}...`);
    const updateRes = await fetch(`https://api.github.com/repos/${repo}/releases/${release.id}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'IRIS-Release-Publisher',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        body: releaseBody,
      }),
    });
    release = await updateRes.json();
  }

  // Delete existing assets if re-uploading
  const existingAssets = release.assets || [];
  for (const asset of assetsToUpload) {
    const found = existingAssets.find((a) => a.name === asset.name);
    if (found) {
      console.log(`Deleting existing asset ${asset.name} (${found.id})...`);
      await fetch(`https://api.github.com/repos/${repo}/releases/assets/${found.id}`, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'IRIS-Release-Publisher',
        },
      });
    }

    console.log(`Uploading ${asset.name} (${(fs.statSync(asset.path).size / 1024 / 1024).toFixed(2)} MB)...`);
    const uploadUrl = release.upload_url.replace(/\{\?name,label\}/, `?name=${encodeURIComponent(asset.name)}`);
    const buffer = fs.readFileSync(asset.path);

    const uploadRes = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'IRIS-Release-Publisher',
        'Content-Type': asset.mime,
      },
      body: buffer,
    });

    if (!uploadRes.ok) {
      console.warn(`Upload failed for ${asset.name}: ${uploadRes.status} ${await uploadRes.text()}`);
    } else {
      console.log(`Uploaded ${asset.name} successfully!`);
    }
  }

  console.log(`\n🎉 Release successfully published with all binary packages at:\n${release.html_url}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
