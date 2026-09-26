// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {FoskaayGGI} from "../src/FoskaayGGI.sol";
import {Deploy} from "./Deploy.sol";

interface Vm {
    function deal(address, uint256) external;
    function prank(address) external;
    function expectRevert() external;
}

/// Upgrade safety for the single core: an upgrade keeps the proxy address and
/// preserves live data, and only the owner can authorize it.
contract UpgradeSafetyTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 constant FEE = 4e14;
    bytes32 constant SID = keccak256("s1");

    function testRegistryUpgradeKeepsAddressAndData() public {
        FoskaayGGI reg = Deploy.registry(address(this), address(0xD357), FEE);
        vm.deal(address(this), 10 ether);
        address[] memory players = new address[](1);
        players[0] = address(0x1);
        reg.handover{value: FEE}(SID, address(0x1234), bytes32("start"), keccak256("seed"), players, players, 0);

        address before = address(reg);
        uint256 feeBefore = reg.fee();
        address destBefore = reg.destination();
        bytes32 commitBefore = reg.commitments(SID);
        uint64 counterBefore = reg.sessionCounter();

        FoskaayGGI impl = new FoskaayGGI();
        reg.upgradeToAndCall(address(impl), "");

        require(address(reg) == before, "address kept");
        require(reg.fee() == feeBefore, "fee kept");
        require(reg.destination() == destBefore, "destination kept");
        require(reg.commitments(SID) == commitBefore, "commitment kept");
        require(reg.sessionCounter() == counterBefore, "counter kept");
        require(reg.isPaid(SID), "paid record kept");
    }

    function testOnlyOwnerCanUpgrade() public {
        FoskaayGGI reg = Deploy.registry(address(this), address(0xD357), FEE);
        FoskaayGGI impl = new FoskaayGGI();
        vm.prank(address(0xBAD));
        vm.expectRevert();
        reg.upgradeToAndCall(address(impl), "");
    }
}
