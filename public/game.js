const socket = io();

// State
let playerId = null;
let isHost = false;
let myBalance = 100;
let timerInterval = null;

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

function addActionLog(msg) {
  const log = document.getElementById("action-log");
  const entry = document.createElement("div");
  entry.className = "log-entry";
  entry.textContent = msg;
  log.prepend(entry);
  // Keep only last 5 entries
  while (log.children.length > 5) {
    log.removeChild(log.lastChild);
  }
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

// Poker actions
document.getElementById("btn-fold").addEventListener("click", () => {
  socket.emit("poker-action", { action: "fold" });
  disablePokerActions();
  document.getElementById("action-status").textContent = "You folded 🃏";
});

document.getElementById("btn-check").addEventListener("click", () => {
  socket.emit("poker-action", { action: "check" });
  disablePokerActions();
  document.getElementById("action-status").textContent = "Checked ✓";
});

document.getElementById("btn-raise").addEventListener("click", () => {
  const controls = document.getElementById("raise-controls");
  controls.classList.toggle("hidden");
});

const raiseSlider = document.getElementById("raise-slider");
const raiseValue = document.getElementById("raise-value");
raiseSlider.addEventListener("input", () => {
  raiseValue.textContent = `$${raiseSlider.value}`;
});

document.getElementById("btn-confirm-raise").addEventListener("click", () => {
  const amount = parseInt(raiseSlider.value);
  socket.emit("poker-action", { action: "raise", raiseAmount: amount });
  disablePokerActions();
  document.getElementById("action-status").textContent = `Raised $${amount} 💰`;
});

function disablePokerActions() {
  document.getElementById("btn-fold").disabled = true;
  document.getElementById("btn-check").disabled = true;
  document.getElementById("btn-raise").disabled = true;
  document.getElementById("btn-confirm-raise").disabled = true;
  document.getElementById("raise-controls").classList.add("hidden");
}

function enablePokerActions() {
  document.getElementById("btn-fold").disabled = false;
  document.getElementById("btn-check").disabled = false;
  document.getElementById("btn-raise").disabled = false;
  document.getElementById("btn-confirm-raise").disabled = false;
  document.getElementById("action-status").textContent = "";
  // Update raise slider max based on balance
  raiseSlider.max = Math.max(5, myBalance);
  raiseSlider.value = Math.min(10, myBalance);
  raiseValue.textContent = `$${raiseSlider.value}`;
}

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

  const me = players.find((p) => p.id === playerId);
  if (me) myBalance = me.balance;
});

socket.on("player-left", (name) => {
  showToast(`${name} left the game`);
});

// Reveal phases
socket.on("reveal-category", ({ questionNumber, totalQuestions, category, difficulty, pot, players }) => {
  document.getElementById("reveal-progress").textContent = `Round ${questionNumber}/${totalQuestions}`;
  document.getElementById("reveal-pot").textContent = `Pot: $${pot}`;
  document.getElementById("reveal-category-text").textContent = decodeHTML(category);

  // Reset reveal sections
  document.getElementById("reveal-category-section").classList.remove("hidden");
  document.getElementById("reveal-answers-section").classList.add("hidden");
  document.getElementById("reveal-question-section").classList.add("hidden");
  document.getElementById("action-log").innerHTML = "";

  // Update balance
  const me = players.find((p) => p.id === playerId);
  if (me) myBalance = me.balance;

  enablePokerActions();
  showScreen("screen-reveal");
});

socket.on("reveal-answers", ({ answers, pot, players }) => {
  document.getElementById("reveal-pot").textContent = `Pot: $${pot}`;
  document.getElementById("reveal-answers-section").classList.remove("hidden");
  document.getElementById("reveal-answers-list").innerHTML = answers
    .map((a) => `<div class="reveal-answer-item">${decodeHTML(a)}</div>`)
    .join("");

  const me = players.find((p) => p.id === playerId);
  if (me) myBalance = me.balance;

  enablePokerActions();
});

socket.on("reveal-question", ({ question, pot, players }) => {
  document.getElementById("reveal-pot").textContent = `Pot: $${pot}`;
  document.getElementById("reveal-question-section").classList.remove("hidden");
  document.getElementById("reveal-question-text").innerHTML = decodeHTML(question);

  const me = players.find((p) => p.id === playerId);
  if (me) myBalance = me.balance;

  enablePokerActions();
});

socket.on("player-action", ({ name, action, pot, activePlayers }) => {
  document.getElementById("reveal-pot").textContent = `Pot: $${pot}`;
  addActionLog(`${name} ${action}`);
});

socket.on("answering-phase", ({ question, answers, timeLimit, pot, activePlayers }) => {
  document.getElementById("answer-pot").textContent = `Pot: $${pot}`;
  document.getElementById("question-text").innerHTML = decodeHTML(question);

  const grid = document.getElementById("answer-options");
  grid.innerHTML = answers
    .map(
      (a) => `
    <button class="answer-btn" data-answer="${encodeURIComponent(a)}">${decodeHTML(a)}</button>
  `
    )
    .join("");

  // Check if player is active (not folded)
  const isActive = activePlayers.includes(playerId);
  if (!isActive) {
    grid.querySelectorAll(".answer-btn").forEach((btn) => {
      btn.disabled = true;
    });
    document.getElementById("answer-status").textContent = "You folded this round 🃏";
  } else {
    grid.querySelectorAll(".answer-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const answer = decodeURIComponent(btn.dataset.answer);
        socket.emit("submit-answer", answer);
        grid.querySelectorAll(".answer-btn").forEach((b) => {
          b.disabled = true;
          b.classList.remove("selected");
        });
        btn.classList.add("selected");
        document.getElementById("answer-status").textContent = "Answer locked in! ⏳";
      });
    });
    document.getElementById("answer-status").textContent = "";
  }

  // Start countdown timer
  let timeLeft = timeLimit;
  const timerEl = document.getElementById("answer-timer");
  timerEl.textContent = `${timeLeft}s`;
  timerEl.classList.remove("timer-urgent");

  if (timerInterval) clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    timeLeft--;
    timerEl.textContent = `${timeLeft}s`;
    if (timeLeft <= 5) timerEl.classList.add("timer-urgent");
    if (timeLeft <= 0) {
      clearInterval(timerInterval);
      timerEl.textContent = "⏰";
    }
  }, 1000);

  showScreen("screen-answering");
});

socket.on("answer-submitted", ({ totalAnswers, totalActive }) => {
  document.getElementById("answer-status").textContent =
    `${totalAnswers}/${totalActive} players answered`;
});

socket.on("fold-win", ({ winnerName, pot, players, questionNumber, totalQuestions, isLastQuestion }) => {
  if (timerInterval) clearInterval(timerInterval);

  document.getElementById("results-title").textContent = "Everyone Folded!";
  document.getElementById("correct-answer-display").innerHTML = `
    <div class="label">Winner by fold</div>
    <div class="answer">${winnerName} takes the pot of $${pot} 🎉</div>
  `;

  document.getElementById("results-list").innerHTML = players
    .map(
      (p) => `
    <div class="result-item">
      <div class="info"><span class="name">${p.name}</span></div>
      <div class="new-balance">$${p.balance}</div>
    </div>
  `
    )
    .join("");

  const nextBtn = document.getElementById("btn-next");
  if (isHost) {
    nextBtn.classList.remove("hidden");
    nextBtn.textContent = isLastQuestion ? "See Final Results" : "Next Round";
  } else {
    nextBtn.classList.add("hidden");
  }

  showScreen("screen-results");
});

socket.on("round-results", ({ correctAnswer, pot, winnersCount, results, questionNumber, totalQuestions, isLastQuestion }) => {
  if (timerInterval) clearInterval(timerInterval);

  document.getElementById("results-title").textContent = "Results";

  const potMsg = winnersCount > 0
    ? `${winnersCount} winner${winnersCount > 1 ? "s" : ""} split $${pot} pot (by speed!)`
    : `Nobody got it right — $${pot} lost to the house 💸`;

  document.getElementById("correct-answer-display").innerHTML = `
    <div class="label">${potMsg}</div>
    <div class="answer">${decodeHTML(correctAnswer)}</div>
  `;

  const list = document.getElementById("results-list");
  list.innerHTML = results
    .map(
      (r) => {
        let statusText = "";
        let statusClass = "";
        if (r.folded) {
          statusText = "Folded";
          statusClass = "folded";
        } else if (r.correct) {
          statusText = r.speedRank === 1 ? "⚡ Fastest!" : `#${r.speedRank} speed`;
          statusClass = "correct";
        } else if (r.answer === null) {
          statusText = "No answer (time up)";
          statusClass = "wrong";
        } else {
          statusText = "Wrong";
          statusClass = "wrong";
        }
        return `
    <div class="result-item ${statusClass}">
      <div class="info">
        <span class="name">${r.name}</span>
        <span class="bet-info">Bet $${r.bet} · ${statusText}</span>
      </div>
      <div class="new-balance">$${r.balance}</div>
    </div>
  `;
      }
    )
    .join("");

  const me = results.find((r) => r.id === playerId);
  if (me) myBalance = me.balance;

  const nextBtn = document.getElementById("btn-next");
  if (isHost) {
    nextBtn.classList.remove("hidden");
    nextBtn.textContent = isLastQuestion ? "See Final Results" : "Next Round";
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
