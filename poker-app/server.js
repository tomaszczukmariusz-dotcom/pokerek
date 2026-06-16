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
    rooms[roomId] = { game: new PokerGame(roomId), chat: [], hostId: null };
  }
  return rooms[roomId];
}

io.on('connection', (socket) => {
  let currentRoom = null;
  let currentName = null;

  socket.on('join_room', ({ roomId, name }) => {
    if (!roomId || !name) return;
    const room = getOrCreateRoom(roomId);

    // Remove any stale player with same name (reconnect case)
    const existing = room.game.players.find(p => p.name === name && p.id !== socket.id);
    if (existing) {
      room.game.players = room.game.players.filter(p => p.name !== name || p.id === socket.id);
      if (room.hostId === existing.id) room.hostId = null;
    }

    // Remove disconnected players (connected===false) to avoid stale slots
    room.game.players = room.game.players.filter(p => p.connected !== false || p.id === socket.id);

    const added = room.game.addPlayer(socket.id, name);
    if (!added && !room.game.players.find(p => p.id === socket.id)) {
      socket.emit('error_msg', 'Pokój jest pełny (max 8 graczy)');
      return;
    }

    if (!room.hostId || !room.game.players.find(p => p.id === room.hostId)) {
      room.hostId = socket.id;
    }

    currentRoom = roomId;
    currentName = name;
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
    if (room.game.activePlayers().length < 2) { socket.emit('error_msg', 'Potrzeba minimum 2 graczy'); return; }
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
    if (room.game.phase === 'showdown' && room.game.winners) {
      const msg = room.game.winners.map(w => `🏆 ${w.name}: ${w.hand}`).join(' | ');
      broadcastChat(currentRoom, null, msg);
      setTimeout(() => {
        if (rooms[currentRoom]) {
          room.game.phase = 'waiting';
          emitPersonalizedStates(currentRoom, room);
        }
      }, 4000);
    }
  });

  socket.on('chat_message', ({ text }) => {
    if (!currentRoom || !text?.trim()) return;
    const room = rooms[currentRoom];
    const player = room?.game.players.find(p => p.id === socket.id);
    const senderName = player?.name || currentName;
    if (!senderName) return;
    broadcastChat(currentRoom, senderName, text.trim().slice(0, 200));
  });

  socket.on('new_hand', () => {
    if (!currentRoom) return;
    const room = rooms[currentRoom];
    if (!room) return;
    if (room.game.phase !== 'waiting') { socket.emit('error_msg', 'Poczekaj na zakończenie rozdania'); return; }
    if (room.game.activePlayers().length < 2) { socket.emit('error_msg', 'Potrzeba minimum 2 graczy z żetonami'); return; }
    room.game.startHand();
    emitPersonalizedStates(currentRoom, room);
    broadcastChat(currentRoom, null, `🎰 Rozdanie #${room.game.handNum} rozpoczęte!`);
  });

  socket.on('update_settings', ({ smallBlind, bigBlind, startingChips }) => {
    if (!currentRoom) return;
    const room = rooms[currentRoom];
    if (!room || room.hostId !== socket.id) { socket.emit('error_msg', 'Tylko host może zmieniać ustawienia'); return; }
    if (room.game.phase !== 'waiting') { socket.emit('error_msg', 'Zmień ustawienia przed rozdaniem'); return; }
    if (smallBlind && bigBlind) {
      room.game.smallBlind = Math.max(1, parseInt(smallBlind));
      room.game.bigBlind = Math.max(2, parseInt(bigBlind));
      room.game.minRaise = room.game.bigBlind;
    }
    if (startingChips) {
      const chips = Math.max(100, parseInt(startingChips));
      for (const p of room.game.players) p.chips = chips;
    }
    emitPersonalizedStates(currentRoom, room);
    broadcastChat(currentRoom, null, `⚙️ Ustawienia: SB=${room.game.smallBlind} BB=${room.game.bigBlind}${startingChips ? ' Żetony='+parseInt(startingChips) : ''}`);
  });

  socket.on('kick_player', ({ playerId }) => {
    if (!currentRoom) return;
    const room = rooms[currentRoom];
    if (!room || room.hostId !== socket.id) { socket.emit('error_msg', 'Tylko host może wyrzucać graczy'); return; }
    if (playerId === socket.id) { socket.emit('error_msg', 'Nie możesz wyrzucić siebie'); return; }
    const player = room.game.players.find(p => p.id === playerId);
    if (!player) return;
    const kickedSocket = io.sockets.sockets.get(playerId);
    if (kickedSocket) kickedSocket.emit('kicked', { reason: 'Zostałeś wyrzucony przez hosta' });
    room.game.removePlayer(playerId);
    broadcastChat(currentRoom, null, `🚫 ${player.name} został wyrzucony`);
    emitPersonalizedStates(currentRoom, room);
  });

  socket.on('disconnect', () => {
    if (!currentRoom) return;
    const room = rooms[currentRoom];
    if (!room) return;
    const player = room.game.players.find(p => p.id === socket.id);
    if (player) {
      broadcastChat(currentRoom, null, `👋 ${player.name} opuścił stół`);
      room.game.removePlayer(socket.id);
      if (room.hostId === socket.id && room.game.players.length > 0) {
        room.hostId = room.game.players[0].id;
        broadcastChat(currentRoom, null, `👑 ${room.game.players[0].name} jest teraz hostem`);
      }
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
      if (s) s.emit('game_state', { ...room.game.getState(player.id), isHost: player.id === room.hostId });
    }
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`♠ Poker server on port ${PORT}`));
