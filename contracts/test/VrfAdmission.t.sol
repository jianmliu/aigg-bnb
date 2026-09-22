// SPDX-License-Identifier: 0BSD
pragma solidity ^0.8.20;
import "./SynchronousVerification.t.sol";
import "../src/VrfSynchronousTaskMarket.sol";
import "aigg-porw/mesh/MEPRegistry.sol";

contract MockVrfCoordinator is IVrfCoordinatorV25 {
    uint256 public count;
    bool public synchronous;
    uint256 public forcedRequestId;

    function setForcedRequestId(uint256 value) external {
        forcedRequestId = value;
    }

    function setSynchronous(bool value) external {
        synchronous = value;
    }

    function requestRandomWords(RandomWordsRequest calldata req) external returns (uint256 id) {
        require(req.numWords == 1 && req.extraArgs.length == 36, "request ABI");
        id = ++count;
        if (forcedRequestId != 0) id = forcedRequestId;
        if (synchronous) fulfill(VrfAdmission(msg.sender), id, 99);
    }

    function fulfill(VrfAdmission target, uint256 id, uint256 word) public {
        uint256[] memory words = new uint256[](1);
        words[0] = word;
        target.rawFulfillRandomWords(id, words);
    }
}

contract VrfTestToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address a, uint256 n) external {
        balanceOf[a] += n;
    }

    function approve(address a, uint256 n) external returns (bool) {
        allowance[msg.sender][a] = n;
        return true;
    }

    function transfer(address a, uint256 n) external returns (bool) {
        balanceOf[msg.sender] -= n;
        balanceOf[a] += n;
        return true;
    }

    function transferFrom(address f, address t, uint256 n) external returns (bool) {
        allowance[f][msg.sender] -= n;
        balanceOf[f] -= n;
        balanceOf[t] += n;
        return true;
    }
}

contract VrfAdmissionTest is Test {
    ISync market;
    VrfTestToken token;
    VrfSynchronousTaskMarket vrf;
    VrfAdmission controller;
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
        vrf = new VrfSynchronousTaskMarket(meps, ins, cm, 5, 5, 500, cfg, tokens, fees);
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
        cap.setCapacity(1);
        vm.prank(b);
        cap.setCapacity(1);
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
        coordinator.fulfill(controller, req, word);
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
        cap.setCapacity(1);
        arm(h);
    }

    function test_postLocksBeforeUnknownRandomness() public {
        bytes32 id = post();
        (uint8 state,,, uint64 end) = market.sessionState(id);
        assertEq(state, 6, "VRF tasks must wait before assignment");
        assertEq(end, block.number + 534);
        assertEq(vrf.executors(id).length, 0);
        assertEq(controller.candidates(id).length, 2);
        assertEq(market.pendingTask(a), id);
        assertEq(ins.disputeHolds(a), 1);
        assertEq(cap.activeSlots(a), 1);
        assertFalse(market.ready(a));
        assertEq(coordinator.count(), 1);
        assertEq(market.credits(address(0), address(0xFEE)), 7);
        vm.expectRevert();
        vrf.allocate(id);
        vm.expectRevert();
        post();
    }

    function test_fulfillmentOnlyStoresAndAllocationUsesFixedClock() public {
        bytes32 id = post();
        vm.roll(block.number + 3);
        uint64 f = uint64(block.number);
        fulfill(id, 0);
        (uint8 state,,,) = market.sessionState(id);
        assertEq(state, 6);
        assertEq(vrf.executors(id).length, 0);
        vm.roll(block.number + 2);
        vrf.allocate(id);
        (uint8 nextState, uint64 cd, uint64 rd, uint64 td) = market.sessionState(id);
        state = nextState;
        assertEq(state, 1);
        assertEq(cd, f + 9);
        assertEq(rd, f + 14);
        assertEq(td, f + 514);
        assertEq(vrf.executors(id).length, 2);
        vm.expectRevert();
        vrf.allocate(id);
    }

    function test_concurrentRequestsFulfillOutOfOrderWithoutCrossBinding() public {
        bytes32 first = post();
        (uint256 firstRequest,,,,,,) = controller.requestInfo(first);
        address c = addHost(13);
        address d = addHost(14);
        bytes32 second = market.postTask{value: 108}(task(), bytes32(uint256(2)));
        (uint256 secondRequest,,,,,,) = controller.requestInfo(second);
        assertTrue(first != second);
        assertTrue(firstRequest != secondRequest);
        assertEq(controller.requestTask(firstRequest), first);
        assertEq(controller.requestTask(secondRequest), second);
        assertEq(controller.candidates(first)[0].host, a);
        assertEq(controller.candidates(first)[1].host, b);
        assertEq(controller.candidates(second)[0].host, c);
        assertEq(controller.candidates(second)[1].host, d);
        vm.roll(block.number + 1);
        coordinator.fulfill(controller, secondRequest, 222);
        (,,,,, uint8 firstState,) = controller.requestInfo(first);
        (,,,,, uint8 secondState,) = controller.requestInfo(second);
        assertEq(firstState, 1);
        assertEq(secondState, 2);
        (uint8 phase,,,) = market.sessionState(first);
        assertEq(phase, 6);
        assertEq(vrf.executors(first).length, 0);
        vm.expectRevert();
        vrf.allocate(first);
        vrf.allocate(second);
        address[] memory secondPair = vrf.executors(second);
        assertTrue(secondPair[0] == c || secondPair[0] == d);
        assertTrue(secondPair[1] == c || secondPair[1] == d);
        assertTrue(secondPair[0] != secondPair[1]);
        vm.roll(block.number + 1);
        coordinator.fulfill(controller, firstRequest, 111);
        vrf.allocate(first);
        address[] memory firstPair = vrf.executors(first);
        assertTrue(firstPair[0] == a || firstPair[0] == b);
        assertTrue(firstPair[1] == a || firstPair[1] == b);
        assertTrue(firstPair[0] != firstPair[1]);
        coordinator.fulfill(controller, secondRequest, 999);
        coordinator.fulfill(controller, firstRequest, 999);
        assertEq(vrf.executors(first)[0], firstPair[0]);
        assertEq(vrf.executors(first)[1], firstPair[1]);
        assertEq(vrf.executors(second)[0], secondPair[0]);
        assertEq(vrf.executors(second)[1], secondPair[1]);
        assertEq(coordinator.count(), 2);
        (, uint64 deadline,,) = market.sessionState(first);
        vm.roll(deadline + 1);
        market.expire(first);
        assertEq(market.pendingTask(a), bytes32(0));
        assertEq(market.pendingTask(b), bytes32(0));
        assertEq(market.pendingTask(c), second);
        assertEq(market.pendingTask(d), second);
        assertEq(cap.activeSlots(c), 1);
        assertEq(cap.activeSlots(d), 1);
        market.expire(second);
        assertEq(cap.activeSlots(c), 0);
        assertEq(cap.activeSlots(d), 0);
    }

    function test_reusedCoordinatorRequestIdRollsBackNewTaskAndCannotOverwriteBinding() public {
        bytes32 first = post();
        (uint256 firstRequest,,,,,,) = controller.requestInfo(first);
        address c = addHost(13);
        address d = addHost(14);
        bytes32 nonce = bytes32(uint256(2));
        bytes32 second = vrf.taskId(task(), address(0), nonce, 0, address(this));
        coordinator.setForcedRequestId(firstRequest);
        vm.expectRevert();
        market.postTask{value: 108}(task(), nonce);
        assertEq(controller.requestTask(firstRequest), first);
        (,,,,, uint8 state,) = controller.requestInfo(second);
        assertEq(state, 0);
        assertEq(coordinator.count(), 1);
        assertTrue(market.ready(c));
        assertTrue(market.ready(d));
        assertEq(ins.disputeHolds(c), 0);
        assertEq(cap.activeSlots(c), 0);
        assertEq(vrf.credits(address(0), address(0xFEE)), 7);
        coordinator.setForcedRequestId(0);
        assertEq(market.postTask{value: 108}(task(), nonce), second);
        (uint256 secondRequest,,,,,,) = controller.requestInfo(second);
        assertEq(controller.requestTask(secondRequest), second);
        assertTrue(firstRequest != secondRequest);
        fulfill(first, 111);
        vrf.allocate(first);
        fulfill(second, 222);
        vrf.allocate(second);
        vm.expectRevert();
        market.postTask{value: 108}(task(), nonce);
        assertEq(coordinator.count(), 2);
    }

    function test_authUnknownReplayAndSynchronousCallback() public {
        bytes32 id = post();
        uint256[] memory words = new uint256[](1);
        vm.expectRevert();
        controller.rawFulfillRandomWords(1, words);
        coordinator.fulfill(controller, 999, 1);
        fulfill(id, 777);
        uint256 snap = vm.snapshotState();
        vrf.allocate(id);
        address[] memory selected = vrf.executors(id);
        vm.revertToState(snap);
        fulfill(id, 123);
        vrf.allocate(id);
        assertEq(vrf.executors(id)[0], selected[0]);
        vm.roll(block.number + 10);
        vrf.expire(id);
        arm(a);
        arm(b);
        coordinator.setSynchronous(true);
        bytes32 syncId = market.postTask{value: 108}(task(), bytes32(uint256(2)));
        (,,,,, uint8 state,) = controller.requestInfo(syncId);
        assertEq(state, 1);
        fulfill(syncId, 123);
        vrf.allocate(syncId);
    }

    function test_timeoutRefundKeepsAdmissionAndLateCallbackCannotRevive() public {
        bytes32 id = post();
        (, uint64 deadline,,,,,) = controller.requestInfo(id);
        vm.roll(deadline);
        vm.expectRevert();
        market.expire(id);
        vm.roll(deadline + 1);
        market.expire(id);
        assertEq(market.credits(address(0), address(this)), 101);
        assertEq(market.credits(address(0), address(0xFEE)), 7);
        assertEq(ins.disputeHolds(a), 0);
        assertEq(cap.activeSlots(a), 0);
        assertEq(market.pendingTask(a), bytes32(0));
        assertFalse(market.ready(a));
        fulfill(id, 123);
        (uint8 state,,,) = market.sessionState(id);
        assertEq(state, 5);
        vm.expectRevert();
        market.expire(id);
        vm.expectRevert();
        vrf.allocate(id);
    }

    function test_timelySeedCannotBeDiscardedAndDelayedAllocationExpires() public {
        bytes32 id = post();
        (, uint64 deadline,,,,,) = controller.requestInfo(id);
        vm.roll(deadline);
        fulfill(id, 123);
        vm.roll(deadline + 1);
        vm.expectRevert();
        market.expire(id);
        vm.roll(deadline + 5);
        vm.expectRevert();
        vrf.allocate(id);
        market.expire(id);
        assertEq(cap.activeSlots(a), 0);
    }

    function test_snapshotFrozenReleaseLosersAndFinalSelectedRelease() public {
        address c = addHost(13);
        bytes32 id = post();
        assertEq(controller.candidates(id).length, 3);
        vm.prank(c);
        ins.requestExit();
        vm.prank(a);
        cap.setCapacity(0);
        fulfill(id, 44);
        vrf.allocate(id);
        address[] memory selected = vrf.executors(id);
        assertTrue(selected[0] != selected[1]);
        for (uint256 j; j < 3; j++) {
            address h = j == 0 ? a : j == 1 ? b : c;
            bool chosen = h == selected[0] || h == selected[1];
            assertEq(ins.disputeHolds(h), chosen ? 1 : 0);
            assertEq(cap.activeSlots(h), chosen ? 1 : 0);
            assertEq(vrf.taskSigner(id, h), h);
        }
        (, uint64 cd,,) = market.sessionState(id);
        vm.roll(cd + 1);
        market.expire(id);
        assertEq(cap.activeSlots(selected[0]), 0);
        assertEq(cap.activeSlots(selected[1]), 0);
    }

    function test_globalRosterTTLFullArmRejectionDoesNotPoisonPosting() public {
        vm.deal(address(this), 1000 ether);
        for (uint256 j; j < 30; j++) {
            addHost(100 + j);
        }
        address extra = vm.addr(999);
        bytes32[] memory mids = new bytes32[](1);
        mids[0] = mid;
        ins.bondFor{value: 1 ether}(extra, mids);
        vm.prank(extra);
        cap.setCapacity(1);
        vm.prank(extra);
        vm.expectRevert();
        market.setReady(true);
        bytes32 id = post();
        assertEq(controller.candidates(id).length, 32);
        (, uint64 deadline,,,,,) = controller.requestInfo(id);
        vm.roll(deadline + 1);
        market.expire(id);
        arm(extra);
        assertTrue(market.ready(extra));
        uint256 nonce = vrf.readinessNonce(extra);
        vm.roll(block.number + 101);
        assertFalse(market.ready(extra));
        controller.pruneReady();
        assertEq(vrf.readinessNonce(extra), nonce + 1);
        assertEq(controller.readyUntil(extra), 0);
    }

    function test_agreementRetainsV1ExecutionAndPayments() public {
        bytes32 id = post();
        fulfill(id, 33);
        vrf.allocate(id);
        bytes32 digest = keccak256("r");
        commit(id, a, 11, digest, digest);
        commit(id, b, 12, digest, digest);
        reveal(id, a, 11, digest, digest);
        reveal(id, b, 12, digest, digest);
        (uint8 state,,,) = market.sessionState(id);
        assertEq(state, 4);
        assertEq(cap.activeSlots(a), 0);
        assertEq(ins.disputeHolds(a), 0);
        assertEq(market.credits(address(0), a), 45);
        assertEq(market.credits(address(0), b), 45);
        assertEq(market.credits(address(0), address(this)), 1);
        assertEq(market.credits(address(0), address(0xFEE)), 7);
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

    function test_tokenFeeAtomicAndRefundNonrefundable() public {
        tokenReady();
        token.approve(address(vrf), 101);
        vm.expectRevert();
        vrf.postTokenTask(task(), address(token), bytes32(0));
        assertEq(coordinator.count(), 0);
        assertTrue(market.ready(a));
        assertEq(ins.disputeHolds(a), 0);
        token.approve(address(vrf), 110);
        bytes32 id = vrf.postTokenTask(task(), address(token), bytes32(0));
        assertEq(token.balanceOf(address(vrf)), 110);
        (, uint64 end,,,,,) = controller.requestInfo(id);
        vm.roll(end + 1);
        market.expire(id);
        assertEq(vrf.credits(address(token), address(this)), 101);
        assertEq(vrf.credits(address(token), address(0xFEE)), 9);
        vrf.withdrawCredit(address(token), payable(address(this)));
        vm.prank(address(0xFEE));
        vrf.withdrawCredit(address(token), payable(address(0xFEE)));
        assertEq(token.balanceOf(address(vrf)), 0);
        assertEq(token.balanceOf(address(0xFEE)), 9);
    }

    function test_nativeAndTokenBatchChargeOneAdmissionEach() public {
        tokenReady();
        vm.mockCall(
            address(vrf.meps()), abi.encodeWithSelector(vrf.meps().lifWeightUnit.selector), abi.encode(uint32(1))
        );
        ITaskMarket.Task memory t = task();
        t.stimulusSeed = 0;
        bytes32 id = vrf.postBatch{value: 108}(t, 2, bytes32(0));
        (, uint64 end,,,,,) = controller.requestInfo(id);
        vm.roll(end + 1);
        market.expire(id);
        arm(a);
        arm(b);
        bytes32 second = vrf.postTokenBatch(t, address(token), 2, bytes32(0));
        assertEq(vrf.batchRuns(second), 2);
        assertEq(vrf.admissionFeesAccrued(address(token)), 9);
        assertEq(vrf.admissionFeesAccrued(address(0)), 7);
    }

    function test_unequalWeightsMatchIndependentTicketDrawWithoutReplacement() public {
        address c = addHost(13);
        bytes32[] memory mids = new bytes32[](1);
        mids[0] = mid;
        ins.bondFor{value: 2 ether}(b, mids);
        ins.bondFor{value: 6 ether}(c, mids);
        bytes32 id = post();
        VrfAdmission.Candidate[] memory pool = controller.candidates(id);
        assertEq(pool[0].weight, 1);
        assertEq(pool[1].weight, 3);
        assertEq(pool[2].weight, 7);
        (,,,, uint64 maximum,,) = controller.requestInfo(id);
        bytes32 identity = keccak256(abi.encode(block.chainid, address(vrf), id, mid, address(0), uint64(0), maximum));
        address[] memory tickets = new address[](11);
        uint256 offset;
        for (uint256 j; j < pool.length; j++) {
            identity = keccak256(abi.encode(identity, pool[j].host, pool[j].signer, pool[j].weight));
            for (uint256 k; k < pool[j].weight; k++) {
                tickets[offset++] = pool[j].host;
            }
        }
        assertEq(offset, 11);
        for (uint256 word; word < 32; word++) {
            uint256 snapshot = vm.snapshotState();
            address first = tickets[uint256(keccak256(abi.encode("AIGG_VRF_FIRST_V1", word, id, identity))) % 11];
            uint256 remaining;
            for (uint256 j; j < tickets.length; j++) {
                if (tickets[j] != first) remaining++;
            }
            uint256 secondIndex = uint256(keccak256(abi.encode("AIGG_VRF_SECOND_V1", word, id, identity))) % remaining;
            address second;
            for (uint256 j; j < tickets.length; j++) {
                if (tickets[j] == first) continue;
                if (secondIndex == 0) {
                    second = tickets[j];
                    break;
                }
                secondIndex--;
            }
            fulfill(id, word);
            vrf.allocate(id);
            address[] memory selected = vrf.executors(id);
            assertEq(selected[0], first);
            assertEq(selected[1], second);
            assertTrue(first != second);
            vm.revertToState(snapshot);
        }
    }

    function test_weightRosterReadinessAndCapacityChangesCannotRedraw() public {
        address c = addHost(13);
        bytes32 id = post();
        uint256 locked = vm.snapshotState();
        fulfill(id, 555);
        vrf.allocate(id);
        address[] memory expected = vrf.executors(id);
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
        addHost(14);
        fulfill(id, 555);
        vrf.allocate(id);
        assertEq(vrf.executors(id)[0], expected[0]);
        assertEq(vrf.executors(id)[1], expected[1]);
        assertEq(controller.candidates(id).length, 3);
        assertEq(controller.candidates(id)[2].weight, 1);
    }

    function test_delegationCoversMaximumButSignedExpiryIsOnlySubmissionWindow() public {
        address signer = vm.addr(55);
        vm.prank(a);
        ins.setSessionKey(signer, uint64(block.number + 533));
        vm.prank(signer);
        vm.expectRevert();
        market.setReady(true);
        vm.prank(a);
        ins.setSessionKey(signer, uint64(block.number + 534));
        uint64 authExpiry = uint64(block.number + 1);
        uint256 nonce = vrf.readinessNonce(a);
        bytes memory signature = sig(55, vrf.readinessDigest(a, true, authExpiry, nonce));
        vrf.setReadyBySig(a, true, authExpiry, nonce, signature);
        assertEq(controller.readyUntil(a), block.number + 100);
        ITaskMarket.Task memory t = task();
        t.deadline = uint64(block.number + 533);
        vm.expectRevert();
        market.postTask{value: 108}(t, bytes32(0));
        bytes32 id = post();
        assertEq(vrf.taskSigner(id, a), signer);
        vm.prank(a);
        ins.revokeSessionKey(signer);
        fulfill(id, 44);
        vrf.allocate(id);
        assertEq(vrf.taskSigner(id, a), signer);
        bytes32 digest = keccak256("r");
        bytes32 commitment = vrf.resultCommitment(id, a, digest, digest, bytes32(uint256(55)));
        bytes memory resultSig = sig(55, vrf.commitmentDigest(id, a, commitment));
        vm.expectRevert();
        vrf.commitResult(id, a, commitment, resultSig);
        (, uint64 deadline,,) = market.sessionState(id);
        vm.roll(deadline + 1);
        market.expire(id);
        assertEq(cap.activeSlots(a), 0);
    }

    function test_historicalDustAndIneligibleReadyHostsNeverEnterSnapshot() public {
        bytes32[] memory mids = new bytes32[](1);
        mids[0] = mid;
        for (uint256 j; j < 100; j++) {
            address dust = address(uint160(0x10000 + j));
            vm.deal(dust, 1);
            vm.prank(dust);
            ins.bond{value: 1}(mids);
        }
        address c = addHost(13);
        vm.prank(c);
        cap.setCapacity(0);
        bytes32 id = post();
        assertEq(controller.candidates(id).length, 2);
        assertEq(cap.activeSlots(c), 0);
        assertEq(ins.disputeHolds(c), 0);
        assertEq(market.pendingTask(c), bytes32(0));
        assertFalse(market.ready(c));
        uint256 oldNonce = vrf.readinessNonce(c);
        controller.pruneReady();
        assertEq(vrf.readinessNonce(c), oldNonce + 1);
    }

    function test_noPublicBeaconFallbackAndInvalidCallbacksCannotChangeFulfillment() public {
        vm.mockCall(
            address(vrf.claimManager()),
            abi.encodeWithSelector(vrf.claimManager().beacon.selector),
            abi.encode(bytes32(0))
        );
        bytes32 id = post();
        uint256[] memory malformed = new uint256[](0);
        vm.prank(address(coordinator));
        controller.rawFulfillRandomWords(1, malformed);
        (,,,,, uint8 state,) = controller.requestInfo(id);
        assertEq(state, 1);
        fulfill(id, 0);
        (,, uint64 fulfilledAt,,,,) = controller.requestInfo(id);
        vm.roll(block.number + 1);
        fulfill(id, 999);
        (,, uint64 stillAt,,,,) = controller.requestInfo(id);
        assertEq(stillAt, fulfilledAt);
        vrf.allocate(id);
    }
}

/// Real registry/claim-manager fixtures exercise base membership and non-bootstrap residency reads.
contract VrfRealResidencyTest is Test {
    MEPRegistry meps;
    InstanceRegistry instances;
    PoRWClaimManager claims;
    HostCapacity capacity;
    VrfSynchronousTaskMarket market;
    VrfAdmission admission;
    MockVrfCoordinator coordinator;
    VrfTestToken token;
    bytes32 base;
    bytes32 derived;

    function setUp() public {
        vm.deal(address(this), 1000 ether);
        vm.roll(1000);
        meps = new MEPRegistry();
        IMEPRegistry.MEP memory profile = IMEPRegistry.MEP(
            keccak256("base-model"),
            SCHEME_SKETCH_TILE_KECCAK_V3,
            keccak256("aigg:exec:int-spmv-q16:v1"),
            2,
            1,
            keccak256("synapses"),
            bytes("real fixture")
        );
        base = meps.registerMEP(profile);
        profile.modelId = keccak256("derived-model");
        derived = meps.registerDerivedMEP(profile, base);
        instances = new InstanceRegistry(1 ether, 5);
        instances.setMEPRegistry(address(meps));
        claims =
            new PoRWClaimManager(meps, instances, new PorwVerifierKeccak(), 1000, 5, 1, 1 ether, IBeacon(address(0)));
        instances.setClaimManager(address(claims), 1);
        claims.rollEpoch();
        coordinator = new MockVrfCoordinator();
        token = new VrfTestToken();
        address[] memory tokens = new address[](2);
        tokens[1] = address(token);
        uint256[] memory fees = new uint256[](2);
        fees[0] = 7;
        fees[1] = 9;
        VrfAdmission.Config memory config = VrfAdmission.Config(
            address(coordinator), bytes32(uint256(1)), 1, 3, 200000, true, 20, 4, 100, address(0xFEE)
        );
        market = new VrfSynchronousTaskMarket(meps, instances, claims, 5, 5, 500, config, tokens, fees);
        admission = market.admission();
        instances.setSlasher(address(admission), true);
        capacity = new HostCapacity();
        capacity.setMarket(address(market), true);
        capacity.setMarket(address(admission), true);
        capacity.setMarket(address(this), true);
        market.setHostCapacity(address(capacity));
        vm.mockCall(address(0xD15), abi.encodeWithSignature("ROUND_BLOCKS()"), abi.encode(uint64(5)));
        market.setDisputes(address(0xD15));
        market.setProfileSupport(derived, 8192);
        market.setTokenAllowed(address(token), true);
        token.mint(address(this), 1000);
        token.approve(address(market), 1000);
    }

    function resident(uint256 key) internal {
        IPoRWClaimManager.Claim memory claim = IPoRWClaimManager.Claim(
            base, keccak256(abi.encode(key)), 4096, claims.epochChallenge(claims.currentEpoch(), base)
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, claims.claimDigest(claim));
        claims.submitClaim(claim, abi.encodePacked(r, s, v));
    }

    function host(uint256 key, bool withClaim, bool crowded) internal returns (address account) {
        account = vm.addr(key);
        bytes32[] memory ids = new bytes32[](1);
        ids[0] = base;
        instances.bondFor{value: 1 ether}(account, ids);
        vm.prank(account);
        capacity.setCapacity(crowded ? 64 : 1);
        vm.prank(account);
        market.setAcceptedToken(address(token), true);
        if (withClaim) resident(key);
        vm.prank(account);
        market.setReady(true);
        if (crowded) {
            for (uint256 j; j < 63; j++) {
                assertTrue(capacity.reserve(bytes32(j + 1), account, uint64(block.number + 1000)));
            }
        }
    }

    function task() internal view returns (ITaskMarket.Task memory) {
        return ITaskMarket.Task(derived, 1, 1, 1, bytes32(0), 101, 0, 2);
    }

    function cold() internal {
        vm.cool(address(meps));
        vm.cool(address(instances));
        vm.cool(address(claims));
        vm.cool(address(capacity));
        vm.cool(address(market));
        vm.cool(address(admission));
        vm.cool(address(coordinator));
        vm.cool(address(token));
    }

    function test_realDerivedEnrollmentAndNonzeroEpochResidency() public {
        address a = host(11, true, false);
        address b = host(12, true, false);
        address noClaim = host(13, false, false);
        assertEq(claims.currentEpoch(), 1);
        assertEq(instances.enrollmentMep(derived), base);
        assertTrue(instances.inMep(derived, a));
        assertTrue(instances.isEligible(a, derived, 1));
        assertFalse(instances.isEligible(noClaim, derived, 1));
        assertEq(claims.lastValidEpochPlus1(a, derived), 0);
        assertEq(claims.lastValidEpochPlus1(a, base), 2);
        bytes32 id = market.postTask{value: 108}(task(), bytes32(0));
        VrfAdmission.Candidate[] memory candidates = admission.candidates(id);
        assertEq(candidates.length, 2);
        assertEq(candidates[0].host, a);
        assertEq(candidates[1].host, b);
        assertEq(capacity.activeSlots(noClaim), 0);
        assertEq(instances.disputeHolds(noClaim), 0);
        vm.roll(3000);
        market.expire(id);
        claims.rollEpoch();
        vm.prank(a);
        market.setReady(true);
        vm.prank(b);
        market.setReady(true);
        assertFalse(instances.isEligible(a, derived, 3));
        vm.expectRevert();
        market.postTask{value: 108}(task(), bytes32(uint256(1)));
        resident(11);
        resident(12);
        bytes32 next = market.postTask{value: 108}(task(), bytes32(uint256(1)));
        assertEq(admission.candidates(next).length, 2);
    }

    function test_realConfiguredResidency32By63ColdGasBound() public {
        for (uint256 j; j < 32; j++) {
            host(100 + j, true, true);
        }
        uint256 prepared = vm.snapshotState();
        cold();
        uint256 start = gasleft();
        bytes32 id = market.postTask{value: 108}(task(), bytes32(0));
        uint256 gasUsed = start - gasleft();
        emit log_named_uint("real registry native admission", gasUsed);
        assertLt(gasUsed + 31000, 16777216);
        assertEq(admission.candidates(id).length, 32);
        uint256 locked = vm.snapshotState();
        (uint256 req, uint64 deadline,,,,,) = admission.requestInfo(id);
        vm.roll(deadline + 1);
        cold();
        start = gasleft();
        market.expire(id);
        gasUsed = start - gasleft();
        emit log_named_uint("real registry expiration", gasUsed);
        assertLt(gasUsed + 31000, 16777216);
        vm.revertToState(locked);
        coordinator.fulfill(admission, req, 123);
        cold();
        start = gasleft();
        market.allocate(id);
        gasUsed = start - gasleft();
        emit log_named_uint("real registry allocation", gasUsed);
        assertLt(gasUsed + 31000, 16777216);
        vm.revertToState(prepared);
        cold();
        start = gasleft();
        market.postTokenTask(task(), address(token), bytes32(0));
        gasUsed = start - gasleft();
        emit log_named_uint("real registry token admission", gasUsed);
        assertLt(gasUsed + 31000, 16777216);
    }
}
