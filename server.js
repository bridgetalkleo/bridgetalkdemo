import express from "express";
import { WebSocketServer } from "ws";
import { createServer } from "http";
import dotenv from "dotenv";
import cors from "cors";
import fetch from "node-fetch"; // Render için fetch paketi

dotenv.config();

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

app.use(cors());
app.use(express.static("public"));
app.use(express.json());

const PORT = process.env.PORT || 10000;

wss.on("connection", (ws) => {
  console.log("🔗 Yeni WebSocket bağlantısı kuruldu");

  ws.on("message", async (data) => {
    try {
      const message = JSON.parse(data.toString());
      console.log("📩 Gelen mesaj:", message);

      // Burada OpenAI veya başka işlem yapılabilir
      const yanit = {
        from: "AI",
        text: `Mesaj alındı: ${message.text}`
      };

      ws.send(JSON.stringify(yanit));
    } catch (err) {
      console.error("❌ Hatalı mesaj formatı:", err);
    }
  });

  ws.send(JSON.stringify({ from: "AI", text: "Bağlantı kuruldu, mesaj bekliyorum..." }));
});

server.listen(PORT, () => {
  console.log(`✅ Sunucu çalışıyor: http://localhost:${PORT}`);
});
