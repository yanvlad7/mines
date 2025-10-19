const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const PORT = process.env.PORT || 4000;
const GRID_SIZE = 10; // Добавим константу для размера сетки
const MAX_BOMBS = 3;

const rooms = {};

function makeRoomIfNeeded(roomId) {
  if (!rooms[roomId]) {
    rooms[roomId] = {
      players: [],
      bombs: {},
      state: "waiting",
      turnIndex: 0,
      balances: {},
      messages: [],
      openedCells: [], // Добавим для отслеживания открытых клеток
    };
  }
  return rooms[roomId];
}

// Функция для проверки валидности координат
function isValidCoordinate(x, y) {
  return x >= 0 && x < GRID_SIZE && y >= 0 && y < GRID_SIZE;
}

io.on("connection", (socket) => {
  console.log("✅ Connected:", socket.id);

  // Присоединение к комнате
  socket.on("joinRoom", (roomId, playerName, gender, cb) => {
    try {
      if (!roomId || !playerName) {
        return cb({ ok: false, reason: "invalid_data" });
      }

      const room = makeRoomIfNeeded(roomId);
      
      if (room.players.length >= 2) {
        return cb({ ok: false, reason: "room_full" });
      }

      // Проверяем, нет ли уже игрока с таким именем в комнате
      if (room.players.some(p => p.name === playerName)) {
        return cb({ ok: false, reason: "name_taken" });
      }

      room.players.push({ id: socket.id, name: playerName, gender });
      room.balances[socket.id] = 0;
      room.bombs[socket.id] = [];
      socket.join(roomId);

      // Отправляем системное сообщение в чат
      const systemMessage = {
        id: Date.now().toString(),
        playerName: "Система",
        playerId: "system",
        message: `${playerName} присоединился к игре`,
        timestamp: new Date().toLocaleTimeString(),
        isSystem: true
      };
      room.messages.push(systemMessage);

      io.to(roomId).emit("playerJoined", playerName);
      io.to(roomId).emit("roomUpdate", { players: room.players });
      io.to(roomId).emit("newMessage", systemMessage);
      
      // Отправляем историю сообщений новому игроку
      socket.emit("chatHistory", room.messages);

      const playerIndex = room.players.findIndex((p) => p.id === socket.id);
      cb({ ok: true, playerIndex });

      // Если оба игрока подключились — начинаем этап постановки бомб
      if (room.players.length === 2) {
        room.state = "placing";
        io.to(roomId).emit("startPlacing");
        
        // Системное сообщение о начале расстановки бомб
        const startMessage = {
          id: Date.now().toString(),
          playerName: "Система",
          playerId: "system",
          message: "Оба игрока подключены! Начинайте расставлять бомбы.",
          timestamp: new Date().toLocaleTimeString(),
          isSystem: true
        };
        room.messages.push(startMessage);
        io.to(roomId).emit("newMessage", startMessage);
      }
    } catch (error) {
      console.error("Error in joinRoom:", error);
      cb({ ok: false, reason: "server_error" });
    }
  });

  // Постановка бомбы
  socket.on("placeBomb", (roomId, coord, cb) => {
    try {
      const room = rooms[roomId];
      if (!room || room.state !== "placing") {
        return cb({ ok: false, reason: "invalid_state" });
      }

      if (!room.bombs[socket.id]) room.bombs[socket.id] = [];

      // Проверяем валидность координат
      if (!isValidCoordinate(coord.x, coord.y)) {
        return cb({ ok: false, reason: "invalid_coordinates" });
      }

      // Проверяем уникальность координаты
      if (room.bombs[socket.id].some((b) => b.x === coord.x && b.y === coord.y)) {
        return cb({ ok: false, reason: "bomb_already_placed" });
      }

      // Проверка на максимальное количество бомб
      if (room.bombs[socket.id].length >= MAX_BOMBS) {
        return cb({ ok: false, reason: "max_bombs_reached" });
      }

      room.bombs[socket.id].push(coord);

      // Проверяем, поставил ли каждый игрок 3 бомбы
      const allPlayersPlaced =
        room.players.length === 2 &&
        room.players.every((p) => room.bombs[p.id] && room.bombs[p.id].length === MAX_BOMBS);

      // Если оба поставили — выбираем случайного первого игрока
      if (allPlayersPlaced) {
        room.state = "started";
        const randomTurn = Math.floor(Math.random() * 2);
        room.turnIndex = randomTurn;

        io.to(roomId).emit("gameStarted", { turnIndex: randomTurn });

        // Системное сообщение о начале игры
        const gameStartMessage = {
          id: Date.now().toString(),
          playerName: "Система",
          playerId: "system",
          message: "Все бомбы расставлены! Игра начинается!",
          timestamp: new Date().toLocaleTimeString(),
          isSystem: true
        };
        room.messages.push(gameStartMessage);
        io.to(roomId).emit("newMessage", gameStartMessage);

        return cb({ ok: true, coord, allPlayersPlaced: true, turnIndex: randomTurn });
      }

      cb({ ok: true, coord, allPlayersPlaced: false });
    } catch (error) {
      console.error("Error in placeBomb:", error);
      cb({ ok: false, reason: "server_error" });
    }
  });

  // Сделать ход
  socket.on("makeMove", (roomId, coord, cb) => {
    try {
      const room = rooms[roomId];
      if (!room || room.state !== "started") {
        return cb({ ok: false, reason: "invalid_state" });
      }

      const playerIndex = room.players.findIndex((p) => p.id === socket.id);
      if (playerIndex === -1) {
        return cb({ ok: false, reason: "player_not_found" });
      }

      // Проверка: ход строго по очереди
      if (playerIndex !== room.turnIndex) {
        return cb({ ok: false, reason: "not_your_turn" });
      }

      // Проверяем валидность координат
      if (!isValidCoordinate(coord.x, coord.y)) {
        return cb({ ok: false, reason: "invalid_coordinates" });
      }

      // Проверяем, не был ли уже сделан ход в эту клетку
      if (room.openedCells.some(cell => cell.x === coord.x && cell.y === coord.y)) {
        return cb({ ok: false, reason: "cell_already_opened" });
      }

      const { x, y } = coord;
      const opponent = room.players[1 - playerIndex];
      const oppBombs = room.bombs[opponent.id] || [];

      // Проверяем попадание на мину
      const hit = oppBombs.some((b) => b.x === x && b.y === y);

      // Добавляем клетку в открытые
      room.openedCells.push({ x, y, playerId: socket.id });

      if (hit) {
        room.state = "finished";
        
        const moveResult = {
          by: playerIndex,
          coord,
          hit: true,
          balances: room.players.map((p) => room.balances[p.id] || 0),
          nextTurn: null,
        };

        const gameOverData = { winnerIndex: 1 - playerIndex };

        io.to(roomId).emit("moveResult", moveResult);
        io.to(roomId).emit("gameOver", gameOverData);

        // Системное сообщение о результате игры
        const winner = room.players[1 - playerIndex];
        const gameOverMessage = {
          id: Date.now().toString(),
          playerName: "Система",
          playerId: "system",
          message: `Игрок ${room.players[playerIndex].name} подорвался на мине! Победитель: ${winner.name}!`,
          timestamp: new Date().toLocaleTimeString(),
          isSystem: true
        };
        room.messages.push(gameOverMessage);
        io.to(roomId).emit("newMessage", gameOverMessage);

        return cb({ ok: true, result: "hit" });
      }

      // Безопасный ход — начисляем очки
      room.balances[socket.id] = (room.balances[socket.id] || 0) + 1;

      // Передача хода следующему игроку
      room.turnIndex = 1 - room.turnIndex;

      const balances = room.players.map((p) => room.balances[p.id] || 0);
      
      const moveResult = {
        by: playerIndex,
        coord,
        hit: false,
        balances,
        nextTurn: room.turnIndex,
      };

      io.to(roomId).emit("moveResult", moveResult);

      cb({ ok: true, result: "safe", reward: 1 });
    } catch (error) {
      console.error("Error in makeMove:", error);
      cb({ ok: false, reason: "server_error" });
    }
  });

  // Отправка сообщения в чат
  socket.on("sendMessage", (roomId, message, cb) => {
    try {
      const room = rooms[roomId];
      if (!room) {
        return cb({ ok: false, reason: "room_not_found" });
      }

      const player = room.players.find(p => p.id === socket.id);
      if (!player) {
        return cb({ ok: false, reason: "player_not_found" });
      }

      // Проверяем, не пустое ли сообщение
      if (!message || message.trim().length === 0) {
        return cb({ ok: false, reason: "empty_message" });
      }

      // Ограничиваем длину сообщения
      if (message.length > 500) {
        return cb({ ok: false, reason: "message_too_long" });
      }

      const chatMessage = {
        id: Date.now().toString(),
        playerName: player.name,
        playerId: socket.id,
        message: message.trim(),
        timestamp: new Date().toLocaleTimeString(),
      };

      // Сохраняем сообщение в истории комнаты (максимум 100 сообщений)
      room.messages.push(chatMessage);
      if (room.messages.length > 100) {
        room.messages = room.messages.slice(-100);
      }

      // Отправляем сообщение всем в комнате
      io.to(roomId).emit("newMessage", chatMessage);
      cb({ ok: true });
    } catch (error) {
      console.error("Error in sendMessage:", error);
      cb({ ok: false, reason: "server_error" });
    }
  });

  // Отключение игрока
  socket.on("disconnect", () => {
    console.log("❌ Disconnected:", socket.id);
    
    for (const roomId in rooms) {
      const room = rooms[roomId];
      const playerIndex = room.players.findIndex((p) => p.id === socket.id);
      
      if (playerIndex !== -1) {
        const leftPlayer = room.players[playerIndex];
        
        // Системное сообщение об отключении
        const leaveMessage = {
          id: Date.now().toString(),
          playerName: "Система",
          playerId: "system",
          message: `${leftPlayer.name} покинул игру`,
          timestamp: new Date().toLocaleTimeString(),
          isSystem: true
        };
        room.messages.push(leaveMessage);
        
        // Удаляем игрока
        room.players.splice(playerIndex, 1);
        delete room.bombs[socket.id];
        delete room.balances[socket.id];
        
        // Если игра была в процессе и игрок отключился, завершаем игру
        if ((room.state === "started" || room.state === "placing") && room.players.length === 1) {
          room.state = "finished";
          const winnerIndex = 0; // Оставшийся игрок
          io.to(roomId).emit("gameOver", { winnerIndex });
          
          const autoWinMessage = {
            id: Date.now().toString(),
            playerName: "Система",
            playerId: "system",
            message: `Игра завершена. ${room.players[0].name} побеждает, так как противник отключился.`,
            timestamp: new Date().toLocaleTimeString(),
            isSystem: true
          };
          room.messages.push(autoWinMessage);
          io.to(roomId).emit("newMessage", autoWinMessage);
        }
        
        io.to(roomId).emit("roomUpdate", { players: room.players });
        io.to(roomId).emit("playerLeft", leftPlayer.name);
        io.to(roomId).emit("newMessage", leaveMessage);
        
        if (room.players.length === 0) {
          delete rooms[roomId];
          console.log(`Room ${roomId} deleted (empty)`);
        }
        
        break; // Игрок может быть только в одной комнате
      }
    }
  });
});

// Эндпоинт для проверки здоровья сервера
app.get("/health", (req, res) => {
  res.json({ 
    status: "ok", 
    rooms: Object.keys(rooms).length,
    timestamp: new Date().toISOString()
  });
});

// Эндпоинт для получения статистики
app.get("/stats", (req, res) => {
  const stats = {
    totalRooms: Object.keys(rooms).length,
    totalPlayers: Object.values(rooms).reduce((acc, room) => acc + room.players.length, 0),
    rooms: Object.keys(rooms).map(roomId => ({
      id: roomId,
      players: rooms[roomId].players.length,
      state: rooms[roomId].state
    }))
  };
  res.json(stats);
});

server.listen(PORT, () => {
  console.log("🚀 Server listening on port", PORT);
  console.log("📊 Health check available at http://localhost:" + PORT + "/health");
  console.log("📈 Stats available at http://localhost:" + PORT + "/stats");
});