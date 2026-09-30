// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts/access/OwnableUpgradeable.sol";

/// @notice Inlined player ledger (test variant of GFGPlayers storage).

/// @title GFGMerged — TEST VARIANT: Ludo rules + player ledger in ONE contract.
/// @notice Answers one measured question: what does the game-to-player
/// cross-contract call cost, and does merging change persistence without
/// settle? Rules, board, timer and settle checks are identical to GFGGames v4;
/// only the credit/record writes are internal instead of external.
/// TESTNET ONLY. Never mainnet without owner approval.
/// @notice Faithful copy of the single-player game logic. The RULES are `pure`,
/// so the whole game runs in the Foskaay GGI Midchain via `eth_call` for FREE
/// (player and sponsor). The MATCH is committed on-chain by `settle`: it writes
/// N games in ONE transaction and credits GFGPlayers in the same step. Only the
/// connect (the core) and this settle are transactions.
///
/// @notice Multiplayer difference is NOT in these rules. It is in the session:
/// N real players plus N session keys in `handoverWithAccounts`, per-seat
/// signing of each hash, timeout kind 3 for clocks, and `verifyMoveLog`
/// client-side. This contract never learns who is remote; it enforces turn,
/// dice, capture and finish the same for every seat.
///
/// @notice The compact 36-byte board (same shape as the pure rules):
///   [0] turn, [1] finishCount, [2] userSeat, [3] seatCount,
///   [4] dieA, [5] dieB, [6] rollCounter, [7] extraRoll,
///   [8..23] stepsWalked per token (16), 0xFF = in the yard, else 0..57,
///   [24..27] finishOrder (4 seats),
///   [28..35] points per seat (4 x uint16, big-endian, the credit source).
///
/// @dev UPGRADEABLE (UUPS, OpenZeppelin only). Proxy address is PERMANENT.
/// Storage is APPEND-ONLY: new variables consume from the top of `__gap`,
/// which shrinks by the same count. `version` marks changes.
contract GFGMerged is Initializable, UUPSUpgradeable, OwnableUpgradeable {
    uint8 internal constant YARD = 0xFF;
    uint8 internal constant SEATS = 4;
    uint8 internal constant TOKENS_PER_SEAT = 4;
    uint256 internal constant STATE_LEN = 36;
    /// Relay-latency grace added to turnSecs inside settle verification.
    uint64 internal constant TURN_GRACE = 15;
    /// Testnet block clocks jitter backward; timestamps stamped from a chain
    /// head may land slightly ahead of the settle block. Small tolerance only:
    /// gaps and the duration cap below still bind every timestamp.
    uint64 internal constant FUTURE_TOL = 120;
    /// Default timer values (also set in initialize for fresh deploys).
    uint64 internal constant DEFAULT_TURN_SECS = 45;
    uint64 internal constant DEFAULT_MAX_MATCH_SECS = 3600;

    /// One committed game. `board` is the compact board bytes; `boardHash` is
    /// keccak256(board) (one bytes32 per game, checked at settle).
    struct Game {
        uint8 turn;
        uint8 seats;
        uint32 step;
        bytes board;
        bytes32 boardHash;
        bool over;
    }

    /// Points, lives and a compact record, all per player and per game tag.
    struct Record {
        uint64 played;
        uint64 wins;
        uint64 best;
    }

    /// player => gameTag => points
    mapping(address => mapping(bytes32 => uint64)) private _points;

    /// player => gameTag => lives
    mapping(address => mapping(bytes32 => uint64)) private _lives;

    /// player => gameTag => record
    mapping(address => mapping(bytes32 => Record)) private _records;

    /// sessionId => the committed games (the on-chain source of truth).
    mapping(bytes32 => Game[]) private _games;

    /// Layout marker. Bump only on a layout change.
    uint8 public version;

/// Reserved slots for future variables. Consume from the top, shrink by the
    /// same count. DO NOT reorder or remove.
    uint256[20] private __gap;

    /// LIVE BOARD (the game's "program" store): the latest board BYTES of each
    /// in-progress game. Overwriting = one slot, so storage cost stays tiny.
    /// NOTE: the midchain rule forbids per-move Arc writes; this slot is read
    /// history only and is never written per move in ludo-mp. Finished history
    /// stays in gamesOf.
    mapping(bytes32 => bytes) public liveBoards;

    /// PER-PLAYER PERSISTENT GAME INDEX: which game indices belong to which
    /// player in a session. Written at settle for every seat that earned
    /// points, so a frontend can ask "player X's games in session Y" straight
    /// from the chain with no relay memory.
    mapping(bytes32 => mapping(address => uint32[])) public playerGameIndices;

    /// TURN TIMER (contract-owned, never client-controlled). The constants live
    /// here so every phone counts down from the SAME numbers (free eth_call
    /// reads); per-move timestamps travel in the signed log and are VERIFIED
    /// at settle, so a forged clock fails settlement. No per-tick transaction:
    /// everything runs gas-free in the midchain, only settle is on-chain.
    /// turnSecs: max seconds per turn window. maxMatchSecs: whole-match cap.
    uint64 public turnSecs;
    uint64 public maxMatchSecs;

    error BadSeat();
    error BadState();
    error NotYourTurn();
    error PendingRoll();
    error NoSeeds();
    error DieNotOnRoll();
    error YardNeedsSix();
    error AlreadyHome();
    error OverflowHome();
    error BadKind();
    error BadInput();
    error BadHash();
    error BadTiming();
    error ZeroAddress();

    event Settled(bytes32 indexed sessionId, uint256 games, uint256 credited);
    event Credited(address indexed player, bytes32 indexed gameTag, uint64 amount);
    event Recorded(address indexed player, bytes32 indexed gameTag, uint64 played, uint64 wins, uint64 best);

    /// @notice Initialize the proxy: the upgrade owner only.
    function initialize(address owner_) external initializer {
        if (owner_ == address(0)) revert ZeroAddress();
        __Ownable_init(owner_);
        turnSecs = DEFAULT_TURN_SECS;
        maxMatchSecs = DEFAULT_MAX_MATCH_SECS;
        version = 1;
    }

    /// @dev The implementation can never be used directly.
    constructor() {
        _disableInitializers();
    }

    /// @dev Only the owner may authorize an upgrade.
    function _authorizeUpgrade(address) internal override onlyOwner {}

    /// @notice Layout marker bump (owner only). Called during an upgrade when a
    ///         storage field is appended, so readers can detect the new layout.
    function setVersion(uint8 v) external onlyOwner {
        version = v;
    }

    /// @notice Set the per-turn window in seconds (owner only). Every phone
    ///         reads this same value, so both clocks agree by construction.
    function setTurnSecs(uint64 v) external onlyOwner {
        if (v == 0) revert BadInput();
        turnSecs = v;
    }

    /// @notice Set the whole-match cap in seconds (owner only).
    function setMaxMatchSecs(uint64 v) external onlyOwner {
        if (v == 0) revert BadInput();
        maxMatchSecs = v;
    }

    // ---------------------------------------------------------------- init

    /// @notice The opening state for a match. Pure: free via eth_call.
    function getInitialState(uint8 seatCount, uint8 userSeat) external pure returns (bytes memory s) {
        if (seatCount != 2 && seatCount != 4) revert BadSeat();
        if (userSeat >= seatCount) revert BadSeat();
        s = new bytes(STATE_LEN);
        s[0] = bytes1(uint8(0));      // turn
        s[1] = bytes1(uint8(0));      // finishCount
        s[2] = bytes1(userSeat);
        s[3] = bytes1(seatCount);
        for (uint256 i = 0; i < 16; i++) s[8 + i] = bytes1(YARD);
    }

    // -------------------------------------------------------------- apply

    /// @notice Apply ONE action and return the next state. Pure: free via eth_call.
    /// @param state the current state bytes.
    /// @param kind 0 = roll, 1 = move a token (spends `value`), 2 = pass, 3 = timeout.
    /// @param seat the seat acting (must be the turn).
    /// @param tokenIndex 0..3 (kind 1).
    /// @param value the die spent (kind 1), 1..6.
    /// @param seeds two random seeds for kind 0 (from the core's randomN).
    function applyMove(
        bytes calldata state,
        uint8 kind,
        uint8 seat,
        uint8 tokenIndex,
        uint8 value,
        bytes32[] calldata seeds
    ) external pure returns (bytes memory out) {
        if (state.length != STATE_LEN) revert BadState();
        out = state;
        uint8 turn = uint8(out[0]);
        if (seat != turn) revert NotYourTurn();

        if (kind == 0) {
            if (uint8(out[4]) != 0 || uint8(out[5]) != 0) revert PendingRoll();
            if (seeds.length < 2) revert NoSeeds();
            uint8 d1 = uint8((uint256(seeds[0]) % 6) + 1);
            uint8 d2 = uint8((uint256(seeds[1]) % 6) + 1);
            out[4] = bytes1(d1);
            out[5] = bytes1(d2);
            out[6] = bytes1(uint8(out[6]) + 1); // rollCounter (the relay's randomN counter)
            if (d1 == 6 && d2 == 6) {
                uint8 e = uint8(out[7]);
                out[7] = bytes1(e >= 3 ? 3 : e + 1); // "Shoki" bonus roll, max 3 in a row
            } else {
                out[7] = bytes1(uint8(0));
            }
            return out;
        }

        if (kind == 1) {
            if (tokenIndex >= TOKENS_PER_SEAT) revert BadSeat();
            if (uint8(out[4]) == value) out[4] = bytes1(uint8(0));
            else if (uint8(out[5]) == value) out[5] = bytes1(uint8(0));
            else revert DieNotOnRoll();

            uint16 idx = uint16(seat) * 4 + uint16(tokenIndex);
            uint8 sc = uint8(out[8 + idx]);
            if (sc == YARD) {
                if (value != 6) revert YardNeedsSix();
                out[8 + idx] = bytes1(uint8(0));
            } else {
                if (sc >= 57) revert AlreadyHome();
                uint16 next = uint16(sc) + uint16(value);
                if (next > 57) revert OverflowHome();
                out[8 + idx] = bytes1(uint8(next));
            }

            // Capture ("pe"): unconditional, matching single-player.
            uint8 ns = uint8(out[8 + idx]);
            if (ns < 52) {
                uint8 absPos = uint8((uint16(seat) * 13 + uint16(ns)) % 52);
                if (absPos % 13 != 0) { // the four coloured start cells are safe
                    for (uint8 s2 = 0; s2 < uint8(out[3]); s2++) {
                        if (s2 == seat) continue;
                        for (uint8 t2 = 0; t2 < TOKENS_PER_SEAT; t2++) {
                            uint8 oi = uint8(s2) * 4 + t2;
                            uint8 so = uint8(out[8 + oi]);
                            if (so < 52) {
                                uint8 oAbs = uint8((uint16(s2) * 13 + uint16(so)) % 52);
                                if (oAbs == absPos) {
                                    out[8 + oi] = bytes1(YARD);      // opponent home
                                    out[8 + idx] = bytes1(uint8(57)); // capturer exits
                                    ns = 57;
                                }
                            }
                        }
                    }
                }
            }

            _recordFinish(out, seat);
            return out;
        }

        if (kind == 2) {
            out[4] = bytes1(uint8(0));
            out[5] = bytes1(uint8(0));
            uint8 e = uint8(out[7]);
            if (e > 0) {
                out[7] = bytes1(e - 1); // bonus roll: stay on the same seat
            } else {
                out[0] = bytes1(_nextSeat(out, seat));
            }
            return out;
        }

        if (kind == 3) { // timeout: FORCED PASS, never a skip. Same turn rules
            // as kind 2: a pending double-six bonus stays on the same seat
            // (consumed by one), otherwise the turn advances. The timer only
            // triggers the normal turn mechanism; it never overrides the rules.
            out[4] = bytes1(uint8(0));
            out[5] = bytes1(uint8(0));
            uint8 e3 = uint8(out[7]);
            if (e3 > 0) {
                out[7] = bytes1(e3 - 1); // bonus roll: stay on the same seat
            } else {
                out[0] = bytes1(_nextSeat(out, seat));
            }
            return out;
        }

        revert BadKind();
    }

    // -------------------------------------------------------------- timer

    /// @notice The deadline of a turn that started at `lastTs`. Free view:
    ///         every phone counts down from this same number.
    function turnDeadline(uint64 lastTs) external view returns (uint64) {
        return lastTs + turnSecs;
    }

    /// @notice True when the turn that started at `lastTs` has expired at
    ///         `nowTs`. Free view: the relay checks this before executing a
    ///         timeout-advance, and settle re-verifies the timestamps.
    function isTurnExpired(uint64 lastTs, uint64 nowTs) external view returns (bool) {
        return nowTs >= lastTs + turnSecs;
    }

    // -------------------------------------------------------------- settle

    /// @notice Commit N games in ONE transaction and credit GFGPlayers in
    ///         the same step. The points come from each board's embedded per-seat
    ///         points (bytes 28..35), summed per seat across the N games. Only the
    ///         owner (the relay) may settle, so arbitrary points cannot be minted.
    /// @param sessionId the core session this settle belongs to.
    /// @param list the N committed games.
    /// @param seatPlayers seat => player address (length must equal each game's seats).
    /// @param gameTag the game bucket (e.g. "ludo-mp").
    /// @param moveTss handover block time FIRST (auditable against the Handover
    ///        event), then one unix timestamp per logged move, in order.
    ///        Verified here: monotonic, every gap within turnSecs + grace, total
    ///        within maxMatchSecs, last at or before now. A forged clock reverts.
    function settle(
        bytes32 sessionId,
        Game[] calldata list,
        address[] calldata seatPlayers,
        bytes32 gameTag,
        uint64[] calldata moveTss
    ) external onlyOwner returns (uint256 credited) {
        uint256 n = list.length;
        if (n == 0) revert BadInput();
        if (seatPlayers.length == 0 || seatPlayers.length > SEATS) revert BadSeat();
        _verifyTiming(list, moveTss);

        uint64[4] memory totals;
        for (uint256 i = 0; i < n; i++) {
            Game calldata g = list[i];
            if (g.board.length != STATE_LEN) revert BadState();
            if (g.seats != seatPlayers.length) revert BadSeat();
            if (keccak256(g.board) != g.boardHash) revert BadHash();
            _games[sessionId].push();
            Game storage d = _games[sessionId][_games[sessionId].length - 1];
            d.turn = g.turn;
            d.seats = g.seats;
            d.step = g.step;
            d.board = g.board;
            d.boardHash = g.boardHash;
            d.over = g.over;
            // Persistent-gameplay: index every game against the player(s) that
            // earned points in it, so any device can rebuild a player's history
            // from the chain (the index of a game in gamesOf is its id).
            for (uint8 s = 0; s < g.seats; s++) {
                uint64 pts = _seatPoints(g.board, s);
                totals[s] += pts;
                if (pts > 0 && seatPlayers[s] != address(0)) {
                    playerGameIndices[sessionId][seatPlayers[s]].push(uint32(i));
                }
            }
        }

        for (uint8 s = 0; s < seatPlayers.length; s++) {
            if (seatPlayers[s] != address(0) && totals[s] > 0) {
                // MERGED: internal ledger write, no cross-contract call.
                _points[seatPlayers[s]][gameTag] += totals[s];
                credited += totals[s];
                emit Credited(seatPlayers[s], gameTag, totals[s]);
            }
        }
        emit Settled(sessionId, n, credited);
    }

    /// @notice Settle-time clock verification. Every logged move must arrive
    ///         within a turn window of the previous one (turnSecs + grace for
    ///         relay latency), the whole match within maxMatchSecs, and no
    ///         timestamp may lie in the future. Timeout-advance moves are logged
    ///         like any move, so a stalled seat cannot hide extra time either.
    function _verifyTiming(Game[] calldata list, uint64[] calldata moveTss) private view {
        uint256 steps = 0;
        for (uint256 i = 0; i < list.length; i++) steps += list[i].step;
        // moveTss = [handoverTs, ...one ts per logged move].
        if (moveTss.length == 0 || moveTss.length != steps + 1) revert BadTiming();
        uint64 prev = moveTss[0];
        for (uint256 i = 1; i < moveTss.length; i++) {
            uint64 ts = moveTss[i];
            if (ts < prev) revert BadTiming(); // monotonic
            if (ts - prev > turnSecs + TURN_GRACE) revert BadTiming(); // turn window
            prev = ts;
        }
        if (prev > uint64(block.timestamp) + FUTURE_TOL) revert BadTiming(); // not the future
        if (prev - moveTss[0] > maxMatchSecs) revert BadTiming(); // match cap
    }

    // --------------------------------------------------------------- views

    function gamesOf(bytes32 sessionId) external view returns (Game[] memory) {
        return _games[sessionId];
    }

    function gameCount(bytes32 sessionId) external view returns (uint256) {
        return _games[sessionId].length;
    }

    /// @notice Latest board bytes slot (read history only in ludo-mp).
    function recordLive(bytes32 sessionId, bytes calldata board) external onlyOwner {
        liveBoards[sessionId] = board;
    }

    /// @notice The latest board bytes of a session.
    function liveBoard(bytes32 sessionId) external view returns (bytes memory) {
        return liveBoards[sessionId];
    }

    /// @notice The indices of a player's games inside a session (each index is the
    ///         game's id in gamesOf). Persistent on-chain: rebuilt from this with
    ///         gamesOf(sessionId) + the board/points, no relay memory needed.
    function playerGamesOf(bytes32 sessionId, address player) external view returns (uint32[] memory) {
        return playerGameIndices[sessionId][player];
    }

    /// @notice Inlined ledger reads (same shape as the split player account).
    function pointsOf(address player, bytes32 gameTag) external view returns (uint64) {
        return _points[player][gameTag];
    }

    function livesOf(address player, bytes32 gameTag) external view returns (uint64) {
        return _lives[player][gameTag];
    }

    function recordOf(address player, bytes32 gameTag) external view returns (uint64 played, uint64 wins, uint64 best) {
        Record storage r = _records[player][gameTag];
        return (r.played, r.wins, r.best);
    }

    function hashState(bytes calldata state) external pure returns (bytes32) {
        return keccak256(state);
    }

    function isTerminal(bytes calldata state) external pure returns (bool finished, uint8 winner) {
        uint8 fc = uint8(state[1]);
        uint8 n = uint8(state[3]);
        finished = fc >= (n == 2 ? 1 : 3);
        winner = fc > 0 ? uint8(state[24]) : 255;
    }

    /// @notice Decode the compact state for a display layer. The frontend renders
    ///         the board from `steps` and the points from `points`.
    function decodeState(bytes calldata state)
        external
        pure
        returns (
            uint8 turn,
            uint8 finishCount,
            uint8 userSeat,
            uint8 seatCount,
            int16[16] memory steps,
            uint8[4] memory order,
            uint16[4] memory points,
            uint8 dieA,
            uint8 dieB
        )
    {
        if (state.length != STATE_LEN) revert BadState();
        turn = uint8(state[0]);
        finishCount = uint8(state[1]);
        userSeat = uint8(state[2]);
        seatCount = uint8(state[3]);
        dieA = uint8(state[4]);
        dieB = uint8(state[5]);
        for (uint256 i = 0; i < 16; i++) {
            uint8 v = uint8(state[8 + i]);
            steps[i] = v == YARD ? int16(-1) : int16(uint16(v));
        }
        for (uint256 i = 0; i < 4; i++) order[i] = uint8(state[24 + i]);
        for (uint256 i = 0; i < 4; i++) {
            points[i] = (uint16(uint8(state[28 + 2 * i])) << 8) | uint16(uint8(state[29 + 2 * i]));
        }
    }

    /// @notice The points a place earns. 4 seats: 1st 100, 2nd 50, 3rd 25, 4th 0.
    ///         2 seats: 1st 100, 2nd 0.
    function placePoints(uint8 place, uint8 seatCount) public pure returns (uint16) {        if (place == 1) return 100;
        if (seatCount == 4 && place == 2) return 50;
        if (seatCount == 4 && place == 3) return 25;
        return 0;
    }

    // ------------------------------------------------------------ internal

    function _seatPoints(bytes calldata board, uint8 seat) private pure returns (uint64) {
        return (uint64(uint8(board[28 + 2 * seat])) << 8) | uint64(uint8(board[29 + 2 * seat]));
    }

    function _recordFinish(bytes memory out, uint8 seat) private pure {
        uint8 homeCount = 0;
        uint8 base = uint8(seat) * 4;
        for (uint8 t = 0; t < TOKENS_PER_SEAT; t++) {
            // A token is HOME only when it reached the centre (exactly 57).
            // A token still in the yard is 0xFF (255) and must never count.
            uint8 sv = uint8(out[8 + base + t]);
            if (sv >= 57 && sv != YARD) homeCount++;
        }
        if (homeCount < TOKENS_PER_SEAT) return;

        uint8 fc = uint8(out[1]);
        for (uint8 i = 0; i < fc; i++) {
            if (uint8(out[24 + i]) == seat) return; // already recorded
        }
        out[24 + fc] = bytes1(seat);
        out[1] = bytes1(fc + 1);
        uint8 place = fc + 1;
        uint16 pts = placePoints(place, uint8(out[3]));
        uint16 cur = (uint16(uint8(out[28 + 2 * seat])) << 8) | uint16(uint8(out[29 + 2 * seat]));
        uint16 updated = cur + pts;
        out[28 + 2 * seat] = bytes1(uint8(updated >> 8));
        out[29 + 2 * seat] = bytes1(uint8(updated & 0xFF));
    }

    function _isFinished(bytes memory out, uint8 seat) private pure returns (bool) {
        uint8 fc = uint8(out[1]);
        for (uint8 i = 0; i < fc; i++) {
            if (uint8(out[24 + i]) == seat) return true;
        }
        return false;
    }

    function _nextSeat(bytes memory out, uint8 from) private pure returns (uint8) {
        uint8 n = uint8(out[3]);
        for (uint8 i = 1; i <= n; i++) {
            uint8 cand = uint8((uint16(from) + i) % n);
            if (!_isFinished(out, cand)) return cand;
        }
        return from;
    }
}
