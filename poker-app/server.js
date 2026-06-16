'use strict';
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { PokerGame } = require('./gameLogic');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

// Rooms: roomId -> { game, chat, readyPlayers }
const rooms = {};

function getOrCreateRoom(roomId) {
  if (!rooms[roomId]) {
    rooms[roomId] = { game: new PokerGame(roomId), chat: [], readyPlayers: new Set() };
  }
  return rooms[roomId];
}

io.on('connection', (socket) => {
  let currentRoom = null;
  let currentPlayerId = socket.id;

  socket.on('join_room', ({ roomId, name }) => {
    if (!roomId || !name) return;
    const room = getOrCreateRoom(roomId);
    const added = room.game.addPlayer(socket.id, name);
    if (!added && !room.game.players.find(p => p.id === socket.id)) {
      socket.emit('error_msg', 'Pokój jest pełny lub już dołączyłeś');
      return;
    }
    currentRoom = roomId;
    socket.join(roomId);

    const state = room.game.getState(socket.id);
    io.to(roomId).emit('game_state', state);
    socket.emit('chat_history', room.chat);

    const player = room.game.players.find(p => p.id === socket.id);
    broadcastChat(roomId, null, `🃏 ${player?.name || name} dołączył do stołu`);
  });

  socket.on('start_game', () => {
    if (!currentRoom) return;
    const room = rooms[currentRoom];
    if (!room) return;
    if (!room.game.canStart()) {
      socket.emit('error_msg', 'Potrzeba minimum 2 graczy');
      return;
    }
    const state = room.game.startHand();
    emitPersonalizedStates(currentRoom, room);
    broadcastChat(currentRoom, null, `🎰 Rozdanie #${room.game.handNum} rozpoczęte!`);
  });

  socket.on('player_action', ({ action, amount }) => {
    if (!currentRoom) return;
    const room = rooms[currentRoom];
    if (!room) return;
    const result = room.game.playerAction(socket.id, action, amount);
    if (result?.error) { socket.emit('error_msg', result.error); return; }
    emitPersonalizedStates(currentRoom, room);

    if (room.game.phase === 'showdown') {
      const winners = room.game.winners;
      if (winners) {
        const msg = winners.map(w => `🏆 ${w.name}: ${w.hand}`).join(' | ');
        broadcastChat(currentRoom, null, msg);
        // Auto next hand after 5s
        setTimeout(() => {
          if (rooms[currentRoom] && room.game.canStart()) {
            room.game.phase = 'waiting';
            if (room.game.activePlayers().length >= 2) {
              room.game.startHand();
              emitPersonalizedStates(currentRoom, room);
              broadcastChat(currentRoom, null, `🎰 Rozdanie #${room.game.handNum} rozpoczęte!`);
            }
          }
        }, 6000);
      }
    }
  });

  socket.on('chat_message', ({ text }) => {
    if (!currentRoom || !text?.trim()) return;
    const room = rooms[currentRoom];
    const player = room?.game.players.find(p => p.id === socket.id);
    if (!player) return;
    broadcastChat(currentRoom, player.name, text.trim().slice(0, 200));
  });

  socket.on('new_hand', () => {
    if (!currentRoom) return;
    const room = rooms[currentRoom];
    if (!room || !room.game.canStart()) return;
    if (room.game.phase !== 'showdown' && room.game.phase !== 'waiting') return;
    room.game.phase = 'waiting';
    room.game.startHand();
    emitPersonalizedStates(currentRoom, room);
    broadcastChat(currentRoom, null, `🎰 Rozdanie #${room.game.handNum} rozpoczęte!`);
  });

  socket.on('disconnect', () => {
    if (!currentRoom) return;
    const room = rooms[currentRoom];
    if (!room) return;
    const player = room.game.players.find(p => p.id === socket.id);
    if (player) {
      broadcastChat(currentRoom, null, `👋 ${player.name} opuścił stół`);
      room.game.removePlayer(socket.id);
      emitPersonalizedStates(currentRoom, room);
    }
  });

  function broadcastChat(roomId, senderName, text) {
    const room = rooms[roomId];
    if (!room) return;
    const msg = { senderName, text, ts: Date.now() };
    room.chat.push(msg);
    if (room.chat.length > 100) room.chat.shift();
    io.to(roomId).emit('chat_message', msg);
  }

  function emitPersonalizedStates(roomId, room) {
    for (const player of room.game.players) {
      const playerSocket = io.sockets.sockets.get(player.id);
      if (playerSocket) {
        playerSocket.emit('game_state', room.game.getState(player.id));
      }
    }
    // Also emit generic state to spectators (no hole cards)
    io.to(roomId).emit('game_state_public', room.game.getState(null));
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`♠ Poker server running on port ${PORT}`));
