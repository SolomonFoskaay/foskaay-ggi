// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// GameRegistry — arcv2m16 (EVM rail, Phase 0).
///
/// The whole game does not live on-chain. Only the START and the END are
/// confirmed here: a game opens with a deadline, settles once, and an abandoned
/// game can be expired by anyone after its deadline so the tree never grows
/// unbounded. Batch roots let ONE transaction commit the results of MANY games,
/// which is what keeps the per-game cost tiny.
contract GameRegistry {
    struct Game {
        address p1;
        address p2;
        uint64 startAt;
        uint64 deadline;
        bytes32 resultHash; // 0 = not settled
        bool expired;
        // ===== TURN CLOCK (arcv2m1, additive, game-agnostic) =====
        // Every turn is time-bound: the seat to play has an ABSOLUTE deadline,
        // and `expireTurn` lets ANYONE advance a seat whose window has passed,
        // so a live game can never stall. Reads the chain clock only.
        uint8 seats;
        uint8 activeSeat;
        uint32 turnSecs;
        uint64 turnDeadline;
        uint32 moveCount;
        bool begun;
    }

    /// Hard ceiling for any game's time to live (seconds).
    uint32 public immutable maxTtl;

    /// Largest seat count any game may use (Ludo 4, chess 2, party games 8).
    uint8 public constant MAX_SEATS = 8;

    mapping(bytes32 => Game) private _games;
    /// Seat ownership, game-agnostic: seat index -> wallet. Empty means the
    /// built-in p1 (seat 0) / p2 (seat 1) held the seat.
    mapping(bytes32 => mapping(uint8 => address)) public seatOwner;
    /// Last hashed move checkpoint (arc2m1 commitments; 0 = none).
    mapping(bytes32 => bytes32) public lastMoveCommit;
    /// Full finish order (seat indexes, 1st..Nth) once a game is settled (arc2m1).
    mapping(bytes32 => uint8[]) private _finishOrder;

    /// Latest batched roots (Phase 3 verifies a per-game Merkle proof against these).
    bytes32 public lastOpenRoot;
    bytes32 public lastSettleRoot;
    // Window state per kind (0 = open, 1 = settle). The LEAVES are the chain's
    // own events (derived with getLogs); these fields record the finalized root,
    // how many leaves it covers, and the block range, so the window is
    // restart-safe and fully verifiable from the chain alone. No off-chain store.
    mapping(uint8 => bytes32) public windowRoot;
    mapping(uint8 => uint256) public windowCount;
    mapping(uint8 => uint256) public windowFromBlock;
    mapping(uint8 => uint256) public windowToBlock;
    event WindowFinalized(uint8 indexed kind, bytes32 root, uint256 count, uint256 fromBlock, uint256 toBlock);
    /// Same as WindowFinalized but records the SPONSOR GAS the app paid for this
    /// window (wei), so all spend accounting is on-chain and auditable. No file,
    /// no indexer, no off-chain store.
    event WindowFinalizedGas(uint8 indexed kind, bytes32 root, uint256 count, uint256 fromBlock, uint256 toBlock, uint256 sponsorGasWei, uint256 timestamp);

    event GameOpened(bytes32 indexed gameId, address indexed p1, address indexed p2, uint64 startAt, uint64 deadline);
    event GameSettled(bytes32 indexed gameId, bytes32 resultHash);
    event GameExpired(bytes32 indexed gameId);
    event BatchCommitted(uint8 indexed kind, bytes32 root, uint256 count);
    event GameBegan(bytes32 indexed gameId, uint8 seats, uint32 turnSecs);
    event SeatTaken(bytes32 indexed gameId, uint8 indexed seat, address indexed player);
    event MoveCommitted(bytes32 indexed gameId, uint8 indexed seat, uint8 nextSeat, uint32 moveCount, uint64 turnDeadline);
    event TurnExpired(bytes32 indexed gameId, uint8 indexed fromSeat, uint8 toSeat, uint32 moveCount, uint64 turnDeadline);
    event GameSettledOrder(bytes32 indexed gameId, bytes32 resultHash, uint8[] order);

    constructor(uint32 maxTtl_) {
        require(maxTtl_ > 0, "ttl");
        maxTtl = maxTtl_;
    }

    /// Start a game. `msg.sender` is player one; `p2` is the opponent.
    function openGame(bytes32 gameId, address p2, uint32 ttl) external {
        require(_games[gameId].p1 == address(0), "exists");
        require(p2 != address(0), "p2");
        require(ttl > 0 && ttl <= maxTtl, "ttl");
        uint64 startAt = uint64(block.timestamp);
        uint64 deadline = startAt + ttl;
        _games[gameId] = Game(msg.sender, p2, startAt, deadline, bytes32(0), false, 0, 0, 0, 0, 0, false);
        emit GameOpened(gameId, msg.sender, p2, startAt, deadline);
    }

    /// Finish a game: only a player, only once, only if not expired.
    function settleGame(bytes32 gameId, bytes32 resultHash) external {
        Game storage g = _games[gameId];
        require(g.p1 != address(0), "no game");
        require(!g.expired, "expired");
        require(g.resultHash == bytes32(0), "settled");
        require(msg.sender == g.p1 || msg.sender == g.p2, "not player");
        require(resultHash != bytes32(0), "result");
        g.resultHash = resultHash;
        emit GameSettled(gameId, resultHash);
    }

    /// Permissionless cleanup: after the deadline an abandoned game is closed.
    function expireGame(bytes32 gameId) external {
        Game storage g = _games[gameId];
        require(g.p1 != address(0), "no game");
        require(g.resultHash == bytes32(0), "settled");
        require(!g.expired, "expired");
        require(block.timestamp > g.deadline, "too soon");
        g.expired = true;
        emit GameExpired(gameId);
    }

    /// One transaction records the root of many games. kind 0 = opens, 1 = settles.
    function commitBatch(uint8 kind, bytes32 root, uint256 count) external {
        require(kind <= 1, "kind");
        require(root != bytes32(0), "root");
        require(count > 0, "count");
        if (kind == 0) lastOpenRoot = root;
        else lastSettleRoot = root;
        emit BatchCommitted(kind, root, count);
    }

    /// Finalize a settlement window: one transaction records the Merkle root of
    /// every leaf in [fromBlock, toBlock]. Anyone can recompute the leaves from
    /// the chain's events and check the root, so no off-chain state is trusted.
    /// Idempotent-by-range: a range already covered cannot be finalized twice.
    function finalizeWindow(uint8 kind, bytes32 root, uint256 count, uint256 fromBlock, uint256 toBlock) external {
        require(kind <= 1, "kind");
        require(root != bytes32(0), "root");
        require(count > 0, "count");
        require(toBlock >= fromBlock, "range");
        require(fromBlock > windowToBlock[kind] || windowToBlock[kind] == 0, "already finalized");
        windowRoot[kind] = root;
        windowCount[kind] = count;
        windowFromBlock[kind] = fromBlock;
        windowToBlock[kind] = toBlock;
        if (kind == 0) lastOpenRoot = root; else lastSettleRoot = root;
        emit WindowFinalized(kind, root, count, fromBlock, toBlock);
    }

    /// Finalize a window AND record the sponsor gas paid for it (chain-only
    /// accounting). Same idempotent range guard. Additive: finalizeWindow stays.
    function finalizeWindowGas(uint8 kind, bytes32 root, uint256 count, uint256 fromBlock, uint256 toBlock, uint256 sponsorGasWei) external {
        require(kind <= 1, "kind");
        require(root != bytes32(0), "root");
        require(count > 0, "count");
        require(toBlock >= fromBlock, "range");
        require(fromBlock > windowToBlock[kind] || windowToBlock[kind] == 0, "already finalized");
        windowRoot[kind] = root;
        windowCount[kind] = count;
        windowFromBlock[kind] = fromBlock;
        windowToBlock[kind] = toBlock;
        if (kind == 0) lastOpenRoot = root; else lastSettleRoot = root;
        emit WindowFinalizedGas(kind, root, count, fromBlock, toBlock, sponsorGasWei, block.timestamp);
    }

    /// Register a wallet to a seat before the match begins. Callable only by a
    /// main player (p1/p2), and only for a seat that is still empty. Lets a host
    /// seat invited players and the house/sponsor seat (computer players) the
    /// same way. Does not change any existing flow.
    ///
    /// IDENTITY: the same model as PlayerCore. On devnet the relayer submits for
    /// the player (the player never signs and never pays gas), so the player is
    /// passed explicitly and `host` is checked against p1/p2. Moving to
    /// EIP-712 player signatures is the documented mainnet hardening.
    function seatUp(bytes32 gameId, address host, uint8 seat, address player) external {
        Game storage g = _games[gameId];
        require(g.p1 != address(0), "no game");
        require(!g.begun, "begun");
        require(g.resultHash == bytes32(0) && !g.expired, "closed");
        require(seat < MAX_SEATS, "seat");
        require(host == g.p1 || host == g.p2, "not player");
        require(player != address(0), "player");
        require(seatOwner[gameId][seat] == address(0), "taken");
        seatOwner[gameId][seat] = player;
        emit SeatTaken(gameId, seat, player);
    }

    /// Start the turn clock. The first turn belongs to seat 0 and its absolute
    /// deadline is stamped from the chain clock (no off-chain timer).
    function beginGame(bytes32 gameId, address host, uint8 seats, uint32 turnSecs) external {
        Game storage g = _games[gameId];
        require(g.p1 != address(0), "no game");
        require(!g.begun, "begun");
        require(g.resultHash == bytes32(0) && !g.expired, "closed");
        require(host == g.p1 || host == g.p2, "not player");
        require(seats >= 2 && seats <= MAX_SEATS, "seats");
        require(turnSecs > 0 && turnSecs <= maxTtl, "turn");
        g.seats = seats;
        g.activeSeat = 0;
        g.turnSecs = turnSecs;
        g.turnDeadline = uint64(block.timestamp) + turnSecs;
        g.moveCount = 0;
        g.begun = true;
        emit GameBegan(gameId, seats, turnSecs);
    }

    /// Commit one hashed move from the ACTIVE seat. Only the seat whose turn is
    /// live may move, so an early or stale move can never jump the turn. The
    /// seat's deadline is re-stamped for whoever plays next, exactly like the
    /// Solana game core (byte19 names the next seat). `mover` is the seat's
    /// wallet (relayer-attested on devnet, EIP-712 on mainnet).
    function commitMove(bytes32 gameId, address mover, uint8 seat, uint8 nextSeat, bytes32 moveCommit) external {
        Game storage g = _games[gameId];
        require(g.begun, "not begun");
        require(g.resultHash == bytes32(0) && !g.expired, "closed");
        require(seat < g.seats, "seat");
        require(seat == g.activeSeat, "not active");
        require(nextSeat < g.seats, "next");
        require(_seatAuth(gameId, seat, g) == mover, "not seat");
        lastMoveCommit[gameId] = moveCommit;
        g.activeSeat = nextSeat;
        g.turnDeadline = uint64(block.timestamp) + g.turnSecs;
        g.moveCount += 1;
        emit MoveCommitted(gameId, seat, nextSeat, g.moveCount, g.turnDeadline);
    }

    /// Permissionless force-pass: once the active seat's deadline has passed,
    /// ANY caller may advance the turn to the next seat so the match never
    /// hangs. Reads only its own deadline and the seat count; changes no game
    /// rule. This is the on-chain replacement for the Solana `expire_turn`.
    function expireTurn(bytes32 gameId) external {
        Game storage g = _games[gameId];
        require(g.begun, "not begun");
        require(g.resultHash == bytes32(0) && !g.expired, "closed");
        require(block.timestamp >= g.turnDeadline, "running");
        uint8 from = g.activeSeat;
        uint8 to = uint8((uint16(from) + 1) % g.seats);
        g.activeSeat = to;
        g.turnDeadline = uint64(block.timestamp) + g.turnSecs;
        g.moveCount += 1;
        emit TurnExpired(gameId, from, to, g.moveCount, g.turnDeadline);
    }

    /// Settle a game AND record the full finish order (1st..Nth seat indexes).
    /// `actor` is a main player (relayer-attested on devnet, EIP-712 on mainnet),
    /// matching the seat/authority model of the rest of the game core.
    function settleGameOrder(bytes32 gameId, address actor, bytes32 resultHash, uint8[] calldata finishOrder) external {
        Game storage g = _games[gameId];
        require(g.p1 != address(0), "no game");
        require(!g.expired, "expired");
        require(g.resultHash == bytes32(0), "settled");
        require(actor == g.p1 || actor == g.p2, "not player");
        require(resultHash != bytes32(0), "result");
        uint256 n = finishOrder.length;
        require(n > 0 && n <= MAX_SEATS, "order");
        uint8 seatCap = g.seats == 0 ? MAX_SEATS : g.seats;
        for (uint256 i = 0; i < n; i++) {
            require(finishOrder[i] < seatCap, "seat");
        }
        g.resultHash = resultHash;
        _finishOrder[gameId] = finishOrder;
        emit GameSettledOrder(gameId, resultHash, finishOrder);
    }

    /// Read a game's result hash and its full finish order (empty until settled).
    function resultOrder(bytes32 gameId) external view returns (bytes32 resultHash, uint8[] memory order) {
        Game storage g = _games[gameId];
        return (g.resultHash, _finishOrder[gameId]);
    }

    /// The seat allowed to move for `seat`: an explicitly seated wallet if one
    /// was registered, otherwise the built-in p1 (seat 0) / p2 (seat 1).
    function _seatAuth(bytes32 gameId, uint8 seat, Game storage g) internal view returns (address) {
        address o = seatOwner[gameId][seat];
        if (o != address(0)) return o;
        if (seat == 0) return g.p1;
        if (seat == 1) return g.p2;
        return address(0);
    }

    function turnState(bytes32 gameId)
        external
        view
        returns (uint8 seats, uint8 activeSeat, uint32 turnSecs, uint64 turnDeadline, uint32 moveCount, bool begun)
    {
        Game storage g = _games[gameId];
        return (g.seats, g.activeSeat, g.turnSecs, g.turnDeadline, g.moveCount, g.begun);
    }

    function gameState(bytes32 gameId)
        external
        view
        returns (address p1, address p2, uint64 startAt, uint64 deadline, bytes32 resultHash, bool expired)
    {
        Game storage g = _games[gameId];
        return (g.p1, g.p2, g.startAt, g.deadline, g.resultHash, g.expired);
    }
}
