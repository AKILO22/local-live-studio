'use strict';

const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const SOURCE_FILES = Object.freeze([
  '.gitignore', 'package.json', 'package-lock.json', 'README.md', 'THIRD-PARTY-NOTICES.md',
  'main.cjs', 'preload.cjs', 'renderer.js', 'gifting.js', 'tiktok.js', 'live.js', 'phones.js', 'phone-studio.css', 'index.html', 'styles.css',
  'phone/index.html', 'phone/phone-client.js', 'phone/phone.css', 'vendor/qrcode.js', 'vendor/QR-LICENSE.txt',
  'cast.js', 'cast-studio.css', 'cast/index.html', 'cast/preload.cjs', 'cast/output.js', 'cast/output.css', 'lib/studio-route.cjs', 'test/studio-route.test.cjs',
  'lib/accounts.cjs', 'lib/gifts.cjs', 'lib/media.cjs', 'lib/online.cjs',
  'lib/recordings.cjs', 'lib/security.cjs', 'lib/storage.cjs', 'lib/tiktok.cjs', 'lib/tiktok-http.cjs', 'lib/livestream.cjs', 'lib/phone.cjs', 'server/tiktok-broker.cjs',
  'scripts/package.cjs', 'scripts/release.cjs', 'scripts/check-live-output.cjs', 'scripts/check-phone-link.cjs', 'scripts/publish-github.ps1',
  'test/main.test.cjs', 'test/online.test.cjs', 'test/accounts.test.cjs', 'test/account-ui.test.cjs', 'test/gifts.test.cjs', 'test/release.test.cjs', 'test/tiktok.test.cjs', 'test/tiktok-ui.test.cjs', 'test/livestream.test.cjs', 'test/live-ui.test.cjs', 'test/phone.test.cjs', 'test/phone-ui.test.cjs', 'test/phone-client.test.cjs',
  'docs/DOWNLOAD.md', 'docs/RELEASE-NOTES-1.3.0.md', 'docs/RELEASE-NOTES-1.4.0.md', 'docs/RELEASE-NOTES-1.5.0.md', 'docs/RELEASE-NOTES-1.6.0.md', 'docs/TIKTOK-SETUP.md', 'docs/LIVESTREAM.md', 'docs/PHONE.md',
  'docs/RELEASE-NOTES-1.7.0.md', 'docs/TIKTOK-STUDIO-ROUTE.md', 'docs/TIKTOK-BROADCAST-ARCHITECTURE.md',
  '.github/workflows/windows-release.yml', '.github/workflows/publish-verified-release.yml'
]);
function releaseNames(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Use a numeric release version.');
  return { windows: `Local-LIVE-Studio-${version}-windows-x64.zip`, source: `Local-LIVE-Studio-${version}-source.zip` };
}
function portableLauncher() {
  return ['@echo off', 'setlocal', 'set "ELECTRON_RUN_AS_NODE="', 'set "studioExe=%~dp0Local LIVE Studio\\Local LIVE Studio.exe"',
    'if not exist "%studioExe%" (', '  echo Extract the entire downloaded ZIP before opening this launcher.', '  pause', '  exit /b 1', ')',
    'start "" "%studioExe%"', 'endlocal', ''].join('\r\n');
}
async function zipDirectory(directory, output) {
  if (process.platform !== 'win32') throw new Error('Build Windows release archives on Windows.');
  try { await fs.access(output); throw new Error('A release asset already exists. Create a new release directory or version.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  await new Promise((resolve, reject) => {
    const child = spawn(executable, ['-NoProfile', '-NonInteractive', '-Command',
      "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory($env:STUDIO_ZIP_INPUT,$env:STUDIO_ZIP_OUTPUT,[System.IO.Compression.CompressionLevel]::Optimal,$false)"],
    { windowsHide: true, stdio: 'inherit', env: { ...process.env, STUDIO_ZIP_INPUT: directory, STUDIO_ZIP_OUTPUT: output } });
    child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(`ZIP creation failed (${code}).`)));
  });
}
async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
async function removeStage(stage, parent) {
  const resolved = await fs.realpath(stage), expectedParent = await fs.realpath(parent);
  if (path.dirname(resolved) !== expectedParent || !path.basename(resolved).startsWith('.stage-')) throw new Error('Refusing to remove an unexpected release staging directory.');
  await fs.rm(resolved, { recursive: true, force: true });
}
async function prepareRelease(root = ROOT) {
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  const names = releaseNames(manifest.version), releaseDir = path.join(root, 'dist', `v${manifest.version}`);
  await fs.mkdir(releaseDir, { recursive: true });
  if (path.relative(await fs.realpath(root), await fs.realpath(releaseDir)) !== path.join('dist', `v${manifest.version}`)) throw new Error('Release assets must stay inside this project.');
  for (const file of [names.windows, names.source]) {
    if (await fs.stat(path.join(releaseDir, file)).catch(error => { if (error.code !== 'ENOENT') throw error; return null; })) throw new Error(`Release asset exists: ${file}. It was preserved.`);
  }
  const runtime = path.join(root, 'release', 'Local LIVE Studio-win32-x64');
  for (const file of ['Local LIVE Studio.exe', 'resources/app.asar', 'LICENSE', 'LICENSES.chromium.html']) await fs.access(path.join(runtime, file));
  for (const file of SOURCE_FILES) await fs.access(path.join(root, file));
  const stage = path.join(releaseDir, `.stage-${randomUUID()}`);
  await fs.mkdir(stage);
  try {
    const windows = path.join(stage, 'windows'), source = path.join(stage, 'source');
    await fs.mkdir(windows); await fs.mkdir(source);
    await fs.cp(runtime, path.join(windows, 'Local LIVE Studio'), { recursive: true, dereference: false });
    await fs.writeFile(path.join(windows, 'Launch Local LIVE Studio.cmd'), portableLauncher());
    await fs.copyFile(path.join(root, 'docs', 'DOWNLOAD.md'), path.join(windows, 'START-HERE.txt'));
    await fs.copyFile(path.join(root, 'README.md'), path.join(windows, 'USER-GUIDE.md'));
    await fs.copyFile(path.join(root, 'THIRD-PARTY-NOTICES.md'), path.join(windows, 'THIRD-PARTY-NOTICES.md'));
    await fs.mkdir(path.join(windows, 'docs'));
    for (const file of ['DOWNLOAD.md', 'TIKTOK-SETUP.md', 'LIVESTREAM.md', 'PHONE.md', 'TIKTOK-STUDIO-ROUTE.md', 'TIKTOK-BROADCAST-ARCHITECTURE.md']) await fs.copyFile(path.join(root, 'docs', file), path.join(windows, 'docs', file));
    const sourceRoot = path.join(source, 'local-live-studio');
    for (const file of SOURCE_FILES) {
      const target = path.join(sourceRoot, file);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(path.join(root, file), target);
    }
    for (const [input, name] of [[windows, names.windows], [source, names.source]]) {
      console.log(`Creating ${name}`);
      await zipDirectory(input, path.join(stage, name));
    }
    for (const name of [names.windows, names.source]) await fs.rename(path.join(stage, name), path.join(releaseDir, name));
    const checksums = [];
    for (const name of [names.windows, names.source]) checksums.push(`${await sha256(path.join(releaseDir, name))}  ${name}`);
    await fs.writeFile(path.join(releaseDir, 'SHA256SUMS.txt'), checksums.join('\n') + '\n');
    await fs.copyFile(path.join(root, 'docs', `RELEASE-NOTES-${manifest.version}.md`), path.join(releaseDir, 'RELEASE-NOTES.md'));
    const sourceHashes = {};
    for (const file of SOURCE_FILES) sourceHashes[file] = await sha256(path.join(root, file));
    const report = { version: manifest.version, platform: 'win32-x64', signed: false, createdAt: new Date().toISOString(), assets: [names.windows, names.source, 'SHA256SUMS.txt'], sourceFiles: SOURCE_FILES, sourceHashes };
    await fs.writeFile(path.join(releaseDir, 'release-manifest.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(`Downloadable release: ${releaseDir}`);
    return releaseDir;
  } finally { await removeStage(stage, releaseDir); }
}
if (require.main === module) prepareRelease().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { SOURCE_FILES, releaseNames, portableLauncher, sha256, removeStage, prepareRelease };
