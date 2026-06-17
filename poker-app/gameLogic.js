'use strict';

const SUITS = ['♠','♥','♦','♣'];
const RANKS = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
const RANK_VAL = Object.fromEntries(RANKS.map((r,i) => [r, i+2]));
const RANK_NAME = { 14:'As', 13:'Król', 12:'Dama', 11:'Walet', 10:'10', 9:'9', 8:'8', 7:'7', 6:'6', 5:'5', 4:'4', 3:'3', 2:'2' };

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

function evaluateHand(holeCards, communityCards) {
  const all = [...holeCards, ...communityCards];
  return bestFiveOf(all);
}

function bestFiveOf(cards) {
  if (cards.length < 5) return null;
  let best = null;
  for (const combo of choose5(cards)) {
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

function handDescription(name, tiebreakers, groups) {
  // Build human-readable description, e.g. "Para Asów", "Dwie pary: Królów i Damów"
  const rn = (v) => RANK_NAME[v] || v;
  const plural = (v) => {
    const m = { 14:'Asów', 13:'Królów', 12:'Dam', 11:'Waletów', 10:'Dziesiątek',
      9:'Dziewiątek', 8:'Ósemek', 7:'Siódemek', 6:'Szóstek', 5:'Piątek',
      4:'Czwórek', 3:'Trójek', 2:'Dwójek' };
    return m[v] || v+'ch';
  };

  if (name === 'Royal Flush') return 'Royal Flush';
  if (name === 'Straight Flush') return `Poker do ${rn(tiebreakers[0])}`;
  if (name === 'Czwórka') return `Czwórka ${plural(tiebreakers[0])}`;
  if (name === 'Full House') return `Full House: ${plural(tiebreakers[0])} i ${plural(tiebreakers[3])}`;
  if (name === 'Kolor') return `Kolor do ${rn(tiebreakers[0])}`;
  if (name === 'Strit') return `Strit do ${rn(tiebreakers[0])}`;
  if (name === 'Trójka') return `Trójka ${plural(tiebreakers[0])}`;
  if (name === 'Dwie pary') return `Dwie pary: ${plural(tiebreakers[0])} i ${plural(tiebreakers[2])}`;
  if (name === 'Para') return `Para ${plural(tiebreakers[0])}`;
  if (name === 'Wysoka karta') return `Wysoka karta: ${rn(tiebreakers[0])}`;
  return name;
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
  const tb = sortedByGroup(groups);

  let result;
  if (flush && straight) {
    const isRoyal = vals[0]===14 && vals[1]===13;
    result = { rank: isRoyal?9:8, name: isRoyal?'Royal Flush':'Straight Flush', tiebreakers: vals };
  } else if (groupCounts[0]===4) {
    result = { rank:7, name:'Czwórka', tiebreakers: tb };
  } else if (groupCounts[0]===3 && groupCounts[1]===2) {
    result = { rank:6, name:'Full House', tiebreakers: tb };
  } else if (flush) {
    result = { rank:5, name:'Kolor', tiebreakers: vals };
  } else if (straight) {
    result = { rank:4, name:'Strit', tiebreakers: vals };
  } else if (groupCounts[0]===3) {
    result = { rank:3, name:'Trójka', tiebreakers: tb };
  } else if (groupCounts[0]===2 && groupCounts[1]===2) {
    result = { rank:2, name:'Dwie pary', tiebreakers: tb };
  } else if (groupCounts[0]===2) {
    result = { rank:1, name:'Para', tiebreakers: tb };
  } else {
    result = { rank:0, name:'Wysoka karta', tiebreakers: vals };
  }

  result.description = handDescription(result.name, result.tiebreakers, groups);
  return result;
}

function isStraight(sortedVals) {
  if (sortedVals[0]-sortedVals[4]===4 && new Set(sortedVals).size===5) return true;
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

class PokerGame {
  constructor(roomId) {
    this.roomId = roomId;
    this.players = [];
    this.deck = [];
    this.community = [];
    this.pot = 0;
    this.phase = 'waiting';
    this.dealerIndex = -1;
    this.currentPlayerIndex = -1;
    this.smallBlind = 50;
    this.bigBlind = 100;
    this.currentBet = 0;
    this.minRaise = 100;
    this.handNum = 0;
    this.lastAction = null;
    this.winners = null;
    this.actedThisStreet = new Set();
    this.startingChips = 5000;
  }

  addPlayer(id, name) {
    if (this.players.find(p => p.id === id)) return false;
    if (this.players.length >= 8) return false;
    this.players.push({ id, name, chips: this.startingChips, cards: [], bet: 0, folded: false, allIn: false, sitOut: false, connected: true, buyins: 0 });
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

  activePlayers() {
    return this.players.filter(p => !p.sitOut && p.chips > 0 && p.connected !== false);
  }

  inHandPlayers() {
    return this.players.filter(p => !p.folded && !p.sitOut && p.connected !== false);
  }

  startHand() {
    this.handNum++;
    this.deck = shuffle(createDeck());
    this.community = [];
    this.pot = 0;
    this.currentBet = 0;
    this.minRaise = this.bigBlind;
    this.winners = null;
    this.lastAction = null;
    this.actedThisStreet = new Set();
    // Save chips before hand for delta calculation
    this.chipsBeforeHand = {};
    for (const p of this.players) this.chipsBeforeHand[p.id] = p.chips;

    for (const p of this.players) {
      p.cards = [];
      p.bet = 0;
      p.totalBet = 0;
      p.folded = p.chips <= 0 || p.connected === false;
      p.allIn = false;
    }

    const active = this.activePlayers();
    this.dealerIndex = (this.dealerIndex + 1) % this.players.length;
    let safety = 0;
    while (!active.find(p => p === this.players[this.dealerIndex])) {
      this.dealerIndex = (this.dealerIndex + 1) % this.players.length;
      if (++safety > 20) break;
    }

    for (let i = 0; i < 2; i++)
      for (const p of active)
        p.cards.push(this.deck.pop());

    const sbIdx = this.nextActiveFrom(this.dealerIndex, 1);
    const bbIdx = this.nextActiveFrom(this.dealerIndex, 2);
    this.postBlind(sbIdx, this.smallBlind);
    this.postBlind(bbIdx, this.bigBlind);
    this.currentBet = this.bigBlind;
    this.minRaise = this.bigBlind;

    this.actedThisStreet = new Set();
    this.actedThisStreet.add(this.players[sbIdx].id);
    this.lastAggressorId = this.players[bbIdx].id; // BB is initial aggressor preflop
    this.hadAggression = false; // no raise yet

    this.currentPlayerIndex = this.nextActiveFrom(bbIdx, 1);
    this.phase = 'preflop';
    return this.getState();
  }

  nextActiveFrom(fromIdx, steps = 1) {
    let idx = fromIdx, found = 0, safety = 0;
    while (found < steps) {
      idx = (idx + 1) % this.players.length;
      const p = this.players[idx];
      if (p && !p.folded && !p.sitOut && p.chips >= 0 && p.connected !== false) found++;
      if (++safety > 100) break;
    }
    return idx;
  }

  postBlind(playerIdx, amount) {
    const p = this.players[playerIdx];
    const actual = Math.min(p.chips, amount);
    p.chips -= actual; p.bet += actual; p.totalBet = (p.totalBet||0) + actual; this.pot += actual;
    if (p.chips === 0) p.allIn = true;
  }

  playerAction(playerId, action, amount) {
    const pIdx = this.players.findIndex(p => p.id === playerId);
    if (pIdx !== this.currentPlayerIndex) return { error: 'Nie twoja kolej' };
    const p = this.players[pIdx];
    if (p.folded) return { error: 'Już spasowałeś' };

    if (action === 'fold') {
      p.folded = true;
    } else if (action === 'check') {
      if (this.currentBet > p.bet) return { error: 'Nie możesz check' };
    } else if (action === 'call') {
      const toCall = Math.min(this.currentBet - p.bet, p.chips);
      p.chips -= toCall; p.bet += toCall; p.totalBet = (p.totalBet||0) + toCall; this.pot += toCall;
      if (p.chips === 0) p.allIn = true;
    } else if (action === 'raise') {
      const raiseTotal = Math.min(amount, p.chips + p.bet);
      if (raiseTotal < this.currentBet + this.minRaise && raiseTotal < p.chips + p.bet)
        return { error: `Min raise to ${this.currentBet + this.minRaise}` };
      const toAdd = raiseTotal - p.bet;
      this.minRaise = raiseTotal - this.currentBet;
      this.currentBet = raiseTotal;
      p.chips -= toAdd; p.bet += toAdd; p.totalBet = (p.totalBet||0) + toAdd; this.pot += toAdd;
      if (p.chips === 0) p.allIn = true;
      this.actedThisStreet = new Set([playerId]);
      this.lastAggressorId = playerId;
      this.hadAggression = true;
    } else if (action === 'allIn') {
      const toAdd = p.chips;
      if (p.bet + toAdd > this.currentBet) {
        this.minRaise = Math.max(this.minRaise, (p.bet + toAdd) - this.currentBet);
        this.currentBet = p.bet + toAdd;
        this.actedThisStreet = new Set([playerId]);
        this.lastAggressorId = playerId;
        this.hadAggression = true;
      }
      p.bet += toAdd; p.totalBet = (p.totalBet||0) + toAdd; this.pot += toAdd; p.chips = 0; p.allIn = true;
    }

    this.actedThisStreet.add(playerId);
    this.lastAction = { playerId, playerName: p.name, action, amount: p.bet };
    return this.advanceTurn();
  }

  advanceTurn() {
    const inHand = this.inHandPlayers();
    if (inHand.length === 1) return this.awardPot(inHand);
    const canAct = inHand.filter(p => !p.allIn);
    if (canAct.length === 0) return this.nextPhase();
    const allActed = canAct.every(p => this.actedThisStreet.has(p.id));
    const allMatched = canAct.every(p => p.bet === this.currentBet);
    if (allActed && allMatched) return this.nextPhase();
    this.currentPlayerIndex = this.nextActiveNonAllIn(this.currentPlayerIndex);
    return this.getState();
  }

  nextActiveNonAllIn(fromIdx) {
    let idx = fromIdx;
    for (let i = 0; i < this.players.length; i++) {
      idx = (idx + 1) % this.players.length;
      const p = this.players[idx];
      if (p && !p.folded && !p.allIn && !p.sitOut && p.connected !== false) return idx;
    }
    return fromIdx;
  }

  nextPhase() {
    const phaseOrder = ['preflop','flop','turn','river','showdown'];
    const next = phaseOrder[phaseOrder.indexOf(this.phase) + 1];
    for (const p of this.players) p.bet = 0;
    this.currentBet = 0; this.minRaise = this.bigBlind; this.actedThisStreet = new Set();
    this.lastAggressorId = null; this.hadAggression = false;
    if (next === 'flop') this.community.push(this.deck.pop(), this.deck.pop(), this.deck.pop());
    else if (next === 'turn' || next === 'river') this.community.push(this.deck.pop());
    else if (next === 'showdown') return this.showdown();
    this.phase = next;
    this.currentPlayerIndex = this.nextActiveFrom(this.dealerIndex, 1);
    const canAct = this.inHandPlayers().filter(p => !p.allIn);
    if (canAct.length === 0) return this.nextPhase();
    return this.getState();
  }

  showdown() {
    this.phase = 'showdown';
    const inHand = this.inHandPlayers();

    // Score all hands
    const scored = inHand.map(p => ({
      player: p,
      score: evaluateHand(p.cards, this.community)
    }));
    scored.sort((a,b) => compareScore(b.score, a.score));

    // Determine who must show cards:
    // - If there was aggression (raise): only the aggressor must show + winner must show
    // - If no aggression (all checked): everyone shows
    const mustShow = new Set();
    if (this.hadAggression && this.lastAggressorId) {
      mustShow.add(this.lastAggressorId);
      mustShow.add(scored[0].player.id); // winner always shows
    } else {
      // All checked - everyone shows
      for (const s of scored) mustShow.add(s.player.id);
    }

    // Build side pots
    // Each player can only win up to their totalBet from each other player
    const allPlayers = this.players.filter(p => (p.totalBet||0) > 0);
    const winnerIds = new Set();

    // Process pots from smallest all-in upward
    const sortedByBet = [...allPlayers].sort((a,b) => (a.totalBet||0) - (b.totalBet||0));
    let remaining = {}; // playerId -> totalBet remaining to distribute
    for (const p of allPlayers) remaining[p.id] = p.totalBet || 0;

    let processedLevel = 0;
    const sidePots = [];

    for (const capPlayer of sortedByBet) {
      const cap = (capPlayer.totalBet || 0) - processedLevel;
      if (cap <= 0) continue;
      let potSize = 0;
      for (const p of allPlayers) {
        const contrib = Math.min(remaining[p.id] || 0, cap);
        potSize += contrib;
        remaining[p.id] = (remaining[p.id] || 0) - contrib;
      }
      if (potSize > 0) {
        // Eligible winners for this pot: must be in hand and have totalBet >= this level
        const eligible = scored.filter(s => !s.player.folded && (s.player.totalBet||0) >= capPlayer.totalBet);
        sidePots.push({ amount: potSize, eligible });
      }
      processedLevel += cap;
    }

    // Award each side pot to best eligible hand
    for (const pot of sidePots) {
      if (pot.eligible.length === 0) continue;
      const potWinner = pot.eligible[0]; // already sorted by score desc
      potWinner.player.chips += pot.amount;
      winnerIds.add(potWinner.player.id);
    }

    this.winners = scored.map(s => ({
      id: s.player.id,
      name: s.player.name,
      hand: s.score ? s.score.description : 'Wysoka karta',
      cards: mustShow.has(s.player.id) ? s.player.cards : [],
      showCards: mustShow.has(s.player.id),
      isWinner: winnerIds.has(s.player.id)
    }));
    this.pot = 0;
    return this.getState();
  }

  awardPot(players) {
    this.phase = 'showdown';
    players[0].chips += this.pot;
    this.winners = [{ id: players[0].id, name: players[0].name, hand: 'Wszyscy spasowali', cards: [], isWinner: true }];
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
        buyins: p.buyins || 0,
        cards: (this.phase === 'showdown' && !p.folded && this.winners && this.winners.find(w=>w.id===p.id&&w.showCards)) ? p.cards : (forPlayerId === p.id ? p.cards : [])
      })),
      smallBlind: this.smallBlind,
      bigBlind: this.bigBlind,
      startingChips: this.startingChips,
      chipsBeforeHand: this.chipsBeforeHand || {},
    };
  }
}

module.exports = { PokerGame };
