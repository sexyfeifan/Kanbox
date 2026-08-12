import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const projectDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = path.join(projectDirectory, 'scripts', 'native', 'kankan-video-analyzer.swift');
const infoPlistPath = path.join(projectDirectory, 'scripts', 'native', 'kankan-video-analyzer-Info.plist');
const outputDirectory = path.join(projectDirectory, 'src-tauri', 'bin');
const outputPath = path.join(outputDirectory, 'kankan-video-analyzer');
const nodeRuntimePath = path.join(outputDirectory, 'kankan-node');
const nodeLicensePath = path.join(outputDirectory, 'kankan-node-LICENSE');
const nodeVersionPath = path.join(outputDirectory, 'kankan-node.version');
const nodeRuntimes = {
  arm64: {
    version: '24.19.0',
    archiveSha256: '8294b7aa9b03997481c06babf1e8b270c859358f27da57a11509afe537ac381d',
  },
  x64: {
    version: '24.19.0',
    archiveSha256: 'd1b5e999db158c62fe8f7267a4476b035d8bd93b1a605bac24a3f0dd166e3316',
  },
};

if (process.platform !== 'darwin') {
  console.log('Skipping macOS native video analyzer build on this platform.');
  process.exit(0);
}

await mkdir(outputDirectory, { recursive: true });

async function ensureNodeRuntime() {
  const architecture = process.arch === 'arm64' ? 'arm64' : 'x64';
  const runtime = nodeRuntimes[architecture];
  const expectedMarker = `node-v${runtime.version}-darwin-${architecture}\n`;
  const currentMarker = await readFile(nodeVersionPath, 'utf8').catch(() => '');
  if (currentMarker === expectedMarker) return;

  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'kankan-node-'));
  const archiveName = `node-v${runtime.version}-darwin-${architecture}.tar.gz`;
  const archivePath = path.join(temporaryDirectory, archiveName);
  try {
    const response = await fetch(`https://nodejs.org/dist/v${runtime.version}/${archiveName}`);
    if (!response.ok) throw new Error(`Node runtime download failed: ${response.status}`);
    const archive = Buffer.from(await response.arrayBuffer());
    const digest = createHash('sha256').update(archive).digest('hex');
    if (digest !== runtime.archiveSha256) throw new Error('Node runtime checksum mismatch');
    await writeFile(archivePath, archive);
    await execFileAsync('/usr/bin/tar', ['-xzf', archivePath, '-C', temporaryDirectory], {
      timeout: 180_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    const extractedRoot = path.join(temporaryDirectory, `node-v${runtime.version}-darwin-${architecture}`);
    await copyFile(path.join(extractedRoot, 'bin', 'node'), nodeRuntimePath);
    await copyFile(path.join(extractedRoot, 'LICENSE'), nodeLicensePath);
    await chmod(nodeRuntimePath, 0o755);
    await writeFile(nodeVersionPath, expectedMarker, 'utf8');
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

await ensureNodeRuntime();
await execFileAsync('/usr/bin/xcrun', [
  'swiftc',
  '-O',
  '-target', `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macosx13.0`,
  '-framework', 'AVFoundation',
  '-framework', 'Speech',
  '-Xlinker', '-sectcreate',
  '-Xlinker', '__TEXT',
  '-Xlinker', '__info_plist',
  '-Xlinker', infoPlistPath,
  sourcePath,
  '-o', outputPath,
], {
  timeout: 180_000,
  maxBuffer: 8 * 1024 * 1024,
});
await execFileAsync('/usr/bin/codesign', ['--force', '--sign', '-', outputPath], {
  timeout: 30_000,
  maxBuffer: 1024 * 1024,
});
console.log(`Built ${outputPath}`);
console.log(`Bundled Node ${nodeRuntimes[process.arch === 'arm64' ? 'arm64' : 'x64'].version}`);
