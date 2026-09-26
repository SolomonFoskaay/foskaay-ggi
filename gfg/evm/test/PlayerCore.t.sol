// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PlayerCore} from "../src/PlayerCore.sol";

interface Vm {
    function warp(uint256) external;
    function prank(address) external;
    function expectRevert() external;
}

contract PlayerCoreTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    PlayerCore core;
    address constant P = address(0xA11CE);
    address constant BAD = address(0xBAD);
    bytes32 constant LUDO = bytes32("ludo");
    bytes32 constant CHESS = bytes32("chess");

    function setUp() public {
        core = new PlayerCore(address(this)); // this test acts as the relayer/admin
    }

    function testChargeLifeConsumesOne() public {
        core.chargeLife(P, 1);
        (uint16 used, uint16 pool, uint64 boosterUntil, uint64 day) = core.livesOf(P);
        require(used == 1, "used");
        require(pool == 5, "default pool");
        require(boosterUntil == 0, "no booster");
        require(day == block.timestamp / 86400, "day");
    }

    function testNoLivesAfterPoolExhausted() public {
        for (uint64 i = 1; i <= 5; i++) core.chargeLife(P, i);
        vm.expectRevert();
        core.chargeLife(P, 6);
    }

    function testDailyRefill() public {
        for (uint64 i = 1; i <= 5; i++) core.chargeLife(P, i);
        vm.warp(block.timestamp + 1 days + 1);
        core.chargeLife(P, 100);
        (uint16 used,,,) = core.livesOf(P);
        require(used == 1, "refilled");
    }

    function testBoosterMakesLivesUnlimited() public {
        core.activateBooster(P, 72);
        for (uint64 i = 1; i <= 20; i++) core.chargeLife(P, i);
        (uint16 used,, uint64 boosterUntil,) = core.livesOf(P);
        require(used == 0, "no draw while unlimited");
        require(boosterUntil > block.timestamp, "booster set");
    }

    function testRecordPointsBucketAndGlobal() public {
        core.recordPoints(P, LUDO, 100, 1, 42);
        (uint64 purePts, uint64 spendable) = core.bucketOf(P, LUDO);
        require(purePts == 100 && spendable == 100, "bucket");
        (uint64 gp, uint64 gl, uint64 gs) = core.globalsOf(P);
        require(gp == 100 && gl == 100 && gs == 100, "global all tracks");

        core.recordPoints(P, CHESS, 50, 1, 43);
        (uint64 cp,) = core.bucketOf(P, CHESS);
        require(cp == 50, "second bucket");
    }

    function testDuplicateMatchRefReverts() public {
        core.recordPoints(P, LUDO, 100, 1, 42);
        vm.expectRevert();
        core.recordPoints(P, LUDO, 100, 1, 42);
    }

    function testRecordGlobalKind1DoesNotTouchPure() public {
        core.recordGlobal(P, 1, 500, 7);
        (uint64 gp, uint64 gl, uint64 gs) = core.globalsOf(P);
        require(gp == 0, "pure untouched");
        require(gl == 500 && gs == 500, "lifetime + spendable");
    }

    function testSpendLocalAndGlobal() public {
        core.recordPoints(P, LUDO, 100, 1, 42);
        core.spendLocal(P, LUDO, 40);
        (uint64 purePts, uint64 spendable) = core.bucketOf(P, LUDO);
        require(purePts == 100 && spendable == 60, "local spend");
        core.spendGlobal(P, 30);
        (, uint64 gl, uint64 gs) = core.globalsOf(P);
        require(gl == 100 && gs == 70, "global spend");
        vm.expectRevert();
        core.spendGlobal(P, 1000);
    }

    function testPremiumCapsAndIdempotency() public {
        core.creditPremium(P, 5000, 1);
        (uint64 pl, uint64 ps,,) = core.premiumOf(P);
        require(pl == 5000 && ps == 5000, "credited");
        vm.expectRevert();
        core.creditPremium(P, 5000, 1); // duplicate ref
        vm.expectRevert();
        core.creditPremium(P, 2_000_000, 2); // single credit too large
    }

    function testActivatePlanSetsPool() public {
        // Owner-approved ladder 2026-09-19: L0 5 / L1 10 / L2 15 / L3 20.
        core.activatePlan(P, 2, 30);
        (uint16 used, uint16 pool,,) = core.livesOf(P);
        (,, uint8 level, uint64 until) = core.premiumOf(P);
        require(level == 2 && pool == 15 && until > block.timestamp, "plan");
        require(used == 0, "fresh");
        core.activatePlan(P, 3, 30);
        require(_poolOf(P) == 20, "l3 pool");
        vm.expectRevert();
        core.activatePlan(P, 9, 30);
    }

    function _lives(address a) internal view returns (uint16 used, uint16 pool, uint64 booster, uint64 day) {
        return core.livesOf(a);
    }

    function testUpkeepExpiresPlanAndHealsPool() public {
        core.activatePlan(P, 2, 1); // 1-day plan -> pool 15
        require(_poolOf(P) == 15, "before");
        vm.warp(block.timestamp + 2 days);
        core.upkeep(P);
        (,, uint8 level, uint64 until) = core.premiumOf(P);
        uint16 poolAfter = _poolOf(P);
        require(level == 0 && until == 0, "expired");
        require(poolAfter == 5, "pool back to free");
        // Idempotent: a second run changes nothing.
        core.upkeep(P);
        require(_poolOf(P) == 5, "idempotent");
    }

    function _poolOf(address a) internal view returns (uint16 pool) {
        (uint16 used, uint16 p, uint64 booster, uint64 day) = core.livesOf(a);
        used; booster; day;
        return p;
    }

    function testOnlyAdminCanWrite() public {
        vm.prank(BAD);
        vm.expectRevert();
        core.chargeLife(P, 1);
        vm.prank(BAD);
        vm.expectRevert();
        core.recordPoints(P, LUDO, 10, 1, 5);
        vm.prank(BAD);
        vm.expectRevert();
        core.activatePlan(P, 2, 30);
    }

    function testMigratePlayerSetsBalancesAndIsIdempotent() public {
        PlayerCore.MigrationData memory m = PlayerCore.MigrationData({
            tag: LUDO, localPure: 1810, localSpendable: 1810,
            globalPure: 1810, globalLifetime: 6235, globalSpendable: 5235,
            premiumLifetime: 12500, premiumSpendable: 6500,
            level: 2, activeUntil: uint64(block.timestamp + 30 days), migrationRef: 999
        });
        core.migratePlayer(P, m);
        (uint64 bp, uint64 bs) = core.bucketOf(P, LUDO);
        (uint64 gp, uint64 gl, uint64 gs) = core.globalsOf(P);
        (uint64 pl, uint64 ps, uint8 lvl,) = core.premiumOf(P);
        require(bp == 1810 && bs == 1810, "bucket");
        require(gp == 1810 && gl == 6235 && gs == 5235, "global");
        require(pl == 12500 && ps == 6500 && lvl == 2, "premium");

        core.migratePlayer(P, m); // re-run must be a no-op
        (gp, gl, gs) = core.globalsOf(P);
        require(gp == 1810 && gl == 6235 && gs == 5235, "idempotent");

        vm.expectRevert();
        PlayerCore.MigrationData memory z = m; z.migrationRef = 0;
        core.migratePlayer(P, z); // ref required
    }
}
