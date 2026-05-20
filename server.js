const express = require('express');
const ffmpeg = require('fluent-ffmpeg');
const fetch = require('node-fetch');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const https = require('https');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

app.get('/health', (req, res) => {
  res.json({ status: 'ok', ffmpeg: 'available', tts: 'available' });
});

async function generateTTS(text, voice, azureKey, azureRegion) {
  const langMap = {
    'ta-IN-PallaviNeural': 'ta-IN',
    'en-IN-NeerjaNeural': 'en-IN',
    'hi-IN-SwaraNeural': 'hi-IN',
    'te-IN-ShrutiNeural': 'te-IN'
  };
  const langCode = langMap[voice] || 'ta-IN';

  const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${langCode}"><voice name="${voice}"><prosody rate="0.90" pitch="-2st">${text}</prosody></voice></speak>`;

  return new Promise((resolve, reject) => {
    const options = {
      hostname: `${azureRegion}.tts.speech.microsoft.com`,
      path: '/cognitiveservices/v1',
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': azureKey,
        'Content-Type': 'application/ssml+xml',
        'X-Microsoft-OutputFormat': 'audio-16khz-128kbitrate-mono-mp3',
        'User-Agent': 'UntoldIndia/1.0',
        'Content-Length': Buffer.byteLength(ssml, 'utf8')
      }
    };

    const req = https.request(options, (res) => {
      console.log('Azure TTS status:', res.statusCode);
      console.log('Azure TTS headers:', res.headers);
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        console.log('Azure response size:', buffer.length, 'bytes');
        if (res.statusCode !== 200) {
          console.log('Azure error response:', buffer.toString());
          reject(new Error(`Azure TTS error: ${res.statusCode} - ${buffer.toString()}`));
        } else {
          resolve(buffer);
        }
      });
    });

    req.on('error', (e) => {
      console.error('Request error:', e);
      reject(e);
    });
    req.write(ssml, 'utf8');
    req.end();
  });
}

app.post('/tts', async (req, res) => {
  const { script, voice, azureKey, azureRegion } = req.body;
  console.log('TTS request - voice:', voice, 'region:', azureRegion, 'script length:', script?.length);

  try {
    const audioBuffer = await generateTTS(script, voice, azureKey, azureRegion);
    const audioBase64 = audioBuffer.toString('base64');
    console.log('TTS success - audio size:', audioBuffer.length);
    res.json({ success: true, audioBase64 });
  } catch (error) {
    console.error('TTS error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/mix', async (req, res) => {
  const { voiceBase64, bgmUrl, language } = req.body;

  try {
    const tempDir = '/tmp';
    const voiceFile = path.join(tempDir, `voice_${Date.now()}.mp3`);
    const bgmRaw = path.join(tempDir, `bgm_raw_${Date.now()}.mp4`);
    const bgmFile = path.join(tempDir, `bgm_${Date.now()}.mp3`);
    const outputFile = path.join(tempDir, `output_${Date.now()}.mp3`);

    const voiceBuffer = Buffer.from(voiceBase64, 'base64');
    fs.writeFileSync(voiceFile, voiceBuffer);

    if (bgmUrl) {
      const bgmResponse = await fetch(bgmUrl);
      const bgmBuffer = await bgmResponse.buffer();
      fs.writeFileSync(bgmRaw, bgmBuffer);

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

      if (fs.existsSync(bgmRaw)) fs.unlinkSync(bgmRaw);
      if (fs.existsSync(bgmFile)) fs.unlinkSync(bgmFile);
    } else {
      fs.copyFileSync(voiceFile, outputFile);
    }

    const outputBuffer = fs.readFileSync(outputFile);
    const outputBase64 = outputBuffer.toString('base64');

    if (fs.existsSync(voiceFile)) fs.unlinkSync(voiceFile);
    if (fs.existsSync(outputFile)) fs.unlinkSync(outputFile);

    res.json({ success: true, audioBase64: outputBase64, language });
  } catch (error) {
    console.error('Mix error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Audio mixer running on port ${PORT}`);
});
