// SPDX-License-Identifier: 0BSD
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/FlyCollection.sol";
import "aigg-porw/mesh/MEPRegistry.sol";

contract FlyCollectionTest is Test {
    FlyCollection c; MEPRegistry meps;
    address alice = address(0xA11CE); address bob = address(0xB0B); address treasury = address(0x7EA);
    bytes32 constant BASE_F = keccak256("female-base"); bytes32 constant BASE_M = keccak256("male-base");
    bytes32 constant DF = keccak256("delta-female-0"); bytes32 constant DM = keccak256("delta-male-1");
    uint256 constant PRICE = 0.06 ether; uint256 constant FEE = 0.01 ether;

    // a two-leaf genesis set: index 0 female, index 1 male
    function leaf(uint32 i, uint8 sex, bytes32 d) internal pure returns (bytes32) { return keccak256(abi.encode(i, sex, d)); }
    function root() internal pure returns (bytes32) { bytes32 a = leaf(0, 0, DF); bytes32 b = leaf(1, 1, DM); return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a)); }
    function proofFor(uint32 i) internal pure returns (bytes32[] memory p) { p = new bytes32[](1); p[0] = i == 0 ? leaf(1, 1, DM) : leaf(0, 0, DF); }

    function setUp() public {
        meps = new MEPRegistry();
        // MINT_BOND 0: sponsored bonding needs InstanceRegistry.bondFor upstream (see the contract's NOTE)
        c = new FlyCollection(BASE_F, BASE_M, root(), 2, PRICE, 0, FEE, treasury, IMEPRegistry(address(meps)), IInstanceBonding(address(0)), LineageRegistry(address(0)));
        vm.deal(alice, 10 ether); vm.deal(bob, 10 ether);
    }

    function mintF(address who) internal returns (uint256) { vm.prank(who); return c.mint{value: PRICE}(0, 0, DF, proofFor(0)); }
    function mintM(address who) internal returns (uint256) { vm.prank(who); return c.mint{value: PRICE}(1, 1, DM, proofFor(1)); }

    function test_genesis_is_fixed_at_deployment() public {
        uint256 id = mintF(alice);
        assertEq(c.ownerOf(id), alice); assertEq(treasury.balance, PRICE, "the whole price went to the treasury when MINT_BOND is 0");
        (bytes32 base,,,, uint8 sex, uint32 gen,,,) = c.individuals(id);
        assertEq(base, BASE_F); assertEq(sex, 0); assertEq(gen, 0);
        vm.prank(bob); vm.expectRevert(bytes("index")); c.mint{value: PRICE}(0, 0, DF, proofFor(0)); // no minting the same individual twice
        vm.prank(bob); vm.expectRevert(bytes("not in the genesis set")); c.mint{value: PRICE}(1, 1, keccak256("invented"), proofFor(1)); // nor one nobody committed to
        vm.prank(bob); vm.expectRevert(bytes("index")); c.mint{value: PRICE}(2, 0, DF, proofFor(0)); // nor past the end of the set
    }

    function test_breeding_needs_one_of_each_sex_and_the_child_sits_on_one_base() public {
        uint256 f = mintF(alice); uint256 m = mintM(alice);
        vm.prank(alice); vm.expectRevert(bytes("breeding needs one of each sex")); c.breed{value: FEE}(f, f);
        vm.roll(block.number + 1);
        vm.prank(alice); uint256 kid = c.breed{value: FEE}(f, m);
        (bytes32 base, bytes32 dh,,, , uint32 gen, uint64 pa, uint64 pb, bytes32 seed) = c.individuals(kid);
        assertEq(base, BASE_F, "the child is a variant of one base, not a blend of two");
        assertEq(dh, bytes32(0), "the recipe is recorded; the delta is claimed at registration");
        assertTrue(seed != bytes32(0)); assertEq(gen, 1); assertEq(pa, uint64(f)); assertEq(pb, uint64(m));
        assertEq(c.ownerOf(kid), alice); assertEq(treasury.balance, 2 * PRICE + FEE);
    }

    function test_breeding_requires_holding_or_approval_of_both_parents() public {
        uint256 f = mintF(alice); uint256 m = mintM(bob);
        vm.roll(block.number + 1);
        vm.prank(alice); vm.expectRevert(bytes("not authorised")); c.breed{value: FEE}(f, m);
        vm.prank(bob); c.approve(alice, m);
        vm.prank(alice); uint256 kid = c.breed{value: FEE}(f, m);
        assertEq(c.ownerOf(kid), alice, "the breeder keeps the child");
    }

    function test_registration_binds_the_mep_once_and_only_by_the_owner() public {
        uint256 id = mintF(alice);
        IMEPRegistry.MEP memory m = IMEPRegistry.MEP({ modelId: keccak256("applied"), schemeDigest: SCHEME_SKETCH_TILE_KECCAK_V2, execKind: keccak256("aigg:exec:int-lif:v1"),
            neurons: 139255, synapses: 2700513, synapseRoot: keccak256("syn"), weightsDA: bytes("gnfd://aigg-brains/x.bin") });
        vm.prank(bob); vm.expectRevert(bytes("not the owner")); c.register(id, DF, m); // nobody can bind someone else's individual to a dead MEP
        vm.prank(alice); bytes32 mepId = c.register(id, DF, m);
        (,, bytes32 modelId, bytes32 stored,,,,,) = c.individuals(id);
        assertEq(modelId, m.modelId); assertEq(stored, mepId); assertTrue(meps.exists(mepId));
        vm.prank(alice); vm.expectRevert(bytes("already registered")); c.register(id, DF, m);
    }

    function test_transfer_moves_the_subject_and_nothing_else() public {
        uint256 id = mintF(alice);
        vm.prank(alice); c.transferFrom(alice, bob, id);
        assertEq(c.ownerOf(id), bob); assertEq(c.balanceOf(alice), 0); assertEq(c.balanceOf(bob), 1);
        // the bond is an address's, not a token's: there is nothing here that could have moved with it
        vm.prank(alice); vm.expectRevert(bytes("not authorised")); c.transferFrom(bob, alice, id);
    }

    function test_the_price_is_exact_and_the_economics_have_no_admin() public {
        vm.prank(alice); vm.expectRevert(bytes("price")); c.mint{value: PRICE - 1}(0, 0, DF, proofFor(0));
        assertEq(c.MINT_PRICE(), PRICE); assertEq(c.TREASURY(), treasury);
        // every economic parameter is immutable: there is no setter to call
    }
}
