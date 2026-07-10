const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

// Game state
const rooms = new Map();

function createRoom(code) {
  return {
    code,
    players: new Map(),
    state: "lobby", // lobby, reveal-category, reveal-answers, reveal-question, answering, results, gameover
    currentQuestion: null,
    questionIndex: 0,
    totalQuestions: 10,
    bets: new Map(), // playerId -> { amount, folded }
    answers: new Map(), // playerId -> { answer, timestamp }
    hostId: null,
    questions: [],
    answerDeadline: null, // timestamp when answering ends
  };
}

function generateRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 4; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

async function fetchQuestions(amount = 10) {
  const response = await fetch(
    `https://opentdb.com/api.php?amount=${amount}&difficulty=medium&type=multiple`
  );
  const data = await response.json();
  if (data.response_code !== 0) {
    throw new Error("Failed to fetch questions from API");
  }
  return data.results.map((q) => ({
    category: q.category,
    difficulty: q.difficulty,
    question: q.question,
    correctAnswer: q.correct_answer,
    answers: shuffle([q.correct_answer, ...q.incorrect_answers]),
  }));
}

function shuffle(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function getPlayersData(room) {
  const players = [];
  for (const [id, player] of room.players) {
    players.push({
      id,
      name: player.name,
      balance: player.balance,
      isHost: id === room.hostId,
    });
  }
  return players.sort((a, b) => b.balance - a.balance);
}

function getActivePlayers(room) {
  // Players who haven't folded
  const active = [];
  for (const [id, player] of room.players) {
    const betInfo = room.bets.get(id);
    if (!betInfo || !betInfo.folded) {
      active.push(id);
    }
  }
  return active;
}

function getPot(room) {
  let pot = 0;
  for (const [id, betInfo] of room.bets) {
    pot += betInfo.amount;
  }
  return pot;
}

const ANTE = 5; // forced ante each round
const ANSWER_TIME_LIMIT = 20; // seconds

io.on("connection", (socket) => {
  let currentRoom = null;
  let playerName = null;

  socket.on("create-room", (name) => {
    const code = generateRoomCode();
    const room = createRoom(code);
    room.hostId = socket.id;
    room.players.set(socket.id, { name, balance: 100 });
    rooms.set(code, room);
    currentRoom = code;
    playerName = name;
    socket.join(code);
    socket.emit("room-created", { code, playerId: socket.id });
    io.to(code).emit("players-updated", getPlayersData(room));
  });

  socket.on("join-room", ({ code, name }) => {
    const room = rooms.get(code.toUpperCase());
    if (!room) {
      socket.emit("error-msg", "Room not found");
      return;
    }
    if (room.state !== "lobby") {
      socket.emit("error-msg", "Game already in progress");
      return;
    }
    room.players.set(socket.id, { name, balance: 100 });
    currentRoom = code.toUpperCase();
    playerName = name;
    socket.join(currentRoom);
    socket.emit("room-joined", { code: currentRoom, playerId: socket.id });
    io.to(currentRoom).emit("players-updated", getPlayersData(room));
  });

  socket.on("start-game", async () => {
    const room = rooms.get(currentRoom);
    if (!room || socket.id !== room.hostId) return;
    if (room.players.size < 2) {
      socket.emit("error-msg", "Need at least 2 players to start");
      return;
    }

    try {
      room.questions = await fetchQuestions(room.totalQuestions);
      room.questionIndex = 0;
      startRound(room);
    } catch (err) {
      socket.emit("error-msg", "Failed to fetch questions. Try again.");
    }
  });

  // Poker actions: check, raise, fold
  socket.on("poker-action", ({ action, raiseAmount }) => {
    const room = rooms.get(currentRoom);
    if (!room) return;
    if (!["reveal-category", "reveal-answers", "reveal-question"].includes(room.state)) return;

    const player = room.players.get(socket.id);
    if (!player) return;

    const betInfo = room.bets.get(socket.id);
    if (!betInfo || betInfo.folded || betInfo.locked) return;

    if (action === "fold") {
      betInfo.folded = true;
      betInfo.locked = true;
      io.to(currentRoom).emit("player-action", {
        playerId: socket.id,
        name: player.name,
        action: "folded",
        pot: getPot(room),
        activePlayers: getActivePlayers(room).length,
      });
    } else if (action === "check") {
      betInfo.locked = true;
      io.to(currentRoom).emit("player-action", {
        playerId: socket.id,
        name: player.name,
        action: "checked",
        pot: getPot(room),
        activePlayers: getActivePlayers(room).length,
      });
    } else if (action === "raise") {
      const amount = Math.max(5, Math.min(raiseAmount || 10, player.balance - betInfo.amount));
      betInfo.amount += amount;
      player.balance -= amount;
      betInfo.locked = true;
      io.to(currentRoom).emit("player-action", {
        playerId: socket.id,
        name: player.name,
        action: `raised $${amount}`,
        pot: getPot(room),
        activePlayers: getActivePlayers(room).length,
      });
    }

    // Check if all active players have locked in for this phase
    checkPhaseAdvance(room);
  });

  socket.on("submit-answer", (answer) => {
    const room = rooms.get(currentRoom);
    if (!room || room.state !== "answering") return;

    const betInfo = room.bets.get(socket.id);
    if (!betInfo || betInfo.folded) return;
    if (room.answers.has(socket.id)) return; // already answered

    room.answers.set(socket.id, { answer, timestamp: Date.now() });

    const activePlayers = getActivePlayers(room);
    io.to(currentRoom).emit("answer-submitted", {
      playerId: socket.id,
      totalAnswers: room.answers.size,
      totalActive: activePlayers.length,
    });

    if (room.answers.size === activePlayers.length) {
      clearTimeout(room.answerTimer);
      showResults(room);
    }
  });

  socket.on("next-question", () => {
    const room = rooms.get(currentRoom);
    if (!room || socket.id !== room.hostId) return;

    room.questionIndex++;
    if (room.questionIndex >= room.totalQuestions) {
      endGame(room);
    } else {
      startRound(room);
    }
  });

  socket.on("play-again", () => {
    const room = rooms.get(currentRoom);
    if (!room || socket.id !== room.hostId) return;

    for (const [id, player] of room.players) {
      player.balance = 100;
    }
    room.state = "lobby";
    room.questionIndex = 0;
    room.questions = [];
    room.bets.clear();
    room.answers.clear();
    io.to(currentRoom).emit("back-to-lobby");
    io.to(currentRoom).emit("players-updated", getPlayersData(room));
  });

  socket.on("disconnect", () => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;

    room.players.delete(socket.id);
    room.bets.delete(socket.id);
    room.answers.delete(socket.id);

    if (room.players.size === 0) {
      rooms.delete(currentRoom);
      if (room.answerTimer) clearTimeout(room.answerTimer);
      return;
    }

    if (socket.id === room.hostId) {
      room.hostId = room.players.keys().next().value;
    }

    io.to(currentRoom).emit("players-updated", getPlayersData(room));
    io.to(currentRoom).emit("player-left", playerName);

    // Check if phase should advance
    if (["reveal-category", "reveal-answers", "reveal-question"].includes(room.state)) {
      checkPhaseAdvance(room);
    }
    if (room.state === "answering") {
      const activePlayers = getActivePlayers(room);
      if (room.answers.size >= activePlayers.length) {
        clearTimeout(room.answerTimer);
        showResults(room);
      }
    }
  });

  function startRound(room) {
    room.bets.clear();
    room.answers.clear();
    room.currentQuestion = room.questions[room.questionIndex];

    // Collect ante from everyone
    for (const [id, player] of room.players) {
      const ante = Math.min(ANTE, player.balance);
      player.balance -= ante;
      room.bets.set(id, { amount: ante, folded: false, locked: false });
    }

    room.state = "reveal-category";

    io.to(currentRoom).emit("reveal-category", {
      questionNumber: room.questionIndex + 1,
      totalQuestions: room.totalQuestions,
      category: room.currentQuestion.category,
      difficulty: room.currentQuestion.difficulty,
      pot: getPot(room),
      players: getPlayersData(room),
      ante: ANTE,
    });
  }

  function checkPhaseAdvance(room) {
    const activePlayers = getActivePlayers(room);

    // If only one player left, they win the pot
    if (activePlayers.length <= 1) {
      awardPotToLastPlayer(room, activePlayers[0]);
      return;
    }

    // Check if all active players have locked their action
    const allLocked = activePlayers.every((id) => {
      const betInfo = room.bets.get(id);
      return betInfo && betInfo.locked;
    });

    if (!allLocked) return;

    // Unlock everyone for next phase
    for (const [id, betInfo] of room.bets) {
      if (!betInfo.folded) {
        betInfo.locked = false;
      }
    }

    if (room.state === "reveal-category") {
      room.state = "reveal-answers";
      io.to(currentRoom).emit("reveal-answers", {
        answers: room.currentQuestion.answers,
        pot: getPot(room),
        players: getPlayersData(room),
      });
    } else if (room.state === "reveal-answers") {
      room.state = "reveal-question";
      io.to(currentRoom).emit("reveal-question", {
        question: room.currentQuestion.question,
        pot: getPot(room),
        players: getPlayersData(room),
      });
    } else if (room.state === "reveal-question") {
      startAnsweringPhase(room);
    }
  }

  function startAnsweringPhase(room) {
    room.state = "answering";
    room.answerDeadline = Date.now() + ANSWER_TIME_LIMIT * 1000;

    const activePlayers = getActivePlayers(room);

    io.to(currentRoom).emit("answering-phase", {
      question: room.currentQuestion.question,
      answers: room.currentQuestion.answers,
      timeLimit: ANSWER_TIME_LIMIT,
      pot: getPot(room),
      activePlayers,
    });

    // Auto-resolve after time limit
    room.answerTimer = setTimeout(() => {
      if (room.state === "answering") {
        showResults(room);
      }
    }, (ANSWER_TIME_LIMIT + 1) * 1000);
  }

  function awardPotToLastPlayer(room, winnerId) {
    const pot = getPot(room);
    if (winnerId) {
      const winner = room.players.get(winnerId);
      if (winner) {
        winner.balance += pot;
      }
    }

    room.state = "results";
    io.to(currentRoom).emit("fold-win", {
      winnerId,
      winnerName: winnerId ? room.players.get(winnerId).name : "Nobody",
      pot,
      players: getPlayersData(room),
      questionNumber: room.questionIndex + 1,
      totalQuestions: room.totalQuestions,
      isLastQuestion: room.questionIndex + 1 >= room.totalQuestions,
    });
  }

  function showResults(room) {
    room.state = "results";
    const correctAnswer = room.currentQuestion.correctAnswer;
    const activePlayers = getActivePlayers(room);
    const pot = getPot(room);
    const results = [];

    // Find winners (correct answers) and their timestamps
    const winners = [];
    for (const id of activePlayers) {
      const answerData = room.answers.get(id);
      const player = room.players.get(id);
      const correct = answerData && answerData.answer === correctAnswer;
      if (correct) {
        winners.push({ id, timestamp: answerData.timestamp });
      }
    }

    if (winners.length > 0) {
      // Sort by speed (fastest first)
      winners.sort((a, b) => a.timestamp - b.timestamp);
      const fastestTime = winners[0].timestamp;
      const slowestTime = winners[winners.length - 1].timestamp;
      const timeSpread = slowestTime - fastestTime || 1;

      // Distribute pot weighted by speed
      // Fastest gets most, slowest gets least
      // Weight: inversely proportional to time taken
      let totalWeight = 0;
      const weights = winners.map((w) => {
        const timeTaken = w.timestamp - fastestTime;
        const weight = 1 - (timeTaken / (timeSpread + 1)) + 0.5; // 0.5 base so slowest still gets something
        totalWeight += weight;
        return { ...w, weight };
      });

      for (const w of weights) {
        const share = Math.floor(pot * (w.weight / totalWeight));
        const player = room.players.get(w.id);
        if (player) player.balance += share;
      }
    }
    // If no winners, pot is lost (house takes it)

    // Build results for all players in room
    for (const [id, player] of room.players) {
      const betInfo = room.bets.get(id);
      const answerData = room.answers.get(id);
      const folded = betInfo ? betInfo.folded : false;
      const betAmount = betInfo ? betInfo.amount : 0;
      const correct = answerData && answerData.answer === correctAnswer;
      const isWinner = winners.some((w) => w.id === id);
      const rank = winners.findIndex((w) => w.id === id);

      results.push({
        id,
        name: player.name,
        bet: betAmount,
        answer: answerData ? answerData.answer : null,
        correct: correct || false,
        folded,
        balance: player.balance,
        speedRank: isWinner ? rank + 1 : null,
      });
    }

    io.to(currentRoom).emit("round-results", {
      correctAnswer,
      pot,
      winnersCount: winners.length,
      results: results.sort((a, b) => b.balance - a.balance),
      questionNumber: room.questionIndex + 1,
      totalQuestions: room.totalQuestions,
      isLastQuestion: room.questionIndex + 1 >= room.totalQuestions,
    });
  }

  function endGame(room) {
    room.state = "gameover";
    const finalStandings = getPlayersData(room).sort(
      (a, b) => b.balance - a.balance
    );
    io.to(currentRoom).emit("game-over", { standings: finalStandings });
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Trivi-Yuh running on http://localhost:${PORT}`);
});
