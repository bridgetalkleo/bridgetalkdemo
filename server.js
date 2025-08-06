// server.js
import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import { randomUUID } from "crypto";
import path from "path";
import { fileURLToPath } from "url";

// ==== Basit ayarlar ====
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = process.env.PORT || 3000;

// ==== In-memory store ====
const conversations = new Map(); // id -> { topic, parties, messages: [], claims: [], createdAt, domain }
const participants = new Map();  // pid -> { name, conversationId }

// ==== App/Server/Socket ====
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// ========== MODELLER ==========
/*
Message {
  id, conversationId, authorId, role: "user"|"ai"|"system",
  text, createdAt, visibleTo: "authorOnly"|"both"
}
Claim {
  id, conversationId, partyId, text, tags:[], confidence, createdAt
}
*/

// ========== REST ENDPOINTS ==========
app.post("/api/create-conversation", (req, res) => {
  const id = randomUUID();
  conversations.set(id, {
    id,
    topic: "",
    parties: [],
    messages: [],
    claims: [],
    createdAt: Date.now(),
    domain: null // henüz bilinmiyor; ilk kullanıcı mesajlarından tespit
  });
  res.json({ conversationId: id, inviteUrl: `/join/${id}` });
});

app.post("/api/join", (req, res) => {
  const { conversationId, displayName } = req.body || {};
  if (!conversations.has(conversationId)) return res.status(404).json({ error: "not found" });
  const pid = randomUUID();
  participants.set(pid, { name: displayName || "Anon", conversationId });
  const conv = conversations.get(conversationId);
  if (!conv.parties.find(p => p.id === pid)) conv.parties.push({ id: pid, name: displayName || "Anon" });
  res.json({ participantId: pid });
});

// Basit “join” sayfası (opsiyonel)
app.get("/join/:conversationId", (req, res) => {
  const cid = req.params.conversationId;
  if (!conversations.has(cid)) return res.status(404).send("Not found");
  res.send(`<html><body><p>Konuşma ID: <b>${cid}</b></p><a href="/">Ana sayfaya dön</a></body></html>`);
});

// ========== SOCKET ==========
io.on("connection", (socket) => {
  socket.on("joinRoom", ({ conversationId, participantId }) => {
    const p = participants.get(participantId);
    if (!p || p.conversationId !== conversationId) return;
    socket.join(conversationId);
    socket.data = { conversationId, participantId };

    const conv = conversations.get(conversationId);

    // İlk giren kişiye selam
    const userMsgs = conv.messages.filter(m => m.authorId === participantId);
    if (userMsgs.length === 0) {
      io.to(socket.id).emit("aiMessage", {
        to: participantId,
        visibleTo: "authorOnly",
        text: "Hoş geldin! Konuyu serbestçe anlat; anlamak için net sorular soracağım."
      });
    }

    // İki kişi olduysa ortak bildirim
    if (conv.parties.length >= 2) {
      const note = mkMsg(conversationId, "AI", "ai",
        "Bilgi: Odaya en az iki kişi bağlandı. Tarafsız ilerleyeceğim; bir tarafın söylediğini diğer tarafa nötr dille referanslayacağım.",
        "both"
      );
      conv.messages.push(note);
      io.to(conversationId).emit("aiBroadcast", { text: note.text });
    }
  });

  socket.on("userMessage", async ({ text }) => {
    const { conversationId, participantId } = socket.data || {};
    if (!conversationId || !participantId) return;

    const conv = conversations.get(conversationId);
    const msg = mkMsg(conversationId, participantId, "user", text, "authorOnly");
    conv.messages.push(msg);
    io.to(socket.id).emit("userEcho", msg);

    // --- Domain tespiti (ilk güçlü kullanıcı mesajlarından sonra) ---
    if (!conv.domain) {
      conv.domain = await detectDomain(getRecentPlainText(conv, 16)); // son 16 satır
    }

    // --- Claim çıkar (çok basit mock; sonra LLM function-calling ile zenginleştiririz) ---
    extractClaims(conv, participantId, text);

    // --- Mod seçimi ---
    const mode = conv.parties.length >= 2 ? "mediator" : "greeter";

    // --- AI çalıştır ---
    const ai = await runAI(conv, mode, participantId);

    // kişiye özel yanıt
    const aiMsg = mkMsg(conversationId, "AI", "ai", ai.privateToSender, "authorOnly");
    conv.messages.push(aiMsg);
    io.to(socket.id).emit("aiMessage", { to: participantId, visibleTo: "authorOnly", text: ai.privateToSender });

    // ortak yayın varsa
    if (ai.sharedToBoth) {
      const bcast = mkMsg(conversationId, "AI", "ai", ai.sharedToBoth, "both");
      conv.messages.push(bcast);
      io.to(conversationId).emit("aiBroadcast", { text: ai.sharedToBoth });
    }
  });
});

// ========== Yardımcılar ==========
function mkMsg(conversationId, authorId, role, text, visibleTo) {
  return { id: randomUUID(), conversationId, authorId, role, text, createdAt: Date.now(), visibleTo };
}

function getRecentPlainText(conv, n = 20) {
  return conv.messages.slice(-n).map(m => {
    const who =
      m.authorId === "AI" ? "AI" :
      (participants.get(m.authorId)?.name || "Kullanıcı");
    return `${who}: ${m.text}`;
  }).join("\n");
}

function extractClaims(conv, partyId, text) {
  const parts = text.split(/[.!?]\s+/).map(s => s.trim()).filter(Boolean);
  parts.forEach(s => conv.claims.push({
    id: randomUUID(),
    conversationId: conv.id,
    partyId,
    text: s,
    tags: [],
    confidence: "med",
    createdAt: Date.now()
  }));
}

// ========== Domain tespiti + Dinamik Prompt ==========
async function detectDomain(context) {
  // Basit heuristic (offline). İstersen direkt LLM’e sor: await callLLM(DOMAIN_PROMPT, ...)
  const t = context.toLowerCase();
  if (/(nafaka|boşanma|evlilik|eşim|çocu(k|ğ)|velayet|aile mahkemesi)/.test(t)) return "Family/Relationship";
  if (/(alacak|veresiye|borç|icra|senet|sözleşme|ticari|dava)/.test(t)) return "Contract/Debt Dispute";
  if (/(iş|ekip|performans|yönetici|startup|müşteri|ürün|pazarlama)/.test(t)) return "Business/Workplace";
  if (/(okul|öğretmen|ödev|sınav)/.test(t)) return "Education";
  if (/(sağlık|ilaç|tedavi|semptom|teşhis)/.test(t)) return "Health";
  // default
  return "General";
}

function makeSystemPrompt(domain, mode) {
  // Uzman persona + mod
  const base = `
Sen bir **${domain}** uzmanısın. Konu neyse, onu **disiplinli ve pratik** bir çerçevede analiz edersin.
Tarafsızsın, kanıt-temelli ilerlersin, gereksiz empati veya süs yok.
Kısa, net, madde madde yazmayı tercih et.
Varsayım yerine soru sor, yanlış anlamayı hızla düzelt.
Gerektiğinde sınırlı-hukuki/medikal uyarıları kısaca belirt.
`;

  const greeter = `
HEDEF: Kullanıcının anlattığı olayı hızla anlamak ve açık yerleri doldurmak.
YÖNTEM:
- 3–5 soru sor (ama gerçekten konuyu açan sorular olsun).
- Zaman çizelgesi, taraflar, beklenti, kısıtlar, kanıt/mesaj dökümleri.
- Eğer kullanıcı WhatsApp gibi bir kayıt göndermişse: zaman damgası, söylem/niyet, tutarlılık, tetikleyici olaylar, tekrar eden kalıplar.
- Soruların "uzman" çerçevesini yansıtsın (örn. Family/Relationship ise iletişim örüntüleri; Contract/Debt ise sözleşme/kanıt).
ÇIKTI BİÇİMİ: 
- Kısa başlık: "Netleştirme Soruları"
- 3–5 madde soru.
`;

  const mediator = `
HEDEF: İki tarafı aynı odada, çapraz-referansla derinleştirmek.
YÖNTEM:
- “Anladığım başlıklar”ı 2–3 maddede çıkar.
- 3–6 soru sor; en az iki soru diğer tarafın ifadesine **nötr referans** içersin (“X şöyle dedi; senin açından doğruluk/bağlam?”).
- Kısa “ara özet” veya “mini mutabakat” öner.
- Denge, netlik, kanıt ve eylem adımlarına odaklan.
ÇIKTI BİÇİMİ:
- Başlıklar
- Sorular
- (İsteğe bağlı) Mini özet/öneri
`;

  return base + (mode === "greeter" ? greeter : mediator);
}

// ========== AI Koşumu ==========
async function runAI(conv, mode, currentPartyId) {
  const history = getRecentPlainText(conv, 40);
  const system = makeSystemPrompt(conv.domain || "General", mode);

  // Diğer taraftan son iddialar (çapraz referans)
  const otherPartyId = (conv.parties.find(p => p.id !== currentPartyId) || {}).id;
  const otherClaims = otherPartyId
    ? conv.claims.filter(c => c.partyId === otherPartyId).slice(-6).map(c => `• "${c.text}"`)
    : [];

  const userPrompt =
`Kişiye özel görünüm için son konuşma:
${history}

Diğer tarafın son iddia/ifade özetleri:
${otherClaims.length ? otherClaims.join("\n") : "—"}

Görev: Sistem talimatına uygun çıktı üret.`;

  const text = await callLLM(system, userPrompt);

  // Ortak yayın (ara sıra ya da butonla tetiklenebilir)
  const shared = (mode === "mediator" && Math.random() < 0.25)
    ? await createSharedSummary(conv)
    : null;

  return { privateToSender: text, sharedToBoth: shared };
}

async function createSharedSummary(conv) {
  const history = getRecentPlainText(conv, 20);
  const sys = `Sen ${conv.domain || "General"} alanında uzmansın. Tarafsız kısa bir ARA ÖZET yaz. 5 maddeyi geçme. Sonuna 2 somut “bir sonraki adım” ekle.`;
  const usr = `Son mesajlar:\n${history}\n\nKısa ara özet + 2 sonraki adım:`;
  return await callLLM(sys, usr);
}

// ========== LLM Entegrasyonu (placeholder) ==========
async function callLLM(system, user) {
  // Buraya OpenAI veya kullandığın sağlayıcıyı ekle.
  // Örn: OpenAI Responses API ile:
  //
  // const resp = await fetch("https://api.openai.com/v1/chat/completions", {
  //   method: "POST",
  //   headers: {
  //     "Content-Type": "application/json",
  //     "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`
  //   },
  //   body: JSON.stringify({
  //     model: "gpt-4o-mini",
  //     messages: [
  //       { role: "system", content: system },
  //       { role: "user", content: user }
  //     ],
  //     temperature: 0.2
  //   })
  // });
  // const data = await resp.json();
  // return data.choices?.[0]?.message?.content?.trim() || "…";
  //
  // Şimdilik mock döndürelim:
  if (system.includes("greeter")) {
    return [
      "Netleştirme Soruları:",
      "1) Ana hedefin ne? Bu konuşma sonunda ne değişmiş olsun istiyorsun?",
      "2) Kimler dahil (isim/rol) ve aranızdaki ilişki?",
      "3) Kritik olayların kısa zaman çizelgesini yazar mısın?",
      "4) Elinde mesaj/e-posta/WhatsApp kaydı var mı? (Tarih ve içerik kısaca)",
      "5) Kısıtlar (zaman, finans, çocuk vb.) ve kabul edilebilir en düşük çözüm?"
    ].join("\n");
  }
  return [
    "Başlıklar:",
    "• Beklentilerde fark ve iletişimde gerilim",
    "• Birkaç kritik olay ve algı farklılığı",
    "",
    "Sorular:",
    "1) Diğer taraf “X gününde konuşuldu ama sonuç yok” dedi; o gün senin açından ne oldu?",
    "2) “Güven/şeffaflık” vurgusu var; bunun sende karşılığı ne? Somut örnek verir misin?",
    "3) Kısa vadeli 1–2 uygulanabilir adım önerin nedir?",
    "4) İdeal sonuç için olmazsa olmazın ve esneyebileceğin yer?",
    "5) Yanlış anlaşıldığını düşündüğün bir örneği zaman damgasıyla yazabilir misin?",
    "",
    "İstersen kısa bir ortak özet çıkarabilirim."
  ].join("\n");
}

server.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
