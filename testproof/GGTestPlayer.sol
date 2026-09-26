// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts/access/OwnableUpgradeable.sol";

/// @title GGTestPlayer — PROOF-ONLY player account. Holds real, permanent state
///        (points per player, bucketed by game tag) ON ARC. UUPS upgradeable.
/// @dev This is a test artifact for the "2 accounts in one session" measurement,
///      not the final product. It is stateful on purpose: the state lives here,
///      on-chain, NOT in the relay.
contract GGTestPlayer is Initializable, UUPSUpgradeable, OwnableUpgradeable {
    /// The game contract allowed to write points.
    address public game;

    /// player => gameTag => points
    mapping(address => mapping(bytes32 => uint64)) private _points;

    uint8 public version;
    uint256[20] private __gap;

    error OnlyGame();

    event Credited(address indexed player, bytes32 indexed gameTag, uint64 amount);

    function initialize(address owner_, address game_) external initializer {
        __Ownable_init(owner_);
        game = game_;
    }

    constructor() {
        _disableInitializers();
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}

    function setGame(address game_) external onlyOwner {
        game = game_;
    }

    /// @notice Credit points for a player under a game tag. The game (or owner)
    ///         calls this; inside a session it is a write in the room.
    function credit(address player, bytes32 gameTag, uint64 amount) external {
        if (msg.sender != game && msg.sender != owner()) revert OnlyGame();
        _points[player][gameTag] += amount;
        emit Credited(player, gameTag, amount);
    }

    function pointsOf(address player, bytes32 gameTag) external view returns (uint64) {
        return _points[player][gameTag];
    }
}
