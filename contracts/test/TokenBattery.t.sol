// SPDX-License-Identifier: 0BSD
pragma solidity ^0.8.20;
import "./FlyCollectionRevision.t.sol";
import "../src/TokenBatteryBudget.sol";
import {TestToken} from "./MultiAssetTaskMarket.t.sol";
interface ITokenBudget {
 function fund(uint256) external returns(address);
 function breedWithBNB(uint256,uint256,uint256) external payable returns(uint256);
 function jobOf(uint256) external view returns(address);
}
import "./mocks/TestSwapRouter.sol";
contract TokenBatteryTest is FlyCollectionRevisionTest {
 function factory(TestToken t,TestSwapRouter r) internal returns(ITokenBudget){
  MultiAssetTaskMarket m=new MultiAssetTaskMarket(IMEPRegistry(address(meps)),InstanceRegistry(address(0)),PoRWClaimManager(address(0)),30);
  m.setTokenAllowed(address(t),true);
  return ITokenBudget(address(new TokenBatteryBudget(c,m,bob,BatteryPolicy(keccak256("battery"),keccak256("runs"),2,20,5,2,2,100,86400),address(t),IExactOutputRouter(address(r)))));
 }
 function test_swapLocksTokensAndRefundsExcessBNB() public {
  c=deploy(0,FlyCollection.Shares(vendor,1000,500,admin));
  uint256 a=adopt(alice,0,0,DF);uint256 b=adopt(alice,1,1,DM);TestToken t=new TestToken();TestSwapRouter r=new TestSwapRouter(t);t.mint(address(r),1000);ITokenBudget f=factory(t,r);
  vm.startPrank(alice);c.setApprovalForAll(address(f),true);uint before_=alice.balance;
  uint id=f.breedWithBNB{value:0.04 ether}(a,b,block.timestamp+100);vm.stopPrank();
  assertEq(c.ownerOf(id),alice);assertEq(t.balanceOf(f.jobOf(id)),200);assertEq(alice.balance,before_-0.03 ether);assertEq(address(f).balance,0);
  address job=f.jobOf(id);vm.warp(block.timestamp+86400);vm.prank(alice);BatteryJob(payable(job)).refund();assertEq(t.balanceOf(alice),200);
 }
 function test_slippageAndDeadlineRollbackBirth() public {
  c=deploy(0,FlyCollection.Shares(vendor,1000,500,admin));
  uint a=adopt(alice,0,0,DF);uint b=adopt(alice,1,1,DM);TestToken t=new TestToken();TestSwapRouter r=new TestSwapRouter(t);t.mint(address(r),1000);ITokenBudget f=factory(t,r);
  vm.startPrank(alice);c.setApprovalForAll(address(f),true);vm.expectRevert();f.breedWithBNB{value:0.02 ether}(a,b,block.timestamp+100);
  vm.warp(100);vm.expectRevert();f.breedWithBNB{value:0.04 ether}(a,b,99);vm.stopPrank();assertEq(c.totalSupply(),2);assertEq(t.balanceOf(address(r)),1000);
 }
 function test_directTreasuryFundingAndNoDuplicate() public {
  c=deploy(0,FlyCollection.Shares(vendor,1000,500,admin));
  uint a=adopt(alice,0,0,DF);TestToken t=new TestToken();TestSwapRouter r=new TestSwapRouter(t);ITokenBudget f=factory(t,r);t.mint(alice,400);
  vm.startPrank(alice);t.approve(address(f),400);address job=f.fund(a);vm.expectRevert();f.fund(a);vm.stopPrank();assertEq(t.balanceOf(job),200);assertEq(t.balanceOf(alice),200);
 }
 function test_wrongRoyaltyMarketRejectedBeforeFunding() public {
  TestToken t=new TestToken();TestSwapRouter r=new TestSwapRouter(t);
  MultiAssetTaskMarket m=new MultiAssetTaskMarket(IMEPRegistry(address(meps)),InstanceRegistry(address(0)),PoRWClaimManager(address(0)),30);
  vm.expectRevert(bytes("royalty market"));new TokenBatteryBudget(c,m,bob,BatteryPolicy(keccak256("battery"),keccak256("runs"),2,20,5,2,2,100,86400),address(t),IExactOutputRouter(address(r)));
 }
}
