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
    state: "lobby", // lobby, betting, answering, results, gameover
    currentQuestion: null,
    questionIndex: 0,
    totalQuestions: 10,
    bets: new Map(),
    answers: new Map(),
    hostId: null,
    questions: [],
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
    `https://opentdb.com/api.php?amount=${amount}&type=multiple`
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

function getDifficultyMultiplier(difficulty) {
  switch (difficulty) {
    case "easy":
      return 1;
    case "medium":
      return 1.5;
    case "hard":
      return 2;
    default:
      return 1;
  }
}

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
      startBettingPhase(room);
    } catch (err) {
      socket.emit("error-msg", "Failed to fetch questions. Try again.");
    }
  });

  socket.on("place-bet", (amount) => {
    const room = rooms.get(currentRoom);
    if (!room || room.state !== "betting") return;
    const player = room.players.get(socket.id);
    if (!player) return;

    const bet = Math.max(0, Math.min(amount, player.balance));
    room.bets.set(socket.id, bet);

    io.to(currentRoom).emit("bet-placed", {
      playerId: socket.id,
      hasBet: true,
      totalBets: room.bets.size,
      totalPlayers: room.players.size,
    });

    if (room.bets.size === room.players.size) {
      startAnsweringPhase(room);
    }
  });

  socket.on("submit-answer", (answer) => {
    const room = rooms.get(currentRoom);
    if (!room || room.state !== "answering") return;

    room.answers.set(socket.id, answer);

    io.to(currentRoom).emit("answer-submitted", {
      playerId: socket.id,
      hasAnswered: true,
      totalAnswers: room.answers.size,
      totalPlayers: room.players.size,
    });

    if (room.answers.size === room.players.size) {
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
      startBettingPhase(room);
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
      return;
    }

    if (socket.id === room.hostId) {
      room.hostId = room.players.keys().next().value;
    }

    io.to(currentRoom).emit("players-updated", getPlayersData(room));
    io.to(currentRoom).emit("player-left", playerName);

    // Check if remaining players have all bet/answered
    if (room.state === "betting" && room.bets.size === room.players.size) {
      startAnsweringPhase(room);
    }
    if (room.state === "answering" && room.answers.size === room.players.size) {
      showResults(room);
    }
  });

  function startBettingPhase(room) {
    room.state = "betting";
    room.bets.clear();
    room.answers.clear();
    room.currentQuestion = room.questions[room.questionIndex];

    io.to(currentRoom).emit("betting-phase", {
      questionNumber: room.questionIndex + 1,
      totalQuestions: room.totalQuestions,
      category: room.currentQuestion.category,
      difficulty: room.currentQuestion.difficulty,
      players: getPlayersData(room),
    });
  }

  function startAnsweringPhase(room) {
    room.state = "answering";
    io.to(currentRoom).emit("answering-phase", {
      question: room.currentQuestion.question,
      answers: room.currentQuestion.answers,
      difficulty: room.currentQuestion.difficulty,
      questionNumber: room.questionIndex + 1,
      totalQuestions: room.totalQuestions,
    });
  }

  function showResults(room) {
    room.state = "results";
    const correctAnswer = room.currentQuestion.correctAnswer;
    const multiplier = getDifficultyMultiplier(room.currentQuestion.difficulty);
    const results = [];

    for (const [id, player] of room.players) {
      const bet = room.bets.get(id) || 0;
      const answer = room.answers.get(id);
      const correct = answer === correctAnswer;
      const earnings = correct ? Math.floor(bet * multiplier) : -bet;
      player.balance = Math.max(0, player.balance + earnings);

      results.push({
        id,
        name: player.name,
        bet,
        answer,
        correct,
        earnings,
        balance: player.balance,
      });
    }

    io.to(currentRoom).emit("round-results", {
      correctAnswer,
      difficulty: room.currentQuestion.difficulty,
      multiplier,
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
  console.log(`Trivia server running on http://localhost:${PORT}`);
});
