const express = require('express');
const ffmpeg = require('fluent-ffmpeg');
const axios = require('axios');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs-extra');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

const TMP = path.join('/tmp', 'viranode');
fs.ensureDirSync(TMP);

// ── Health check ──
app.get('/', (req, res) => res.json({ status: 'ViraNode FFmpeg Server running' }));

// ── Download helper ──
async function download(url, dest) {
  const r = await axios.get(url, { responseType: 'arraybuffer', timeout: 60000 });
  await fs.writeFile(dest, r.data);
}

// ── Assemble video ──
// POST /assemble
// Body: { imageUrls: [], audioUrls: [], format: "16:9"|"9:16"|"1:1", title: "", cloudinaryUrl: "" }
app.post('/assemble', async (req, res) => {
  const jobId = uuidv4();
  const jobDir = path.join(TMP, jobId);
  await fs.ensureDir(jobDir);

  try {
    const { imageUrls = [], audioUrls = [], format = '16:9', title = 'video' } = req.body;

    // Resolve output dimensions
    const dims = {
      '16:9': { w: 1920, h: 1080 },
      '9:16': { w: 1080, h: 1920 },
      '1:1':  { w: 1080, h: 1080 }
    };
    const { w, h } = dims[format] || dims['16:9'];

    // 1 — Download images
    const imagePaths = [];
    for (let i = 0; i < imageUrls.length; i++) {
      const dest = path.join(jobDir, `img_${i}.jpg`);
      await download(imageUrls[i], dest);
      imagePaths.push(dest);
    }

    // 2 — Download audio files
    const audioPaths = [];
    for (let i = 0; i < audioUrls.length; i++) {
      const dest = path.join(jobDir, `audio_${i}.mp3`);
      await download(audioUrls[i], dest);
      audioPaths.push(dest);
    }

    // 3 — Create Ken Burns video from each image (5 sec per image)
    const clipPaths = [];
    for (let i = 0; i < imagePaths.length; i++) {
      const clipPath = path.join(jobDir, `clip_${i}.mp4`);
      await new Promise((resolve, reject) => {
        ffmpeg(imagePaths[i])
          .inputOptions(['-loop 1', '-t 5'])
          .videoFilters([
            `scale=${w * 2}:${h * 2}`,
            `zoompan=z='min(zoom+0.0015,1.5)':d=150:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${w}x${h}:fps=30`
          ])
          .outputOptions(['-c:v libx264', '-pix_fmt yuv420p', '-t 5', '-an'])
          .output(clipPath)
          .on('end', resolve)
          .on('error', reject)
          .run();
      });
      clipPaths.push(clipPath);
    }

    // 4 — Concat all video clips
    const concatList = path.join(jobDir, 'concat.txt');
    const concatContent = clipPaths.map(p => `file '${p}'`).join('\n');
    await fs.writeFile(concatList, concatContent);

    const concatVideo = path.join(jobDir, 'concat.mp4');
    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(concatList)
        .inputOptions(['-f concat', '-safe 0'])
        .outputOptions(['-c copy'])
        .output(concatVideo)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });

    // 5 — Concat all audio files
    const audioList = path.join(jobDir, 'audiolist.txt');
    const audioContent = audioPaths.map(p => `file '${p}'`).join('\n');
    await fs.writeFile(audioList, audioContent);

    const concatAudio = path.join(jobDir, 'audio.mp3');
    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(audioList)
        .inputOptions(['-f concat', '-safe 0'])
        .outputOptions(['-c copy'])
        .output(concatAudio)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });

    // 6 — Merge video + audio
    const finalPath = path.join(jobDir, `${title.replace(/\s+/g, '_')}_${format.replace(':', 'x')}.mp4`);
    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(concatVideo)
        .input(concatAudio)
        .outputOptions([
          '-c:v copy',
          '-c:a aac',
          '-shortest',
          '-movflags +faststart'
        ])
        .output(finalPath)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });

    // 7 — Return file as download
    res.download(finalPath, `${title}_${format.replace(':', 'x')}.mp4`, async () => {
      await fs.remove(jobDir);
    });

  } catch (err) {
    await fs.remove(jobDir).catch(() => {});
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ── Multi-format: generate all 3 formats at once ──
app.post('/assemble-all', async (req, res) => {
  res.json({
    message: 'Use /assemble with format: 16:9, 9:16, or 1:1',
    formats: ['16:9', '9:16', '1:1']
  });
});
// ── Concat video clips + voiceover ──
app.post('/concat', async (req, res) => {
  const jobId = uuidv4();
  const jobDir = path.join(TMP, jobId);
  await fs.ensureDir(jobDir);
  try {
    const { clipUrls = [], voiceoverUrl, videoId, userId } = req.body;
    
    // Download clips
    const clipPaths = [];
    for (let i = 0; i < clipUrls.length; i++) {
      const dest = path.join(jobDir, `scene_${String(i).padStart(3,'0')}.mp4`);
      await download(clipUrls[i], dest);
      clipPaths.push(dest);
    }
    
    // Download voiceover
    const voicePath = path.join(jobDir, 'voiceover.mp3');
    await download(voiceoverUrl, voicePath);
    
    // Concat clips
    const concatList = path.join(jobDir, 'filelist.txt');
    await fs.writeFile(concatList, clipPaths.map(p => `file '${p}'`).join('\n'));
    const concatPath = path.join(jobDir, 'concat.mp4');
    await new Promise((resolve, reject) => {
      ffmpeg().input(concatList).inputOptions(['-f concat','-safe 0'])
        .outputOptions(['-c:v libx264','-preset fast'])
        .output(concatPath).on('end', resolve).on('error', reject).run();
    });
    
    // Add voiceover
    const finalPath = path.join(jobDir, 'final_16x9.mp4');
    await new Promise((resolve, reject) => {
      ffmpeg().input(concatPath).input(voicePath)
        .outputOptions(['-c:v copy','-c:a aac','-shortest'])
        .output(finalPath).on('end', resolve).on('error', reject).run();
    });
    
    res.download(finalPath, 'final_16x9.mp4', async () => {
      await fs.remove(jobDir).catch(() => {});
    });
  } catch(err) {
    await fs.remove(jobDir).catch(() => {});
    res.status(500).json({ error: err.message });
  }
});
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`ViraNode FFmpeg Server running on port ${PORT}`));
