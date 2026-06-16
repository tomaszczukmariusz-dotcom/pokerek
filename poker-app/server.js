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

const rooms = {};

function getOrCreateRoom(roomId) {
  if (!rooms[roomId]) {
    rooms[roomId] = { game: new PokerGame(roomId), chat: [] };
  }
  return rooms[roomId];
}

io.on('connection', (socket) => {
  let currentRoom = null;

  socket.on('join_room', ({ roomId, name }) => {
    if (!roomId || !name) return;
    const room = getOrCreateRoom(roomId);
    const added = room.game.addPlayer(socket.id, name);
    if (!added && !room.game.players.find(p => p.id === socket.id)) {
      socket.emit('error_msg', 'Pokój jest pełny');
      return;
    }
    currentRoom = roomId;
    socket.join(roomId);
    emitPersonalizedStates(roomId, room);
    socket.emit('chat_history', room.chat);
    const player = room.game.players.find(p => p.id === socket.id);
    broadcastChat(roomId, null, `🃏 ${player?.name || name} dołączył do stołu`);
  });

  socket.on('start_game', () => {
    if (!currentRoom) return;
    const room = rooms[currentRoom];
    if (!room) return;
    if (room.game.activePlayers().length < 2) {
      socket.emit('error_msg', 'Potrzeba minimum 2 graczy');
      return;
    }
    if (room.game.phase !== 'waiting') return;
    room.game.startHand();
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
        // Wait 4s then switch to waiting so players can see the result
        setTimeout(() => {
          if (rooms[currentRoom]) {
            room.game.phase = 'waiting';
            emitPersonalizedStates(currentRoom, room);
          }
        }, 4000);
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
    if (!room) return;
    if (room.game.phase !== 'waiting') {
      socket.emit('error_msg', 'Poczekaj na zakończenie rozdania');
      return;
    }
    if (room.game.activePlayers().length < 2) {
      socket.emit('error_msg', 'Potrzeba minimum 2 graczy z żetonami');
      return;
    }
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
      const s = io.sockets.sockets.get(player.id);
      if (s) s.emit('game_state', room.game.getState(player.id));
    }
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`♠ Poker server on port ${PORT}`));
