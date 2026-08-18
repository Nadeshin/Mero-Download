import { createWriteStream, existsSync, mkdirSync, chmodSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import https from 'https';

const __dirname = dirname(fileURLToPath(import.meta.url));
const binDir = join(__dirname, '..', 'bin');
mkdirSync(binDir, { recursive: true });

const PLATFORM_BINS = {
  win32: 'yt-dlp.exe',
  linux: 'yt-dlp_linux',
  darwin: 'yt-dlp_macos',
};

const binName = PLATFORM_BINS[process.platform];
if (!binName) {
  console.error(`Unsupported platform: ${process.platform}`);
  process.exit(1);
}

const dest = join(binDir, binName);
if (existsSync(dest)) {
  console.log(`yt-dlp binary already exists: ${dest}`);
  process.exit(0);
}

const url = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${binName}`;

function download(currentUrl) {
  return new Promise((resolve, reject) => {
    https
      .get(currentUrl, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          resolve(download(res.headers.location));
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode} for ${currentUrl}`));
          return;
        }
        const file = createWriteStream(dest);
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve()));
        file.on('error', reject);
      })
      .on('error', reject);
  });
}

try {
  console.log(`Downloading ${binName}...`);
  await download(url);
  if (process.platform !== 'win32') {
    chmodSync(dest, 0o755);
  }
  console.log(`yt-dlp ready: ${dest}`);
} catch (err) {
  console.error(`Failed to download yt-dlp: ${err.message}`);
  process.exit(1);
}