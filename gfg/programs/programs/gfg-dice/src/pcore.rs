// core.rs - PLAYER CORE ACCOUNT (arcv2m3, the law).
//
// ONE on-chain account per player instead of one PDA per feature per game.
// Seed [gfgcore, player]. It holds lives, the global ledgers, premium, the last
// result digest, and a bounded table of per-game point BUCKETS (24 bytes each,
// keyed by the 8-byte game tag). Adding a platform game NEVER adds an account
// and never needs a program change.
//
// Build law: layout is fixed and versioned (version u8 FIRST). Any future change
// ships a permissionless, idempotent migrate_* in the SAME build. Do not
// reorder, rename, or remove fields.

use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::{commit, delegate};
use ephemeral_rollups_sdk::cpi::DelegateConfig;
use ephemeral_rollups_sdk::ephem::MagicIntentBundleBuilder;

pub const CORE_SEED: &[u8] = b"gfgcore";
pub const CORE_BUCKETS: usize = 24;
pub const CORE_DEFAULT_POOL: u16 = 5;
/// Highest plan level (the config ladder tops out at L3). An unvalidated level
/// once reached 112 on a live account; the boundary now refuses it.
pub const MAX_PLAN_LEVEL: u8 = 3;
/// Hard ceiling for a SINGLE premium credit. A frontend bug once credited an
/// absurd amount to one account; this makes a repeat impossible ON-CHAIN.
pub const MAX_PREMIUM_CREDIT: u64 = 1_000_000;
/// Hard ceiling for the accumulated premium lifetime on one account.
pub const MAX_PREMIUM_LIFETIME: u64 = 100_000_000;

/// One per-game bucket: 24 bytes. Keyed by the 8-byte game tag so no numeric
/// registry exists and a new game needs no program change. A runtime vector of
/// protocol metadata needs large stack space; this anchor's small fixed array
/// alone generates a tiny frame, so keep it in the account data (not on stack).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default)]
pub struct GameBucket {
    pub game_tag: [u8; 8],
    pub local_pure: u64,
    pub local_spendable: u64,
}

#[account]
pub struct PlayerCore {
    pub version: u8,
    pub player: Pubkey,
    pub created_at: i64,
    // lives (charged AT GAME START)
    pub lives_day: i64,
    pub lives_used: u16,
    pub lives_pool: u16,
    pub unlimited_until: i64,
    pub last_life_ref: u64,
    pub last_life_ts: i64,
    pub lives_award_count: u64,
    // global ledgers
    pub global_pure: u64,
    pub global_lifetime: u64,
    pub global_spendable: u64,
    // premium (subscription + booster), direct-activate
    pub premium_lifetime: u64,
    pub premium_spendable: u64,
    pub subscription_level: u8,
    pub subscription_active_until: i64,
    pub booster_active_until: i64,
    pub last_credit_ref: u64,
    // last result (for the seam / profile) + idempotency refs
    pub last_match_ref: u64,
    pub last_global_ref: u64,
    pub last_finish_digest: [u8; 8],
    // per-game point buckets
    pub bucket_count: u8,
    pub buckets: [GameBucket; CORE_BUCKETS],
    pub bump: u8,
    /// The admin/operator authority (set to the initializer = sponsor relay).
    /// Gates premium credit and plan/booster activation (direct, after a
    /// verified payment). Kept LAST so earlier offsets never shift.
    pub admin_authority: Pubkey,
}

impl PlayerCore {
    // Fixed Borsh length (no padding). Must equal the serialized size.
    pub const LEN: usize = 1 + 32 + 8            // version, player, created_at
        + 8 + 2 + 2 + 8 + 8 + 8 + 8              // lives
        + 8 + 8 + 8                              // global
        + 8 + 8 + 1 + 8 + 8 + 8                  // premium
        + 8 + 8 + 8                              // last result (match_ref, global_ref, digest)
        + 1 + (8 + 8 + 8) * CORE_BUCKETS         // bucket_count + buckets
        + 1                                       // bump
        + 32; // admin_authority (last; keeps earlier offsets stable)

    /// Find the bucket index for a game tag, or None.
    pub fn find_bucket(&self, tag: &[u8; 8]) -> Option<usize> {
        for i in 0..self.bucket_count as usize {
            if &self.buckets[i].game_tag == tag { return Some(i); }
        }
        None
    }

    /// Find or append the bucket for a game tag, returning its index.
    pub fn ensure_bucket(&mut self, tag: &[u8; 8]) -> Result<usize> {
        if let Some(i) = self.find_bucket(tag) { return Ok(i); }
        let n = self.bucket_count as usize;
        require!(n < CORE_BUCKETS, crate::PointsError::CoreBucketsFull);
        self.buckets[n].game_tag = *tag;
        self.buckets[n].local_pure = 0;
        self.buckets[n].local_spendable = 0;
        self.bucket_count = (n + 1) as u8;
        Ok(n)
    }

    /// Charge ONE life AT GAME START (never on completion). Unlimited (booster
    /// or premium active) draws nothing but stamps the ref. Callers charge only
    /// on a real transition so a retry can never double-charge.
    pub fn charge_life(&mut self, now: i64, match_ref: u64) -> Result<()> {
        // Unlimited when EITHER the lives window (unlimited_until) or an active
        // M5 booster (booster_active_until) is live. The booster used to write
        // only booster_active_until, which this gate ignored, so a paying
        // booster player was still charged lives on-chain while the UI showed
        // unlimited. (Fix 2026-09; no layout change.)
        if (self.unlimited_until > 0 && self.unlimited_until > now)
            || (self.booster_active_until > 0 && self.booster_active_until > now)
        {
            self.last_life_ref = match_ref;
            self.last_life_ts = now;
            return Ok(());
        }
        let day = now / 86400;
        if self.lives_day != day { self.lives_day = day; self.lives_used = 0; } // GMT+00 refill
        require!(self.lives_used < self.lives_pool, crate::PointsError::NoLives);
        self.lives_used = self.lives_used.checked_add(1).ok_or(crate::PointsError::Overflow)?;
        self.last_life_ref = match_ref;
        self.last_life_ts = now;
        self.lives_award_count = self.lives_award_count.checked_add(1).ok_or(crate::PointsError::Overflow)?;
        Ok(())
    }

    /// Credit the global ledgers. kind 0 = game win (pure + lifetime +
    /// spendable); kind 1 = other sources (lifetime + spendable only, never
    /// pure). Idempotent by `last_global_ref`.
    pub fn record_global(&mut self, kind: u8, points: u64, match_ref: u64) -> Result<()> {
        if kind == 0 {
            self.global_pure = self.global_pure.checked_add(points).ok_or(crate::PointsError::Overflow)?;
        }
        self.global_lifetime = self.global_lifetime.checked_add(points).ok_or(crate::PointsError::Overflow)?;
        self.global_spendable = self.global_spendable.checked_add(points).ok_or(crate::PointsError::Overflow)?;
        self.last_global_ref = match_ref;
        Ok(())
    }

    /// Spend from the global spendable balance.
    pub fn spend_global(&mut self, amount: u64) -> Result<()> {
        require!(self.global_spendable >= amount, crate::PointsError::InsufficientBalance);
        self.global_spendable = self.global_spendable.checked_sub(amount).ok_or(crate::PointsError::InsufficientBalance)?;
        Ok(())
    }

    /// Spend `amount` of the local SPENDABLE track for `tag` (never the pure
    /// track). The game's bucket must already exist.
    pub fn spend_local(&mut self, tag: &[u8; 8], amount: u64) -> Result<()> {
        let i = self.find_bucket(tag).ok_or(crate::PointsError::InvalidGameTag)?;
        require!(self.buckets[i].local_spendable >= amount, crate::PointsError::InsufficientBalance);
        self.buckets[i].local_spendable = self.buckets[i]
            .local_spendable
            .checked_sub(amount)
            .ok_or(crate::PointsError::InsufficientBalance)?;
        Ok(())
    }

    /// Spend `amount` of the PREMIUM spendable track (never `premium_lifetime`).
    pub fn spend_premium(&mut self, amount: u64) -> Result<()> {
        require!(self.premium_spendable >= amount, crate::PointsError::InsufficientBalance);
        self.premium_spendable = self.premium_spendable
            .checked_sub(amount)
            .ok_or(crate::PointsError::InsufficientBalance)?;
        Ok(())
    }

    /// Migration (arcv2m3, 2026-09): fold a retired per-game points ledger into
    /// this player's bucket for `tag`. The caller zeroes the source afterwards,
    /// which is what makes the migration idempotent (a re-run adds zero).
    pub fn migrate_bucket(&mut self, tag: [u8; 8], pure: u64, spendable: u64) -> Result<()> {
        let i = self.ensure_bucket(&tag)?;
        self.buckets[i].local_pure = self.buckets[i]
            .local_pure
            .checked_add(pure)
            .ok_or(crate::PointsError::Overflow)?;
        self.buckets[i].local_spendable = self.buckets[i]
            .local_spendable
            .checked_add(spendable)
            .ok_or(crate::PointsError::Overflow)?;
        Ok(())
    }

    /// Migration: fold the retired global ledger into the core's globals.
    pub fn migrate_global(&mut self, pure: u64, lifetime: u64, spendable: u64) -> Result<()> {
        self.global_pure = self.global_pure.checked_add(pure).ok_or(crate::PointsError::Overflow)?;
        self.global_lifetime = self.global_lifetime.checked_add(lifetime).ok_or(crate::PointsError::Overflow)?;
        self.global_spendable = self.global_spendable.checked_add(spendable).ok_or(crate::PointsError::Overflow)?;
        Ok(())
    }

    /// Migration: fold the retired premium ledger into the core's premium track.
    /// An active plan/booster on the source is carried over ONLY when the core
    /// has none, so a live core subscription is never overwritten.
    pub fn migrate_premium(
        &mut self,
        lifetime: u64,
        spendable: u64,
        level: u8,
        until: i64,
        booster_until: i64,
    ) -> Result<()> {
        self.premium_lifetime = self.premium_lifetime.checked_add(lifetime).ok_or(crate::PointsError::Overflow)?;
        self.premium_spendable = self.premium_spendable.checked_add(spendable).ok_or(crate::PointsError::Overflow)?;
        // A junk level (e.g. 112 from the 2026-08 bug) is never carried over.
        if self.subscription_active_until == 0 && until > 0 && level >= 1 && level <= MAX_PLAN_LEVEL {
            self.subscription_level = level;
            self.subscription_active_until = until;
            self.lives_pool = if level >= 3 { 15 } else if level == 2 { 10 } else { 5 };
        }
        if booster_until > self.booster_active_until { self.booster_active_until = booster_until; }
        Ok(())
    }

    /// Credit premium points (admin/operated). The direct-activation flow keeps
    /// this for promos; a purchase activates the plan directly (no middleman).
    pub fn credit_premium(&mut self, points: u64, credit_ref: u64) -> Result<()> {
        require!(self.last_credit_ref != credit_ref, crate::PointsError::DuplicateCreditRef);
        // HARD CAPS (on-chain, not client-side): one credit can never be absurd,
        // and the lifetime can never accumulate past a sane ceiling.
        require!(points <= MAX_PREMIUM_CREDIT, crate::PointsError::CreditTooLarge);
        let next_lifetime = self.premium_lifetime.checked_add(points).ok_or(crate::PointsError::Overflow)?;
        require!(next_lifetime <= MAX_PREMIUM_LIFETIME, crate::PointsError::CreditTooLarge);
        self.premium_lifetime = next_lifetime;
        self.premium_spendable = self.premium_spendable.checked_add(points).ok_or(crate::PointsError::Overflow)?;
        self.last_credit_ref = credit_ref;
        Ok(())
    }

    /// Admin correction (2026-09): SET the premium balances outright and
    /// optionally clear the plan. Used to repair an account corrupted by the
    /// 2026-08 frontend bug that credited an absurd premium amount, and to
    /// issue refunds/corrections. Admin-gated at the instruction boundary.
    pub fn fix_premium(&mut self, lifetime: u64, spendable: u64, clear_plan: bool) -> Result<()> {
        self.premium_lifetime = lifetime;
        self.premium_spendable = spendable;
        if clear_plan { self.cancel_plan()?; }
        Ok(())
    }

    /// DIRECT activation: set the plan level + expiry in ONE step (pay -> active,
    /// no premium-points middleman, no second click). Lives pool follows the
    /// tier (free/other 5, L2 10, L3 15).
    pub fn activate_plan(&mut self, level: u8, until: i64) -> Result<()> {
        // The ladder tops out at L3. Without this a bad caller could park any
        // u8 level on the account (a live account once held level 112).
        require!(level <= MAX_PLAN_LEVEL, crate::PointsError::InvalidLevel);
        self.subscription_level = level;
        self.subscription_active_until = until;
        self.lives_pool = if level >= 3 { 15 } else if level == 2 { 10 } else { 5 };
        Ok(())
    }

    /// DIRECT booster activation (unlimited lives until `until`).
    pub fn activate_booster(&mut self, until: i64) -> Result<()> {
        if until > self.booster_active_until { self.booster_active_until = until; }
        Ok(())
    }

    /// Admin cancel: clear the plan (level 0, no active window, base pool).
    pub fn cancel_plan(&mut self) -> Result<()> {
        self.subscription_level = 0;
        self.subscription_active_until = 0;
        self.lives_pool = 5;
        Ok(())
    }
}

/// Pad a game tag string into the fixed 8-byte slot (idempotent).
pub fn game_tag8(tag: &str) -> [u8; 8] {
    let mut out = [0u8; 8];
    let b = tag.as_bytes();
    let n = if b.len() < 8 { b.len() } else { 8 };
    out[..n].copy_from_slice(&b[..n]);
    out
}

#[derive(Accounts)]
pub struct InitializeCoreCtx<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: the player wallet (seed basis for the PDA).
    pub player_authority: AccountInfo<'info>,
    #[account(
        init,
        payer = payer,
        space = 8 + PlayerCore::LEN,
        seeds = [CORE_SEED, player_authority.key().as_ref()],
        bump
    )]
    pub core: Account<'info, PlayerCore>,
    pub system_program: Program<'info, System>,
}

#[delegate]
#[derive(Accounts)]
pub struct DelegateCoreCtx<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: the player wallet (seed basis for the PDA).
    pub player_authority: AccountInfo<'info>,
    /// CHECK: the core PDA to delegate.
    #[account(mut, del)]
    pub core: UncheckedAccount<'info>,
}

#[commit]
#[derive(Accounts)]
pub struct CommitAndUndelegateCoreCtx<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: the player wallet (seed basis for the PDA).
    pub player_authority: AccountInfo<'info>,
    #[account(mut, seeds = [CORE_SEED, player_authority.key().as_ref()], bump)]
    pub core: Account<'info, PlayerCore>,
}

/// Record a per-game local award into the player's core bucket (gasless ER).
/// Payer is the sponsor/payer (relay); the credit lands on `player_authority`'s
/// bucket. Idempotent by match_ref (global last-match guard).
#[derive(Accounts)]
pub struct RecordCorePointsCtx<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: the player wallet authority (seed basis for the PDA).
    pub player_authority: AccountInfo<'info>,
    #[account(mut, seeds = [CORE_SEED, player_authority.key().as_ref()], bump)]
    pub core: Box<Account<'info, PlayerCore>>,
}

/// Credit the global ledgers into the player's core (gasless ER). kind 0 = win.
#[derive(Accounts)]
pub struct RecordCoreGlobalCtx<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: the player wallet authority (seed basis for the PDA).
    pub player_authority: AccountInfo<'info>,
    #[account(mut, seeds = [CORE_SEED, player_authority.key().as_ref()], bump)]
    pub core: Box<Account<'info, PlayerCore>>,
}

/// Spend from the core's global spendable balance (gasless ER).
#[derive(Accounts)]
pub struct SpendCoreGlobalCtx<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: the player wallet authority (seed basis for the PDA).
    pub player_authority: AccountInfo<'info>,
    #[account(mut, seeds = [CORE_SEED, player_authority.key().as_ref()], bump)]
    pub core: Box<Account<'info, PlayerCore>>,
}

/// Spend from the core's per-game local spendable bucket (gasless ER).
#[derive(Accounts)]
pub struct SpendCoreLocalCtx<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: the player wallet authority (seed basis for the PDA).
    pub player_authority: AccountInfo<'info>,
    #[account(mut, seeds = [CORE_SEED, player_authority.key().as_ref()], bump)]
    pub core: Box<Account<'info, PlayerCore>>,
}

/// Spend from the core's premium spendable balance (gasless ER).
#[derive(Accounts)]
pub struct SpendCorePremiumCtx<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: the player wallet authority (seed basis for the PDA).
    pub player_authority: AccountInfo<'info>,
    #[account(mut, seeds = [CORE_SEED, player_authority.key().as_ref()], bump)]
    pub core: Box<Account<'info, PlayerCore>>,
}

/// Migration (arcv2m3, 2026-09): fold the RETIRED per-game points ledger
/// [gfgpoints, game_tag, player] into the core bucket, then zero the source.
/// Permissionless (any payer may run it for any player) and idempotent (a
/// re-run copies zero). Runs on the ER so the write is gasless; both the core
/// and the legacy points PDA must be delegated.
#[derive(Accounts)]
#[instruction(game_tag: String)]
pub struct MigrateCoreBucketCtx<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: the player wallet authority (seed basis for both PDAs).
    pub player_authority: AccountInfo<'info>,
    #[account(mut, seeds = [CORE_SEED, player_authority.key().as_ref()], bump)]
    pub core: Box<Account<'info, PlayerCore>>,
    #[account(
        mut,
        seeds = [crate::POINTS, game_tag.as_bytes(), player_authority.key().as_ref()],
        bump
    )]
    pub legacy_points: Box<Account<'info, crate::PlayerPoints>>,
}

/// Migration: fold the RETIRED global ledger [gfgpoints, 'global', player] into
/// the core's globals, then zero the source. Permissionless + idempotent.
#[derive(Accounts)]
pub struct MigrateCoreGlobalCtx<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: the player wallet authority (seed basis for both PDAs).
    pub player_authority: AccountInfo<'info>,
    #[account(mut, seeds = [CORE_SEED, player_authority.key().as_ref()], bump)]
    pub core: Box<Account<'info, PlayerCore>>,
    #[account(
        mut,
        seeds = [crate::POINTS, crate::GLOBAL_TAG, player_authority.key().as_ref()],
        bump
    )]
    pub legacy_global: Box<Account<'info, crate::GlobalPoints>>,
}

/// Migration: fold the RETIRED premium ledger [gfgprem, player] into the core's
/// premium track, then zero the source balances. Permissionless + idempotent.
/// A v1/v2 premium account must be upgraded first (upgrade_premium_points_v3).
#[derive(Accounts)]
pub struct MigrateCorePremiumCtx<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: the player wallet authority (seed basis for both PDAs).
    pub player_authority: AccountInfo<'info>,
    #[account(mut, seeds = [CORE_SEED, player_authority.key().as_ref()], bump)]
    pub core: Box<Account<'info, PlayerCore>>,
    #[account(
        mut,
        seeds = [crate::PREMIUM_SEED, player_authority.key().as_ref()],
        bump
    )]
    pub legacy_premium: Box<Account<'info, crate::PremiumPoints>>,
}

/// Admin-gated premium credit + DIRECT plan/booster activation on the core. The
/// payer must equal the core's stored `admin_authority` (the sponsor relay),
/// which signs only after a verified payment.
#[derive(Accounts)]
pub struct CoreAdminCtx<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: the player wallet authority (seed basis for the PDA).
    pub player_authority: AccountInfo<'info>,
    #[account(mut, seeds = [CORE_SEED, player_authority.key().as_ref()], bump)]
    pub core: Box<Account<'info, PlayerCore>>,
}
