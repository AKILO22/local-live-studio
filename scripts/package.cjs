'use strict';

const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const NAME = 'Local LIVE Studio';
const TARGET = `${NAME}-win32-x64`;
const ROOT_FILES = new Set(['package.json', 'main.cjs', 'preload.cjs', 'index.html', 'styles.css', 'renderer.js', 'gifting.js', 'tiktok.js', 'live.js', 'phones.js', 'phone-studio.css', 'cast.js', 'cast-studio.css']);

function ignoreFile(input) {
  const relative = input.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!relative) return false;
  if (ROOT_FILES.has(relative) || relative === 'lib' || /^lib\/[^/]+\.cjs$/.test(relative)) return false;
  if (['phone', 'phone/index.html', 'phone/phone-client.js', 'phone/phone.css', 'vendor', 'vendor/qrcode.js', 'vendor/QR-LICENSE.txt'].includes(relative)) return false;
  if (['cast', 'cast/index.html', 'cast/preload.cjs', 'cast/output.js', 'cast/output.css'].includes(relative)) return false;
  // No runtime npm dependencies. In particular, omit tests, evidence, .git,
  // release, documentation, build tools, and every development node_module.
  return true;
}

function packageOptions(manifest, root = ROOT) {
  return {
    dir: root, name: NAME, executableName: NAME,
    platform: 'win32', arch: 'x64', electronVersion: manifest.devDependencies.electron,
    appVersion: manifest.version, buildVersion: manifest.version,
    appBundleId: 'independent.local-live-studio',
    out: path.join(root, 'release'), asar: true, prune: true,
    overwrite: true, ignore: ignoreFile,
    win32metadata: {
      CompanyName: 'Independent local software', FileDescription: NAME,
      ProductName: NAME, InternalName: 'LocalLIVEStudio',
      OriginalFilename: `${NAME}.exe`
    }
  };
}

async function checkOutput(root) {
  const release = path.join(root, 'release');
  await fs.mkdir(release, { recursive: true });
  const realRoot = await fs.realpath(root);
  const realRelease = await fs.realpath(release);
  if (path.relative(realRoot, realRelease) !== 'release') throw new Error('The release directory must be a real directory inside this project.');
  const target = path.join(release, TARGET);
  const stat = await fs.lstat(target).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error('Refusing to replace an unexpected release destination.');
  if (stat) {
    const realTarget = await fs.realpath(target);
    if (path.relative(realRelease, realTarget) !== TARGET) throw new Error('The release destination is outside this project.');
  }
}

function launcherText() {
  return [
    '@echo off', 'setlocal', 'set "ELECTRON_RUN_AS_NODE="',
    `set "studioExe=%~dp0release\\${TARGET}\\${NAME}.exe"`,
    'if not exist "%studioExe%" (',
    '  echo Local LIVE Studio has not been packaged yet. Run npm run build first.',
    '  pause', '  exit /b 1', ')',
    'start "" "%studioExe%"', 'endlocal', ''
  ].join('\r\n');
}

async function localElectronZip(root, version) {
  const filename = `electron-v${version}-win32-x64.zip`;
  const archive = path.join(root, '.cache', filename);
  const stat = await fs.stat(archive).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
  if (!stat) return null;
  if (!stat.isFile() || !stat.size) throw new Error('The local Electron archive is incomplete.');
  const checksums = JSON.parse(await fs.readFile(path.join(root, 'node_modules', 'electron', 'checksums.json'), 'utf8'));
  const expected = checksums[filename];
  if (!/^[a-f0-9]{64}$/i.test(expected || '')) throw new Error('No official checksum is available for the cached Electron archive.');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(archive)) hash.update(chunk);
  if (hash.digest('hex') !== expected.toLowerCase()) throw new Error('The cached Electron archive does not match its official SHA256 checksum.');
  return path.dirname(archive);
}

async function build(root = ROOT) {
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  for (const file of ROOT_FILES) await fs.access(path.join(root, file));
  await fs.access(path.join(root, 'lib', 'storage.cjs'));
  await checkOutput(root);
  const options = packageOptions(manifest, root);
  const zipDirectory = await localElectronZip(root, options.electronVersion);
  if (zipDirectory) options.electronZipDir = zipDirectory;
  const { packager } = await import('@electron/packager');
  const paths = await packager(options);
  const output = path.join(root, 'release', TARGET);
  if (!paths.some(item => path.resolve(item) === output)) throw new Error('Packager did not produce the expected portable app.');
  await fs.access(path.join(output, `${NAME}.exe`));
  await fs.access(path.join(output, 'resources', 'app.asar'));
  await fs.writeFile(path.join(root, 'Launch Local LIVE Studio.cmd'), launcherText(), 'utf8');
  console.log(`Portable app: ${output}\nLauncher: ${path.join(root, 'Launch Local LIVE Studio.cmd')}`);
  return output;
}

if (require.main === module) build().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { build, packageOptions, ignoreFile, launcherText, checkOutput, localElectronZip };
