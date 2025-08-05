// Temel modüller
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
require('dotenv').config();
const OpenAI = require('openai');
const Redis = require('ioredis');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const redis = new Redis(process.env.UPSTASH_REDIS_REST_URL, {
 password: process.env.UPSTASH_REDIS_REST_TOKEN,
 tls: {}
});

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static('public'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Dinamik upload klasörü
const storage = multer.diskStorage({
 destination: (req, file, cb) => {
   const konusmaId = req.body.konusma_id || 'genel';
   const uploadPath = path.join(__dirname, 'uploads', konusmaId);
   fs.mkdirSync(uploadPath, { recursive: true });
   cb(null, uploadPath);
 },
 filename: (req, file, cb) => {
   cb(null, Date.now() + path.extname(file.originalname));
 }
});
const upload = multer({ storage });

// Yazılı mesaj endpoint
app.post('/message', async (req, res) => {
 const { konusma_id, text } = req.body;
 if (!konusma_id || !text) return res.json({ ok: false, error: 'Eksik veri' });

 const key = `conv:${konusma_id}`;
 await redis.rpush(key, `Text: ${text}`);
 await redis.expire(key, 60 * 60 * 24 * 7); // 1 hafta sakla

 res.json({ ok: true });
});

// Ses yükleme endpoint
app.post('/upload', upload.single('audio'), async (req, res) => {
 const konusma_id = req.body.konusma_id;
 if (!konusma_id) return res.json({ ok: false, error: 'Konuşma ID eksik' });

 const filePath = req.file.path;
 const transcription = await openai.audio.transcriptions.create({
   file: fs.createReadStream(filePath),
   model: 'whisper-1'
 });

 const key = `conv:${konusma_id}`;
 await redis.rpush(key, `Audio: ${transcription.text}`);
 await redis.expire(key, 60 * 60 * 24 * 7);

 res.json({ ok: true, text: transcription.text });
});

// Analiz endpoint
app.post('/finalize', async (req, res) => {
 const { konusma_id } = req.body;
 if (!konusma_id) return res.json({ ok: false, error: 'Konuşma ID eksik' });

 const cacheKey = `analysis:${konusma_id}`;
 const cached = await redis.get(cacheKey);
 if (cached) return res.json({ ok: true, summary: cached, cached: true });

 const key = `conv:${konusma_id}`;
 const messages = await redis.lrange(key, 0, -1);
 if (!messages.length) return res.json({ ok: false, error: 'Mesaj yok' });

 const prompt = `
Aşağıda birden fazla kişinin konuşması var.
Her mesaj "Ben [isim]" ile başlıyor.
Bu konuşmayı analiz et:
- Kim hangi noktada doğru?
- Kim hangi noktada yanlış?
- Hangi tavır daha yapıcı?
- Optimal çözüm önerisi ver.
- Kısa değil, detaylı anlat.
Konuşmalar:
${messages.join("\n")}
 `;

 const aiRes = await openai.chat.completions.create({
   model: "gpt-4o-mini",
   messages: [{ role: "user", content: prompt }]
 });

 const summary = aiRes.choices[0].message.content;
 await redis.set(cacheKey, summary, 'EX', 60 * 5); // 5 dakika cache

 res.json({ ok: true, summary });
});

app.listen(PORT, () => console.log(`Server çalışıyor: ${PORT}`));
