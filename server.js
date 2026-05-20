const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const https = require('https');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

app.get('/health', (req, res) => {
  res.json({ status: 'ok', tts: 'elevenlabs' });
});

async function generateTTS(text, voiceId, apiKey) {
  const response = await fetch('https://api.elevenlabs.io/v1/text-to-speech/' + voiceId, {
    method: 'POST',
    headers: {
      'xi-api-key': apiKey,
      'Content-Type': 'application/json',
      'Accept': 'audio/mpeg'
    },
    body: JSON.stringify({
      text: text,
      model_id: 'eleven_multilingual_v2',
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.75,
        style: 0.4,
        use_speaker_boost: true
      }
    })
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error('ElevenLabs error: ' + response.status + ' - ' + err);
  }

  const buffer = await response.buffer();
  console.log('ElevenLabs audio size:', buffer.length, 'bytes');
  return buffer;
}

async function saveToSupabase(audioBuffer, fileName, supabaseUrl, supabaseKey) {
  return new Promise((resolve, reject) => {
    const url = new URL(supabaseUrl + '/storage/v1/object/audio-files/' + fileName);
    const options = {
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: {
        'apikey': supabaseKey,
        'Authorization': 'Bearer ' + supabaseKey,
        'Content-Type': 'audio/mpeg',
        'x-upsert': 'true',
        'Content-Length': audioBuffer.length
      }
    };
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        console.log('Supabase upload status:', res.statusCode);
        resolve(res.statusCode);
      });
    });
    req.on('error', reject);
    req.write(audioBuffer);
    req.end();
  });
}

app.post('/tts', async (req, res) => {
  const { script, elevenLabsKey, voiceId } = req.body;
  console.log('TTS request - voiceId:', voiceId, 'script length:', script && script.length);
  try {
    const audioBuffer = await generateTTS(script, voiceId, elevenLabsKey);
    const audioBase64 = audioBuffer.toString('base64');
    res.json({ success: true, audioBase64 });
  } catch (error) {
    console.error('TTS error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/mix-and-save', async (req, res) => {
  const { voiceBase64, language, episodeTitle, supabaseUrl, supabaseKey } = req.body;
  console.log('Mix-and-save - language:', language);
  try {
    const tempDir = '/tmp';
    const voiceFile = path.join(tempDir, 'voice_' + Date.now() + '.mp3');
    const outputFile = path.join(tempDir, 'output_' + Date.now() + '.mp3');
    const voiceBuffer = Buffer.from(voiceBase64, 'base64');
    fs.writeFileSync(voiceFile, voiceBuffer);
    fs.copyFileSync(voiceFile, outputFile);
    const outputBuffer = fs.readFileSync(outputFile);
    const fileName = 'untold_india_' + language + '_' + Date.now() + '.mp3';
    await saveToSupabase(outputBuffer, fileName, supabaseUrl, supabaseKey);
    if (fs.existsSync(voiceFile)) fs.unlinkSync(voiceFile);
    if (fs.existsSync(outputFile)) fs.unlinkSync(outputFile);
    const publicUrl = supabaseUrl + '/storage/v1/object/public/audio-files/' + fileName;
    console.log('Saved to:', publicUrl);
    res.json({ success: true, publicUrl, fileName, language });
  } catch (error) {
    console.error('Mix-and-save error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Audio mixer running on port ' + PORT);
});
