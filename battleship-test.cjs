#!/usr/bin/env node

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function now() {
  return new Date().toISOString();
}

function log(...args) {
  console.log(`[${now()}] [battleship-test]`, ...args);
}

function fail(...args) {
  console.error(`[${now()}] [battleship-test] ERROR:`, ...args);
  process.exit(1);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getEnv(name, fallback) {
  const val = process.env[name];
  if (val == null || val === '') return fallback;
  return val;
}

function loadChainDataIfPresent() {
  const dataPath = path.join(__dirname, 'data.txt');
  if (!fs.existsSync(dataPath)) return null;

  const content = fs.readFileSync(dataPath, 'utf8');
  const data = {};
  for (const line of content.split('\n')) {
    const match = line.match(/^([A-Z_]+)=(.+)$/);
    if (match) data[match[1]] = match[2];
  }
  return data;
}

function mustEnv(name) {
  const val = process.env[name];
  if (val == null || val === '') fail(`Missing environment variable: ${name}`);
  return val;
}

function curlGraphqlResponse(endpoint, query) {
  const body = JSON.stringify({ query });
  const args = [
    '-sS',
    '-X',
    'POST',
    endpoint,
    '-H',
    'Content-Type: application/json',
    '--data-binary',
    body,
  ];
  const raw = execFileSync('curl', args, { encoding: 'utf8' });
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Non-JSON response from ${endpoint}: ${raw.slice(0, 500)}`);
  }
  if (parsed.errors) {
    const preview = JSON.stringify(parsed.errors, null, 2);
    throw new Error(`GraphQL errors: ${preview}`);
  }
  return parsed;
}

function curlGraphql(endpoint, query) {
  return curlGraphqlResponse(endpoint, query).data;
}

function tryCurlGraphql(endpoint, query) {
  try {
    return curlGraphql(endpoint, query);
  } catch (e) {
    return null;
  }
}

function tryCurlGraphqlResponse(endpoint, query) {
  try {
    return curlGraphqlResponse(endpoint, query);
  } catch (e) {
    return null;
  }
}

function extractTxHash(data, operationName) {
  if (typeof data === 'string') return data;
  if (!data || typeof data !== 'object') return null;
  if (!operationName) return null;
  const v = data[operationName];
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object' && typeof v.hash === 'string') return v.hash;
  return null;
}

async function waitUntil(label, fn, { timeoutMs = 60000, intervalMs = 700 } = {}) {
  const start = Date.now();
  let lastErr = null;
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fn();
      if (res) return res;
    } catch (e) {
      lastErr = e;
    }
    await sleep(intervalMs);
  }
  if (lastErr) throw lastErr;
  throw new Error(`Timeout waiting for: ${label}`);
}

function normEnum(v) {
  return String(v || '')
    .trim()
    .replace(/[^a-zA-Z0-9]/g, '')
    .toLowerCase();
}

function enumIs(v, expected) {
  return normEnum(v) === normEnum(expected);
}

function axisToGql(axis) {
  const a = String(axis || '').trim().toLowerCase();
  if (a === 'vert' || a === 'v' || a.startsWith('ver')) return 'VERT';
  if (a === 'horiz' || a === 'h' || a.startsWith('hor')) return 'HORIZ';
  if (a === 'vertical') return 'VERT';
  if (a === 'horizontal') return 'HORIZ';
  if (a === 'vert_') return 'VERT';
  if (a === 'horiz_') return 'HORIZ';
  if (a === 'vert') return 'VERT';
  return 'HORIZ';
}

function shipsToGql(ships) {
  const parts = ships.map(
    (s) => `{row:${s.row},col:${s.col},length:${s.length},axis:${axisToGql(s.axis)}}`
  );
  return `[${parts.join(',')}]`;
}

function getCell(view, row, col) {
  const idx = row * view.size + col;
  return view.cells[idx];
}

async function run() {
  const APP_ID = getEnv(
    'BATTLESHIP_APP_ID',
    process.env.VITE_BATTLESHIP_APPLICATION_ID ||
      process.env.BATTLESHIP_APPLICATION_ID ||
      '023e90372f10763584078bd6bb818f7ac9da502a6e79c79bebd648af2f6920e4'
  );
  if (!APP_ID) {
    fail('Set BATTLESHIP_APP_ID (or VITE_BATTLESHIP_APPLICATION_ID) to your app id');
  }

  const MATCHMAKING_APP_ID = getEnv(
    'MATCHMAKING_APP_ID',
    process.env.VITE_MATCHMAKING_APPLICATION_ID ||
      process.env.MATCHMAKING_APPLICATION_ID ||
      '09fcfae259cc3a84cff33ed4ef1c0762bf072eba8832e4d257c79ceb4188504b'
  );

  const fromFile = loadChainDataIfPresent() || {};

  const MAIN_CHAIN = getEnv(
    'MAIN_CHAIN',
    fromFile.MAIN_CHAIN ||
      '3d3fbc6d744054032f4f67728fef0760bc32c8081d43f25b593d575d80b42989'
  );
  const AUTHOR_CHAIN = getEnv(
    'AUTHOR_CHAIN',
    fromFile.AUTHOR_CHAIN ||
      '4d55424a444348ab6dd16d94e3fdf43e3935d3dc04d945d38b6284aea41044ef'
  );
  const BUYER_CHAIN = getEnv(
    'BUYER_CHAIN',
    fromFile.BUYER_CHAIN ||
      'da85e35912f6c4b01fd20e08a6e60ad1b487ca21042bb2090adda67cf0adc0b6'
  );

  const MAIN_PORT = getEnv('MAIN_PORT', fromFile.MAIN_PORT || '7071');
  const AUTHOR_PORT = getEnv('AUTHOR_PORT', fromFile.AUTHOR_PORT || '7072');
  const BUYER_PORT = getEnv('BUYER_PORT', fromFile.BUYER_PORT || '7073');

  const hostChain = getEnv('HOST_CHAIN', MAIN_CHAIN);
  const guestChain = getEnv('GUEST_CHAIN', AUTHOR_CHAIN);
  const portForChain = (chainId) => {
    if (chainId === MAIN_CHAIN) return MAIN_PORT;
    if (chainId === AUTHOR_CHAIN) return AUTHOR_PORT;
    if (chainId === BUYER_CHAIN) return BUYER_PORT;
    return MAIN_PORT;
  };
  const hostPort = getEnv('HOST_PORT', portForChain(hostChain));
  const guestPort = getEnv('GUEST_PORT', portForChain(guestChain));
  const matchmakerChain = getEnv('MATCHMAKER_CHAIN', BUYER_CHAIN);
  const matchmakerPort = getEnv('MATCHMAKER_PORT', portForChain(matchmakerChain));

  const hostEndpoint = `http://localhost:${hostPort}/chains/${hostChain}/applications/${APP_ID}`;
  const guestEndpoint = `http://localhost:${guestPort}/chains/${guestChain}/applications/${APP_ID}`;
  const matchmakerEndpoint = `http://localhost:${matchmakerPort}/chains/${matchmakerChain}/applications/${MATCHMAKING_APP_ID}`;

  log('Using chains:');
  log('  host =', hostChain, 'port=', hostPort);
  log('  guest=', guestChain, 'port=', guestPort);
  log('  matchmaker=', matchmakerChain, 'port=', matchmakerPort);
  log('Endpoints:');
  log('  host =', hostEndpoint);
  log('  guest=', guestEndpoint);
  log('  matchmaker =', matchmakerEndpoint);

  const queryState = `
    query {
      room {
        roomId
        hostChainId
        status
        gameState
        currentAttacker
        pendingAttack { row col }
        winnerChainId
        players { chainId name boardSubmitted }
      }
      isMyTurn
      hasSubmittedBoard
      friends
      friendRequestsReceived
      friendRequestsSent
      roomInvitations { hostChainId timestamp }
      lastReveal {
        attackerChainId
        defenderChainId
        row
        col
        valid
        error
        hit
        sunk
        sunkShipCells { row col }
        adjacentCoords { row col }
        nextAttacker
        gameOver
        winnerChainId
        timestamp
      }
      myBoard {
        size
        ships { id cells { row col } }
        cells { row col shipId attacked }
      }
      enemyView { size cells }
    }
  `;
  const queryMatchmakerState = `
    query {
      battleshipAppId
      pendingPlayerName
      queueLen
      pendingMatchesLen
    }
  `;

  log('STEP 0: Cleanup any previous room');
  const hostLeaveRes = tryCurlGraphqlResponse(hostEndpoint, `mutation { leaveRoom }`);
  if (hostLeaveRes) {
    const tx = extractTxHash(hostLeaveRes.data, 'leaveRoom');
    if (tx) log('  host leaveRoom txHash =', tx);
  }
  const guestLeaveRes = tryCurlGraphqlResponse(guestEndpoint, `mutation { leaveRoom }`);
  if (guestLeaveRes) {
    const tx = extractTxHash(guestLeaveRes.data, 'leaveRoom');
    if (tx) log('  guest leaveRoom txHash =', tx);
  }

  const hostName = getEnv('HOST_NAME', `Host-${Date.now()}`);
  const guestName = getEnv('GUEST_NAME', `Guest-${Date.now()}`);

  log('STEP 1: Host searches player via matchmaking');
  const hostSearchRes = curlGraphqlResponse(
    hostEndpoint,
    `mutation { searchPlayer(matchmakingChainId: "${matchmakerChain}", playerName: "${hostName}") }`
  );
  {
    const tx = extractTxHash(hostSearchRes.data, 'searchPlayer');
    if (tx) {
      log('  host searchPlayer txHash =', tx);
    } else {
      log('  host searchPlayer response =', JSON.stringify(hostSearchRes.data));
    }
  }

  await waitUntil(
    'matchmaker queueLen >= 1 (after host search)',
    async () => {
      const s = tryCurlGraphql(matchmakerEndpoint, queryMatchmakerState);
      if (!s) return false;
      return typeof s.queueLen === 'number' && s.queueLen >= 1;
    },
    { timeoutMs: 20000, intervalMs: 500 }
  );

  log('STEP 2: Guest searches player via matchmaking');
  const guestSearchRes = curlGraphqlResponse(
    guestEndpoint,
    `mutation { searchPlayer(matchmakingChainId: "${matchmakerChain}", playerName: "${guestName}") }`
  );
  {
    const tx = extractTxHash(guestSearchRes.data, 'searchPlayer');
    if (tx) {
      log('  guest searchPlayer txHash =', tx);
    } else {
      log('  guest searchPlayer response =', JSON.stringify(guestSearchRes.data));
    }
  }

  await waitUntil(
    'host room created and has 2 players',
    async () => {
      const s = curlGraphql(hostEndpoint, queryState);
      if (!s.room) return false;
      if (s.room.hostChainId !== hostChain) return false;
      if (!Array.isArray(s.room.players) || s.room.players.length !== 2) return false;
      return true;
    },
    { timeoutMs: 90000, intervalMs: 600 }
  );

  await waitUntil(
    'guest joined room and sees 2 players',
    async () => {
      const s = curlGraphql(guestEndpoint, queryState);
      if (!s.room) return false;
      if (s.room.hostChainId !== hostChain) return false;
      if (!Array.isArray(s.room.players) || s.room.players.length !== 2) return false;
      return true;
    },
    { timeoutMs: 90000, intervalMs: 600 }
  );

  const hostState = curlGraphql(hostEndpoint, queryState);
  const guestState = curlGraphql(guestEndpoint, queryState);

  log('STEP 3: Query players to confirm they joined the same room');
  if (!hostState.room) fail('Host has no room after matchmaking');
  if (!guestState.room) fail('Guest has no room after matchmaking');

  if (hostState.room.roomId !== guestState.room.roomId) {
    fail(
      'Host and guest are in different rooms:',
      'hostRoomId=',
      hostState.room.roomId,
      'guestRoomId=',
      guestState.room.roomId
    );
  }

  const hostPlayerChains = hostState.room.players.map((p) => p.chainId).sort();
  const expectedChains = [hostChain, guestChain].sort();
  if (JSON.stringify(hostPlayerChains) !== JSON.stringify(expectedChains)) {
    fail(
      'Unexpected chainIds in host room:',
      hostPlayerChains,
      'expected:',
      expectedChains
    );
  }

  const hostPlayers = hostState.room.players.map((p) => p.name).sort();
  const expectedPlayers = [hostName, guestName].sort();
  if (JSON.stringify(hostPlayers) !== JSON.stringify(expectedPlayers)) {
    fail('Unexpected players in host room:', hostPlayers, 'expected:', expectedPlayers);
  }

  const guestPlayers = guestState.room.players.map((p) => p.name).sort();
  if (JSON.stringify(guestPlayers) !== JSON.stringify(expectedPlayers)) {
    fail('Unexpected players in guest room:', guestPlayers, 'expected:', expectedPlayers);
  }

  log(
    '  roomId =',
    hostState.room.roomId,
    'players =',
    hostState.room.players.map((p) => `${p.chainId}:${p.name}`).join(', ')
  );

  log('STEP 4: Matchmaker queue drained');
  const mmState = tryCurlGraphql(matchmakerEndpoint, queryMatchmakerState);
  if (mmState) {
    log(
      'matchmaker state:',
      'queueLen=',
      mmState.queueLen,
      'pendingMatchesLen=',
      mmState.pendingMatchesLen
    );
    if (mmState.queueLen !== 0 || mmState.pendingMatchesLen !== 0) {
      fail('Matchmaker queue not drained:', mmState);
    }
  }

  log('✅ Matchmaking test finished successfully');
}

run().catch((e) => fail(e.stack || e.message || String(e)));
