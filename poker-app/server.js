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
  upgradeTimeout: 30000,
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

    // Clear pending disconnect timer for returning player
    for (const p of room.game.players) {
      if (p.name === name && p._disconnectTimer) {
        clearTimeout(p._disconnectTimer);
        p._disconnectTimer = null;
      }
    }

    // Check if player is reconnecting (same name, different socket id)
    const existing = room.game.players.find(p => p.name === name && p.id !== socket.id);
    if (existing) {
      // Update socket ID in place - preserve cards, chips, everything
      if (room.hostId === existing.id) room.hostId = socket.id;
      if (room.readyPlayers.has(existing.id)) {
        room.readyPlayers.delete(existing.id);
        room.readyPlayers.add(socket.id);
      }
      existing.id = socket.id;
      existing.connected = true;
      // Only unfold if they have chips (not busted)
      if (existing.chips > 0 && room.game.phase === 'waiting') {
        existing.folded = false;
      }
    } else {
      // New player - remove stale disconnected slots first
      room.game.players = room.game.players.filter(p => p.connected !== false);
      const added = room.game.addPlayer(socket.id, name);
      if (!added && !room.game.players.find(p => p.id === socket.id)) {
        socket.emit('error_msg', 'Pokój jest pełny (max 8 graczy)');
        return;
      }
    }

    // Ensure connected = true
    const player = room.game.players.find(p => p.id === socket.id);
    if (player) player.connected = true;

    if (!room.hostId || !room.game.players.find(p => p.id === room.hostId)) {
      room.hostId = socket.id;
    }

    currentRoom = roomId;
    currentName = name;
    socket.join(roomId);
    emitPersonalizedStates(roomId, room);
    socket.emit('chat_history', room.chat);
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
    scheduleAutoFold(currentRoom, room);
    if (room.game.phase === 'showdown' && room.game.winners) {
      const msg = room.game.winners.map(w => `🏆 ${w.name}: ${w.hand}`).join(' | ');
      broadcastChat(currentRoom, null, msg);
      setTimeout(() => {
        if (rooms[currentRoom]) {
          room.game.phase = 'waiting';
          room.readyPlayers.clear();
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
    if (room.game.phase !== 'waiting') return;
    const activePlayers = room.game.activePlayers();
    if (activePlayers.length < 2) { socket.emit('error_msg', 'Potrzeba minimum 2 graczy z żetonami'); return; }
    room.readyPlayers.add(socket.id);
    const readyCount = activePlayers.filter(p => room.readyPlayers.has(p.id)).length;
    emitPersonalizedStates(currentRoom, room);
    if (readyCount < activePlayers.length) {
      broadcastChat(currentRoom, null, `✋ ${room.game.players.find(p=>p.id===socket.id)?.name} gotowy (${readyCount}/${activePlayers.length})`);
      return;
    }
    room.readyPlayers.clear();
    room.game.startHand();
    emitPersonalizedStates(currentRoom, room);
    broadcastChat(currentRoom, null, `🎰 Rozdanie #${room.game.handNum} rozpoczęte!`);
  });

  socket.on('update_settings', ({ smallBlind, bigBlind, startingChips, turnSeconds }) => {
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
      room.game.startingChips = chips;
      for (const p of room.game.players) p.chips = chips;
    }
    if (turnSeconds) room.game.turnSeconds = Math.max(10, Math.min(120, parseInt(turnSeconds)));
    emitPersonalizedStates(currentRoom, room);
    broadcastChat(currentRoom, null, `⚙️ Ustawienia: SB=${room.game.smallBlind} BB=${room.game.bigBlind}${startingChips ? ' Żetony='+parseInt(startingChips) : ''}${room.game.turnSeconds ? ' Timer='+room.game.turnSeconds+'s' : ''}`);
  });

  socket.on('set_chips', ({ playerId, amount }) => {
    if (!currentRoom) return;
    const room = rooms[currentRoom];
    if (!room || room.hostId !== socket.id) { socket.emit('error_msg', 'Tylko host może zmieniać żetony'); return; }
    const player = room.game.players.find(p => p.id === playerId);
    if (!player) return;
    const chips = Math.max(0, parseInt(amount) || 0);
    player.chips = chips;
    if (chips === 0) player.folded = true;
    else player.folded = false;
    emitPersonalizedStates(currentRoom, room);
    broadcastChat(currentRoom, null, `✏️ ${player.name} ma teraz ${chips.toLocaleString('pl-PL')} zł`);
  });

  socket.on('give_chips', ({ playerId, amount }) => {
    if (!currentRoom) return;
    const room = rooms[currentRoom];
    if (!room || room.hostId !== socket.id) { socket.emit('error_msg', 'Tylko host może dawać żetony'); return; }
    const player = room.game.players.find(p => p.id === playerId);
    if (!player) return;
    const chips = Math.max(1, parseInt(amount) || 0);
    player.chips += chips;
    if (player.folded && player.chips > 0) player.folded = false;
    emitPersonalizedStates(currentRoom, room);
    broadcastChat(currentRoom, null, `💰 ${player.name} otrzymał ${chips.toLocaleString('pl-PL')} zł od hosta`);
  });

  socket.on('buyin', ({ amount }) => {
    if (!currentRoom) return;
    const room = rooms[currentRoom];
    if (!room) return;
    const player = room.game.players.find(p => p.id === socket.id);
    if (!player) return;
    if (player.chips > 0) { socket.emit('error_msg', 'Masz jeszcze żetony!'); return; }
    const chips = Math.max(100, Math.min(100000, parseInt(amount) || room.game.startingChips));
    player.chips = chips;
    player.folded = false;
    player.buyins = (player.buyins || 0) + 1;
    emitPersonalizedStates(currentRoom, room);
    broadcastChat(currentRoom, null, `🔄 ${player.name} dokupił ${chips.toLocaleString('pl-PL')} zł`);
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

  function scheduleAutoFold(roomId, room) {
    if (room._autoFoldTimer) { clearTimeout(room._autoFoldTimer); room._autoFoldTimer = null; }
    const secs = room.game.turnSeconds || 30;
    const currentPId = room.game.players[room.game.currentPlayerIndex]?.id;
    if (!currentPId || room.game.phase === 'waiting' || room.game.phase === 'showdown') return;
    room._autoFoldTimer = setTimeout(() => {
      if (!rooms[roomId]) return;
      const r = rooms[roomId];
      const cp = r.game.players[r.game.currentPlayerIndex];
      if (!cp || cp.id !== currentPId) return;
      if (r.game.phase === 'waiting' || r.game.phase === 'showdown') return;
      const canCheck = cp.bet >= r.game.currentBet;
      const action = canCheck ? 'check' : 'fold';
      r.game.playerAction(currentPId, action, 0);
      emitPersonalizedStates(roomId, r);
      broadcastChat(roomId, null, `⏱ ${cp.name} przekroczył czas (${canCheck ? 'auto-check' : 'auto-fold'})`);
      scheduleAutoFold(roomId, r);
    }, secs * 1000);
  }

  socket.on('disconnect', () => {
    if (!currentRoom) return;
    const room = rooms[currentRoom];
    if (!room) return;
    const player = room.game.players.find(p => p.id === socket.id);
    if (!player) return;

    player._disconnectTimer = setTimeout(() => {
      const stillGone = room.game.players.find(p => p.id === socket.id);
      if (stillGone) {
        broadcastChat(currentRoom, null, `👋 ${player.name} opuścił stół`);
        room.game.removePlayer(socket.id);
        if (room.hostId === socket.id && room.game.players.length > 0) {
          room.hostId = room.game.players[0].id;
          broadcastChat(currentRoom, null, `👑 ${room.game.players[0].name} jest teraz hostem`);
        }
        emitPersonalizedStates(currentRoom, room);
      }
    }, 30000);

    player.connected = 'away';
    emitPersonalizedStates(currentRoom, room);
    broadcastChat(currentRoom, null, `📵 ${player.name} chwilowo niedostępny...`);
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
