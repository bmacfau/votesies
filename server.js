const express = require('express');
const path = require('path');
const crypto = require('crypto');
const gamesDB = require('./gamesDatabase');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'frontend')));

const gameLists = require('./predefinedGames');

// Fast lookup: game id → full game object
const gameDBMap = Object.fromEntries(gamesDB.map(g => [g.id, g]));

// In-memory session store: { [code]: session }
const sessions = {};

function generateCode() {
  // 4 uppercase hex characters, e.g. "A1B2"
  return crypto.randomBytes(2).toString('hex').toUpperCase();
}

// Create a new session (host)
app.post('/api/session/create', (req, res) => {
  const { hostName } = req.body;
  if (!hostName || !hostName.trim()) {
    return res.status(400).json({ error: 'Host name is required' });
  }
  const code = generateCode();
  const hostId = crypto.randomUUID();
  sessions[code] = {
    code,
    hostId,
    players: [{ id: hostId, name: hostName.trim(), isHost: true, hasVoted: false, ranking: [] }],
    gameListName: null,
    games: [],
    status: 'lobby', // lobby | voting | results
    results: null,
    createdAt: Date.now(),
  };
  res.json({ code, hostId });
});

// Get session state
app.get('/api/session/:code', (req, res) => {
  const session = sessions[req.params.code.toUpperCase()];
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json(session);
});

// Join a session
app.post('/api/session/:code/join', (req, res) => {
  const session = sessions[req.params.code.toUpperCase()];
  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (session.status !== 'lobby') return res.status(400).json({ error: 'Session has already started' });

  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });

  const playerId = crypto.randomUUID();
  session.players.push({ id: playerId, name: name.trim(), isHost: false, hasVoted: false, ranking: [] });
  res.json({ playerId });
});

// Host starts voting
app.post('/api/session/:code/start', (req, res) => {
  const session = sessions[req.params.code.toUpperCase()];
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const { hostId, gameListName, customGames, vibes, votingMode } = req.body;
  if (session.hostId !== hostId) return res.status(403).json({ error: 'Only the host can start voting' });
  if (session.status !== 'lobby') return res.status(400).json({ error: 'Session already started' });

  let games;
  if (customGames) {
    if (!Array.isArray(customGames) || customGames.length < 2) {
      return res.status(400).json({ error: 'Custom list needs at least 2 games' });
    }
    // Enrich with full metadata from database
    games = customGames.map(g => gameDBMap[g.id] || g);
  } else {
    const ids = gameLists[gameListName];
    if (!ids) return res.status(400).json({ error: 'Invalid game list' });
    // Resolve IDs to full game objects
    games = ids.map(id => gameDBMap[id]).filter(Boolean);
  }

  if (Array.isArray(vibes)) {
    if (vibes.includes('sexy-time'))      games.push({ id: 'vibe-sexy-time',      name: '🔥 Sexy Time' });
    if (vibes.includes('more-votesies')) games.push({ id: 'vibe-more-votesies', name: '🗳️ More Votesies' });
  }

  session.gameListName = gameListName || 'Custom';
  session.games = games;
  session.votingMode = votingMode === 'approval' ? 'approval' : 'ranked';
  session.status = 'voting';
  res.json({ ok: true });
});

// Search local games database
app.get('/api/bgg/search', (req, res) => {
  const q = req.query.q?.trim().toLowerCase() || '';
  const players = parseInt(req.query.players);

  let results = gamesDB;
  if (q) results = results.filter(g => g.name.toLowerCase().includes(q));
  if (players) results = results.filter(g => g.minPlayers <= players && g.maxPlayers >= players);

  res.json(results.slice(0, 20));
});

// Submit a vote (ranked list of game IDs)
app.post('/api/session/:code/vote', (req, res) => {
  const session = sessions[req.params.code.toUpperCase()];
  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (session.status !== 'voting') return res.status(400).json({ error: 'Not currently voting' });

  const { playerId, ranking } = req.body;
  const player = session.players.find(p => p.id === playerId);
  if (!player) return res.status(404).json({ error: 'Player not found in session' });
  if (player.hasVoted) return res.status(400).json({ error: 'You have already voted' });

  player.ranking = ranking;
  player.hasVoted = true;

  const allVoted = session.players.every(p => p.hasVoted);
  if (allVoted) {
    session.results = calculateResults(session);
    session.status = 'results';
  }

  res.json({ ok: true, allVoted });
});

// Get available game list names
app.get('/api/gamelists', (req, res) => {
  res.json(Object.keys(gameLists));
});

// Get games in a specific list (resolved to full objects)
app.get('/api/gamelists/:name', (req, res) => {
  const ids = gameLists[req.params.name];
  if (!ids) return res.status(404).json({ error: 'List not found' });
  res.json(ids.map(id => gameDBMap[id]).filter(Boolean));
});

function calculateResults(session) {
  if (session.votingMode === 'approval') {
    // Approval voting: count how many players approved each game
    const scores = {};
    session.games.forEach(g => { scores[g.id] = 0; });
    session.players.forEach(player => {
      player.ranking.forEach(gameId => {
        if (scores[gameId] !== undefined) scores[gameId]++;
      });
    });
    return session.games
      .map(g => ({ ...g, score: scores[g.id] }))
      .sort((a, b) => b.score - a.score);
  }

  // Borda count: rank 1 = (N-1) pts, rank 2 = (N-2) pts, ..., rank N = 0 pts
  const n = session.games.length;
  const scores = {};
  session.games.forEach(g => { scores[g.id] = 0; });

  session.players.forEach(player => {
    player.ranking.forEach((gameId, index) => {
      if (scores[gameId] !== undefined) {
        scores[gameId] += n - 1 - index;
      }
    });
  });

  return session.games
    .map(g => ({ ...g, score: scores[g.id] }))
    .sort((a, b) => b.score - a.score);
}

app.listen(PORT, () => {
  console.log(`Votesies running at http://localhost:${PORT}`);
});