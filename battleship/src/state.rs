use battleship_game::{Board, EnemyBoardView, Invitation, MatchmakingPlayer, RevealInfo, Room};
use linera_sdk::views::{linera_views, RegisterView, RootView, ViewStorageContext};

#[derive(RootView)]
#[view(context = ViewStorageContext)]
pub struct BattleshipState {
    pub room: RegisterView<Option<Room>>,
    pub board: RegisterView<Option<Board>>,
    pub enemy_view: RegisterView<Option<EnemyBoardView>>,
    pub subscribed_to_host: RegisterView<Option<String>>,
    pub last_reveal: RegisterView<Option<RevealInfo>>,
    pub last_notification: RegisterView<Option<String>>,
    pub friends: RegisterView<Vec<String>>,
    pub friend_requests_received: RegisterView<Vec<String>>,
    pub friend_requests_sent: RegisterView<Vec<String>>,
    pub room_invitations: RegisterView<Vec<Invitation>>,
    pub sent_invitations: RegisterView<Vec<String>>,
    pub matchmaking_queue: RegisterView<Vec<MatchmakingPlayer>>,
}
