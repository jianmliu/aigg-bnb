// SPDX-License-Identifier: 0BSD
pragma solidity ^0.8.20;
import "./SynchronousDisputes.t.sol";
import {LifMeshFixtures as FX} from "../lib/aigg-porw/contracts/evm/test/fixtures/LifMeshFixtures.sol";

interface IRunView {
    function hasOpenedRun(bytes32, address) external view returns (bool);
}

contract SynchronousLifBatchTest is SynchronousDisputesTest {
    function configureLif() internal {
        IMEPRegistry meps = SynchronousTaskMarket(address(market)).meps();
        vm.mockCall(
            address(meps),
            abi.encodeWithSelector(meps.getMEP.selector),
            abi.encode(
                IMEPRegistry.MEP(
                    FX.MODEL_ID, FX.SCHEME_DIGEST, FX.EXEC_KIND, FX.NEURONS, FX.SYNAPSES, FX.SYNAPSE_ROOT, hex""
                )
            )
        );
        vm.mockCall(address(meps), abi.encodeWithSelector(meps.lifWeightUnit.selector), abi.encode(uint32(32768)));
    }

    function lifTask() internal view returns (ITaskMarket.Task memory t) {
        t = FX.task();
        t.mepId = mid;
        t.fee = 101;
        t.deadline = 0;
        t.redundancy = 2;
    }

    function lifDisagree(bool batch) internal returns (bytes32 id) {
        configureLif();
        ITaskMarket.Task memory t = lifTask();
        (ITaskMarket.Result memory ra,) = FX.resultA0();
        (ITaskMarket.Result memory rb,) = FX.resultB0();
        if (batch) {
            t.stimulusSeed = 0;
            bytes32 l0 = PorwMeshHash.runLeaf(0, FX.STIMULUS_SEED, FX.INIT_STATE_ROOT);
            bytes32 l1 = PorwMeshHash.runLeaf(1, FX.STIMULUS_SEED, FX.INIT_STATE_ROOT);
            t.initStateRoot = keccak256(abi.encodePacked(l0, l1));
            id = SynchronousTaskMarket(address(market)).postBatch{value: 101}(t, 2, bytes32(0));
            bytes32 ar = keccak256(
                abi.encodePacked(PorwMeshHash.runResultLeaf(0, ra.execRoot), PorwMeshHash.runResultLeaf(1, ra.execRoot))
            );
            bytes32 br = keccak256(
                abi.encodePacked(PorwMeshHash.runResultLeaf(0, rb.execRoot), PorwMeshHash.runResultLeaf(1, ra.execRoot))
            );
            commit(id, a, 11, PorwMeshHash.batchDigest(ar), ar);
            commit(id, b, 12, PorwMeshHash.batchDigest(br), br);
            reveal(id, a, 11, PorwMeshHash.batchDigest(ar), ar);
            reveal(id, b, 12, PorwMeshHash.batchDigest(br), br);
            vm.prank(a);
            game.postChildren(
                id, PorwMeshHash.runResultLeaf(0, ra.execRoot), PorwMeshHash.runResultLeaf(1, ra.execRoot)
            );
            vm.prank(b);
            game.postChildren(
                id, PorwMeshHash.runResultLeaf(0, rb.execRoot), PorwMeshHash.runResultLeaf(1, ra.execRoot)
            );
            bytes32[] memory proof = new bytes32[](1);
            proof[0] = l1;
            assertFalse(IRunView(address(game)).hasOpenedRun(id, a));
            vm.prank(a);
            game.openRun(id, ra.execRoot, FX.STIMULUS_SEED, FX.INIT_STATE_ROOT, proof);
            assertTrue(IRunView(address(game)).hasOpenedRun(id, a));
            vm.prank(b);
            game.openRun(id, rb.execRoot, FX.STIMULUS_SEED, FX.INIT_STATE_ROOT, proof);
        } else {
            id = market.postTask{value: 101}(t, bytes32(0));
            commit(id, a, 11, ra.execDigest, ra.execRoot);
            commit(id, b, 12, rb.execDigest, rb.execRoot);
            reveal(id, a, 11, ra.execDigest, ra.execRoot);
            reveal(id, b, 12, rb.execDigest, rb.execRoot);
        }
    }

    function finishProof(bytes32 id) internal {
        vm.prank(a);
        game.revealRoots(id, FX.segRootsA());
        vm.prank(b);
        game.revealRoots(id, FX.segRootsB2());
        vm.prank(a);
        game.postStepRoots(id, FX.stepRootsA());
        vm.prank(b);
        game.postStepRoots(id, FX.stepRootsB2());
        bytes32[] memory pa = FX.pairsA2Flat();
        bytes32[] memory pb = FX.pairsB2Flat();
        for (uint256 j; j < FX.ROUNDS; j++) {
            vm.prank(a);
            game.postChildren(id, pa[2 * j], pa[2 * j + 1]);
            vm.prank(b);
            game.postChildren(id, pb[2 * j], pb[2 * j + 1]);
        }
        LifRowCheck.State memory sa = FX.stateA();
        LifRowCheck.State memory sb = FX.stateB2();
        vm.prank(a);
        game.postRowLif(id, sa.v, sa.g, sa.refr, sa.flags, sa.count, FX.sumsA());
        vm.prank(b);
        game.postRowLif(id, sb.v, sb.g, sb.refr, sb.flags, sb.count, FX.sumsB2Lied());
        game.proveSynapseTermLif(
            id,
            IExecutionDisputes.LifTermProof(
                FX.K_STAR,
                FX.CSR_ROOT,
                FX.ROW_ROOT,
                IExecutionDisputes.RowBounds(FX.ROW_START, FX.rowStartProof(), FX.ROW_END, FX.rowEndProof()),
                IExecutionDisputes.ChunkOpening(FX.CHUNK_C, FX.chunkRecords(), FX.chunkProof()),
                FX.selfOpening(),
                FX.preOpening()
            )
        );
    }

    function test_objectiveFraudSlashesToPullCreditDespiteRejectingWinner() public {
        bytes32 id = lifDisagree(false);
        vm.etch(a, hex"60006000fd");
        finishProof(id);
        (uint8 st,,,) = market.sessionState(id);
        assertEq(st, 4);
        assertEq(ins.bonded(b), 0.9 ether);
        assertEq(game.slashCredits(a), 0.1 ether);
        assertEq(ins.disputeHolds(a), 0);
        vm.prank(a);
        game.withdrawSlash(payable(address(0xCAFE)));
        assertEq(address(0xCAFE).balance, 0.1 ether);
    }

    function test_batchRunOpeningThenObjectiveProof() public {
        bytes32 id = lifDisagree(true);
        finishProof(id);
        (uint8 st,,,) = market.sessionState(id);
        assertEq(st, 4);
        assertEq(game.slashCredits(a), 0.1 ether);
    }
}
