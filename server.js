// ===== Temeller =====
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
require('dotenv').config();
const OpenAI = require('openai');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ---- Statik dosyalar ve ana sayfa ----
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (_req, res) => {
 res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ===== Upstash Redis (REST) =====
const UP_URL = process.env.UPSTASH_REDIS_REST_URL;
const UP_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

async function redis(cmd, ...args) {
 // Node 18+ global fetch var
 const url = `${UP_URL}/${cmd}/${args.map(encodeURIComponent).join('/')}`;
 const res = await fetch(url, { headers: { Authorization: `Bearer ${UP_TOKEN}` } });
 const data = await res.json();
 if (!res.ok) throw new Error(JSON.stringify(data));
 return data.result;
}

const WEEK = 7 * 24 * 60 * 60;   // 1 hafta (saniye)
const SUMMARY_TTL = 5 * 60;      // 5 dk cache

function extractSpeaker(text = '') {
 const patterns = [
   /benim ad(?:ı|i)m\s+([A-Za-zÇĞİÖŞÜçğıöşü\-]+)/i,
   /\bad(?:ı|i)m\s+([A-Za-zÇĞİÖŞÜçğıöşü\-]+)/i,
   /\bben\s+([A-Za-zÇĞİÖŞÜçğıöşü\-]+)/i,
 ];
 for (const rx of patterns) {
   const m = text.match(rx);
   if (m && m[1]) return m[1];
 }
 return 'Bilinmeyen';
}

async function addMessagePersistent(convId, rawText) {
 const msg = { speaker: extractSpeaker(rawText), text: (rawText || '').trim(), ts: Date.now() };
 const key = `conv:${convId}`;
 await redis('rpush', key, JSON.stringify(msg)); // listeye ekle
 await redis('expire', key, WEEK);               // her mesajda ömrü 1 haftaya yenile
 await redis('del', `${key}:summary`);           // eski özeti sil
}

async function getMessages(convId) {
 const key = `conv:${convId}`;
 const arr = await redis('lrange', key, 0, -1) || [];
 return arr.map(s => { try { return JSON.parse(s); } catch { return null; } }).filter(Boolean);
}
async function getCachedSummary(convId) {
 return await redis('get', `conv:${convId}:summary`);
}
async function setCachedSummary(convId, text) {
 const key = `conv:${convId}:summary`;
 await redis('set', key, text);
 await redis('expire', key, SUMMARY_TTL);
}

// ===== Multer (ses yükleme) =====
const storage = multer.diskStorage({
 destination: (req, _file, cb) => {
   const id = String(req.body.konusma_id || 'genel').trim();
   const uploadPath = path.join(__dirname, 'uploads', id);
   fs.mkdirSync(uploadPath, { recursive: true });
   cb(null, uploadPath);
 },
 filename: (_req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage });

// ===== Yazılı mesaj =====
app.post('/message', async (req, res) => {
 try {
   const id = String(req.body.konusma_id || '').trim();
   const text = String(req.body.text || '').trim();
   if (!id || !text) return res.status(400).json({ ok: false, error: 'konusma_id ve text gerekli' });
   await addMessagePersistent(id, text);
   res.json({ ok: true });
 } catch (e) {
   console.error(e);
   res.status(500).json({ ok: false, error: 'Mesaj kaydedilemedi' });
 }
});

// ===== Ses yükleme + transkripsiyon =====
app.post('/upload', upload.single('audio'), async (req, res) => {
 try {
   const id = String(req.body.konusma_id || '').trim();
   if (!id || !req.file?.path) return res.status(400).json({ ok: false, error: 'konusma_id veya dosya yok' });

   // OpenAI Whisper / 4o-mini-transcribe: hesapta hangisi aktifse onu kullan
   let text = '';
   try {
     const tr = await openai.audio.transcriptions.create({
       model: 'gpt-4o-mini-transcribe',   // varsa bunu kullan
       file: fs.createReadStream(req.file.path)
     });
     text = tr.text || '';
   } catch {
     const tr2 = await openai.audio.transcriptions.create({
       model: 'whisper-1',                 // yedek model
       file: fs.createReadStream(req.file.path)
     });
     text = tr2.text || '';
   }

   await addMessagePersistent(id, text);
   res.json({ ok: true, text });
 } catch (e) {
   console.error(e);
   res.status(500).json({ ok: false, error: 'Transkripsiyon hatası' });
 }
});

// ===== Analiz Et =====
app.post('/finalize', async (req, res) => {
 try {
   const id = String(req.body.konusma_id || '').trim();
   if (!id) return res.status(400).json({ ok: false, error: 'konusma_id gerekli' });

   const cached = await getCachedSummary(id);
   if (cached) return res.json({ ok: true, summary: cached, cached: true });

   const msgs = await getMessages(id);
   if (!msgs.length) return res.json({ ok: true, summary: 'Bu ID altında mesaj bulunamadı.' });

   const transcript = msgs.map(m => `${m.speaker}: ${m.text}`).join('\n');

   const systemPrompt = `
Sen bir arabulucu asistansın. Aynı konuşma ID altındaki TÜM mesajları tek bağlamda değerlendir.
- Detaylı, dengeli ve yapıcı bir analiz yaz (birkaç paragraf).
- Tarafların GÜÇLÜ (iyi) ve ZAYIF (hatalı/yanlış) yönlerini ayrı ayrı belirt.
- Ortak ve ayrışan noktaları madde madde çıkar.
- Her tarafa 2-3 maddelik uygulanabilir ÖNERİ ver.
- Sonunda "OPTİMAL ÇÖZÜM" başlığıyla, iki tarafı da kapsayan TEK bir çözüm önerisi sun.
- Kısa geçme; ama net ve okunur olsun.
`;

   const userPrompt = `Konuşma dökümü (kişiler mesaj başında adını söylüyor):\n${transcript}\n\nLütfen yukarıdaki kurallara göre TEK, detaylı bir çıktı üret.`;

   const completion = await openai.chat.completions.create({
     model: 'gpt-4o-mini',
     messages: [
       { role: 'system', content: systemPrompt },
       { role: 'user', content: userPrompt }
     ],
     temperature: 0.5
   });

   const out = completion.choices?.[0]?.message?.content?.trim() || 'Özet üretilemedi.';
   await setCachedSummary(id, out);
   res.json({ ok: true, summary: out, cached: false });
 } catch (e) {
   console.error(e);
   res.status(500).json({ ok: false, error: 'Analiz hatası' });
 }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
