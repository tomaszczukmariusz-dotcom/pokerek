'use strict';
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { PokerGame } = require('./gameLogic');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingTimeout: 60000,
  pingInterval: 25000,
  transports: ['websocket', 'polling']
});
app.use(express.static(path.join(__dirname, 'public')));

const rooms = {};

function getOrCreateRoom(roomId) {
  if (!rooms[roomId]) {
    rooms[roomId] = { game: new PokerGame(roomId), chat: [], hostId: null, readyPlayers: new Set() };
  }
  return rooms[roomId];
}

io.on('connection', (socket) => {
  let currentRoom = null;
  let currentName = null;

  socket.on('join_room', ({ roomId, name }) => {
    if (!roomId || !name) return;
    const room = getOrCreateRoom(roomId);

    // Check if player already exists with same name
    const existing = room.game.players.find(p => p.name === name);

    if (existing) {
      // Reconnect: just update socket ID, preserve everything
      const oldId = existing.id;
      existing.id = socket.id;
      existing.connected = true;

      // Update host if needed
      if (room.hostId === oldId) room.hostId = socket.id;

      // Update readyPlayers
      if (room.readyPlayers.has(oldId)) {
        room.readyPlayers.delete(oldId);
        room.readyPlayers.add(socket.id);
      }

      currentRoom = roomId;
      currentName = name;
      socket.join(roomId);
      emitPersonalizedStates(roomId, room);
      socket.emit('chat_history', room.chat);
      broadcastChat(roomId, null, `🔄 ${name} wrócił do stołu`);
    } else {
      // New player
      if (room.game.players.length >= 8) {
        socket.emit('error_msg', 'Pokój jest pełny (max 8 graczy)');
        return;
      }
      room.game.addPlayer(socket.id, name);
      if (!room.hostId) room.hostId = socket.id;
      currentRoom = roomId;
      currentName = name;
      socket.join(roomId);
      emitPersonalizedStates(roomId, room);
      socket.emit('chat_history', room.chat);
      broadcastChat(roomId, null, `🃏 ${name} dołączył do stołu`);
    }
  });

  socket.on('start_game', () => {
    if (!currentRoom) return;
    const room = rooms[currentRoom];
    if (!room || room.game.phase !== 'waiting') return;
    if (room.game.activePlayers().length < 2) { socket.emit('error_msg', 'Potrzeba minimum 2 graczy'); return; }
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
    scheduleAutoFold(currentRoom, room);
    if (room.game.phase === 'showdown' && room.game.winners) {
      broadcastChat(currentRoom, null, room.game.winners.map(w => `🏆 ${w.name}: ${w.hand}`).join(' | '));
      setTimeout(() => {
        if (rooms[currentRoom]) {
          room.game.phase = 'waiting';
          room.readyPlayers.clear();
          emitPersonalizedStates(currentRoom, room);
        }
      }, 4000);
    }
  });

  socket.on('new_hand', () => {
    if (!currentRoom) return;
    const room = rooms[currentRoom];
    if (!room || room.game.phase !== 'waiting') return;
    const active = room.game.activePlayers();
    if (active.length < 2) { socket.emit('error_msg', 'Potrzeba minimum 2 graczy z żetonami'); return; }
    room.readyPlayers.add(socket.id);
    const readyCount = active.filter(p => room.readyPlayers.has(p.id)).length;
    emitPersonalizedStates(currentRoom, room);
    if (readyCount < active.length) {
      const p = room.game.players.find(p => p.id === socket.id);
      broadcastChat(currentRoom, null, `✋ ${p?.name} gotowy (${readyCount}/${active.length})`);
      return;
    }
    room.readyPlayers.clear();
    room.game.startHand();
    emitPersonalizedStates(currentRoom, room);
    broadcastChat(currentRoom, null, `🎰 Rozdanie #${room.game.handNum} rozpoczęte!`);
  });

  socket.on('chat_message', ({ text }) => {
    if (!currentRoom || !text?.trim()) return;
    const room = rooms[currentRoom];
    const player = room?.game.players.find(p => p.id === socket.id);
    broadcastChat(currentRoom, player?.name || currentName, text.trim().slice(0, 200));
  });

  socket.on('update_settings', ({ smallBlind, bigBlind, startingChips, turnSeconds }) => {
    if (!currentRoom) return;
    const room = rooms[currentRoom];
    if (!room || room.hostId !== socket.id) { socket.emit('error_msg', 'Tylko host może zmieniać ustawienia'); return; }
    if (room.game.phase !== 'waiting') { socket.emit('error_msg', 'Zmień ustawienia przed rozdaniem'); return; }
    if (smallBlind && bigBlind) {
      room.game.smallBlind = Math.max(1, parseInt(smallBlind));
      room.game.bigBlind = Math.max(2, parseInt(bigBlind));
    }
    if (startingChips) {
      room.game.startingChips = Math.max(100, parseInt(startingChips));
      for (const p of room.game.players) p.chips = room.game.startingChips;
    }
    if (turnSeconds) room.game.turnSeconds = Math.max(10, Math.min(120, parseInt(turnSeconds)));
    emitPersonalizedStates(currentRoom, room);
    broadcastChat(currentRoom, null, `⚙️ SB=${room.game.smallBlind} BB=${room.game.bigBlind}${startingChips?' Żetony='+room.game.startingChips:''}${room.game.turnSeconds?' Timer='+room.game.turnSeconds+'s':''}`);
  });

  socket.on('give_chips', ({ playerId, amount }) => {
    if (!currentRoom) return;
    const room = rooms[currentRoom];
    if (!room || room.hostId !== socket.id) return;
    const player = room.game.players.find(p => p.id === playerId);
    if (!player) return;
    player.chips += Math.max(1, parseInt(amount) || 0);
    if (player.chips > 0) player.folded = false;
    emitPersonalizedStates(currentRoom, room);
    broadcastChat(currentRoom, null, `💰 ${player.name} otrzymał ${amount} zł`);
  });

  socket.on('set_chips', ({ playerId, amount }) => {
    if (!currentRoom) return;
    const room = rooms[currentRoom];
    if (!room || room.hostId !== socket.id) return;
    const player = room.game.players.find(p => p.id === playerId);
    if (!player) return;
    player.chips = Math.max(0, parseInt(amount) || 0);
    player.folded = player.chips <= 0;
    emitPersonalizedStates(currentRoom, room);
    broadcastChat(currentRoom, null, `✏️ ${player.name} ma teraz ${player.chips} zł`);
  });

  socket.on('buyin', ({ amount }) => {
    if (!currentRoom) return;
    const room = rooms[currentRoom];
    if (!room) return;
    const player = room.game.players.find(p => p.id === socket.id);
    if (!player || player.chips > 0) return;
    player.chips = Math.max(100, Math.min(100000, parseInt(amount) || room.game.startingChips));
    player.folded = false;
    player.buyins = (player.buyins || 0) + 1;
    emitPersonalizedStates(currentRoom, room);
    broadcastChat(currentRoom, null, `🔄 ${player.name} dokupił ${player.chips} zł`);
  });

  socket.on('kick_player', ({ playerId }) => {
    if (!currentRoom) return;
    const room = rooms[currentRoom];
    if (!room || room.hostId !== socket.id) return;
    if (playerId === socket.id) return;
    const player = room.game.players.find(p => p.id === playerId);
    if (!player) return;
    const s = io.sockets.sockets.get(playerId);
    if (s) s.emit('kicked', { reason: 'Zostałeś wyrzucony przez hosta' });
    room.game.removePlayer(playerId);
    broadcastChat(currentRoom, null, `🚫 ${player.name} został wyrzucony`);
    emitPersonalizedStates(currentRoom, room);
  });

  function scheduleAutoFold(roomId, room) {
    if (room._autoFoldTimer) { clearTimeout(room._autoFoldTimer); room._autoFoldTimer = null; }
    const secs = room.game.turnSeconds || 30;
    const cpId = room.game.players[room.game.currentPlayerIndex]?.id;
    if (!cpId || room.game.phase === 'waiting' || room.game.phase === 'showdown') return;
    room._autoFoldTimer = setTimeout(() => {
      if (!rooms[roomId]) return;
      const r = rooms[roomId];
      const cp = r.game.players[r.game.currentPlayerIndex];
      if (!cp || cp.id !== cpId || r.game.phase === 'waiting' || r.game.phase === 'showdown') return;
      const canCheck = cp.bet >= r.game.currentBet;
      r.game.playerAction(cpId, canCheck ? 'check' : 'fold', 0);
      emitPersonalizedStates(roomId, r);
      broadcastChat(roomId, null, `⏱ ${cp.name} (${canCheck ? 'auto-check' : 'auto-fold'})`);
      scheduleAutoFold(roomId, r);
    }, secs * 1000);
  }

  socket.on('disconnect', () => {
    if (!currentRoom) return;
    const room = rooms[currentRoom];
    if (!room) return;
    const player = room.game.players.find(p => p.id === socket.id);
    if (!player) return;

    // During active hand - fold and keep in list so they can reconnect
    if (room.game.phase !== 'waiting' && room.game.phase !== 'showdown') {
      player.connected = 'away';
      // Auto-fold their turn if it's their turn
      if (room.game.players[room.game.currentPlayerIndex]?.id === socket.id) {
        room.game.playerAction(socket.id, 'fold', 0);
        scheduleAutoFold(currentRoom, room);
      }
      emitPersonalizedStates(currentRoom, room);
      broadcastChat(currentRoom, null, `📵 ${player.name} rozłączył się`);
    } else {
      // Between hands - remove after delay
      setTimeout(() => {
        if (!rooms[currentRoom]) return;
        const stillThere = room.game.players.find(p => p.id === socket.id);
        if (stillThere) {
          room.game.removePlayer(socket.id);
          if (room.hostId === socket.id && room.game.players.length > 0) {
            room.hostId = room.game.players[0].id;
            broadcastChat(currentRoom, null, `👑 ${room.game.players[0].name} jest hostem`);
          }
          broadcastChat(currentRoom, null, `👋 ${player.name} opuścił stół`);
          emitPersonalizedStates(currentRoom, room);
        }
      }, 15000);
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
    const readyIds = [...room.readyPlayers];
    for (const player of room.game.players) {
      const s = io.sockets.sockets.get(player.id);
      if (s) s.emit('game_state', {
        ...room.game.getState(player.id),
        isHost: player.id === room.hostId,
        readyPlayers: readyIds,
        iAmReady: room.readyPlayers.has(player.id),
        turnSeconds: room.game.turnSeconds || 30
      });
    }
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`♠ Poker server on port ${PORT}`));
