// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts/access/OwnableUpgradeable.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @title FoskaayGGI — the SINGLE, non-opinionated core of Foskaay GGI.
///
/// @notice The session rail. It knows NOTHING about any game: it takes a
/// dev-declared list of accounts (ANY count), charges ONE fee at connect, records
/// a committable session, and settles once. It never learns game, player, points,
/// board, seats or dice. Everything inside a session runs in the Foskaay GGI
/// Midchain for FREE (moves, dice, computer turns, point credits); only connect
/// and settle are transactions.
///
/// @notice FEE (unbypassable, charged at connect ONLY): a base + a per-account fee
/// + a per-game fee. The base and per-account parts are charged ONCE per session;
/// only the per-game part grows with batching. The fee is forwarded straight to
/// `destination` in the same transaction, and the ONE storage write at connect
/// (`commitments[sessionId]`) is BOTH the paid flag and the seed/participant
/// commitment, so a session cannot start unpaid and cannot settle unless it paid.
///
/// @notice FREE RANDOMNESS: `random`/`randomN` are pure, so dice/cards/loot cost
/// nothing via eth_call. The game derives them from the committed seed.
///
/// @dev OPENZEPPELIN ONLY: UUPS + Initializable + Ownable for upgrades, ECDSA for
///      signature recovery (rejects malleable/malformed signatures).
///
/// @dev UPGRADEABLE (UUPS). Storage is APPEND-ONLY: new variables consume from the
///      top of `__gap`, which shrinks by the same count. `version` marks changes.
contract FoskaayGGI is Initializable, UUPSUpgradeable, OwnableUpgradeable {
    /// Where the fee goes (the project treasury). A direct transfer, no vault.
    address public destination;

    /// LEGACY single fee for the plain `handover`/`handoverMany` (kept as-is).
    uint256 public fee;

    /// The session fee: base + per-account + per-game, all charged at connect.
    uint256 public feeBase;
    uint256 public feePerAccount;
    uint256 public feePerGame;

    /// Monotonic session counter. Emitted in Handover for off-chain indexing.
    uint64 public sessionCounter;

    /// sessionId => commitment = keccak256(abi.encode(seedCommit, players, sessionKeys)).
    /// NON-ZERO means "paid and connected". Binds the randomness commitment AND the
    /// exact player/session-key set, so a stranger cannot settle with their own key.
    mapping(bytes32 => bytes32) public commitments;

    /// sessionId => settled. Blocks a second settle of the same session.
    mapping(bytes32 => bool) public settled;

    /// sessionId => the accounts the DEV declared to lift (ANY count). The core
    /// NEVER interprets the list; it only records it so a settle can commit the
    /// right set. This is the generic hook a game uses to bring its own accounts
    /// (game, player, points, ...) into one session.
    mapping(bytes32 => address[]) public liftedAccounts;

    /// sessionId => the number of games this session will cover (the dev's
    /// declared count). Used only for the per-game fee; the core never learns what
    /// a "game" is.
    mapping(bytes32 => uint16) public sessionGames;

    /// Layout marker. This fresh core is version 2.
    uint8 public version;

    /// Reserved slots for future variables. Consume from the top, shrink by the
    /// same count. DO NOT reorder or remove.
    uint256[20] private __gap;

    event Handover(
        bytes32 indexed sessionId,
        address indexed gameLogic,
        bytes32 startHash,
        bytes32 seedCommit,
        address[] players,
        address[] sessionKeys,
        uint16 randomCount,
        address indexed payer,
        uint64 counter
    );
    event Settled(bytes32 indexed sessionId, bytes32 finalHash, bytes32 seedReveal, address indexed payer);
    event FeeSet(uint256 fee);
    event FeesSet(uint256 feeBase, uint256 feePerAccount, uint256 feePerGame);
    event DestinationSet(address destination);

    error BadFee();
    error BadInput();
    error FeeNotPaid();
    error BadSignature();
    error BadReveal();
    error AlreadySettled();
    error ZeroAddress();
    error TransferFailed();

    /// @notice Initialize the proxy.
    /// @param owner_ the upgrade/config owner (the project owner).
    /// @param destination_ where fees are sent (the treasury).
    /// @param fee_ legacy single fee for `handover` (native USDC wei).
    /// @param feeBase_ session base fee.
    /// @param feePerAccount_ fee per lifted account.
    /// @param feePerGame_ fee per game in the session.
    function initialize(
        address owner_,
        address destination_,
        uint256 fee_,
        uint256 feeBase_,
        uint256 feePerAccount_,
        uint256 feePerGame_
    ) external initializer {
        if (owner_ == address(0) || destination_ == address(0)) revert ZeroAddress();
        __Ownable_init(owner_);
        destination = destination_;
        fee = fee_;
        feeBase = feeBase_;
        feePerAccount = feePerAccount_;
        feePerGame = feePerGame_;
        version = 2;
        emit DestinationSet(destination_);
        emit FeeSet(fee_);
        emit FeesSet(feeBase_, feePerAccount_, feePerGame_);
    }

    /// @dev The implementation contract can never be used directly.
    constructor() {
        _disableInitializers();
    }

    /// @dev Only the owner may authorize an upgrade.
    function _authorizeUpgrade(address) internal override onlyOwner {}

    function setFee(uint256 fee_) external onlyOwner {
        fee = fee_;
        emit FeeSet(fee_);
    }

    /// @notice Set the three session-fee parts (native USDC wei).
    function setFees(uint256 feeBase_, uint256 feePerAccount_, uint256 feePerGame_) external onlyOwner {
        feeBase = feeBase_;
        feePerAccount = feePerAccount_;
        feePerGame = feePerGame_;
        emit FeesSet(feeBase_, feePerAccount_, feePerGame_);
    }

    function setDestination(address destination_) external onlyOwner {
        if (destination_ == address(0)) revert ZeroAddress();
        destination = destination_;
        emit DestinationSet(destination_);
    }

    // ------------------------------------------------------------- connect

    /// @notice LEGACY connect: pay the single `fee`. Kept exactly as before.
    function handover(
        bytes32 sessionId,
        address gameLogic,
        bytes32 startHash,
        bytes32 seedCommit,
        address[] calldata players,
        address[] calldata sessionKeys,
        uint16 randomCount
    ) external payable {
        if (players.length == 0 || players.length != sessionKeys.length) revert BadInput();
        if (msg.value != fee) revert BadFee();
        if (commitments[sessionId] != bytes32(0)) revert BadInput();
        commitments[sessionId] = _commitment(seedCommit, players, sessionKeys);
        sessionCounter += 1;
        _pay(msg.value);
        emit Handover(sessionId, gameLogic, startHash, seedCommit, players, sessionKeys, randomCount, msg.sender, sessionCounter);
    }

    /// @notice LEGACY connect MANY sessions in ONE transaction (single `fee` each).
    function handoverMany(
        bytes32[] calldata sessionIds,
        address gameLogic,
        bytes32[] calldata startHashes,
        bytes32[] calldata seedCommits_,
        address[][] calldata players,
        address[][] calldata sessionKeys,
        uint16 randomCount
    ) external payable {
        uint256 n = sessionIds.length;
        if (n == 0 || n != startHashes.length || n != seedCommits_.length || n != players.length || n != sessionKeys.length) revert BadInput();
        if (msg.value != fee * n) revert BadFee();
        for (uint256 i = 0; i < n; i++) {
            if (players[i].length == 0 || players[i].length != sessionKeys[i].length) revert BadInput();
            if (commitments[sessionIds[i]] != bytes32(0)) revert BadInput();
            commitments[sessionIds[i]] = _commitment(seedCommits_[i], players[i], sessionKeys[i]);
            emit Handover(sessionIds[i], gameLogic, startHashes[i], seedCommits_[i], players[i], sessionKeys[i], randomCount, msg.sender, sessionCounter + uint64(i));
        }
        sessionCounter += uint64(n);
        _pay(msg.value);
    }

    /// @notice Connect a session, record the DEV-declared accounts (ANY count) and
    ///         the number of games. Charges, ONCE, the full session fee:
    ///         feeBase + feePerAccount * accounts.length + feePerGame * games.
    ///         Nothing else is charged: everything inside the Foskaay GGI Midchain
    ///         (moves, dice, point credits, computer turns) is free.
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
    ) external payable {
        if (players.length == 0 || players.length != sessionKeys.length) revert BadInput();
        uint256 required = feeBase + feePerAccount * accounts.length + feePerGame * uint256(games);
        if (msg.value != required) revert BadFee();
        if (commitments[sessionId] != bytes32(0)) revert BadInput();
        commitments[sessionId] = _commitment(seedCommit, players, sessionKeys);
        liftedAccounts[sessionId] = accounts;   // ANY count, the dev's choice
        sessionGames[sessionId] = games;        // the declared game count
        sessionCounter += 1;
        _pay(msg.value);
        emit Handover(sessionId, gameLogic, startHash, seedCommit, players, sessionKeys, randomCount, msg.sender, sessionCounter);
    }

    /// @notice The accounts the dev declared for a session (0..N).
    function sessionAccounts(bytes32 sessionId) external view returns (address[] memory) {
        return liftedAccounts[sessionId];
    }

    /// @notice Owner-only layout marker bump.
    function setVersion(uint8 v) external onlyOwner {
        version = v;
    }

    // -------------------------------------------------------------- settle

    function settle(
        bytes32 sessionId,
        bytes32 finalHash,
        bytes32 seedReveal,
        address[] calldata players,
        address[] calldata sessionKeys,
        bytes[] calldata sigs,
        address[] calldata signers
    ) external {
        _settleOne(sessionId, finalHash, seedReveal, players, sessionKeys, sigs, signers);
    }

    function settleMany(
        bytes32[] calldata sessionIds,
        bytes32[] calldata finalHashes,
        bytes32[] calldata seedReveals,
        address[][] calldata players,
        address[][] calldata sessionKeys,
        bytes[][] calldata sigs,
        address[][] calldata signers
    ) external {
        uint256 n = sessionIds.length;
        if (n == 0 || n != finalHashes.length || n != seedReveals.length || n != players.length || n != sessionKeys.length || n != sigs.length || n != signers.length) revert BadInput();
        for (uint256 i = 0; i < n; i++) {
            _settleOne(sessionIds[i], finalHashes[i], seedReveals[i], players[i], sessionKeys[i], sigs[i], signers[i]);
        }
    }

    function _settleOne(
        bytes32 sessionId,
        bytes32 finalHash,
        bytes32 seedReveal,
        address[] calldata players,
        address[] calldata sessionKeys,
        bytes[] calldata sigs,
        address[] calldata signers
    ) private {
        bytes32 stored = commitments[sessionId];
        if (stored == bytes32(0)) revert FeeNotPaid();
        bytes32 seedCommit = keccak256(abi.encodePacked(seedReveal));
        if (_commitment(seedCommit, players, sessionKeys) != stored) revert BadReveal();
        if (settled[sessionId]) revert AlreadySettled();
        uint256 n = signers.length;
        if (n == 0 || n != sigs.length) revert BadInput();
        bytes32 digest = midchainDigest(sessionId, finalHash);
        for (uint256 i = 0; i < n; i++) {
            if (ECDSA.recover(digest, sigs[i]) != signers[i]) revert BadSignature();
        }
        settled[sessionId] = true;
        emit Settled(sessionId, finalHash, seedReveal, msg.sender);
    }

    // ---------------------------------------------------------------- reads

    function midchainDigest(bytes32 sessionId, bytes32 finalHash) public view returns (bytes32) {
        return keccak256(abi.encodePacked("FoskaayGGI", block.chainid, address(this), sessionId, finalHash));
    }

    function isPaid(bytes32 sessionId) external view returns (bool) {
        return commitments[sessionId] != bytes32(0);
    }

    // ------------------------------------------------------- free randomness

    function random(bytes32 seed, uint256 counter) public pure returns (bytes32) {
        return keccak256(abi.encode(seed, counter));
    }

    function randomN(bytes32 seed, uint256 counter, uint256 count) public pure returns (bytes32[] memory out) {
        out = new bytes32[](count);
        for (uint256 i = 0; i < count; i++) {
            out[i] = keccak256(abi.encode(seed, counter, i));
        }
    }

    // ------------------------------------------------------------- internal

    function _commitment(bytes32 seedCommit, address[] calldata players, address[] calldata sessionKeys) private pure returns (bytes32) {
        return keccak256(abi.encode(seedCommit, players, sessionKeys));
    }

    function _pay(uint256 amount) private {
        (bool ok, ) = payable(destination).call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}
