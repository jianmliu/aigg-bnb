// SPDX-License-Identifier: 0BSD
pragma solidity ^0.8.20;
import "./FlyCollectionRevision.t.sol";
import "../src/BatteryBudget.sol";
contract BatteryBudgetTest is FlyCollectionRevisionTest {
    // Separate tests below use the existing fixture without changing any inherited test's setup.
    function budgetFactory() internal returns(BatteryBudget f){
        TaskMarket m=new TaskMarket(IMEPRegistry(address(meps)),InstanceRegistry(address(0)),PoRWClaimManager(address(0)),30);
        f=new BatteryBudget(c,m,bob,BatteryPolicy(keccak256("battery-v1"),keccak256("runs"),39,5000,500,2,2,0.2 ether,86400));
    }
    function test_breedLocksBatteryFundsOutsideTreasuryAndTransfersChild() public {
        uint256 a=adopt(alice,0,0,DF);uint256 b=adopt(alice,1,1,DM);BatteryBudget f=budgetFactory();
        vm.startPrank(alice);c.approve(address(f),a);c.approve(address(f),b);uint256 id=f.breed{value:0.41 ether}(a,b);vm.stopPrank();
        address job=f.jobOf(id);assertEq(job.balance,0.4 ether);assertEq(address(f).balance,0);assertEq(c.ownerOf(id),alice);
        vm.prank(bob);vm.expectRevert();BatteryJob(payable(job)).refund();
        vm.prank(alice);vm.expectRevert();BatteryJob(payable(job)).refund();
        vm.warp(block.timestamp+86400);uint256 before=alice.balance;vm.prank(alice);BatteryJob(payable(job)).refund();assertEq(alice.balance,before+0.4 ether);
    }
    function test_failedBudgetPaymentCreatesNoChild() public {
        uint256 a=adopt(alice,0,0,DF);uint256 b=adopt(alice,1,1,DM);BatteryBudget f=budgetFactory();
        vm.startPrank(alice);c.setApprovalForAll(address(f),true);vm.expectRevert();f.breed{value:0.01 ether}(a,b);vm.stopPrank();assertEq(c.totalSupply(),2);
    }
    function test_existingIndividualFundedOnceAndNFTTransferDoesNotTransferRefundRights() public {
        uint256 a=adopt(alice,0,0,DF);BatteryBudget f=budgetFactory();vm.prank(alice);address job=f.fund{value:0.4 ether}(a);
        vm.prank(alice);vm.expectRevert();f.fund{value:0.4 ether}(a);
        vm.prank(alice);c.transferFrom(alice,bob,a);assertEq(BatteryJob(payable(job)).payer(),alice);
        vm.prank(alice);vm.expectRevert();BatteryJob(payable(job)).post(uint64(block.number+100));
        vm.prank(bob);vm.expectRevert(bytes("waiting model"));BatteryJob(payable(job)).post(uint64(block.number+100));
    }
}
