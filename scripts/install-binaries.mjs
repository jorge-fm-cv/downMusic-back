#!/usr/bin/env node
// ---------------------------------------------------------------
// Instala yt-dlp y ffmpeg en ./bin para entornos sin gestor de
// paquetes (p. ej. el build de Render, donde no hay `apt`).
//
// Se ejecuta en `npm install` (postinstall). Si los binarios ya
// están en el PATH del sistema (brew, apt, chocolatey…) no descarga
// nada, así que en local no molesta.
//
// Para saltarlo explícitamente: SKIP_BINARY_DOWNLOAD=1 npm install
// ---------------------------------------------------------------
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BIN_DIR = join(ROOT, 'bin');
const IS_WINDOWS = process.platform === 'win32';
const EXE = IS_WINDOWS ? '.exe' : '';
const FFMPEG_RELEASE = 'b6.1.1'; // ffmpeg 6.1.1 (builds estáticos de ffmpeg-static)

const YTDLP_ASSETS = {
  'linux-x64': 'yt-dlp_linux',
  'linux-arm64': 'yt-dlp_linux_aarch64',
  'linux-arm': 'yt-dlp_linux_armv7l',
  'linux-ia32': 'yt-dlp_linux_x86',
  'darwin-x64': 'yt-dlp_macos',
  'darwin-arm64': 'yt-dlp_macos',
  'win32-x64': 'yt-dlp.exe',
  'win32-ia32': 'yt-dlp_x86.exe',
};

const FFMPEG_ASSETS = {
  'linux-x64': 'ffmpeg-linux-x64',
  'linux-arm64': 'ffmpeg-linux-arm64',
  'linux-arm': 'ffmpeg-linux-arm',
  'linux-ia32': 'ffmpeg-linux-ia32',
  'darwin-x64': 'ffmpeg-darwin-x64',
  'darwin-arm64': 'ffmpeg-darwin-arm64',
  'win32-x64': 'ffmpeg-win32-x64',
  'win32-ia32': 'ffmpeg-win32-ia32',
};

const key = `${process.platform}-${process.arch}`;

function log(msg) {
  console.log(`[binaries] ${msg}`);
}

function runs(command, args) {
  const result = spawnSync(command, args, { stdio: 'ignore' });
  return !result.error && result.status === 0;
}

async function download(url, dest) {
  const response = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(300_000),
  });
  if (!response.ok || !response.body) {
    throw new Error(`HTTP ${response.status} al descargar ${url}`);
  }

  const tmp = `${dest}.part`;
  rmSync(tmp, { force: true });
  await pipeline(Readable.fromWeb(response.body), createWriteStream(tmp));
  rmSync(dest, { force: true });
  renameSync(tmp, dest);
  chmodSync(dest, 0o755);

  return statSync(dest).size;
}

function mb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function ensureBinary({ name, envVar, versionArgs, asset, url }) {
  if (process.env[envVar]) {
    log(`${name}: usando ${envVar}=${process.env[envVar]}`);
    return;
  }

  const dest = join(BIN_DIR, `${name}${EXE}`);

  if (existsSync(dest) && runs(dest, versionArgs)) {
    log(`${name}: ya instalado en bin/`);
    return;
  }

  if (runs(name, versionArgs)) {
    log(`${name}: disponible en el PATH del sistema`);
    return;
  }

  if (!asset) {
    throw new Error(`No hay binario de ${name} para ${process.platform}/${process.arch}`);
  }

  log(`${name}: descargando ${asset}…`);
  mkdirSync(BIN_DIR, { recursive: true });
  const size = await download(url(asset), dest);
  log(`${name}: instalado en bin/ (${mb(size)})`);
}

async function main() {
  if (process.env.SKIP_BINARY_DOWNLOAD === '1') {
    log('SKIP_BINARY_DOWNLOAD=1, no se descarga nada');
    return;
  }

  await ensureBinary({
    name: 'yt-dlp',
    envVar: 'YTDLP_BIN',
    versionArgs: ['--version'],
    asset: YTDLP_ASSETS[key],
    url: (asset) => `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${asset}`,
  });

  await ensureBinary({
    name: 'ffmpeg',
    envVar: 'FFMPEG_BIN',
    versionArgs: ['-version'],
    asset: FFMPEG_ASSETS[key],
    url: (asset) =>
      `https://github.com/eugeneware/ffmpeg-static/releases/download/${FFMPEG_RELEASE}/${asset}`,
  });
}

main().catch((err) => {
  console.error(`[binaries] Error: ${err.message}`);
  console.error(
    '[binaries] Puedes instalar yt-dlp/ffmpeg manualmente o definir YTDLP_BIN y FFMPEG_BIN.'
  );
  process.exitCode = 1;
});
