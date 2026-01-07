# Battleship (Linera)

A Battleship game implemented as a Linera application (Rust smart contract + GraphQL service) with a JavaScript frontend that talks to Linera using `@linera/client`.

![Battleship gameplay](/gameplay.gif "Battleship gameplay")

## Game Overview

- Classic Battleship rules: each player places ships on a grid, then players alternate attacks.
- Two-player flow: one player hosts a room, the other joins. Boards are submitted, then turns begin.
- Turn-by-turn reveals: the attacker sends coordinates; the defender validates against their private board and returns a reveal result (hit/miss/sunk, next attacker, game over).

## Repository Layout

- Frontend (JavaScript): [app/](./app)
  - Main entry: [app/app.js](./app/app.js)
  - Linera config: [app/env.js](./app/env.js)
- Linera application (Rust): [battleship/](./battleship)
  - ABI + shared types: [battleship/src/lib.rs](./battleship/src/lib.rs)
  - Contract (state transitions + cross-chain messages): [battleship/src/contract.rs](./battleship/src/contract.rs)
  - Service (GraphQL queries/mutations): [battleship/src/service.rs](./battleship/src/service.rs)
- CLI integration test (GraphQL via curl): [battleship-test.cjs](./battleship-test.cjs)

## Frontend (How It Connects to Linera)

The frontend uses `@linera/client` to:

- Initialize the WASM runtime (`linera.initialize()`).
- Create or reuse a mnemonic stored in `localStorage`.
- Create a wallet and claim a chain from the faucet.
- Open the chain and attach to an application id.

Defaults are defined in [app/env.js](./app/env.js):

- `LINERA_FAUCET_URL`
- `LINERA_APPLICATION_ID` (the Battleship application id)
- `LINERA_MATCHMAKER_CHAIN_ID` (used by `searchPlayer`)

## Smart Contracts (Linera)

This repo contains a Linera application with:

- A contract (WASM) that owns state and executes operations.
- A service (WASM) that exposes a GraphQL API and schedules operations.

### State Model

The core on-chain model is a `Room` (see [lib.rs](./battleship/src/lib.rs)):

- `roomId`, `hostChainId`
- `status`: `Active | Ended`
- `gameState`: `WaitingForPlayer | PlacingBoards | InGame | Ended`
- `players`: list of `PlayerInfo { chainId, name, boardSubmitted }`
- `currentAttacker`, `pendingAttack`, `winnerChainId`

Each chain stores its own private `Board` (ship positions), and an `EnemyBoardView` (what you know about the opponent) plus helper fields such as `lastReveal`, `lastNotification`, friend lists and invitations (see [state.rs](./battleship/src/state.rs)).

### Cross-Chain Flow

The contract uses cross-chain messages (see `CrossChainMessage` in [lib.rs](./battleship/src/lib.rs)) to coordinate:

- Joining a room and syncing the initial room state.
- Notifying board submissions.
- Sending an `AttackRequest` to the defender.
- Returning a `RevealResult` to the attacker, including whether the attack was valid, hit/sunk info, and who attacks next.

### Operations (Contract Entry Points)

The service schedules these operations (defined in [lib.rs](./battleship/src/lib.rs)) and the contract executes them (see [contract.rs](./battleship/src/contract.rs)):

- `CreateRoom { hostName }`
- `JoinRoom { hostChainId, playerName }`
- `SearchPlayer { orchestratorChainId, playerName }`
- `SubmitBoard { ships }`
- `StartGame`
- `Attack { row, col }`
- `LeaveRoom`
- Friends:
  - `RequestFriend { targetChainId }`
  - `AcceptFriend { requesterChainId }`
  - `DeclineFriend { requesterChainId }`
  - `InviteFriend { friendChainId }`
  - `AcceptInvite { hostChainId, playerName }`
  - `DeclineInvite { hostChainId }`

## GraphQL API

The service exposes GraphQL queries for reading state and mutations for scheduling operations (see [service.rs](./battleship/src/service.rs)).

### Query Examples

```graphql
query {
  room {
    roomId
    hostChainId
    status
    gameState
    players { chainId name boardSubmitted }
    currentAttacker
    pendingAttack { row col }
    winnerChainId
  }
  isMyTurn
  hasSubmittedBoard
  enemyView { size cells }
  myBoard { size cells { row col shipId attacked } ships { id cells { row col } } }
  lastReveal { attackerChainId defenderChainId row col valid error hit sunk nextAttacker gameOver winnerChainId timestamp }
  lastNotification
  friends
  friendRequestsReceived
  friendRequestsSent
  roomInvitations { hostChainId timestamp }
}
```

### Mutation Examples

```graphql
mutation { createRoom(hostName: "Alice") }
mutation { joinRoom(hostChainId: "<HOST_CHAIN_ID>", playerName: "Bob") }
mutation { submitBoard(ships: [{row:0,col:0,length:5,axis:HORIZ}]) }
mutation { startGame }
mutation { attack(row: 2, col: 7) }
mutation { leaveRoom }
mutation { requestFriend(targetChainId: "<CHAIN_ID>") }
mutation { inviteFriend(friendChainId: "<CHAIN_ID>") }
```

## Running Locally

### Frontend

```bash
npm ci
npm run start
```

This uses a small Node HTTP server that sets cross-origin isolation headers (COOP/COEP/CORP) so the Linera web worker can run.

### Contract/Service Build

The Rust crate is in [battleship/Cargo.toml](./battleship/Cargo.toml) and produces:

- `battleship_contract` (contract WASM)
- `battleship_service` (service WASM)

Build and publish the Linera application:

```bash
cd battleship
cargo build --release --target wasm32-unknown-unknown

linera publish-and-create \
  target/wasm32-unknown-unknown/release/battleship_{contract,service}.wasm
```

Once you have an application id, set it in the frontend:

- Edit [app/env.js](./app/env.js), or
- Set `VITE_BATTLESHIP_APPLICATION_ID` / `BATTLESHIP_APPLICATION_ID` for scripts that read it.

## Integration Test (GraphQL via curl)

The script [battleship-test.cjs](./battleship-test.cjs) constructs local GraphQL endpoints like:

```
http://localhost:<PORT>/chains/<CHAIN_ID>/applications/<BATTLESHIP_APP_ID>
```

It reads configuration from environment variables (with fallbacks):

- `BATTLESHIP_APP_ID` (or `VITE_BATTLESHIP_APPLICATION_ID`)
- `MATCHMAKING_APP_ID` (or `VITE_MATCHMAKING_APPLICATION_ID`)
- `MAIN_CHAIN`, `AUTHOR_CHAIN`, `BUYER_CHAIN`
- `MAIN_PORT`, `AUTHOR_PORT`, `BUYER_PORT`

Run it after you have local Linera nodes and application ids:

```bash
node battleship-test.cjs
```
