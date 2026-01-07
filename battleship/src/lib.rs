use async_graphql::{Request, Response};
use linera_sdk::linera_base_types::{ChainId, ContractAbi, ServiceAbi};
use serde::{Deserialize, Serialize};

pub struct BattleshipAbi;

impl ContractAbi for BattleshipAbi {
    type Operation = Operation;
    type Response = ();
}

impl ServiceAbi for BattleshipAbi {
    type Query = Request;
    type QueryResponse = Response;
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, async_graphql::Enum)]
pub enum RoomStatus {
    Active,
    Ended,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, async_graphql::Enum)]
pub enum GameState {
    WaitingForPlayer,
    PlacingBoards,
    InGame,
    Ended,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, async_graphql::Enum)]
pub enum Axis {
    Horiz,
    Vert,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash, async_graphql::SimpleObject)]
#[graphql(rename_fields = "camelCase")]
pub struct Coord {
    pub row: u8,
    pub col: u8,
}

#[derive(Debug, Clone, Serialize, Deserialize, async_graphql::SimpleObject)]
#[graphql(rename_fields = "camelCase")]
pub struct PlayerInfo {
    pub chain_id: String,
    pub name: String,
    pub board_submitted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, async_graphql::SimpleObject)]
#[graphql(rename_fields = "camelCase")]
pub struct Room {
    pub room_id: String,
    pub host_chain_id: String,
    pub status: RoomStatus,
    pub game_state: GameState,
    pub players: Vec<PlayerInfo>,
    pub current_attacker: Option<String>,
    pub pending_attack: Option<Coord>,
    pub winner_chain_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, async_graphql::SimpleObject)]
#[graphql(rename_fields = "camelCase")]
pub struct RevealInfo {
    pub attacker_chain_id: String,
    pub defender_chain_id: String,
    pub row: u8,
    pub col: u8,
    pub valid: bool,
    pub error: Option<String>,
    pub hit: bool,
    pub sunk: bool,
    pub sunk_ship_cells: Option<Vec<Coord>>,
    pub adjacent_coords: Option<Vec<Coord>>,
    pub next_attacker: String,
    pub game_over: bool,
    pub winner_chain_id: Option<String>,
    pub timestamp: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, async_graphql::SimpleObject)]
#[graphql(rename_fields = "camelCase")]
pub struct Invitation {
    pub host_chain_id: String,
    pub timestamp: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, async_graphql::Enum)]
pub enum EnemyCell {
    Unknown,
    Miss,
    Hit,
    Sunk,
}

#[derive(Debug, Clone, Serialize, Deserialize, async_graphql::SimpleObject)]
#[graphql(rename_fields = "camelCase")]
pub struct EnemyBoardView {
    pub size: u8,
    pub cells: Vec<EnemyCell>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Board {
    pub size: u8,
    pub cells: Vec<Cell>,
    pub ships: Vec<Ship>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct Cell {
    pub ship_id: Option<u8>,
    pub attacked: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Ship {
    pub id: u8,
    pub cells: Vec<Coord>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, async_graphql::SimpleObject)]
#[graphql(rename_fields = "camelCase")]
pub struct MyCellView {
    pub row: u8,
    pub col: u8,
    pub ship_id: Option<u8>,
    pub attacked: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, async_graphql::SimpleObject)]
#[graphql(rename_fields = "camelCase")]
pub struct ShipView {
    pub id: u8,
    pub cells: Vec<Coord>,
}

#[derive(Debug, Clone, Serialize, Deserialize, async_graphql::SimpleObject)]
#[graphql(rename_fields = "camelCase")]
pub struct MyBoardView {
    pub size: u8,
    pub cells: Vec<MyCellView>,
    pub ships: Vec<ShipView>,
}

#[derive(Debug, Clone, Serialize, Deserialize, async_graphql::InputObject)]
#[graphql(rename_fields = "camelCase")]
pub struct ShipPlacementInput {
    pub row: u8,
    pub col: u8,
    pub length: u8,
    pub axis: Axis,
}

#[derive(Debug, Serialize, Deserialize)]
pub enum Operation {
    CreateRoom { host_name: String },
    JoinRoom { host_chain_id: String, player_name: String },
    SearchPlayer {
        orchestrator_chain_id: String,
        player_name: String,
    },
    SubmitBoard { ships: Vec<ShipPlacementInput> },
    StartGame,
    Attack { row: u8, col: u8 },
    LeaveRoom,
    RequestFriend { target_chain_id: String },
    AcceptFriend { requester_chain_id: String },
    DeclineFriend { requester_chain_id: String },
    InviteFriend { friend_chain_id: String },
    AcceptInvite { host_chain_id: String, player_name: String },
    DeclineInvite { host_chain_id: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MatchmakingPlayer {
    pub chain_id: String,
    pub player_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum CrossChainMessage {
    JoinRequest { player_chain_id: ChainId, player_name: String },
    InitialStateSync { room: Room },
    RoomSync { room: Room },
    BoardSubmittedNotice { player_chain_id: ChainId },
    AttackRequest { attacker_chain_id: ChainId, row: u8, col: u8 },
    RevealResult {
        defender_chain_id: ChainId,
        row: u8,
        col: u8,
        valid: bool,
        error: Option<String>,
        hit: bool,
        sunk: bool,
        sunk_ship_cells: Option<Vec<Coord>>,
        adjacent_coords: Option<Vec<Coord>>,
        next_attacker: ChainId,
        game_over: bool,
        winner_chain_id: Option<ChainId>,
    },
    LeaveNotice { player_chain_id: ChainId },
    FriendRequest { requester_chain_id: ChainId },
    FriendAccepted { target_chain_id: ChainId },
    RoomInvitation { host_chain_id: ChainId, timestamp: String },
    RoomInvitationCancelled { host_chain_id: ChainId },
    MatchmakingEnqueue {
        player_chain_id: ChainId,
        player_name: String,
    },
    MatchmakingEnqueued {
        orchestrator_chain_id: ChainId,
    },
    MatchmakingStart {
        host_name: String,
        guest_chain_id: ChainId,
        guest_name: String,
    },
    MatchmakingFound {
        host_chain_id: ChainId,
    },
}

pub fn empty_enemy_view(size: u8) -> EnemyBoardView {
    EnemyBoardView {
        size,
        cells: vec![EnemyCell::Unknown; (size as usize) * (size as usize)],
    }
}

fn idx(size: u8, row: u8, col: u8) -> usize {
    (row as usize) * (size as usize) + (col as usize)
}

pub fn validate_and_build_board(
    size: u8,
    placements: &[ShipPlacementInput],
) -> Result<Board, String> {
    if size == 0 {
        return Err("Invalid board size".into());
    }
    let mut cells = vec![
        Cell {
            ship_id: None,
            attacked: false
        };
        (size as usize) * (size as usize)
    ];
    let mut ships: Vec<Ship> = Vec::new();
    let mut next_ship_id: u8 = 0;

    for placement in placements {
        if placement.length == 0 {
            return Err("Ship length must be > 0".into());
        }
        let max_index = size.saturating_sub(1);
        if placement.row > max_index || placement.col > max_index {
            return Err("Ship start out of bounds".into());
        }

        let mut ship_cells: Vec<Coord> = Vec::with_capacity(placement.length as usize);
        for i in 0..placement.length {
            let (r, c) = match placement.axis {
                Axis::Horiz => (placement.row, placement.col.saturating_add(i)),
                Axis::Vert => (placement.row.saturating_add(i), placement.col),
            };
            if r > max_index || c > max_index {
                return Err("Ship out of bounds".into());
            }
            ship_cells.push(Coord { row: r, col: c });
        }

        for coord in &ship_cells {
            let index = idx(size, coord.row, coord.col);
            if cells[index].ship_id.is_some() {
                return Err("Ships overlap".into());
            }
            for dr in [-1i8, 0, 1] {
                for dc in [-1i8, 0, 1] {
                    if dr == 0 && dc == 0 {
                        continue;
                    }
                    let nr = coord.row as i16 + dr as i16;
                    let nc = coord.col as i16 + dc as i16;
                    if nr < 0 || nc < 0 {
                        continue;
                    }
                    let nr = nr as u8;
                    let nc = nc as u8;
                    if nr > max_index || nc > max_index {
                        continue;
                    }
                    let nindex = idx(size, nr, nc);
                    if cells[nindex].ship_id.is_some() {
                        return Err("Ships must not touch (including diagonals)".into());
                    }
                }
            }
        }

        for coord in &ship_cells {
            let index = idx(size, coord.row, coord.col);
            cells[index].ship_id = Some(next_ship_id);
        }

        ships.push(Ship {
            id: next_ship_id,
            cells: ship_cells,
        });
        next_ship_id = next_ship_id.saturating_add(1);
    }

    Ok(Board { size, cells, ships })
}

pub fn apply_attack(board: &mut Board, row: u8, col: u8) -> Result<(bool, bool, Option<u8>, bool), String> {
    let max_index = board.size.saturating_sub(1);
    if row > max_index || col > max_index {
        return Err("Attack out of bounds".into());
    }
    let index = idx(board.size, row, col);
    if board.cells[index].attacked {
        return Err("Cell already attacked".into());
    }
    board.cells[index].attacked = true;
    let ship_id = board.cells[index].ship_id;
    let hit = ship_id.is_some();
    let mut sunk = false;
    if let Some(sid) = ship_id {
        if let Some(ship) = board.ships.iter().find(|s| s.id == sid) {
            sunk = ship.cells.iter().all(|c| board.cells[idx(board.size, c.row, c.col)].attacked);
        }
    }
    let game_over = board
        .ships
        .iter()
        .all(|ship| ship.cells.iter().all(|c| board.cells[idx(board.size, c.row, c.col)].attacked));
    Ok((hit, sunk, ship_id, game_over))
}

pub fn apply_sunk_padding(
    board: &mut Board,
    ship_id: u8,
) -> Result<(Vec<Coord>, Vec<Coord>), String> {
    let ship = board
        .ships
        .iter()
        .find(|s| s.id == ship_id)
        .ok_or_else(|| "Ship not found".to_string())?;
    let mut adjacent: Vec<Coord> = Vec::new();
    let max_index = board.size.saturating_sub(1);

    for coord in &ship.cells {
        for dr in [-1i8, 0, 1] {
            for dc in [-1i8, 0, 1] {
                let nr = coord.row as i16 + dr as i16;
                let nc = coord.col as i16 + dc as i16;
                if nr < 0 || nc < 0 {
                    continue;
                }
                let nr = nr as u8;
                let nc = nc as u8;
                if nr > max_index || nc > max_index {
                    continue;
                }
                let index = idx(board.size, nr, nc);
                let cell = &mut board.cells[index];
                if cell.ship_id.is_some() {
                    continue;
                }
                if cell.attacked {
                    continue;
                }
                cell.attacked = true;
                adjacent.push(Coord { row: nr, col: nc });
            }
        }
    }

    Ok((ship.cells.clone(), adjacent))
}

pub fn set_enemy_view_cell(view: &mut EnemyBoardView, row: u8, col: u8, value: EnemyCell) -> Result<(), String> {
    let max_index = view.size.saturating_sub(1);
    if row > max_index || col > max_index {
        return Err("Coord out of bounds".into());
    }
    let index = idx(view.size, row, col);
    view.cells[index] = value;
    Ok(())
}
