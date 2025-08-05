
// Temel modüller
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
require('dotenv').config();
const OpenAI = require('openai');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// ==== Redis Ayarları ====
const UP_URL = process.env.UPSTASH_REDIS_REST_URL;
const UP_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

async function redis(cmd, ...args) {
  const url = `${UP_URL}/${cmd}/${args.map(encodeURIComponent).join('/')}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${UP_TOKEN}` } });
  const data = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(data));
  return data.result;
}

const WEEK = 7 * 24 * 60 * 60; // 1 hafta saniye
const SUMMARY_TTL = 5 * 60; // özet cache: 5 dakika

function extractSpeaker(text) {
  const patterns = [
    /benim ad(?:ı|i)m\s+([A-Za-zÇĞİÖŞÜçğıöşü\-]+)/i,
    /\bad(?:ı|i)m\s+([A-Za-zÇĞİÖŞÜçğıöşü\-]+)/i,
    /\bben\s+([A-Za-zÇĞİÖŞÜçğıöşü\-]+)/i,
  ];
  for (const rx of patterns) {
    const m = (text || '').match(rx);
    if (m && m[1]) return m[1];
  }
  return 'Bilinmeyen';
}

async function addMessagePersistent(convId, rawText) {
  const msg = {
    speaker: extractSpeaker(rawText || ''),
    text: (rawText || '').trim(),
    ts: Date.now()
  };
  const key = `conv:${convId}`;
  await redis('rpush', key, JSON.stringify(msg));
  await redis('expire', key, WEEK);
  await redis('del', `${key}:summary`); // eski özeti sil
}

async function getMessages(convId) {
  const key = `conv:${convId}`;
  const arr = await redis('lrange', key, 0, -1) || [];
  return arr.map(s => {
    try { return JSON.parse(s); } catch { return null; }
  }).filter(Boolean);
}

async function getCachedSummary(convId) {
  return await redis('get', `conv:${convId}:summary`);
}
async function setCachedSummary(convId, text) {
  const key = `conv:${convId}:summary`;
  await redis('set', key, text);
  await redis('expire', key, SUMMARY_TTL);
}

// ==== Upload Ayarları ====
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadPath = path.join(__dirname, 'uploads');
    fs.mkdirSync(uploadPath, { recursive: true });
    cb(null, uploadPath);
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + path.extname(file.originalname));
  }
});
const upload = multer({ storage });

// ==== Ses dosyası yükleme ====
app.post('/upload', upload.single('audio'), async (req, res) => {
  try {
    const konusmaId = req.body.konusma_id?.trim();
    if (!konusmaId) return res.status(400).json({ error: 'konusma_id gerekli' });

    // Burada ses dosyasını OpenAI Whisper ile metne çevir
    const transcription = await openai.audio.transcriptions.create({
      model: "gpt-4o-mini-transcribe",
      file: fs.createReadStream(req.file.path)
    });

    const text = transcription.text || '';
    await addMessagePersistent(konusmaId, text);
    res.json({ ok: true, text });
  }
