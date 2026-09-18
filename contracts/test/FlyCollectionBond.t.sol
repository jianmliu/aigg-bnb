// SPDX-License-Identifier: 0BSD
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/FlyCollection.sol";
import "aigg-porw/mesh/MEPRegistry.sol";
import "aigg-porw/mesh/InstanceRegistry.sol";

/// "One action, one price": with InstanceRegistry.bondFor a mint funds its minter's stake and enrols them for the base brain.
contract FlyCollectionBondTest is Test {
    FlyCollection c; MEPRegistry meps; InstanceRegistry inst; bytes32 baseMep;
    address alice = address(0xA11CE); address treasury = address(0x7EA);
    bytes32 constant BASE_F = keccak256("female-base"); bytes32 constant BASE_M = keccak256("male-base"); bytes32 constant DF = keccak256("delta-female-0"); bytes32 constant DM = keccak256("delta-male-1");
    uint256 constant UNIT = 0.05 ether; uint256 constant PRICE = 0.06 ether; uint256 constant FEE = 0.01 ether;
    function leaf(uint32 i, uint8 sex, bytes32 d) internal pure returns (bytes32) { return keccak256(abi.encode(i, sex, d)); }
    function root() internal pure returns (bytes32) { bytes32 a = leaf(0, 0, DF); bytes32 b = leaf(1, 1, DM); return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a)); }
    function proofFor(uint32 i) internal pure returns (bytes32[] memory p) { p = new bytes32[](1); p[0] = i == 0 ? leaf(1, 1, DM) : leaf(0, 0, DF); }

    function setUp() public {
        meps = new MEPRegistry(); inst = new InstanceRegistry(UNIT, 20);
        baseMep = meps.registerMEP(IMEPRegistry.MEP({ modelId: BASE_F, schemeDigest: SCHEME_SKETCH_TILE_KECCAK_V3, execKind: keccak256("aigg:exec:int-lif:v1"), neurons: 139255, synapses: 2700513, synapseRoot: keccak256("syn"), weightsDA: bytes("gnfd://aigg-brains/base.bin") }));
        c = new FlyCollection(BASE_F, BASE_M, root(), 2, PRICE, UNIT, FEE, treasury, IMEPRegistry(address(meps)), IInstanceBonding(address(inst)), LineageRegistry(address(0)), baseMep, bytes32(0));
        vm.deal(alice, 1 ether);
    }
    function test_one_transaction_owns_an_individual_and_is_a_bonded_instance() public {
        assertFalse(inst.isBondedFor(alice, baseMep));
        vm.prank(alice); uint256 id = c.mint{value: PRICE}(0, 0, DF, proofFor(0));
        assertEq(c.ownerOf(id), alice); assertTrue(inst.isBondedFor(alice, baseMep), "bonded for the base brain by the mint itself"); assertEq(inst.weightOf(alice), 1, "one sortition vote");
        assertEq(inst.bonded(alice), UNIT); assertEq(treasury.balance, PRICE - UNIT, "the rest pays for the mesh"); assertEq(address(c).balance, 0, "the collection holds nothing");
        // the stake is the minter's: they can leave with it, the collection cannot touch it
        vm.prank(alice); inst.requestExit(); vm.roll(block.number + 21); uint256 bal = alice.balance; vm.prank(alice); inst.finalizeExit(); assertEq(alice.balance, bal + UNIT);
    }
    function test_a_base_without_a_mep_bonds_without_enrolling() public {
        vm.prank(alice); c.mint{value: PRICE}(1, 1, DM, proofFor(1)); // the male base's MEP was left unset
        assertEq(inst.bonded(alice), UNIT); assertFalse(inst.isBondedFor(alice, baseMep));
    }
}
