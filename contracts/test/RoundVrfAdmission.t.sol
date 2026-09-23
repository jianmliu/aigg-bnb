// SPDX-License-Identifier: 0BSD
pragma solidity ^0.8.20;
import "./VrfAdmission.t.sol";
import "../src/RoundVrfSynchronousTaskMarket.sol";

contract RoundVrfAdmissionTest is Test {
    ISync market;
    VrfTestToken token;
    RoundVrfSynchronousTaskMarket vrf;
    RoundVrfAdmission controller;
    MockVrfCoordinator coordinator;
    InstanceRegistry ins;
    HostCapacity cap;
    address a;
    address b;
    bytes32 mid = keccak256("mep");

    function setUp() public {
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
        coordinator = new MockVrfCoordinator();
        token = new VrfTestToken();
        address[] memory tokens = new address[](2);
        tokens[1] = address(token);
        uint256[] memory fees = new uint256[](2);
        fees[0] = 7;
        fees[1] = 9;
        VrfAdmission.Config memory cfg = VrfAdmission.Config(
            address(coordinator), bytes32(uint256(1)), 1, 3, 200000, true, 20, 4, 100, address(0xFEE)
        );
        vrf = new RoundVrfSynchronousTaskMarket(meps, ins, cm, 5, 5, 500, cfg, tokens, fees, 10, 64);
        controller = vrf.admission();
        market = ISync(address(vrf));
        ins.setSlasher(address(controller), true);
        IProfileSupport(address(market)).setProfileSupport(mid, 8192);
        ins.setSlasher(address(market), true);
        cap = new HostCapacity();
        cap.setMarket(address(market), true);
        cap.setMarket(address(controller), true);
        market.setHostCapacity(address(cap));
        market.setDisputes(wireDispute(meps));
        vm.prank(a);
        cap.setCapacity(64);
        vm.prank(b);
        cap.setCapacity(64);
        vm.prank(a);
        market.setReady(true);
        vm.prank(b);
        market.setReady(true);
    }

    function wireDispute(IMEPRegistry) internal returns (address) {
        vm.mockCall(address(0xD15), abi.encodeWithSignature("ROUND_BLOCKS()"), abi.encode(uint64(5)));
        return address(0xD15);
    }

    function task() internal view returns (ITaskMarket.Task memory) {
        return ITaskMarket.Task(mid, 1, 1, 1, bytes32(0), 101, 0, 2);
    }

    function post() internal returns (bytes32) {
        return market.postTask{value: 108}(task(), bytes32(0));
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

    function fulfill(bytes32 id, uint256 word) internal {
        (uint256 req,,,,,,) = controller.requestInfo(id);
        coordinator.fulfill(VrfAdmission(address(controller)), req, word);
    }

    function arm(address h) internal {
        vm.prank(h);
        market.setReady(true);
    }

    function addHost(uint256 key) internal returns (address h) {
        h = vm.addr(key);
        bytes32[] memory mids = new bytes32[](1);
        mids[0] = mid;
        ins.bondFor{value: 1 ether}(h, mids);
        vm.prank(h);
        cap.setCapacity(64);
        arm(h);
    }

    function seal(bytes32 id) internal {
        uint256 round = controller.taskRound(id);
        (uint64 close,,,,,,) = controller.roundInfo(round);
        vm.roll(close);
        vrf.sealRound(round);
    }

    function second() internal returns (bytes32) {
        return market.postTask{value: 108}(task(), bytes32(uint256(2)));
    }

    function test_sharedRoundFixedCloseAndOneRequest() public {
        bytes32 x = post();
        bytes32 y = second();
        assertEq(controller.taskRound(x), controller.taskRound(y));
        assertEq(coordinator.count(), 0);
        (,,,,, uint8 state,) = controller.requestInfo(x);
        assertEq(state, 5);
        assertEq(vrf.pendingTasks(a).length, 2);
        assertEq(cap.activeSlots(a), 2);
        uint256 rid = controller.taskRound(x);
        vm.expectRevert();
        vrf.sealRound(rid);
        seal(x);
        assertEq(coordinator.count(), 1);
        assertFalse(vrf.ready(a));
        vm.expectRevert();
        vrf.sealRound(rid);
        vm.expectRevert();
        market.postTask{value: 108}(task(), bytes32(uint256(3)));
        fulfill(x, 33);
        vrf.allocate(y);
        vrf.allocate(x);
        (uint256 rx,,,,,,) = controller.requestInfo(x);
        (uint256 ry,,,,,,) = controller.requestInfo(y);
        assertEq(rx, ry);
        assertEq(vrf.admissionVersion(), 3);
    }

    function test_independentMembershipOutOfOrderSettlementAndAccounting() public {
        bytes32 x = post();
        bytes32 y = second();
        seal(x);
        fulfill(x, 33);
        vrf.allocate(x);
        vrf.allocate(y);
        bytes32 d = keccak256("r");
        commit(y, a, 11, d, d);
        commit(y, b, 12, d, d);
        reveal(y, a, 11, d, d);
        reveal(y, b, 12, d, d);
        assertTrue(vrf.hasPendingTask(x, a));
        assertFalse(vrf.hasPendingTask(y, a));
        assertEq(vrf.pendingTasks(a).length, 1);
        assertEq(cap.activeSlots(a), 1);
        assertEq(ins.disputeHolds(a), 1);
        commit(x, a, 11, d, d);
        commit(x, b, 12, d, d);
        reveal(x, a, 11, d, d);
        reveal(x, b, 12, d, d);
        assertEq(cap.activeSlots(a), 0);
        assertEq(ins.disputeHolds(a), 0);
        assertEq(vrf.pendingTasks(a).length, 0);
        assertEq(vrf.credits(address(0), a), 90);
        assertEq(vrf.credits(address(0), address(this)), 10);
        assertEq(vrf.credits(address(0), address(0xFEE)), 6);
    }

    function test_capacityRefusalAndCollectingTimeoutRefund() public {
        vm.prank(a);
        cap.setCapacity(1);
        vm.prank(b);
        cap.setCapacity(1);
        bytes32 x = post();
        vm.expectRevert();
        second();
        (, uint64 deadline,,,,,) = controller.requestInfo(x);
        vm.roll(deadline + 1);
        market.expire(x);
        assertEq(coordinator.count(), 0);
        assertEq(cap.activeSlots(a), 0);
        assertEq(ins.disputeHolds(a), 0);
        assertEq(vrf.credits(address(0), address(this)), 108);
        assertEq(vrf.credits(address(0), address(0xFEE)), 0);
        uint256 rid = controller.taskRound(x);
        vm.expectRevert();
        vrf.sealRound(rid);
    }

    function test_oneTaskRoundKeepsFullFeeAfterVrfRequest() public {
        bytes32 x = post();
        assertEq(vrf.credits(address(0), address(0xFEE)), 0);
        seal(x);
        (, uint64 deadline,,,,,) = controller.requestInfo(x);
        vm.roll(deadline + 1);
        market.expire(x);
        assertEq(vrf.credits(address(0), address(this)), 101);
        assertEq(vrf.credits(address(0), address(0xFEE)), 7);
    }

    function test_batchShareMatchesRoundSizeEvenIfTasksFinishOutOfOrder() public {
        bytes32 x = post();
        bytes32 y = second();
        bytes32 z = market.postTask{value: 108}(task(), bytes32(uint256(3)));
        seal(x);
        (, uint64 deadline,,,,,) = controller.requestInfo(x);
        vm.roll(deadline + 1);
        market.expire(z);
        market.expire(x);
        market.expire(y);
        assertEq(vrf.credits(address(0), address(this)), 318);
        assertEq(vrf.credits(address(0), address(0xFEE)), 6);
    }

    function test_duplicateCallbackCannotRerollAndClockFixed() public {
        bytes32 x = post();
        bytes32 y = second();
        seal(x);
        fulfill(x, 33);
        (,,, uint64 activation,,,) = controller.requestInfo(x);
        uint256 snap = vm.snapshotState();
        vrf.allocate(y);
        address[] memory expected = vrf.executors(y);
        vm.revertToState(snap);
        fulfill(x, 999);
        vrf.allocate(y);
        assertEq(vrf.executors(y)[0], expected[0]);
        (, uint64 cd, uint64 rd, uint64 td) = market.sessionState(y);
        assertEq(cd, activation + 5);
        assertEq(rd, activation + 10);
        assertEq(td, activation + 510);
        vm.roll(activation + 1);
        market.expire(x);
        assertTrue(vrf.hasPendingTask(y, a));
        assertEq(coordinator.count(), 1);
    }

    function test_ownerRevokeAfterKeyRevocationPreservesRouting() public {
        address signer = vm.addr(55);
        vm.prank(a);
        ins.setSessionKey(signer, uint64(block.number + 1000));
        vm.prank(signer);
        market.setReady(true);
        bytes32 x = post();
        vm.prank(a);
        ins.revokeSessionKey(signer);
        vm.prank(a);
        market.setReady(false);
        assertFalse(vrf.ready(a));
        assertEq(vrf.taskSigner(x, a), signer);
        assertEq(vrf.readinessSigner(a), signer);
        assertTrue(vrf.hasPendingTask(x, a));
    }

    function test_tokenFeesAndTimeoutAfterRequest() public {
        vrf.setTokenAllowed(address(token), true);
        token.mint(address(this), 1000);
        token.approve(address(vrf), 1000);
        vm.prank(a);
        vrf.setAcceptedToken(address(token), true);
        vm.prank(b);
        vrf.setAcceptedToken(address(token), true);
        bytes32 x = vrf.postTokenTask(task(), address(token), bytes32(0));
        bytes32 y = vrf.postTokenTask(task(), address(token), bytes32(uint256(2)));
        seal(x);
        (, uint64 end,,,,,) = controller.requestInfo(x);
        vm.roll(end + 1);
        market.expire(y);
        market.expire(x);
        assertEq(token.balanceOf(address(vrf)), 220);
        assertEq(vrf.credits(address(token), address(this)), 212);
        assertEq(vrf.credits(address(token), address(0xFEE)), 8);
        fulfill(x, 44);
        (,,,,, uint8 state,) = controller.requestInfo(x);
        assertEq(state, 4);
        assertEq(cap.activeSlots(a), 0);
    }

    function test_disputedHeadDoesNotBlockSecondTask() public {
        bytes32 x = post();
        bytes32 y = second();
        seal(x);
        fulfill(x, 42);
        vrf.allocate(x);
        vrf.allocate(y);
        bytes32 d = keccak256("d");
        bytes32 other = keccak256("other");
        vm.mockCall(address(0xD15), abi.encodeWithSignature("openDispute(bytes32,address,address)", x, a, b), bytes(""));
        vm.mockCall(address(0xD15), abi.encodeWithSignature("openDispute(bytes32,address,address)", x, b, a), bytes(""));
        commit(x, a, 11, d, d);
        commit(x, b, 12, other, other);
        reveal(x, a, 11, d, d);
        reveal(x, b, 12, other, other);
        (uint8 st,,,) = market.sessionState(x);
        assertEq(st, 3);
        commit(y, a, 11, d, d);
        commit(y, b, 12, d, d);
        reveal(y, a, 11, d, d);
        reveal(y, b, 12, d, d);
        assertTrue(vrf.hasPendingTask(x, a));
        assertFalse(vrf.hasPendingTask(y, a));
        vm.prank(address(0xD15));
        vrf.onDisputeResolved(x, b, a);
        assertEq(cap.activeSlots(a), 0);
    }

    function test_snapshotsUnchangedAfterWeightExitAndReadinessChanges() public {
        address c = addHost(13);
        bytes32 x = post();
        bytes32 y = second();
        seal(x);
        uint256 locked = vm.snapshotState();
        fulfill(x, 123);
        vrf.allocate(y);
        address[] memory expected = vrf.executors(y);
        vm.revertToState(locked);
        bytes32[] memory mids = new bytes32[](1);
        mids[0] = mid;
        ins.bondFor{value: 10 ether}(c, mids);
        vm.prank(a);
        market.setReady(false);
        vm.prank(b);
        cap.setCapacity(0);
        vm.prank(c);
        ins.requestExit();
        fulfill(x, 123);
        vrf.allocate(y);
        assertEq(vrf.executors(y)[0], expected[0]);
        assertEq(vrf.executors(y)[1], expected[1]);
        assertEq(controller.candidates(y)[2].weight, 1);
    }

    function test_maximumRoundAndBoundedCallbackAndReleaseGas() public {
        bytes32[] memory ids = new bytes32[](64);
        for (uint256 j; j < 64; j++) {
            ids[j] = market.postTask{value: 108}(task(), bytes32(j));
        }
        assertEq(vrf.pendingTasks(a).length, 64);
        assertEq(cap.activeSlots(a), 64);
        assertFalse(vrf.ready(a));
        vm.expectRevert();
        market.postTask{value: 108}(task(), bytes32(uint256(65)));
        seal(ids[0]);
        uint256 before = gasleft();
        fulfill(ids[0], 42);
        uint256 used = before - gasleft();
        emit log_named_uint("64 task callback gas", used);
        assertLt(used, 100000);
        vrf.allocate(ids[63]);
        assertTrue(vrf.hasPendingTask(ids[63], a));
        (,,, uint64 deadline,,,) = controller.requestInfo(ids[0]);
        vm.roll(deadline + 1);
        before = gasleft();
        market.expire(ids[31]);
        used = before - gasleft();
        assertLt(used, 1000000);
        assertEq(vrf.pendingTasks(a).length, 63);
        assertTrue(vrf.hasPendingTask(ids[63], a));
        assertLt(address(vrf).code.length, 24577);
        assertLt(address(controller).code.length, 24577);
    }

    function test_boundarySealAndCallbackLateIgnoringAndEmptyRound() public {
        vm.expectRevert();
        vrf.sealRound(0);
        bytes32 x = post();
        (, uint64 deadline,,,,,) = controller.requestInfo(x);
        uint256 rid = controller.taskRound(x);
        vm.roll(deadline);
        vrf.sealRound(rid);
        fulfill(x, 0);
        (,, uint64 at, uint64 allocation,,,) = controller.requestInfo(x);
        assertEq(at, deadline);
        assertEq(allocation, deadline + 4);
        vm.roll(allocation);
        vrf.allocate(x);
        (, uint64 cd,, uint64 end) = market.sessionState(x);
        assertEq(end, deadline + 514);
        vm.roll(cd + 1);
        market.expire(x);
        arm(a);
        arm(b);
        bytes32 y = second();
        seal(y);
        (, deadline,,,,,) = controller.requestInfo(y);
        vm.roll(deadline + 1);
        fulfill(y, 44);
        (,,,,, uint8 st,) = controller.requestInfo(y);
        assertEq(st, 1);
        market.expire(y);
    }

    function test_callbackAuthenticationMalformedAndSynchronousIgnored() public {
        bytes32 x = post();
        coordinator.setSynchronous(true);
        seal(x);
        (uint256 req,,,,, uint8 st,) = controller.requestInfo(x);
        assertEq(st, 1);
        uint256[] memory words = new uint256[](1);
        vm.expectRevert();
        controller.rawFulfillRandomWords(req, words);
        words = new uint256[](0);
        vm.prank(address(coordinator));
        controller.rawFulfillRandomWords(req, words);
        (,,,,, st,) = controller.requestInfo(x);
        assertEq(st, 1);
        fulfill(x, 77);
        vrf.allocate(x);
        vm.expectRevert();
        vrf.allocate(x);
    }

    function test_differentRoundsDoNotMixReservationsOrRequests() public {
        bytes32 x = post();
        seal(x);
        address c = addHost(13);
        address d = addHost(14);
        bytes32 y = second();
        assertTrue(controller.taskRound(x) != controller.taskRound(y));
        assertEq(controller.candidates(y).length, 2);
        assertEq(controller.candidates(y)[0].host, c);
        seal(y);
        fulfill(y, 222);
        vrf.allocate(y);
        fulfill(x, 111);
        vrf.allocate(x);
        assertEq(coordinator.count(), 2);
        assertTrue(vrf.hasPendingTask(x, a));
        assertTrue(vrf.hasPendingTask(y, d));
    }

    function test_worstCase32Candidates63ExistingLeasesFitsGasCap() public {
        vm.deal(address(this), 1000 ether);
        address[] memory hosts = new address[](32);
        hosts[0] = a;
        hosts[1] = b;
        for (uint256 j = 2; j < 32; j++) {
            hosts[j] = addHost(100 + j);
        }
        cap.setMarket(address(this), true);
        for (uint256 j; j < 32; j++) {
            vm.prank(hosts[j]);
            cap.setCapacity(64);
            for (uint256 k; k < 63; k++) {
                assertTrue(cap.reserve(bytes32(k + 1), hosts[j], uint64(block.number + 1000)));
            }
        }
        vm.cool(address(cap));
        vm.cool(address(ins));
        vm.cool(address(vrf));
        vm.cool(address(controller));
        uint256 prepared = vm.snapshotState();
        uint256 beforeGas = gasleft();
        bytes32 id = post();
        uint256 used = beforeGas - gasleft();
        emit log_named_uint("worst-case admission gas", used);
        assertLt(used, 16777216);
        uint256 locked = vm.snapshotState();
        (, uint64 expiry,,,,,) = controller.requestInfo(id);
        vm.roll(expiry + 1);
        vm.cool(address(cap));
        vm.cool(address(ins));
        vm.cool(address(vrf));
        vm.cool(address(controller));
        beforeGas = gasleft();
        market.expire(id);
        used = beforeGas - gasleft();
        emit log_named_uint("worst-case expiration gas", used);
        assertLt(used, 16777216);
        vm.revertToState(locked);
        seal(id);
        fulfill(id, 123);
        vm.cool(address(cap));
        vm.cool(address(ins));
        vm.cool(address(vrf));
        vm.cool(address(controller));
        beforeGas = gasleft();
        vrf.allocate(id);
        used = beforeGas - gasleft();
        emit log_named_uint("worst-case allocation gas", used);
        assertLt(used, 16777216);
        vm.revertToState(prepared);
        tokenReady();
        for (uint256 j = 2; j < 32; j++) {
            vm.prank(hosts[j]);
            vrf.setAcceptedToken(address(token), true);
        }
        vm.cool(address(cap));
        vm.cool(address(ins));
        vm.cool(address(vrf));
        vm.cool(address(controller));
        vm.cool(address(token));
        beforeGas = gasleft();
        vrf.postTokenTask(task(), address(token), bytes32(0));
        used = beforeGas - gasleft();
        emit log_named_uint("worst-case token admission gas", used);
        assertLt(used, 16777216);
    }

    function tokenReady() internal {
        vrf.setTokenAllowed(address(token), true);
        vm.prank(a);
        vrf.setAcceptedToken(address(token), true);
        vm.prank(b);
        vrf.setAcceptedToken(address(token), true);
        token.mint(address(this), 1000);
        token.approve(address(vrf), 1000);
    }
}
