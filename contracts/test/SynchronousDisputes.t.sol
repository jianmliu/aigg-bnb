// SPDX-License-Identifier: 0BSD
pragma solidity ^0.8.20;
import "./SynchronousVerification.t.sol";
import "../src/SynchronousExecutionDisputes.sol";

interface IForwardSync {
    function moveDigest(bytes32, address, uint8, uint256, uint256, uint64, bytes32) external view returns (bytes32);
    function forwardMove(bytes32, address, uint8, uint256, uint256, uint64, bytes calldata, bytes calldata) external;
    function moveNonce(bytes32, address) external view returns (uint256);
}

contract SynchronousDisputesTest is SynchronousVerificationTest {
    SynchronousExecutionDisputes game;

    function wireDispute(IMEPRegistry meps) internal override returns (address) {
        game = new SynchronousExecutionDisputes(meps, ins, SynchronousTaskMarket(address(market)), 5, 0.1 ether);
        ins.setSlasher(address(game), true);
        return address(game);
    }

    function mismatch() internal returns (bytes32 id) {
        id = post();
        bytes32 x = keccak256("x");
        bytes32 y = keccak256("y");
        commit(id, a, 11, x, x);
        commit(id, b, 12, y, y);
        reveal(id, a, 11, x, x);
        reveal(id, b, 12, y, y);
    }

    function test_disputeOwnsNoDuplicateHolds() public {
        mismatch();
        assertEq(ins.disputeHolds(a), 1);
        assertEq(ins.disputeHolds(b), 1);
    }

    function test_bothSilentDisputeExpiresWithoutSlashing() public {
        bytes32 id = mismatch();
        vm.roll(block.number + 6);
        game.timeout(id);
        (uint8 st,,,) = market.sessionState(id);
        assertEq(st, 5);
        assertEq(ins.bonded(a), 1 ether);
        assertEq(ins.disputeHolds(a), 0);
        assertEq(market.credits(address(0), address(this)), 101);
    }

    function test_lateRootsRejected() public {
        bytes32 id = mismatch();
        bytes32[] memory roots = new bytes32[](1);
        roots[0] = keccak256("x");
        vm.roll(block.number + 6);
        vm.prank(a);
        vm.expectRevert();
        game.revealRoots(id, roots);
    }

    function test_sponsoredProofBindsPhaseRoundTaskHostAndNonce() public {
        bytes32 id = mismatch();
        bytes32[] memory roots = new bytes32[](1);
        roots[0] = keccak256("x");
        bytes memory data = abi.encodeCall(game.revealRoots, (id, roots));
        IForwardSync f = IForwardSync(address(game));
        uint256 round = game.roundNonce(id);
        uint64 expiry = uint64(block.number + 5);
        bytes memory signature = sig(11, f.moveDigest(id, a, 0, round, 0, expiry, keccak256(data)));
        f.forwardMove(id, a, 0, round, 0, expiry, data, signature);
        assertEq(f.moveNonce(id, a), 1);
        vm.expectRevert();
        f.forwardMove(id, a, 0, round, 0, expiry, data, signature);
    }

    function test_singleNeuronMovesDirectlyToRow() public {
        IMEPRegistry meps = SynchronousTaskMarket(address(market)).meps();
        vm.mockCall(
            address(meps),
            abi.encodeWithSelector(meps.getMEP.selector),
            abi.encode(
                IMEPRegistry.MEP(
                    bytes32(0), bytes32(0), keccak256("aigg:exec:int-spmv-q16:v1"), 1, 0, bytes32(0), hex""
                )
            )
        );
        bytes32 id = mismatch();
        bytes32[] memory roots = new bytes32[](1);
        roots[0] = keccak256("x");
        vm.prank(a);
        game.revealRoots(id, roots);
        roots[0] = keccak256("y");
        vm.prank(b);
        game.revealRoots(id, roots);
        (,,,,,, IExecutionDisputes.Phase phase,,,,,,,,) = game.disputes(id);
        assertEq(uint8(phase), uint8(IExecutionDisputes.Phase.Synapse));
    }

    function test_sponsoredMoveRejectsWrongTaskSelectorSignerAndExpired() public {
        bytes32 id = mismatch();
        IForwardSync f = IForwardSync(address(game));
        uint256 round = game.roundNonce(id);
        uint64 expiry = uint64(block.number + 5);
        bytes32[] memory roots = new bytes32[](1);
        roots[0] = keccak256("x");
        bytes memory data = abi.encodeCall(game.revealRoots, (bytes32(uint256(4)), roots));
        bytes memory signature = sig(11, f.moveDigest(id, a, 0, round, 0, expiry, keccak256(data)));
        vm.expectRevert();
        f.forwardMove(id, a, 0, round, 0, expiry, data, signature);
        data = abi.encodeCall(game.timeout, (id));
        signature = sig(11, f.moveDigest(id, a, 0, round, 0, expiry, keccak256(data)));
        vm.expectRevert();
        f.forwardMove(id, a, 0, round, 0, expiry, data, signature);
        data = abi.encodeCall(game.revealRoots, (id, roots));
        signature = sig(12, f.moveDigest(id, a, 0, round, 0, expiry, keccak256(data)));
        vm.expectRevert();
        f.forwardMove(id, a, 0, round, 0, expiry, data, signature);
        signature = sig(11, f.moveDigest(id, a, 0, round + 1, 0, expiry, keccak256(data)));
        vm.expectRevert();
        f.forwardMove(id, a, 0, round + 1, 0, expiry, data, signature);
        vm.roll(expiry + 1);
        vm.expectRevert();
        f.forwardMove(id, a, 0, round, 0, expiry, data, signature);
        assertEq(f.moveNonce(id, a), 0);
    }

    function test_onePartySilentInDisputeNeverSlashed() public {
        bytes32 id = mismatch();
        bytes32[] memory roots = new bytes32[](1);
        roots[0] = keccak256("x");
        vm.prank(a);
        game.revealRoots(id, roots);
        vm.roll(block.number + 6);
        market.expire(id);
        assertEq(ins.bonded(b), 1 ether);
        (uint8 st,,,) = market.sessionState(id);
        assertEq(st, 5);
        vm.expectRevert();
        game.timeout(id);
    }
}
