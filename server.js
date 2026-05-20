const express = require('express');
const ffmpeg = require('fluent-ffmpeg');
const fetch = require('node-fetch');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

app.get('/health', (req, res) => {
  res.json({ status: 'ok', ffmpeg: 'available' });
});

app.post('/mix', async (req, res) => {
  const { voiceBase64, bgmUrl, language } = req.body;
  
  try {
    const tempDir = '/tmp';
    const voiceFile = path.join(tempDir, `voice_${Date.now()}.mp3`);
    const bgmRaw = path.join(tempDir, `bgm_raw_${Date.now()}.mp4`);
    const bgmFile = path.join(tempDir, `bgm_${Date.now()}.mp3`);
    const outputFile = path.join(tempDir, `output_${Date.now()}.mp3`);

    // Save voice audio
    const voiceBuffer = Buffer.from(voiceBase64, 'base64');
    fs.writeFileSync(voiceFile, voiceBuffer);

    if (bgmUrl) {
      // Download BGM (video file from Pixabay)
      const bgmResponse = await fetch(bgmUrl);
      const bgmBuffer = await bgmResponse.buffer();
      fs.writeFileSync(bgmRaw, bgmBuffer);

      // Extract audio from video file
      await new Promise((resolve, reject) => {
        ffmpeg(bgmRaw)
          .noVideo()
          .audioCodec('libmp3lame')
          .audioBitrate('128k')
          .output(bgmFile)
          .on('end', resolve)
          .on('error', reject)
          .run();
      });

      // Mix voice + extracted BGM audio
      await new Promise((resolve, reject) => {
        ffmpeg()
          .input(voiceFile)
          .input(bgmFile)
          .complexFilter([
            '[1:a]volume=0.15[bgm]',
            '[0:a][bgm]amix=inputs=2:duration=first:dropout_transition=3[out]'
          ])
          .outputOptions(['-map [out]', '-ac 2', '-ar 44100'])
          .audioCodec('libmp3lame')
          .audioBitrate('128k')
          .output(outputFile)
          .on('end', resolve)
          .on('error', reject)
          .run();
      });

      // Cleanup BGM temp files
      if (fs.existsSync(bgmRaw)) fs.unlinkSync(bgmRaw);
      if (fs.existsSync(bgmFile)) fs.unlinkSync(bgmFile);

    } else {
      fs.copyFileSync(voiceFile, outputFile);
    }

    const outputBuffer = fs.readFileSync(outputFile);
    const outputBase64 = outputBuffer.toString('base64');

    if (fs.existsSync(voiceFile)) fs.unlinkSync(voiceFile);
    if (fs.existsSync(outputFile)) fs.unlinkSync(outputFile);

    res.json({ 
      success: true, 
      audioBase64: outputBase64,
      language 
    });

  } catch (error) {
    console.error('Mix error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Audio mixer running on port ${PORT}`);
});
