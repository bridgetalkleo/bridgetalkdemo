// === Yazılı mesaj gönderme ===
document.getElementById('sendTextBtn').addEventListener('click', async () => {
 const konusma_id = document.getElementById('konusma_id').value.trim();
 const text = document.getElementById('textMessage').value.trim();
 if (!konusma_id || !text) {
   alert("Konuşma ID ve mesaj gerekli.");
   return;
 }
 try {
   const res = await fetch('/message', {
     method: 'POST',
     headers: { 'Content-Type': 'application/json' },
     body: JSON.stringify({ konusma_id, text })
   });
   const data = await res.json();
   if (data.ok) {
     alert("Mesaj gönderildi!");
     document.getElementById('textMessage').value = "";
   } else {
     alert("Hata: " + data.error);
   }
 } catch (err) {
   alert("Hata: " + err.message);
 }
});

// === Ses kaydı ===
let mediaRecorder;
let audioChunks = [];

document.getElementById('startRecBtn').addEventListener('click', async () => {
 const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
 mediaRecorder = new MediaRecorder(stream);
 audioChunks = [];

 mediaRecorder.addEventListener('dataavailable', event => {
   audioChunks.push(event.data);
 });

 mediaRecorder.addEventListener('stop', async () => {
   const konusma_id = document.getElementById('konusma_id').value.trim();
   if (!konusma_id) {
     alert("Konuşma ID gerekli.");
     return;
   }
   const blob = new Blob(audioChunks, { type: 'audio/webm' });
   const formData = new FormData();
   formData.append('audio', blob, 'recording.webm');
   formData.append('konusma_id', konusma_id);

   try {
     const res = await fetch('/upload', { method: 'POST', body: formData });
     const data = await res.json();
     if (data.ok) {
       alert("Ses yüklendi: " + data.text);
     } else {
       alert("Hata: " + data.error);
     }
   } catch (err) {
     alert("Hata: " + err.message);
   }
 });

 mediaRecorder.start();
 document.getElementById('startRecBtn').disabled = true;
 document.getElementById('stopRecBtn').disabled = false;
});

document.getElementById('stopRecBtn').addEventListener('click', () => {
 mediaRecorder.stop();
 document.getElementById('startRecBtn').disabled = false;
 document.getElementById('stopRecBtn').disabled = true;
});

// === Analiz Et ===
document.getElementById('analyzeBtn').addEventListener('click', async () => {
 const convId = document.getElementById('analysisConvId').value.trim();
 if (!convId) {
   alert("Lütfen konuşma ID girin.");
   return;
 }

 document.getElementById('analysisResult').textContent = "Analiz yapılıyor...";

 try {
   const res = await fetch('/finalize', {
     method: 'POST',
     headers: { 'Content-Type': 'application/json' },
     body: JSON.stringify({ konusma_id: convId })
   });

   const data = await res.json();
   if (data.ok) {
     document.getElementById('analysisResult').textContent = data.summary;
   } else {
     document.getElementById('analysisResult').textContent = "Analiz yapılamadı: " + (data.error || "Bilinmeyen hata");
   }
 } catch (err) {
   document.getElementById('analysisResult').textContent = "Hata: " + err.message;
 }
});
