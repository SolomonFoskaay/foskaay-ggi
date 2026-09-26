// gfg-move — GlobalFolkGames ER game-move experiment program.
//
// PURPOSE (experiment only, NOT wired into the live game):
// Prove whether validating + applying game-state moves on a MagicBlock
// Ephemeral Rollup is fast enough for real-time play, and measure it against
// the base layer. The findings decide WHICH Ludo actions move on-chain.
//
// Surface measured:
//   - game_move  : a simple legality-checked state write (the "piece moved")
//   - roll_dice  : delegated VRF via the ER queue (on-rollup randomness)
// The delegate/commit/undelegate go through the ephemeral-rollups-sdk so the
// game PDA runs inside an ER session: gasless, low latency, free VRF.
//
// The single on-chain 'proof of fairness' pattern stays with gfg-dice
// (CH8JepNPAqpp3X67bxujngUSdmFy7Dq1BWxrBu8wgAuJ). This program is isolated so
// the live dice program is never touched by experiments.

use anchor_lang::prelude::*;

use ephemeral_rollups_sdk::anchor::{commit, delegate, ephemeral, vrf, vrf_callback};
use ephemeral_rollups_sdk::cpi::DelegateConfig;
use ephemeral_rollups_sdk::ephem::MagicIntentBundleBuilder;
use ephemeral_rollups_sdk::vrf::{
    self,
    instructions::{create_request_scoped_randomness_ix, RequestRandomnessParams},
    types::SerializableAccountMeta,
};

declare_id!("CkzrmH8NjyT4GPxq4qvK3v4HLujnJcPHyLJViqrpHFcj");

pub const GAME: &[u8] = b"gfgmove";

#[ephemeral]
#[program]
pub mod gfg_move {
    use super::*;

    // Board constants mirroring a Ludo track (excluding home columns):
    pub const BOARD_LEN: u8 = 52; // shared track cells

    /// Idempotent: creates the player's game PDA (rent paid by app sponsor).
    pub fn init_game(ctx: Context<InitGame>) -> Result<()> {
        Ok(())
    }

    /// Requests verifiable randomness on the ER queue. The callback stores the
    /// roll on the game PDA so a subsequent `game_move` can enforce legality.
    pub fn roll_dice(ctx: Context<DoRollDiceCtx>, client_seed: u8) -> Result<()> {
        let ix = create_request_scoped_randomness_ix(RequestRandomnessParams {
            payer: ctx.accounts.payer.key(),
            oracle_queue: ctx.accounts.oracle_queue.key(),
            callback_program_id: ID,
            callback_discriminator: instruction::CallbackRollDice::DISCRIMINATOR.to_vec(),
            caller_seed: [client_seed; 32],
            accounts_metas: Some(vec![SerializableAccountMeta {
                pubkey: ctx.accounts.game.key(),
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

    /// Called by the VRF program with the verified randomness.
    pub fn callback_roll_dice(
        ctx: Context<CallbackRollDiceCtx>,
        randomness: [u8; 32],
        client_seed: u8,
    ) -> Result<()> {
        let mut seed = [0u8; 32];
        seed[..16].copy_from_slice(&randomness[..16]);
        seed[16..].copy_from_slice(&randomness[..16]);
        let roll = vrf::rnd::random_u8_with_range(&seed, 1, 6);

        ctx.accounts.game.last_roll = roll;
        ctx.accounts.game.last_client_seed = client_seed;
        Ok(())
    }

    /// Legality-checked move: advances from cell `from` to `to` by exactly one
    /// cell on the shared track (experiment-grade rule; the integration phase
    /// swaps in the full Ludo ruleset on the same instruction shape).
    pub fn game_move(
        ctx: Context<GameMoveCtx>,
        from: u8,
        to: u8,
        expected_roll: u8,
    ) -> Result<()> {
        let game = &mut ctx.accounts.game;
        require!((from as u16) < BOARD_LEN as u16, MoveError::OutOfBoard);
        require!((to as u16) < BOARD_LEN as u16, MoveError::OutOfBoard);
        require!(
            (to as i16 - from as i16) == expected_roll as i16,
            MoveError::IllegalMove
        );
        require!(
            game.last_roll == expected_roll,
            MoveError::RollMismatch
        );

        game.move_count = game.move_count.checked_add(1).ok_or(MoveError::Overflow)?;
        game.last_from = from;
        game.last_to = to;
        Ok(())
    }

    pub fn delegate(ctx: Context<DelegateInput>) -> Result<()> {
        let authority = ctx.accounts.player_authority.key();
        ctx.accounts.delegate_game(
            &ctx.accounts.payer,
            &[GAME, authority.as_ref()],
            DelegateConfig {
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
        .commit(&[ctx.accounts.game.to_account_info()])
        .build_and_invoke()?;
        Ok(())
    }

    pub fn undelegate(ctx: Context<CommitAndUndelegateInput>) -> Result<()> {
        MagicIntentBundleBuilder::new(
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .commit_and_undelegate(&[ctx.accounts.game.to_account_info()])
        .build_and_invoke()?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct InitGame<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: The player's wallet authority that owns this game account.
    pub player_authority: AccountInfo<'info>,
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + GameState::INIT_SPACE,
        seeds = [GAME, player_authority.key().as_ref()],
        bump
    )]
    pub game: Account<'info, GameState>,
    pub system_program: Program<'info, System>,
}

#[delegate]
#[derive(Accounts)]
pub struct DelegateInput<'info> {
    pub payer: Signer<'info>,
    /// CHECK: The player's wallet authority (seed basis for the PDA).
    pub player_authority: AccountInfo<'info>,
    /// CHECK: The pda to delegate.
    #[account(mut, del)]
    pub game: UncheckedAccount<'info>,
}

#[vrf]
#[derive(Accounts)]
pub struct DoRollDiceCtx<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: The player's wallet authority (seed basis for the PDA).
    pub player_authority: AccountInfo<'info>,
    #[account(seeds = [GAME, player_authority.key().as_ref()], bump)]
    pub game: Account<'info, GameState>,
    /// CHECK: The oracle queue.
    #[account(
        mut,
        constraint =
            oracle_queue.key() == vrf::consts::DEFAULT_QUEUE ||
            oracle_queue.key() == vrf::consts::DEFAULT_EPHEMERAL_QUEUE
    )]
    pub oracle_queue: UncheckedAccount<'info>,
}

#[vrf_callback]
#[derive(Accounts)]
pub struct CallbackRollDiceCtx<'info> {
    #[account(mut)]
    pub game: Account<'info, GameState>,
}

#[derive(Accounts)]
pub struct GameMoveCtx<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: The player's wallet authority (seed basis for the PDA).
    pub player_authority: AccountInfo<'info>,
    #[account(mut, seeds = [GAME, player_authority.key().as_ref()], bump)]
    pub game: Account<'info, GameState>,
}

/// Context for manual commit / undelegate (runs on the ER).
#[commit]
#[derive(Accounts)]
pub struct CommitAndUndelegateInput<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: The player's wallet authority (seed basis for the PDA).
    pub player_authority: AccountInfo<'info>,
    #[account(mut, seeds = [GAME, player_authority.key().as_ref()], bump)]
    pub game: Account<'info, GameState>,
}

#[account]
#[derive(InitSpace)]
pub struct GameState {
    pub move_count: u64,
    pub last_from: u8,
    pub last_to: u8,
    pub last_roll: u8,
    pub last_client_seed: u8,
}

#[error_code]
pub enum MoveError {
    #[msg("cell out of board")]
    OutOfBoard,
    #[msg("illegal move")]
    IllegalMove,
    #[msg("roll does not match expected value")]
    RollMismatch,
    #[msg("move counter overflow")]
    Overflow,
}