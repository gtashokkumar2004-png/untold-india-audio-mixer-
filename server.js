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
  res.json({ status: 'ok', tts: 'available' });
});

async function generateTTS(text, voice, azureKey, azureRegion) {
  const langMap = {
    'ta-IN-PallaviNeural': 'ta-IN',
    'en-IN-NeerjaNeural': 'en-IN',
    'hi-IN-SwaraNeural': 'hi-IN',
    'te-IN-ShrutiNeural': 'te-IN'
  };
  const langCode = langMap[voice] || 'ta-IN';
  const ssml = '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="' + langCode + '"><voice name="' + voice + '">' + text + '</voice></speak>';

  return new Promise((resolve, reject) => {
    const options = {
      hostname: azureRegion + '.tts.speech.microsoft.com',
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
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        console.log('Azure response size:', buffer.length);
        if (res.statusCode !== 200) {
          reject(new Error('Azure TTS error: ' + res.statusCode));
        } else {
          resolve(buffer);
        }
      });
    });
    req.on('error', reject);
    req.write(ssml, 'utf8');
    req.end();
  });
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
  const { script, voice, azureKey, azureRegion } = req.body;
  try {
    const audioBuffer = await generateTTS(script, voice, azureKey, azureRegion);
    const audioBase64 = audioBuffer.toString('base64');
    res.json({ success: true, audioBase64 });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/mix-and-save', async (req, res) => {
  const { voiceBase64, language, episodeTitle, supabaseUrl, supabaseKey } = req.body;
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
    res.json({ success: true, publicUrl, fileName, language });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/mix', async (req, res) => {
  const { voiceBase64, language } = req.body;
  try {
    const voiceBuffer = Buffer.from(voiceBase64, 'base64');
    res.json({ success: true, audioBase64: voiceBuffer.toString('base64'), language });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Audio mixer running on port ' + PORT);
});
