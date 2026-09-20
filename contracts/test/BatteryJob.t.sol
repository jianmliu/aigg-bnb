// SPDX-License-Identifier: 0BSD
pragma solidity ^0.8.20;
import "./FlyCollectionRevision.t.sol";
import "../src/BatteryBudget.sol";
contract PaidBatchSink {
    function postBatch(ITaskMarket.Task calldata,uint32,bytes32) external payable returns(bytes32){return keccak256("paid task");}
}
contract BatteryJobTest is FlyCollectionRevisionTest {
    bytes32 constant TID=keccak256("paid task");
    function jobFixture() internal returns(BatteryJob j,address m){
        uint256 id=adopt(alice,0,0,DF);vm.prank(alice);c.register(id,DF,mep(keccak256("brain")));
        m=address(new PaidBatchSink());
        j=new BatteryJob{value:0.4 ether}(c,TaskMarket(m),bob,alice,id,BatteryPolicy(keccak256("v"),keccak256("r"),39,5000,500,2,2,0.2 ether,100));
        vm.prank(bob);j.post(uint64(block.number+100));
    }
    function facts(address m,bool settled,bool disputed,bool repudiated,uint64 at) internal {
        ITaskMarket.Task memory t;
        vm.mockCall(m,abi.encodeWithSelector(bytes4(keccak256("tasks(bytes32)")),TID),abi.encode(t,address(0),uint64(1),uint64(1),at,true,settled,disputed,repudiated));
        vm.mockCall(m,abi.encodeWithSelector(bytes4(keccak256("challengeWindow()"))),abi.encode(uint64(10)));
    }
    function acceptedFacts(address m) internal {
        address[] memory ex=new address[](2);ex[0]=address(10);ex[1]=address(11);
        vm.mockCall(m,abi.encodeWithSelector(TaskMarket.executors.selector,TID),abi.encode(ex));
        vm.mockCall(m,abi.encodeWithSelector(bytes4(keccak256("settledRef(bytes32)")),TID),abi.encode(ex[0]));
        vm.mockCall(m,abi.encodeWithSelector(bytes4(keccak256("submitted(bytes32,address)"))),abi.encode(true));
        vm.mockCall(m,abi.encodeWithSelector(TaskMarket.resultOf.selector),abi.encode(keccak256("d"),keccak256("r")));
    }
    function test_activeTaskCannotDoubleSpendOrRefundEvenAfterExpiry() public {
        (BatteryJob j,address m)=jobFixture();facts(m,false,false,false,0);vm.warp(block.timestamp+101);
        vm.prank(alice);vm.expectRevert();j.refund();vm.prank(bob);vm.expectRevert();j.post(100);
        assertEq(address(j).balance,0.2 ether);assertEq(j.attempt(),1);
    }
    function test_deliveryWaitsForChallengeWindowAndDisputes() public {
        (BatteryJob j,address m)=jobFixture();acceptedFacts(m);facts(m,true,false,false,10);vm.roll(20);
        vm.prank(bob);vm.expectRevert();j.deliver(keccak256("artifact"));
        vm.roll(21);facts(m,true,true,false,10);assertFalse(j.accepted());
        facts(m,true,false,true,10);assertFalse(j.accepted());
        facts(m,true,false,false,10);vm.prank(bob);j.deliver(keccak256("artifact"));
        uint256 before=alice.balance;vm.prank(alice);j.refund();assertEq(alice.balance,before+0.2 ether);
    }
    function test_noResultRefundStaysInItsJobAndCanFundBoundedRetry() public {
        (BatteryJob j,address m)=jobFixture();facts(m,true,false,false,1);vm.roll(12);
        vm.mockCall(m,abi.encodeWithSelector(bytes4(keccak256("settledRef(bytes32)")),TID),abi.encode(address(0)));
        vm.deal(m,0.2 ether);vm.prank(m);(bool ok,)=address(j).call{value:0.2 ether}("");assertTrue(ok);
        assertEq(address(j).balance,0.4 ether);vm.prank(bob);j.post(100);assertEq(j.attempt(),2);
        vm.prank(bob);vm.expectRevert();j.post(100);
    }
    function test_resolvedDisputeAllowsNativeReserveRefund() public {
        (BatteryJob j,address m)=jobFixture();facts(m,true,true,true,1);vm.roll(12);vm.warp(block.timestamp+101);
        vm.mockCall(m,abi.encodeWithSignature("disputeResolved(bytes32)",TID),abi.encode(true));
        assertTrue(j.settledFinal());vm.prank(alice);j.refund();assertEq(address(j).balance,0);
    }
}
