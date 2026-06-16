'use strict';

const SUITS = ['♠','♥','♦','♣'];
const RANKS = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
const RANK_VAL = Object.fromEntries(RANKS.map((r,i) => [r, i+2]));

function createDeck() {
  const deck = [];
  for (const suit of SUITS)
    for (const rank of RANKS)
      deck.push({ rank, suit, val: RANK_VAL[rank] });
  return deck;
}

function shuffle(deck) {
  const d = [...deck];
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

// Hand evaluation - returns { rank, name, tiebreakers }
function evaluateHand(holeCards, communityCards) {
  const all = [...holeCards, ...communityCards];
  const best = bestFiveOf(all);
  return best;
}

function bestFiveOf(cards) {
  if (cards.length < 5) return null;
  let best = null;
  const combos = choose5(cards);
  for (const combo of combos) {
    const score = scoreHand(combo);
    if (!best || compareScore(score, best) > 0) best = score;
  }
  return best;
}

function choose5(cards) {
  const results = [];
  const n = cards.length;
  for (let a = 0; a < n-4; a++)
  for (let b = a+1; b < n-3; b++)
  for (let c = b+1; c < n-2; c++)
  for (let d = c+1; d < n-1; d++)
  for (let e = d+1; e < n; e++)
    results.push([cards[a],cards[b],cards[c],cards[d],cards[e]]);
  return results;
}

function scoreHand(five) {
  const vals = five.map(c => c.val).sort((a,b) => b-a);
  const suits = five.map(c => c.suit);
  const flush = suits.every(s => s === suits[0]);
  const straight = isStraight(vals);
  const counts = {};
  for (const v of vals) counts[v] = (counts[v]||0)+1;
  const groups = Object.entries(counts).sort((a,b) => b[1]-a[1] || b[0]-a[0]);
  const groupCounts = groups.map(g => +g[1]);

  if (flush && straight) {
    const isRoyal = vals[0]===14 && vals[1]===13;
    return { rank: isRoyal ? 9 : 8, name: isRoyal ? 'Royal Flush' : 'Straight Flush', tiebreakers: vals };
  }
  if (groupCounts[0]===4) return { rank:7, name:'Czwórka', tiebreakers: sortedByGroup(groups) };
  if (groupCounts[0]===3 && groupCounts[1]===2) return { rank:6, name:'Full House', tiebreakers: sortedByGroup(groups) };
  if (flush) return { rank:5, name:'Kolor', tiebreakers: vals };
  if (straight) return { rank:4, name:'Strit', tiebreakers: vals };
  if (groupCounts[0]===3) return { rank:3, name:'Trójka', tiebreakers: sortedByGroup(groups) };
  if (groupCounts[0]===2 && groupCounts[1]===2) return { rank:2, name:'Dwie pary', tiebreakers: sortedByGroup(groups) };
  if (groupCounts[0]===2) return { rank:1, name:'Para', tiebreakers: sortedByGroup(groups) };
  return { rank:0, name:'Wysoka karta', tiebreakers: vals };
}

function isStraight(sortedVals) {
  // normal straight
  if (sortedVals[0]-sortedVals[4]===4 && new Set(sortedVals).size===5) return true;
  // wheel A-2-3-4-5
  const s = new Set(sortedVals);
  if (s.has(14)&&s.has(2)&&s.has(3)&&s.has(4)&&s.has(5)) return true;
  return false;
}

function sortedByGroup(groups) {
  return groups.flatMap(g => Array(+g[1]).fill(+g[0]));
}

function compareScore(a, b) {
  if (a.rank !== b.rank) return a.rank - b.rank;
  for (let i = 0; i < Math.min(a.tiebreakers.length, b.tiebreakers.length); i++) {
    if (a.tiebreakers[i] !== b.tiebreakers[i]) return a.tiebreakers[i] - b.tiebreakers[i];
  }
  return 0;
}

// ---- Game State Machine ----

const PHASES = ['preflop','flop','turn','river','showdown'];

class PokerGame {
  constructor(roomId) {
    this.roomId = roomId;
    this.players = []; // { id, name, chips, cards, bet, folded, allIn, sitOut }
    this.deck = [];
    this.community = [];
    this.pot = 0;
    this.sidePots = [];
    this.phase = 'waiting';
    this.dealerIndex = -1;
    this.currentPlayerIndex = -1;
    this.smallBlind = 20;
    this.bigBlind = 40;
    this.currentBet = 0;
    this.minRaise = 40;
    this.handNum = 0;
    this.lastAction = null;
    this.winners = null;
  }

  addPlayer(id, name) {
    if (this.players.find(p => p.id === id)) return false;
    if (this.players.length >= 8) return false;
    this.players.push({ id, name, chips: 2000, cards: [], bet: 0, folded: false, allIn: false, sitOut: false, connected: true });
    return true;
  }

  removePlayer(id) {
    const idx = this.players.findIndex(p => p.id === id);
    if (idx === -1) return;
    if (this.phase === 'waiting' || this.phase === 'showdown') {
      this.players.splice(idx, 1);
    } else {
      this.players[idx].connected = false;
      this.players[idx].folded = true;
      if (this.currentPlayerIndex === idx) this.advanceTurn();
    }
  }

  canStart() {
    return this.activePlayers().length >= 2 && this.phase === 'waiting';
  }

  activePlayers() {
    return this.players.filter(p => !p.sitOut && p.chips > 0 && p.connected);
  }

  inHandPlayers() {
    return this.players.filter(p => !p.folded && !p.sitOut);
  }

  startHand() {
    this.handNum++;
    this.deck = shuffle(createDeck());
    this.community = [];
    this.pot = 0;
    this.sidePots = [];
    this.currentBet = 0;
    this.minRaise = this.bigBlind;
    this.winners = null;
    this.lastAction = null;

    for (const p of this.players) {
      p.cards = [];
      p.bet = 0;
      p.folded = p.chips <= 0 || !p.connected;
      p.allIn = false;
    }

    const active = this.activePlayers();
    this.dealerIndex = (this.dealerIndex + 1) % this.players.length;
    // Make sure dealer is active
    while (!active.find(p => p === this.players[this.dealerIndex])) {
      this.dealerIndex = (this.dealerIndex + 1) % this.players.length;
    }

    // Deal 2 cards each
    for (let i = 0; i < 2; i++)
      for (const p of active)
        p.cards.push(this.deck.pop());

    // Post blinds
    const sbIdx = this.nextActiveFrom(this.dealerIndex, 1);
    const bbIdx = this.nextActiveFrom(this.dealerIndex, 2);
    this.postBlind(sbIdx, this.smallBlind);
    this.postBlind(bbIdx, this.bigBlind);
    this.currentBet = this.bigBlind;
    this.minRaise = this.bigBlind;

    // First to act preflop: player after BB
    this.currentPlayerIndex = this.nextActiveFrom(bbIdx, 1);
    this.phase = 'preflop';
    this.bettingStartIndex = this.currentPlayerIndex;
    this.lastRaiserIndex = bbIdx;

    return this.getState();
  }

  nextActiveFrom(fromIdx, steps = 1) {
    let idx = fromIdx;
    let found = 0;
    while (found < steps) {
      idx = (idx + 1) % this.players.length;
      if (!this.players[idx].folded && !this.players[idx].sitOut && this.players[idx].chips >= 0 && this.players[idx].connected) found++;
    }
    return idx;
  }

  postBlind(playerIdx, amount) {
    const p = this.players[playerIdx];
    const actual = Math.min(p.chips, amount);
    p.chips -= actual;
    p.bet += actual;
    this.pot += actual;
    if (p.chips === 0) p.allIn = true;
  }

  playerAction(playerId, action, amount) {
    const pIdx = this.players.findIndex(p => p.id === playerId);
    if (pIdx !== this.currentPlayerIndex) return { error: 'Not your turn' };
    const p = this.players[pIdx];
    if (p.folded) return { error: 'You folded' };

    if (action === 'fold') {
      p.folded = true;
    } else if (action === 'check') {
      if (this.currentBet > p.bet) return { error: 'Cannot check, must call or raise' };
    } else if (action === 'call') {
      const toCall = Math.min(this.currentBet - p.bet, p.chips);
      p.chips -= toCall;
      p.bet += toCall;
      this.pot += toCall;
      if (p.chips === 0) p.allIn = true;
    } else if (action === 'raise') {
      const raiseTotal = Math.min(amount, p.chips + p.bet);
      if (raiseTotal < this.currentBet + this.minRaise && raiseTotal < p.chips + p.bet)
        return { error: `Min raise to ${this.currentBet + this.minRaise}` };
      const toAdd = raiseTotal - p.bet;
      this.minRaise = raiseTotal - this.currentBet;
      this.currentBet = raiseTotal;
      p.chips -= toAdd;
      p.bet += toAdd;
      this.pot += toAdd;
      this.lastRaiserIndex = pIdx;
      if (p.chips === 0) p.allIn = true;
    } else if (action === 'allIn') {
      const toAdd = p.chips;
      if (p.bet + toAdd > this.currentBet) {
        this.minRaise = Math.max(this.minRaise, (p.bet + toAdd) - this.currentBet);
        this.currentBet = p.bet + toAdd;
        this.lastRaiserIndex = pIdx;
      }
      p.bet += toAdd;
      this.pot += toAdd;
      p.chips = 0;
      p.allIn = true;
    }

    this.lastAction = { playerId, playerName: p.name, action, amount: p.bet };

    return this.advanceTurn();
  }

  advanceTurn() {
    const inHand = this.inHandPlayers();
    
    // Only one player left
    if (inHand.length === 1) {
      return this.awardPot(inHand);
    }

    // Check if betting round is over
    const canAct = inHand.filter(p => !p.allIn);
    const allCalled = canAct.every(p => p.bet === this.currentBet);
    const nextIdx = this.nextActiveNonAllIn(this.currentPlayerIndex);

    if (allCalled || canAct.length === 0) {
      return this.nextPhase();
    }

    // Check if we've gone around to the last raiser
    if (nextIdx === this.lastRaiserIndex && allCalled) {
      return this.nextPhase();
    }

    this.currentPlayerIndex = nextIdx;
    return this.getState();
  }

  nextActiveNonAllIn(fromIdx) {
    let idx = fromIdx;
    for (let i = 0; i < this.players.length; i++) {
      idx = (idx + 1) % this.players.length;
      const p = this.players[idx];
      if (!p.folded && !p.allIn && !p.sitOut && p.connected) return idx;
    }
    return fromIdx;
  }

  nextPhase() {
    const phaseOrder = ['preflop','flop','turn','river','showdown'];
    const next = phaseOrder[phaseOrder.indexOf(this.phase) + 1];

    // Reset bets for new street
    for (const p of this.players) p.bet = 0;
    this.currentBet = 0;
    this.minRaise = this.bigBlind;

    if (next === 'flop') {
      this.community.push(this.deck.pop(), this.deck.pop(), this.deck.pop());
    } else if (next === 'turn' || next === 'river') {
      this.community.push(this.deck.pop());
    } else if (next === 'showdown') {
      return this.showdown();
    }

    this.phase = next;
    // First to act post-flop: first active left of dealer
    this.currentPlayerIndex = this.nextActiveFrom(this.dealerIndex, 1);
    // Skip if only all-in players
    const canAct = this.inHandPlayers().filter(p => !p.allIn);
    if (canAct.length <= 1) return this.nextPhase();
    this.lastRaiserIndex = this.currentPlayerIndex;
    return this.getState();
  }

  showdown() {
    this.phase = 'showdown';
    const inHand = this.inHandPlayers();
    // Evaluate hands
    const scored = inHand.map(p => ({
      player: p,
      score: evaluateHand(p.cards, this.community)
    }));
    scored.sort((a,b) => compareScore(b.score, a.score));
    // Simple: winner takes all pot (no side pots for now in display)
    const winner = scored[0].player;
    winner.chips += this.pot;
    this.winners = scored.map(s => ({ id: s.player.id, name: s.player.name, hand: s.score.name, cards: s.player.cards }));
    this.pot = 0;
    return this.getState();
  }

  awardPot(players) {
    this.phase = 'showdown';
    players[0].chips += this.pot;
    this.winners = [{ id: players[0].id, name: players[0].name, hand: 'Wszyscy spasowali', cards: [] }];
    this.pot = 0;
    return this.getState();
  }

  getState(forPlayerId) {
    return {
      roomId: this.roomId,
      phase: this.phase,
      pot: this.pot,
      community: this.community,
      currentBet: this.currentBet,
      minRaise: this.minRaise,
      currentPlayerId: this.players[this.currentPlayerIndex]?.id || null,
      dealerIndex: this.dealerIndex,
      handNum: this.handNum,
      lastAction: this.lastAction,
      winners: this.winners,
      players: this.players.map((p, i) => ({
        id: p.id,
        name: p.name,
        chips: p.chips,
        bet: p.bet,
        folded: p.folded,
        allIn: p.allIn,
        connected: p.connected,
        cardCount: p.cards.length,
        isDealer: i === this.dealerIndex,
        // Reveal cards only in showdown or to the player themselves
        cards: (this.phase === 'showdown' && !p.folded) ? p.cards : (forPlayerId === p.id ? p.cards : null)
      })),
      smallBlind: this.smallBlind,
      bigBlind: this.bigBlind,
    };
  }
}

module.exports = { PokerGame };
