const express = require('express');
const multer = require('multer');
const path = require('path');
const app = express();
const PORT = 3000;

app.use(express.static('public'));

// Upload klasörü ayarlanıyor
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/')
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + path.extname(file.originalname))
  }
});

const upload = multer({ storage });

// Form verilerini yakalama
app.post('/upload', upload.single('audio'), (req, res) => {
  const conversationId = req.body.conversationId;
  const text = req.body.text;
  const audioPath = req.file.path;

  console.log('Gelen veri:', { conversationId, text, audioPath });
  res.send('Yükleme başarılı!');
});

app.listen(PORT, () => {
  console.log(`Sunucu çalışıyor: http://localhost:${PORT}`);
});