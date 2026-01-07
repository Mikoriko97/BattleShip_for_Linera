#![cfg_attr(target_arch = "wasm32", no_main)]

mod state;

use battleship_game::{
    apply_attack, apply_sunk_padding, empty_enemy_view, set_enemy_view_cell, validate_and_build_board, BattleshipAbi,
    CrossChainMessage, EnemyCell, GameState, MatchmakingPlayer, Operation, PlayerInfo, RevealInfo, Room, RoomStatus,
};
use linera_sdk::{
    linera_base_types::{ChainId, WithContractAbi},
    views::{RootView, View},
    Contract, ContractRuntime,
};

use self::state::BattleshipState;

linera_sdk::contract!(BattleshipContract);

pub struct BattleshipContract {
    state: BattleshipState,
    runtime: ContractRuntime<Self>,
}

impl WithContractAbi for BattleshipContract {
    type Abi = BattleshipAbi;
}

impl BattleshipContract {
    fn ensure_room_mut(&mut self) -> Room {
        self.state.room.get().clone().expect("Room not found")
    }

    fn set_room(&mut self, room: Room) {
        self.state.room.set(Some(room));
    }

    fn is_host(&mut self, room: &Room) -> bool {
        room.host_chain_id == self.runtime.chain_id().to_string()
    }

    fn find_enemy_chain_id(&mut self, room: &Room) -> Option<ChainId> {
        let self_chain = self.runtime.chain_id().to_string();
        room.players
            .iter()
            .find(|p| p.chain_id != self_chain)
            .and_then(|p| p.chain_id.parse().ok())
    }

    fn ensure_enemy_view_created(&mut self, enemy_chain_id: &str) {
        let already = self.state
            .enemy_view
            .get()
            .as_ref()
            .map(|_| true)
            .unwrap_or(false);
        if already {
            return;
        }
        if let Some(room) = self.state.room.get() {
            if room.players.iter().any(|p| p.chain_id == enemy_chain_id) {
                self.state.enemy_view.set(Some(empty_enemy_view(10)));
            }
        }
    }
}

impl Contract for BattleshipContract {
    type Message = CrossChainMessage;
    type InstantiationArgument = ();
    type Parameters = ();
    type EventValue = ();

    async fn load(runtime: ContractRuntime<Self>) -> Self {
        let state = BattleshipState::load(runtime.root_view_storage_context())
            .await
            .expect("Failed to load state");
        BattleshipContract { state, runtime }
    }

    async fn instantiate(&mut self, _argument: ()) {
        self.state.room.set(None);
        self.state.board.set(None);
        self.state.enemy_view.set(None);
        self.state.subscribed_to_host.set(None);
        self.state.last_reveal.set(None);
        self.state.last_notification.set(None);
        self.state.matchmaking_queue.set(Vec::new());
    }

    async fn execute_operation(&mut self, operation: Operation) -> () {
        match operation {
            Operation::CreateRoom { host_name } => {
                let chain_id = self.runtime.chain_id().to_string();
                let room_id = self.runtime.system_time().micros().to_string();
                let room = Room {
                    room_id: room_id.clone(),
                    host_chain_id: chain_id.clone(),
                    status: RoomStatus::Active,
                    game_state: GameState::WaitingForPlayer,
                    players: vec![PlayerInfo {
                        chain_id: chain_id.clone(),
                        name: host_name,
                        board_submitted: false,
                    }],
                    current_attacker: None,
                    pending_attack: None,
                    winner_chain_id: None,
                };
                self.set_room(room.clone());
                self.state.last_reveal.set(None);
            }

            Operation::JoinRoom {
                host_chain_id,
                player_name,
            } => {
                let target_chain: ChainId = host_chain_id.parse().expect("Invalid host chain ID");
                let message = CrossChainMessage::JoinRequest {
                    player_chain_id: self.runtime.chain_id(),
                    player_name,
                };
                self.runtime.send_message(target_chain, message);
            }

            Operation::SearchPlayer {
                orchestrator_chain_id,
                player_name,
            } => {
                let orchestrator: ChainId =
                    orchestrator_chain_id.parse().expect("Invalid orchestrator chain ID");
                let player_chain_id = self.runtime.chain_id();
                self.state
                    .last_notification
                    .set(Some("Matchmaking search started".to_string()));
                self.runtime.send_message(
                    orchestrator,
                    CrossChainMessage::MatchmakingEnqueue {
                        player_chain_id,
                        player_name,
                    },
                );
            }

            Operation::SubmitBoard { ships } => {
                let board = validate_and_build_board(10, &ships).expect("Invalid board");
                self.state.board.set(Some(board));

                let mut room = self.ensure_room_mut();
                let self_chain = self.runtime.chain_id().to_string();
                if let Some(p) = room.players.iter_mut().find(|p| p.chain_id == self_chain) {
                    p.board_submitted = true;
                }
                self.set_room(room.clone());

                if self.is_host(&room) {
                    if let Some(enemy) = self.find_enemy_chain_id(&room) {
                        self.ensure_enemy_view_created(&enemy.to_string());
                        self.runtime.send_message(enemy, CrossChainMessage::RoomSync { room });
                    }
                } else if let Ok(host_chain) = room.host_chain_id.parse::<ChainId>() {
                    let player_chain_id = self.runtime.chain_id();
                    self.runtime.send_message(
                        host_chain,
                        CrossChainMessage::BoardSubmittedNotice {
                            player_chain_id,
                        },
                    );
                }
            }

            Operation::StartGame => {
                let mut room = self.ensure_room_mut();
                if !self.is_host(&room) {
                    panic!("Only host can start game");
                }
                if room.status != RoomStatus::Active {
                    panic!("Room not active");
                }
                if room.players.len() != 2 {
                    panic!("Need 2 players");
                }
                if !room.players.iter().all(|p| p.board_submitted) {
                    panic!("Both boards must be submitted");
                }
                let host_chain_id = self.runtime.chain_id();
                let sent_invites = self.state.sent_invitations.get().clone();
                for target in sent_invites {
                    if let Ok(target_chain) = target.parse::<ChainId>() {
                        self.runtime.send_message(
                            target_chain,
                            CrossChainMessage::RoomInvitationCancelled { host_chain_id },
                        );
                    }
                }
                self.state.sent_invitations.set(Vec::new());
                let host_chain = room.host_chain_id.clone();
                room.game_state = GameState::InGame;
                room.current_attacker = Some(host_chain.clone());
                room.pending_attack = None;
                self.set_room(room.clone());
                if let Some(enemy) = self.find_enemy_chain_id(&room) {
                    self.runtime.send_message(enemy, CrossChainMessage::RoomSync { room });
                }
            }

            Operation::Attack { row, col } => {
                let mut room = self.ensure_room_mut();
                if room.game_state != GameState::InGame {
                    panic!("Game not started");
                }
                let self_chain = self.runtime.chain_id().to_string();
                if room.current_attacker.as_deref() != Some(&self_chain) {
                    panic!("Not your turn");
                }
                if room.pending_attack.is_some() {
                    panic!("Pending attack not resolved");
                }

                if let Some(view) = self.state.enemy_view.get().clone() {
                    let idx = (row as usize) * (view.size as usize) + (col as usize);
                    if idx < view.cells.len() && view.cells[idx] != EnemyCell::Unknown {
                        panic!("Cell already revealed");
                    }
                }

                let enemy = self.find_enemy_chain_id(&room).expect("Enemy not found");
                room.pending_attack = Some(battleship_game::Coord { row, col });
                self.set_room(room.clone());
                self.state.last_reveal.set(None);

                let attacker_chain_id = self.runtime.chain_id();
                let message = CrossChainMessage::AttackRequest {
                    attacker_chain_id,
                    row,
                    col,
                };
                self.runtime.send_message(enemy, message);
            }

            Operation::LeaveRoom => {
                let room = self.state.room.get().clone();
                if let Some(room) = room {
                    if room.status == RoomStatus::Active {
                        if let Some(enemy) = self.find_enemy_chain_id(&room) {
                            let self_chain_id = self.runtime.chain_id();
                            self.runtime.send_message(
                                enemy,
                                CrossChainMessage::LeaveNotice {
                                    player_chain_id: self_chain_id,
                                },
                            );
                        }
                    }
                }
                self.state.room.set(None);
                self.state.board.set(None);
                self.state.enemy_view.set(None);
                self.state.subscribed_to_host.set(None);
                self.state.last_reveal.set(None);
            }

            Operation::RequestFriend { target_chain_id } => {
                let target_chain: ChainId = target_chain_id.parse().expect("Invalid chain ID");
                let friends = self.state.friends.get().clone();
                if friends.contains(&target_chain_id) {
                    return;
                }
                let mut sent = self.state.friend_requests_sent.get().clone();
                if !sent.contains(&target_chain_id) {
                    sent.push(target_chain_id.clone());
                    self.state.friend_requests_sent.set(sent);
                    let requester_chain_id = self.runtime.chain_id();
                    self.runtime.send_message(
                        target_chain,
                        CrossChainMessage::FriendRequest { requester_chain_id },
                    );
                }
            }

            Operation::AcceptFriend { requester_chain_id } => {
                let mut received = self.state.friend_requests_received.get().clone();
                if let Some(pos) = received.iter().position(|x| x == &requester_chain_id) {
                    received.remove(pos);
                    self.state.friend_requests_received.set(received);

                    let mut friends = self.state.friends.get().clone();
                    if !friends.contains(&requester_chain_id) {
                        friends.push(requester_chain_id.clone());
                        self.state.friends.set(friends);

                        let target_chain: ChainId =
                            requester_chain_id.parse().expect("Invalid chain ID");
                        let target_chain_id = self.runtime.chain_id();
                        self.runtime.send_message(
                            target_chain,
                            CrossChainMessage::FriendAccepted { target_chain_id },
                        );
                    }
                }
            }

            Operation::DeclineFriend { requester_chain_id } => {
                let mut received = self.state.friend_requests_received.get().clone();
                if let Some(pos) = received.iter().position(|x| x == &requester_chain_id) {
                    received.remove(pos);
                    self.state.friend_requests_received.set(received);
                }
            }

            Operation::InviteFriend { friend_chain_id } => {
                let room = self.ensure_room_mut();
                if !self.is_host(&room) {
                    panic!("Only host can invite");
                }
                if room.status != RoomStatus::Active {
                    panic!("Room not active");
                }
                if room.players.len() >= 2 {
                    panic!("Room full");
                }
                let friends = self.state.friends.get().clone();
                if !friends.contains(&friend_chain_id) {
                    panic!("Not friends");
                }

                let mut sent_invites = self.state.sent_invitations.get().clone();
                if sent_invites.contains(&friend_chain_id) {
                    return;
                }
                sent_invites.push(friend_chain_id.clone());
                self.state.sent_invitations.set(sent_invites);

                let target_chain: ChainId = friend_chain_id.parse().expect("Invalid chain ID");
                let host_chain_id = self.runtime.chain_id();
                let timestamp = self.runtime.system_time().micros().to_string();
                self.runtime.send_message(
                    target_chain,
                    CrossChainMessage::RoomInvitation {
                        host_chain_id,
                        timestamp,
                    },
                );
            }

            Operation::AcceptInvite {
                host_chain_id,
                player_name,
            } => {
                let mut invitations = self.state.room_invitations.get().clone();
                if let Some(pos) = invitations
                    .iter()
                    .position(|inv| inv.host_chain_id == host_chain_id)
                {
                    let invite = invitations[pos].clone();
                    let invite_time: u64 = invite.timestamp.parse().unwrap_or(0);
                    let current_time = self.runtime.system_time().micros();
                    invitations.remove(pos);
                    self.state.room_invitations.set(invitations);

                    if current_time > invite_time && current_time.saturating_sub(invite_time) <= 300_000_000
                    {
                        let target_chain: ChainId =
                            host_chain_id.parse().expect("Invalid host chain ID");
                        let message = CrossChainMessage::JoinRequest {
                            player_chain_id: self.runtime.chain_id(),
                            player_name,
                        };
                        self.runtime.send_message(target_chain, message);
                    }
                }
            }

            Operation::DeclineInvite { host_chain_id } => {
                let mut invitations = self.state.room_invitations.get().clone();
                if let Some(pos) = invitations
                    .iter()
                    .position(|inv| inv.host_chain_id == host_chain_id)
                {
                    invitations.remove(pos);
                    self.state.room_invitations.set(invitations);
                }
            }
        }
    }

    async fn execute_message(&mut self, message: Self::Message) {
        match message {
            CrossChainMessage::JoinRequest {
                player_chain_id,
                player_name,
            } => {
                let mut room = self.ensure_room_mut();
                if !self.is_host(&room) {
                    panic!("Only host can accept joins");
                }
                if room.status != RoomStatus::Active {
                    panic!("Room not active");
                }
                if room.players.len() >= 2 {
                    panic!("Room full");
                }
                let mut sent_invites = self.state.sent_invitations.get().clone();
                let player_str = player_chain_id.to_string();
                if let Some(pos) = sent_invites.iter().position(|x| x == &player_str) {
                    sent_invites.remove(pos);
                    self.state.sent_invitations.set(sent_invites);
                }
                room.players.push(PlayerInfo {
                    chain_id: player_chain_id.to_string(),
                    name: player_name.clone(),
                    board_submitted: false,
                });
                room.game_state = GameState::PlacingBoards;
                self.set_room(room.clone());

                self.runtime.send_message(
                    player_chain_id,
                    CrossChainMessage::InitialStateSync { room: room.clone() },
                );
            }

            CrossChainMessage::InitialStateSync { room } => {
                self.state.room.set(Some(room.clone()));
                self.state
                    .last_notification
                    .set(Some("Room ready".to_string()));
                if let Some(enemy) = self.find_enemy_chain_id(&room) {
                    self.ensure_enemy_view_created(&enemy.to_string());
                }
            }

            CrossChainMessage::RoomSync { room } => {
                self.state.room.set(Some(room.clone()));
                if let Some(enemy) = self.find_enemy_chain_id(&room) {
                    self.ensure_enemy_view_created(&enemy.to_string());
                }
            }

            CrossChainMessage::BoardSubmittedNotice { player_chain_id } => {
                let mut room = self.ensure_room_mut();
                if !self.is_host(&room) {
                    return;
                }
                if let Some(p) = room
                    .players
                    .iter_mut()
                    .find(|p| p.chain_id == player_chain_id.to_string())
                {
                    p.board_submitted = true;
                }
                self.set_room(room.clone());
                let host_chain = self.runtime.chain_id();
                for p in room.players.iter() {
                    if let Ok(target_chain) = p.chain_id.parse::<ChainId>() {
                        if target_chain != host_chain {
                            self.runtime
                                .send_message(target_chain, CrossChainMessage::RoomSync { room: room.clone() });
                        }
                    }
                }
            }

            CrossChainMessage::AttackRequest {
                attacker_chain_id,
                row,
                col,
            } => {
                let mut room = self.ensure_room_mut();
                if room.game_state != GameState::InGame {
                    return;
                }
                if room.current_attacker.as_deref() != Some(&attacker_chain_id.to_string()) {
                    return;
                }

                let mut board = self.state.board.get().clone().expect("Board not submitted");
                let res = apply_attack(&mut board, row, col);
                if let Err(err) = res {
                    let defender_chain_id = self.runtime.chain_id();
                    self.state.last_reveal.set(Some(RevealInfo {
                        attacker_chain_id: attacker_chain_id.to_string(),
                        defender_chain_id: defender_chain_id.to_string(),
                        row,
                        col,
                        valid: false,
                        error: Some(err.clone()),
                        hit: false,
                        sunk: false,
                        sunk_ship_cells: None,
                        adjacent_coords: None,
                        next_attacker: attacker_chain_id.to_string(),
                        game_over: false,
                        winner_chain_id: None,
                        timestamp: self.runtime.system_time().micros().to_string(),
                    }));
                    self.runtime.send_message(
                        attacker_chain_id,
                        CrossChainMessage::RevealResult {
                            defender_chain_id,
                            row,
                            col,
                            valid: false,
                            error: Some(err),
                            hit: false,
                            sunk: false,
                            sunk_ship_cells: None,
                            adjacent_coords: None,
                            next_attacker: attacker_chain_id,
                            game_over: false,
                            winner_chain_id: None,
                        },
                    );
                    return;
                }

                let (hit, sunk, ship_id, game_over) = res.unwrap();
                let mut sunk_ship_cells = None;
                let mut adjacent_coords = None;
                if sunk {
                    if let Some(ship_id) = ship_id {
                        if let Ok((ship_cells, adjacent)) = apply_sunk_padding(&mut board, ship_id) {
                            sunk_ship_cells = Some(ship_cells);
                            adjacent_coords = Some(adjacent);
                        }
                    }
                }
                self.state.board.set(Some(board));

                let defender_chain_id = self.runtime.chain_id();
                let next_attacker = if hit { attacker_chain_id } else { defender_chain_id };
                room.current_attacker = Some(next_attacker.to_string());
                room.pending_attack = None;
                if game_over {
                    room.game_state = GameState::Ended;
                    room.status = RoomStatus::Ended;
                    room.winner_chain_id = Some(attacker_chain_id.to_string());
                }
                self.set_room(room.clone());
                self.state.last_reveal.set(Some(RevealInfo {
                    attacker_chain_id: attacker_chain_id.to_string(),
                    defender_chain_id: defender_chain_id.to_string(),
                    row,
                    col,
                    valid: true,
                    error: None,
                    hit,
                    sunk,
                    sunk_ship_cells: sunk_ship_cells.clone(),
                    adjacent_coords: adjacent_coords.clone(),
                    next_attacker: next_attacker.to_string(),
                    game_over,
                    winner_chain_id: if game_over { Some(attacker_chain_id.to_string()) } else { None },
                    timestamp: self.runtime.system_time().micros().to_string(),
                }));

                self.runtime.send_message(
                    attacker_chain_id,
                    CrossChainMessage::RevealResult {
                        defender_chain_id,
                        row,
                        col,
                        valid: true,
                        error: None,
                        hit,
                        sunk,
                        sunk_ship_cells,
                        adjacent_coords,
                        next_attacker,
                        game_over,
                        winner_chain_id: if game_over { Some(attacker_chain_id) } else { None },
                    },
                );
            }

            CrossChainMessage::RevealResult {
                defender_chain_id,
                row,
                col,
                valid,
                error,
                hit,
                sunk,
                sunk_ship_cells,
                adjacent_coords,
                next_attacker,
                game_over,
                winner_chain_id,
            } => {
                let mut room = self.ensure_room_mut();
                if room.game_state != GameState::InGame && room.game_state != GameState::Ended {
                    return;
                }
                if let Some(pending) = room.pending_attack {
                    if pending.row != row || pending.col != col {
                        return;
                    }
                } else {
                    return;
                }

                let attacker_chain_id = self.runtime.chain_id().to_string();
                self.state.last_reveal.set(Some(RevealInfo {
                    attacker_chain_id,
                    defender_chain_id: defender_chain_id.to_string(),
                    row,
                    col,
                    valid,
                    error: error.clone(),
                    hit,
                    sunk,
                    sunk_ship_cells: sunk_ship_cells.clone(),
                    adjacent_coords: adjacent_coords.clone(),
                    next_attacker: next_attacker.to_string(),
                    game_over,
                    winner_chain_id: winner_chain_id.map(|c| c.to_string()),
                    timestamp: self.runtime.system_time().micros().to_string(),
                }));

                if valid {
                    let mut view = self
                        .state
                        .enemy_view
                        .get()
                        .clone()
                        .unwrap_or_else(|| empty_enemy_view(10));
                    if sunk {
                        set_enemy_view_cell(&mut view, row, col, EnemyCell::Sunk).ok();
                        if let Some(cells) = sunk_ship_cells.as_ref() {
                            for c in cells {
                                set_enemy_view_cell(&mut view, c.row, c.col, EnemyCell::Sunk).ok();
                            }
                        }
                        if let Some(adj) = adjacent_coords.as_ref() {
                            for c in adj {
                                let idx = (c.row as usize) * (view.size as usize) + (c.col as usize);
                                if idx < view.cells.len() && view.cells[idx] == EnemyCell::Unknown {
                                    set_enemy_view_cell(&mut view, c.row, c.col, EnemyCell::Miss).ok();
                                }
                            }
                        }
                    } else if hit {
                        set_enemy_view_cell(&mut view, row, col, EnemyCell::Hit).ok();
                    } else {
                        set_enemy_view_cell(&mut view, row, col, EnemyCell::Miss).ok();
                    }
                    self.state.enemy_view.set(Some(view));
                }

                room.current_attacker = Some(next_attacker.to_string());
                room.pending_attack = None;
                if game_over {
                    room.game_state = GameState::Ended;
                    room.status = RoomStatus::Ended;
                    room.winner_chain_id = winner_chain_id.map(|c| c.to_string());
                }
                let room_id = room.room_id.clone();
                self.set_room(room.clone());

                if !valid {
                    return;
                }

                let _ = defender_chain_id;
                let _ = room_id;
            }

            CrossChainMessage::LeaveNotice { player_chain_id } => {
                let mut room = self.ensure_room_mut();
                if room.status != RoomStatus::Active {
                    return;
                }
                let winner_chain_id = self.runtime.chain_id().to_string();
                room.status = RoomStatus::Ended;
                room.game_state = GameState::Ended;
                room.winner_chain_id = Some(winner_chain_id.clone());
                let room_id = room.room_id.clone();
                self.set_room(room);
                let _ = (player_chain_id, room_id);
            }

            CrossChainMessage::FriendRequest { requester_chain_id } => {
                let requester_str = requester_chain_id.to_string();
                let friends = self.state.friends.get().clone();
                if friends.contains(&requester_str) {
                    return;
                }
                let mut received = self.state.friend_requests_received.get().clone();
                if !received.contains(&requester_str) {
                    received.push(requester_str);
                    self.state.friend_requests_received.set(received);
                }
            }

            CrossChainMessage::FriendAccepted { target_chain_id } => {
                let target_str = target_chain_id.to_string();
                let mut friends = self.state.friends.get().clone();
                if !friends.contains(&target_str) {
                    friends.push(target_str.clone());
                    self.state.friends.set(friends);
                }
                let mut sent = self.state.friend_requests_sent.get().clone();
                if let Some(pos) = sent.iter().position(|x| x == &target_str) {
                    sent.remove(pos);
                    self.state.friend_requests_sent.set(sent);
                }
            }

            CrossChainMessage::RoomInvitation { host_chain_id, timestamp } => {
                let host_str = host_chain_id.to_string();
                let mut invitations = self.state.room_invitations.get().clone();
                if !invitations.iter().any(|inv| inv.host_chain_id == host_str) {
                    invitations.push(battleship_game::Invitation {
                        host_chain_id: host_str,
                        timestamp,
                    });
                    self.state.room_invitations.set(invitations);
                }
            }

            CrossChainMessage::RoomInvitationCancelled { host_chain_id } => {
                let host_str = host_chain_id.to_string();
                let mut invitations = self.state.room_invitations.get().clone();
                if let Some(pos) = invitations.iter().position(|inv| inv.host_chain_id == host_str) {
                    invitations.remove(pos);
                    self.state.room_invitations.set(invitations);
                }
            }

            CrossChainMessage::MatchmakingEnqueue {
                player_chain_id,
                player_name,
            } => {
                let mut queue = self.state.matchmaking_queue.get().clone();
                let player_chain_str = player_chain_id.to_string();
                if !queue.iter().any(|p| p.chain_id == player_chain_str) {
                    queue.push(MatchmakingPlayer {
                        chain_id: player_chain_str,
                        player_name: player_name.clone(),
                    });
                    self.state.matchmaking_queue.set(queue.clone());
                }

                let orchestrator_chain_id = self.runtime.chain_id();
                self.runtime.send_message(
                    player_chain_id,
                    CrossChainMessage::MatchmakingEnqueued {
                        orchestrator_chain_id,
                    },
                );

                if queue.len() < 2 {
                    return;
                }

                let host = queue.remove(0);
                let guest = queue.remove(0);
                self.state.matchmaking_queue.set(queue);

                let host_chain_id: ChainId = host.chain_id.parse().expect("Invalid host chain ID");
                let guest_chain_id: ChainId =
                    guest.chain_id.parse().expect("Invalid guest chain ID");
                self.runtime.send_message(
                    host_chain_id,
                    CrossChainMessage::MatchmakingStart {
                        host_name: host.player_name,
                        guest_chain_id,
                        guest_name: guest.player_name,
                    },
                );
                self.runtime.send_message(
                    guest_chain_id,
                    CrossChainMessage::MatchmakingFound { host_chain_id },
                );
            }

            CrossChainMessage::MatchmakingEnqueued {
                orchestrator_chain_id,
            } => {
                self.state.last_notification.set(Some(format!(
                    "Enqueued on {}",
                    orchestrator_chain_id
                )));
            }

            CrossChainMessage::MatchmakingStart {
                host_name,
                guest_chain_id,
                guest_name,
            } => {
                if let Some(room) = self.state.room.get().clone() {
                    if room.status == RoomStatus::Active {
                        return;
                    }
                }

                let chain_id = self.runtime.chain_id().to_string();
                let room_id = self.runtime.system_time().micros().to_string();
                let room = Room {
                    room_id,
                    host_chain_id: chain_id.clone(),
                    status: RoomStatus::Active,
                    game_state: GameState::PlacingBoards,
                    players: vec![
                        PlayerInfo {
                            chain_id: chain_id.clone(),
                            name: host_name,
                            board_submitted: false,
                        },
                        PlayerInfo {
                            chain_id: guest_chain_id.to_string(),
                            name: guest_name,
                            board_submitted: false,
                        },
                    ],
                    current_attacker: None,
                    pending_attack: None,
                    winner_chain_id: None,
                };
                self.state.board.set(None);
                self.state.enemy_view.set(None);
                self.set_room(room.clone());
                self.state.last_reveal.set(None);
                self.state
                    .last_notification
                    .set(Some("Match found (host)".to_string()));
                self.ensure_enemy_view_created(&guest_chain_id.to_string());
                self.runtime.send_message(guest_chain_id, CrossChainMessage::InitialStateSync { room });
            }

            CrossChainMessage::MatchmakingFound { host_chain_id } => {
                self.state.last_notification.set(Some(format!(
                    "Match found. Host: {}",
                    host_chain_id
                )));
            }
        }
    }

    async fn process_streams(
        &mut self,
        _streams: Vec<linera_sdk::linera_base_types::StreamUpdate>,
    ) {
    }

    async fn store(mut self) {
        let _ = self.state.save().await;
    }
}
