// SPDX-License-Identifier: 0BSD
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/FlyCollection.sol";
import "aigg-porw/mesh/MEPRegistry.sol";
import {FlyDeltaFixtures as FX} from "../lib/aigg-porw/contracts/evm/test/fixtures/FlyDeltaFixtures.sol";

/// a bred token's seed comes from a block hash; the fixture child was derived with seed 101, so the test pins it
contract FlyCollectionHarness is FlyCollection {
    constructor(bytes32 f, bytes32 m, bytes32 g, uint32 n, uint256 p, uint256 b, uint256 fee, address t, IMEPRegistry meps, IInstanceBonding i, LineageRegistry l) FlyCollection(f, m, g, n, p, b, fee, t, meps, i, l, bytes32(0), bytes32(0)) {}
    function setSeed(uint256 id, bytes32 seed) external { individuals[id].seed = seed; }
}

/// The collection with a lineage registry: both genesis individuals are founders of the fixture lineage (one base plays
/// both sexes here, which is the same-base case), their child is the fixture child.
contract FlyCollectionLineageTest is Test {
    FlyCollectionHarness c; MEPRegistry meps; LineageRegistry R; FlyDeltaRecordVerifier V;
    address alice = address(0xA11CE); address treasury = address(0x7EA); address sink = address(0x51);
    uint256 constant PRICE = 0.06 ether; uint256 constant FEE = 0.01 ether; uint256 constant BOND = 0.02 ether; uint64 constant WINDOW = 100;

    function leaf(uint32 i, uint8 sex, bytes32 d) internal pure returns (bytes32) { return keccak256(abi.encode(i, sex, d)); }
    function root() internal pure returns (bytes32) { bytes32 a = leaf(0, 0, FX.DELTA_ID_A); bytes32 b = leaf(1, 1, FX.DELTA_ID_B); return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a)); }
    function proofFor(uint32 i) internal pure returns (bytes32[] memory p) { p = new bytes32[](1); p[0] = i == 0 ? leaf(1, 1, FX.DELTA_ID_B) : leaf(0, 0, FX.DELTA_ID_A); }
    function mep(bytes32 modelId) internal pure returns (IMEPRegistry.MEP memory) { return IMEPRegistry.MEP({ modelId: modelId, schemeDigest: SCHEME_SKETCH_TILE_KECCAK_V2, execKind: keccak256("aigg:exec:int-lif:v1"), neurons: 3000, synapses: 30000, synapseRoot: keccak256(abi.encode("syn", modelId)), weightsDA: bytes("gnfd://aigg-brains/x.delta") }); }
    function _final(bytes memory delta, bytes32 modelId) internal { vm.prank(alice); bytes32 id = R.register{value: BOND}(delta, modelId); vm.roll(block.number + WINDOW + 1); R.finalize(id); }

    function setUp() public {
        meps = new MEPRegistry(); V = new FlyDeltaRecordVerifier(); R = new LineageRegistry(V, BOND, WINDOW, sink);
        c = new FlyCollectionHarness(FX.ROOT_BASE, FX.ROOT_BASE, root(), 2, PRICE, 0, FEE, treasury, IMEPRegistry(address(meps)), IInstanceBonding(address(0)), R);
        vm.deal(alice, 10 ether); R.registerBase(FX.ROOT_BASE, FX.tile_base_static(), FX.proof_base_static());
    }

    function test_a_genesis_individual_registers_only_with_its_final_model_id() public {
        vm.prank(alice); uint256 f = c.mint{value: PRICE}(0, 0, FX.DELTA_ID_A, proofFor(0));
        vm.prank(alice); vm.expectRevert(bytes("use registerDerived")); c.register(f, FX.DELTA_ID_A, mep(FX.ROOT_A));
        vm.prank(alice); vm.expectRevert(bytes("not final")); c.registerDerived(f, FX.deltaFounderA(), mep(FX.ROOT_A)); // nobody has declared it yet
        vm.prank(alice); R.register{value: BOND}(FX.deltaFounderA(), FX.ROOT_A);
        vm.prank(alice); vm.expectRevert(bytes("not final")); c.registerDerived(f, FX.deltaFounderA(), mep(FX.ROOT_A)); // declared, still challengeable
        vm.roll(block.number + WINDOW + 1); R.finalize(FX.DELTA_ID_A);
        vm.prank(alice); vm.expectRevert(bytes("model id")); c.registerDerived(f, FX.deltaFounderA(), mep(FX.ROOT_B)); // final, but not as this model
        vm.prank(alice); vm.expectRevert(bytes("delta")); c.registerDerived(f, FX.deltaFounderB(), mep(FX.ROOT_B)); // not the delta this token was minted with
        vm.prank(alice); bytes32 mepId = c.registerDerived(f, FX.deltaFounderA(), mep(FX.ROOT_A));
        (,, bytes32 modelId, bytes32 stored,,,,,) = c.individuals(f); assertEq(modelId, FX.ROOT_A); assertEq(stored, mepId); assertTrue(meps.exists(mepId));
    }
    function test_a_bred_individual_must_carry_the_recipe_the_contract_recorded() public {
        vm.startPrank(alice); uint256 f = c.mint{value: PRICE}(0, 0, FX.DELTA_ID_A, proofFor(0)); uint256 m = c.mint{value: PRICE}(1, 1, FX.DELTA_ID_B, proofFor(1)); vm.stopPrank();
        _final(FX.deltaFounderA(), FX.ROOT_A); _final(FX.deltaFounderB(), FX.ROOT_B);
        vm.prank(alice); uint256 kid = c.breed{value: FEE}(f, m); _final(FX.deltaChild(), FX.ROOT_C);
        vm.prank(alice); vm.expectRevert(bytes("seed")); c.registerDerived(kid, FX.deltaChild(), mep(FX.ROOT_C)); // the recipe's seed is the contract's, not the owner's
        c.setSeed(kid, bytes32(uint256(101))); // (test only) the seed the fixture child was derived with
        vm.prank(alice); bytes32 mepId = c.registerDerived(kid, FX.deltaChild(), mep(FX.ROOT_C));
        (bytes32 base, bytes32 dh, bytes32 modelId, bytes32 stored,,,,,) = c.individuals(kid);
        assertEq(base, FX.ROOT_BASE); assertEq(dh, FX.DELTA_ID_CHILD); assertEq(modelId, FX.ROOT_C); assertEq(stored, mepId);
    }
    function test_a_recipe_naming_other_parents_is_refused() public {
        vm.startPrank(alice); uint256 f = c.mint{value: PRICE}(0, 0, FX.DELTA_ID_A, proofFor(0)); uint256 m = c.mint{value: PRICE}(1, 1, FX.DELTA_ID_B, proofFor(1)); vm.stopPrank();
        _final(FX.deltaFounderA(), FX.ROOT_A); _final(FX.deltaFounderB(), FX.ROOT_B);
        vm.prank(alice); uint256 kid = c.breed{value: FEE}(m, f); // the same two parents, the other way round
        _final(FX.deltaChild(), FX.ROOT_C); c.setSeed(kid, bytes32(uint256(101)));
        vm.prank(alice); vm.expectRevert(bytes("parents")); c.registerDerived(kid, FX.deltaChild(), mep(FX.ROOT_C)); // the fixture child is A x B, this token is B x A
    }
    function test_breeding_needs_parents_whose_deltas_are_known() public {
        vm.startPrank(alice); uint256 f = c.mint{value: PRICE}(0, 0, FX.DELTA_ID_A, proofFor(0)); uint256 m = c.mint{value: PRICE}(1, 1, FX.DELTA_ID_B, proofFor(1)); uint256 kid = c.breed{value: FEE}(f, m); vm.stopPrank();
        (,,,, uint8 sex,,,,) = c.individuals(kid); uint256 mate = sex == 0 ? m : f; // the unregistered kid has no delta yet
        vm.prank(alice); vm.expectRevert(bytes("parents must have their deltas claimed")); c.breed{value: FEE}(kid, mate);
    }
}
