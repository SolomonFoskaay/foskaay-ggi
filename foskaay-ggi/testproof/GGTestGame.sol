// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts/access/OwnableUpgradeable.sol";

interface IGGTestPlayer {
    function credit(address player, bytes32 gameTag, uint64 amount) external;
}

interface IFoskaayGGISettle {
    function settle(
        bytes32 sessionId,
        bytes32 finalHash,
        bytes32 seedReveal,
        address[] calldata players,
        address[] calldata sessionKeys,
        bytes[] calldata sigs,
        address[] calldata signers
    ) external;
}
/// @title GGTestGame — PROOF-ONLY game account. It HOLDS the match ON ARC (real
///        state, the source of truth). UUPS upgradeable.
///
/// @dev This is the test artifact for the "game + player in one session, they
///      communicate, settle commits both" measurement. It is NOT the final Ludo.
///
///      - `apply(...)` is a PURE step: the Foskaay GGI Midchain runs it for free
///        (via eth_call) with no base-chain write.
///      - `commitAndCredit(...)` is the SETTLE write: it stores the final match
///        AND credits the player account IN THE SAME TRANSACTION, proving the two
///        on-chain accounts talk to each other.
///      - `commitCreditAndSettle(...)` does the same AND calls the generic core's
///        `settle`, so ONE transaction commits both accounts and closes the
///        session.
contract GGTestGame is Initializable, UUPSUpgradeable, OwnableUpgradeable {
    struct Match {
        uint8 turn;
        uint32 moveCount;
        bytes32 finalHash;
        uint64 committedAt;
        bool over;
    }

    /// sessionId => the committed match (the on-chain source of truth).
    mapping(bytes32 => Match) public matches;

    /// BATCH proof: sessionId => gameIndex => match, so one session can commit
    /// MANY matches (many games) while the accounts are lifted only once.
    mapping(bytes32 => mapping(uint256 => Match)) public matchAt;
    mapping(bytes32 => uint32) public matchCount;

    uint8 public version;
    uint256[20] private __gap;

    event MatchCommitted(bytes32 indexed sessionId, uint32 moveCount, bytes32 finalHash);

    function initialize(address owner_) external initializer {
        __Ownable_init(owner_);
    }

    constructor() {
        _disableInitializers();
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}

    /// @notice A FREE midchain step (pure, no storage): the game's rules run here
    ///         with no base-chain cost. The relay hash-chains the returned state.
    function step(uint8 turn, uint32 moveCount, bytes32 stateHash, uint8 action)
        public
        pure
        returns (uint8 newTurn, uint32 newCount, bytes32 newHash)
    {
        newTurn = uint8((uint256(turn) + 1) % 2);
        newCount = moveCount + 1;
        newHash = keccak256(abi.encodePacked(turn, moveCount, stateHash, action));
    }

    /// @notice SETTLE the match on-chain AND credit the player, in ONE tx, so the
    ///         two accounts demonstrably communicate. The points are derived from
    ///         the committed match (a read of this contract) before the write to
    ///         the player account.
    function commitAndCredit(
        bytes32 sessionId,
        uint32 moveCount,
        bytes32 finalHash,
        address playerAccount,
        address player,
        bytes32 gameTag
    ) external {
        Match storage m = matches[sessionId];
        m.turn = 0;
        m.moveCount = moveCount;
        m.finalHash = finalHash;
        m.committedAt = uint64(block.timestamp);
        m.over = true;
        // READ the match we just wrote, then WRITE the player, in the same step.
        uint64 points = m.over ? 100 : 0;
        emit MatchCommitted(sessionId, moveCount, finalHash);
        if (points > 0) IGGTestPlayer(playerAccount).credit(player, gameTag, points);
    }

    /// @notice BATCH: commit N games in ONE settle, with the SAME two lifted
    ///         accounts. The accounts are lifted once; the N games are only
    ///         writes. Points for all N credit the player once (pointsPerGame*N).
    function commitManyAndCredit(
        bytes32 sessionId,
        uint32 n,
        address playerAccount,
        address player,
        bytes32 gameTag,
        uint64 pointsPerGame
    ) external {
        for (uint256 i = 0; i < n; i++) {
            matchAt[sessionId][i] = Match({
                turn: 0,
                moveCount: uint32(i),
                finalHash: keccak256(abi.encodePacked(sessionId, i)),
                committedAt: uint64(block.timestamp),
                over: true
            });
        }
        matchCount[sessionId] = n;
        uint64 points = pointsPerGame * n;
        emit MatchCommitted(sessionId, n, bytes32(0));
        if (points > 0) IGGTestPlayer(playerAccount).credit(player, gameTag, points);
    }

    /// @notice SAME as commitAndCredit but ALSO closes the generic session in the
    ///         same transaction, so the whole settle is ONE cost.
    function commitCreditAndSettle(
        bytes32 sessionId,
        uint32 moveCount,
        bytes32 finalHash,
        address playerAccount,
        address player,
        bytes32 gameTag,
        address core,
        bytes32 seedReveal,
        address[] calldata players,
        address[] calldata sessionKeys,
        bytes[] calldata sigs,
        address[] calldata signers
    ) external {
        Match storage m = matches[sessionId];
        m.turn = 0;
        m.moveCount = moveCount;
        m.finalHash = finalHash;
        m.committedAt = uint64(block.timestamp);
        m.over = true;
        emit MatchCommitted(sessionId, moveCount, finalHash);
        uint64 points = m.over ? 100 : 0;
        if (points > 0) IGGTestPlayer(playerAccount).credit(player, gameTag, points);
        IFoskaayGGISettle(core).settle(sessionId, finalHash, seedReveal, players, sessionKeys, sigs, signers);
    }
}
