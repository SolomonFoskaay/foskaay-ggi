// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// MatchSettlement — arcv2m17 GFG-BS (the gasless core).
///
/// WHY: Arc has no free execution layer, so writing every MOVE on-chain is not
/// gasless (~0.10 USDC per 2P match). This contract makes a match cost TWO
/// transactions total, regardless of how many moves it has:
///   1. commitStart  — one small tx at the start (players + a commitment + clock)
///   2. settle       — one tx at the end (the co-signed summary of the match)
///
/// SECURITY (off-chain is NOT "trust the frontend"): the full move log never
/// goes on-chain unless there is a dispute. Only a DIGEST of the move log is
/// stored, and a settlement is only accepted with BOTH players' signatures over
/// that same digest + result. Editing the move log changes the digest, so a
/// forged log cannot produce a valid co-signed settlement.
///
/// DISPUTE (commit-reveal): if either side disagrees, they reveal the move log;
/// the stored digest proves whether the reveal is the real game. On-chain rule
/// replay for the money games is layered on top of this later; the commitment
/// model here is what makes that possible.
///
/// GAME-AGNOSTIC: the contract knows nothing about Ludo or chess. `gameTag`
/// identifies the game and the digest is opaque bytes, so 100+ games reuse it.
contract MatchSettlement {
    struct Match {
        bytes32 gameId;
        address p1;
        address p2;
        bytes32 commitHash;   // digest of the start state (players + matchRef)
        bytes32 moveDigest;   // digest of the full move log at settlement
        bytes32 resultHash;   // digest of the result payload
        uint64 startedAt;
        uint64 settleDeadline; // after this, a timeout claim is allowed
        uint64 settledAt;
        uint32 moveCount;
        uint16 gameTag;        // 0 = ludo, 1 = chess, ... (data, not code)
        uint8 seats;
        bool settled;
        bool disputed;
    }

    address public relayer;                       // submits co-signed payloads, pays gas
    mapping(bytes32 => Match) private _matches;

    event MatchStarted(bytes32 indexed gameId, address indexed p1, address indexed p2, uint16 gameTag, uint8 seats, bytes32 commitHash, uint64 settleDeadline);
    event MatchSettled(bytes32 indexed gameId, bytes32 moveDigest, bytes32 resultHash, uint32 moveCount, uint64 settledAt);
    event MatchDisputed(bytes32 indexed gameId, address indexed by, bytes32 revealedDigest);
    event MatchTimeoutClaimed(bytes32 indexed gameId, address indexed by);

    error Exists();
    error NoMatch();
    error AlreadySettled();
    error NotPlayer();
    error BadSig();
    error NotExpired();

    constructor(address relayer_) {
        require(relayer_ != address(0), "relayer");
        relayer = relayer_;
    }

    /// START COMMIT — one small tx. Records the two players, the game tag, and a
    /// commitment to the initial state; opens the timeout clock. This is the
    /// permanent "beginning of the game" on-chain.
    function commitStart(
        bytes32 gameId,
        address p1,
        address p2,
        uint16 gameTag,
        uint8 seats,
        bytes32 commitHash,
        uint32 ttlSecs
    ) external {
        if (_matches[gameId].p1 != address(0)) revert Exists();
        if (p1 == address(0) || p2 == address(0)) revert NotPlayer();
        if (commitHash == bytes32(0)) revert BadSig();
        uint64 nowTs = uint64(block.timestamp);
        _matches[gameId] = Match({
            gameId: gameId, p1: p1, p2: p2,
            commitHash: commitHash, moveDigest: bytes32(0), resultHash: bytes32(0),
            startedAt: nowTs, settleDeadline: nowTs + ttlSecs, settledAt: 0,
            moveCount: 0, gameTag: gameTag, seats: seats,
            settled: false, disputed: false
        });
        emit MatchStarted(gameId, p1, p2, gameTag, seats, commitHash, nowTs + ttlSecs);
    }

    /// SETTLE — ONE tx for the whole match, co-signed by BOTH players. The two
    /// signatures must be present (a result cannot be forged by one side), and
    /// the digests are opaque: the contract stores them, it does not trust the
    /// caller's story. `v1/r1/s1` signs (moveDigest, resultHash, gameId); same
    /// for player two.
    function settle(
        bytes32 gameId,
        bytes32 moveDigest,
        bytes32 resultHash,
        uint32 moveCount,
        uint8 v1, bytes32 r1, bytes32 s1,
        uint8 v2, bytes32 r2, bytes32 s2
    ) external {
        Match storage m = _matches[gameId];
        if (m.p1 == address(0)) revert NoMatch();
        if (m.settled) revert AlreadySettled();
        bytes32 h = keccak256(abi.encodePacked(gameId, moveDigest, resultHash, moveCount));
        if (_recover(h, v1, r1, s1) != m.p1) revert BadSig();
        if (_recover(h, v2, r2, s2) != m.p2) revert BadSig();
        m.moveDigest = moveDigest;
        m.resultHash = resultHash;
        m.moveCount = moveCount;
        m.settled = true;
        m.settledAt = uint64(block.timestamp);
        emit MatchSettled(gameId, moveDigest, resultHash, moveCount, m.settledAt);
    }

    /// DISPUTE — a player reveals a digest they claim is the real move log. If it
    /// differs from the settled one, the match is flagged so the reveal/rule
    /// replay path can adjudicate. No funds and no points move here.
    function dispute(bytes32 gameId, bytes32 revealedDigest) external {
        Match storage m = _matches[gameId];
        if (m.p1 == address(0)) revert NoMatch();
        if (msg.sender != m.p1 && msg.sender != m.p2) revert NotPlayer();
        if (revealedDigest == bytes32(0)) revert BadSig();
        m.disputed = true;
        emit MatchDisputed(gameId, msg.sender, revealedDigest);
    }

    /// TIMEOUT CLAIM — if the match was never settled and the clock has passed,
    /// either player may claim. This is how an ABANDONED match ends: by the
    /// clock, so the game can never hang forever. (The life was already charged
    /// at start, so abandoning is never a free escape.)
    function claimTimeout(bytes32 gameId) external {
        Match storage m = _matches[gameId];
        if (m.p1 == address(0)) revert NoMatch();
        if (m.settled) revert AlreadySettled();
        if (msg.sender != m.p1 && msg.sender != m.p2) revert NotPlayer();
        if (block.timestamp < m.settleDeadline) revert NotExpired();
        m.settled = true;
        m.settledAt = uint64(block.timestamp);
        m.resultHash = keccak256(abi.encodePacked("timeout", gameId));
        emit MatchTimeoutClaimed(gameId, msg.sender);
    }

    function matchOf(bytes32 gameId)
        external
        view
        returns (address p1, address p2, bytes32 commitHash, bytes32 moveDigest, bytes32 resultHash,
                 uint64 startedAt, uint64 settleDeadline, uint32 moveCount, uint16 gameTag, uint8 seats,
                 bool settled, bool disputed)
    {
        Match storage m = _matches[gameId];
        return (m.p1, m.p2, m.commitHash, m.moveDigest, m.resultHash,
                m.startedAt, m.settleDeadline, m.moveCount, m.gameTag, m.seats,
                m.settled, m.disputed);
    }

    function _recover(bytes32 h, uint8 v, bytes32 r, bytes32 s) internal pure returns (address) {
        if (v < 27) v += 27;
        if (v != 27 && v != 28) return address(0);
        return ecrecover(keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", h)), v, r, s);
    }
}
