// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts/access/OwnableUpgradeable.sol";

/// @title LudoPlayers — ONE player account for gfgnew/board/ludo, standalone.
/// @notice Holds everything permanent about a player, bucketed by game tag:
///         points, lives and a compact record (played / wins / best). It is
///         lifted into a session alongside the game account, so a point is a
///         FREE write inside the free room; it is never a per-move base-chain
///         transaction.
///
/// @notice ONLY the game contract may credit it (`credit`/`setLives`/
///         `addRecord`), so a player cannot mint points for themselves. The
///         owner may also call them (for a repair) and may point `game` at a
///         new game contract.
///
/// @dev UPGRADEABLE (UUPS, OpenZeppelin only). Proxy address is PERMANENT.
/// Storage is APPEND-ONLY: new variables consume from the top of `__gap`,
/// which shrinks by the same count. `version` marks changes.
contract LudoPlayers is Initializable, UUPSUpgradeable, OwnableUpgradeable {
    /// Points, lives and a compact record, all per player and per game tag.
    struct Record {
        uint64 played;
        uint64 wins;
        uint64 best;
    }

    /// The game contract allowed to write this account (LudoGames).
    address public game;

    /// player => gameTag => points
    mapping(address => mapping(bytes32 => uint64)) private _points;

    /// player => gameTag => lives
    mapping(address => mapping(bytes32 => uint64)) private _lives;

    /// player => gameTag => record
    mapping(address => mapping(bytes32 => Record)) private _records;

    /// Layout marker. Bump only on a layout change.
    uint8 public version;

    /// Reserved slots for future variables. Consume from the top, shrink by the
    /// same count. DO NOT reorder or remove.
    uint256[20] private __gap;

    error OnlyGame();
    error ZeroAddress();

    event Credited(address indexed player, bytes32 indexed gameTag, uint64 amount);
    event LivesSet(address indexed player, bytes32 indexed gameTag, uint64 lives);
    event Recorded(address indexed player, bytes32 indexed gameTag, uint64 played, uint64 wins, uint64 best);
    event GameSet(address indexed game);

    /// @notice Initialize the proxy. `game` is set right after the game contract
    ///         is deployed (setGame), so the two permanent proxies can be wired.
    function initialize(address owner_) external initializer {
        if (owner_ == address(0)) revert ZeroAddress();
        __Ownable_init(owner_);
        version = 1;
    }

    /// @dev The implementation can never be used directly.
    constructor() {
        _disableInitializers();
    }

    /// @dev Only the owner may authorize an upgrade.
    function _authorizeUpgrade(address) internal override onlyOwner {}

    /// @notice Point this player account at its game contract (owner only).
    function setGame(address game_) external onlyOwner {
        if (game_ == address(0)) revert ZeroAddress();
        game = game_;
        emit GameSet(game_);
    }

    /// @dev Only the game contract (or the owner, for a repair) may write.
    modifier onlyGame() {
        if (msg.sender != game && msg.sender != owner()) revert OnlyGame();
        _;
    }

    /// @notice Credit points for a player under a game tag. Called by the game
    ///         at the end of a match, inside the session, for free.
    function credit(address player, bytes32 gameTag, uint64 amount) external onlyGame {
        _points[player][gameTag] += amount;
        emit Credited(player, gameTag, amount);
    }

    /// @notice Set a player's lives for a game tag (the game owns the value).
    function setLives(address player, bytes32 gameTag, uint64 lives) external onlyGame {
        _lives[player][gameTag] = lives;
        emit LivesSet(player, gameTag, lives);
    }

    /// @notice Add to a player's record for a game tag (played / wins, best kept).
    function addRecord(address player, bytes32 gameTag, uint64 played, uint64 wins, uint64 best) external onlyGame {
        Record storage r = _records[player][gameTag];
        r.played += played;
        r.wins += wins;
        if (best > r.best) r.best = best;
        emit Recorded(player, gameTag, r.played, r.wins, r.best);
    }

    // ---------------------------------------------------------------- reads

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
}