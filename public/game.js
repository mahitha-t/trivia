const socket = io();

// State
let playerId = null;
let isHost = false;
let myBalance = 100;

// DOM elements
const screens = document.querySelectorAll(".screen");
const errorMsg = document.getElementById("error-msg");

// Utility
function showScreen(id) {
  screens.forEach((s) => s.classList.remove("active"));
  document.getElementById(id).classList.add("active");
}

function showError(msg) {
  errorMsg.textContent = msg;
  errorMsg.classList.remove("hidden");
  setTimeout(() => errorMsg.classList.add("hidden"), 3000);
}

function showToast(msg) {
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.textContent = msg;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

function decodeHTML(html) {
  const el = document.createElement("textarea");
  el.innerHTML = html;
  return el.value;
}

// Home screen
document.getElementById("btn-join-toggle").addEventListener("click", () => {
  document.getElementById("join-section").classList.toggle("hidden");
});

document.getElementById("btn-create").addEventListener("click", () => {
  const name = document.getElementById("player-name").value.trim();
  if (!name) return showError("Enter your name");
  socket.emit("create-room", name);
});

document.getElementById("btn-join").addEventListener("click", () => {
  const name = document.getElementById("player-name").value.trim();
  const code = document.getElementById("room-code").value.trim();
  if (!name) return showError("Enter your name");
  if (!code) return showError("Enter room code");
  socket.emit("join-room", { code, name });
});

// Allow Enter key on room code input
document.getElementById("room-code").addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("btn-join").click();
});

document.getElementById("player-name").addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("btn-create").click();
});

// Lobby
document.getElementById("btn-start").addEventListener("click", () => {
  socket.emit("start-game");
});

// Betting
const betSlider = document.getElementById("bet-slider");
const betValue = document.getElementById("bet-value");

betSlider.addEventListener("input", () => {
  betValue.textContent = betSlider.value;
});

document.querySelectorAll(".bet-preset").forEach((btn) => {
  btn.addEventListener("click", () => {
    const pct = parseInt(btn.dataset.pct);
    const amount = Math.floor(myBalance * (pct / 100));
    betSlider.value = amount;
    betValue.textContent = amount;
  });
});

document.getElementById("btn-place-bet").addEventListener("click", () => {
  const bet = parseInt(betSlider.value);
  socket.emit("place-bet", bet);
  document.getElementById("btn-place-bet").disabled = true;
  document.getElementById("btn-place-bet").textContent = "Bet Locked ✓";
});

// Results
document.getElementById("btn-next").addEventListener("click", () => {
  socket.emit("next-question");
});

// Game Over
document.getElementById("btn-play-again").addEventListener("click", () => {
  socket.emit("play-again");
});

// Socket events
socket.on("error-msg", (msg) => showError(msg));

socket.on("room-created", ({ code, playerId: id }) => {
  playerId = id;
  isHost = true;
  document.getElementById("lobby-code").textContent = code;
  document.getElementById("btn-start").classList.remove("hidden");
  document.getElementById("lobby-wait").classList.add("hidden");
  showScreen("screen-lobby");
});

socket.on("room-joined", ({ code, playerId: id }) => {
  playerId = id;
  isHost = false;
  document.getElementById("lobby-code").textContent = code;
  document.getElementById("btn-start").classList.add("hidden");
  document.getElementById("lobby-wait").classList.remove("hidden");
  showScreen("screen-lobby");
});

socket.on("players-updated", (players) => {
  const container = document.getElementById("lobby-players");
  container.innerHTML = players
    .map(
      (p) => `
    <div class="player-item">
      <span class="name">${p.name}${p.isHost ? '<span class="host-badge">HOST</span>' : ""}</span>
      <span class="balance">$${p.balance}</span>
    </div>
  `
    )
    .join("");

  // Update my balance
  const me = players.find((p) => p.id === playerId);
  if (me) myBalance = me.balance;
});

socket.on("player-left", (name) => {
  showToast(`${name} left the game`);
});

socket.on("betting-phase", ({ questionNumber, totalQuestions, category, difficulty, players }) => {
  document.getElementById("bet-progress").textContent = `${questionNumber}/${totalQuestions}`;

  const diffBadge = document.getElementById("bet-difficulty");
  diffBadge.textContent = difficulty;
  diffBadge.className = `difficulty-badge ${difficulty}`;

  document.getElementById("bet-category").textContent = decodeHTML(category);
  document.getElementById("bet-balance").textContent = myBalance;
  document.getElementById("bet-status").textContent = "";

  // Reset bet controls
  const maxBet = myBalance;
  betSlider.max = maxBet;
  betSlider.value = Math.min(10, maxBet);
  betValue.textContent = betSlider.value;

  const betBtn = document.getElementById("btn-place-bet");
  betBtn.disabled = false;
  betBtn.textContent = "Lock In Bet";

  showScreen("screen-betting");
});

socket.on("bet-placed", ({ totalBets, totalPlayers }) => {
  document.getElementById("bet-status").textContent = `${totalBets}/${totalPlayers} players have bet`;
});

socket.on("answering-phase", ({ question, answers, difficulty, questionNumber, totalQuestions }) => {
  document.getElementById("answer-progress").textContent = `${questionNumber}/${totalQuestions}`;

  const diffBadge = document.getElementById("answer-difficulty");
  diffBadge.textContent = difficulty;
  diffBadge.className = `difficulty-badge ${difficulty}`;

  document.getElementById("question-text").innerHTML = decodeHTML(question);

  const grid = document.getElementById("answer-options");
  grid.innerHTML = answers
    .map(
      (a) => `
    <button class="answer-btn" data-answer="${encodeURIComponent(a)}">${decodeHTML(a)}</button>
  `
    )
    .join("");

  // Answer click handlers
  grid.querySelectorAll(".answer-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const answer = decodeURIComponent(btn.dataset.answer);
      socket.emit("submit-answer", answer);

      grid.querySelectorAll(".answer-btn").forEach((b) => {
        b.disabled = true;
        b.classList.remove("selected");
      });
      btn.classList.add("selected");
    });
  });

  document.getElementById("answer-status").textContent = "";
  showScreen("screen-answering");
});

socket.on("answer-submitted", ({ totalAnswers, totalPlayers }) => {
  document.getElementById("answer-status").textContent = `${totalAnswers}/${totalPlayers} players answered`;
});

socket.on("round-results", ({ correctAnswer, difficulty, multiplier, results, questionNumber, totalQuestions, isLastQuestion }) => {
  const correctDiv = document.getElementById("correct-answer-display");
  correctDiv.innerHTML = `
    <div class="label">Correct Answer (${difficulty} ×${multiplier})</div>
    <div class="answer">${decodeHTML(correctAnswer)}</div>
  `;

  const list = document.getElementById("results-list");
  list.innerHTML = results
    .map(
      (r) => `
    <div class="result-item ${r.correct ? "correct" : "wrong"}">
      <div class="info">
        <span class="name">${r.name}</span>
        <span class="bet-info">Bet $${r.bet} → ${r.correct ? "✓" : "✗"}</span>
      </div>
      <div style="text-align:right">
        <div class="earnings ${r.earnings >= 0 ? "positive" : "negative"}">
          ${r.earnings >= 0 ? "+" : ""}$${r.earnings}
        </div>
        <div class="new-balance">Balance: $${r.balance}</div>
      </div>
    </div>
  `
    )
    .join("");

  // Update my balance
  const me = results.find((r) => r.id === playerId);
  if (me) myBalance = me.balance;

  const nextBtn = document.getElementById("btn-next");
  if (isHost) {
    nextBtn.classList.remove("hidden");
    nextBtn.textContent = isLastQuestion ? "See Final Results" : "Next Question";
  } else {
    nextBtn.classList.add("hidden");
  }

  showScreen("screen-results");
});

socket.on("game-over", ({ standings }) => {
  const medals = ["🥇", "🥈", "🥉"];
  const list = document.getElementById("final-standings");
  list.innerHTML = standings
    .map(
      (p, i) => `
    <div class="standing-item">
      <span class="rank">${medals[i] || `#${i + 1}`}</span>
      <div class="details">
        <div class="name">${p.name}</div>
      </div>
      <span class="final-balance">$${p.balance}</span>
    </div>
  `
    )
    .join("");

  const playAgainBtn = document.getElementById("btn-play-again");
  if (isHost) {
    playAgainBtn.classList.remove("hidden");
  } else {
    playAgainBtn.classList.add("hidden");
  }

  showScreen("screen-gameover");
});

socket.on("back-to-lobby", () => {
  myBalance = 100;
  showScreen("screen-lobby");
});
