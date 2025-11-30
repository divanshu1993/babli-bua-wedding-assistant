const chatEl = document.getElementById("chat");
const formEl = document.getElementById("chat-form");
const inputEl = document.getElementById("msg-input");

function addMessage(text, who) {
  const div = document.createElement("div");
  div.className = `msg ${who}`;
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.innerHTML = text;
  div.appendChild(bubble);
  chatEl.appendChild(div);
  chatEl.scrollTop = chatEl.scrollHeight;
}

formEl.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = inputEl.value.trim();
  if (!text) return;

  addMessage(text, "me");
  inputEl.value = "";
  addMessage("Typing...", "bot");
  const typingNode = chatEl.lastChild;

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text }),
    });
    const data = await res.json();
    chatEl.removeChild(typingNode);
    addMessage(data.reply || "No reply", "bot");
  } catch (err) {
    console.error(err);
    chatEl.removeChild(typingNode);
    addMessage("Error aa gaya, please phir se try karo.", "bot");
  }
});

// welcome message
addMessage("Hi 😊 main Babli Bua hoon. Mehendi, sangeet, shaadi, venue, dress code, Hotel Booking, address – kuch bhi puchho!", "bot");
