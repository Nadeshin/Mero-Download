import { createReadStream, existsSync, writeFileSync } from 'fs';
import { promises as fsp } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { randomUUID } from 'crypto';
import { createServer } from 'http';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

import express from 'express';
import ffmpegPath from 'ffmpeg-static';

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(join(__dirname, 'public')));

const DOWNLOAD_DIR = join(tmpdir(), 'yt-downloader');
const YTDLP_BIN = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp_linux';
const YTDLP_PATH = process.env.YTDLP_PATH || join(__dirname, 'bin', YTDLP_BIN);

const QUALITY_OPTIONS = ['360', '480', '720', '1080', 'best'];

// ponytail: cookies file ditulis sinkron tiap call, file kecil (<50KB)
function getCookiesArgs() {
  const b64 = process.env.YT_COOKIES_B64;
  const raw = process.env.YT_COOKIES;
  if (!b64 && !raw) return [];
  const p = join(tmpdir(), 'yt-cookies.txt');
  try {
    if (b64) writeFileSync(p, Buffer.from(b64.replace(/\s/g, ''), 'base64'));
    else writeFileSync(p, raw.replace(/\\n/g, '\n'));
    return ['--cookies', p];
  } catch {
    return [];
  }
}

async function ensureTempDir() {
  await fsp.mkdir(DOWNLOAD_DIR, { recursive: true });
}

function cleanTitle(title) {
  return String(title)
    .replace(/[\\/:*?"<>|]/g, '_')
    .trim()
    .slice(0, 120);
}

function formatDuration(seconds) {
  if (!seconds) return null;
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function runYtDlp(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(YTDLP_PATH, [...getCookiesArgs(), ...args]);
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += d.toString()));
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.on('error', (err) => reject(new Error(err.message)));
    proc.on('close', (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(stderr.trim() || `yt-dlp exited with code ${code}`));
      }
    });
  });
}

function runYtDlpCapture(args) {
  return new Promise((resolve) => {
    const proc = spawn(YTDLP_PATH, [...getCookiesArgs(), ...args]);
    let stderr = '';
    proc.stdout.on('data', () => {});
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.on('error', (err) => resolve({ ok: false, error: err.message }));
    proc.on('close', (code) => {
      if (code === 0) {
        resolve({ ok: true });
      } else {
        resolve({ ok: false, error: stderr.trim() || `yt-dlp exited with code ${code}` });
      }
    });
  });
}

const PLAYER_CLIENTS = [
  'youtube:player_client=default,android_vr',
  'youtube:player_client=android_vr',
  'youtube:player_client=web,web_safari,android',
  'youtube:player_client=mweb',
  'youtube:player_client=tv_embedded',
];

async function runYtDlpWithFallback(args) {
  let lastError = '';
  for (const client of PLAYER_CLIENTS) {
    try {
      return await runYtDlp([...args, '--extractor-args', client]);
    } catch (err) {
      lastError = err.message;
    }
  }
  throw new Error(lastError);
}

function buildMp4Format(quality) {
  const q = QUALITY_OPTIONS.includes(String(quality)) ? String(quality) : '1080';
  if (q === 'best') {
    return 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best';
  }
  return `bestvideo[ext=mp4][height<=${q}]+bestaudio[ext=m4a]/best[ext=mp4][height<=${q}]/best[height<=${q}]`;
}

async function cleanupFiles(prefix) {
  try {
    const files = await fsp.readdir(DOWNLOAD_DIR);
    await Promise.all(
      files.filter((f) => f.startsWith(prefix)).map((f) => fsp.unlink(join(DOWNLOAD_DIR, f)))
    );
  } catch {
    /* ignore */
  }
}

async function downloadVideo({ url, format, quality }) {
  const id = randomUUID().replace(/-/g, '').slice(0, 16);
  const outputTemplate = join(DOWNLOAD_DIR, `${id}.%(ext)s`);

  let filename;
  try {
    const meta = await runYtDlpWithFallback([
      '--no-playlist',
      '--no-warnings',
      '--skip-download',
      '--print',
      '%(title)s',
      '--print',
      '%(uploader)s',
      url,
    ]);
    const [title, uploader] = meta.trim().split('\n');
    filename = `${cleanTitle(title || 'video')} - ${cleanTitle(uploader || 'Unknown channel')} - ${todayStr()}.${format}`;
  } catch {
    filename = `video_${id}.${format}`;
  }

  const commonArgs = [
    '--no-playlist',
    '--no-warnings',
    '--ffmpeg-location',
    ffmpegPath,
    '-o',
    outputTemplate,
  ];

  const args =
    format === 'mp3'
      ? [
          ...commonArgs,
          '-f',
          'bestaudio/best',
          '-x',
          '--audio-format',
          'mp3',
          '--audio-quality',
          '0',
        ]
      : [
          ...commonArgs,
          '-f',
          buildMp4Format(quality),
          '--merge-output-format',
          'mp4',
        ];

  let result = { ok: false, error: 'yt-dlp failed' };
  for (const [i, playerClient] of PLAYER_CLIENTS.entries()) {
    const attemptArgs = [
      ...args,
      '--extractor-args',
      playerClient,
      url,
    ];
    result = await runYtDlpCapture(attemptArgs);
    if (result.ok) break;
    if (i < PLAYER_CLIENTS.length - 1) await cleanupFiles(id);
  }

  if (!result.ok) {
    throw new Error(result.error);
  }

  const expected = join(DOWNLOAD_DIR, `${id}.${format}`);
  let filePath = existsSync(expected)
    ? expected
    : await fsp.readdir(DOWNLOAD_DIR).then((entries) => {
        const match = entries.find((f) => f.startsWith(id) && f.endsWith(`.${format}`));
        return match ? join(DOWNLOAD_DIR, match) : null;
      });

  if (!filePath) {
    throw new Error('Downloaded file was not found.');
  }

  return { id, filePath, filename };
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, ytdlp: existsSync(YTDLP_PATH), ffmpeg: !!ffmpegPath, cookies: !!(process.env.YT_COOKIES || process.env.YT_COOKIES_B64) });
});

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return null;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

function estimateSize(formats, format, quality) {
  const audio = formats
    .filter((f) => f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none'))
    .sort((a, b) => (b.tbr || 0) - (a.tbr || 0))[0];

  if (format === 'mp3') {
    return audio?.filesize || audio?.filesize_approx || null;
  }

  const q = QUALITY_OPTIONS.includes(String(quality)) ? String(quality) : '1080';
  const maxHeight = q === 'best' ? Infinity : parseInt(q, 10);
  const video = formats
    .filter(
      (f) =>
        f.ext === 'mp4' &&
        f.vcodec &&
        f.vcodec !== 'none' &&
        (!f.acodec || f.acodec === 'none') &&
        (f.height || 0) <= maxHeight
    )
    .sort((a, b) => (b.height || 0) - (a.height || 0) || (b.tbr || 0) - (a.tbr || 0))[0];

  const total = (video?.filesize || video?.filesize_approx || 0) + (audio?.filesize || audio?.filesize_approx || 0);
  return total > 0 ? total : null;
}

app.post('/api/info', async (req, res) => {
  const url = String(req.body?.url || '').trim();
  const format = req.body?.format === 'mp3' ? 'mp3' : 'mp4';
  const quality = req.body?.quality;
  if (!url) return res.status(400).json({ error: 'Please provide a video URL.' });

  try {
    const stdout = await runYtDlpWithFallback([
      '--dump-single-json',
      '--no-playlist',
      '--no-warnings',
      url,
    ]);
    const info = JSON.parse(stdout);
    const sizeBytes = estimateSize(info.formats || [], format, quality);
    res.json({
      title: info.title,
      duration: formatDuration(info.duration),
      uploader: info.uploader || info.channel,
      id: info.id,
      thumbnail: info.thumbnail,
      sizeBytes,
      sizeLabel: formatBytes(sizeBytes),
    });
  } catch (err) {
    res.status(400).json({ error: `Could not fetch video info: ${err.message}` });
  }
});

app.post('/api/download', async (req, res) => {
  const url = String(req.body?.url || '').trim();
  const format = req.body?.format === 'mp3' ? 'mp3' : 'mp4';
  const quality = req.body?.quality;
  if (!url) return res.status(400).json({ error: 'Please provide a video URL.' });

  await ensureTempDir();

  let id;
  try {
    const result = await downloadVideo({ url, format, quality });
    id = result.id;

    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    res.setHeader('Content-Type', format === 'mp3' ? 'audio/mpeg' : 'video/mp4');

    const stream = createReadStream(result.filePath);
    stream.on('error', () => {
      res.status(500).end();
      cleanupFiles(id);
    });
    stream.on('end', () => cleanupFiles(id));
    stream.pipe(res);
  } catch (err) {
    res.status(500).json({ error: `Download failed: ${err.message}` });
    if (id) cleanupFiles(id);
  }
});

const server = createServer(app);
const PORT = process.env.PORT || 5000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`YouTube downloader running at http://0.0.0.0:${PORT}`);
  console.log(`yt-dlp: ${YTDLP_PATH} (${existsSync(YTDLP_PATH) ? 'ok' : 'MISSING'})`);
});