#![cfg_attr(target_arch = "wasm32", no_main)]

mod state;

use std::sync::Arc;

use async_graphql::{EmptySubscription, Object, Request, Response, Schema};
use battleship_game::{
    BattleshipAbi, Board, EnemyBoardView, GameState, MyBoardView, MyCellView, Operation, Room, RoomStatus,
    Invitation, RevealInfo, ShipPlacementInput, ShipView,
};
use linera_sdk::{linera_base_types::WithServiceAbi, views::View, Service, ServiceRuntime};

use self::state::BattleshipState;

linera_sdk::service!(BattleshipService);

pub struct BattleshipService {
    state: BattleshipState,
    runtime: Arc<ServiceRuntime<Self>>,
}

impl WithServiceAbi for BattleshipService {
    type Abi = BattleshipAbi;
}

impl Service for BattleshipService {
    type Parameters = ();

    async fn new(runtime: ServiceRuntime<Self>) -> Self {
        let state = BattleshipState::load(runtime.root_view_storage_context())
            .await
            .expect("Failed to load state");
        BattleshipService {
            state,
            runtime: Arc::new(runtime),
        }
    }

    async fn handle_query(&self, request: Request) -> Response {
        let room = self.state.room.get().clone();
        let enemy_view = self.state.enemy_view.get().clone();
        let board = self.state.board.get().clone();
        let has_board = board.is_some();
        let last_reveal = self.state.last_reveal.get().clone();
        let last_notification = self.state.last_notification.get().clone();
        let friends = self.state.friends.get().clone();
        let friend_requests_received = self.state.friend_requests_received.get().clone();
        let friend_requests_sent = self.state.friend_requests_sent.get().clone();
        let room_invitations = self.state.room_invitations.get().clone();
        let schema = Schema::build(
            QueryRoot {
                room,
                enemy_view,
                board,
                has_board,
                chain_id: self.runtime.chain_id().to_string(),
                last_reveal,
                last_notification,
                friends,
                friend_requests_received,
                friend_requests_sent,
                room_invitations,
            },
            MutationRoot {
                runtime: self.runtime.clone(),
            },
            EmptySubscription,
        )
        .finish();
        schema.execute(request).await
    }
}

struct QueryRoot {
    room: Option<Room>,
    enemy_view: Option<EnemyBoardView>,
    board: Option<Board>,
    has_board: bool,
    chain_id: String,
    last_reveal: Option<RevealInfo>,
    last_notification: Option<String>,
    friends: Vec<String>,
    friend_requests_received: Vec<String>,
    friend_requests_sent: Vec<String>,
    room_invitations: Vec<Invitation>,
}

#[Object]
impl QueryRoot {
    async fn room(&self) -> Option<&Room> {
        self.room.as_ref()
    }

    async fn room_status(&self) -> Option<RoomStatus> {
        self.room.as_ref().map(|r| r.status)
    }

    async fn game_state(&self) -> Option<GameState> {
        self.room.as_ref().map(|r| r.game_state)
    }

    async fn is_my_turn(&self) -> bool {
        self.room
            .as_ref()
            .and_then(|r| r.current_attacker.as_ref())
            .map(|attacker| attacker == &self.chain_id)
            .unwrap_or(false)
    }

    async fn enemy_view(&self) -> Option<&EnemyBoardView> {
        self.enemy_view.as_ref()
    }

    async fn has_submitted_board(&self) -> bool {
        self.has_board
    }

    async fn my_board(&self) -> Option<MyBoardView> {
        let board = self.board.as_ref()?;
        let size = board.size;
        let mut cells = Vec::with_capacity(board.cells.len());
        for row in 0..size {
            for col in 0..size {
                let idx = (row as usize) * (size as usize) + (col as usize);
                if let Some(cell) = board.cells.get(idx) {
                    cells.push(MyCellView {
                        row,
                        col,
                        ship_id: cell.ship_id,
                        attacked: cell.attacked,
                    });
                }
            }
        }

        let ships = board
            .ships
            .iter()
            .map(|s| ShipView {
                id: s.id,
                cells: s.cells.clone(),
            })
            .collect();

        Some(MyBoardView { size, cells, ships })
    }

    async fn last_reveal(&self) -> Option<&RevealInfo> {
        self.last_reveal.as_ref()
    }

    async fn last_notification(&self) -> Option<String> {
        self.last_notification.clone()
    }

    async fn friends(&self) -> Vec<String> {
        self.friends.clone()
    }

    async fn friend_requests_received(&self) -> Vec<String> {
        self.friend_requests_received.clone()
    }

    async fn friend_requests_sent(&self) -> Vec<String> {
        self.friend_requests_sent.clone()
    }

    async fn room_invitations(&self) -> Vec<Invitation> {
        self.room_invitations.clone()
    }
}

struct MutationRoot {
    runtime: Arc<ServiceRuntime<BattleshipService>>,
}

#[Object]
impl MutationRoot {
    async fn create_room(&self, host_name: String) -> String {
        self.runtime
            .schedule_operation(&Operation::CreateRoom { host_name: host_name.clone() });
        format!("Room created by '{}'", host_name)
    }

    async fn join_room(&self, host_chain_id: String, player_name: String) -> String {
        self.runtime.schedule_operation(&Operation::JoinRoom {
            host_chain_id: host_chain_id.clone(),
            player_name: player_name.clone(),
        });
        format!("Join request sent to {}", host_chain_id)
    }

    async fn search_player(&self, orchestrator_chain_id: String, player_name: String) -> String {
        self.runtime
            .schedule_operation(&Operation::SearchPlayer { orchestrator_chain_id: orchestrator_chain_id.clone(), player_name });
        format!("Search requested via {}", orchestrator_chain_id)
    }

    async fn submit_board(&self, ships: Vec<ShipPlacementInput>) -> String {
        self.runtime
            .schedule_operation(&Operation::SubmitBoard { ships });
        "Board submitted".to_string()
    }

    async fn start_game(&self) -> String {
        self.runtime.schedule_operation(&Operation::StartGame);
        "Start game requested".to_string()
    }

    async fn attack(&self, row: i32, col: i32) -> String {
        if row < 0 || col < 0 || row > 255 || col > 255 {
            return "Invalid coords".to_string();
        }
        self.runtime.schedule_operation(&Operation::Attack {
            row: row as u8,
            col: col as u8,
        });
        format!("Attack sent: ({},{})", row, col)
    }

    async fn leave_room(&self) -> String {
        self.runtime.schedule_operation(&Operation::LeaveRoom);
        "Leave requested".to_string()
    }

    async fn request_friend(&self, target_chain_id: String) -> String {
        self.runtime
            .schedule_operation(&Operation::RequestFriend { target_chain_id: target_chain_id.clone() });
        format!("Friend request sent to '{}'", target_chain_id)
    }

    async fn accept_friend(&self, requester_chain_id: String) -> String {
        self.runtime
            .schedule_operation(&Operation::AcceptFriend { requester_chain_id: requester_chain_id.clone() });
        format!("Friend request from '{}' accepted", requester_chain_id)
    }

    async fn decline_friend(&self, requester_chain_id: String) -> String {
        self.runtime
            .schedule_operation(&Operation::DeclineFriend { requester_chain_id: requester_chain_id.clone() });
        format!("Friend request from '{}' declined", requester_chain_id)
    }

    async fn invite_friend(&self, friend_chain_id: String) -> String {
        self.runtime
            .schedule_operation(&Operation::InviteFriend { friend_chain_id: friend_chain_id.clone() });
        format!("Invitation sent to '{}'", friend_chain_id)
    }

    async fn accept_invite(&self, host_chain_id: String, player_name: String) -> String {
        self.runtime.schedule_operation(&Operation::AcceptInvite {
            host_chain_id: host_chain_id.clone(),
            player_name,
        });
        format!("Invitation from '{}' accepted", host_chain_id)
    }

    async fn decline_invite(&self, host_chain_id: String) -> String {
        self.runtime
            .schedule_operation(&Operation::DeclineInvite { host_chain_id: host_chain_id.clone() });
        format!("Invitation from '{}' declined", host_chain_id)
    }
}
