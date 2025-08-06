import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import { randomUUID } from "crypto";
import fetch from "node-fetch";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = process.env.PORT || 3000;

// In-memory store
const conversations = new Map();
const participants = new Map();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// REST Endpoints
app.post("/api/create-conversation", (req, res) => {
  const id = randomUUID();
  conversations.set(id, {
    id,
    topic: "",
    parties: [],
    messages: [],
    claims: [],
    createdAt: Date.now(),
    domain: null
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

app.get("/join/:conversationId", (req, res) => {
  const cid = req.params.conversationId;
  if (!conversations.has(cid)) return res.status(404).send("Not found");
  res.send(`<html><body><p>Konuşma ID: <b>${cid}</b></p><a href="/">Ana sayfaya dön</a></body></html>`);
});

// Socket
io.on("connection", (socket) => {
  socket.on("joinRoom", ({ conversationId, participantId }) => {
    const p = participants.get(participantId);
    if (!p || p.conversationId !== conversationId) return;
    socket.join(conversationId);
    socket.data = { conversationId, participantId };

    const conv = conversations.get(conversationId);

    if (conv.messages.filter(m => m.authorId === participantId).length === 0) {
      io.to(socket.id).emit("aiMessage", {
        to: participantId,
        visibleTo: "authorOnly",
        text: "Hoş geldin! Konuyu serbestçe anlat; anlamak için net sorular soracağım."
      });
    }

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

    if (!conv.domain) {
      conv.domain = await detectDomain(getRecentPlainText(conv, 16));
    }

    extractClaims(conv, participantId, text);

    const mode = conv.parties.length >= 2 ? "mediator" : "greeter";
    const ai = await runAI(conv, mode, participantId);

    const aiMsg = mkMsg(conversationId, "AI", "ai", ai.privateToSender, "authorOnly");
    conv.messages.push(aiMsg);
    io.to(socket.id).emit("aiMessage", { to: participantId, visibleTo: "authorOnly", text: ai.privateToSender });

    if (ai.sharedToBoth) {
      const bcast = mkMsg(conversationId, "AI", "ai", ai.sharedToBoth, "both");
      conv.messages.push(bcast);
      io.to(conversationId).emit("aiBroadcast", { text: ai.sharedToBoth });
    }
  });
});

// Helpers
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

async function detectDomain(context) {
  const t = context.toLowerCase();
  if (/(nafaka|boşanma|evlilik|eşim|çocu(k|ğ)|velayet|aile mahkemesi)/.test(t)) return "Family/Relationship";
  if (/(alacak|veresiye|borç|icra|senet|sözleşme|ticari|dava)/.test(t)) return "Contract/Debt Dispute";
  if (/(iş|ekip|performans|yönetici|startup|müşteri|ürün|pazarlama)/.test(t)) return "Business/Workplace";
  if (/(okul|öğretmen|ödev|sınav)/.test(t)) return "Education";
  if (/(sağlık|ilaç|tedavi|semptom|teşhis)/.test(t)) return "Health";
  return "General";
}

function makeSystemPrompt(domain, mode) {
  const base = `
Sen bir **${domain}** uzmanısın. Konu neyse, onu disiplinli ve pratik bir çerçevede analiz edersin.
Tarafsızsın, kanıt-temelli ilerlersin, gereksiz empati yok.
Kısa, net, madde madde yazmayı tercih et.
Varsayım yerine soru sor, yanlış anlamayı hızla düzelt.
`;

  const greeter = `
HEDEF: Kullanıcının anlattığı olayı hızla anlamak ve açık yerleri doldurmak.
- 3–5 net soru sor.
- Zaman çizelgesi, taraflar, beklenti, kısıtlar, kanıt/mesaj dökümleri.
`;

  const mediator = `
HEDEF: İki tarafı aynı odada, çapraz-referansla derinleştirmek.
- 2–3 başlıkta özet çıkar.
- 3–6 soru sor; en az iki soru diğer tarafın ifadesine nötr referans içersin.
- Mini özet veya öneri sun.
`;

  return base + (mode === "greeter" ? greeter : mediator);
}

async function runAI(conv, mode, currentPartyId) {
  const history = getRecentPlainText(conv, 40);
  const system = makeSystemPrompt(conv.domain || "General", mode);

  const otherPartyId = (conv.parties.find(p => p.id !== currentPartyId) || {}).id;
  const otherClaims = otherPartyId
    ? conv.claims.filter(c => c.partyId === otherPartyId).slice(-6).map(c => `• "${c.text}"`)
    : [];

  const userPrompt = `
Kişiye özel görünüm için son konuşma:
${history}

Diğer tarafın son iddia/ifade özetleri:
${otherClaims.length ? otherClaims.join("\n") : "—"}

Görev: Sistem talimatına uygun çıktı üret.
`;

  const text = await callLLM(system, userPrompt);

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

// OpenAI API entegrasyonu
async function callLLM(system, user) {
  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ],
      temperature: 0.2
    })
  });
  const data = await resp.json();
  return data.choices?.[0]?.message?.content?.trim() || "Yanıt alınamadı.";
}

server.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
