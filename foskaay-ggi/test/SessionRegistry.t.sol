// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {SessionRegistry} from "../src/SessionRegistry.sol";
import {Deploy} from "./Deploy.sol";

interface Vm {
    function deal(address, uint256) external;
    function prank(address) external;
    function expectRevert() external;
    function expectRevert(bytes4) external;
    function sign(uint256, bytes32) external pure returns (uint8 v, bytes32 r, bytes32 s);
    function addr(uint256) external pure returns (address);
}

/// The single core (v7): connect pays the fee straight to the destination and the
/// ONE storage write is both the paid flag and the seed/participant commitment.
/// Free randomness, settle by session-key signatures. There is no FeeVault.
contract SessionRegistryTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 constant FEE = 4e14; // 0.0004 native USDC (18 decimals)
    uint256 constant PK0 = 0xA11CE;
    uint256 constant PK1 = 0xB0B;
    address constant DEST = address(0xBEEF);
    bytes32 constant SID = keccak256("session-1");
    bytes32 constant SEED = keccak256("reveal-me");

    SessionRegistry reg;
    address p0;
    address p1;

    function setUp() public {
        reg = Deploy.registry(address(this), DEST, FEE);
        vm.deal(address(this), 100 ether);
        p0 = vm.addr(PK0);
        p1 = vm.addr(PK1);
    }

    function _players() internal view returns (address[] memory a) {
        a = new address[](2);
        a[0] = p0;
        a[1] = p1;
    }

    function _keys() internal view returns (address[] memory a) {
        return _players();
    }

    function _commit() internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(SEED));
    }

    function _handover() internal {
        reg.handover{value: FEE}(SID, address(0x1234), bytes32("start"), _commit(), _players(), _keys(), 2);
    }

    function _sig(uint256 pk) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, reg.midchainDigest(SID, bytes32("final")));
        return abi.encodePacked(r, s, v);
    }

    function _sigs() internal view returns (bytes[] memory s) {
        s = new bytes[](2);
        s[0] = _sig(PK0);
        s[1] = _sig(PK1);
    }

    function testHandoverPaysFeeAndMarksPaid() public {
        uint256 before = DEST.balance;
        _handover();
        require(DEST.balance == before + FEE, "fee forwarded to destination");
        require(reg.isPaid(SID), "session marked paid");
        require(reg.sessionCounter() == 1, "counter");
        require(reg.commitments(SID) != bytes32(0), "commitment stored");
    }

    function testHandoverWrongFeeReverts() public {
        vm.expectRevert(SessionRegistry.BadFee.selector);
        reg.handover{value: FEE - 1}(SID, address(0x1234), bytes32("start"), _commit(), _players(), _keys(), 2);
    }

    function testDoubleHandoverReverts() public {
        _handover();
        vm.expectRevert(SessionRegistry.BadInput.selector);
        _handover();
    }

    function testSettleVerifiesSeedAndSignatures() public {
        _handover();
        reg.settle(SID, bytes32("final"), SEED, _players(), _keys(), _sigs(), _keys());
        require(reg.settled(SID), "settled");
    }

    function testSettleWrongSeedReverts() public {
        _handover();
        bytes[] memory s = _sigs();
        vm.expectRevert(SessionRegistry.BadReveal.selector);
        reg.settle(SID, bytes32("final"), keccak256("other"), _players(), _keys(), s, _keys());
    }

    function testSettleWrongSignerReverts() public {
        _handover();
        bytes[] memory s = _sigs();
        s[1] = _sig(PK0); // signer set expects p1 here
        vm.expectRevert(SessionRegistry.BadSignature.selector);
        reg.settle(SID, bytes32("final"), SEED, _players(), _keys(), s, _keys());
    }

    function testSettleUnpaidReverts() public {
        bytes[] memory s = _sigs();
        vm.expectRevert(SessionRegistry.FeeNotPaid.selector);
        reg.settle(SID, bytes32("final"), SEED, _players(), _keys(), s, _keys());
    }

    function testSettleTwiceReverts() public {
        _handover();
        bytes[] memory s = _sigs();
        reg.settle(SID, bytes32("final"), SEED, _players(), _keys(), s, _keys());
        vm.expectRevert(SessionRegistry.AlreadySettled.selector);
        reg.settle(SID, bytes32("final"), SEED, _players(), _keys(), s, _keys());
    }

    function testSettleCannotBindDifferentKeys() public {
        // A stranger cannot settle with their own session keys: the commitment
        // binds the exact player/session-key set from handover.
        _handover();
        bytes[] memory s = _sigs();
        address[] memory fake = new address[](2);
        fake[0] = address(0xDEAD);
        fake[1] = address(0xBEEF);
        vm.expectRevert(SessionRegistry.BadReveal.selector);
        reg.settle(SID, bytes32("final"), SEED, _players(), fake, s, _keys());
    }

    function testRandomIsDeterministicAndFree() public {
        bytes32 a = reg.random(SEED, 1);
        bytes32 b = reg.random(SEED, 1);
        require(a == b, "deterministic");
        bytes32[] memory n = reg.randomN(SEED, 1, 2);
        require(n[0] != n[1], "independent streams");
        require(reg.random(SEED, 2) != a, "counter changes the seed");
    }

    function testHandoverManyAndSettleMany() public {
        bytes32[] memory ids = new bytes32[](2);
        ids[0] = keccak256("s-a");
        ids[1] = keccak256("s-b");
        bytes32[] memory startHashes = new bytes32[](2);
        bytes32[] memory commits = new bytes32[](2);
        address[][] memory players = new address[][](2);
        address[][] memory keys = new address[][](2);
        for (uint256 i = 0; i < 2; i++) {
            commits[i] = _commit();
            players[i] = _players();
            keys[i] = _keys();
        }
        uint256 before = DEST.balance;
        reg.handoverMany{value: FEE * 2}(ids, address(0x1234), startHashes, commits, players, keys, 2);
        require(DEST.balance == before + FEE * 2, "batched fee forwarded");

        bytes32[] memory finals = new bytes32[](2);
        bytes32[] memory reveals = new bytes32[](2);
        bytes[][] memory sigs = new bytes[][](2);
        address[][] memory signers = new address[][](2);
        for (uint256 i = 0; i < 2; i++) {
            reveals[i] = SEED;
            signers[i] = _keys();
            bytes[] memory one = new bytes[](1);
            one[0] = _sigFor(ids[i], PK0);
            sigs[i] = one;
            address[] memory oneSigner = new address[](1);
            oneSigner[0] = p0;
            signers[i] = oneSigner;
        }
        reg.settleMany(ids, finals, reveals, players, keys, sigs, signers);
        require(reg.settled(ids[0]) && reg.settled(ids[1]), "both settled");
    }

    function _sigFor(bytes32 id, uint256 pk) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, reg.midchainDigest(id, bytes32(0)));
        return abi.encodePacked(r, s, v);
    }

    function testOnlyOwnerSetters() public {
        vm.prank(p0);
        vm.expectRevert();
        reg.setFee(1);
        reg.setFee(123);
        require(reg.fee() == 123, "fee set");
        reg.setDestination(address(0xCAFE));
        require(reg.destination() == address(0xCAFE), "destination set");
    }
}
