// @foskaay/ggi-contracts-sdk — Solidity interfaces for Foskaay Gasless Games Infrastructure (Foskaay GGI).
//
// Foskaay GGI is ONE core contract (FoskaayGGI), plus the game and player
// contracts a dev deploys. Import this package (or copy this interface) and call
// it directly. Nothing here is opinionated: no account layout, no commit cadence,
// no game concept. The rail never learns your game.

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// THE CORE: the room. Connect a session (paying the fee), settle the result,
/// and get free pure randomness. Every move inside runs off-chain for free.
/// The fee is built in (base + per lifted account + per game) and forwarded
/// straight to `destination` in the same transaction, so a session cannot start
/// unpaid and cannot settle unless it paid.
interface IFoskaayGGI {
    /// Connect a session. `msg.value` must equal the legacy single fee; it is
    /// forwarded to `destination` in this same transaction.
    function handover(
        bytes32 sessionId,
        address gameLogic,
        bytes32 startHash,
        bytes32 seedCommit,
        address[] calldata players,
        address[] calldata sessionKeys,
        uint16 randomCount
    ) external payable;

    /// Connect MANY sessions in one transaction (msg.value = fee x count).
    function handoverMany(
        bytes32[] calldata sessionIds,
        address gameLogic,
        bytes32[] calldata startHashes,
        bytes32[] calldata seedCommits,
        address[][] calldata players,
        address[][] calldata sessionKeys,
        uint16 randomCount
    ) external payable;

    /// Connect a session, recording the DEV-declared accounts (ANY count) and
    /// the number of games. `msg.value` must equal
    /// feeBase + feePerAccount * accounts.length + feePerGame * games.
    function handoverWithAccounts(
        bytes32 sessionId,
        address gameLogic,
        bytes32 startHash,
        bytes32 seedCommit,
        address[] calldata players,
        address[] calldata sessionKeys,
        uint16 randomCount,
        address[] calldata accounts,
        uint16 games
    ) external payable;

    /// Settle ONE session: every declared signer must have signed
    /// (sessionId, finalHash). `finalHash` may be one game's final hash or a
    /// whole session's Merkle root. Refused unless the session was paid.
    function settle(
        bytes32 sessionId,
        bytes32 finalHash,
        bytes32 seedReveal,
        bytes[] calldata sigs,
        address[] calldata signers
    ) external;

    /// Settle MANY sessions in one transaction.
    function settleMany(
        bytes32[] calldata sessionIds,
        bytes32[] calldata finalHashes,
        bytes32[] calldata seedReveals,
        bytes[][] calldata sigs,
        address[][] calldata signers
    ) external;

    /// The exact digest a participant signs to authorise a settlement. Bound to
    /// this contract and chain, so a signature cannot be replayed elsewhere.
    function midchainDigest(bytes32 sessionId, bytes32 finalHash) external view returns (bytes32);

    /// FREE randomness: keccak(seed, counter), computed via eth_call at no cost.
    function random(bytes32 seed, uint256 counter) external pure returns (bytes32);

    /// FREE randomness: N seeds in one call.
    function randomN(bytes32 seed, uint256 counter, uint256 count) external pure returns (bytes32[] memory);

    /// The legacy single fee used by `handover`/`handoverMany` (native USDC wei).
    function fee() external view returns (uint256);

    /// The 3-part session fee used by `handoverWithAccounts`: base + per lifted
    /// account + per game, all charged at connect.
    function feeBase() external view returns (uint256);
    function feePerAccount() external view returns (uint256);
    function feePerGame() external view returns (uint256);

    /// Where the fee goes (the treasury). A direct transfer, no vault.
    function destination() external view returns (address);

    /// The upgrade/config owner.
    function owner() external view returns (address);
}

/// DEPRECATED (kept for reference): the earlier separate cashier. The FeeVault was
/// merged into FoskaayGGI, which forwards the fee straight to `destination`, so
/// there is no separate vault to deploy or wire.
interface IFeeVault {
    /// Record one paid session. Only the SessionRegistry may call it; msg.value
    /// must equal the fee. Normally reached through SessionRegistry.handover.
    function deposit(bytes32 sessionId) external payable;

    /// Record MANY paid sessions in one call (msg.value = fee x count).
    function depositMany(bytes32[] calldata sessionIds) external payable;

    /// Withdraw all collected native USDC to the destination (owner only).
    function withdraw() external;

    /// The per-session fee, in native USDC base units (18 decimals on Arc).
    function fee() external view returns (uint256);

    /// Whether a session was paid at connect.
    function paid(bytes32 sessionId) external view returns (bool);

    /// Same as `paid`, named for readability.
    function paymentOf(bytes32 sessionId) external view returns (bool);

    /// The only contract allowed to record a payment (the SessionRegistry).
    function sessionRegistry() external view returns (address);

    /// Native USDC collected and withdrawable.
    function collected() external view returns (uint256);

    /// Where withdrawals go.
    function destination() external view returns (address);

    /// The config owner.
    function owner() external view returns (address);
}

/// THE GAME: the developer's own game contract (FoskaayGGIGames for Ludo). It
/// holds the match on-chain plus the game's rules, and its `settle` writes N games
/// in ONE transaction and credits the player account in the same step.
interface IFoskaayGGIGames {
    struct Game {
        uint8 turn;
        uint8 seats;
        uint32 step;
        bytes board;
        bytes32 boardHash;
        bool over;
    }

    /// The player account this game credits (FoskaayGGIPlayers).
    function players() external view returns (address);

    /// How many games a session has committed.
    function gameCount(bytes32 sessionId) external view returns (uint256);

    /// All committed games of a session (the board bytes are stored on-chain at
    /// settle, so any device can rebuild them with no relay memory).
    function gamesOf(bytes32 sessionId) external view returns (Game[] memory);

    /// The indices of a player's games inside a session (persistent-gameplay
    /// index). Pair with gamesOf(sessionId) to rebuild that player's boards.
    function playerGamesOf(bytes32 sessionId, address player) external view returns (uint32[] memory);

    /// Commit N games in one transaction and credit the players in the same step.
    /// `seatPlayers` maps seat => player (length must equal each game's seats).
    function settle(bytes32 sessionId, Game[] calldata list, address[] calldata seatPlayers, bytes32 gameTag)
        external
        returns (uint256 credited);
}

/// THE PLAYER ACCOUNT: one per player for every game (FoskaayGGIPlayers). Holds
/// points, lives and a record per game tag. Only its game may write it.
interface IFoskaayGGIPlayers {
    /// The game contract allowed to write this account.
    function game() external view returns (address);

    function pointsOf(address player, bytes32 gameTag) external view returns (uint64);
    function livesOf(address player, bytes32 gameTag) external view returns (uint64);
    function recordOf(address player, bytes32 gameTag) external view returns (uint64 played, uint64 wins, uint64 best);
}
