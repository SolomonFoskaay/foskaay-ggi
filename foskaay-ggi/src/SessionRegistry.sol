// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts/access/OwnableUpgradeable.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @title SessionRegistry — the SINGLE core of Foskaay GGI.
///
/// @notice ONE contract (the FeeVault is merged in; there is no second core).
/// A game connects once (paying the fee, which is transferred straight to the
/// destination), plays every move for free, and settles once. It knows NOTHING
/// about any game: no board, token, seat or dice. The game state is opaque bytes.
///
/// @notice THE MIDCHAIN: `random`/`randomN` are pure, so dice, cards and loot
/// cost nothing via eth_call. Moves run in the GAME's own pure functions via
/// eth_call, signed with the session keys into a hash chain; only handover and
/// settle are real transactions (2 per session, not 200).
///
/// @notice FEE, UNBYPASSABLE: `handover` is payable and requires exactly the fee,
/// forwarding it to `destination` in the SAME transaction. The ONE storage write
/// at connect (`commitments[sessionId]`) is BOTH the paid flag and the committed
/// randomness/participant commitment, so a session cannot start unpaid and cannot
/// be settled unless it connected.
///
/// @dev OPENZEPPELIN ONLY: UUPS + Initializable + Ownable for upgrades, ECDSA for
///      signature recovery (rejects malleable/malformed signatures).
///
/// @dev UPGRADEABLE (UUPS). Storage is APPEND-ONLY: new variables go at the top of
///      `__gap`, which shrinks by the same count. `version` marks layout changes.
///
/// @dev GAS TARGET: connect ~50k gas + settle ~35k gas + the fee = about $1/1000
///      at Arc mainnet gas (5-10 Gwei) unbatched; `handoverMany`/`settleMany`
///      amortize the 21k base tx and go well under $1/1000.
contract SessionRegistry is Initializable, UUPSUpgradeable, OwnableUpgradeable {
    /// Where the fee goes (the project treasury). A direct transfer, no vault.
    address public destination;

    /// Fee for a single session in native USDC wei (Arc USDC is 18dp). ONE fee:
    /// batching a session with MANY games only saves gas (the 21k base tx is
    /// shared), never changes this fee.
    uint256 public fee;

    /// RESERVED (unused): kept only so the storage layout stays append-only for
    /// the in-place upgrade. Do not add a second tier; batching lowers GAS, not
    /// the fee per game.
    uint256 public reservedFeeSlot;

    /// Monotonic session counter. Emitted in Handover for off-chain indexing.
    uint64 public sessionCounter;

    /// sessionId => commitment = keccak256(abi.encode(seedCommit, players, sessionKeys)).
    /// A NON-ZERO value means "paid and connected". It binds the randomness
    /// commitment AND the exact player/session-key set, so:
    ///   - settle can prove the revealed seed is the one committed at connect, and
    ///   - a stranger cannot settle with their own key (the signer set is bound).
    mapping(bytes32 => bytes32) public commitments;

    /// sessionId => settled. Blocks a second settle of the same session.
    mapping(bytes32 => bool) public settled;

    /// Layout marker. Bump only on a layout change.
    uint8 public version;

    /// Reserved slots for future variables. Consume from the top, shrink by the
    /// same count. DO NOT reorder or remove.
    uint256[20] private __gap;

    /// The connect event. Carries the game link and committed seed so the Explorer
    /// can index it from eth_getLogs with no backend and no extra tx.
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

    /// The settle event. `finalHash` commits to the whole game (board AND points);
    /// `seedReveal` opens the seed committed at connect.
    event Settled(bytes32 indexed sessionId, bytes32 finalHash, bytes32 seedReveal, address indexed payer);
    event FeeSet(uint256 fee);
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
    /// @param fee_ unbatched fee (native USDC wei). Batched defaults to the same.
    function initialize(address owner_, address destination_, uint256 fee_) external initializer {
        if (owner_ == address(0) || destination_ == address(0)) revert ZeroAddress();
        __Ownable_init(owner_);
        destination = destination_;
        fee = fee_;
        emit DestinationSet(destination_);
        emit FeeSet(fee_);
    }

    /// @dev The implementation contract can never be used directly.
    constructor() {
        _disableInitializers();
    }

    /// @dev Only the owner may authorize an upgrade. Move to a timelock/multisig
    ///      before mainnet.
    function _authorizeUpgrade(address) internal override onlyOwner {}

    function setFee(uint256 fee_) external onlyOwner {
        fee = fee_;
        emit FeeSet(fee_);
    }

    function setDestination(address destination_) external onlyOwner {
        if (destination_ == address(0)) revert ZeroAddress();
        destination = destination_;
        emit DestinationSet(destination_);
    }

    // ------------------------------------------------------------- connect

    /// @notice Connect a session and pay the fee. `msg.value` must equal `fee`.
    ///         The fee is forwarded to `destination` in this same transaction.
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
        if (commitments[sessionId] != bytes32(0)) revert BadInput(); // already connected
        commitments[sessionId] = _commitment(seedCommit, players, sessionKeys);
        sessionCounter += 1;
        _pay(msg.value);
        emit Handover(sessionId, gameLogic, startHash, seedCommit, players, sessionKeys, randomCount, msg.sender, sessionCounter);
    }

    /// @notice Connect MANY sessions in ONE transaction at the batched fee.
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

    // -------------------------------------------------------------- settle

    /// @notice Settle one session. Requires: it connected (paid), the revealed
    ///         seed matches the commitment, it is not already settled, and every
    ///         declared session key signed (sessionId, finalHash). Emits the
    ///         result; the game's points are inside `finalHash` (midchain), so no
    ///         extra storage is written for them.
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

    /// @notice Settle MANY sessions in ONE transaction (batched cadence).
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

    /// @dev One settle, factored out so settleMany stays within the stack limit.
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
        if (stored == bytes32(0)) revert FeeNotPaid();      // never connected / unpaid
        // Rebuild the commitment from the reveal + the exact participant sets.
        bytes32 seedCommit = keccak256(abi.encodePacked(seedReveal));
        if (_commitment(seedCommit, players, sessionKeys) != stored) revert BadReveal();
        if (settled[sessionId]) revert AlreadySettled();
        uint256 n = signers.length;
        if (n == 0 || n != sigs.length) revert BadInput();
        bytes32 digest = midchainDigest(sessionId, finalHash);
        for (uint256 i = 0; i < n; i++) {
            // OpenZeppelin ECDSA.recover rejects malleable/malformed signatures.
            if (ECDSA.recover(digest, sigs[i]) != signers[i]) revert BadSignature();
        }
        settled[sessionId] = true;
        emit Settled(sessionId, finalHash, seedReveal, msg.sender);
    }

    // ---------------------------------------------------------------- reads

    /// @notice The exact digest a session key signs to authorise a settlement.
    ///         Bound to this contract and chain, so it cannot be replayed.
    function midchainDigest(bytes32 sessionId, bytes32 finalHash) public view returns (bytes32) {
        return keccak256(abi.encodePacked("FoskaayGGI", block.chainid, address(this), sessionId, finalHash));
    }

    /// @notice True once a session connected and paid.
    function isPaid(bytes32 sessionId) external view returns (bool) {
        return commitments[sessionId] != bytes32(0);
    }

    // ------------------------------------------------------- free randomness

    /// @notice One free random seed: keccak(seed, counter). Pure, costs nothing
    ///         via eth_call. The game derives dice/cards/loot from it.
    function random(bytes32 seed, uint256 counter) public pure returns (bytes32) {
        return keccak256(abi.encode(seed, counter));
    }

    /// @notice N free random seeds in one call. Pure and free.
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
