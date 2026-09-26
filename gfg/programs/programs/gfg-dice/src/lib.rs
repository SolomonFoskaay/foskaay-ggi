// gfg-dice
// GlobalFolkGames provably-fair dice, gasless for end users.
//
// A player requests VRF randomness through the MagicBlock VRF program.
// A verified oracle fulfills the request and the VRF program calls back into
// callback_roll_dice, which stores two dice values (1..=6) on the player's PDA.
//
// Ephemeral Rollup (ER) integration:
//   - `initialize`  : creates the player's dice PDA (base layer, app pays).
//   - `delegate`    : moves the PDA into a MagicBlock ER session (base layer,
//                     app pays) so rolls run gasless on the rollup.
//   - `roll_dice`   : requests VRF randomness. On the ER it is free and the
//                     player's session key is the only signer (no SOL needed).
//   - `commit`/`undelegate`: optional manual state pushes back to base layer.
//
// Points / rewards (Scope B — on-chain points):
//   - `initialize_points`: creates the player's POINTS PDA (base layer, app
//                          pays rent). Seed `gfgpoints`, same player_authority.
//   - `delegate_points`  : moves the points PDA into the ER session (base
//                          layer, app pays) so records run gasless.
//   - `record_points`    : appends an award to the points PDA on the ER. FREE
//                          for the player (session key signs, no SOL needed).
//                          The transaction signature is the authoritative
//                          on-chain receipt of the reward.
//
// Match results (Scope C — on-chain finish order):
//   - `initialize_result`: creates the player's RESULT PDA (base layer, app
//                          pays rent). Seed `gfgresult`, same player_authority.
//   - `delegate_result`  : moves the result PDA into the ER session (base
//                          layer, app pays) so records run gasless.
//   - `record_result`    : commits the FULL 1st..4th finish order of a match
//                          on the ER. FREE for the player (session key signs,
//                          no SOL). This completes the on-chain match story:
//                          dice roll -> reward points -> full finish order.
//
// Competitions (S2 — earn + brand escrow, 30/70 rake):
//   - `initialize_comp`  : creates a Competition escrow PDA (base layer, app
//                          pays rent). Seed `gfgcomp` + comp_id, authority =
//                          the sponsor (brand / the app relay).
//   - `delegate_comp`    : moves the competition PDA into the ER session so
//                          fund/settle/claim run gasless.
//   - `fund_comp`        : the sponsor LOCKS the prize pool on-chain BEFORE
//                          the event (Open -> prize_pool += amount).
//   - `close_comp`       : closes entry after the deadline (Open -> Funded).
//   - `settle_comp`      : program logic splits the pool: 70% to winners
//                          (50/30/20 for 1st/2nd/3rd), 30% platform rake.
//                          Requires the pool funded; sponsor triggers it.
//   - `claim_comp`       : a winner claims their allocation gasless on the ER;
//                          credits their points PDA and marks the allocation
//                          claimed. Signed by the winner's session key.
//   Proven pattern (BracketChain / SkillOS): prize LOCKED in a smart-contract
//   escrow BEFORE the event, payouts by program logic, no third-party custody.
//   On devnet the pool is mirror points (free money) — real-value escrow +
//   legal framing is a mainnet item.
//
// M5 — Premium points + Active Tier (launch engine, IMPLEMENTED):
//   - `initialize_premium_points`: creates the player's PREMIUM points PDA
//                                  (base layer, app pays rent). Seed `gfgprem`,
//                                  same player_authority. Stores the admin
//                                  authority (the sponsor/ecror who initializes
//                                  it), matching the Competition sponsor pattern.
//   - `delegate_premium_points`  : moves the premium PDA into the ER session
//                                  (base layer, app pays) so spends run gasless.
//   - `credit_premium_points`    : the admin (stored authority) credits
//                                  premium_lifetime + premium_spendable together
//                                  after a VERIFIED manual payment. AUTHORITY-
//                                  GATED (only the account's admin_authority
//                                  signer). Idempotent by credit ref.
//   - `spend_premium_points`     : the player spends premium spendable on the ER
//                                  (session key signs, gasless). Insufficient
//                                  guard + idempotent spend_ref.
//   - `activate_subscription`    : deducts 5,000 premium spendable and sets
//                                  subscription_level=2 + active_until=now+30d
//                                  (no auto-renew; expiry is passive). Gasless on
//                                  the ER (session key signs).
//   - `undelegate_premium_points`: returns the premium PDA to this program so it
//                                  can be re-pinned off a flaky ER region
//                                  (RPC/region-agnostic rule, same build).
// Premium points are a buy-only economy: they NEVER merge into global (M4) or
// local (M3) ledgers and never dilute M4a pure.
//
// The PDA seed uses a dedicated `player_authority` key (the player's wallet),
// NOT the payer, so any wallet can sponsor rent/fees without changing the
// account's address.
//
// Follows the MagicBlock quickstart pattern:
// https://docs.magicblock.gg/pages/verifiable-randomness-functions-vrfs/how-to-guide/quickstart
// https://docs.magicblock.gg/pages/ephemeral-rollups-ers/how-to-guide/quickstart

use anchor_lang::prelude::*;
use anchor_lang::accounts::migration::Migration;

use ephemeral_rollups_sdk::anchor::{commit, delegate, ephemeral, vrf, vrf_callback};
use ephemeral_rollups_sdk::cpi::DelegateConfig;
use ephemeral_rollups_sdk::ephem::MagicIntentBundleBuilder;
use ephemeral_rollups_sdk::vrf::{
    self,
    instructions::{create_request_scoped_randomness_ix, RequestRandomnessParams},
    types::SerializableAccountMeta,
};

// M1A Chess core (Phase 1): on-chain engine in its own module, additive on the
// same program. Adds no instruction yet; Phase 2 wires the lifecycle.
pub mod chess;
pub use chess::*;
pub mod pcore;
pub use pcore::*;

declare_id!("CH8JepNPAqpp3X67bxujngUSdmFy7Dq1BWxrBu8wgAuJ");

pub const PLAYER: &[u8] = b"gfgplayerd";
pub const POINTS: &[u8] = b"gfgpoints";
pub const RESULT: &[u8] = b"gfgresult";
pub const COMP: &[u8] = b"gfgcomp";
pub const GLOBAL_TAG: &[u8] = b"global"; // reserved M4 global points tag, no game may use this
pub const PREMIUM_SEED: &[u8] = b"gfgprem"; // M5 premium points ledger seed (buy-only)
pub const AFFILIATE_SEED: &[u8] = b"gfgref";      // M6 affiliate ledger [gfgref, affiliate]
pub const AFFILIATE_PAIR_SEED: &[u8] = b"gfgrefpair"; // M6 affiliate pair [gfgrefpair, affiliate, referral]
pub const LIVES_SEED: &[u8] = b"gfglives";        // M10 lives ledger [gfglives, player] (game-agnostic)
pub const FREE_LIVES_DAY: u64 = 5;                // M10 free daily pool (GMT+00 refill); premium tiers raise pool
pub const CLAIM_SEED: &[u8] = b"gfgclaim";        // M6 signup-bonus fence [gfgclaim, player] (permanent, on-chain)
pub const SIGNUP_BONUS_POINTS: u64 = 500;         // M6 500P lifetime signup bonus (once per account, ever)
pub const COMP2_SEED: &[u8] = b"gfgcomp2";        // M7 competition instance [gfgcomp2, creator, seq]
pub const GFGWIN_SEED: &[u8] = b"gfgwin";         // M7 winner record [gfgwin, comp, rank]
pub const MAX_GAMES: usize = 4;
pub const MAX_WINNERS: usize = 16;
pub const MATCHBOARD_SEED: &[u8] = b"gfgboard";   // Arc2 M1 D: on-chain match board (v1, legacy)
pub const MATCHBOARD2_SEED: &[u8] = b"gfgboard2"; // M12: multiplayer match board (v2: seat-authority + handles + turn)
pub const MAX_MP: usize = 8;                      // max human seats per earn match
pub const HANDLE_SLOT: usize = 24;                // per-seat sitewide handle width (matches ProfileHandle rule 5..24)
pub const CLOCK_SEED: &[u8] = b"gfgclock";          // Arc2 M1B: per-seat turn clocks + forfeits
pub const DEFAULT_TIMEOUT_CAP: u8 = 3;              // timeout_seat triggers foreclosure at 3 stalls
pub const DEFAULT_TURN_SECS: u64 = 45;              // M12 turn timer default per turn (Ludo 45s; clients may pass their own, else the PROGRAM decides)
pub const AFFILIATE_ENTRIES: usize = 24;          // rolling ring of affiliate month-records
pub const PROFILE_HANDLE_SEED: &[u8] = b"gfghandle"; // M6 profile handle [gfghandle, handle_bytes]

pub const RAKE_BPS: u16 = 3000; // 30% platform rake on competition pools
pub const WINNER_SHARES: [u16; 3] = [5000, 3000, 2000]; // 1st/2nd/3rd of the 70% winners bucket

// M5 — Active Tier plan ladder (L0 free .. L3). Activation points are based on
// the ACTUAL (strike) USD price, never the discount, so removing a discount
// later never requires a program change. Base rate: 500 premium points = $1
// (owner 2026-08-31), so an actual price of $N needs N * 500 points.
//   L1 actual $10 -> 5,000 pts | L2 actual $20 -> 10,000 | L3 actual $30 -> 15,000
pub const PREMIUM_PLAN_COST: u64 = 5_000;   // L1 (actual $10) requires 5,000 premium pts
pub const PREMIUM_PLAN_COST_L2: u64 = 10_000; // L2 (actual $20) requires 10,000
pub const PREMIUM_PLAN_COST_L3: u64 = 15_000; // L3 (actual $30) requires 15,000
pub const SUBSCRIPTION_DAYS: i64 = 30; // active-sub window (no auto-renew)
// Two boosters (owner 2026-08-29): 24h = $1 actual / 500 pts; 72h = $3 actual
// (discounted $2) / 1,500 pts. Points always on actual price (500 pts = $1).
pub const BOOSTER_1D_POINTS: u64 = 500;
pub const BOOSTER_1D_HOURS: i64 = 24;
pub const BOOSTER_3D_POINTS: u64 = 1_500;
pub const BOOSTER_3D_HOURS: i64 = 72;
pub const DAY_SECS: i64 = 24 * 60 * 60;

/// Registered M1A game tags for per-game point ledgers. Add a game here when
/// its M1 spec locks. The tag is the seed basis that isolates each game's
/// points PDA ([gfgpoints, game_tag, player]) so games never share ledgers.
pub fn is_valid_game_tag(tag: &str) -> bool {
    matches!(
        tag,
        "ludo" | "ayo_olopon" | "ludo_lab" | "ayo_lab" | "sandbox"
    )
}

// M10 LIVES GATE (game-agnostic, on-chain). A player may enter a match
// (join/begin) only when they have an available life this UTC day OR they are
// currently unlimited (booster / premium active). The ledger is init_if_needed'd
// by the caller so a fresh wallet auto-gets its base pool; the PROGRAM enforces
// `used < pool`, never trusting the client.
fn gate_lives(l: &LivesAccount, now: i64) -> Result<()> {
    // Unlimited window still live -> always allowed (no draw).
    if l.unlimited_until > 0 && l.unlimited_until > now { return Ok(()); }
    let day = now / 86400;
    let used = if l.day == day { l.used } else { 0 }; // implicit refill on a new day
    require!(used < l.pool, PointsError::NoLives);
    Ok(())
}

// M10 LIVES CHARGE (owner 2026): a life is spent AT GAME START, never held
// until completion. The program charges the ledger the moment a player enters a
// live match (join) or the host begins it, so win, lose, draw, or abandon all
// spend that one life, a player must deliberate before starting, and a bare
// frontend can never begin free. Unlimited (booster / premium active) still
// draws nothing but stamps the ref. Callers charge only on a real transition
// (lobby -> live, or a new seat), so a retry can never double-charge.
fn charge_life(l: &mut LivesAccount, now: i64, match_ref: u64) -> Result<()> {
    if l.unlimited_until > 0 && l.unlimited_until > now {
        l.last_consumed_ref = match_ref;
        l.last_consumed_ts = now;
        return Ok(());
    }
    let day = now / 86400;
    if l.day != day { l.day = day; l.used = 0; } // GMT+00 daily refill
    require!(l.used < l.pool, PointsError::NoLives);
    l.used = l.used.checked_add(1).ok_or(PointsError::Overflow)?;
    l.last_consumed_ref = match_ref;
    l.last_consumed_ts = now;
    l.award_count = l.award_count.checked_add(1).ok_or(PointsError::Overflow)?;
    Ok(())
}

#[ephemeral]
#[program]
pub mod gfg_dice {
    use super::*;

    // ===== M1A Chess (Phase 2: single player, fully on-chain) =====

    /// Relay/sponsor creates the chess board PDA for a match (base layer). Seat
    /// 0 is the host (the human); seat 1 is the house (the on-chain AI opponent
    /// for solo). Requires the host's lives ledger (gate only; the life is
    /// consumed on completion via consume_life).
    pub fn initialize_chess_match(
        ctx: Context<InitializeChessMatch>,
        match_ref: u64,
        time_ms: u64,
        increment_ms: u64,
        solo: u8,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let b = &mut ctx.accounts.board;
        let init = Position::initial();
        b.version = 1;
        b.game = CHESS_TAG;
        b.status = STATUS_LOBBY;
        b.seat_count = 2;
        b.result = RESULT_NONE;
        b.end_reason = REASON_NONE;
        b.side_to_move = WHITE;
        b.castling = INITIAL_CASTLING;
        b.ep = NO_EP;
        b.check_flag = 0;
        b.seats = [ctx.accounts.host.key(), if solo == 1 { ctx.accounts.payer.key() } else { Pubkey::default() }];
        b.position = init.squares;
        b.clock_ms = [time_ms, time_ms];
        b.increment_ms = increment_ms;
        b.turn_started_at = 0;
        b.started_at = 0;
        b.finished_at = 0;
        b.halfmove = 0;
        b.fullmove = 1;
        b.move_count = 0;
        b.last_hash = position_hash(&init);
        b.draw_offer = 255;
        b.last_request_ref = match_ref;
        b.bump = ctx.bumps.board;
        Ok(())
    }

    /// Relay moves the chess board into the ER session (base layer, sponsor).
    pub fn delegate_chess_board(ctx: Context<DelegateChessBoardInput>, match_ref: u64) -> Result<()> {
        ctx.accounts.delegate_board(
            &ctx.accounts.payer,
            &[CHESS_SEED, &match_ref.to_le_bytes()],
            DelegateConfig {
                validator: ctx.remaining_accounts.first().map(|acc| acc.key()),
                ..Default::default()
            },
        )?;
        Ok(())
    }

    /// Host starts the match (status 0 -> 1). Requires the signer's lives.
    /// Gasless ER write; the host's session key signs.
    pub fn start_chess_match(ctx: Context<StartChessMatch>, match_ref: u64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let b = &mut ctx.accounts.board;
        require!(b.status == STATUS_LOBBY, PointsError::NotOpen);
        require!(
            ctx.accounts.signer.key() == b.seats[0] || ctx.accounts.signer.key() == b.seats[1],
            PointsError::NotSeatAuthority
        );
        // M10: charge the host's life AT START (never on completion).
        ctx.accounts.core.charge_life(now, match_ref)?;
        b.status = STATUS_PLAYING;
        b.started_at = now;
        b.turn_started_at = now;
        Ok(())
    }

    /// A seated player submits a move. Fully validated on-chain (legality,
    /// turn, end conditions). Gasless ER write.
    pub fn make_chess_move(
        ctx: Context<MakeChessMove>,
        match_ref: u64,
        from: u8,
        to: u8,
        promo: u8,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let b = &mut ctx.accounts.board;
        require!(b.status == STATUS_PLAYING, PointsError::NotOpen);
        let seat = b.side_to_move as usize;
        require!(ctx.accounts.signer.key() == b.seats[seat], PointsError::NotYourTurn);
        if from > 63 || to > 63 || from == to {
            return Err(error!(PointsError::IllegalMove));
        }
        apply_move_to_board(b, Move { from, to, promo }, now)
    }

    /// House-signed on-chain AI reply (single player). The signer must be the
    /// AI seat's wallet; the move is generated and validated on-chain.
    pub fn ai_chess_move(ctx: Context<AiChessMove>, match_ref: u64, level: u8) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let b = &mut ctx.accounts.board;
        require!(b.status == STATUS_PLAYING, PointsError::NotOpen);
        require!(b.side_to_move == AI_SEAT, PointsError::NotYourTurn);
        require!(
            ctx.accounts.signer.key() == b.seats[AI_SEAT as usize],
            PointsError::NotSeatAuthority
        );
        let pos = Position {
            squares: b.position,
            side: b.side_to_move,
            castling: b.castling,
            ep: b.ep,
            halfmove: b.halfmove,
            fullmove: b.fullmove,
        };
        let lvl = if level == 0 { 1 } else { level };
        let mv = choose_ai_move(&pos, lvl).ok_or(error!(PointsError::IllegalMove))?;
        apply_move_to_board(b, mv, now)
    }

    /// PERMISSIONLESS timeout claim. Anyone may call it; the program verifies
    /// the seat to move has genuinely run out of time and finishes the game as
    /// a win for the opponent. No crank, deterministic from on-chain timestamps.
    pub fn claim_chess_timeout(ctx: Context<ClaimChessTimeout>, match_ref: u64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let b = &mut ctx.accounts.board;
        require!(b.status == STATUS_PLAYING, PointsError::NotOpen);
        let seat = b.side_to_move as usize;
        let elapsed = ((now - b.turn_started_at).max(0) as u64).saturating_mul(1000);
        require!(elapsed > b.clock_ms[seat], PointsError::StillRunning);
        let result = if seat == 0 { RESULT_BLACK } else { RESULT_WHITE };
        finish_board(b, result, REASON_TIMEOUT, now);
        Ok(())
    }

    /// A second player joins an open chess match (seat 1). Gasless ER write,
    /// lives-gated. Refuses if seat 1 is taken or the joiner is the host.
    pub fn join_chess_match(ctx: Context<JoinChessMatch>, match_ref: u64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let b = &mut ctx.accounts.board;
        require!(b.status == STATUS_LOBBY, PointsError::NotOpen);
        require!(b.seats[1] == Pubkey::default(), PointsError::AlreadyClaimed);
        require!(ctx.accounts.signer.key() != b.seats[0], PointsError::NotSeatAuthority);
        // M10: charge the joiner's life AT JOIN (never on completion).
        ctx.accounts.core.charge_life(now, match_ref)?;
        b.seats[1] = ctx.accounts.signer.key();
        Ok(())
    }

    /// A seated player resigns; the opponent wins. Gasless ER write.
    pub fn resign_chess_match(ctx: Context<ChessSeatAction>, match_ref: u64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let b = &mut ctx.accounts.board;
        require!(b.status == STATUS_PLAYING, PointsError::NotOpen);
        let signer = ctx.accounts.signer.key();
        let seat = if signer == b.seats[0] { 0u8 } else if signer == b.seats[1] { 1u8 } else { return Err(error!(PointsError::NotSeatAuthority)); };
        let result = if seat == 0 { RESULT_BLACK } else { RESULT_WHITE };
        finish_board(b, result, REASON_RESIGN, now);
        Ok(())
    }

    /// A seated player offers a draw. Gasless ER write.
    pub fn offer_draw_chess(ctx: Context<ChessSeatAction>, match_ref: u64) -> Result<()> {
        let b = &mut ctx.accounts.board;
        require!(b.status == STATUS_PLAYING, PointsError::NotOpen);
        let signer = ctx.accounts.signer.key();
        let seat = if signer == b.seats[0] { 0u8 } else if signer == b.seats[1] { 1u8 } else { return Err(error!(PointsError::NotSeatAuthority)); };
        b.draw_offer = seat;
        Ok(())
    }

    /// The other seated player accepts the draw. Mutual agreement ends the game.
    pub fn accept_draw_chess(ctx: Context<ChessSeatAction>, match_ref: u64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let b = &mut ctx.accounts.board;
        require!(b.status == STATUS_PLAYING, PointsError::NotOpen);
        let signer = ctx.accounts.signer.key();
        let seat = if signer == b.seats[0] { 0u8 } else if signer == b.seats[1] { 1u8 } else { return Err(error!(PointsError::NotSeatAuthority)); };
        require!(b.draw_offer != 255 && b.draw_offer != seat, PointsError::IllegalMove);
        finish_board(b, RESULT_DRAW, REASON_AGREEMENT, now);
        Ok(())
    }

    /// Relay returns the finished chess board to the base layer (commit +
    /// undelegate) so the record is readable by the seam and the profile.
    pub fn undelegate_chess_board(
        ctx: Context<CommitAndUndelegateChessBoard>,
        match_ref: u64,
    ) -> Result<()> {
        MagicIntentBundleBuilder::new(
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .commit_and_undelegate(&[ctx.accounts.board.to_account_info()])
        .build_and_invoke()?;
        Ok(())
    }

    // ===== PLAYER CORE (arcv2m3, the law) =====
    pub fn initialize_player_core(ctx: Context<InitializeCoreCtx>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let c = &mut ctx.accounts.core;
        c.version = 1;
        c.player = ctx.accounts.player_authority.key();
        c.created_at = now;
        c.lives_day = now / 86400;
        c.lives_used = 0;
        c.lives_pool = CORE_DEFAULT_POOL;
        c.unlimited_until = 0;
        c.last_life_ref = 0;
        c.last_life_ts = 0;
        c.lives_award_count = 0;
        c.global_pure = 0;
        c.global_lifetime = 0;
        c.global_spendable = 0;
        c.premium_lifetime = 0;
        c.premium_spendable = 0;
        c.subscription_level = 0;
        c.subscription_active_until = 0;
        c.booster_active_until = 0;
        c.last_credit_ref = 0;
        c.last_match_ref = 0;
        c.last_global_ref = 0;
        c.last_finish_digest = [0u8; 8];
        c.bucket_count = 0;
        c.buckets = [GameBucket::default(); CORE_BUCKETS];
        c.bump = ctx.bumps.core;
        c.admin_authority = ctx.accounts.payer.key();
        Ok(())
    }

    pub fn delegate_player_core(ctx: Context<DelegateCoreCtx>) -> Result<()> {
        let authority = ctx.accounts.player_authority.key();
        ctx.accounts.delegate_core(
            &ctx.accounts.payer,
            &[CORE_SEED, authority.as_ref()],
            DelegateConfig {
                validator: ctx.remaining_accounts.first().map(|acc| acc.key()),
                ..Default::default()
            },
        )?;
        Ok(())
    }

    pub fn undelegate_player_core(ctx: Context<CommitAndUndelegateCoreCtx>) -> Result<()> {
        MagicIntentBundleBuilder::new(
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .commit_and_undelegate(&[ctx.accounts.core.to_account_info()])
        .build_and_invoke()?;
        Ok(())
    }

    /// Bank a per-game local award into the player's core bucket (gasless ER).
    /// Additive mirror of record_points; the bucket is keyed by the game tag so
    /// no per-game PDA is ever created. Idempotent by match_ref.
    pub fn record_core_points(
        ctx: Context<RecordCorePointsCtx>,
        game_tag: String,
        points: u64,
        reason: u8,
        match_ref: u64,
    ) -> Result<()> {
        require!(points > 0, PointsError::ZeroPoints);
        require!(is_valid_game_tag(&game_tag), PointsError::InvalidGameTag);
        let tag = game_tag8(&game_tag);
        let c = &mut ctx.accounts.core;
        require!(c.last_match_ref != match_ref, PointsError::DuplicateMatchRef);
        let i = c.ensure_bucket(&tag)?;
        c.buckets[i].local_pure = c.buckets[i]
            .local_pure
            .checked_add(points)
            .ok_or(PointsError::Overflow)?;
        c.buckets[i].local_spendable = c.buckets[i]
            .local_spendable
            .checked_add(points)
            .ok_or(PointsError::Overflow)?;
        c.last_match_ref = match_ref;
        let _ = reason;
        Ok(())
    }

    /// Credit the player's global ledgers in the core (gasless ER). kind 0 = a
    /// game win (pure + lifetime + spendable); kind 1 = other sources. Additive
    /// mirror of record_global_points; no separate global PDA.
    pub fn record_core_global(
        ctx: Context<RecordCoreGlobalCtx>,
        kind: u8,
        points: u64,
        reason: u8,
        match_ref: u64,
    ) -> Result<()> {
        require!(points > 0, PointsError::ZeroPoints);
        require!(kind <= 1, PointsError::InvalidGameTag);
        let c = &mut ctx.accounts.core;
        require!(c.last_global_ref != match_ref, PointsError::DuplicateMatchRef);
        c.record_global(kind, points, match_ref)?;
        let _ = reason;
        Ok(())
    }

    /// Spend from the core's global spendable balance (gasless ER).
    pub fn spend_core_global(
        ctx: Context<SpendCoreGlobalCtx>,
        amount: u64,
        reason: u8,
        spend_ref: u64,
    ) -> Result<()> {
        require!(amount > 0, PointsError::ZeroAmount);
        let c = &mut ctx.accounts.core;
        c.spend_global(amount)?;
        let _ = (reason, spend_ref);
        Ok(())
    }

    /// Admin-gated premium credit on the core (promos/overflow).
    pub fn credit_core_premium(
        ctx: Context<CoreAdminCtx>,
        points: u64,
        credit_ref: u64,
        reason: u8,
    ) -> Result<()> {
        require!(points > 0, PointsError::ZeroPoints);
        let c = &mut ctx.accounts.core;
        require!(ctx.accounts.payer.key() == c.admin_authority, PointsError::NotAdmin);
        c.credit_premium(points, credit_ref)?;
        let _ = reason;
        Ok(())
    }

    /// DIRECT plan activation (pay -> active in ONE step, no premium points):
    /// set the level + expiry on the core. Admin-gated (verified payment).
    pub fn activate_core_plan(
        ctx: Context<CoreAdminCtx>,
        level: u8,
        days: u16,
        payment_ref: u64,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let c = &mut ctx.accounts.core;
        require!(ctx.accounts.payer.key() == c.admin_authority, PointsError::NotAdmin);
        // DIRECT ACTIVATION (spec M5): the verified payment's ref makes the
        // activation idempotent, so a re-submitted tx can never extend the plan
        // twice. payment_ref = 0 means a manual admin op (no guard).
        if payment_ref != 0 {
            require!(c.last_credit_ref != payment_ref, PointsError::DuplicateCreditRef);
            c.last_credit_ref = payment_ref;
        }
        let until = now + (days as i64) * 86400;
        c.activate_plan(level, until)?;
        Ok(())
    }

    /// DIRECT booster activation (unlimited lives for `hours`). Admin-gated.
    /// `payment_ref` guards replay exactly like activate_core_plan.
    pub fn activate_core_booster(
        ctx: Context<CoreAdminCtx>,
        hours: u16,
        payment_ref: u64,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let c = &mut ctx.accounts.core;
        require!(ctx.accounts.payer.key() == c.admin_authority, PointsError::NotAdmin);
        if payment_ref != 0 {
            require!(c.last_credit_ref != payment_ref, PointsError::DuplicateCreditRef);
            c.last_credit_ref = payment_ref;
        }
        let until = now + (hours as i64) * 3600;
        c.activate_booster(until)?;
        Ok(())
    }

    /// Admin cancel: clear the plan on the core (level 0, base pool).
    pub fn cancel_core_plan(ctx: Context<CoreAdminCtx>) -> Result<()> {
        let c = &mut ctx.accounts.core;
        require!(ctx.accounts.payer.key() == c.admin_authority, PointsError::NotAdmin);
        c.cancel_plan()?;
        Ok(())
    }

    /// Admin correction (2026-09): SET the core's premium balances outright and
    /// optionally clear the plan. Repairs an account corrupted by the 2026-08
    /// frontend bug that credited an absurd premium amount, and covers refunds.
    /// Admin-gated: the payer must equal the core's stored admin_authority.
    pub fn admin_fix_core_premium(
        ctx: Context<CoreAdminCtx>,
        lifetime: u64,
        spendable: u64,
        clear_plan: bool,
    ) -> Result<()> {
        let c = &mut ctx.accounts.core;
        require!(ctx.accounts.payer.key() == c.admin_authority, PointsError::NotAdmin);
        c.fix_premium(lifetime, spendable, clear_plan)?;
        Ok(())
    }

    /// Spend from the core's per-game local spendable bucket (gasless ER).
    /// Additive mirror of spend_local; the retired per-game PDA is never used.
    pub fn spend_core_local(
        ctx: Context<SpendCoreLocalCtx>,
        game_tag: String,
        amount: u64,
        reason: u8,
        spend_ref: u64,
    ) -> Result<()> {
        require!(amount > 0, PointsError::ZeroAmount);
        require!(is_valid_game_tag(&game_tag), PointsError::InvalidGameTag);
        let c = &mut ctx.accounts.core;
        c.spend_local(&game_tag8(&game_tag), amount)?;
        let _ = (reason, spend_ref);
        Ok(())
    }

    /// Spend from the core's premium spendable balance (gasless ER). Additive
    /// mirror of spend_premium_points.
    pub fn spend_core_premium(
        ctx: Context<SpendCorePremiumCtx>,
        amount: u64,
        reason: u8,
        spend_ref: u64,
    ) -> Result<()> {
        require!(amount > 0, PointsError::ZeroAmount);
        let c = &mut ctx.accounts.core;
        c.spend_premium(amount)?;
        let _ = (reason, spend_ref);
        Ok(())
    }

    /// Migration (2026-09, permissionless + idempotent): fold the RETIRED
    /// per-game points ledger into the core bucket, then zero the source so a
    /// re-run copies zero. Reads the old bytes fully BEFORE writing.
    pub fn migrate_core_bucket(ctx: Context<MigrateCoreBucketCtx>, game_tag: String) -> Result<()> {
        require!(is_valid_game_tag(&game_tag), PointsError::InvalidGameTag);
        let pure = ctx.accounts.legacy_points.local_pure_lifetime;
        let spendable = ctx.accounts.legacy_points.local_spendable_balance;
        ctx.accounts.core.migrate_bucket(game_tag8(&game_tag), pure, spendable)?;
        ctx.accounts.legacy_points.local_pure_lifetime = 0;
        ctx.accounts.legacy_points.local_spendable_balance = 0;
        Ok(())
    }

    /// Migration: fold the RETIRED global ledger into the core's globals, then
    /// zero the source. Permissionless + idempotent.
    pub fn migrate_core_global(ctx: Context<MigrateCoreGlobalCtx>) -> Result<()> {
        let pure = ctx.accounts.legacy_global.global_pure_lifetime;
        let lifetime = ctx.accounts.legacy_global.global_lifetime;
        let spendable = ctx.accounts.legacy_global.global_spendable_balance;
        ctx.accounts.core.migrate_global(pure, lifetime, spendable)?;
        ctx.accounts.legacy_global.global_pure_lifetime = 0;
        ctx.accounts.legacy_global.global_lifetime = 0;
        ctx.accounts.legacy_global.global_spendable_balance = 0;
        Ok(())
    }

    /// Migration: fold the RETIRED premium ledger into the core's premium track,
    /// then zero the source balances. Permissionless + idempotent.
    pub fn migrate_core_premium(ctx: Context<MigrateCorePremiumCtx>) -> Result<()> {
        let lifetime = ctx.accounts.legacy_premium.premium_lifetime;
        let spendable = ctx.accounts.legacy_premium.premium_spendable;
        let level = ctx.accounts.legacy_premium.subscription_level;
        let until = ctx.accounts.legacy_premium.subscription_active_until;
        let booster_until = ctx.accounts.legacy_premium.booster_active_until;
        ctx.accounts.core.migrate_premium(lifetime, spendable, level, until, booster_until)?;
        ctx.accounts.legacy_premium.premium_lifetime = 0;
        ctx.accounts.legacy_premium.premium_spendable = 0;
        Ok(())
    }

    /// Idempotent: creates the player's dice PDA if it does not exist yet.
    /// The payer (sponsor) pays rent; the account belongs to `player_authority`.
    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        Ok(())
    }

    /// Requests verifiable randomness from the MagicBlock VRF program.
    /// The result is delivered asynchronously via `callback_roll_dice`.
    pub fn roll_dice(ctx: Context<DoRollDiceCtx>, client_seed: u8) -> Result<()> {
        let ix = create_request_scoped_randomness_ix(RequestRandomnessParams {
            payer: ctx.accounts.payer.key(),
            oracle_queue: ctx.accounts.oracle_queue.key(),
            callback_program_id: ID,
            callback_discriminator: instruction::CallbackRollDice::DISCRIMINATOR.to_vec(),
            caller_seed: [client_seed; 32],
            // Account the callback needs to write the result into.
            accounts_metas: Some(vec![SerializableAccountMeta {
                pubkey: ctx.accounts.player.key(),
                is_signer: false,
                is_writable: true,
            }]),
            callback_args: Some(vec![client_seed]),
            ..Default::default()
        });
        ctx.accounts
            .invoke_signed_vrf(&ctx.accounts.payer.to_account_info(), &ix)?;
        Ok(())
    }

    /// Called by the VRF program (oracle-verified) with the randomness.
    pub fn callback_roll_dice(
        ctx: Context<CallbackRollDiceCtx>,
        randomness: [u8; 32],
        client_seed: u8,
    ) -> Result<()> {
        // Derive two INDEPENDENT dice from the 32 VRF bytes.
        // `random_u8_with_range` scans the array from the END (bytes[31] first),
        // so a zero-padded tail would always resolve to 1. Fill the full 32 bytes
        // of each die's seed from its half of the randomness instead.
        let mut seed1 = [0u8; 32];
        seed1[..16].copy_from_slice(&randomness[..16]);
        seed1[16..].copy_from_slice(&randomness[..16]);
        let mut seed2 = [0u8; 32];
        seed2[..16].copy_from_slice(&randomness[16..]);
        seed2[16..].copy_from_slice(&randomness[16..]);

        let roll1 = vrf::rnd::random_u8_with_range(&seed1, 1, 6);
        let roll2 = vrf::rnd::random_u8_with_range(&seed2, 1, 6);

        msg!("gfg-dice randomness: {:?}", randomness);
        msg!("gfg-dice rolls: {} + {}", roll1, roll2);

        ctx.accounts.player.last_roll1 = roll1;
        ctx.accounts.player.last_roll2 = roll2;
        ctx.accounts.player.last_client_seed = client_seed;
        ctx.accounts.player.last_request_ts = Clock::get()?.unix_timestamp;
        Ok(())
    }

    /// Delegates the player's dice PDA into an Ephemeral Rollup session.
    /// Pins the ER validator via the first remaining account. Base layer; the
    /// payer (sponsor) covers the one-time session + account costs.
    pub fn delegate(ctx: Context<DelegateInput>) -> Result<()> {
        let authority = ctx.accounts.player_authority.key();
        ctx.accounts.delegate_player(
            &ctx.accounts.payer,
            &[PLAYER, authority.as_ref()],
            DelegateConfig {
                // Optionally set a specific validator from the first remaining account
                validator: ctx.remaining_accounts.first().map(|acc| acc.key()),
                ..Default::default()
            },
        )?;
        Ok(())
    }

    /// Manually pushes the delegated state back to the base layer (runs on ER).
    pub fn commit(ctx: Context<CommitAndUndelegateInput>) -> Result<()> {
        MagicIntentBundleBuilder::new(
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .commit(&[ctx.accounts.player.to_account_info()])
        .build_and_invoke()?;
        Ok(())
    }

    /// Idempotent: creates the player's per-game POINTS PDA if it does not
    /// exist yet. Seed [gfgpoints, game_tag, player_authority]. Payer (sponsor)
    /// pays rent; the account belongs to `player_authority`.
    pub fn initialize_points(ctx: Context<InitializePoints>, game_tag: String) -> Result<()> {
        require!(is_valid_game_tag(&game_tag), PointsError::InvalidGameTag);
        Ok(())
    }

    /// Delegates the player's per-game POINTS PDA into an ER session (base
    /// layer, sponsor pays) so `record_points`/`spend_local` run gasless.
    pub fn delegate_points(ctx: Context<DelegatePointsInput>, game_tag: String) -> Result<()> {
        require!(is_valid_game_tag(&game_tag), PointsError::InvalidGameTag);
        let authority = ctx.accounts.player_authority.key();
        ctx.accounts.delegate_points(
            &ctx.accounts.payer,
            &[POINTS, game_tag.as_bytes(), authority.as_ref()],
            DelegateConfig {
                // Optionally set a specific validator from the first remaining account
                validator: ctx.remaining_accounts.first().map(|acc| acc.key()),
                ..Default::default()
            },
        )?;
        Ok(())
    }

    /// Appends a reward to the player's per-game POINTS PDA (M3 — two-track
    /// local ledger: local_pure_lifetime AND local_spendable_balance are credited together
    /// on a verified win). Runs GASLESS on the ER: the player's session key is
    /// the only signer and no SOL is needed. `game_tag` ('ludo', 'ayo_olopon',
    /// ...) isolates each game's ledger via the PDA seed [gfgpoints, game_tag,
    /// player]. `match_ref` ties the record to the proof-roll transaction that
    /// earned it (first 8 bytes of the roll signature as a u64) and guards
    /// idempotency: a match_ref can only be recorded once.
    pub fn record_points(
        ctx: Context<RecordPointsCtx>,
        game_tag: String,
        points: u64,
        reason: u8,
        match_ref: u64,
    ) -> Result<()> {
        require!(points > 0, PointsError::ZeroPoints);
        require!(is_valid_game_tag(&game_tag), PointsError::InvalidGameTag);
        let dest = &mut ctx.accounts.points;
        require!(
            dest.award_count == 0 || dest.last_match_ref != match_ref,
            PointsError::DuplicateMatchRef
        );

        dest.local_pure_lifetime = dest
            .local_pure_lifetime
            .checked_add(points)
            .ok_or(PointsError::Overflow)?;
        dest.local_spendable_balance = dest
            .local_spendable_balance
            .checked_add(points)
            .ok_or(PointsError::Overflow)?;
        dest.last_points = points;
        dest.last_reason = reason;
        dest.last_match_ref = match_ref;
        dest.last_recorded_ts = Clock::get()?.unix_timestamp;
        dest.award_count = dest.award_count.checked_add(1).ok_or(PointsError::Overflow)?;
        Ok(())
    }

    // ===== M10 LIVES (game-agnostic, on-chain) =====
    // consume_life: called when a match COMPLETES (a finished game emits the M2
    // seam). Consumes exactly ONE life from the caller's lives ledger. Rules
    // (identical to single-player, now chain-enforced):
    //   - abandon / reset / mid-game disconnect never reach here (no completion
    //     envelope) -> no life is ever taken for an unfinished match.
    //   - only the OWNER's ledger can be consumed (player == signer).
    //   - idempotent by match_ref: re-running the same completion is a no-op.
    //   - UTC-day reset: `used` restarts at 0 when the UTC day rolls over (the
    //     daily refill, same GMT+00 the rest of the platform uses).
    //   - unlimited (booster / premium sub with boosterActiveUntil still live)
    //     is honored here too: no life is drawn while unlimited, matching the
    //     front-end lives module.
    pub fn consume_life(ctx: Context<ConsumeLifeCtx>, match_ref: u64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let l = &mut ctx.accounts.lives;
        require!(l.player == ctx.accounts.signer.key(), PointsError::NotSeatAuthority);
        // Unlimited (booster/premium active) -> no draw.
        if l.unlimited_until > 0 && l.unlimited_until > now {
            l.last_consumed_ref = match_ref;
            l.last_consumed_ts = now;
            return Ok(());
        }
        let day = now / 86400;
        if l.day != day { l.day = day; l.used = 0; } // GMT+00 daily refill
        // Idempotent per completion ref.
        if l.last_consumed_ref == match_ref { return Ok(()); }
        // Pool gate: only consume when still available this day.
        require!(l.used < l.pool, PointsError::NoLives);
        l.used = l.used.checked_add(1).ok_or(PointsError::Overflow)?;
        l.last_consumed_ref = match_ref;
        l.last_consumed_ts = now;
        l.award_count = l.award_count.checked_add(1).ok_or(PointsError::Overflow)?;
        Ok(())
    }

    /// Initializes the M10 LIVES ledger for a player (base layer, relay/sponsor
    /// pays ONCE per player, bundled into the same first-onboarding flow as
    /// dice/points/result/premium). ia overrides remain at interface: the free
    /// base pool is 5/day; unlimited comes from the premium booster. Adds the
    /// daily UTC pool. Everything after init is gasless ER.
    pub fn initialize_lives(ctx: Context<InitializeLivesInput>) -> Result<()> {
        let l = &mut ctx.accounts.lives;
        let now = Clock::get()?.unix_timestamp;
        l.version = 1u8;
        l.player = ctx.accounts.player_authority.key();
        l.day = now / 86400;
        l.used = 0;
        l.pool = FREE_LIVES_DAY as u16;
        l.unlimited_until = 0;
        l.last_consumed_ref = 0;
        l.last_consumed_ts = 0;
        l.award_count = 0;
        Ok(())
    }

    /// Delegates the player's LIVES PDA into an ER session (base layer, sponsor
    /// pays once) so `consume_life` / the join/begin gates run gasless. Mirrors
    /// delegate_points.
    pub fn delegate_lives(ctx: Context<DelegateLivesInput>) -> Result<()> {
        let authority = ctx.accounts.player_authority.key();
        ctx.accounts.delegate_lives(
            &ctx.accounts.payer,
            &[LIVES_SEED, authority.as_ref()],
            DelegateConfig {
                validator: ctx.remaining_accounts.first().map(|acc| acc.key()),
                ..Default::default()
            },
        )?;
        Ok(())
    }

    /// Returns the LIVES PDA to this program (ER -> re-delegate elsewhere).
    /// Additive, 2026-09-10 (region-agnostic build rule).
    pub fn undelegate_lives(ctx: Context<CommitAndUndelegateLivesInput>) -> Result<()> {
        MagicIntentBundleBuilder::new(
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .commit_and_undelegate(&[ctx.accounts.lives.to_account_info()])
        .build_and_invoke()?;
        Ok(())
    }

    /// (M3 — local spendable) Draws down the SPENDABLE track of a per-game
    /// points PDA for that game's own in-game purchases (S3 shop). The PURE
    /// track is never touched: local pure is the unspendable bragging-rights
    /// source of truth. Runs GASLESS on the ER (session key signs, 0 SOL);
    /// `spend_ref` is the client/backend-supplied purchase reference that makes
    /// the spend replayable. `reason` uses the client reason tag map.
    pub fn spend_local(
        ctx: Context<SpendLocalCtx>,
        game_tag: String,
        amount: u64,
        reason: u8,
        spend_ref: u64,
    ) -> Result<()> {
        require!(amount > 0, PointsError::ZeroAmount);
        require!(is_valid_game_tag(&game_tag), PointsError::InvalidGameTag);
        let dest = &mut ctx.accounts.points;
        require!(
            dest.local_spendable_balance >= amount,
            PointsError::InsufficientBalance
        );

        dest.local_spendable_balance = dest
            .local_spendable_balance
            .checked_sub(amount)
            .ok_or(PointsError::InsufficientBalance)?;
        dest.last_spend_reason = reason;
        dest.last_spend_ref = spend_ref;
        dest.last_spend_ts = Clock::get()?.unix_timestamp;
        dest.spend_count = dest.spend_count.checked_add(1).ok_or(PointsError::Overflow)?;
        Ok(())
    }

    /// (M3 — data preservation, see .opencode/rules/solana-upgrade-safety.md)
    /// Permissionless one-time migration from the legacy pre-game_tag points
    /// PDA `[gfgpoints, player]` (old `total_points` layout) into the new
    /// per-game ledger `[gfgpoints, game_tag, player]`. Copies the legacy
    /// total into BOTH new tracks (1:1 split) so no lifetime points are lost
    /// across the seed change. Idempotent: skips when the destination already
    /// holds awards. The legacy account is left in place as a tombstone; it is
    /// never closed (closing would reclaim rent and destroy the data).
    pub fn migrate_points(ctx: Context<MigratePointsCtx>, game_tag: String) -> Result<()> {
        require!(is_valid_game_tag(&game_tag), PointsError::InvalidGameTag);
        let dest = &mut ctx.accounts.points;
        if dest.award_count > 0 {
            return Ok(()); // already migrated
        }
        let legacy = &ctx.accounts.legacy_points;
        if legacy.lamports() == 0 || legacy.try_borrow_data()?.len() <= 8 {
            return Ok(()); // nothing to migrate
        }
        let mut data: &[u8] = &legacy.try_borrow_data()?[8..];
        let old = LegacyPlayerPoints::deserialize(&mut data)?;
        dest.local_pure_lifetime = old.total_points;
        dest.local_spendable_balance = old.total_points;
        dest.last_points = old.last_points;
        dest.last_reason = old.last_reason;
        dest.last_match_ref = old.last_match_ref;
        dest.last_recorded_ts = old.last_recorded_ts;
        dest.award_count = old.award_count;
        Ok(())
    }

    /// Commits the latest state and returns the PDA to this program (runs on ER).
    pub fn undelegate(ctx: Context<CommitAndUndelegateInput>) -> Result<()> {
        MagicIntentBundleBuilder::new(
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .commit_and_undelegate(&[ctx.accounts.player.to_account_info()])
        .build_and_invoke()?;
        Ok(())
    }

    /// Commits the latest state and returns the per-game POINTS PDA to this
    /// program (runs on ER). Mirrors `undelegate` for the M3 points ledger so
    /// a points PDA can leave a flaky region and be re-pinned to a healthy one
    /// without a program that can drop its data. Additive, 2026-08-18.
    pub fn undelegate_points(ctx: Context<CommitAndUndelegatePointsInput>, game_tag: String) -> Result<()> {
        require!(is_valid_game_tag(&game_tag), PointsError::InvalidGameTag);
        MagicIntentBundleBuilder::new(
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .commit_and_undelegate(&[ctx.accounts.points.to_account_info()])
        .build_and_invoke()?;
        Ok(())
    }

    /// Commits the latest state and returns the RESULT PDA to this program
    /// (runs on ER). Mirrors `undelegate` for the Scope C result ledger so it
    /// can be re-pinned to a healthy region. Additive, 2026-08-18.
    pub fn undelegate_result(ctx: Context<CommitAndUndelegateResultInput>) -> Result<()> {
        MagicIntentBundleBuilder::new(
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .commit_and_undelegate(&[ctx.accounts.result.to_account_info()])
        .build_and_invoke()?;
        Ok(())
    }

    /// Commits the latest state and returns the GLOBAL POINTS PDA to this
    /// program (runs on ER). Mirrors `undelegate` for the M4 global ledger so
    /// it can be re-pinned to a healthy region. Additive, 2026-08-18.
    pub fn undelegate_global_points(ctx: Context<CommitAndUndelegateGlobalPointsInput>) -> Result<()> {
        MagicIntentBundleBuilder::new(
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .commit_and_undelegate(&[ctx.accounts.global_points.to_account_info()])
        .build_and_invoke()?;
        Ok(())
    }

    /// Delegates the arc2m1 MATCH BOARD PDA into an ER session (base layer,
    /// sponsor/relay pays) so `begin_match`/`commit_move`/`finish_match` run
    /// GASLESS on the ER. Mirrors `delegate_result`; seed [gfgboard2, game, match_ref].
    pub fn delegate_board(ctx: Context<DelegateBoardInput>, game: u8, match_ref: u64) -> Result<()> {
        ctx.accounts.delegate_board(
            &ctx.accounts.payer,
            &[MATCHBOARD2_SEED, &game.to_le_bytes(), &match_ref.to_le_bytes()],
            DelegateConfig {
                // Optionally set a specific validator from the first remaining account
                validator: ctx.remaining_accounts.first().map(|acc| acc.key()),
                ..Default::default()
            },
        )?;
        Ok(())
    }

    /// Commits the latest state and returns a MATCH BOARD PDA to this program
    /// (runs on ER). Mirrors `undelegate_result`. Additive.
    pub fn undelegate_board(ctx: Context<CommitAndUndelegateBoardInput>, game: u8, match_ref: u64) -> Result<()> {
        MagicIntentBundleBuilder::new(
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .commit_and_undelegate(&[ctx.accounts.board.to_account_info()])
        .build_and_invoke()?;
        Ok(())
    }

    /// Idempotent: creates the player's RESULT PDA if it does not exist yet.
    /// Payer (sponsor) pays rent; the account belongs to `player_authority`.
    pub fn initialize_result(ctx: Context<InitializeResult>) -> Result<()> {
        Ok(())
    }

    /// Delegates the player's RESULT PDA into an ER session (base layer,
    /// sponsor pays) so `record_result` runs gasless on the rollup.
    pub fn delegate_result(ctx: Context<DelegateResultInput>) -> Result<()> {
        let authority = ctx.accounts.player_authority.key();
        ctx.accounts.delegate_result(
            &ctx.accounts.payer,
            &[RESULT, authority.as_ref()],
            DelegateConfig {
                validator: ctx.remaining_accounts.first().map(|acc| acc.key()),
                ..Default::default()
            },
        )?;
        Ok(())
    }

    /// Commits the FULL 1st..4th finish order of a match. Runs GASLESS on the
    /// ER: the player's session key is the only signer, no SOL needed.
    /// `finish_order[i]` is the player (color/seat index) that finished in
    /// position i+1 (0 = 1st place). `points`/`multiplier`/`match_ref` mirror
    /// the same values the reward used, so the result ties to the winning roll.
    pub fn record_result(
        ctx: Context<RecordResultCtx>,
        finish_order: [u8; 4],
        points: u64,
        multiplier: u8,
        match_ref: u64,
    ) -> Result<()> {
        let dest = &mut ctx.accounts.result;
        dest.finish_order = finish_order;
        dest.points = points;
        dest.multiplier = multiplier;
        dest.match_ref = match_ref;
        dest.last_recorded_ts = Clock::get()?.unix_timestamp;
        dest.result_count = dest.result_count.checked_add(1).ok_or(PointsError::Overflow)?;
        Ok(())
    }

    /// Creates a Competition escrow PDA. Base layer; the payer (sponsor) covers
    /// rent. The sponsor authority is the creator; only they can fund/close.
    pub fn initialize_comp(
        ctx: Context<InitializeComp>,
        comp_id: u64,
        entry_fee: u64,
        ends_at: i64,
    ) -> Result<()> {
        let comp = &mut ctx.accounts.comp;
        comp.comp_id = comp_id;
        comp.sponsor = ctx.accounts.sponsor.key();
        comp.entry_fee = entry_fee;
        comp.ends_at = ends_at;
        comp.prize_pool = 0;
        comp.state = CompState::Open as u8;
        comp.winner_count = 0;
        Ok(())
    }

    /// Delegates the Competition PDA into an ER session (base layer, sponsor
    /// pays) so fund/settle/claim run gasless on the rollup.
    pub fn delegate_comp(ctx: Context<DelegateCompInput>) -> Result<()> {
        ctx.accounts.delegate_comp(
            &ctx.accounts.payer,
            &[COMP, ctx.accounts.payer.key().as_ref()],
            DelegateConfig {
                validator: ctx.remaining_accounts.first().map(|acc| acc.key()),
                ..Default::default()
            },
        )?;
        Ok(())
    }

    /// Sponsor LOCKS prize pool into the escrow BEFORE the event. Base layer
    /// or ER (sponsor signs either way). Open -> prize_pool += amount.
    pub fn fund_comp(ctx: Context<FundCompCtx>, amount: u64) -> Result<()> {
        require!(amount > 0, PointsError::ZeroAmount);
        require!(
            ctx.accounts.comp.state == CompState::Open as u8,
            PointsError::NotOpen
        );
        let comp = &mut ctx.accounts.comp;
        comp.prize_pool = comp
            .prize_pool
            .checked_add(amount)
            .ok_or(PointsError::Overflow)?;
        Ok(())
    }

    /// Sponsor closes entry once the deadline has passed. Open -> Funded.
    pub fn close_comp(ctx: Context<CloseCompCtx>) -> Result<()> {
        require!(
            ctx.accounts.comp.state == CompState::Open as u8,
            PointsError::NotOpen
        );
        require!(
            Clock::get()?.unix_timestamp >= ctx.accounts.comp.ends_at,
            PointsError::StillRunning
        );
        ctx.accounts.comp.state = CompState::Funded as u8;
        Ok(())
    }

    /// Program logic splits a funded pool: 70% to the winners bucket (split
    /// 50/30/20 across 1st/2nd/3rd), 30% stays as platform rake. Sponsor
    /// submits the winner table after the on-chain finish orders resolve; the
    /// program validates the total and stores the allocations so claims are
    /// enforceable. Funded -> Settled.
    pub fn settle_comp(
        ctx: Context<SettleCompCtx>,
        winners: [Pubkey; 3],
        amounts: [u64; 3],
    ) -> Result<()> {
        let comp = &mut ctx.accounts.comp;
        require!(
            comp.state == CompState::Funded as u8,
            PointsError::NotFunded
        );
        let winners_bucket = comp
            .prize_pool
            .checked_mul((10_000 - RAKE_BPS) as u64)
            .ok_or(PointsError::Overflow)?
            / 10_000;
        let mut total: u64 = 0;
        for a in amounts.iter() {
            total = total.checked_add(*a).ok_or(PointsError::Overflow)?;
        }
        require!(total <= winners_bucket, PointsError::OverAlloc);
        comp.prize_pool = winners_bucket;
        for i in 0..3 {
            comp.winners[i].winner = winners[i];
            comp.winners[i].amount = amounts[i];
            comp.winners[i].claimed = false;
            if amounts[i] > 0 {
                comp.winner_count = (i + 1) as u8;
            }
        }
        comp.state = CompState::Settled as u8;
        Ok(())
    }

    /// A winner claims their allocation gasless on the ER. Requires the winner
    /// to be a stored allocation. Credits the SPENDABLE track of the player's
    /// per-game points PDA with the allocation (competition winnings are
    /// spendable) and marks it claimed (each allocation claims exactly once).
    /// `game_tag` selects which game's points PDA receives the prize.
    pub fn claim_comp(
        ctx: Context<ClaimCompCtx>,
        game_tag: String,
        winner_index: u8,
    ) -> Result<()> {
        require!(is_valid_game_tag(&game_tag), PointsError::InvalidGameTag);
        let comp = &mut ctx.accounts.comp;
        require!(
            comp.state == CompState::Settled as u8,
            PointsError::NotSettled
        );
        let idx = winner_index as usize;
        require!(idx < comp.winner_count as usize, PointsError::NoSuchWinner);
        let alloc = &mut comp.winners[idx];
        require!(
            alloc.winner == ctx.accounts.payer.key(),
            PointsError::NotYourAllocation
        );
        require!(!alloc.claimed, PointsError::AlreadyClaimed);
        alloc.claimed = true;

        let dest = &mut ctx.accounts.points;
        dest.local_spendable_balance = dest
            .local_spendable_balance
            .checked_add(alloc.amount)
            .ok_or(PointsError::Overflow)?;
        dest.local_pure_lifetime = dest
            .local_pure_lifetime
            .checked_add(alloc.amount)
            .ok_or(PointsError::Overflow)?;
        dest.last_points = alloc.amount;
        dest.last_reason = 2; // COMP_WIN
        dest.last_match_ref = comp.comp_id;
        dest.last_recorded_ts = Clock::get()?.unix_timestamp;
        dest.award_count = dest.award_count.checked_add(1).ok_or(PointsError::Overflow)?;
        Ok(())
    }

    // ── M4: Global Points (3-ledger site-wide framework) ──────────────────

    /// Idempotent: creates the player's GLOBAL POINTS PDA if it does not
    /// exist yet. Seed [gfgpoints, 'global', player_authority]. Payer (sponsor)
    /// pays rent; the account belongs to `player_authority`.
    pub fn initialize_global_points(ctx: Context<InitializeGlobalPoints>) -> Result<()> {
        Ok(())
    }

    /// Delegates the player's GLOBAL POINTS PDA into an ER session (base
    /// layer, sponsor pays) so record_global_points / spend_global run gasless.
    pub fn delegate_global_points(ctx: Context<DelegateGlobalPointsInput>) -> Result<()> {
        let authority = ctx.accounts.player_authority.key();
        ctx.accounts.delegate_global_points(
            &ctx.accounts.payer,
            &[POINTS, GLOBAL_TAG, authority.as_ref()],
            DelegateConfig {
                validator: ctx.remaining_accounts.first().map(|acc| acc.key()),
                ..Default::default()
            },
        )?;
        Ok(())
    }

    /// Credits the player's GLOBAL POINTS PDA. Runs GASLESS on the ER (session
    /// key signs, 0 SOL). `kind` determines which ledgers are credited:
    ///   - 0 (GAME WIN): M4a pure + M4b lifetime + M4c spendable all credited.
    ///   - 1 (OTHER — signup_bonus/referral/giveaway): M4b lifetime + M4c
    ///     spendable only, M4a pure is untouched (the multiplier-blind flow-up
    ///     contract: tier boosts are kind-1 credits).
    /// `source_code` is a u8 enum identifying the game or event:
    ///   1=ludo, 2=ayo_olopon, 10=signup_bonus, 11=referral, 12=giveaway,
    ///   13=tier_boost. M4 reads gameTag from M3's output (the scorer) and
    ///   maps it to source_code (M4 is the bank, not the scorer).
    /// `match_ref` guards idempotency (first 8 bytes of the triggering tx sig).
    pub fn record_global_points(
        ctx: Context<RecordGlobalPointsCtx>,
        kind: u8,
        source_code: u8,
        points: u64,
        reason: u8,
        match_ref: u64,
    ) -> Result<()> {
        require!(points > 0, PointsError::ZeroPoints);
        require!(kind <= 1, PointsError::InvalidGameTag); // reuse: kind must be 0 or 1
        let dest = &mut ctx.accounts.global_points;
        require!(
            dest.award_count == 0 || dest.last_match_ref != match_ref,
            PointsError::DuplicateMatchRef
        );

        if kind == 0 {
            // Game win: credit all three ledgers (M4a pure + M4b lifetime + M4c spendable)
            dest.global_pure_lifetime = dest
                .global_pure_lifetime
                .checked_add(points)
                .ok_or(PointsError::Overflow)?;
        }
        // kind 0 and 1 both credit lifetime + spendable (never pure for kind 1)
        dest.global_lifetime = dest
            .global_lifetime
            .checked_add(points)
            .ok_or(PointsError::Overflow)?;
        dest.global_spendable_balance = dest
            .global_spendable_balance
            .checked_add(points)
            .ok_or(PointsError::Overflow)?;

        dest.last_source = source_code;
        dest.last_points = points;
        dest.last_reason = reason;
        dest.last_match_ref = match_ref;
        dest.last_recorded_ts = Clock::get()?.unix_timestamp;
        dest.award_count = dest.award_count.checked_add(1).ok_or(PointsError::Overflow)?;
        Ok(())
    }

    /// (M6 — signup bonus, PERMANENT ON-CHAIN FENCE) Credits the 500P lifetime
    /// signup bonus AND marks the player's `[gfgclaim, player]` account as
    /// claimed, atomically. The claim account is the hard gate: once set it can
    /// NEVER be unset by anyone, so the same wallet can never claim twice even
    /// if the frontend or a server map is bypassed or lost. This single write
    /// replaces the old relay recordGlobalPoints(kind=1, source=10) path.
    /// Runs base-layer (sponsor signs, rare — once per signup), so the claim
    /// account never needs delegating.
    pub fn claim_signup_bonus(ctx: Context<ClaimSignupBonusCtx>, match_ref: u64) -> Result<()> {
        let claim = &mut ctx.accounts.signup_claim;
        require!(claim.claimed == 0, PointsError::SignupAlreadyClaimed); // THE FENCE
        let dest = &mut ctx.accounts.global_points;
        require!(
            dest.award_count == 0 || dest.last_match_ref != match_ref,
            PointsError::DuplicateMatchRef
        );
        // kind=1 semantics: credits M4b lifetime + M4c spendable, NEVER M4a pure.
        dest.global_lifetime = dest
            .global_lifetime
            .checked_add(SIGNUP_BONUS_POINTS)
            .ok_or(PointsError::Overflow)?;
        dest.global_spendable_balance = dest
            .global_spendable_balance
            .checked_add(SIGNUP_BONUS_POINTS)
            .ok_or(PointsError::Overflow)?;
        let now = Clock::get()?.unix_timestamp;
        dest.last_source = 10; // signup_bonus
        dest.last_points = SIGNUP_BONUS_POINTS;
        dest.last_reason = 2; // signup_bonus
        dest.last_match_ref = match_ref;
        dest.last_recorded_ts = now;
        dest.award_count = dest.award_count.checked_add(1).ok_or(PointsError::Overflow)?;
        claim.claimed = 1;
        claim.claim_ref = match_ref;
        claim.claimed_ts = now;
        Ok(())
    }

    /// (M6) One-time base-layer init of the player's signup-claim fence account
    /// ([gfgclaim, player], owner = this program). The relay (sponsor) runs it
    /// right before `claim_signup_bonus`; idempotent by the account existing.
    pub fn initialize_signup_claim(ctx: Context<InitializeSignupClaimCtx>) -> Result<()> {
        let claim = &mut ctx.accounts.signup_claim;
        claim.version = 1u8;
        claim.claimed = 0u8;
        claim.claimed_ts = 0;
        claim.claim_ref = 0;
        Ok(())
    }

    /// (M4 — global spendable) Draws down the SPENDABLE track of the global
    /// points PDA. M4a pure and M4b lifetime are never touched. Runs GASLESS
    /// on the ER (session key signs, 0 SOL); `spend_ref` is the
    /// client/backend-supplied purchase reference for replayability.
    pub fn spend_global(
        ctx: Context<SpendGlobalCtx>,
        amount: u64,
        reason: u8,
        spend_ref: u64,
    ) -> Result<()> {
        require!(amount > 0, PointsError::ZeroAmount);
        let dest = &mut ctx.accounts.global_points;
        require!(
            dest.global_spendable_balance >= amount,
            PointsError::InsufficientBalance
        );

        dest.global_spendable_balance = dest
            .global_spendable_balance
            .checked_sub(amount)
            .ok_or(PointsError::InsufficientBalance)?;
        dest.last_spend_reason = reason;
        dest.last_spend_ref = spend_ref;
        dest.last_spend_ts = Clock::get()?.unix_timestamp;
        dest.spend_count = dest.spend_count.checked_add(1).ok_or(PointsError::Overflow)?;
        Ok(())
    }

    // ── M5: Premium Points + Active Tier (launch engine) ───────────────────

    /// Idempotent: creates the player's PREMIUM points PDA if it does not
    /// exist yet. Seed [gfgprem, player_authority]. Payer (sponsor/ecror) pays
    /// rent; the payer becomes the stored ADMIN AUTHORITY who alone can credit
    /// the account (mirrors the Competition sponsor pattern).
    pub fn initialize_premium_points(ctx: Context<InitializePremiumPoints>) -> Result<()> {
        let prem = &mut ctx.accounts.premium_points;
        prem.version = 3u8; // current v3 layout (v1/v2 migrate via upgrade instructions)
        prem.admin_authority = ctx.accounts.payer.key();
        prem.premium_lifetime = 0;
        prem.premium_spendable = 0;
        prem.subscription_level = 0;
        prem.subscription_active_until = 0;
        prem.last_credit_ts = 0;
        prem.last_credit_points = 0;
        prem.last_credit_ref = 0;
        prem.last_spend_ts = 0;
        prem.last_spend_ref = 0;
        prem.last_spend_reason = 0;
        prem.spend_count = 0;
        prem.last_credit_reason = 0;
        prem.booster_active_until = 0;
        Ok(())
    }

    /// (M5) Permissionless, idempotent migration of a v1 premium account into the
    /// current v2 layout (adds last_credit_reason). Safe for anyone to call for any
    /// account; no-ops when the account is already v2. Runs base-layer or ER; the
    /// payer (any wallet) funds the rent delta for the +1 byte (realloc via Anchor
    /// Migration). Preserves every existing field, defaults last_credit_reason to 1
    /// (subscription_payment) so no data is lost and reads stay valid on v1 too.
    pub fn upgrade_premium_points(ctx: Context<UpgradePremiumPointsCtx>) -> Result<()> {
        let mig = &mut ctx.accounts.premium_points;
        let old = mig.try_as_from()?.clone();
        let next = PremiumPoints {
            version: 3u8,
            booster_active_until: 0,
            admin_authority: old.admin_authority,
            premium_lifetime: old.premium_lifetime,
            premium_spendable: old.premium_spendable,
            subscription_level: old.subscription_level,
            subscription_active_until: old.subscription_active_until,
            last_credit_ts: old.last_credit_ts,
            last_credit_points: old.last_credit_points,
            last_credit_ref: old.last_credit_ref,
            last_spend_ts: old.last_spend_ts,
            last_spend_ref: old.last_spend_ref,
            last_spend_reason: old.last_spend_reason,
            spend_count: old.spend_count,
            last_credit_reason: 1, // subscription_payment
        };
        mig.migrate(next)
    }

    /// Delegates the player's PREMIUM points PDA into an ER session (base
    /// layer, sponsor pays) so spend_premium_points / activate_subscription run
    /// gasless on the rollup.
    pub fn delegate_premium_points(ctx: Context<DelegatePremiumPointsInput>) -> Result<()> {
        let authority = ctx.accounts.player_authority.key();
        ctx.accounts.delegate_premium_points(
            &ctx.accounts.payer,
            &[PREMIUM_SEED, authority.as_ref()],
            DelegateConfig {
                validator: ctx.remaining_accounts.first().map(|acc| acc.key()),
                ..Default::default()
            },
        )?;
        Ok(())
    }

    /// The admin (stored admin_authority, e.g. the sponsor/ecror) credits the
    /// player's PREMIUM points ledger after a VERIFIED manual payment. Writes
    /// premium_lifetime AND premium_spendable together. idempotent by
    /// `credit_ref`, so admin double-clicks can never double-credit.
    /// Runs base-layer or ER signed by the admin key (never by the player).
    pub fn credit_premium_points(
        ctx: Context<CreditPremiumPointsCtx>,
        points: u64,
        credit_ref: u64,
        reason: u8,
    ) -> Result<()> {
        require!(points > 0, PointsError::ZeroPoints);
        let prem = &mut ctx.accounts.premium_points;
        // v2 layout required (run upgrade_premium_points first for legacy accounts).
        require!(prem.version >= 3, PointsError::NeedsUpgrade);
        require!(
            prem.admin_authority == ctx.accounts.admin.key(),
            PointsError::NotAdmin
        );
        require!(
            prem.last_credit_ref != credit_ref,
            PointsError::DuplicateCreditRef
        );
        prem.premium_lifetime = prem
            .premium_lifetime
            .checked_add(points)
            .ok_or(PointsError::Overflow)?;
        prem.premium_spendable = prem
            .premium_spendable
            .checked_add(points)
            .ok_or(PointsError::Overflow)?;
        prem.last_credit_points = points;
        prem.last_credit_ref = credit_ref;
        prem.last_credit_ts = Clock::get()?.unix_timestamp;
        prem.version = 3u8;
        prem.last_credit_reason = reason; // 1 = subscription_payment, 2 = in_game_purchase, ...
        Ok(())
    }

    /// (M5) Draws down the SPENDABLE track of the player's PREMIUM points PDA.
    /// Runs GASLESS on the ER (session key signs, 0 SOL, player-consented);
    /// `spend_ref` is the purchase reference for replayability. premium_lifetime
    /// is never touched. (The operator/admin can also spend on the player's
    /// behalf with their authority, e.g. subscription activation.)
    pub fn spend_premium_points(
        ctx: Context<SpendPremiumPointsCtx>,
        amount: u64,
        reason: u8,
        spend_ref: u64,
    ) -> Result<()> {
        require!(amount > 0, PointsError::ZeroAmount);
        let prem = &mut ctx.accounts.premium_points;
        require!(
            prem.premium_spendable >= amount,
            PointsError::InsufficientPremiumBalance
        );
        prem.premium_spendable = prem
            .premium_spendable
            .checked_sub(amount)
            .ok_or(PointsError::InsufficientPremiumBalance)?;
        prem.last_spend_reason = reason;
        prem.last_spend_ref = spend_ref;
        prem.last_spend_ts = Clock::get()?.unix_timestamp;
        prem.spend_count = prem.spend_count.checked_add(1).ok_or(PointsError::Overflow)?;
        Ok(())
    }

    /// (M5) Activates the Level-2 (2x) subscription from PREMIUM spendable.
    /// Deducts PREMIUM_PLAN_COST (5,000), sets subscription_level = 2 and
    /// subscription_active_until = now + 30 days. NO auto-renew: the window is
    /// fixed; expiry is passive until the next manual purchase/credit. Runs
    /// GASLESS on the ER (session key signs).
    pub fn activate_subscription(ctx: Context<ActivateSubscriptionCtx>) -> Result<()> {
        let prem = &mut ctx.accounts.premium_points;
        require!(prem.version >= 3, PointsError::NeedsUpgrade);
        // One active plan at a time: reject a second upgrade while the current
        // 30-day window is still live, so a user can't spend another PREMIUM_PLAN_COST_L2
        // to stack/extend the same plan. They may re-activate only after expiry.
        let now = Clock::get()?.unix_timestamp;
        require!(
            !(prem.subscription_level > 0 && prem.subscription_active_until > now),
            PointsError::AlreadyActive
        );
        require!(
            prem.premium_spendable >= PREMIUM_PLAN_COST_L2,
            PointsError::InsufficientPremiumBalance
        );
        prem.premium_spendable = prem
            .premium_spendable
            .checked_sub(PREMIUM_PLAN_COST_L2)
            .ok_or(PointsError::InsufficientPremiumBalance)?;
        prem.subscription_level = 2u8;
        prem.subscription_active_until =
            Clock::get()?.unix_timestamp.checked_add(SUBSCRIPTION_DAYS * DAY_SECS)
                .ok_or(PointsError::Overflow)?;
        prem.last_spend_reason = 20; // SUB_ACTIVATE
        prem.last_spend_ref = prem.subscription_active_until as u64;
        prem.last_spend_ts = now;
        prem.spend_count = prem.spend_count.checked_add(1).ok_or(PointsError::Overflow)?;
        Ok(())
    }

    /// (M5, plan ladder 2026-08-22) Activates a SPECIFIC plan level from PREMIUM
    /// spendable: L1 costs 5,000P (actual $10), L2 10,000P (actual $20), L3
    /// 15,000P (actual $30) - points derive from the ACTUAL price at the base
    /// rate 500 points = $1 (owner 2026-08-31), so removing a launch discount
    /// never changes this (level is an arg, so more levels are
    /// data/constants, never a new instruction). Sets subscription_level =
    /// level and active_until = now + 30 days (no auto-renew). One active
    /// plan at a time. Gasless on the ER. Additive: the original
    /// activate_subscription (L2 only) stays untouched for existing callers.
    pub fn activate_subscription_level(ctx: Context<ActivateSubscriptionLevelCtx>, level: u8) -> Result<()> {
        let prem = &mut ctx.accounts.premium_points;
        require!(prem.version >= 3, PointsError::NeedsUpgrade);
        let cost = match level {
            1 => PREMIUM_PLAN_COST,     // L1 (actual $10)
            2 => PREMIUM_PLAN_COST_L2,  // L2 (actual $20)
            3 => PREMIUM_PLAN_COST_L3,  // L3 (actual $30)
            _ => return Err(PointsError::InvalidLevel.into()),
        };
        let now = Clock::get()?.unix_timestamp;
        require!(
            !(prem.subscription_level > 0 && prem.subscription_active_until > now),
            PointsError::AlreadyActive
        );
        require!(prem.premium_spendable >= cost, PointsError::InsufficientPremiumBalance);
        prem.premium_spendable = prem.premium_spendable
            .checked_sub(cost)
            .ok_or(PointsError::InsufficientPremiumBalance)?;
        prem.subscription_level = level;
        prem.subscription_active_until = now.checked_add(SUBSCRIPTION_DAYS * DAY_SECS).ok_or(PointsError::Overflow)?;
        prem.last_spend_reason = 20; // SUB_ACTIVATE
        prem.last_spend_ref = prem.subscription_active_until as u64;
        prem.last_spend_ts = now;
        prem.spend_count = prem.spend_count.checked_add(1).ok_or(PointsError::Overflow)?;
        Ok(())
    }

    /// (M5) Admin cancels a defective/perpetual subscription. Authority-gated
    /// (only stored admin_authority may call), sets level=0 and active_until=0.
    /// Used from the premium tracker to revoke a sub that escaped expiry.
    /// Runs base-layer or ER signed by admin, delegation-aware (undelegate if needed).
    pub fn admin_cancel_subscription(ctx: Context<AdminCancelSubscriptionCtx>) -> Result<()> {
        let prem = &mut ctx.accounts.premium_points;
        require!(
            prem.admin_authority == ctx.accounts.admin.key(),
            PointsError::NotAdmin
        );
        prem.subscription_level = 0;
        prem.subscription_active_until = 0;
        Ok(())
    }

    /// (M5) Authority-gated close of a premium account (returns rent to the
    /// player_authority). Used to reset a corrupted/lost test account for a clean
    /// recreate; never used in normal product flow. Additive, same program id.
    pub fn close_premium_points(ctx: Context<ClosePremiumPointsCtx>) -> Result<()> {
        let prem = &ctx.accounts.premium_points;
        // Stored admin_authority is the normal key. For broken/corrupted devnet
        // accounts whose admin field no longer matches (e.g. a bad migration),
        // the program's upgrade authority (deployer) may close them too — the
        // deployer key already has full control over the program, so this grants
        // no new privilege.
        let is_admin = prem.admin_authority == ctx.accounts.admin.key();
        if !is_admin {
            require!(
                ctx.accounts.programdata.upgrade_authority_address == Some(ctx.accounts.admin.key()),
                PointsError::NotAdmin
            );
        }
        let acct = prem.to_account_info();
        let lamports = acct.lamports();
        **acct.try_borrow_mut_lamports()? = 0;
        **ctx.accounts.destination.to_account_info().try_borrow_mut_lamports()? += lamports;
        Ok(())
    }

    /// Commits the latest state and returns the PREMIUM points PDA to this
    /// program (runs on ER). Mirrors `undelegate_global_points` so a premium
    /// PDA can leave a flaky region and be re-pinned. Additive, 2026-08-20.
    pub fn undelegate_premium_points(ctx: Context<CommitAndUndelegatePremiumPointsInput>) -> Result<()> {
        MagicIntentBundleBuilder::new(
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .commit_and_undelegate(&[ctx.accounts.premium_points.to_account_info()])
        .build_and_invoke()?;
        Ok(())
    }

    // ================= M6 AFFILIATE (relay-signed immutable audit ledger) ===========
    // The platform (relay, stored as account authority) records each referral's
    // FIRST upgrade accrual ON-CHAIN in USD cents (20% of the plan's payable USD,
    // read live from the config ladder). On-chain rule (owner 2026-08-31): a pair
    // earns exactly ONCE - the first upgrade; later renewals/upgrades by the same
    // referral pay nothing. And there is NO active-sub requirement: anyone who
    // referred may earn. status flags on entries: 0 = earned (pending), 1 = paid,
    // 2 = forfeited. Totals are permanent; the account keeps a rolling ring of the
    // most recent 68 records, and running totals for all history.

    /// Creates/updates the affiliate ledger for one affiliate->referral month.
    /// Authority = stored account authority (relay/sponsor). Idempotent per
    /// (affiliate, referral, period). Run GASLESS on the ER when delegated.
    pub fn record_affiliate_period(
        ctx: Context<RecordAffiliatePeriodCtx>,
        affiliate: Pubkey,
        referral: Pubkey,
        period: u32,
        usd_cents: u64,
        eligibility: u8,
    ) -> Result<()> {
        let acct = &mut ctx.accounts.affiliate_account;
        if acct.authority == Pubkey::default() {
            acct.authority = ctx.accounts.payer.key();
        }
        require!(acct.authority == ctx.accounts.payer.key(), PointsError::NotAdmin);
        require!(av_has_period(&acct, period, referral) == false, PointsError::DuplicateAffiliatePeriod);
        let pair = &mut ctx.accounts.affiliate_pair;
        // ONE-TIME EARN PER PAIR (owner 2026-08-31): the affiliate reward is 20% of
        // the referred player's FIRST upgrade only. A pair that already earned is
        // permanently done - a later renewal/upgrade by the same referral pays
        // nothing. No active-sub gate: anyone who referred may earn once.
        if eligibility == 0 {
            require!(pair.paid_period_count == 0, PointsError::AffiliateOnceOnly);
        }
        let now = Clock::get()?.unix_timestamp;
        // Update running totals by eligibility.
        if eligibility == 0 {
            acct.lifetime_usd_cents = acct.lifetime_usd_cents.checked_add(usd_cents).ok_or(PointsError::Overflow)?;
            acct.pending_usd_cents = acct.pending_usd_cents.checked_add(usd_cents).ok_or(PointsError::Overflow)?;
        } else if eligibility == 2 {
            acct.forfeited_usd_cents = acct.forfeited_usd_cents.checked_add(usd_cents).ok_or(PointsError::Overflow)?;
        }
        // Rolling ring entry.
        let idx = (acct.entry_count as usize) % AFFILIATE_ENTRIES;
        acct.entries[idx] = AffiliateEntry {
            period,
            referral,
            amount_usd_cents: usd_cents,
            status: eligibility,
            ts: now,
        };
        acct.entry_count = acct.entry_count.checked_add(1).ok_or(PointsError::Overflow)?;

        // Pair bookkeeping (the old 60-day forfeit/pause rules are retired; a pair
        // simply records its first-earned timestamp and locks forever after).
        if pair.first_subscribed_ts == 0 {
            pair.first_subscribed_ts = now;
        }
        if eligibility == 0 {
            pair.consecutive_inactive_periods = 0;
            pair.last_earned_period = period;
            pair.forfeited = false;
            pair.paid_period_count = pair.paid_period_count.saturating_add(1);
        } else if eligibility == 2 {
            pair.consecutive_inactive_periods = pair.consecutive_inactive_periods.saturating_add(1);
            if pair.consecutive_inactive_periods >= 2 {
                pair.forfeited = true;
            }
        }
        Ok(())
    }

    /// Marks an affiliate payout (authority-gated, relay/sponsor signs). Moves
    /// pending -> paid, records the payout receipt (ts + ref). Idempotent by
    /// payout_ref: a repeat of the same ref is rejected.
    pub fn upgrade_premium_points_v3(ctx: Context<UpgradePremiumV3Ctx>) -> Result<()> {
        let mig = &mut ctx.accounts.premium_points;
        let old = mig.try_as_from()?.clone();
        let next = PremiumPoints {
            version: 3u8,
            admin_authority: old.admin_authority,
            premium_lifetime: old.premium_lifetime,
            premium_spendable: old.premium_spendable,
            subscription_level: old.subscription_level,
            subscription_active_until: old.subscription_active_until,
            last_credit_ts: old.last_credit_ts,
            last_credit_points: old.last_credit_points,
            last_credit_ref: old.last_credit_ref,
            last_spend_ts: old.last_spend_ts,
            last_spend_ref: old.last_spend_ref,
            last_spend_reason: old.last_spend_reason,
            spend_count: old.spend_count,
            last_credit_reason: old.last_credit_reason,
            booster_active_until: 0,
        };
        mig.migrate(next)
    }

    /// (M5 v3) Activates an unlimited-life booster by spending premium spendable.
    /// Two durations (owner 2026-08-29): hours=24 -> $1 actual / 500 pts;
    /// hours=72 -> $3 actual (discounted $2) / 1,500 pts. Points always derive
    /// from the ACTUAL price so removing the discount later needs no program
    /// change. Extends from now (or the current active booster) by `hours`.
    /// Gasless on the ER (session key signs). One plan/booster per account flow.
    pub fn activate_booster(ctx: Context<ActivateBoosterCtx>, hours: i64) -> Result<()> {
        let (cost, window) = match hours {
            24 => (BOOSTER_1D_POINTS, BOOSTER_1D_HOURS),
            72 => (BOOSTER_3D_POINTS, BOOSTER_3D_HOURS),
            _ => return Err(PointsError::InvalidLevel.into()),
        };
        let prem = &mut ctx.accounts.premium_points;
        require!(prem.version >= 3, PointsError::NeedsUpgrade);
        require!(prem.premium_spendable >= cost, PointsError::InsufficientPremiumBalance);
        let now = Clock::get()?.unix_timestamp;
        let current = if prem.booster_active_until > now { prem.booster_active_until } else { now };
        let until = current.checked_add(window * 3600).ok_or(PointsError::Overflow)?;
        prem.premium_spendable = prem.premium_spendable.checked_sub(cost).ok_or(PointsError::InsufficientPremiumBalance)?;
        prem.booster_active_until = until;
        prem.last_spend_reason = 30; // BOOST_ACTIVATE
        prem.last_spend_ref = until as u64;
        prem.last_spend_ts = now;
        prem.spend_count = prem.spend_count.checked_add(1).ok_or(PointsError::Overflow)?;
        Ok(())
    }

    // ================= M7 COMPETITIONS (additive framework, owner 2026-08-22) =========
    // Config-driven on-chain competition instances ([gfgcomp2, creator, seq]) +
    // [gfgwin, comp, rank] winner records. Create/close/settle/cancel/mark are
    // creator-gated (relay/sponsor signs), base-layer (admin frequency). Each
    // winner payoff = pool_value x shares[rank]/sum(shares), computed by the
    // program so the on-chain winner ledger is self-consistent.

    #[allow(clippy::too_many_arguments)]
    pub fn create_competition(
        ctx: Context<CreateCompetitionCtx>,
        seq: u32,
        name: String,
        games: Vec<u8>,
        tier_bits: u8,
        require_all: u8,
        entry_cost: u64,
        entry_families: u8,
        starts_at: i64,
        ends_at: i64,
        pool_usd_cents: u64,
        pool_points: u64,
        winner_count: u8,
        prize_shares: Vec<u32>,
        redemption: u8,
        payout_mode: u8,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(ends_at > starts_at && starts_at >= now, PointsError::InvalidCompetition);
        require!(winner_count >= 1 && winner_count as usize <= MAX_WINNERS, PointsError::InvalidCompetition);
        require!(prize_shares.len() == winner_count as usize, PointsError::InvalidCompetition);
        require!(games.len() >= 1 && games.len() <= MAX_GAMES, PointsError::InvalidCompetition);
        require!(tier_bits != 0, PointsError::InvalidCompetition);
        require!(pool_usd_cents > 0 && pool_points > 0 && entry_cost > 0, PointsError::InvalidCompetition);
        for share in &prize_shares { require!(*share > 0, PointsError::InvalidCompetition); }

        let comp = &mut ctx.accounts.competition;
        comp.version = 1u8;
        comp.creator = ctx.accounts.payer.key();
        comp.seq = seq;
        let mut nm = [0u8; 24];
        let name_len = name.as_bytes().len().min(24);
        nm[..name_len].copy_from_slice(&name.as_bytes()[..name_len]);
        comp.name = nm;
        let mut gs = [0u8; MAX_GAMES];
        for (i, g) in games.iter().enumerate() { gs[i] = *g; }
        comp.games = gs;
        comp.game_count = games.len() as u8;
        comp.tier_bits = tier_bits;
        comp.require_all = require_all;
        comp.entry_cost = entry_cost;
        comp.entry_families = entry_families;
        comp.starts_at = starts_at;
        comp.ends_at = ends_at;
        comp.pool_usd_cents = pool_usd_cents;
        comp.pool_points = pool_points;
        comp.winner_count = winner_count;
        let mut sh = [0u32; MAX_WINNERS];
        for (i, v) in prize_shares.iter().enumerate() { sh[i] = *v; }
        comp.prize_shares = sh;
        comp.redemption = redemption;
        comp.payout_mode = payout_mode;
        comp.status = 0u8; // open
        comp.settled_ts = 0;
        Ok(())
    }

    pub fn close_competition(ctx: Context<CompetitionSeqCtx>, seq: u32) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let comp = &mut ctx.accounts.competition;
        require!(comp.creator == ctx.accounts.authority.key(), PointsError::NotCreator);
        require!(comp.status == 0, PointsError::NotOpen);
        require!(now >= comp.ends_at, PointsError::StillRunning); // auto-stop (R16)
        comp.status = 1u8; // closed
        Ok(())
    }

    pub fn cancel_competition(ctx: Context<CompetitionSeqCtx>, seq: u32) -> Result<()> {
        let comp = &mut ctx.accounts.competition;
        require!(comp.creator == ctx.accounts.authority.key(), PointsError::NotCreator);
        require!(comp.status == 0 || comp.status == 1, PointsError::NotOpen);
        comp.status = 3u8; // cancelled
        Ok(())
    }

    pub fn record_competition_winner(
        ctx: Context<RecordCompetitionWinnerCtx>,
        seq: u32,
        rank: u8,
        player: Pubkey,
    ) -> Result<()> {
        let comp = &ctx.accounts.competition;
        require!(comp.creator == ctx.accounts.authority.key(), PointsError::NotCreator);
        require!(comp.status == 1, PointsError::CompetitionNotClosed);
        require!(rank >= 1 && rank as usize <= comp.winner_count as usize, PointsError::RankOutOfRange);
        let idx = (rank - 1) as usize;
        let total: u64 = comp.prize_shares.iter()
            .map(|s| *s as u64)
            .take(comp.winner_count as usize)
            .sum();
        require!(total > 0, PointsError::InvalidCompetition);
        let points = (comp.pool_points * comp.prize_shares[idx] as u64) / total;
        let usd = (comp.pool_usd_cents * comp.prize_shares[idx] as u64) / total;
        let w = &mut ctx.accounts.winner;
        w.version = 1u8;
        w.comp = comp.key();
        w.rank = rank;
        w.player = player;
        w.points = points;
        w.usd_cents = usd;
        w.status = 0u8;
        w.paid_ts = 0;
        Ok(())
    }

    pub fn settle_competition(ctx: Context<CompetitionSeqCtx>, seq: u32) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let comp = &mut ctx.accounts.competition;
        require!(comp.creator == ctx.accounts.authority.key(), PointsError::NotCreator);
        require!(comp.status == 1, PointsError::CompetitionNotClosed);
        comp.status = 2u8; // settled
        comp.settled_ts = now;
        Ok(())
    }

    pub fn mark_winner_paid(ctx: Context<MarkWinnerPaidCtx>, seq: u32, rank: u8) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let comp = &ctx.accounts.competition;
        require!(comp.creator == ctx.accounts.authority.key(), PointsError::NotCreator);
        require!(comp.status == 2, PointsError::CompetitionNotSettled);
        let w = &mut ctx.accounts.winner;
        require!(w.status == 0, PointsError::AlreadyClaimed);
        w.status = 1u8;
        w.paid_ts = now;
        Ok(())
    }

    // ===== M7 in-window win tally (H, owner 2026-08-23) ===================
    // Every verified win inside a live window increments the player's
    // [gfgwin, comp, player] tally ON-CHAIN (durable on serverless, R13). The
    // board aggregates tallies; the file ledger stays as a local fallback.

    /// One-time init of a player's tally for a competition (rent by the relay/
    /// sponsor; payer is the player session key on first win via the relay).
    pub fn initialize_competition_tally(
        ctx: Context<InitializeCompetitionTallyCtx>,
        seq: u32,
    ) -> Result<()> {
        let t = &mut ctx.accounts.tally;
        t.version = 1u8;
        t.comp = ctx.accounts.competition.key();
        t.player = ctx.accounts.player_authority.key();
        t.wins = 0;
        t.first_ts = 0;
        t.last_ts = 0;
        Ok(())
    }

    /// Gasless ER write (session key): +1 win on the player's own tally, only
    /// while the window is OPEN (auto-stop at ends_at by chain clock) and the
    /// given proof-time sits inside [starts_at, ends_at].
    pub fn record_competition_win(
        ctx: Context<RecordCompetitionWinCtx>,
        seq: u32,
        ts: i64,
        game: u8,
    ) -> Result<()> {
        let comp = &ctx.accounts.competition;
        let now = Clock::get()?.unix_timestamp;
        require!(comp.status == 0, PointsError::NotOpen);
        require!(now <= comp.ends_at, PointsError::StillRunning); // auto-stop (R16)
        require!(ts >= comp.starts_at && ts <= comp.ends_at, PointsError::InvalidCompetition);
        require!(game > 0, PointsError::InvalidCompetition);
        let t = &mut ctx.accounts.tally;
        t.wins = t.wins.checked_add(1).ok_or(PointsError::Overflow)?;
        t.last_ts = ts;
        if t.first_ts == 0 { t.first_ts = ts; }
        Ok(())
    }

    /// Delegate a player's competition tally into an ER session (relay/sponsor
    /// signs base-layer like the other per-player delegates).
    pub fn delegate_competition_tally(ctx: Context<DelegateCompetitionTallyInput>) -> Result<()> {
        ctx.accounts.delegate_tally(
            &ctx.accounts.payer,
            &[
                GFGWIN_SEED,
                ctx.accounts.competition.key().as_ref(),
                ctx.accounts.player_authority.key().as_ref(),
            ],
            DelegateConfig {
                validator: ctx.remaining_accounts.first().map(|acc| acc.key()),
                ..Default::default()
            },
        )?;
        Ok(())
    }

    /// Return a player's competition tally to this program (region-agnostic).
    pub fn undelegate_competition_tally(ctx: Context<CommitAndUndelegateCompetitionTallyInput>) -> Result<()> {
        MagicIntentBundleBuilder::new(
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .commit_and_undelegate(&[ctx.accounts.tally.to_account_info()])
        .build_and_invoke()?;
        Ok(())
    }


    // ===== arc2m1a: on-chain match board (owner-approved 2026-08-25) =====
    // Additive multiplayer record: start_match locks a board with participants +
    // stake + clocks; commit_move records hashed move checkpoints with turn caps;
    // finish_match writes the winner + time. Solo/free play is untouched.
    #[allow(clippy::too_many_arguments)]
    pub fn start_match(
        ctx: Context<StartMatchCtx>,
        game: u8,
        match_ref: u64,
        players: Vec<Pubkey>,
        seats: u8,
        stake_usd_cents: u64,
        turn_secs: u64,
        max_match_secs: u64,
    ) -> Result<()> {
        require!(players.len() >= 1 && players.len() <= MAX_MP, PointsError::InvalidCompetition);
        require!(seats >= players.len() as u8 && seats as usize <= MAX_MP, PointsError::InvalidCompetition);
        require!(game > 0, PointsError::InvalidCompetition);
        // stake 0 = Solo/free match (board records facts only, reward-neutral);
        // stake > 0 = earn match (escrow locks it via AGM). M1 never computes
        // rewards - it only stores the stake for downstream modules to read.
        // Turn timer (arc2m1): the PROGRAM is the single source of truth. The
        // client may pass its own per-game turn_secs (Ludo = 45); if a client
        // sends 0, the program enforces its DEFAULT_TURN_SECS - so a future
        // frontend can never create an untimed (or wrong-timed) match.
        require!(max_match_secs > 0, PointsError::InvalidCompetition);
        let turn_secs_final = if turn_secs > 0 { turn_secs } else { DEFAULT_TURN_SECS };
        let b = &mut ctx.accounts.board;
        b.version = 3u8;
        b.game = game;
        b.match_ref = match_ref;
        b.status = 0u8;
        let mut ps = [Pubkey::default(); MAX_MP];
        for (i, p) in players.iter().enumerate() { ps[i] = *p; }
        b.players = ps;
        // CREATOR = the first (host) wallet seated at create. Identified by
        // WALLET, never by seat: the creator can switch seats freely without
        // losing the right to begin, and an invited player auto-seated at seat0
        // after such a move can never become the creator. begin_match requires
        // signer == creator, and join_match never lets a seat-holder take
        // another's occupied seat.
        b.creator = ps[0];
        // player_count = the REAL non-default wallets seated at create (the
        // host). Free seats (Pubkey::default) never count; join_match fills +
        // counts them. begin_match requires player_count == seats, so a seat
        // can never be 'full' with no wallet behind it.
        b.player_count = ps.iter().take(seats as usize).filter(|p| **p != Pubkey::default()).count() as u8;
        b.seats = seats;
        b.handles = [[0u8; HANDLE_SLOT]; MAX_MP];
        b.current_turn = 255u8; // none yet
        b.stake_usd_cents = stake_usd_cents;
        b.seat_pot_usd_cents = stake_usd_cents.checked_mul(seats as u64).ok_or(PointsError::Overflow)?;
        b.turn_secs = turn_secs_final;
        b.max_match_secs = max_match_secs;
        b.started_at = Clock::get()?.unix_timestamp;
        b.last_turn_ts = [0i64; MAX_MP];
        b.move_count = 0;
        b.last_move_commit = [0u8; 32];
        b.finished_at = 0;
        b.winner_seat = 255;
        Ok(())
    }

    /// M12 join_match: a player joins a free seat on the board (gasless ER,
    /// PLAYER session key signs). Registers the joiner's REAL wallet into the
    /// seat + their sitewide handle. Requires the match to still be open
    /// (status 0); the host opens the board via start_match with seat 0 already
    /// taken and the rest open. Re-joins are idempotent (same seat + same
    /// signer may refresh the handle).
    pub fn join_match(
        ctx: Context<JoinMatchCtx>,
        game: u8,
        match_ref: u64,
        seat: u8,
        handle: String,
    ) -> Result<()> {
        let h = handle.trim();
        require!(h.len() >= 5 && h.len() <= 24, PointsError::InvalidHandle);
        let valid = h.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
        require!(valid, PointsError::InvalidHandle);

        let b = &mut ctx.accounts.board;
        require!(b.game == game, PointsError::InvalidCompetition);
        require!(b.match_ref == match_ref, PointsError::InvalidCompetition);
        require!(b.status == 0, PointsError::NotOpen);
        require!((seat as usize) < b.seats as usize, PointsError::RankOutOfRange);

        let sk = ctx.accounts.signer.key();
        // A wallet sits in exactly ONE seat: if the signer already occupies a
        // different seat (switching), free it first; joining into a seat that
        // belongs to a DIFFERENT wallet is forbidden.
        let mut already_holder = false;
        let mut switch_from = None;
        for (i, p) in b.players.iter().enumerate() {
            if p == &sk {
                if i as u8 == seat {
                    already_holder = true; // refresh handle, same seat
                } else {
                    switch_from = Some(i); // switch: free the old seat
                }
            }
        }
        if let Some(old) = switch_from {
            b.players[old] = Pubkey::default();
        }
        let cur = b.players[seat as usize];
        require!(cur == Pubkey::default() || already_holder, PointsError::NotSeatAuthority);
        b.players[seat as usize] = sk;
        // Recompute player_count from the players array so seat-switches never
        // drift it (count only non-default seats, capped at seats).
        b.player_count = b.players.iter().take(b.seats as usize).filter(|p| **p != Pubkey::default()).count() as u8;

        let mut hbuf = [0u8; HANDLE_SLOT];
        let hb = h.as_bytes();
        hbuf[..hb.len()].copy_from_slice(hb);
        b.handles[seat as usize] = hbuf;
        b.last_turn_ts[seat as usize] = Clock::get()?.unix_timestamp;
        // M10 lives charge: the JOINER's life is spent AT JOIN (never on
        // completion). A re-join by the same wallet on the same seat does not
        // charge again.
        if !already_holder {
            let now = Clock::get()?.unix_timestamp;
            ctx.accounts.core.charge_life(now, match_ref)?;
        }
        Ok(())
    }

    pub fn begin_match(ctx: Context<BeginMatchCtx>, game: u8, match_ref: u64) -> Result<()> {
        require!(ctx.accounts.board.game == game, PointsError::InvalidCompetition);
        let b = &mut ctx.accounts.board;
        require!(b.status == 0, PointsError::NotOpen);
        // All seats must be filled by real wallets before the match begins
        // (M12 seat-authority board; computer seats are filled by the host).
        require!(b.player_count == b.seats, PointsError::NotSettled);
        // Only the CREATOR (the wallet that opened the match) may begin.
        // Creator is wallet-bound, never seat-bound: the creator can switch
        // seats freely without transferring authority, and an invited player
        // accidentally seating at seat 0 can never become the creator.
        require!(b.creator == ctx.accounts.signer.key(), PointsError::NotSeatAuthority);
        // M10 lives charge: the CREATOR's life is spent AT BEGIN (never on
        // completion), chain-enforced so a bare frontend can't begin free.
        {
            let now = Clock::get()?.unix_timestamp;
            ctx.accounts.core.charge_life(now, match_ref)?;
        }
        // current_turn stays 255 (none yet): the SEAT THAT JUST MOVED is unused
        // until the first commit. Both devices therefore derive the displayed
        // turn uniformly as "the seat AFTER current_turn" - at begin it is none
        // yet, so the game's natural first turn (Green) plays. commit_move sets
        // current_turn = the seat that moved, making the next turn unambiguous.
        b.started_at = Clock::get()?.unix_timestamp;
        b.status = 1;
        // ===== arc2m1 TURN TIMER (game-core, Option B, on-chain) =====
        // The timer is integral to the game's turn engine: once the match is
        // live (this begin), every turn is time-bound to turn_secs, no UTC, no
        // client trigger. last_turn_ts[seat] stores the ABSOLUTE DEADLINE for
        // that seat's current turn window (an until-timestamp, exactly like the
        // booster/lives/subscription timers - the frontend just reads it). The
        // first turn belongs to seat 0 (the host / first active seat): its
        // window starts now.
        b.last_turn_ts[0] = b.started_at + b.turn_secs as i64;
        Ok(())
    }

    /// Commit one hashed move from a seat (gasless on the ER). SEAT AUTHORITY:
    /// the signer MUST be the exact wallet registered to that seat (join_match
    /// / start_match recorded it), so a wrong device can never commit another
    /// player's seat. Records current_turn + the 32-byte move checkpoint.
    pub fn commit_move(
        ctx: Context<CommitMoveCtx>,
        game: u8,
        match_ref: u64,
        seat: u8,
        move_commit: [u8; 32],
    ) -> Result<()> {
        require!(ctx.accounts.board.game == game, PointsError::InvalidCompetition);
        let now = Clock::get()?.unix_timestamp;
        let b = &mut ctx.accounts.board;
        require!(b.status == 1, PointsError::NotOpen);
        require!(seat < b.player_count, PointsError::RankOutOfRange);
        require!(b.players[seat as usize] == ctx.accounts.signer.key(), PointsError::NotSeatAuthority);
        b.last_move_commit = move_commit;
        b.move_count = b.move_count.checked_add(1).ok_or(PointsError::Overflow)?;
        b.current_turn = seat;
        // ===== arc2m1 TURN TIMER (game-core, Option B, on-chain) =====
        // The timer is part of the game's turn engine: every turn is time-bound
        // to turn_secs. last_turn_ts[seat] is the ABSOLUTE DEADLINE (an until-
        // timestamp) for the seat whose turn is running. The game adapter
        // (arc2m1 Ludo) writes byte19 in EVERY commit:
        //   - a mid-turn/roll/move or a double-six bonus => byte19 == seat (the
        //     SAME player keeps the turn): re-stamp that seat's deadline so the
        //     current turn continues under a fresh 45s window;
        //   - a pass to the next player => byte19 == next seat: stamp the NEXT
        //     seat's deadline so its turn is timed from handover.
        // There is NO check on whether a player is 'active' - the clock simply
        // runs for whichever turn is live, and expire_turn (below) force-passes
        // a seat whose deadline has passed so the game can never stall.
        let next = move_commit[19] as usize;
        if next < b.player_count as usize {
            b.last_turn_ts[next] = now + b.turn_secs as i64;
        } else {
            b.last_turn_ts[seat as usize] = now + b.turn_secs as i64;
        }
        Ok(())
    }

    // ===== arc2m1 TURN TIMER: Option B - permissionless force-pass =====
    // expire_turn: when the CURRENT turn's deadline (last_turn_ts[active]) has
    // passed, ANY caller (a participant device, or any future frontend) may
    // advance the turn past the stalled seat so the match never hangs. It reads
    // its OWN deadline + turn_secs, needs NO turn-order knowledge and does NOT
    // change game rules: it only skips a seat whose time window is truly over
    // and lets the Ludo turn engine proceed with whatever is next.
    // The active seat = the one the last commit named as next (byte19); before
    // the first commit it is seat 0. After advancing, that seat's OWN window is
    // given a fresh deadline so its turn is timed like every other turn.
    pub fn expire_turn(ctx: Context<ExpireTurnCtx>, game: u8, match_ref: u64) -> Result<()> {
        require!(ctx.accounts.board.game == game, PointsError::InvalidCompetition);
        require!(ctx.accounts.board.match_ref == match_ref, PointsError::InvalidCompetition);
        let now = Clock::get()?.unix_timestamp;
        let b = &mut ctx.accounts.board;
        require!(b.status == 1, PointsError::NotOpen);
        require!(b.player_count >= 2, PointsError::NotSettled);
        // Determinate active seat: byte19 of the last commit is who is next to
        // play (the adapter writes it every commit); before any commit it is
        // seat 0 (host / first active seat). current_turn is 'the last mover';
        // the seat to play is the one AFTER it when no commit names a next yet.
        let active = if b.current_turn == 255 {
            0usize
        } else {
            let ctp = b.last_move_commit[19] as usize;
            if ctp < b.player_count as usize {
                ctp
            } else {
                (b.current_turn as usize + 1) % b.player_count as usize
            }
        };
        // If the active seat's deadline is still in the future, the turn is live.
        require!(now >= b.last_turn_ts[active], PointsError::StillRunning);
        // The stalled seat is skipped (turn moves to whoever follows it; the
        // Ludo turn engine re-derives its own next from the game state).
        let next = (active + 1) % b.player_count as usize;
        let mut marker = [0u8; 32];
        marker[0] = 255u8;   // not a real seat => 'timeout advance'
        marker[19] = next as u8;
        b.last_move_commit = marker;
        b.move_count = b.move_count.checked_add(1).ok_or(PointsError::Overflow)?;
        b.current_turn = next as u8;
        b.last_turn_ts[next] = now + b.turn_secs as i64;
        Ok(())
    }

    pub fn finish_match(ctx: Context<FinishMatchCtx>, game: u8, match_ref: u64, winner_seat: u8) -> Result<()> {
        require!(ctx.accounts.board.game == game, PointsError::InvalidCompetition);
        let now = Clock::get()?.unix_timestamp;
        let b = &mut ctx.accounts.board;
        require!(b.status == 1, PointsError::NotOpen);
        require!(winner_seat < b.player_count, PointsError::RankOutOfRange);
        require!(now - b.started_at <= b.max_match_secs as i64, PointsError::StillRunning); // time cap
        // Only a seat holder (the winner's device / a joined player) may finish.
        require!(b.players.iter().take(b.player_count as usize).any(|p| p == &ctx.accounts.signer.key()), PointsError::NotSeatAuthority);
        b.status = 2;
        b.winner_seat = winner_seat;
        b.finished_at = now;
        Ok(())
    }

    // ===== Arc2 M1B: per-seat turn clocks + forfeits (board additive) =====
    // start_match_clocks: initializes the clock ledger for a begun board.
    pub fn start_match_clocks(ctx: Context<MatchClockCtx>, game: u8, match_ref: u64) -> Result<()> {
        require!(ctx.accounts.board.game == game, PointsError::InvalidCompetition);
        require!(ctx.accounts.board.match_ref == match_ref, PointsError::InvalidCompetition);
        require!(ctx.accounts.board.status == 1, PointsError::NotOpen);
        let now = Clock::get()?.unix_timestamp;
        let c = &mut ctx.accounts.clock;
        c.version = 1u8;
        c.game = game;
        c.match_ref = match_ref;
        c.turn_secs = ctx.accounts.board.turn_secs;
        c.timeout_cap = DEFAULT_TIMEOUT_CAP;
        for (i, d) in c.deadlines.iter_mut().enumerate() {
            if (i as u8) < ctx.accounts.board.player_count {
                *d = now + ctx.accounts.board.turn_secs as i64;
            }
        }
        c.updated_at = now;
        Ok(())
    }

    // touch_seat_clock: a seat resets its own deadline after a legal move.
    // Anyone may touch (game logic decides whose turn it is), board gate checks.
    pub fn touch_seat_clock(ctx: Context<MatchClockExistingCtx>, game: u8, match_ref: u64, seat: u8) -> Result<()> {
        require!(ctx.accounts.board.game == game, PointsError::InvalidCompetition);
        require!(ctx.accounts.board.match_ref == match_ref, PointsError::InvalidCompetition);
        require!(ctx.accounts.board.status == 1, PointsError::NotOpen);
        require!(seat < ctx.accounts.board.player_count, PointsError::RankOutOfRange);
        require!(ctx.accounts.clock.forfeited[seat as usize] == 0, PointsError::AlreadyClaimed);
        let now = Clock::get()?.unix_timestamp;
        let c = &mut ctx.accounts.clock;
        c.deadlines[seat as usize] = now + c.turn_secs as i64;
        c.updated_at = now;
        Ok(())
    }

    // timeout_seat: permissionless anti-stall. Once a seat's deadline passes,
    // anyone may record the stall and reset the clock; at timeout_cap stalls the
    // seat is FORFEITED so finish_forfeit can close the match early.
    pub fn timeout_seat(ctx: Context<MatchClockExistingCtx>, game: u8, match_ref: u64, seat: u8) -> Result<()> {
        require!(ctx.accounts.board.game == game, PointsError::InvalidCompetition);
        require!(ctx.accounts.board.match_ref == match_ref, PointsError::InvalidCompetition);
        require!(ctx.accounts.board.status == 1, PointsError::NotOpen);
        require!(seat < ctx.accounts.board.player_count, PointsError::RankOutOfRange);
        let now = Clock::get()?.unix_timestamp;
        let c = &mut ctx.accounts.clock;
        require!(c.forfeited[seat as usize] == 0, PointsError::AlreadyClaimed);
        require!(now > c.deadlines[seat as usize], PointsError::StillRunning); // not stalled yet
        let n = c.timeouts[seat as usize].saturating_add(1);
        c.timeouts[seat as usize] = n;
        if n >= c.timeout_cap {
            c.forfeited[seat as usize] = 1;
        }
        c.deadlines[seat as usize] = now + c.turn_secs as i64;
        c.updated_at = now;
        Ok(())
    }

    // finish_forfeit: any SEAT still in good standing may finalize the board and
    // claim the win when another seat has been forfeited for stalling. Clocks
    // keep the earn match from stalling on a walkaway opponent.
    pub fn finish_forfeit(ctx: Context<MatchClockExistingCtx>, game: u8, match_ref: u64, winner_seat: u8) -> Result<()> {
        require!(ctx.accounts.board.game == game, PointsError::InvalidCompetition);
        require!(ctx.accounts.board.match_ref == match_ref, PointsError::InvalidCompetition);
        let b = &mut ctx.accounts.board;
        require!(b.status == 1, PointsError::NotOpen);
        require!(winner_seat < b.player_count, PointsError::RankOutOfRange);
        let c = &ctx.accounts.clock;
        require!(c.forfeited[winner_seat as usize] == 0, PointsError::AlreadyClaimed);
        let mut forfeited_any = false;
        for (i, f) in c.forfeited.iter().enumerate() {
            if (i as u8) < b.player_count && *f == 1 {
                forfeited_any = true;
                break;
            }
        }
        require!(forfeited_any, PointsError::NotSettled); // no one forfeited yet
        let now = Clock::get()?.unix_timestamp;
        b.status = 2;
        b.winner_seat = winner_seat;
        b.finished_at = now;
        Ok(())
    }

    pub fn register_profile_handle(
        ctx: Context<RegisterProfileHandleCtx>,
        handle: String,
    ) -> Result<()> {
        let h = handle.trim();
        require!(h.len() >= 5 && h.len() <= 24, PointsError::InvalidHandle);
        let valid = h.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
        require!(valid, PointsError::InvalidHandle);
        let acct = &mut ctx.accounts.handle_account;
        require!(acct.owner == Pubkey::default(), PointsError::DuplicateHandle);
        acct.owner = ctx.accounts.payer.key();
        acct.created_ts = Clock::get()?.unix_timestamp;
        Ok(())
    }

    pub fn record_affiliate_payout(
        ctx: Context<AffiliatePayoutCtx>,
        affiliate: Pubkey,
        usd_cents: u64,
        payout_ref: u64,
    ) -> Result<()> {
        let acct = &mut ctx.accounts.affiliate_account;
        require!(acct.authority == ctx.accounts.payer.key(), PointsError::NotAdmin);
        require!(acct.last_payout_ref != payout_ref, PointsError::DuplicateCreditRef);
        require!(acct.pending_usd_cents >= usd_cents, PointsError::InsufficientPremiumBalance);
        acct.pending_usd_cents = acct.pending_usd_cents.checked_sub(usd_cents).ok_or(PointsError::InsufficientPremiumBalance)?;
        acct.paid_usd_cents = acct.paid_usd_cents.checked_add(usd_cents).ok_or(PointsError::Overflow)?;
        acct.payout_count = acct.payout_count.saturating_add(1);
        acct.last_payout_ts = Clock::get()?.unix_timestamp;
        acct.last_payout_ref = payout_ref;
        Ok(())
    }
}

fn av_has_period(acct: &AffiliateAccount, period: u32, referral: Pubkey) -> bool {
    acct.entries.iter().any(|e| e.period == period && e.referral == referral)
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: The player's wallet authority that owns this dice account.
    pub player_authority: AccountInfo<'info>,
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + PlayerDice::INIT_SPACE,
        seeds = [PLAYER, player_authority.key().as_ref()],
        bump
    )]
    pub player: Account<'info, PlayerDice>,
    pub system_program: Program<'info, System>,
}

/// Add delegate function to the context.
#[delegate]
#[derive(Accounts)]
pub struct DelegateInput<'info> {
    pub payer: Signer<'info>,
    /// CHECK: The player's wallet authority (seed basis for the PDA).
    pub player_authority: AccountInfo<'info>,
    /// CHECK: The pda to delegate.
    #[account(mut, del)]
    pub player: UncheckedAccount<'info>,
}

#[derive(Accounts)]
#[instruction(game_tag: String)]
pub struct InitializePoints<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: The player's wallet authority that owns this points account.
    pub player_authority: AccountInfo<'info>,
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + PlayerPoints::INIT_SPACE,
        seeds = [POINTS, game_tag.as_bytes(), player_authority.key().as_ref()],
        bump
    )]
    pub points: Account<'info, PlayerPoints>,
    pub system_program: Program<'info, System>,
}

/// Context for `consume_life` (M10, game-agnostic on-chain lives). The ledger is
/// created + delegated ONCE by the relay/sponsor during first onboarding
/// (initialize_lives + delegate_lives, base-layer one-time per player) - the
/// SAME gasless pattern as points/result/premium. After that every write is a
/// 0-fee ER tx signed by the player. A player-signed init_if_needed would be a
/// base/rent toll, so it is intentionally NOT used here.
#[derive(Accounts)]
#[instruction(match_ref: u64)]
pub struct ConsumeLifeCtx<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,
    #[account(
        mut,
        seeds = [LIVES_SEED, signer.key().as_ref()],
        bump
    )]
    pub lives: Account<'info, LivesAccount>,
}

/// Context for `initialize_lives` (M10). Sponsor/relay creates the ledger once
/// at onboarding (base layer), exactly like initialize_points.
#[derive(Accounts)]
pub struct InitializeLivesInput<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: The player's wallet authority (seed basis for the PDA).
    pub player_authority: AccountInfo<'info>,
    #[account(
        init,
        payer = payer,
        space = 8 + LivesAccount::INIT_SPACE,
        seeds = [LIVES_SEED, player_authority.key().as_ref()],
        bump
    )]
    pub lives: Account<'info, LivesAccount>,
    pub system_program: Program<'info, System>,
}

/// Context for `delegate_lives` (M10). Mirrors DelegatePointsInput.
#[delegate]
#[derive(Accounts)]
pub struct DelegateLivesInput<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: The player's wallet authority (seed basis for the PDA).
    pub player_authority: AccountInfo<'info>,
    /// CHECK: The lives pda to delegate.
    #[account(mut, del)]
    pub lives: UncheckedAccount<'info>,
}

/// Context for `undelegate_lives` (M10). Mirrors CommitAndUndelegateResultInput.
#[commit]
#[derive(Accounts)]
pub struct CommitAndUndelegateLivesInput<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: The player's wallet authority (seed basis for the PDA).
    pub player_authority: AccountInfo<'info>,
    #[account(mut, seeds = [LIVES_SEED, player_authority.key().as_ref()], bump)]
    pub lives: Account<'info, LivesAccount>,
}

#[delegate]
#[derive(Accounts)]
pub struct DelegatePointsInput<'info> {
    pub payer: Signer<'info>,
    /// CHECK: The player's wallet authority (seed basis for the PDA).
    pub player_authority: AccountInfo<'info>,
    /// CHECK: The points pda to delegate.
    #[account(mut, del)]
    pub points: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct InitializeResult<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: The player's wallet authority that owns this result account.
    pub player_authority: AccountInfo<'info>,
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + PlayerResult::INIT_SPACE,
        seeds = [RESULT, player_authority.key().as_ref()],
        bump
    )]
    pub result: Account<'info, PlayerResult>,
    pub system_program: Program<'info, System>,
}

#[delegate]
#[derive(Accounts)]
pub struct DelegateResultInput<'info> {
    pub payer: Signer<'info>,
    /// CHECK: The player's wallet authority (seed basis for the PDA).
    pub player_authority: AccountInfo<'info>,
    /// CHECK: The result pda to delegate.
    #[account(mut, del)]
    pub result: UncheckedAccount<'info>,
}

/// Context for `record_result`. Runs on the ER (gasless): the player's session
/// key is the payer, and the result PDA must already exist + be delegated.
#[derive(Accounts)]
pub struct RecordResultCtx<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: The player's wallet authority (seed basis for the PDA).
    pub player_authority: AccountInfo<'info>,
    #[account(mut, seeds = [RESULT, player_authority.key().as_ref()], bump)]
    pub result: Account<'info, PlayerResult>,
}

#[derive(Accounts)]
pub struct InitializeComp<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// The competition sponsor (brand / the app relay). Pays rent; owns the
    /// escrow lifecycle (fund/close/settle). One active competition per
    /// sponsor: the PDA seed is the sponsor key.
    pub sponsor: Signer<'info>,
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + Competition::INIT_SPACE,
        seeds = [COMP, sponsor.key().as_ref()],
        bump
    )]
    pub comp: Account<'info, Competition>,
    pub system_program: Program<'info, System>,
}

#[delegate]
#[derive(Accounts)]
pub struct DelegateCompInput<'info> {
    pub payer: Signer<'info>,
    /// CHECK: The competition escrow PDA (seed: gfgcomp + sponsor key).
    #[account(mut, del)]
    pub comp: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct FundCompCtx<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// The sponsor who created the competition.
    pub sponsor: Signer<'info>,
    #[account(
        mut,
        seeds = [COMP, sponsor.key().as_ref()],
        bump,
        constraint = comp.sponsor == sponsor.key() @ PointsError::NotSponsor
    )]
    pub comp: Account<'info, Competition>,
}

#[derive(Accounts)]
pub struct CloseCompCtx<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// The sponsor who created the competition.
    pub sponsor: Signer<'info>,
    #[account(
        mut,
        seeds = [COMP, sponsor.key().as_ref()],
        bump,
        constraint = comp.sponsor == sponsor.key() @ PointsError::NotSponsor
    )]
    pub comp: Account<'info, Competition>,
}

#[derive(Accounts)]
pub struct SettleCompCtx<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// The sponsor who created the competition.
    pub sponsor: Signer<'info>,
    #[account(
        mut,
        seeds = [COMP, sponsor.key().as_ref()],
        bump,
        constraint = comp.sponsor == sponsor.key() @ PointsError::NotSponsor
    )]
    pub comp: Account<'info, Competition>,
}

/// Context for `claim_comp`. Runs on the ER (gasless): the winner's session
/// key is the payer; the competition PDA must be delegated and the winner's
/// points PDA must exist + be delegated.
#[derive(Accounts)]
#[instruction(game_tag: String)]
pub struct ClaimCompCtx<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: The player's wallet authority (seed basis for the points PDA).
    pub player_authority: AccountInfo<'info>,
    #[account(mut, seeds = [POINTS, game_tag.as_bytes(), player_authority.key().as_ref()], bump)]
    pub points: Account<'info, PlayerPoints>,
    /// The competition sponsor (read-only seed basis; not required to sign).
    /// CHECK: read-only, used only as the PDA seed.
    pub sponsor: AccountInfo<'info>,
    #[account(
        mut,
        seeds = [COMP, sponsor.key().as_ref()],
        bump,
        constraint = comp.sponsor == sponsor.key() @ PointsError::NotSponsor
    )]
    pub comp: Account<'info, Competition>,
}

/// Context for `record_points`. Runs on the ER (gasless): the player's session
/// key is the payer, and the points PDA must already exist + be delegated.
#[derive(Accounts)]
#[instruction(game_tag: String)]
pub struct RecordPointsCtx<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: The player's wallet authority (seed basis for the PDA).
    pub player_authority: AccountInfo<'info>,
    #[account(mut, seeds = [POINTS, game_tag.as_bytes(), player_authority.key().as_ref()], bump)]
    pub points: Account<'info, PlayerPoints>,
}

// ── M4: Global Points contexts ────────────────────────────────────────────

#[derive(Accounts)]
pub struct InitializeGlobalPoints<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: The player's wallet authority that owns this global points account.
    pub player_authority: AccountInfo<'info>,
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + GlobalPoints::INIT_SPACE,
        seeds = [POINTS, GLOBAL_TAG, player_authority.key().as_ref()],
        bump
    )]
    pub global_points: Account<'info, GlobalPoints>,
    pub system_program: Program<'info, System>,
}

#[delegate]
#[derive(Accounts)]
pub struct DelegateGlobalPointsInput<'info> {
    pub payer: Signer<'info>,
    /// CHECK: The player's wallet authority (seed basis for the PDA).
    pub player_authority: AccountInfo<'info>,
    /// CHECK: The global points PDA to delegate.
    #[account(mut, del)]
    pub global_points: UncheckedAccount<'info>,
}

/// Context for `record_global_points`. Runs on the ER (gasless): the player's
/// session key is the payer, and the global points PDA must already exist +
/// be delegated.
#[derive(Accounts)]
pub struct RecordGlobalPointsCtx<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: The player's wallet authority (seed basis for the PDA).
    pub player_authority: AccountInfo<'info>,
    #[account(mut, seeds = [POINTS, GLOBAL_TAG, player_authority.key().as_ref()], bump)]
    pub global_points: Account<'info, GlobalPoints>,
}

/// Context for `claim_signup_bonus` (M6). Base-layer, sponsor-signed, once per
/// signup. The `signup_claim` account (already initialized) is the permanent
/// on-chain fence: the program rejects any repeat, forever.
#[derive(Accounts)]
pub struct ClaimSignupBonusCtx<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: The player's wallet authority (seed basis for the PDA).
    pub player_authority: AccountInfo<'info>,
    #[account(mut, seeds = [POINTS, GLOBAL_TAG, player_authority.key().as_ref()], bump)]
    pub global_points: Account<'info, GlobalPoints>,
    #[account(mut, seeds = [CLAIM_SEED, player_authority.key().as_ref()], bump)]
    pub signup_claim: Account<'info, SignupClaim>,
}

/// Context for `initialize_signup_claim` (M6). Sponsor (relay) creates the
/// per-wallet claim-fence account once, before the first claim.
#[derive(Accounts)]
pub struct InitializeSignupClaimCtx<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: The player's wallet authority (seed basis for the PDA).
    pub player_authority: AccountInfo<'info>,
    #[account(
        init,
        payer = payer,
        space = 8 + 1 + 1 + 8 + 8,
        seeds = [CLAIM_SEED, player_authority.key().as_ref()],
        bump
    )]
    pub signup_claim: Account<'info, SignupClaim>,
    pub system_program: Program<'info, System>,
}

/// Context for `create_competition` (M7). Seeds use [COMP2_SEED, creator, seq].
#[derive(Accounts)]
#[instruction(seq: u32, name: String, games: Vec<u8>, tier_bits: u8, require_all: u8, entry_cost: u64, entry_families: u8, starts_at: i64, ends_at: i64, pool_usd_cents: u64, pool_points: u64, winner_count: u8, prize_shares: Vec<u32>, redemption: u8, payout_mode: u8)]
pub struct CreateCompetitionCtx<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init,
        payer = payer,
        space = 8 + std::mem::size_of::<CompetitionInstance>(),
        seeds = [COMP2_SEED, payer.key().as_ref(), &seq.to_le_bytes()],
        bump
    )]
    pub competition: Account<'info, CompetitionInstance>,
    pub system_program: Program<'info, System>,
}

/// Reusable creator-gated context for close/settle/cancel (COMP2 seed).
#[derive(Accounts)]
#[instruction(seq: u32)]
pub struct CompetitionSeqCtx<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(mut, seeds = [COMP2_SEED, authority.key().as_ref(), &seq.to_le_bytes()], bump)]
    pub competition: Account<'info, CompetitionInstance>,
}

/// Context for `record_competition_winner` (per rank; creates its gfgwin record).
#[derive(Accounts)]
#[instruction(seq: u32, rank: u8, player: Pubkey)]
pub struct RecordCompetitionWinnerCtx<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(seeds = [COMP2_SEED, authority.key().as_ref(), &seq.to_le_bytes()], bump)]
    pub competition: Account<'info, CompetitionInstance>,
    #[account(
        init,
        payer = authority,
        space = 8 + std::mem::size_of::<WinnerRecord>(),
        seeds = [GFGWIN_SEED, competition.key().as_ref(), &[rank]],
        bump
    )]
    pub winner: Account<'info, WinnerRecord>,
    pub system_program: Program<'info, System>,
}

/// Context for `mark_winner_paid`.
#[derive(Accounts)]
#[instruction(seq: u32, rank: u8)]
pub struct MarkWinnerPaidCtx<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(seeds = [COMP2_SEED, authority.key().as_ref(), &seq.to_le_bytes()], bump)]
    pub competition: Account<'info, CompetitionInstance>,
    #[account(mut, seeds = [GFGWIN_SEED, competition.key().as_ref(), &[rank]], bump)]
    pub winner: Account<'info, WinnerRecord>,
}

// ===== M12 entry: v3 match board (gfgboard2) contexts =====
// The v3 board lives on seed prefix gfgboard2 so the new seat-authority +
// handles + turn layout never touches the legacy v1 test boards (gfgboard).

/// Context for `start_match` (M12). Board seed [gfgboard2, game, match_ref].
/// game + match_ref are instruction args; the host (payer) is seat 0.
#[derive(Accounts)]
#[instruction(game: u8, match_ref: u64, players: Vec<Pubkey>, seats: u8, stake_usd_cents: u64, turn_secs: u64, max_match_secs: u64)]
pub struct StartMatchCtx<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init,
        payer = payer,
        space = 8 + std::mem::size_of::<MatchBoard>(),
        seeds = [MATCHBOARD2_SEED, &game.to_le_bytes(), &match_ref.to_le_bytes()],
        bump
    )]
    pub board: Account<'info, MatchBoard>,
    pub system_program: Program<'info, System>,
}

/// Context for `join_match`: the JOINER signs (gasless ER), registering their
/// real wallet + sitewide handle into a free seat.
#[derive(Accounts)]
#[instruction(game: u8, match_ref: u64, seat: u8, handle: String)]
pub struct JoinMatchCtx<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,
    #[account(mut, seeds = [MATCHBOARD2_SEED, &game.to_le_bytes(), &match_ref.to_le_bytes()], bump)]
    pub board: Account<'info, MatchBoard>,
    // arcv2m3 Player Core: the JOINER's life is charged from their single core
    // account at join (never on completion).
    #[account(
        mut,
        seeds = [CORE_SEED, signer.key().as_ref()],
        bump
    )]
    pub core: Account<'info, PlayerCore>,
}

/// Context for `begin_match`.
#[derive(Accounts)]
#[instruction(game: u8, match_ref: u64)]
pub struct BeginMatchCtx<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,
    #[account(mut, seeds = [MATCHBOARD2_SEED, &game.to_le_bytes(), &match_ref.to_le_bytes()], bump)]
    pub board: Account<'info, MatchBoard>,
    // arcv2m3 Player Core: the HOST's life is charged from their single core
    // account at begin (never on completion).
    #[account(
        mut,
        seeds = [CORE_SEED, signer.key().as_ref()],
        bump
    )]
    pub core: Account<'info, PlayerCore>,
}

/// Context for `commit_move`.
#[derive(Accounts)]
#[instruction(game: u8, match_ref: u64, seat: u8, move_commit: [u8; 32])]
pub struct CommitMoveCtx<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,
    #[account(mut, seeds = [MATCHBOARD2_SEED, &game.to_le_bytes(), &match_ref.to_le_bytes()], bump)]
    pub board: Account<'info, MatchBoard>,
}

/// Context for `expire_turn` (arc2m1 turn timer, Option B). Permissionless:
/// any signer records a lapsed turn so the game advances. Board-only accounts -
/// no new seed, no layout change, solana-upgrade-safe.
#[derive(Accounts)]
#[instruction(game: u8, match_ref: u64)]
pub struct ExpireTurnCtx<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,
    #[account(mut, seeds = [MATCHBOARD2_SEED, &game.to_le_bytes(), &match_ref.to_le_bytes()], bump)]
    pub board: Account<'info, MatchBoard>,
}

/// Context for `finish_match`.
#[derive(Accounts)]
#[instruction(game: u8, match_ref: u64, winner_seat: u8)]
pub struct FinishMatchCtx<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,
    #[account(mut, seeds = [MATCHBOARD2_SEED, &game.to_le_bytes(), &match_ref.to_le_bytes()], bump)]
    pub board: Account<'info, MatchBoard>,
}

/// Context for `start_match_clocks` (arc2m1b). Clock seed [gfgclock, game, match_ref].
#[derive(Accounts)]
#[instruction(game: u8, match_ref: u64)]
pub struct MatchClockCtx<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,
    #[account(mut, seeds = [MATCHBOARD2_SEED, &game.to_le_bytes(), &match_ref.to_le_bytes()], bump)]
    pub board: Account<'info, MatchBoard>,
    #[account(
        init_if_needed,
        payer = signer,
        space = 8 + std::mem::size_of::<MatchClock>(),
        seeds = [CLOCK_SEED, &game.to_le_bytes(), &match_ref.to_le_bytes()],
        bump
    )]
    pub clock: Account<'info, MatchClock>,
    pub system_program: Program<'info, System>,
}

/// Context for the clock state-change instructions (touch/timeout/finish): the
/// clock MUST exist (start_match_clocks ran first), so a stale zeroed clock
/// can never auto-forfeit a seat.
#[derive(Accounts)]
#[instruction(game: u8, match_ref: u64)]
pub struct MatchClockExistingCtx<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,
    #[account(mut, seeds = [MATCHBOARD2_SEED, &game.to_le_bytes(), &match_ref.to_le_bytes()], bump)]
    pub board: Account<'info, MatchBoard>,
    #[account(
        mut,
        seeds = [CLOCK_SEED, &game.to_le_bytes(), &match_ref.to_le_bytes()],
        bump
    )]
    pub clock: Account<'info, MatchClock>,
}

/// Context for `spend_global`. Runs on the ER (gasless): the player's session
/// key is the payer, and the global points PDA must already exist + be
/// delegated.
#[derive(Accounts)]
pub struct SpendGlobalCtx<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: The player's wallet authority (seed basis for the PDA).
    pub player_authority: AccountInfo<'info>,
    #[account(mut, seeds = [POINTS, GLOBAL_TAG, player_authority.key().as_ref()], bump)]
    pub global_points: Account<'info, GlobalPoints>,
}

// ── M5: Premium Points contexts ────────────────────────────────────────────

/// Context for `initialize_premium_points`. Base layer: the payer
/// (sponsor/ecror) pays rent and becomes the stored admin authority.
#[derive(Accounts)]
pub struct InitializePremiumPoints<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: The player's wallet authority (seed basis for the PDA).
    pub player_authority: AccountInfo<'info>,
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + PremiumPoints::INIT_SPACE,
        seeds = [PREMIUM_SEED, player_authority.key().as_ref()],
        bump
    )]
    pub premium_points: Account<'info, PremiumPoints>,
    pub system_program: Program<'info, System>,
}

/// Context for `delegate_premium_points`. Base layer, sponsor pays.
#[delegate]
#[derive(Accounts)]
pub struct DelegatePremiumPointsInput<'info> {
    pub payer: Signer<'info>,
    /// CHECK: The player's wallet authority (seed basis for the PDA).
    pub player_authority: AccountInfo<'info>,
    /// CHECK: The premium points PDA to delegate.
    #[account(mut, del)]
    pub premium_points: UncheckedAccount<'info>,
}

/// Context for `credit_premium_points`. The admin authority (sponsor/ecror,
/// stored at init) signs. Runs base-layer or ER signed by the admin; the
/// player does NOT sign.
#[derive(Accounts)]
pub struct CreditPremiumPointsCtx<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    /// CHECK: The player's wallet authority (seed basis for the PDA).
    pub player_authority: AccountInfo<'info>,
    #[account(mut, seeds = [PREMIUM_SEED, player_authority.key().as_ref()], bump)]
    pub premium_points: Account<'info, PremiumPoints>,
}

/// Context for `spend_premium_points`. Runs on the ER (gasless): the player's
/// session key is the payer, and the premium PDA must exist + be delegated.
#[derive(Accounts)]
pub struct SpendPremiumPointsCtx<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: The player's wallet authority (seed basis for the PDA).
    pub player_authority: AccountInfo<'info>,
    #[account(mut, seeds = [PREMIUM_SEED, player_authority.key().as_ref()], bump)]
    pub premium_points: Account<'info, PremiumPoints>,
}

/// Context for `activate_subscription`. Runs on the ER (gasless): the player's
/// session key signs; the premium PDA must exist + be delegated.
#[derive(Accounts)]
pub struct ActivateSubscriptionCtx<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: The player's wallet authority (seed basis for the PDA).
    pub player_authority: AccountInfo<'info>,
    #[account(mut, seeds = [PREMIUM_SEED, player_authority.key().as_ref()], bump)]
    pub premium_points: Account<'info, PremiumPoints>,
}

/// Context for `activate_subscription_level` (M5 plan ladder). Same shape as
/// ActivateSubscriptionCtx plus the level argument (instruction-bound).
#[derive(Accounts)]
#[instruction(level: u8)]
pub struct ActivateSubscriptionLevelCtx<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: The player's wallet authority (seed basis for the PDA).
    pub player_authority: AccountInfo<'info>,
    #[account(mut, seeds = [PREMIUM_SEED, player_authority.key().as_ref()], bump)]
    pub premium_points: Account<'info, PremiumPoints>,
}

/// Context for `upgrade_premium_points`: migrates a v1 premium account to v2
/// (adds last_credit_reason). Permissionless (any payer may run it for any
/// account); idempotent; reallocs the account +1 byte via Anchor Migration.
#[derive(Accounts)]
pub struct UpgradePremiumPointsCtx<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        mut,
        realloc = 8 + PremiumPoints::INIT_SPACE,
        realloc::payer = payer,
        realloc::zero = false
    )]
    pub premium_points: Migration<'info, PremiumPointsV1, PremiumPoints>,
    pub system_program: Program<'info, System>,
}

/// Context for `record_affiliate_period` (M6). Creates the affiliate ledger and
/// pair account if missing (payer, the relay/sponsor, pays rent and becomes the
/// stored authority). Runs base-layer for first creation, ER gasless when delegated.
#[derive(Accounts)]
#[instruction(affiliate: Pubkey, referral: Pubkey, period: u32, usd_cents: u64, eligibility: u8)]
pub struct RecordAffiliatePeriodCtx<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + AffiliateAccount::INIT_SPACE,
        seeds = [AFFILIATE_SEED, affiliate.as_ref()],
        bump
    )]
    pub affiliate_account: Account<'info, AffiliateAccount>,
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + AffiliatePair::INIT_SPACE,
        seeds = [AFFILIATE_PAIR_SEED, affiliate.as_ref(), referral.as_ref()],
        bump
    )]
    pub affiliate_pair: Account<'info, AffiliatePair>,
    pub system_program: Program<'info, System>,
}

/// Context for `upgrade_premium_points_v3` (M5 v3): migrates a v2 premium account
/// (124 bytes) to v3 (adds booster_active_until). Permissionless; reallocs +8 bytes.
#[derive(Accounts)]
pub struct UpgradePremiumV3Ctx<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        mut,
        realloc = 8 + PremiumPoints::INIT_SPACE,
        realloc::payer = payer,
        realloc::zero = false
    )]
    pub premium_points: Migration<'info, PremiumPointsV2, PremiumPoints>,
    pub system_program: Program<'info, System>,
}

/// Context for `activate_booster` (M5 v3). Gasless on the ER (session key signs).
#[derive(Accounts)]
#[instruction(hours: i64)]
pub struct ActivateBoosterCtx<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: The player's wallet authority (seed basis for the PDA).
    pub player_authority: AccountInfo<'info>,
    #[account(mut, seeds = [PREMIUM_SEED, player_authority.key().as_ref()], bump)]
    pub premium_points: Account<'info, PremiumPoints>,
}

/// Context for `initialize_competition_tally` (H): sponsor/relay creates the
/// player's per-competition win tally once.
#[derive(Accounts)]
#[instruction(seq: u32)]
pub struct InitializeCompetitionTallyCtx<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: The player's wallet authority (seed basis).
    pub player_authority: AccountInfo<'info>,
    /// CHECK: The competition creator (comp PDA seed part).
    pub creator: AccountInfo<'info>,
    #[account(seeds = [COMP2_SEED, creator.key().as_ref(), &seq.to_le_bytes()], bump)]
    pub competition: Account<'info, CompetitionInstance>,
    #[account(
        init,
        payer = payer,
        space = 8 + std::mem::size_of::<CompetitionTally>(),
        seeds = [GFGWIN_SEED, competition.key().as_ref(), player_authority.key().as_ref()],
        bump
    )]
    pub tally: Account<'info, CompetitionTally>,
    pub system_program: Program<'info, System>,
}

/// Context for `record_competition_win` (H): gasless ER write by the player's
/// session key; auto-stop + window-fresh enforced inside.
#[derive(Accounts)]
#[instruction(seq: u32, ts: i64, game: u8)]
pub struct RecordCompetitionWinCtx<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: The player's wallet authority (seed basis).
    pub player_authority: AccountInfo<'info>,
    /// CHECK: The competition creator (comp PDA seed part).
    pub creator: AccountInfo<'info>,
    #[account(seeds = [COMP2_SEED, creator.key().as_ref(), &seq.to_le_bytes()], bump)]
    pub competition: Account<'info, CompetitionInstance>,
    #[account(mut, seeds = [GFGWIN_SEED, competition.key().as_ref(), player_authority.key().as_ref()], bump)]
    pub tally: Account<'info, CompetitionTally>,
}

/// Context for `delegate_competition_tally` (H). Mirrors the other delegates.
#[delegate]
#[derive(Accounts)]
pub struct DelegateCompetitionTallyInput<'info> {
    pub payer: Signer<'info>,
    /// CHECK: The player's wallet authority (seed basis for the PDA).
    pub player_authority: AccountInfo<'info>,
    /// CHECK: The competition instance pubkey (part of the tally seed).
    pub competition: AccountInfo<'info>,
    /// CHECK: The tally PDA to delegate.
    #[account(mut, del)]
    pub tally: UncheckedAccount<'info>,
}

/// Context for `undelegate_competition_tally` (H).
#[commit]
#[derive(Accounts)]
pub struct CommitAndUndelegateCompetitionTallyInput<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: The player's wallet authority (seed basis for the PDA).
    pub player_authority: AccountInfo<'info>,
    /// CHECK: The tally PDA to undelegate.
    #[account(mut)]
    pub tally: UncheckedAccount<'info>,
}

/// Context for `register_profile_handle` (M6). Self-service: the player's wallet
/// (session key) signs to claim a handle, gasless on the ER.
#[derive(Accounts)]
#[instruction(handle: String)]
pub struct RegisterProfileHandleCtx<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + ProfileHandle::INIT_SPACE,
        seeds = [PROFILE_HANDLE_SEED, handle.as_bytes()],
        bump
    )]
    pub handle_account: Account<'info, ProfileHandle>,
    pub system_program: Program<'info, System>,
}

/// Context for `record_affiliate_payout` (M6).
#[derive(Accounts)]
#[instruction(affiliate: Pubkey, usd_cents: u64, payout_ref: u64)]
pub struct AffiliatePayoutCtx<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [AFFILIATE_SEED, affiliate.as_ref()], bump)]
    pub affiliate_account: Account<'info, AffiliateAccount>,
}

/// Context for `close_premium_points`. Authority-gated (stored admin_authority);
/// closes the account and returns rent to `destination` so a broken account can be
/// reset and recreated cleanly (devnet maintenance only).
#[derive(Accounts)]
pub struct ClosePremiumPointsCtx<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    /// CHECK: rent recipient.
    #[account(mut)]
    pub destination: UncheckedAccount<'info>,
    #[account(mut, seeds = [PREMIUM_SEED, player_authority.key().as_ref()], bump)]
    pub premium_points: Account<'info, PremiumPoints>,
    /// CHECK: The player's wallet authority (seed basis for the PDA).
    pub player_authority: AccountInfo<'info>,
    /// Bpf-upgradeable ProgramData account (only read to authorize the deployer close).
    pub programdata: Account<'info, ProgramData>,
}

/// Context for `admin_cancel_subscription`. Authority-gated: only the stored
/// admin_authority (sponsor/ecror) may cancel a defective perpetual sub.
/// Player does NOT sign; admin does. Runs base-layer (undelegate if delegated).
#[derive(Accounts)]
pub struct AdminCancelSubscriptionCtx<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    /// CHECK: The player's wallet authority (seed basis for the PDA).
    pub player_authority: AccountInfo<'info>,
    #[account(mut, seeds = [PREMIUM_SEED, player_authority.key().as_ref()], bump)]
    pub premium_points: Account<'info, PremiumPoints>,
}

/// Context for `undelegate_premium_points`: returns the PREMIUM PDA to this
/// program (runs on the ER). Mirrors CommitAndUndelegateGlobalPointsInput.
/// premium_points is UNTYPED so a legacy v1/v2 premium account (115/124 bytes)
/// can be undelegated even though the current PremiumPoints layout is 132 bytes
/// (a typed Account<PremiumPoints> deserialize would reject the shorter bytes,
/// Custom 3003 = AccountDidNotDeserialize). The Magic commit intent only reads
/// the account key, never its data.
#[commit]
#[derive(Accounts)]
pub struct CommitAndUndelegatePremiumPointsInput<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: The player's wallet authority (seed basis for the PDA).
    pub player_authority: AccountInfo<'info>,
    /// CHECK: The premium points PDA to undelegate (untyped).
    #[account(mut)]
    pub premium_points: UncheckedAccount<'info>,
}

/// Context for `spend_local`. Runs on the ER (gasless): the player's session
/// key is the payer, and the points PDA must already exist + be delegated.
#[derive(Accounts)]
#[instruction(game_tag: String)]
pub struct SpendLocalCtx<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: The player's wallet authority (seed basis for the PDA).
    pub player_authority: AccountInfo<'info>,
    #[account(mut, seeds = [POINTS, game_tag.as_bytes(), player_authority.key().as_ref()], bump)]
    pub points: Account<'info, PlayerPoints>,
}

/// Context for `migrate_points`. Runs on the base layer (one-time, sponsor or
/// anyone pays): reads the legacy pre-game_tag PDA and seeds the new per-game
/// ledger with the same data.
#[derive(Accounts)]
#[instruction(game_tag: String)]
pub struct MigratePointsCtx<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: The player's wallet authority (seed basis for both PDAs).
    pub player_authority: AccountInfo<'info>,
    /// CHECK: Legacy (pre-game_tag) points PDA [gfgpoints, player]. Read-only
    /// tombstone; never closed after migration.
    #[account(seeds = [POINTS, player_authority.key().as_ref()], bump)]
    pub legacy_points: UncheckedAccount<'info>,
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + PlayerPoints::INIT_SPACE,
        seeds = [POINTS, game_tag.as_bytes(), player_authority.key().as_ref()],
        bump
    )]
    pub points: Account<'info, PlayerPoints>,
    pub system_program: Program<'info, System>,
}

#[vrf]
#[derive(Accounts)]
pub struct DoRollDiceCtx<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: The player's wallet authority (seed basis for the PDA).
    pub player_authority: AccountInfo<'info>,
    #[account(seeds = [PLAYER, player_authority.key().as_ref()], bump)]
    pub player: Account<'info, PlayerDice>,
    /// CHECK: The oracle queue.
    #[account(
        mut,
        constraint =
            oracle_queue.key() == vrf::consts::DEFAULT_QUEUE ||            // base-layer (devnet/mainnet)
            oracle_queue.key() == vrf::consts::DEFAULT_EPHEMERAL_QUEUE     // ephemeral rollup
    )]
    pub oracle_queue: UncheckedAccount<'info>,
}

#[vrf_callback]
#[derive(Accounts)]
pub struct CallbackRollDiceCtx<'info> {
    #[account(mut)]
    pub player: Account<'info, PlayerDice>,
}

/// Context for manual commit / undelegate (runs on the ER).
#[commit]
#[derive(Accounts)]
pub struct CommitAndUndelegateInput<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: The player's wallet authority (seed basis for the PDA).
    pub player_authority: AccountInfo<'info>,
    #[account(mut, seeds = [PLAYER, player_authority.key().as_ref()], bump)]
    pub player: Account<'info, PlayerDice>,
}

/// Context for `undelegate_points`: returns the per-game POINTS PDA to this
/// program (runs on the ER). Mirrors CommitAndUndelegateInput for the M3
/// points ledger. Additive, 2026-08-18.
#[commit]
#[derive(Accounts)]
#[instruction(game_tag: String)]
pub struct CommitAndUndelegatePointsInput<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: The player's wallet authority (seed basis for the PDA).
    pub player_authority: AccountInfo<'info>,
    #[account(mut, seeds = [POINTS, game_tag.as_bytes(), player_authority.key().as_ref()], bump)]
    pub points: Account<'info, PlayerPoints>,
}

/// Context for `undelegate_result`: returns the RESULT PDA to this program
/// (runs on the ER). Mirrors CommitAndUndelegateInput for the Scope C result
/// ledger. Additive, 2026-08-18.
#[commit]
#[derive(Accounts)]
pub struct CommitAndUndelegateResultInput<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: The player's wallet authority (seed basis for the PDA).
    pub player_authority: AccountInfo<'info>,
    #[account(mut, seeds = [RESULT, player_authority.key().as_ref()], bump)]
    pub result: Account<'info, PlayerResult>,
}

/// Context for `delegate_board`: moves a MATCH BOARD PDA into an ER session so
/// `begin_match`/`commit_move`/`finish_match` run gasless. The PDA's real seeds
/// [gfgboard2, game, match_ref] are passed to `delegate_board(...)`. Additive
/// (arc2m1a G0).
#[delegate]
#[derive(Accounts)]
pub struct DelegateBoardInput<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: The board PDA to delegate.
    #[account(mut, del)]
    pub board: UncheckedAccount<'info>,
}

/// Context for `undelegate_board`: returns a MATCH BOARD PDA to this program
/// (runs on the ER). Mirrors CommitAndUndelegateResultInput. Additive.
#[commit]
#[derive(Accounts)]
#[instruction(game: u8, match_ref: u64)]
pub struct CommitAndUndelegateBoardInput<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [MATCHBOARD2_SEED, &game.to_le_bytes(), &match_ref.to_le_bytes()], bump)]
    pub board: Account<'info, MatchBoard>,
}

/// Context for `undelegate_global_points`: returns the GLOBAL POINTS PDA to
/// this program (runs on the ER). Mirrors CommitAndUndelegateInput for the M4
/// global ledger. Additive, 2026-08-18.
#[commit]
#[derive(Accounts)]
pub struct CommitAndUndelegateGlobalPointsInput<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: The player's wallet authority (seed basis for the PDA).
    pub player_authority: AccountInfo<'info>,
    #[account(mut, seeds = [POINTS, GLOBAL_TAG, player_authority.key().as_ref()], bump)]
    pub global_points: Account<'info, GlobalPoints>,
}

#[account]
#[derive(InitSpace)]
pub struct PlayerDice {
    pub last_roll1: u8,
    pub last_roll2: u8,
    pub last_client_seed: u8,
    pub last_request_ts: i64,
}

/// On-chain LOCAL points ledger for one player per game (M3 — two-track local
/// points). One account per [game_tag, player]. Runs gasless on the ER.
///
/// Field naming: `local_` prefixed so the future M4 GLOBAL ledgers can live on
/// the same program as `global_*` fields/accounts without ambiguity.
///
/// Fields:
///   - local_pure_lifetime    : PURE (unspendable) lifetime points. Source of truth
///                        for the player's on-chain bragging rights. Credits
///                        on every verified win; never drawn down.
///   - local_spendable_balance: SPENDABLE track credited alongside pure on every win
///                        (1:1 for now). Can be spent via `spend_local` (local
///                        in-game purchases) or `claim_comp` (competition
///                        winnings credit this track).
///   - last_points      : the most recent award amount.
///   - last_reason      : award reason tag (client mapping; see
///                        `src/magicblock-vrf.js` POINT_REASONS).
///   - last_match_ref   : first 8 bytes (as u64) of the proof-roll tx signature
///                        that earned the last award. Duplicate guard for the
///                        idempotent 1x-per-match rule.
///   - last_recorded_ts : unix ts of the most recent award.
///   - award_count      : number of awards recorded.
///   - last_spend_ts    : unix ts of the most recent local spend.
///   - last_spend_ref   : client/backend purchase reference of the last spend.
///   - last_spend_reason: spend reason tag of the last spend.
///   - spend_count      : number of local spends recorded.
#[account]
#[derive(InitSpace)]
pub struct PlayerPoints {
    pub local_pure_lifetime: u64,
    pub local_spendable_balance: u64,
    pub last_points: u64,
    pub last_reason: u8,
    pub last_match_ref: u64,
    pub last_recorded_ts: i64,
    pub award_count: u64,
    pub last_spend_ts: i64,
    pub last_spend_ref: u64,
    pub last_spend_reason: u8,
    pub spend_count: u64,
}

/// M10 LIVES ledger (game-agnostic, on-chain).
/// One account per player, seed [gfglives, player]. The lives gate is the same
/// for EVERY M1 game (Ludo now, Ayo/future later): a completed match consumes
/// exactly one life; abandon / reset / disconnect never complete -> never cost
/// a life (and never award points). Subscribers / boosted (unlimited) players
/// pass the gate without drawing the meter (boosterActiveUntil read from the
/// player's premium ledger).
///
/// THIS IS THE ON-CHAIN ENFORCEMENT the platform uses: because the lives ledger
/// lives in the program and start_match/join_match gate against it, an external
/// frontend calling the public program still cannot onboard unpaid play - the
/// gate is chain-enforced, not client-enforced.
///
/// UTC-day accounting: `day = unix_ts / 86400` (UTC). `used` resets to 0 when
/// the UTC day changes (refill). `pool` = lives available per day for the
/// player's tier (free 5 / L2 10 / L3 15 / L4 20), snapshotted by the client
/// at activation but enforced as `used < pool` by consume/lookup.
#[account]
pub struct LivesAccount {
    pub version: u8,          // 1
    pub player: Pubkey,       // the owner (to prevent replay from wrong PDA)
    pub day: i64,             // UTC day key (unix_ts / 86400)
    pub used: u16,            // lives consumed this UTC day
    pub pool: u16,            // daily pool for the player's tier (5/10/15/20)
    pub unlimited_until: i64, // 0 = not unlimited; else GMT epoch (booster / sub)
    pub last_consumed_ref: u64, // match_ref of the last consumed completion (idempotency)
    pub last_consumed_ts: i64,
    pub award_count: u64,     // total lives consumed ever (accounting)
}
impl LivesAccount {
    pub const INIT_SPACE: usize =
        1 + 32 + 8 + 2 + 2 + 8 + 8 + 8 + 8;
}

/// On-chain GLOBAL points ledger for one player (M4 — site-wide three-ledger
/// framework). One account per player, seed [gfgpoints, 'global', player].
/// Runs gasless on the ER.
///
/// Three tracks:
///   - global_pure_lifetime    : sum of M3 local wins across ALL games, no
///                               multiplier, no purchases, no bonus — the honest
///                               cross-game skill total (M4a).
///   - global_lifetime         : every point earned from ANY source (M3 game
///                               wins + M5 multiplier credits + M6 signup/
///                               referral/giveaway). Unspendable, permanent
///                               reputation number (M4b).
///   - global_spendable_balance: the spendable split of lifetime. Purchases,
///                               Active Tier buys, comp entries, cosmetics
///                               all flow here. Goes up and down (M4c).
///
/// `kind` field on credits:
///   - 0 = GAME WIN: credits all three tracks (M4a + M4b + M4c).
///   - 1 = OTHER (signup_bonus/referral/giveaway/tier_boost): credits M4b
///         + M4c only. M4a pure is never multiplied or bonus-inflated.
#[account]
#[derive(InitSpace)]
pub struct GlobalPoints {
    pub global_pure_lifetime: u64,   // M4a: sum of verified game wins only
    pub global_lifetime: u64,        // M4b: everything earned, unspendable
    pub global_spendable_balance: u64, // M4c: spendable track
    pub last_source: u8,             // source_code enum: 1=ludo, 2=ayo_olopon, 10=signup_bonus, 11=referral, 12=giveaway, 13=tier_boost, 14=daily_reward
    pub last_points: u64,
    pub last_reason: u8,
    pub last_match_ref: u64,
    pub last_recorded_ts: i64,
    pub award_count: u64,
    pub last_spend_ts: i64,
    pub last_spend_ref: u64,
    pub last_spend_reason: u8,
    pub spend_count: u64,
}

/// M6 signup-bonus fence account ([gfgclaim, player]), ONE per wallet. Holds
/// an immutable "claimed" flag so the 500P signup bonus can only ever be
/// granted once in the program's lifetime, even if a client or server map is
/// forged or lost. Never changes seed; additive-only account type.
#[account]
#[derive(Default)]
pub struct SignupClaim {
    pub version: u8,      // 1 = current
    pub claimed: u8,      // 0 = not claimed, 1 = claimed (permanent)
    pub claimed_ts: i64,  // unix ts when claimed
    pub claim_ref: u64,   // the credit match_ref used
}

/// M7 competition instance ([gfgcomp2, creator, seq]) - the competition itself,
/// fully config-driven (games, tiers, entry, window, pool, shares, redemption).
#[account]
pub struct CompetitionInstance {
    pub version: u8,          // 1 = current
    pub creator: Pubkey,      // instance authority (admin now, sponsors later)
    pub seq: u32,
    pub name: [u8; 24],
    pub games: [u8; MAX_GAMES],   // source_codes of selected games (0 = empty)
    pub game_count: u8,
    pub tier_bits: u8,        // bit k set => level k qualifies (bit2=L2, bit3=L3, ...)
    pub require_all: u8,      // 0 = any-of tiers, 1 = all-of (future, reserved)
    pub entry_cost: u64,
    pub entry_families: u8,   // bit0 global, bit1 local, bit2 premium
    pub starts_at: i64,
    pub ends_at: i64,         // auto-stop (R16)
    pub pool_usd_cents: u64,
    pub pool_points: u64,     // pool in points ($0.002/pt base, set by creator)
    pub winner_count: u8,
    pub prize_shares: [u32; MAX_WINNERS], // redemption units per rank (1..winner_count)
    pub redemption: u8,       // 0 naira, 1 points, 2 crypto, 3 merch (presentational)
    pub payout_mode: u8,      // 0 manual, 1 escrow (later)
    pub status: u8,           // 0 open, 1 closed, 2 settled, 3 cancelled
    pub settled_ts: i64,
}

/// M7 winner record ([gfgwin, comp, rank]) - one per prize slot, on-chain proof
/// of who won which rank and whether they were paid (R15).
#[account]
pub struct WinnerRecord {
    pub version: u8,
    pub comp: Pubkey,
    pub rank: u8,
    pub player: Pubkey,
    pub points: u64,
    pub usd_cents: u64,
    pub status: u8,           // 0 won (pending), 1 paid
    pub paid_ts: i64,
}

/// M7 per-player in-window win tally ([gfgwin, comp, player]) - the durable,
/// on-chain record of verified wins inside a competition window (R13/R16).
/// Written gaslessly by the player's session key (ER); read by the board.
#[account]
pub struct CompetitionTally {
    pub version: u8,
    pub comp: Pubkey,
    pub player: Pubkey,
    pub wins: u64,
    pub first_ts: i64,
    pub last_ts: i64,
}

/// Arc2 M1 (item D): on-chain match board for MULTIPLAYER (earn) matches.
/// M12 multiplayer match board v2 (seed gfgboard2). One per match, delegated
/// to the ER so all match writes run gasless. v2 is the seat-AUTHORITY board:
/// start_match locks the host + open seats; join_match fills each free seat
/// with the joiner's REAL wallet + sitewide handle; begin requires all seats
/// full (host signs); commit_move requires signer == players[seat] so the
/// wrong device can never commit another player's seat; current_turn records
/// whose move it is for the game-agnostic rail. Game-agnostic: the board
/// stores opaque 32-byte move commits + a turn cursor, never game rules.
#[account]
pub struct MatchBoard {
    pub version: u8,             // 3 = current (creator-by-wallet; v1/v2 seeds untouched)
    pub game: u8,                // M1 source_code (1 = ludo, ...)
    pub match_ref: u64,          // lobby-generated unique id
    pub status: u8,              // 0 locked (awaiting players), 1 in_progress, 2 finished
    pub players: [Pubkey; MAX_MP],
    pub player_count: u8,        // seats actually joined (host-only create -> 1)
    pub seats: u8,               // total seats (humans + computer fill)
    pub handles: [[u8; HANDLE_SLOT]; MAX_MP], // per-seat sitewide handle (ASCII, zero-padded)
    pub current_turn: u8,        // 255 = none yet (game decides turn order)
    pub stake_usd_cents: u64,    // each side's stake
    pub seat_pot_usd_cents: u64, // pot = stake * seats  (flat 10% fee at finish)
    pub turn_secs: u64,
    pub max_match_secs: u64,
    pub started_at: i64,
    pub last_turn_ts: [i64; MAX_MP],
    pub move_count: u64,
    pub last_move_commit: [u8; 32],
    pub finished_at: i64,
    pub winner_seat: u8,         // 0..player_count-1, 255 = none yet
    pub creator: Pubkey,         // v3: the host wallet (never seat-bound). begin requires signer == creator, so switching seats never transfers creator authority.
}

/// Arc2 M1B: per-seat turn clocks + timeout record for a match. Additive to the
/// board (which stays game-agnostic): the game client maps its turn order onto
/// these per-seat clocks. A seat that stalls past its deadline accumulates a
/// timeout; at DEFAULT_TIMEOUT_CAP stalls it is FORFEITED, letting a finishing
/// seat take the win without waiting out max_match_secs. Solo boards never
/// create a clock, so the free path is untouched.
#[account]
pub struct MatchClock {
    pub version: u8,             // 1 = current
    pub game: u8,
    pub match_ref: u64,
    pub turn_secs: u64,          // snapshot from the board at start
    pub deadlines: [i64; MAX_MP],
    pub timeouts: [u8; MAX_MP],
    pub forfeited: [u8; MAX_MP],
    pub timeout_cap: u8,
    pub updated_at: i64,
}



/// On-chain PREMIUM points ledger for one player (M5 — subscription + premium
/// points, the launch engine). One account per player, seed [gfgprem, player].
/// Runs gasless on the ER.
///
/// Two tracks, buy-only (never earned from gameplay):
///   - premium_lifetime    : the player's permanent premium-point credential
///                           (never spendable).
///   - premium_spendable   : the spendable premium balance (buys the Active
///                           Tier subscription, lives, and anything else premium
///                           spendable is accepted for - places global spendable
///                           can NEVER go). Acquired ONLY via admin
///                           `credit_premium_points` after a verified purchase.
///
/// Subscription state lives here (never Supabase):
///   - subscription_level     : 0 = free, 2 = Level-2 (2x) at launch.
///   - subscription_active_until : unix ts; a fixed 30-day window, NO auto-renew
///                           (expiry is passive until the next manual purchase).
///
/// `version: u8` is FIRST per upgrade-safety R2 (live layouts are versioned).
/// The MEDIA never merges into global (M4) or local (M3) ledgers.
#[account]
#[derive(InitSpace)]
pub struct PremiumPoints {
    pub version: u8,               // layout version: 1 (original), 2 (adds last_credit_reason)
    pub admin_authority: Pubkey,   // the sponsor/ecror who may credit the ledger
    pub premium_lifetime: u64,     // permanent, never spendable
    pub premium_spendable: u64,    // spendable premium balance (buys the sub)
    pub subscription_level: u8,    // 0=free, 2=Level 2
    pub subscription_active_until: i64, // unix ts expiry; never auto-renewed
    pub last_credit_ts: i64,
    pub last_credit_points: u64,
    pub last_credit_ref: u64,
    pub last_spend_ts: i64,
    pub last_spend_ref: u64,
    pub last_spend_reason: u8,
    pub spend_count: u64,
    /// On-chain WHY of the most recent credit (M3/M4-style reason tag so modules can
    /// read source without extra metadata). 1 = subscription_payment (Level 2).
    /// Only present on version >= 2 accounts; v1 accounts default to 1 on read.
    pub last_credit_reason: u8,
    /// M5 v3: unlimited-life booster window (unix ts, 72h from activation). while
    /// active, M10 lives are unlimited. version must be >= 3 to have this field.
    pub booster_active_until: i64,
}

/// Exact byte layout of the v2 PremiumPoints account (version 2, includes
/// last_credit_reason). Used ONLY by the permissionless `upgrade_premium_points_v3`
/// migration so v2 accounts upgrade cleanly to v3 (R2).
#[derive(Clone, AnchorSerialize, AnchorDeserialize)]
pub struct PremiumPointsV2 {
    pub version: u8,
    pub admin_authority: Pubkey,
    pub premium_lifetime: u64,
    pub premium_spendable: u64,
    pub subscription_level: u8,
    pub subscription_active_until: i64,
    pub last_credit_ts: i64,
    pub last_credit_points: u64,
    pub last_credit_ref: u64,
    pub last_spend_ts: i64,
    pub last_spend_ref: u64,
    pub last_spend_reason: u8,
    pub spend_count: u64,
    pub last_credit_reason: u8,
}

impl Owner for PremiumPointsV2 {
    fn owner() -> Pubkey { crate::ID }
}

impl anchor_lang::AccountDeserialize for PremiumPointsV2 {
    fn try_deserialize_unchecked(buf: &mut &[u8]) -> Result<Self> {
        Self::skip_disc_read(buf).map_err(|_| anchor_lang::error::ErrorCode::AccountDidNotDeserialize.into())
    }
    fn try_deserialize(buf: &mut &[u8]) -> Result<Self> {
        Self::skip_disc_read(buf).map_err(|_| anchor_lang::error::ErrorCode::AccountDidNotDeserialize.into())
    }
}

impl PremiumPointsV2 {
    fn skip_disc_read(buf: &mut &[u8]) -> std::result::Result<Self, anchor_lang::solana_program::program_error::ProgramError> {
        if buf.len() < 8 {
            return Err(anchor_lang::solana_program::program_error::ProgramError::AccountDataTooSmall);
        }
        *buf = &buf[8..];
        <Self as anchor_lang::AnchorDeserialize>::deserialize(buf)
            .map_err(|_| anchor_lang::solana_program::program_error::ProgramError::InvalidAccountData)
    }
}

/// Exact byte layout of the original (v1) PremiumPoints account (115 bytes incl
/// discriminator). Used ONLY by the permissionless `upgrade_premium_points`
/// migration so old bytes keep deserializing and upgrade cleanly (upgrade-safety R2).
#[derive(Clone, AnchorSerialize, AnchorDeserialize)]
pub struct PremiumPointsV1 {
    pub version: u8,
    pub admin_authority: Pubkey,
    pub premium_lifetime: u64,
    pub premium_spendable: u64,
    pub subscription_level: u8,
    pub subscription_active_until: i64,
    pub last_credit_ts: i64,
    pub last_credit_points: u64,
    pub last_credit_ref: u64,
    pub last_spend_ts: i64,
    pub last_spend_ref: u64,
    pub last_spend_reason: u8,
    pub spend_count: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, InitSpace)]
pub struct AffiliateEntry {
    pub period: u32,
    pub referral: Pubkey,
    pub amount_usd_cents: u64,
    /// 0 = earned (pending), 1 = paid, 2 = forfeited
    pub status: u8,
    pub ts: i64,
}

/// M6 — per-affiliate immutable audit ledger. Authority = relay/sponsor.
/// Running totals are permanent; `entries` keeps the most recent 68 months.
#[account]
pub struct AffiliateAccount {
    pub version: u8,
    pub authority: Pubkey,
    pub affiliate: Pubkey,
    pub lifetime_usd_cents: u64,
    pub pending_usd_cents: u64,
    pub paid_usd_cents: u64,
    pub forfeited_usd_cents: u64,
    pub entry_count: u32,
    pub payout_count: u32,
    pub last_payout_ts: i64,
    pub last_payout_ref: u64,
    pub entries: Box<[AffiliateEntry; AFFILIATE_ENTRIES]>,
}

/// M6 — public identity handle. A player claims a handle once (gasless self-
/// register); the account binds handle -> wallet so referral links and public
/// leaderboards can show a handle and never an email or wallet.
#[account]
#[derive(InitSpace)]
pub struct ProfileHandle {
    pub owner: Pubkey,
    pub created_ts: i64,
}

impl anchor_lang::Space for AffiliateAccount {
    const INIT_SPACE: usize =
        1 + 32 + 32 + 8 + 8 + 8 + 8 + 4 + 4 + 8 + 8 + AFFILIATE_ENTRIES * 53;
}

/// M6 — per (affiliate, referral) state that drives the 60-day permanent
/// forfeit and pause/resume rules.
#[account]
#[derive(InitSpace)]
pub struct AffiliatePair {
    pub version: u8,
    pub affiliate: Pubkey,
    pub referral: Pubkey,
    pub first_subscribed_ts: i64,
    pub last_earned_period: u32,
    pub consecutive_inactive_periods: u16,
    pub forfeited: bool,
    pub paid_period_count: u16,
}

impl Owner for PremiumPointsV1 {
    fn owner() -> Pubkey { crate::ID }
}

impl anchor_lang::AccountDeserialize for PremiumPointsV1 {
    fn try_deserialize_unchecked(buf: &mut &[u8]) -> Result<Self> {
        Self::skip_disc_read(buf).map_err(|_| anchor_lang::error::ErrorCode::AccountDidNotDeserialize.into())
    }
    fn try_deserialize(buf: &mut &[u8]) -> Result<Self> {
        Self::skip_disc_read(buf).map_err(|_| anchor_lang::error::ErrorCode::AccountDidNotDeserialize.into())
    }
}

impl PremiumPointsV1 {
    fn skip_disc_read(buf: &mut &[u8]) -> std::result::Result<Self, anchor_lang::solana_program::program_error::ProgramError> {
        // Skip the 8-byte account discriminator, then read the 13 borsh fields.
        if buf.len() < 8 {
            return Err(anchor_lang::solana_program::program_error::ProgramError::AccountDataTooSmall);
        }
        *buf = &buf[8..];
        <Self as anchor_lang::AnchorDeserialize>::deserialize(buf)
            .map_err(|_| anchor_lang::solana_program::program_error::ProgramError::InvalidAccountData)
    }
}

/// Exact byte layout of the LEGACY (pre-game_tag) PlayerPoints account created
/// by Scope B. Used only by `migrate_points` to read old accounts that predate
/// the per-game seed change. Never ship this layout as a new account; it exists
/// so old bytes keep deserializing and migrate cleanly (upgrade-safety R2).
#[derive(Clone, Copy, AnchorSerialize, AnchorDeserialize)]
pub struct LegacyPlayerPoints {
    pub total_points: u64,
    pub last_points: u64,
    pub last_reason: u8,
    pub last_match_ref: u64,
    pub last_recorded_ts: i64,
    pub award_count: u64,
}

/// On-chain match-result ledger for one player (Scope C — finish order).
///
/// Fields:
///   - finish_order     : finish positions for the match, index i = seat/color
///                        that finished in position i+1 (0 = 1st place).
///   - points           : the reward points recorded for that result.
///   - multiplier       : the Active Tier multiplier that applied.
///   - match_ref        : first 8 bytes (as u64) of the proof-roll tx signature.
///   - last_recorded_ts : unix ts of the most recent result.
///   - result_count     : number of results recorded.
#[account]
#[derive(InitSpace)]
pub struct PlayerResult {
    pub finish_order: [u8; 4],
    pub points: u64,
    pub multiplier: u8,
    pub match_ref: u64,
    pub last_recorded_ts: i64,
    pub result_count: u64,
}

/// Competition lifecycle states.
#[repr(u8)]
pub enum CompState {
    Open = 0,    // entries open, sponsor can fund the pool
    Funded = 1,  // entry closed, pool locked, sponsor can settle
    Settled = 2, // winners allocated, claims open
}

/// One winner's allocation inside a Competition escrow.
#[derive(InitSpace, Default, Clone, AnchorSerialize, AnchorDeserialize)]
pub struct WinnerAlloc {
    pub winner: Pubkey,
    pub amount: u64,
    pub claimed: bool,
}

/// Competition escrow (S2 — earn + brand rake). Seed `gfgcomp` + comp_id.
///
/// The sponsor locks the prize pool on-chain BEFORE the event; on settle the
/// program enforces a 70/30 rake and stores the winner table; winners claim
/// their allocations gasless on the ER.
#[account]
#[derive(InitSpace)]
pub struct Competition {
    pub comp_id: u64,
    pub sponsor: Pubkey,
    pub entry_fee: u64,
    pub ends_at: i64,
    pub prize_pool: u64,
    pub state: u8,
    pub winner_count: u8,
    pub winners: [WinnerAlloc; 3],
}

#[error_code]
pub enum PointsError {
    #[msg("points must be greater than zero")]
    ZeroPoints,
    #[msg("points overflow")]
    Overflow,
    #[msg("unknown or unregistered game tag")]
    InvalidGameTag,
    #[msg("match_ref already recorded (duplicate award guard)")]
    DuplicateMatchRef,
    #[msg("insufficient spendable balance for this local spend")]
    InsufficientBalance,
    #[msg("only the competition sponsor can do this")]
    NotSponsor,
    #[msg("fund amount must be greater than zero")]
    ZeroAmount,
    #[msg("competition is not open")]
    NotOpen,
    #[msg("competition is not funded")]
    NotFunded,
    #[msg("only the exact seat owner may do this (M12 seat authority)")]
    NotSeatAuthority,
    #[msg("competition is not settled")]
    NotSettled,
    #[msg("competition still running (ends_at not reached)")]
    StillRunning,
    #[msg("winner allocations exceed the 70% winners bucket")]
    OverAlloc,
    #[msg("no such winner index")]
    NoSuchWinner,
    #[msg("allocation belongs to a different player")]
    NotYourAllocation,
    #[msg("allocation already claimed")]
    AlreadyClaimed,
    #[msg("signup bonus already claimed (once per account, forever)")]
    SignupAlreadyClaimed,
    #[msg("unsupported subscription level (2 or 3 at launch)")]
    InvalidLevel,
    #[msg("credit exceeds the on-chain maximum (single credit or lifetime ceiling)")]
    CreditTooLarge,
    #[msg("invalid competition configuration")]
    InvalidCompetition,
    #[msg("only the competition creator can do this")]
    NotCreator,
    #[msg("competition must be closed before winners are recorded")]
    CompetitionNotClosed,
    #[msg("competition must be settled before paying winners")]
    CompetitionNotSettled,
    #[msg("prize rank is out of range for this competition")]
    RankOutOfRange,
    #[msg("premium points credit requires the admin authority signer")]
    NotAdmin,
    #[msg("premium points credit_ref already used (duplicate credit guard)")]
    DuplicateCreditRef,
    #[msg("insufficient premium spendable balance")]
    InsufficientPremiumBalance,
    #[msg("subscription already active - one plan at a time, re-upgrade only after expiry")]
    AlreadyActive,
    #[msg("premium account needs upgrade_premium_points (v2 layout) first")]
    NeedsUpgrade,
    #[msg("affiliate period for this referral already recorded")]
    DuplicateAffiliatePeriod,
    #[msg("affiliate reward is one-time per referral (first upgrade only)")]
    AffiliateOnceOnly,
    #[msg("profile handle already taken")]
    DuplicateHandle,
    #[msg("profile handle is invalid (5-24 chars, letters/numbers only)")]
    InvalidHandle,
    #[msg("no lives left today - refill at midnight GMT or go Premium")]
    NoLives,
    #[msg("illegal chess move")]
    IllegalMove,
    #[msg("not your turn")]
    NotYourTurn,
    #[msg("player core bucket table is full (24 games); open a page-2 core")]
    CoreBucketsFull,
}
