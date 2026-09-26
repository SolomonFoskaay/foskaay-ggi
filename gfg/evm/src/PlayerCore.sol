// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// PlayerCore — arcv2m16 Phase 2.
///
/// ONE account per player (a mapping keyed by address), holding EVERYTHING about
/// that player: lives, points (local per-game buckets + global ledgers),
/// premium, and the subscription or booster windows. This mirrors the Solana
/// Player Core account, so the platform never needs one on-chain account per
/// feature per game.
///
/// Gasless model: the player never signs or pays. The app's own relayer (the
/// adminAuthority, a self-hosted key with USDC) submits writes and pays the tiny
/// gas. Reads are public and free. No third-party paymaster is required.
contract PlayerCore {
    uint8 public constant MAX_BUCKETS = 24;
    uint64 public constant MAX_PREMIUM_CREDIT = 1_000_000;
    uint64 public constant MAX_PREMIUM_LIFETIME = 100_000_000;
    uint8 public constant MAX_PLAN_LEVEL = 3;
    uint64 public constant DAY = 86400;
    uint16 public constant DEFAULT_POOL = 5;

    /// Lives pool for a plan level (owner-approved ladder 2026-09-19):
    /// L0 free = 5, L1 = 10, L2 = 15, L3 = 20. One place, so migrate and
    /// activate can never drift apart.
    function _poolForLevel(uint8 level) internal pure returns (uint16) {
        if (level >= 3) return 20;
        if (level == 2) return 15;
        if (level == 1) return 10;
        return 5;
    }

    struct Bucket {
        bytes32 tag;       // game tag, e.g. "ludo"
        uint64 purePts;     // unspendable lifetime
        uint64 spendable;  // spendable balance
    }

    struct Player {
        // lives
        uint64 livesDay;
        uint16 livesUsed;
        uint16 livesPool;
        uint64 unlimitedUntil;
        uint64 boosterUntil;
        uint64 livesAwardCount;
        // global ledgers
        uint64 globalPure;      // M4a, never multiplied
        uint64 globalLifetime;  // M4b, everything earned
        uint64 globalSpendable; // M4c, spendable
        // premium
        uint64 premiumLifetime;
        uint64 premiumSpendable;
        uint8 subscriptionLevel;
        uint64 subscriptionActiveUntil;
        uint64 lastCreditRef;
        uint64 lastGlobalRef;
        // idempotency for the last award
        uint64 lastMatchRef;
        // migration idempotency (Solana -> Arc)
        uint64 migrationRef;
        // per-game buckets
        uint8 bucketCount;
        Bucket[MAX_BUCKETS] buckets;
        bool exists;
    }

    /// One-shot migration payload for moving a player's Solana balances to Arc.
    struct MigrationData {
        bytes32 tag;
        uint64 localPure;
        uint64 localSpendable;
        uint64 globalPure;
        uint64 globalLifetime;
        uint64 globalSpendable;
        uint64 premiumLifetime;
        uint64 premiumSpendable;
        uint8 level;
        uint64 activeUntil;
        uint64 migrationRef;
    }

    address public adminAuthority; // the self-hosted relayer
    mapping(address => Player) private _players;

    error NotAdmin();
    error NoLives();
    error Insufficient();
    error Overflow();
    error BucketsFull();
    error DuplicateRef();
    error BadLevel();
    error CreditTooLarge();
    error BadPoints();

    event LifeCharged(address indexed player, uint64 matchRef, bool unlimited);
    event PointsRecorded(address indexed player, bytes32 indexed tag, uint64 points, uint8 reason, uint64 matchRef);
    event GlobalRecorded(address indexed player, uint8 kind, uint64 points, uint64 matchRef);
    event LocalSpent(address indexed player, bytes32 indexed tag, uint64 amount);
    event GlobalSpent(address indexed player, uint64 amount);
    event PremiumCredited(address indexed player, uint64 points, uint64 creditRef);
    event PlanActivated(address indexed player, uint8 level, uint64 until);
    event BoosterActivated(address indexed player, uint64 until);
    event Migrated(address indexed player, uint64 migrationRef);
    event PlanExpired(address indexed player);
    event PoolUpdated(address indexed player, uint16 pool);

    constructor(address admin) {
        require(admin != address(0), "admin");
        adminAuthority = admin;
    }

    modifier onlyAdmin() {
        if (msg.sender != adminAuthority) revert NotAdmin();
        _;
    }

    // ---------------------------------------------------------------- internals

    function _p(address a) internal returns (Player storage p) {
        p = _players[a];
        if (!p.exists) {
            p.exists = true;
            p.livesPool = DEFAULT_POOL;
        }
    }

    function _find(Player storage p, bytes32 tag) internal view returns (uint256 i, bool found) {
        for (i = 0; i < p.bucketCount; i++) {
            if (p.buckets[i].tag == tag) return (i, true);
        }
        return (0, false);
    }

    function _ensure(Player storage p, bytes32 tag) internal returns (uint256 i) {
        bool found;
        (i, found) = _find(p, tag);
        if (found) return i;
        if (p.bucketCount >= MAX_BUCKETS) revert BucketsFull();
        i = p.bucketCount;
        p.buckets[i].tag = tag;
        p.bucketCount = uint8(i + 1);
    }

    // -------------------------------------------------------------------- lives

    /// Charge ONE life at game start. Unlimited while a booster or plan window is
    /// live. Idempotent by the day refill only, so a retry is safe.
    function chargeLife(address player, uint64 matchRef) external onlyAdmin {
        Player storage p = _p(player);
        uint64 nowTs = uint64(block.timestamp);
        if ((p.unlimitedUntil > nowTs) || (p.boosterUntil > nowTs)) {
            emit LifeCharged(player, matchRef, true);
            return;
        }
        uint64 day = nowTs / DAY;
        if (p.livesDay != day) {
            p.livesDay = day;
            p.livesUsed = 0;
        }
        if (p.livesUsed >= p.livesPool) revert NoLives();
        p.livesUsed += 1;
        p.livesAwardCount += 1;
        emit LifeCharged(player, matchRef, false);
    }

    // ------------------------------------------------------------------- points

    /// Bank a per-game award AND the global credits in one write (kind 0 = win).
    /// Idempotent by matchRef, so a replayed award is a clean no-op.
    function recordPoints(address player, bytes32 tag, uint64 points, uint8 reason, uint64 matchRef) external onlyAdmin {
        if (points == 0) revert BadPoints();
        Player storage p = _p(player);
        if (p.lastMatchRef == matchRef) revert DuplicateRef();
        uint256 i = _ensure(p, tag);
        p.buckets[i].purePts = _add(p.buckets[i].purePts, points);
        p.buckets[i].spendable = _add(p.buckets[i].spendable, points);
        p.globalPure = _add(p.globalPure, points);
        p.globalLifetime = _add(p.globalLifetime, points);
        p.globalSpendable = _add(p.globalSpendable, points);
        p.lastMatchRef = matchRef;
        emit PointsRecorded(player, tag, points, reason, matchRef);
    }

    /// Migration (Solana -> Arc): SET this player's balances from the source
    /// chain in one call. Admin-gated and idempotent by migrationRef, so a
    /// re-run for the same player is a clean no-op. Never adds to global twice.
    function migratePlayer(address player, MigrationData calldata m) external onlyAdmin {
        Player storage p = _p(player);
        require(m.migrationRef != 0, "ref");
        if (p.migrationRef == m.migrationRef) return; // already migrated: clean no-op
        uint256 i = _ensure(p, m.tag);
        p.buckets[i].purePts = m.localPure;
        p.buckets[i].spendable = m.localSpendable;
        p.globalPure = m.globalPure;
        p.globalLifetime = m.globalLifetime;
        p.globalSpendable = m.globalSpendable;
        p.premiumLifetime = m.premiumLifetime;
        p.premiumSpendable = m.premiumSpendable;
        if (m.level > 0 && m.level <= MAX_PLAN_LEVEL) {
            p.subscriptionLevel = m.level;
            p.subscriptionActiveUntil = m.activeUntil;
            p.livesPool = _poolForLevel(m.level);
        }
        p.migrationRef = m.migrationRef;
        emit Migrated(player, m.migrationRef);
    }

    /// kind 0 = game win (all three tracks); kind 1 = other sources (lifetime +
    /// spendable only, so pure is never inflated).
    function recordGlobal(address player, uint8 kind, uint64 points, uint64 matchRef) external onlyAdmin {
        if (points == 0) revert BadPoints();
        if (kind > 1) revert BadLevel();
        Player storage p = _p(player);
        if (p.lastGlobalRef == matchRef) revert DuplicateRef();
        if (kind == 0) p.globalPure = _add(p.globalPure, points);
        p.globalLifetime = _add(p.globalLifetime, points);
        p.globalSpendable = _add(p.globalSpendable, points);
        p.lastGlobalRef = matchRef;
        emit GlobalRecorded(player, kind, points, matchRef);
    }

    function spendLocal(address player, bytes32 tag, uint64 amount) external onlyAdmin {
        Player storage p = _p(player);
        (uint256 i, bool found) = _find(p, tag);
        if (!found) revert Insufficient();
        if (p.buckets[i].spendable < amount) revert Insufficient();
        p.buckets[i].spendable -= amount;
        emit LocalSpent(player, tag, amount);
    }

    function spendGlobal(address player, uint64 amount) external onlyAdmin {
        Player storage p = _p(player);
        if (p.globalSpendable < amount) revert Insufficient();
        p.globalSpendable -= amount;
        emit GlobalSpent(player, amount);
    }

    // ------------------------------------------------------------------ premium

    function creditPremium(address player, uint64 points, uint64 creditRef) external onlyAdmin {
        if (points == 0 || points > MAX_PREMIUM_CREDIT) revert CreditTooLarge();
        Player storage p = _p(player);
        if (p.lastCreditRef == creditRef) revert DuplicateRef();
        p.premiumLifetime = _add(p.premiumLifetime, points);
        if (p.premiumLifetime > MAX_PREMIUM_LIFETIME) revert CreditTooLarge();
        p.premiumSpendable = _add(p.premiumSpendable, points);
        p.lastCreditRef = creditRef;
        emit PremiumCredited(player, points, creditRef);
    }

    function activatePlan(address player, uint8 level, uint16 planDays) external onlyAdmin {
        if (level == 0 || level > MAX_PLAN_LEVEL) revert BadLevel();
        Player storage p = _p(player);
        uint64 until = uint64(block.timestamp) + uint64(planDays) * DAY;
        p.subscriptionLevel = level;
        p.subscriptionActiveUntil = until;
        p.livesPool = _poolForLevel(level);
        emit PlanActivated(player, level, until);
    }

    function activateBooster(address player, uint16 planHours) external onlyAdmin {
        Player storage p = _p(player);
        uint64 until = uint64(block.timestamp) + uint64(planHours) * 3600;
        if (until > p.boosterUntil) p.boosterUntil = until;
        emit BoosterActivated(player, until);
    }

    /// PERMISSIONLESS upkeep: bring a player's on-chain state in line with the
    /// chain clock and the current plan ladder. Anyone may call it for any
    /// player; it:
    ///   - expires a plan whose 30-day window has passed (level -> 0), so the
    ///     boost and the bigger lives pool stop automatically (no cron needed);
    ///   - re-derives the lives pool from the (possibly just-expired) level.
    /// Idempotent and safe to re-run. NEVER touches points or premium balances.
    function upkeep(address player) external {
        Player storage p = _p(player);
        if (p.subscriptionLevel != 0 && p.subscriptionActiveUntil != 0 && p.subscriptionActiveUntil <= block.timestamp) {
            p.subscriptionLevel = 0;
            p.subscriptionActiveUntil = 0;
            emit PlanExpired(player);
        }
        uint16 want = p.subscriptionLevel == 0 ? DEFAULT_POOL : _poolForLevel(p.subscriptionLevel);
        if (p.livesPool != want) {
            p.livesPool = want;
            emit PoolUpdated(player, want);
        }
    }

    // -------------------------------------------------------------------- reads

    function livesOf(address a) external view returns (uint16 used, uint16 pool, uint64 boosterUntil, uint64 livesDay) {
        Player storage p = _players[a];
        return (p.livesUsed, p.livesPool, p.boosterUntil, p.livesDay);
    }

    function globalsOf(address a) external view returns (uint64 purePts, uint64 lifetime, uint64 spendable) {
        Player storage p = _players[a];
        return (p.globalPure, p.globalLifetime, p.globalSpendable);
    }

    function premiumOf(address a) external view returns (uint64 lifetime, uint64 spendable, uint8 level, uint64 activeUntil) {
        Player storage p = _players[a];
        return (p.premiumLifetime, p.premiumSpendable, p.subscriptionLevel, p.subscriptionActiveUntil);
    }

    function bucketOf(address a, bytes32 tag) external view returns (uint64 purePts, uint64 spendable) {
        Player storage p = _players[a];
        (uint256 i, bool found) = _find(p, tag);
        if (!found) return (0, 0);
        return (p.buckets[i].purePts, p.buckets[i].spendable);
    }

    function _add(uint64 a, uint64 b) internal pure returns (uint64) {
        uint64 c = a + b;
        if (c < a) revert Overflow();
        return c;
    }
}
