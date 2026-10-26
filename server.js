import express from 'express';
import cors from 'cors';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const YTDLP = process.env.YTDLP_BIN || 'yt-dlp';
const FFMPEG = process.env.FFMPEG_BIN || 'ffmpeg';
const PORT = Number(process.env.PORT || 4000);
const HOST = process.env.HOST || '0.0.0.0';

const app = express();
app.use(cors());
app.use(express.json());

// ---------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------

const YT_BASE = (id) => `https://www.youtube.com/watch?v=${id}`;

/** Limpia un nombre para usarlo como nombre de archivo. */
function sanitizeFilename(name) {
  return (name || 'audio')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // quitar tildes
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'audio';
}

function formatDuration(seconds) {
  if (!seconds || seconds <= 0) return null;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function baseArgs(extra = []) {
  return [
    '--no-warnings',
    '--no-progress',
    '--quiet',
    '--no-playlist',
    '--no-check-certificates',
    ...extra,
  ];
}

// ---------------------------------------------------------------
// GET /api/health
// ---------------------------------------------------------------
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'downmusic-backend', ytdlp: YTDLP, uptime: process.uptime() });
});

// ---------------------------------------------------------------
// GET /api/search?q=...&limit=...
// Busca videos en YouTube mediante yt-dlp (ytsearch).
// ---------------------------------------------------------------
app.get('/api/search', async (req, res) => {
  const q = String(req.query.q || '').trim();
  const limit = Math.min(20, Math.max(1, Number(req.query.limit) || 12));

  if (!q) {
    return res.status(400).json({ error: 'Falta el parámetro "q"' });
  }

  try {
    const { stdout } = await execFileAsync(
      YTDLP,
      [`ytsearch${limit}:${q}`, '--flat-playlist', '-J', ...baseArgs()],
      { timeout: 90000, maxBuffer: 30 * 1024 * 1024 }
    );
    const data = JSON.parse(stdout);
    const results = (data.entries || [])
      .filter((e) => e && e.id && !e.id.startsWith('UC')) // descartar canales/playlists
      .map((e) => ({
        id: e.id,
        title: e.title || '(sin título)',
        duration: e.duration || 0,
        durationText: formatDuration(e.duration),
        channel: e.channel || e.uploader || '',
        views: e.view_count || 0,
        thumbnail: `https://i.ytimg.com/vi/${e.id}/mqdefault.jpg`,
        url: e.url || YT_BASE(e.id),
      }));
    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: err.stderr?.split('\n').slice(0, 8).join('\n') || err.message });
  }
});

// ---------------------------------------------------------------
// GET /api/info?url=...
// Metadatos completos de un video.
// ---------------------------------------------------------------
app.get('/api/info', async (req, res) => {
  const url = String(req.query.url || '').trim();
  if (!url) {
    return res.status(400).json({ error: 'Falta el parámetro "url"' });
  }

  try {
    const { stdout } = await execFileAsync(YTDLP, ['-J', ...baseArgs(), url], {
      timeout: 120000,
      maxBuffer: 60 * 1024 * 1024,
    });
    const d = JSON.parse(stdout);
    res.json({
      id: d.id,
      title: d.title || '(sin título)',
      thumbnail:
        d.thumbnail ||
        (d.thumbnails && d.thumbnails[d.thumbnails.length - 1]?.url) ||
        '',
      duration: d.duration || 0,
      durationText: formatDuration(d.duration),
      channel: d.channel || d.uploader || '',
      uploadDate: d.upload_date || '',
      viewCount: d.view_count || 0,
      likeCount: d.like_count ?? null,
      url: d.webpage_url || url,
    });
  } catch (err) {
    res.status(500).json({ error: err.stderr?.split('\n').slice(0, 8).join('\n') || err.message });
  }
});

// ---------------------------------------------------------------
// GET /api/download?url=...&format=mp3|m4a&title=...
// Extrae/convierte el audio y lo transmite en streaming en cuanto
// hay datos, para que el cliente nunca llegue a un read-timeout
// mientras yt-dlp/ffmpeg trabajan.
// ---------------------------------------------------------------
const VALID_FORMATS = new Set(['mp3', 'm4a']);

/** Argumentos de yt-dlp: volcamos el audio crudo a stdout (m4a nativo si se puede). */
function downloadArgs(format, url) {
  return format === 'mp3'
    ? ['-f', 'bestaudio[ext=m4a]/bestaudio/best', '-o', '-', ...baseArgs(), url]
    : ['-f', 'bestaudio[ext=m4a]/bestaudio[ext=aac]/bestaudio/best', '-o', '-', ...baseArgs(), url];
}

/** Argumentos de ffmpeg: convierte/remuxea el stream de stdin y lo vuelca a stdout. */
function ffmpegArgs(format, bitrate) {
  const base = ['-loglevel', 'error', '-i', 'pipe:0'];
  return format === 'mp3'
    ? [...base, '-vn', '-ac', '2', '-ar', '44100', '-b:a', `${bitrate}k`, '-f', 'mp3', 'pipe:1']
    : [...base, '-c', 'copy', '-f', 'mp4', 'pipe:1']; // remux M4A a contenedor válido
}

app.get('/api/download', (req, res) => {
  const url = String(req.query.url || '').trim();
  const format = String(req.query.format || 'mp3');
  const quality = String(req.query.quality || '128');
  const title = String(req.query.title || 'audio').trim();

  if (!url) {
    return res.status(400).json({ error: 'Falta el parámetro "url"' });
  }
  if (!VALID_FORMATS.has(format)) {
    return res.status(400).json({ error: 'Formato inválido. Usa mp3 o m4a' });
  }

  // Calidad para MP3: el valor se pasa directo como bitrate de ffmpeg.
  const bitrate = /^\d{2,4}$/.test(quality) ? Math.min(320, Math.max(64, Number(quality))) : 128;
  const ext = format === 'mp3' ? '.mp3' : '.m4a';
  const fileName = `${sanitizeFilename(title)}${ext}`;
  const mime = format === 'mp3' ? 'audio/mpeg' : 'audio/mp4';

  const yt = spawn(YTDLP, downloadArgs(format, url), { stdio: ['ignore', 'pipe', 'pipe'] });
  let ff = null;

  // M4A: el stream de yt-dlp ya es un contenedor válido → pasamos directo.
  // MP3: convertimos en paralelo con ffmpeg (stdin = stdout de yt-dlp).
  let source = yt.stdout;
  if (format === 'mp3') {
    ff = spawn(FFMPEG, ffmpegArgs(format, bitrate), { stdio: ['pipe', 'pipe', 'ignore'] });
    yt.stdout.pipe(ff.stdin);
    source = ff.stdout;
    ff.stdin.on('error', () => {}); // EPIPE si ffmpeg se cierra antes
  }

  // Si el cliente o un subproceso se cierran a mitad de la transmisión,
  // nos blindamos contra EPIPE para no tumbar el proceso completo.
  res.on('error', () => {});
  yt.stdout.on('error', () => {});
  source.on('error', () => {});

  let ytStderr = '';
  yt.stderr.on('data', (d) => {
    ytStderr += d.toString();
  });

  const cleanup = () => {
    try { yt.kill('SIGKILL'); } catch { /* ya terminó */ }
    if (ff) {
      try { ff.kill('SIGKILL'); } catch { /* ya terminó */ }
    }
  };

  const fail = (message) => {
    cleanup();
    if (!res.headersSent) {
      return res.status(500).json({ error: message });
    }
    res.destroy(); // el cliente verá un error de conexión
  };

  // Volcamos el stream nada más haya datos. El primer `data` solo marca el
// momento de enviar cabeceras (sin consumir el chunk: `pipe` lo entrega).
let started = false;
const startResponse = () => {
  if (started || res.destroyed) return;
  started = true;
  res.setHeader('Content-Type', mime);
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`);
  res.setHeader('Cache-Control', 'no-store');
  res.flushHeaders();
};
source.on('data', startResponse);
source.pipe(res);

  yt.on('error', (err) => fail(`yt-dlp: ${err.message}`));
  yt.on('close', (code) => {
    if (!res.headersSent) {
      fail(code === 0 ? 'No se recibió audio del servidor' : `yt-dlp falló (código ${code}): ${ytStderr.split('\n').slice(0, 3).join(' ')}`);
    }
  });

  if (ff) {
    ff.on('error', (err) => fail(`ffmpeg: ${err.message}`));
    ff.on('close', () => {
      if (!res.headersSent) fail('ffmpeg no produjo audio');
    });
  }

  res.on('close', cleanup);
});

// ---------------------------------------------------------------

app.listen(PORT, HOST, () => {
  console.log(`🎵 downMusic backend escuchando en http://${HOST}:${PORT}`);
  console.log(`   yt-dlp: ${YTDLP}`);
});