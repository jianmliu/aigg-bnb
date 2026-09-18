// SPDX-License-Identifier: 0BSD
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/LineageRegistry.sol";
import {FlyDeltaFixtures as FX} from "../lib/aigg-porw/contracts/evm/test/fixtures/FlyDeltaFixtures.sol";

/// The registry on the fixtures of the verifier: an in-place lineage built by delta.js on a synthetic base (founders A
/// and B, their child, a child whose declared root hides one wrong weight, one with a flipped root-id byte).
contract LineageRegistryTest is Test {
    FlyDeltaRecordVerifier V; LineageRegistry R;
    address alice = address(0xA11CE); address mallory = address(0xBAD); address carol = address(0xCA201); address sink = address(0x51);
    uint256 constant BOND = 0.02 ether; uint64 constant WINDOW = 100;

    function setUp() public {
        V = new FlyDeltaRecordVerifier(); R = new LineageRegistry(V, BOND, WINDOW, sink);
        vm.deal(alice, 1 ether); vm.deal(mallory, 1 ether); vm.deal(carol, 1 ether);
    }
    function _base() internal { R.registerBase(FX.ROOT_BASE, FX.tile_base_static(), FX.proof_base_static()); }
    function _final(address who, bytes memory delta, bytes32 modelId) internal returns (bytes32 id) { vm.prank(who); id = R.register{value: BOND}(delta, modelId); vm.roll(block.number + WINDOW + 1); R.finalize(id); }
    function _one(uint64 idx, bytes memory tile, bytes32[] memory proof) internal pure returns (FlyDeltaRecordVerifier.TileOpening[] memory o) { o = new FlyDeltaRecordVerifier.TileOpening[](1); o[0] = FlyDeltaRecordVerifier.TileOpening(idx, tile, proof); }
    function _founders() internal { _base(); _final(alice, FX.deltaFounderA(), FX.ROOT_A); _final(alice, FX.deltaFounderB(), FX.ROOT_B); }

    function test_a_base_is_proven_from_its_first_tile() public {
        _base(); FlyDeltaRecordVerifier.Lineage memory L = R.baseOf(FX.ROOT_BASE);
        assertEq(L.nTiles, FX.N_TILES); assertEq(L.synOffset, FX.SYN_OFFSET); assertEq(L.synapses, FX.SYNAPSES); assertEq(L.nameLen, FX.NAME_LEN);
        vm.expectRevert(bytes("registered")); R.registerBase(FX.ROOT_BASE, FX.tile_base_static(), FX.proof_base_static());
        vm.expectRevert(bytes("tile 0 proof")); R.registerBase(FX.ROOT_A, FX.tile_base_static(), FX.proof_base_static()); // the base's header under another root
        vm.expectRevert(bytes("tile 0 proof")); R.registerBase(FX.ROOT_C, FX.tile_base_static(), FX.proof_C_static());
    }
    function test_an_honest_lineage_becomes_final_generation_by_generation() public {
        _base();
        vm.prank(alice); bytes32 idA = R.register{value: BOND}(FX.deltaFounderA(), FX.ROOT_A); assertEq(idA, FX.DELTA_ID_A);
        vm.expectRevert(bytes("not final")); R.finalModelId(idA);
        vm.expectRevert(bytes("not finalizable")); R.finalize(idA);
        vm.expectRevert(bytes("parent not final")); vm.prank(alice); R.register{value: BOND}(FX.deltaChild(), FX.ROOT_C); // a child waits for its parents' windows
        uint256 bal = alice.balance; vm.roll(block.number + WINDOW + 1); R.finalize(idA); assertEq(alice.balance, bal + BOND, "bond back"); assertEq(R.finalModelId(idA), FX.ROOT_A);
        _final(alice, FX.deltaFounderB(), FX.ROOT_B);
        bytes32 idC = _final(carol, FX.deltaChild(), FX.ROOT_C); assertEq(idC, FX.DELTA_ID_CHILD); assertEq(R.finalModelId(idC), FX.ROOT_C); assertEq(R.deltaOfModel(FX.ROOT_C), idC);
    }
    function test_an_honest_registration_cannot_be_struck_down() public {
        _founders(); vm.prank(carol); R.register{value: BOND}(FX.deltaChild(), FX.ROOT_C);
        vm.expectRevert(bytes("consistent")); vm.prank(mallory);
        R.challengeRecord(FX.deltaChild(), FX.J_MUTATED, _one(FX.TILE_T, FX.tile_base_T(), FX.proof_base_T()), _one(FX.TILE_T, FX.tile_A_T(), FX.proof_A_T()), _one(FX.TILE_T, FX.tile_B_T(), FX.proof_B_T()), _one(FX.TILE_T, FX.tile_C_T(), FX.proof_C_T()));
        vm.expectRevert(bytes("consistent")); vm.prank(mallory);
        R.challengeStatic(FX.DELTA_ID_CHILD, FlyDeltaRecordVerifier.TileOpening(FX.STATIC_TILE, FX.tile_base_static(), FX.proof_base_static()), FlyDeltaRecordVerifier.TileOpening(FX.STATIC_TILE, FX.tile_C_static(), FX.proof_C_static()));
    }
    function test_a_wrong_model_id_is_struck_down_by_one_record_and_the_recipe_can_be_claimed_again() public {
        _founders(); vm.prank(mallory); bytes32 id = R.register{value: BOND}(FX.deltaChild(), FX.ROOT_W); // one weight off by one
        uint256 bal = carol.balance; uint256 g0 = gasleft(); vm.prank(carol);
        R.challengeRecord(FX.deltaChild(), FX.J_FROMA, _one(FX.TILE_T, FX.tile_base_T(), FX.proof_base_T()), _one(FX.TILE_T, FX.tile_A_T(), FX.proof_A_T()), _one(FX.TILE_T, FX.tile_B_T(), FX.proof_B_T()), _one(FX.TILE_T, FX.tile_W_T(), FX.proof_W_T()));
        emit log_named_uint("gas challengeRecord (fraud, four tiles)", g0 - gasleft());
        assertEq(uint8(R.statusOf(id)), uint8(LineageRegistry.Status.Fraud)); assertEq(carol.balance, bal + BOND / 2, "half the bond to the challenger"); assertEq(sink.balance, BOND - BOND / 2, "half to the sink");
        assertEq(R.deltaOfModel(FX.ROOT_W), bytes32(0)); vm.expectRevert(bytes("not final")); R.finalModelId(id);
        vm.roll(block.number + WINDOW + 1); vm.expectRevert(bytes("not finalizable")); R.finalize(id);
        assertEq(_final(carol, FX.deltaChild(), FX.ROOT_C), id, "the same recipe, now with what it really produces"); assertEq(R.finalModelId(id), FX.ROOT_C);
    }
    function test_a_touched_static_byte_is_struck_down() public {
        _founders(); vm.prank(mallory); bytes32 id = R.register{value: BOND}(FX.deltaChild(), FX.ROOT_S);
        vm.prank(carol); R.challengeStatic(id, FlyDeltaRecordVerifier.TileOpening(FX.STATIC_TILE, FX.tile_base_static(), FX.proof_base_static()), FlyDeltaRecordVerifier.TileOpening(FX.STATIC_TILE, FX.tile_S_static(), FX.proof_S_static()));
        assertEq(uint8(R.statusOf(id)), uint8(LineageRegistry.Status.Fraud));
    }
    function test_windows_bonds_and_squatting() public {
        _founders();
        vm.expectRevert(bytes("bond")); vm.prank(mallory); R.register{value: BOND - 1}(FX.deltaChild(), FX.ROOT_C);
        LineageRegistry fresh = new LineageRegistry(V, BOND, WINDOW, sink); vm.expectRevert(bytes("unknown base")); vm.prank(mallory); fresh.register{value: BOND}(FX.deltaChild(), FX.ROOT_C);
        vm.expectRevert(bytes("in-place cross expected")); vm.prank(mallory); R.register{value: BOND}(FX.deltaCompact(), FX.ROOT_C);
        vm.prank(mallory); bytes32 id = R.register{value: BOND}(FX.deltaChild(), FX.ROOT_W);
        vm.expectRevert(bytes("registered")); vm.prank(carol); R.register{value: BOND}(FX.deltaChild(), FX.ROOT_C); // pending: challenge it first
        vm.expectRevert(bytes("model id taken")); vm.prank(carol); R.register{value: BOND}(FX.deltaFounderA(), FX.ROOT_W);
        vm.roll(block.number + WINDOW + 1); // nobody looked: the wrong claim survives its window, and is then beyond challenge
        vm.expectRevert(bytes("not challengeable")); vm.prank(carol);
        R.challengeRecord(FX.deltaChild(), FX.J_FROMA, _one(FX.TILE_T, FX.tile_base_T(), FX.proof_base_T()), _one(FX.TILE_T, FX.tile_A_T(), FX.proof_A_T()), _one(FX.TILE_T, FX.tile_B_T(), FX.proof_B_T()), _one(FX.TILE_T, FX.tile_W_T(), FX.proof_W_T()));
        R.finalize(id); assertEq(R.finalModelId(id), FX.ROOT_W, "an optimistic scheme is only as good as its watchers");
    }
}
