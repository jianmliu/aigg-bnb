// SPDX-License-Identifier: 0BSD
pragma solidity ^0.8.20;
import "forge-std/Test.sol";
import "../src/SynchronousTaskMarket.sol";
import "aigg-porw/mesh/HostCapacity.sol";

interface ISync {
    function setReady(bool) external;
    function ready(address) external view returns (bool);
    function pendingTask(address) external view returns (bytes32);
    function setDisputes(address) external;
    function setHostCapacity(address) external;
    function postTask(ITaskMarket.Task calldata, bytes32) external payable returns (bytes32);
    function commitResult(bytes32, address, bytes32, bytes calldata) external;
    function revealResult(bytes32, address, ITaskMarket.Result calldata, bytes32, bytes calldata) external;
    function resultCommitment(bytes32, address, bytes32, bytes32, bytes32) external view returns (bytes32);
    function commitmentDigest(bytes32, address, bytes32) external view returns (bytes32);
    function resultDigest(bytes32, address, bytes32, bytes32) external view returns (bytes32);
    function sessionState(bytes32) external view returns (uint8, uint64, uint64, uint64);
    function credits(address, address) external view returns (uint256);
    function expire(bytes32) external;
    function settledDigest(bytes32) external view returns (bytes32);
}

interface IProfileSupport {
    function setProfileSupports(bytes32[] calldata, uint32[] calldata) external;
    function setProfileSupport(bytes32, uint32) external;
    function profileMaxInDegree(bytes32) external view returns (uint32);
}

contract SynchronousVerificationTest is Test {
    ISync market;
    InstanceRegistry ins;
    HostCapacity cap;
    address a;
    address b;
    bytes32 mid = keccak256("mep");

    function setUp() public virtual {
        a = vm.addr(11);
        b = vm.addr(12);
        ins = new InstanceRegistry(1 ether, 5);
        bytes32[] memory mids = new bytes32[](1);
        mids[0] = mid;
        vm.deal(address(this), 100 ether);
        ins.bondFor{value: 1 ether}(a, mids);
        ins.bondFor{value: 1 ether}(b, mids);
        IMEPRegistry meps = IMEPRegistry(address(0x101));
        PoRWClaimManager cm = PoRWClaimManager(address(0x103));
        vm.mockCall(
            address(meps),
            abi.encodeWithSelector(meps.getMEP.selector),
            abi.encode(
                IMEPRegistry.MEP(
                    bytes32(0), bytes32(0), keccak256("aigg:exec:int-spmv-q16:v1"), 2, 0, bytes32(0), hex""
                )
            )
        );
        vm.mockCall(address(meps), abi.encodeWithSelector(meps.lifWeightUnit.selector), abi.encode(uint32(0)));
        vm.mockCall(
            address(meps), abi.encodeWithSelector(meps.termsOf.selector), abi.encode(address(0xBEEF), uint16(1000))
        );
        vm.mockCall(address(cm), abi.encodeWithSelector(cm.currentEpoch.selector), abi.encode(uint64(0)));
        vm.mockCall(address(cm), abi.encodeWithSelector(cm.beacon.selector), abi.encode(bytes32(uint256(1))));
        market = ISync(address(new SynchronousTaskMarket(meps, ins, cm, 5, 5, 500)));
        IProfileSupport(address(market)).setProfileSupport(mid, 8192);
        ins.setSlasher(address(market), true);
        cap = new HostCapacity();
        cap.setMarket(address(market), true);
        market.setHostCapacity(address(cap));
        market.setDisputes(wireDispute(meps));
        vm.prank(a);
        cap.setCapacity(1);
        vm.prank(b);
        cap.setCapacity(1);
        vm.prank(a);
        market.setReady(true);
        vm.prank(b);
        market.setReady(true);
    }

    function wireDispute(IMEPRegistry) internal virtual returns (address) {
        vm.mockCall(address(0xD15), abi.encodeWithSignature("ROUND_BLOCKS()"), abi.encode(uint64(5)));
        return address(0xD15);
    }

    function task() internal view returns (ITaskMarket.Task memory) {
        return ITaskMarket.Task(mid, 1, 1, 1, bytes32(0), 101, 0, 2);
    }

    function post() internal returns (bytes32) {
        return market.postTask{value: 101}(task(), bytes32(0));
    }

    function sig(uint256 key, bytes32 h) internal returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, h);
        return abi.encodePacked(r, s, v);
    }

    function commit(bytes32 id, address host, uint256 key, bytes32 digest, bytes32 root) public {
        bytes32 c = market.resultCommitment(id, host, digest, root, bytes32(key));
        market.commitResult(id, host, c, sig(key, market.commitmentDigest(id, host, c)));
    }

    function reveal(bytes32 id, address host, uint256 key, bytes32 digest, bytes32 root) public {
        market.revealResult(
            id,
            host,
            ITaskMarket.Result(digest, root),
            bytes32(key),
            sig(key, market.resultDigest(id, host, digest, root))
        );
    }

    function test_agreementPaysOnlyAtFinalAndReleasesOnce() public {
        bytes32 id = post();
        assertFalse(market.ready(a));
        assertEq(market.pendingTask(a), id);
        assertEq(ins.disputeHolds(a), 1);
        bytes32 r = keccak256("result");
        commit(id, a, 11, r, r);
        vm.expectRevert();
        this.reveal(id, a, 11, r, r);
        commit(id, b, 12, r, r);
        reveal(id, a, 11, r, r);
        assertEq(market.credits(address(0), a), 0);
        assertEq(cap.activeSlots(a), 1);
        reveal(id, b, 12, r, r);
        (uint8 st,,,) = market.sessionState(id);
        assertEq(st, 4);
        assertEq(market.settledDigest(id), r);
        assertEq(market.credits(address(0), a), 45);
        assertEq(market.credits(address(0), b), 45);
        assertEq(market.credits(address(0), address(this)), 1);
        assertEq(ins.disputeHolds(a), 0);
        assertEq(cap.activeSlots(a), 0);
        assertEq(market.pendingTask(a), bytes32(0));
        vm.expectRevert();
        this.reveal(id, b, 12, r, r);
        vm.expectRevert();
        market.expire(id);
    }

    function test_silenceRefundsNoSlash() public {
        bytes32 id = post();
        bytes32 r = keccak256("result");
        commit(id, a, 11, r, r);
        (, uint64 deadline,,) = market.sessionState(id);
        vm.roll(deadline);
        vm.expectRevert();
        market.expire(id);
        vm.roll(deadline + 1);
        market.expire(id);
        (uint8 st,,,) = market.sessionState(id);
        assertEq(st, 5);
        assertEq(market.credits(address(0), address(this)), 101);
        assertEq(ins.bonded(a), 1 ether);
        assertEq(ins.bonded(b), 1 ether);
        assertEq(ins.disputeHolds(b), 0);
    }

    function test_conflictingDigestsAreInconclusive() public {
        bytes32 id = post();
        bytes32 r = keccak256("result");
        commit(id, a, 11, r, r);
        commit(id, b, 12, bytes32(uint256(2)), r);
        reveal(id, a, 11, r, r);
        reveal(id, b, 12, bytes32(uint256(2)), r);
        (uint8 st,,,) = market.sessionState(id);
        assertEq(st, 5);
        assertEq(market.settledDigest(id), bytes32(0));
    }

    function test_duplicateCommitAndLateRevealFail() public {
        bytes32 id = post();
        bytes32 r = keccak256("result");
        commit(id, a, 11, r, r);
        vm.expectRevert();
        this.commit(id, a, 11, r, r);
        commit(id, b, 12, r, r);
        (,, uint64 deadline,) = market.sessionState(id);
        vm.roll(deadline + 1);
        vm.expectRevert();
        this.reveal(id, a, 11, r, r);
        market.expire(id);
        assertEq(ins.disputeHolds(a), 0);
    }

    function test_exactlyTwoReadyHostsAtomicAssignment() public {
        vm.prank(b);
        market.setReady(false);
        vm.expectRevert();
        post();
        assertTrue(market.ready(a));
        assertEq(ins.disputeHolds(a), 0);
        vm.prank(b);
        market.setReady(true);
        ITaskMarket.Task memory t = task();
        t.redundancy = 1;
        vm.expectRevert();
        market.postTask{value: 101}(t, bytes32(0));
    }

    function test_commitmentBindsHostChainSalt() public {
        bytes32 id = post();
        bytes32 r = keccak256("result");
        commit(id, a, 11, r, r);
        commit(id, b, 12, r, r);
        bytes memory signature = sig(11, market.resultDigest(id, a, r, r));
        vm.expectRevert();
        market.revealResult(id, a, ITaskMarket.Result(r, r), bytes32(uint256(12)), signature);
        assertTrue(market.resultCommitment(id, a, r, r, bytes32(0)) != market.resultCommitment(id, b, r, r, bytes32(0)));
        bytes32 old = market.resultCommitment(id, a, r, r, bytes32(0));
        vm.chainId(block.chainid + 1);
        assertTrue(old != market.resultCommitment(id, a, r, r, bytes32(0)));
    }

    function test_shortSessionCannotRearmReadiness() public {
        address session = vm.addr(99);
        vm.prank(a);
        ins.setSessionKey(session, uint64(block.number + 2));
        vm.prank(session);
        vm.expectRevert();
        market.setReady(true);
    }

    function test_signedReadinessReplayAndDrainInvalidatesOutstandingRearm() public {
        SynchronousTaskMarket m = SynchronousTaskMarket(address(market));
        uint256 nonce = m.readinessNonce(a);
        uint64 end = uint64(block.number + 500);
        bytes memory signature = sig(11, m.readinessDigest(a, true, end, nonce));
        vm.prank(a);
        m.setReady(false);
        vm.expectRevert();
        m.setReadyBySig(a, true, end, nonce, signature);
        assertFalse(m.ready(a));
        nonce = m.readinessNonce(a);
        signature = sig(11, m.readinessDigest(a, true, end, nonce));
        m.setReadyBySig(a, true, end, nonce, signature);
        vm.expectRevert();
        m.setReadyBySig(a, true, end, nonce, signature);
    }

    function test_assignmentRechecksDelegationCoverageAfterReady() public {
        address session = vm.addr(99);
        vm.prank(a);
        ins.setSessionKey(session, uint64(block.number + 511));
        vm.prank(session);
        market.setReady(true);
        vm.roll(block.number + 2);
        vm.expectRevert();
        post();
        assertTrue(market.ready(a));
        assertEq(ins.disputeHolds(a), 0);
    }

    function test_payoutRejectingRecipientCannotUndoTerminal() public {
        bytes32 id = post();
        bytes32 r = keccak256("r");
        commit(id, a, 11, r, r);
        commit(id, b, 12, r, r);
        vm.etch(a, hex"60006000fd");
        reveal(id, a, 11, r, r);
        reveal(id, b, 12, r, r);
        SynchronousTaskMarket m = SynchronousTaskMarket(address(market));
        vm.prank(a);
        vm.expectRevert();
        m.withdrawCredit(address(0), payable(a));
        assertEq(m.credits(address(0), a), 45);
        vm.prank(a);
        m.withdrawCredit(address(0), payable(address(0xCAFE)));
        assertEq(address(0xCAFE).balance, 45);
    }

    function test_unmeasuredProfileCannotBePosted() public {
        IProfileSupport(address(market)).setProfileSupport(mid, 0);
        vm.expectRevert();
        this.tryPost();
        assertTrue(market.ready(a));
    }

    function tryPost() external {
        post();
    }

    function test_profileCertificationBoundAndOwner() public {
        IProfileSupport m = IProfileSupport(address(market));
        vm.expectRevert();
        m.setProfileSupport(mid, 16385);
        vm.prank(a);
        vm.expectRevert();
        m.setProfileSupport(mid, 1);
        m.setProfileSupport(mid, 8192);
        assertEq(m.profileMaxInDegree(mid), 8192);
    }

    function test_profileRevocationDoesNotStrandAdmittedTask() public {
        bytes32 id = post();
        IProfileSupport(address(market)).setProfileSupport(mid, 0);
        bytes32 r = keccak256("r");
        commit(id, a, 11, r, r);
        commit(id, b, 12, r, r);
        reveal(id, a, 11, r, r);
        reveal(id, b, 12, r, r);
        (uint8 st,,,) = market.sessionState(id);
        assertEq(st, 4);
    }

    function test_unknownKindAndUnmeasuredDerivedProfileRejected() public {
        ITaskMarket.Task memory t = task();
        t.mepId = keccak256("derived");
        vm.expectRevert();
        market.postTask{value: 101}(t, bytes32(0));
        IMEPRegistry meps = SynchronousTaskMarket(address(market)).meps();
        vm.mockCall(
            address(meps),
            abi.encodeWithSelector(meps.getMEP.selector),
            abi.encode(IMEPRegistry.MEP(bytes32(0), bytes32(0), keccak256("unsupported"), 2, 1, bytes32(0), hex""))
        );
        vm.expectRevert();
        IProfileSupport(address(market)).setProfileSupport(mid, 2);
        vm.expectRevert();
        this.tryPost();
    }

    function test_batchProfileCertification() public {
        bytes32[] memory ids = new bytes32[](2);
        uint32[] memory degrees = new uint32[](2);
        ids[0] = mid;
        ids[1] = keccak256("second");
        degrees[0] = 16384;
        degrees[1] = 10167;
        IProfileSupport(address(market)).setProfileSupports(ids, degrees);
        assertEq(IProfileSupport(address(market)).profileMaxInDegree(ids[1]), 10167);
    }
}
