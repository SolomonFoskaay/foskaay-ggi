// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {FoskaayGGI} from "../src/FoskaayGGI.sol";
import {GGTestGame} from "../testproof/GGTestGame.sol";
import {GGTestPlayer} from "../testproof/GGTestPlayer.sol";
import {Deploy} from "./Deploy.sol";

interface Vm {
    function deal(address, uint256) external;
    function prank(address) external;
    function expectRevert() external;
    function expectRevert(bytes4) external;
    function sign(uint256, bytes32) external pure returns (uint8 v, bytes32 r, bytes32 s);
    function addr(uint256) external pure returns (address);
}

/// PROOF: the generic, non-opinionated core can take a DEV-DECLARED account list
/// of ANY size (0..N), charge base + per-account + per-game at connect, and a
/// stateful game account and a stateful player account can be committed in ONE
/// settle transaction while the two on-chain accounts talk to each other.
contract GGTwoAccountsTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 constant FEE = 4e14;        // legacy single fee
    uint256 constant FEE_BASE = 4e14;   // 0.0004
    uint256 constant FEE_ACCT = 4e14;   // 0.0004 per account
    uint256 constant FEE_GAME = 2e14;   // 0.0002 per game
    uint256 constant PK = 0xA11CE;
    address constant DEST = address(0xBEEF);
    bytes32 constant SID = keccak256("session-2acct");
    bytes32 constant SEED = keccak256("reveal");
    bytes32 constant TAG = keccak256("ludo");

    FoskaayGGI core;
    GGTestGame game;
    GGTestPlayer player;
    address p;

    function setUp() public {
        core = Deploy.registry(address(this), DEST, FEE);
        core.setFees(FEE_BASE, FEE_ACCT, FEE_GAME);
        game = Deploy.ggTestGame(address(this));
        player = Deploy.ggTestPlayer(address(this), address(game));
        vm.deal(address(this), 100 ether);
        p = vm.addr(PK);
    }

    function _one(address a) internal pure returns (address[] memory x) { x = new address[](1); x[0] = a; }

    function _commit(bytes32 seedReveal) internal pure returns (bytes32) { return keccak256(abi.encodePacked(seedReveal)); }

    /// The exact session fee for a declared account count and game count.
    function _fee(uint256 nAccounts, uint16 games) internal pure returns (uint256) {
        return FEE_BASE + FEE_ACCT * nAccounts + FEE_GAME * uint256(games);
    }

    function _sig(bytes32 id, bytes32 finalHash) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(PK, core.midchainDigest(id, finalHash));
        return abi.encodePacked(r, s, v);
    }

    // ---- correctness ----

    function testCoreIsNonOpinionatedAnyAccountCount() public {
        address[] memory accounts = new address[](3);
        accounts[0] = address(game);
        accounts[1] = address(player);
        accounts[2] = address(0xF00D); // a third account the dev chose
        core.handoverWithAccounts{value: _fee(3, 1)}(SID, address(game), bytes32("start"), _commit(SEED), _one(p), _one(p), 2, accounts, 1);
        address[] memory got = core.sessionAccounts(SID);
        require(got.length == 3, "3 accounts recorded, not a fixed 2");
        require(got[0] == address(game) && got[1] == address(player), "order kept");
        require(core.sessionGames(SID) == 1, "games recorded");
        require(core.isPaid(SID), "paid");
    }

    function testHandoverWithAccountsRejectsWrongFee() public {
        vm.expectRevert(FoskaayGGI.BadFee.selector);
        core.handoverWithAccounts{value: FEE}(SID, address(game), 0, _commit(SEED), _one(p), _one(p), 2, _one(address(game)), 1);
    }

    function testGameHoldsMatchAndCreditsPlayerInOneStep() public {
        game.commitAndCredit(SID, 42, bytes32("final"), address(player), p, TAG);
        (uint8 turn, uint32 moveCount, bytes32 finalHash, , bool over) = game.matches(SID);
        require(over && moveCount == 42 && finalHash == bytes32("final"), "match held on-chain");
        require(turn == 0, "turn reset on commit");
        require(player.pointsOf(p, TAG) == 100, "player credited by the game, same step");
    }

    function testOneTxCommitsBothAndSettlesSession() public {
        core.handoverWithAccounts{value: _fee(1, 1)}(SID, address(game), bytes32("start"), _commit(SEED), _one(p), _one(p), 2, _one(address(game)), 1);
        bytes[] memory finalSigs = new bytes[](1);
        finalSigs[0] = _sig(SID, bytes32("final"));
        game.commitCreditAndSettle(SID, 42, bytes32("final"), address(player), p, TAG, address(core), SEED, _one(p), _one(p), finalSigs, _one(p));
        require(core.settled(SID), "session closed in the same tx");
        require(player.pointsOf(p, TAG) == 100, "player credited");
        (, uint32 moveCount, , , bool over) = game.matches(SID);
        require(over && moveCount == 42, "match committed");
    }

    function testCoreUpgradePreservesAccountsAndFees() public {
        address[] memory accounts = _one(address(game));
        core.handoverWithAccounts{value: _fee(1, 1)}(SID, address(game), bytes32("start"), _commit(SEED), _one(p), _one(p), 2, accounts, 1);
        address before = address(core);
        FoskaayGGI impl = new FoskaayGGI();
        core.upgradeToAndCall(address(impl), "");
        require(address(core) == before, "address kept");
        require(core.sessionAccounts(SID).length == 1, "accounts kept");
        require(core.feeBase() == FEE_BASE && core.feePerAccount() == FEE_ACCT && core.feePerGame() == FEE_GAME, "fees kept");
    }

    // ---- gas: connect with 0/1/2/3 declared accounts (1 game) ----
    function testGasConnect0Accounts() public {
        core.handoverWithAccounts{value: _fee(0, 1)}(SID, address(game), 0, _commit(SEED), _one(p), _one(p), 2, new address[](0), 1);
    }

    function testGasConnect1Account() public {
        core.handoverWithAccounts{value: _fee(1, 1)}(SID, address(game), 0, _commit(SEED), _one(p), _one(p), 2, _one(address(game)), 1);
    }

    function testGasConnect2Accounts() public {
        address[] memory a = new address[](2);
        a[0] = address(game);
        a[1] = address(player);
        core.handoverWithAccounts{value: _fee(2, 1)}(SID, address(game), 0, _commit(SEED), _one(p), _one(p), 2, a, 1);
    }

    function testGasConnect3Accounts() public {
        address[] memory a = new address[](3);
        a[0] = address(game);
        a[1] = address(player);
        a[2] = address(0xF00D);
        core.handoverWithAccounts{value: _fee(3, 1)}(SID, address(game), 0, _commit(SEED), _one(p), _one(p), 2, a, 1);
    }

    // ---- gas: settle variants ----
    function testGasSettleGameAndPlayer() public {
        game.commitAndCredit(SID, 42, bytes32("final"), address(player), p, TAG);
    }

    function testGasSettleBothAndCore() public {
        core.handoverWithAccounts{value: _fee(1, 1)}(SID, address(game), 0, _commit(SEED), _one(p), _one(p), 2, _one(address(game)), 1);
        bytes[] memory s = new bytes[](1);
        s[0] = _sig(SID, bytes32("final"));
        game.commitCreditAndSettle(SID, 42, bytes32("final"), address(player), p, TAG, address(core), SEED, _one(p), _one(p), s, _one(p));
    }

    // ---- gas: BATCH (N games committed in ONE settle, accounts lifted once) ----
    function testGasBatch1() public { game.commitManyAndCredit(SID, 1, address(player), p, TAG, 100); }
    function testGasBatch5() public { game.commitManyAndCredit(SID, 5, address(player), p, TAG, 100); }
    function testGasBatch10() public { game.commitManyAndCredit(SID, 10, address(player), p, TAG, 100); }
    function testGasBatch20() public { game.commitManyAndCredit(SID, 20, address(player), p, TAG, 100); }
}
