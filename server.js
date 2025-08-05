
// ==== Temel modüller ====
const express = require('express');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');

// ==== OpenAI ayarları ====
require('dotenv').config();
const OpenAI = require('openai');
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ==== Uygulama ====
const app  = express();
const PORT = 3000;

app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));

// ==== Dinamik upload klasörü (konuşmaID'ye göre) ====
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const idFromForm = req.body.konusmaID || req.body.konusma_id || 'genel';
    const konusmaId  = String(idFromForm || 'genel').trim() || 'genel';
    const uploadPath = path.join(__dirname, 'uploads', konusmaId);
    fs.mkdirSync(uploadPath, { recursive: true });
    cb(null, uploadPath);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '') || '.wav';
    cb(null, `${Date.now()}-recording${ext}`);
  }
});
const upload = multer({ storage });

// ==== Transkripsiyon + Analiz ====
async function transcribeAndAnalyze(audioPath, rawTextFromForm) {
  // 1) Ses -> Metin (Whisper)
  const transcription = await openai.audio.transcriptions.create({
    file: fs.createReadStream(audioPath),
    model: "whisper-1" // alternatif: "gpt-4o-mini-transcribe"
  });
  const transcriptText = transcription.text || "";

  // 2) Metin Analizi (Chat)
  const prompt = `
Aşağıdaki konuşma metnini kısa ve net analiz et:
- Duygu özeti (1-2 cümle)
- Öne çıkan sorun/tema (madde)
- Somut 2 öneri

Kullanıcı yazısı: ${rawTextFromForm || "(yok)"}
Transkript: ${transcriptText}
`;

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: "Kısa, net ve eylem odaklı analiz yap." },
      { role: "user", content: prompt }
    ],
    temperature: 0.3
  });

  const analysis = completion.choices?.[0]?.message?.content || "";
  return { transcriptText, analysis };
}

// ==== Rotalar ====

// Upload + STT + Analiz
app.post('/', upload.single('dosya'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: "Ses dosyası yok" });

    const audioPath = req.file.path;
    const rawText   = (req.body?.mesaj || "").toString();

    const { transcriptText, analysis } = await transcribeAndAnalyze(audioPath, rawText);

    // İsteğe bağlı çıktı dosyaları
    const outDir = path.dirname(audioPath);
    fs.writeFileSync(path.join(outDir, `${Date.now()}-transcript.txt`), transcriptText, 'utf8');
    fs.writeFileSync(path.join(outDir, `${Date.now()}-analysis.txt`),  analysis,    'utf8');

    res.json({
      ok: true,
      dosya: req.file.filename,
      transkript: transcriptText,
      analiz: analysis
    });
  } catch (err) {
    console.error("Hata:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ==== Sunucu ====
app.listen(PORT, () => {
  console.log(`Sunucu çalışıyor: http://localhost:${PORT}`);
});
