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
  res.json({ status: 'ok', tts: 'google-wavenet-v2' });
});

async function getGoogleToken(serviceAccount) {
  const jwt = require('jsonwebtoken');
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: serviceAccount.client_email,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  };
  const token = jwt.sign(payload, serviceAccount.private_key, { algorithm: 'RS256' });
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + token
  });
  const data = await response.json();
  return data.access_token;
}

function addSSMLPauses(text) {
  return text
    .replace(/\.\.\./g, '<break time="900ms"/>')
    .replace(/\. /g, '.<break time="600ms"/> ')
    .replace(/\.\n/g, '.<break time="700ms"/>\n')
    .replace(/\? /g, '?<break time="600ms"/> ')
    .replace(/! /g, '!<break time="500ms"/> ')
    .replace(/,/g, ',<break time="250ms"/>');
}

async function generateTTS(text, language, accessToken) {
  const voiceMap = {
    tamil:   { languageCode: 'ta-IN', name: 'ta-IN-Wavenet-A',   ssmlGender: 'FEMALE' },
    english: { languageCode: 'en-IN', name: 'en-IN-Wavenet-D',   ssmlGender: 'FEMALE' },
    hindi:   { languageCode: 'hi-IN', name: 'hi-IN-Wavenet-A',   ssmlGender: 'FEMALE' },
    telugu:  { languageCode: 'te-IN', name: 'te-IN-Standard-D',  ssmlGender: 'FEMALE' }
  };

  const voice = voiceMap[language] || voiceMap.tamil;
  const processedText = addSSMLPauses(text);

  const ssml = `<speak>${processedText}</speak>`;

  const response = await fetch('https://texttospeech.googleapis.com/v1/text:synthesize', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + accessToken,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      input: { ssml: ssml },
      voice: voice,
      audioConfig: {
        audioEncoding: 'MP3',
        speakingRate: 0.85,
        pitch: 0.0,
        effectsProfileId: ['headphone-class-device']
      }
    })
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error('Google TTS error: ' + JSON.stringify(data));
  }
  return Buffer.from(data.audioContent, 'base64');
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

const SERVICE_ACCOUNT = {
  "client_email": "untold-india-tts@gen-lang-client-0646791504.iam.gserviceaccount.com",
  "private_key": "-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDZmoG/0orBsSWD\nynihSjSLeqVG9UZWU8MyzXdxjL3I5vOiKNPprsWIfnzSMnXbXa+Sfc1IfKBvBe/B\nbFqcbJWzoz7+0mCR5VsTgYtaC9jXe5IkElW8qThSSRb5hdhFslDgd3ukTPaImRsI\n582VGMegKS9MN54QwWZziaBLvPWb6eSHhEbLCnLzI2/WJ03v9o/tcW6VIm5aAoTf\nKqmNv6pwhNC1T+z+zz7y/FK7XkbP9T/hvVrb11BiO+VN9FuuWmxAD+QpDzELH6ks\ndBp2PNheuatD7cNqQo1beRBn5RjykYUpIdpo76rl8yPN/uva89U3h2U88jxp2X9V\nSlIXNGL/AgMBAAECggEAAdy6o4gvu87m3UmVcGmjBFaPgK30riRzFTNcX8AcTolE\nljXSqnInmFMoOAVvGepaepWaviPHeEcxlcnj4lbRRJW4NJRbLqR0IIJSch6L1fMc\nfVjS0nETuOLWq8f+4YnQRISl0oS08/t0l3zrNujczsXLdPhhc1hmpqAwUiNS/Htw\nL+dsJVoqDmjumF24sS6J+yrE6UbhC8v4Vx2AFXZT3Z8TnZtIcVg+QcuYFrqxZjtt\n506bROk9dlePc79KeEPWVvFY2FFSwRqs1rPGt3rR8Gd2znMtbI/v4d2Q+wxpF/O8\nb4/iv1wzEKwBUbwGpVaG26wFKOGVtMP/0+YjiWlIkQKBgQDtEkpD8ylJAMlMkX6D\nomyAmIEGy5/gj/Htbu9yqdav8cy6N/hgOU4bwjS0VkRkGYrZ5s8LIOZ0kzwqtvne\nFxcpVmzMpyu9oAWYS4iu7cBGAqEKxJKWXlGxEDHqm1xu4MqRO5JHVaZ20K/Fu7aT\nkH8cp7BEHYCdjUWU9cQujdgWNQKBgQDq+kuYEq85mE65bsS8uAvPsbYTQjzEH6xf\nQb8qlVgi0NcVQ8+jLUK4oDhZIO4CHGlLCjeZ5PZLw1ER5Bq73rgYkFEovpV/Fz7/\nr/65uqVlMyiBoQKNildsOrTUZtQ9I8liUQyhHOU+YRDm3Nn4/RuPQsHA265BU4Sl\nsS10d6Qq4wKBgAXs3RpRq4h9koptYIIdvyR/q0nmMPrF3kAW87kj8Y+4NWu6FmUh\nSYh8FCElvtPZp5TGpgobKmdjfq96n0gjv5py5IlA7GDy7PDfgm0M2C9nxWqlexxz\nAwuv4e+BLpA+4hE7Me7Cf0Sc9qe0h12s0OCAeHFbY2mMrF6KvfqD5RC5AoGBALJ/\nIB2NU/50bJkARAL37EEBxkYq8u4pAU/7KbS3bhREgJ5uvLRAFYcabrOGCEciPfn6\n8PG+tDopTNRCaux762z9dCl3XSkGB51DnESKPEn76rFOFhpfFLnqfqM62c73+Grv\nFqDsylfwdF5rNkmmO+E/3N8cAest/n2/ccAfgl3xAoGBAMlw4KXvxvpDG9bI1b37\nxPhjImRztDMJVvX9F03qXRReTOpontr1lEgMaDrDqAvfxJuprRC4M7dqRCiwblfe\nKubLdvwrhsyZajqvbue5PQZ9NVfWsKruLCU0A4zaivvn0JPeLXD23sYCL2++Byvu\nAG6mNvYPngpZ1i6XY6igC/uf\n-----END PRIVATE KEY-----\n"
};

app.post('/tts', async (req, res) => {
  const { script, language } = req.body;
  console.log('TTS request - language:', language, 'length:', script && script.length);
  try {
    const accessToken = await getGoogleToken(SERVICE_ACCOUNT);
    const audioBuffer = await generateTTS(script, language || 'tamil', accessToken);
    const audioBase64 = audioBuffer.toString('base64');
    console.log('Google TTS success - size:', audioBuffer.length);
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
