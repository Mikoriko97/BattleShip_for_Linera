import { createLogo, createBoardUI, renderShip } from "./helpers.js";
import { HORIZONTAL, VERTICAL } from "../models/utils.js";

function gameScreen(session) {
  const MARKER = "●";
  const HIT_MARKER = "X";
  const DEBUG = true;

  let state = null;
  let refreshing = false;
  let pendingAttackKey = null;
  let pollTimeoutId = null;
  let notificationUnsubscribe = null;
  let notificationHandler = null;
  let destroyed = false;

  const isActive = typeof session?.isActive === "function" ? session.isActive : () => !destroyed;

  const enumUpper = (value) => String(value || "").toUpperCase();

  render();

  const turnText = document.getElementById("turnStatus");
  const boardsRoot = document.getElementsByClassName("game_boards")[0];
  const winModal = document.getElementsByClassName("game_win-modal")[0];
  const winMessageModal = winModal.getElementsByClassName("win_msg")[0];
  const winMessageTitle = winMessageModal.getElementsByClassName("win_msg-title")[0];

  const myBoardContainer = boardsRoot.querySelector(".board_my");
  const enemyBoardContainer = boardsRoot.querySelector(".board_enemy");

  const cellKey = (row, col) => `${row},${col}`;

  let myBoardUI = null;
  let myCells = null;
  let myValues = null;
  let myShipsMounted = false;
  let mySize = null;

  let enemyBoardUI = null;
  let enemyCells = null;
  let enemyValues = null;
  let enemySize = null;

  const restartBtn = document.getElementById("restartGame");
  restartBtn.addEventListener("click", async () => {
    destroyed = true;
    stopPolling();
    try {
      await gql(`mutation { leaveRoom }`);
    } catch { }
    PubSub.publish("RESTART GAME");
  });

  const stopNotifications = () => {
    if (typeof notificationUnsubscribe === "function") {
      try {
        notificationUnsubscribe();
      } catch { }
    } else if (notificationHandler && typeof session.client?.offNotification === "function") {
      try {
        session.client.offNotification(notificationHandler);
      } catch { }
    }
    notificationUnsubscribe = null;
    notificationHandler = null;
  };

  const stopPolling = () => {
    if (pollTimeoutId) {
      clearTimeout(pollTimeoutId);
      pollTimeoutId = null;
    }
    stopNotifications();
  };

  const gql = async (query) => {
    if (DEBUG) {
      console.log("[battleship:gql] request", query);
    }
    const res = await session.application.query(JSON.stringify({ query }));
    const data = typeof res === "string" ? JSON.parse(res) : res;
    if (DEBUG) {
      console.log("[battleship:gql] response", data);
    }
    if (data.errors?.length) {
      const msg = data.errors.map((e) => e.message).join("; ");
      if (DEBUG) {
        console.error("[battleship:gql] errors", data.errors);
      }
      throw new Error(msg);
    }
    return data.data;
  };

  const fetchState = async () => {
    const data = await gql(`query {
      room { roomId hostChainId status gameState players { chainId name boardSubmitted } currentAttacker winnerChainId }
      isMyTurn
      enemyView { size cells }
      myBoard { size cells { row col shipId attacked } ships { id cells { row col } } }
    }`);
    return data;
  };

  const updateUi = (snapshot) => {
    state = snapshot;
    const room = snapshot.room;
    if (!room) return;

    const isMyTurn = snapshot.isMyTurn;
    const myTurnText = isMyTurn ? "Your turn" : "Opponent's turn";
    if (turnText.textContent !== myTurnText) {
      turnText.textContent = myTurnText;
    }

    applyMyBoard(snapshot.myBoard);
    applyEnemyBoard(snapshot.enemyView, isMyTurn);

    if (room.winnerChainId) {
      stopPolling();
      showWinMessage(room.winnerChainId === session.chainId);
    }
  };

  const ensureMyBoardUI = (size) => {
    if (myBoardUI && mySize === size) return;
    mySize = size;
    myShipsMounted = false;
    myCells = new Map();
    myValues = new Map();
    const grid = Array.from({ length: size }, () => Array.from({ length: size }, () => null));
    myBoardUI = createBoardUI(grid, (container, _cell, coords) => {
      const markerBox = container.getElementsByClassName("board_box-marker")[0];
      myCells.set(cellKey(coords[0], coords[1]), { container, markerBox });
    });
    myBoardUI.classList.add("board");
    myBoardContainer.innerHTML = "";
    myBoardContainer.append(myBoardUI);
  };

  const ensureEnemyBoardUI = (size) => {
    if (enemyBoardUI && enemySize === size) return;
    enemySize = size;
    enemyCells = new Map();
    enemyValues = new Map();
    const grid = Array.from({ length: size }, () => Array.from({ length: size }, () => "UNKNOWN"));

    enemyBoardUI = createBoardUI(grid, (container, _cell, coords) => {
      const markerBox = container.getElementsByClassName("board_box-marker")[0];
      const key = cellKey(coords[0], coords[1]);
      enemyCells.set(key, { container, markerBox, coords });

      container.addEventListener("click", async () => {
        const room = state?.room;
        if (!room || !state?.isMyTurn) return;
        if (pendingAttackKey) return;
        const v = enemyValues.get(key) || "UNKNOWN";
        if (v !== "UNKNOWN") return;

        pendingAttackKey = key;
        container.classList.add("loading", "not-available");
        markerBox.textContent = "";
        try {
          await gql(`mutation { attack(row: ${coords[0]}, col: ${coords[1]}) }`);
        } catch {
          pendingAttackKey = null;
          container.classList.remove("loading", "not-available");
        }
      });
    });
    enemyBoardUI.classList.add("board-enemy");
    enemyBoardContainer.innerHTML = "";
    enemyBoardContainer.append(enemyBoardUI);
  };

  const applyMyBoard = (myBoard) => {
    if (!myBoard) return;
    ensureMyBoardUI(myBoard.size);

    for (const cell of myBoard.cells || []) {
      const key = cellKey(cell.row, cell.col);
      const ref = myCells.get(key);
      if (!ref) continue;

      const hasShip = cell.shipId != null;
      const attacked = Boolean(cell.attacked);
      const valueKey = `${cell.shipId ?? ""}:${attacked ? 1 : 0}`;
      if (myValues.get(key) === valueKey) continue;
      myValues.set(key, valueKey);

      ref.container.classList.toggle("ship-cell", hasShip);
      ref.container.classList.toggle("hit", attacked && hasShip);
      ref.container.classList.toggle("not-available", attacked && !hasShip);

      if (attacked) {
        ref.markerBox.textContent = hasShip ? HIT_MARKER : MARKER;
      } else {
        ref.markerBox.textContent = "";
      }
    }

    if (!myShipsMounted && Array.isArray(myBoard.ships) && myBoard.ships.length) {
      const shipsByStart = [];
      for (const ship of myBoard.ships || []) {
        const coords = ship.cells || [];
        if (!coords.length) continue;
        const rows = new Set(coords.map((c) => c.row));
        const axis = rows.size === 1 ? HORIZONTAL : VERTICAL;
        let startRow = coords[0].row;
        let startCol = coords[0].col;
        for (const c of coords) {
          if (c.row < startRow) startRow = c.row;
          if (c.col < startCol) startCol = c.col;
        }
        shipsByStart.push({ row: startRow, col: startCol, length: coords.length, axis });
      }

      for (const s of shipsByStart) {
        const startBox = myBoardUI.querySelector(`[data-row="${s.row}"][data-col="${s.col}"]`);
        if (!startBox) continue;
        const ui = renderShip(s.length, s.axis);
        startBox.append(ui);
      }
      myShipsMounted = true;
    }
  };

  const applyEnemyBoard = (enemyView, isMyTurn) => {
    if (!enemyView) return;
    ensureEnemyBoardUI(enemyView.size);

    enemyBoardUI.classList.toggle("not-playing", !isMyTurn);

    const size = enemyView.size;
    const flat = enemyView.cells || [];
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        const key = cellKey(r, c);
        const ref = enemyCells.get(key);
        if (!ref) continue;

        const v = enumUpper(flat[r * size + c] || "UNKNOWN");
        const prev = enemyValues.get(key) || "UNKNOWN";
        const isPending = pendingAttackKey === key && v === "UNKNOWN";
        const shouldUpdate = prev !== v || isPending;
        if (!shouldUpdate) continue;
        enemyValues.set(key, v);

        if (pendingAttackKey === key && v !== "UNKNOWN") {
          pendingAttackKey = null;
        }

        ref.container.classList.toggle("loading", isPending);
        ref.container.classList.toggle("hit", v === "HIT" || v === "SUNK");
        ref.container.classList.toggle("not-available", isPending || v === "MISS" || v === "HIT" || v === "SUNK");

        if (isPending) {
          ref.markerBox.textContent = "";
        } else if (v === "MISS") {
          ref.markerBox.textContent = MARKER;
        } else if (v === "HIT" || v === "SUNK") {
          ref.markerBox.textContent = HIT_MARKER;
        } else {
          ref.markerBox.textContent = "";
        }
      }
    }
  };

  const showWinMessage = (iWon) => {
    winMessageTitle.textContent = iWon ? "You have CONQUERED!" : "You were CONQUERED!";
    winModal.classList.add("active");
    winMessageModal.classList.add("active");
  };

  const refreshOnce = async () => {
    if (refreshing) return;
    if (!isActive()) {
      stopPolling();
      return;
    }
    refreshing = true;
    try {
      const snapshot = await fetchState();
      if (!isActive()) {
        stopPolling();
        return;
      }
      updateUi(snapshot);
    } catch (e) {
      console.error("[battleship] refreshOnce failed", e);
      const msg = e?.message ? String(e.message) : String(e || "Unknown error");
      if (isActive() && turnText) {
        turnText.textContent = `Error: ${msg}`;
      }
    } finally {
      refreshing = false;
    }
  };

  function render() {
    document.body.innerHTML = "";

    const gameSection = document.createElement("section");
    const gameHeader = document.createElement("div");
    const battleshipLogo = createLogo();

    document.body.classList.add("body-flex");
    gameSection.classList.add("game", "margin-auto-x");
    gameHeader.classList.add("game_header");

    gameSection.innerHTML += `
      <div class="game_status flash">
        <span class="accent-color">STATUS:</span>
        <p id="turnStatus"></p>
      </div>
      <div class="game_boards">
        <div class="board_col">
          <h3 class="board_title">My board</h3>
          <div class="board_my"></div>
        </div>
        <div class="board_col">
          <h3 class="board_title">Enemy board</h3>
          <div class="board_enemy"></div>
        </div>
      </div>
      <div class="game_win-modal">
        <div class="dark-overlay"></div>
        <div class="win_msg">
          <h2 class="win_msg-title"></h2>
          <p>Want to play again?</p>
          <button type="button" id="restartGame" class="btn-primary">
            BACK TO LOBBY
          </button>
          <img class="win_msg-img"
            src="./ui/images/deco-ship.png"
            alt="A warship in the sea">
        </div>
      </div>
    `;

    gameHeader.append(battleshipLogo);
    gameSection.prepend(gameHeader);
    document.body.append(gameSection);
  }

  (async () => {
    await refreshOnce();

    if (session.client) {
      notificationHandler = (notification) => {
        if (!isActive()) {
          stopPolling();
          return;
        }
        if (notification?.reason?.NewBlock) {
          refreshOnce();
        }
      };
      const maybeUnsub = session.client.onNotification(notificationHandler);
      if (typeof maybeUnsub === "function") {
        notificationUnsubscribe = maybeUnsub;
      }
    }
  })();
}

export { gameScreen };
