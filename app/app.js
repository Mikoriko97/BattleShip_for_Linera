import { gameboard } from "./models/gameboard.js";
import { placementScreen } from "./ui/placementScreen.js";
import { gameScreen } from "./ui/gameScreen.js";
import * as linera from "@linera/client";
import { Wallet } from "ethers";
import {
  LINERA_APPLICATION_ID,
  LINERA_FAUCET_URL,
  LINERA_MATCHMAKER_CHAIN_ID,
} from "./env.js";

(() => {
  const ships = [5, 3, 3, 2, 2, 1];
  let pollIntervalId = null;
  let notificationUnsubscribe = null;
  let notificationHandler = null;
  let viewToken = 0;

  const appState = {
    faucetUrl: "",
    applicationId: "",
    mnemonic: "",
    chainId: "",
    playerName: "",
    hostChainId: "",
    isHost: false,
    clientInstance: null,
    client: null,
    application: null,
  };

  const ensureWasmInstantiateStreamingFallback = () => {
    if (typeof WebAssembly === "undefined") return;
    const wasmAny = WebAssembly;
    const original = wasmAny.instantiateStreaming;
    if (typeof original !== "function") return;
    wasmAny.instantiateStreaming = async (source, importObject) => {
      try {
        const res = source instanceof Response ? source : await source;
        const ct = res.headers?.get("Content-Type") || "";
        if (ct.includes("application/wasm")) {
          return original(Promise.resolve(res), importObject);
        }
        const buf = await res.arrayBuffer();
        return WebAssembly.instantiate(buf, importObject);
      } catch {
        const res = source instanceof Response ? source : await source;
        const buf = await res.arrayBuffer();
        return WebAssembly.instantiate(buf, importObject);
      }
    };
  };

  const escapeGqlString = (value) =>
    value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r/g, "\\r").replace(/\n/g, "\\n");

  const escapeHtml = (value) =>
    String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");

  const gql = async (query) => {
    const res = await appState.application.query(JSON.stringify({ query }));
    const data = typeof res === "string" ? JSON.parse(res) : res;
    if (data.errors?.length) {
      const msg = data.errors.map((e) => e.message).join("; ");
      throw new Error(msg);
    }
    return data.data;
  };

  const stopUpdates = () => {
    if (pollIntervalId) {
      clearInterval(pollIntervalId);
      pollIntervalId = null;
    }
    if (typeof notificationUnsubscribe === "function") {
      try {
        notificationUnsubscribe();
      } catch { }
    } else if (notificationHandler && typeof appState.client?.offNotification === "function") {
      try {
        appState.client.offNotification(notificationHandler);
      } catch { }
    }
    notificationUnsubscribe = null;
    notificationHandler = null;
  };

  const startNotifications = (fn) => {
    stopUpdates();
    if (!appState.client || typeof appState.client?.onNotification !== "function") return false;
    notificationHandler = (notification) => {
      try {
        if (notification?.reason?.NewBlock) {
          fn();
        }
      } catch { }
    };
    const maybeUnsub = appState.client.onNotification(notificationHandler);
    if (typeof maybeUnsub === "function") {
      notificationUnsubscribe = maybeUnsub;
    }
    return true;
  };

  const initLinera = async ({ faucetUrl, applicationId }) => {
    ensureWasmInstantiateStreamingFallback();
    try {
      await linera.initialize();
    } catch { }

    let mnemonic = "";
    try {
      mnemonic = localStorage.getItem("linera_mnemonic") || "";
    } catch { }
    if (!mnemonic) {
      const generated = Wallet.createRandom();
      const phrase = generated.mnemonic?.phrase;
      if (!phrase) throw new Error("Failed to generate mnemonic");
      mnemonic = phrase;
      try {
        localStorage.setItem("linera_mnemonic", mnemonic);
      } catch { }
    }

    const signer = linera.signer.PrivateKey.fromMnemonic(mnemonic);
    const faucet = new linera.Faucet(faucetUrl);
    const owner = signer.address();

    const wallet = await faucet.createWallet();
    const chainId = await faucet.claimChain(wallet, owner);

    const clientInstance = await new linera.Client(wallet, signer, { skipProcessInbox: false });
    const chain = await clientInstance.chain(chainId);
    const application = await chain.application(applicationId);

    appState.faucetUrl = faucetUrl;
    appState.applicationId = applicationId;
    appState.mnemonic = mnemonic;
    appState.chainId = chainId;
    appState.clientInstance = clientInstance;
    appState.client = chain;
    appState.application = application;
  };

  const isTestsPage =
    typeof window !== "undefined" && /^\/tests\/?$/.test(window.location.pathname || "");

  const renderInitErrorScreen = (errorText) => {
    stopUpdates();
    viewToken++;
    document.body.innerHTML = "";
    document.body.classList.add("body-flex");

    const container = document.createElement("div");
    container.classList.add("lobby_container", "margin-auto-y", "fadeInDown", "animated");

    container.innerHTML = `
      <div class="lobby_card">
        <h2>Failed to initialize Linera</h2>
        <div class="lobby_meta">
          <div><span class="lobby_k">Faucet:</span> <span class="lobby_v">${escapeHtml(
      LINERA_FAUCET_URL
    )}</span></div>
          <div><span class="lobby_k">Application:</span> <span class="lobby_v">${escapeHtml(
      LINERA_APPLICATION_ID
    )}</span></div>
        </div>
        <div class="lobby_error">${escapeHtml(errorText || "Unknown error")}</div>
      </div>
    `;

    document.body.append(container);
  };

  const renderTestsScreen = () => {
    stopUpdates();
    const token = ++viewToken;

    const initialBattleshipQuery =
      `query { room { roomId hostChainId status gameState players { chainId name boardSubmitted } } }`;
    const initialMatchmakingQuery =
      `query { lastNotification }`;
    const initialSearchMutation =
      `mutation { searchPlayer(orchestratorChainId: "${escapeGqlString(
        LINERA_MATCHMAKER_CHAIN_ID
      )}", playerName: "Player") }`;

    document.body.innerHTML = "";
    document.body.classList.add("body-flex");

    const container = document.createElement("div");
    container.classList.add("lobby_container", "margin-auto-y", "fadeInDown", "animated");

    container.innerHTML = `
      <div class="lobby_card" style="max-width: 1100px;">
        <h2 style="margin-bottom: 10px;">TESTS</h2>
        <div class="lobby_meta" style="margin-bottom: 18px;">
          <div><span class="lobby_k">Faucet:</span> <span class="lobby_v">${escapeHtml(
            LINERA_FAUCET_URL
          )}</span></div>
          <div><span class="lobby_k">My Chain:</span> <span class="lobby_v">${escapeHtml(
            appState.chainId
          )}</span></div>
          <div><span class="lobby_k">Matchmaker Chain:</span> <span class="lobby_v">${escapeHtml(
            LINERA_MATCHMAKER_CHAIN_ID
          )}</span></div>
        </div>

        <div style="display: flex; gap: 12px; flex-wrap: wrap; align-items: flex-end; margin-bottom: 18px;">
          <div style="flex: 1; min-width: 320px;">
            <label class="lobby_label" style="font-size: 0.95rem;">TARGET CHAIN ID</label>
            <input class="lobby_input" id="testsChainId" style="width: 100%; margin-top: 5px;" value="${escapeHtml(
              appState.chainId
            )}">
          </div>
          <button class="btn-secondary-dark lobby_btn" id="useMyChainBtn" type="button">USE MY CHAIN</button>
          <button class="btn-secondary-dark lobby_btn" id="useMatchmakerChainBtn" type="button">USE MATCHMAKER CHAIN</button>
          <button class="btn-secondary-dark lobby_btn" id="backToGameBtn" type="button" style="margin-left: auto;">BACK</button>
        </div>

        <div style="display: flex; gap: 18px; flex-wrap: wrap;">
          <div style="flex: 1; min-width: 420px; background: rgba(255,255,255,0.05); padding: 14px;">
            <h3 style="margin-bottom: 10px; font-size: 1.2rem;">BATTLESHIP APP</h3>
            <label class="lobby_label" style="font-size: 0.9rem;">APP ID</label>
            <input class="lobby_input" id="bsAppId" style="width: 100%; margin-top: 5px;" value="${escapeHtml(
              LINERA_APPLICATION_ID
            )}">
            <div style="margin-top: 12px;">
              <label class="lobby_label" style="font-size: 0.9rem;">QUERY</label>
              <textarea id="bsQuery" style="width: 100%; height: 120px; margin-top: 5px; padding: 10px; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace;">${escapeHtml(
                initialBattleshipQuery
              )}</textarea>
              <div style="display: flex; gap: 10px; margin-top: 10px; align-items: center;">
                <button class="btn-primary lobby_btn" id="bsRunQueryBtn" type="button">RUN QUERY</button>
                <label style="display:flex; align-items:center; gap:8px; font-size:0.95rem;">
                  <input type="checkbox" id="bsAutoQuery">
                  auto query on NewBlock
                </label>
              </div>
            </div>
            <div style="margin-top: 12px;">
              <label class="lobby_label" style="font-size: 0.9rem;">MUTATION</label>
              <textarea id="bsMutation" style="width: 100%; height: 120px; margin-top: 5px; padding: 10px; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace;">${escapeHtml(
                initialSearchMutation
              )}</textarea>
              <div style="display: flex; gap: 10px; margin-top: 10px;">
                <button class="btn-secondary-dark lobby_btn" id="bsRunMutationBtn" type="button">RUN MUTATION</button>
              </div>
            </div>
            <div style="margin-top: 12px;">
              <label class="lobby_label" style="font-size: 0.9rem;">OUTPUT</label>
              <pre id="bsOut" style="white-space: pre-wrap; word-break: break-word; background: rgba(0,0,0,0.25); padding: 10px; min-height: 90px;"></pre>
            </div>
          </div>

          <div style="flex: 1; min-width: 420px; background: rgba(255,255,255,0.05); padding: 14px;">
            <h3 style="margin-bottom: 10px; font-size: 1.2rem;">MATCHMAKING (SAME APP)</h3>
            <label class="lobby_label" style="font-size: 0.9rem;">APP ID</label>
            <input class="lobby_input" id="mmAppId" style="width: 100%; margin-top: 5px;" value="${escapeHtml(
              LINERA_APPLICATION_ID
            )}" disabled>
            <div style="margin-top: 12px;">
              <label class="lobby_label" style="font-size: 0.9rem;">QUERY</label>
              <textarea id="mmQuery" style="width: 100%; height: 120px; margin-top: 5px; padding: 10px; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace;">${escapeHtml(
                initialMatchmakingQuery
              )}</textarea>
              <div style="display: flex; gap: 10px; margin-top: 10px; align-items: center;">
                <button class="btn-primary lobby_btn" id="mmRunQueryBtn" type="button">RUN QUERY</button>
                <label style="display:flex; align-items:center; gap:8px; font-size:0.95rem;">
                  <input type="checkbox" id="mmAutoQuery">
                  auto query on NewBlock
                </label>
              </div>
            </div>
            <div style="margin-top: 12px;">
              <label class="lobby_label" style="font-size: 0.9rem;">MUTATION</label>
              <textarea id="mmMutation" style="width: 100%; height: 120px; margin-top: 5px; padding: 10px; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace;">${escapeHtml(
                initialSearchMutation
              )}</textarea>
              <div style="display: flex; gap: 10px; margin-top: 10px;">
                <button class="btn-secondary-dark lobby_btn" id="mmRunMutationBtn" type="button">RUN MUTATION</button>
              </div>
            </div>
            <div style="margin-top: 12px;">
              <label class="lobby_label" style="font-size: 0.9rem;">OUTPUT</label>
              <pre id="mmOut" style="white-space: pre-wrap; word-break: break-word; background: rgba(0,0,0,0.25); padding: 10px; min-height: 90px;"></pre>
            </div>
          </div>
        </div>

        <div style="margin-top: 18px; background: rgba(255,255,255,0.05); padding: 14px;">
          <h3 style="margin-bottom: 10px; font-size: 1.1rem;">NOTIFICATIONS</h3>
          <pre id="notifOut" style="white-space: pre-wrap; word-break: break-word; background: rgba(0,0,0,0.25); padding: 10px; min-height: 70px;"></pre>
        </div>

        <div id="testsError" class="lobby_error" style="margin-top: 12px; text-align: center;"></div>
      </div>
    `;

    document.body.append(container);

    const chainIdInput = document.getElementById("testsChainId");
    const useMyChainBtn = document.getElementById("useMyChainBtn");
    const useMatchmakerChainBtn = document.getElementById("useMatchmakerChainBtn");
    const backToGameBtn = document.getElementById("backToGameBtn");
    const testsError = document.getElementById("testsError");
    const notifOut = document.getElementById("notifOut");

    const bsAppIdInput = document.getElementById("bsAppId");
    const bsQueryEl = document.getElementById("bsQuery");
    const bsMutationEl = document.getElementById("bsMutation");
    const bsOut = document.getElementById("bsOut");
    const bsRunQueryBtn = document.getElementById("bsRunQueryBtn");
    const bsRunMutationBtn = document.getElementById("bsRunMutationBtn");
    const bsAutoQuery = document.getElementById("bsAutoQuery");

    const mmAppIdInput = document.getElementById("mmAppId");
    const mmQueryEl = document.getElementById("mmQuery");
    const mmMutationEl = document.getElementById("mmMutation");
    const mmOut = document.getElementById("mmOut");
    const mmRunQueryBtn = document.getElementById("mmRunQueryBtn");
    const mmRunMutationBtn = document.getElementById("mmRunMutationBtn");
    const mmAutoQuery = document.getElementById("mmAutoQuery");

    const appendNotif = (line) => {
      const prev = String(notifOut.textContent || "");
      const next = prev ? `${prev}\n${line}` : line;
      const parts = next.split("\n");
      notifOut.textContent = parts.slice(-80).join("\n");
      try {
        console.log(line);
      } catch { }
    };

    let lastMmNotification = null;
    const checkMatchmakingNotification = async () => {
      try {
        const data = await runOn({
          chainId: chainIdInput.value,
          appId: bsAppIdInput.value,
          gqlText: "query { lastNotification }",
        });
        const current = data?.lastNotification || null;
        if (current && current !== lastMmNotification) {
          lastMmNotification = current;
          appendNotif(`[${new Date().toISOString()}] matchmaking: ${current}`);
        }
      } catch { }
    };

    const runOn = async ({ chainId, appId, gqlText }) => {
      const chainIdTrim = String(chainId || "").trim();
      const appIdTrim = String(appId || "").trim();
      const text = String(gqlText || "").trim();
      if (!chainIdTrim) throw new Error("Missing chain id");
      if (!appIdTrim) throw new Error("Missing app id");
      if (!text) throw new Error("Empty GraphQL input");
      if (!appState.clientInstance) throw new Error("Client not initialized");
      const chain = await appState.clientInstance.chain(chainIdTrim);
      const app = await chain.application(appIdTrim);
      const res = await app.query(JSON.stringify({ query: text }));
      const parsed = typeof res === "string" ? JSON.parse(res) : res;
      if (parsed.errors?.length) {
        const msg = parsed.errors.map((e) => e.message).join("; ");
        throw new Error(msg);
      }
      return parsed.data;
    };

    const wrap = (obj) => JSON.stringify(obj, null, 2);

    const runBsQuery = async () => {
      testsError.textContent = "";
      bsOut.textContent = "Loading...";
      try {
        const data = await runOn({
          chainId: chainIdInput.value,
          appId: bsAppIdInput.value,
          gqlText: bsQueryEl.value,
        });
        if (token !== viewToken) return;
        bsOut.textContent = wrap(data);
      } catch (e) {
        if (token !== viewToken) return;
        bsOut.textContent = "";
        testsError.textContent = e?.message || String(e);
      }
    };

    const runBsMutation = async () => {
      testsError.textContent = "";
      bsOut.textContent = "Loading...";
      try {
        const data = await runOn({
          chainId: chainIdInput.value,
          appId: bsAppIdInput.value,
          gqlText: bsMutationEl.value,
        });
        if (token !== viewToken) return;
        bsOut.textContent = wrap(data);
      } catch (e) {
        if (token !== viewToken) return;
        bsOut.textContent = "";
        testsError.textContent = e?.message || String(e);
      }
    };

    const runMmQuery = async () => {
      testsError.textContent = "";
      mmOut.textContent = "Loading...";
      try {
        const data = await runOn({
          chainId: chainIdInput.value,
          appId: mmAppIdInput.value,
          gqlText: mmQueryEl.value,
        });
        if (token !== viewToken) return;
        mmOut.textContent = wrap(data);
      } catch (e) {
        if (token !== viewToken) return;
        mmOut.textContent = "";
        testsError.textContent = e?.message || String(e);
      }
    };

    const runMmMutation = async () => {
      testsError.textContent = "";
      mmOut.textContent = "Loading...";
      try {
        const data = await runOn({
          chainId: chainIdInput.value,
          appId: mmAppIdInput.value,
          gqlText: mmMutationEl.value,
        });
        if (token !== viewToken) return;
        mmOut.textContent = wrap(data);
      } catch (e) {
        if (token !== viewToken) return;
        mmOut.textContent = "";
        testsError.textContent = e?.message || String(e);
      }
    };

    useMyChainBtn.addEventListener("click", () => {
      chainIdInput.value = appState.chainId;
    });
    useMatchmakerChainBtn.addEventListener("click", () => {
      chainIdInput.value = LINERA_MATCHMAKER_CHAIN_ID;
    });
    backToGameBtn.addEventListener("click", () => {
      window.location.href = "/app/";
    });

    bsRunQueryBtn.addEventListener("click", runBsQuery);
    bsRunMutationBtn.addEventListener("click", runBsMutation);
    mmRunQueryBtn.addEventListener("click", runMmQuery);
    mmRunMutationBtn.addEventListener("click", runMmMutation);

    const subscribed = startNotifications(() => {
      appendNotif(`[${new Date().toISOString()}] NewBlock`);
      checkMatchmakingNotification();
      if (bsAutoQuery.checked) runBsQuery();
      if (mmAutoQuery.checked) runMmQuery();
    });
    if (!subscribed) {
      appendNotif(`[${new Date().toISOString()}] notifications: not supported`);
    } else {
      appendNotif(`[${new Date().toISOString()}] subscribed (my chain)`);
    }

    checkMatchmakingNotification();
  };

  const renderLobbyScreen = (isLoading = false) => {
    stopUpdates();
    const token = ++viewToken;

    // Helper to attach listeners
    const attachListeners = () => {
      const nameInput = document.getElementById("playerName");
      const hostInput = document.getElementById("hostChainId");
      const createBtn = document.getElementById("createRoomBtn");
      const matchmakingBtn = document.getElementById("matchmakingBtn");
      const joinBtn = document.getElementById("joinRoomBtn");
      const errorEl = document.getElementById("lobbyError");

      if (!createBtn || !joinBtn || !matchmakingBtn) return;

      // Prevent multiple attachments
      if (createBtn.dataset.listening) return;
      createBtn.dataset.listening = "true";
      matchmakingBtn.dataset.listening = "true";
      joinBtn.dataset.listening = "true";

      const normalizeName = () => nameInput.value.trim() || "Player";

      createBtn.addEventListener("click", async () => {
        errorEl.textContent = "";
        const name = normalizeName();
        try {
          localStorage.setItem("battleship_nickname", name);
        } catch { }
        createBtn.setAttribute("disabled", "");
        createBtn.textContent = "CREATING...";
        try {
          const escaped = escapeGqlString(name);
          await gql(`mutation { createRoom(hostName: "${escaped}") }`);
          if (token !== viewToken) return;
          appState.playerName = name;
          appState.isHost = true;
          appState.hostChainId = appState.chainId;
          renderWaitingScreen();
        } catch (e) {
          errorEl.textContent = "Error creating room: " + (e.message || "Unknown error");
          createBtn.textContent = "CREATE ROOM";
        } finally {
          createBtn.removeAttribute("disabled");
        }
      });

      matchmakingBtn.addEventListener("click", async () => {
        errorEl.textContent = "";
        const name = normalizeName();
        try {
          localStorage.setItem("battleship_nickname", name);
        } catch { }
        createBtn.setAttribute("disabled", "");
        matchmakingBtn.setAttribute("disabled", "");
        joinBtn.setAttribute("disabled", "");
      matchmakingBtn.textContent = "SEARCHING...";
      try {
          const chainEsc = escapeGqlString(LINERA_MATCHMAKER_CHAIN_ID);
          const nameEsc = escapeGqlString(name);
          await gql(
            `mutation { searchPlayer(orchestratorChainId: "${chainEsc}", playerName: "${nameEsc}") }`
          );
          if (token !== viewToken) return;
          appState.playerName = name;
          appState.isHost = false;
          appState.hostChainId = "";
          renderWaitingScreen();
        } catch (e) {
          errorEl.textContent = "Error matchmaking: " + (e.message || "Unknown error");
          matchmakingBtn.textContent = "MATCHMAKING";
        } finally {
          createBtn.removeAttribute("disabled");
          matchmakingBtn.removeAttribute("disabled");
          joinBtn.removeAttribute("disabled");
        }
      });

      joinBtn.addEventListener("click", async () => {
        errorEl.textContent = "";
        const name = normalizeName();
        const host = hostInput.value.trim();
        if (!host) {
          errorEl.textContent = "Please enter a Host Chain ID";
          return;
        }
        try {
          localStorage.setItem("battleship_nickname", name);
        } catch { }
        joinBtn.setAttribute("disabled", "");
        joinBtn.textContent = "JOINING...";
        try {
          const hostEsc = escapeGqlString(host);
          const nameEsc = escapeGqlString(name);
          await gql(`mutation { joinRoom(hostChainId: "${hostEsc}", playerName: "${nameEsc}") }`);
          if (token !== viewToken) return;
          appState.playerName = name;
          appState.isHost = false;
          appState.hostChainId = host;
          renderWaitingScreen();
        } catch (e) {
          errorEl.textContent = "Error joining: " + (e.message || "Check Host ID");
          joinBtn.textContent = "JOIN";
        } finally {
          joinBtn.removeAttribute("disabled");
        }
      });
    };

    // Check if lobby already exists
    const existingContainer = document.querySelector(".lobby_container");
    const nameInput = document.getElementById("playerName");
    const hostInput = document.getElementById("hostChainId");
    const createBtn = document.getElementById("createRoomBtn");
    const matchmakingBtn = document.getElementById("matchmakingBtn");
    const joinBtn = document.getElementById("joinRoomBtn");
    const chainIdEl = document.getElementById("chainIdDisplay");

    // If lobby exists, just update the state
    if (existingContainer && nameInput && createBtn && matchmakingBtn && joinBtn) {
      if (!isLoading) {
        if (chainIdEl) chainIdEl.innerHTML = `<span class="lobby_v">${appState.chainId}</span>`;
        nameInput.removeAttribute("disabled");
        hostInput.removeAttribute("disabled");
        createBtn.removeAttribute("disabled");
        matchmakingBtn.removeAttribute("disabled");
        joinBtn.removeAttribute("disabled");
        attachListeners(); // Ensure listeners are attached
      }
      return;
    }

    document.body.innerHTML = "";
    document.body.classList.add("body-flex");

    const container = document.createElement("div");
    container.classList.add("lobby_container", "margin-auto-y", "fadeInDown", "animated");

    const savedName = (() => {
      try {
        return localStorage.getItem("battleship_nickname") || "";
      } catch {
        return "";
      }
    })();

    const chainDisplay = isLoading
      ? `<span class="lobby_v cast">Connecting...</span>`
      : `<span class="lobby_v">${appState.chainId}</span>`;
    const disabledAttr = isLoading ? "disabled" : "";

    container.innerHTML = `
      <div class="lobby_card">
        <h2 style="margin-bottom: 10px;">BATTLESHIP</h2>
        <div class="lobby_meta" style="margin-bottom: 20px;">
          <div><span class="lobby_k">Protocol:</span> <span class="lobby_v">Linera</span></div>
          <div><span class="lobby_k">My Chain:</span> <span id="chainIdDisplay">${chainDisplay}</span></div>
        </div>
        
        <div style="margin-bottom: 25px;">
            <label class="lobby_label">NICKNAME</label>
            <input class="lobby_input" id="playerName" style="width: 100%; margin-top: 5px;" placeholder="Enter your name" value="${savedName}" ${disabledAttr}>
        </div>

        <div style="display: flex; gap: 20px; flex-wrap: wrap;">
            <!-- Create Room Section -->
            <div style="flex: 1; min-width: 250px; background: rgba(255,255,255,0.05); padding: 15px;">
                <h3 style="margin-bottom: 10px; font-size: 1.4rem;">HOST GAME</h3>
                <p style="font-size: 1.05rem; margin-bottom: 15px; opacity: 0.8;">Create a new room and invite a friend.</p>
                <button class="btn-primary lobby_btn" id="createRoomBtn" type="button" style="width: 100%;" ${disabledAttr}>CREATE ROOM</button>
                <button class="btn-secondary-dark lobby_btn" id="matchmakingBtn" type="button" style="width: 100%; margin-top: 10px;" ${disabledAttr}>MATCHMAKING</button>
            </div>

            <!-- Join Room Section -->
            <div style="flex: 1; min-width: 250px; background: rgba(255,255,255,0.05); padding: 15px;">
                <h3 style="margin-bottom: 10px; font-size: 1.4rem;">JOIN GAME</h3>
                <p style="font-size: 1.05rem; margin-bottom: 15px; opacity: 0.8;">Enter a Host Chain ID to join.</p>
                <label class="lobby_label" style="font-size: 0.95rem;">HOST CHAIN ID</label>
                <div style="display: flex; flex-direction: column; gap: 10px; margin-top: 5px;">
                    <input class="lobby_input" id="hostChainId" placeholder="e.g. e476.." style="width: 100%;" ${disabledAttr}>
                    <button class="btn-secondary-dark lobby_btn" id="joinRoomBtn" type="button" style="width: 100%;" ${disabledAttr}>JOIN</button>
                </div>
            </div>
        </div>
        <div id="lobbyError" class="lobby_error" style="margin-top: 15px; text-align: center;"></div>
      </div>
    `;

    document.body.append(container);

    if (!isLoading) {
      attachListeners();
    }
  };

  const renderWaitingScreen = () => {
    stopUpdates();
    const token = ++viewToken;
    document.body.innerHTML = "";
    document.body.classList.add("body-flex");

    const container = document.createElement("div");
    container.classList.add("lobby_container", "margin-auto-y", "fadeInDown", "animated");

    // Copy function
    window.copyHostId = () => {
      const id = appState.hostChainId;
      if (!id) return;
      navigator.clipboard.writeText(id).then(() => {
        const btn = document.getElementById('copyBtn');
        if (btn) {
          const orig = btn.innerText;
          btn.innerText = "COPIED!";
          setTimeout(() => btn.innerText = orig, 1500);
        }
      });
    };

    const hostChainDisplay = appState.hostChainId || "SEARCHING...";
    const copyDisabledAttr = appState.hostChainId ? "" : "disabled";
    container.innerHTML = `
      <div class="lobby_card">
        <h2>MISSION CONTROL</h2>
        <div class="lobby_meta" style="background: rgba(40,40,40,0.5); padding: 10px; margin-bottom: 20px;">
          <div><span class="lobby_k">MY CHAIN:</span> <span class="lobby_v">${appState.chainId}</span></div>
          <div style="margin-top: 5px; display: flex; align-items: center; gap: 10px;">
            <span class="lobby_k">HOST CHAIN:</span> 
            <span id="hostChainValue" class="lobby_v" style="font-weight: bold; color: var(--accent);">${escapeHtml(
              hostChainDisplay
            )}</span>
            <button id="copyBtn" onclick="window.copyHostId()" style="border: 1px solid white; padding: 4px 10px; font-size: 0.95rem; text-transform: uppercase;" ${copyDisabledAttr}>COPY</button>
          </div>
        </div>

        <div class="lobby_section">
          <h3 style="border-bottom: 1px solid rgba(255,255,255,0.2); padding-bottom: 5px;">STATUS REPORT</h3>
          <div id="roomStatus" style="min-height: 100px; padding: 10px 0;">Loading...</div>
        </div>

        <div class="lobby_section" style="margin-top: 14px;">
          <h3 style="border-bottom: 1px solid rgba(255,255,255,0.2); padding-bottom: 5px;">MATCHMAKING LOG</h3>
          <pre id="mmNotif" style="white-space: pre-wrap; word-break: break-word; background: rgba(0,0,0,0.25); padding: 10px; min-height: 60px;"></pre>
        </div>

        <div class="lobby_actions" style="margin-top: 20px; border-top: 1px solid rgba(255,255,255,0.1); padding-top: 20px;">
           <button class="btn-secondary-dark lobby_btn" id="backBtn" type="button">ABORT MISSION</button> 
           <button class="btn-primary lobby_btn" id="startGameBtn" type="button" disabled style="margin-left: auto;">START GAME</button>
        </div>
      </div>
    `;
    document.body.append(container);

    const statusEl = document.getElementById("roomStatus");
    const startBtn = document.getElementById("startGameBtn");
    const backBtn = document.getElementById("backBtn");
    const mmNotifEl = document.getElementById("mmNotif");
    let lastStatusHtml = "";
    let lastMmNotification = null;

    const appendMmNotif = (line) => {
      if (!mmNotifEl) return;
      const prev = String(mmNotifEl.textContent || "");
      const next = prev ? `${prev}\n${line}` : line;
      const parts = next.split("\n");
      mmNotifEl.textContent = parts.slice(-40).join("\n");
      try {
        console.log(line);
      } catch { }
    };

    const readMatchmakingNotification = async () => {
      try {
        const data = await gql("query { lastNotification }");
        return data?.lastNotification || null;
      } catch {
        return null;
      }
    };

    const checkMatchmakingNotification = async () => {
      const current = await readMatchmakingNotification();
      if (current && current !== lastMmNotification) {
        lastMmNotification = current;
        appendMmNotif(`[${new Date().toISOString()}] ${current}`);
      }
    };

    backBtn.addEventListener("click", async () => {
      stopUpdates();
      try {
        await gql(`mutation { leaveRoom }`);
      } catch { }
      renderLobbyScreen();
    });

    startBtn.addEventListener("click", async () => {
      startBtn.setAttribute("disabled", "");
      startBtn.textContent = "STARTING...";
      try {
        await gql(`mutation { startGame }`);
      } catch {
        startBtn.textContent = "START GAME";
      }
    });

    let ticking = false;
    const tick = async () => {
      if (token !== viewToken) return;
      if (ticking) return;
      ticking = true;
      try {
        const data = await gql(`query {
          room { roomId hostChainId status gameState players { chainId name boardSubmitted } currentAttacker winnerChainId }
        }`);
        if (token !== viewToken) return;
        const room = data.room;
        if (!room) {
          statusEl.textContent = "Waiting for room to sync...";
          startBtn.setAttribute("disabled", "");
          await checkMatchmakingNotification();
          return;
        }

        if (room.hostChainId) {
          appState.isHost = room.hostChainId === appState.chainId;
          if (room.hostChainId !== appState.hostChainId) {
            appState.hostChainId = room.hostChainId;
            const hostEl = document.getElementById("hostChainValue");
            if (hostEl) hostEl.textContent = room.hostChainId;
            const copyBtn = document.getElementById("copyBtn");
            if (copyBtn) copyBtn.removeAttribute("disabled");
          }
        }

        const players = room.players || [];
        const bothJoined = players.length === 2;
        const bothSubmitted = bothJoined && players.every((p) => p.boardSubmitted);
        const me = players.find((p) => p.chainId === appState.chainId);
        const iSubmitted = Boolean(me?.boardSubmitted);
        const gameState = String(room.gameState || "").toUpperCase();

        const nextHtml = `
          <div class="lobby_players">
            ${players
            .map(
              (p) =>
                `<div class="lobby_player" style="font-size: 1.4rem; margin-bottom: 6px;">
                  <span class="lobby_v" style="font-weight: bold;">${escapeHtml(p.name)}</span>
                  <span class="lobby_k" style="font-size: 0.9em; opacity: 0.7;"> - ${p.boardSubmitted ? "READY" : "PREPARING"}</span>
                </div>`
            )
            .join("")}
          </div>
        `;
        if (nextHtml !== lastStatusHtml) {
          statusEl.innerHTML = nextHtml;
          lastStatusHtml = nextHtml;
        }

        if (bothJoined && gameState === "WAITING_FOR_PLAYER" && !iSubmitted) {
          stopUpdates();
          renderPlacementScreen();
          return;
        }
        if (gameState === "PLACING_BOARDS" && !iSubmitted) {
          stopUpdates();
          renderPlacementScreen();
          return;
        }
        if (gameState === "IN_GAME") {
          stopUpdates();
          renderGameScreen();
          return;
        }
        if (gameState === "ENDED") {
          startBtn.setAttribute("disabled", "");
          return;
        }

        if (appState.isHost && bothSubmitted) {
          startBtn.removeAttribute("disabled");
        } else {
          startBtn.setAttribute("disabled", "");
        }
        await checkMatchmakingNotification();
      } catch {
      } finally {
        ticking = false;
      }
    };

    tick();

    const subscribed = startNotifications(tick);
    if (!subscribed) {
      pollIntervalId = setInterval(tick, 800);
    }
  };

  const renderPlacementScreen = () => {
    stopUpdates();
    const token = ++viewToken;
    const board = gameboard();
    placementScreen(board, ships, {
      primaryButtonText: "SUBMIT BOARD",
      headerHtml: `
        <div class="lobby_meta">
          <div><span class="lobby_k">My chain:</span> <span class="lobby_v">${appState.chainId}</span></div>
          <div><span class="lobby_k">Host chain:</span> <span class="lobby_v">${appState.hostChainId}</span></div>
        </div>
      `,
      onSubmitBoard: async () => {
        const placements = board.getShips().map((s) => {
          const axis = s.ship.axis === "horiz" ? "HORIZ" : "VERT";
          return `{ row: ${s.beginningCoords[0]}, col: ${s.beginningCoords[1]}, length: ${s.ship.length}, axis: ${axis} }`;
        });
        try {
          await gql(`mutation { submitBoard(ships: [${placements.join(",")}]) }`);
          if (token === viewToken) {
            renderWaitingScreen();
          }
        } catch {
        }
      },
    });
  };

  const renderGameScreen = () => {
    stopUpdates();
    const token = ++viewToken;
    gameScreen({
      application: appState.application,
      client: appState.client,
      chainId: appState.chainId,
      hostChainId: appState.hostChainId,
      isHost: appState.isHost,
      playerName: appState.playerName,
      isActive: () => token === viewToken,
    });
  };

  PubSub.subscribe("RESTART GAME", () => {
    renderLobbyScreen();
  });

  const bootstrap = async () => {
    renderLobbyScreen(true); // Render "Loading..." state immediately
    try {
      await initLinera({ faucetUrl: LINERA_FAUCET_URL, applicationId: LINERA_APPLICATION_ID });
      renderLobbyScreen(false); // Render interactive lobby once ready
    } catch (e) {
      renderInitErrorScreen(e?.message || "Failed to connect");
    }
  };

  const bootstrapTests = async () => {
    renderLobbyScreen(true);
    try {
      await initLinera({ faucetUrl: LINERA_FAUCET_URL, applicationId: LINERA_APPLICATION_ID });
      renderTestsScreen();
    } catch (e) {
      renderInitErrorScreen(e?.message || "Failed to connect");
    }
  };

  if (isTestsPage) {
    bootstrapTests();
  } else {
    bootstrap();
  }
})();
