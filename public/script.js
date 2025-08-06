// script.js

const socket = new WebSocket(`wss://${location.host}`);

socket.addEventListener("open", () => {
  console.log("✅ WebSocket bağlantısı kuruldu");
});

socket.addEventListener("message", (event) => {
  const msg = JSON.parse(event.data);
  console.log("💬 Gelen:", msg);

  const msgList = document.getElementById("messages");
  const newMsg = document.createElement("li");
  newMsg.textContent = `${msg.from}: ${msg.text}`;
  msgList.appendChild(newMsg);
});

document.getElementById("sendBtn").addEventListener("click", () => {
  const textInput = document.getElementById("textInput").value;
  const nameInput = document.getElementById("nameInput").value;

  if (textInput && nameInput) {
    const msg = { text: textInput, from: nameInput };
    socket.send(JSON.stringify(msg));
    document.getElementById("textInput").value = "";
  }
});
