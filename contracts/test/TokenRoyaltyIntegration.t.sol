// SPDX-License-Identifier: 0BSD
pragma solidity ^0.8.20;
import "./FlyCollectionRevision.t.sol";
import "../src/MultiAssetTaskMarket.sol";
import "./mocks/TestToken.sol";
contract TokenRoyaltyIntegrationTest is FlyCollectionRevisionTest {
 function test_realTokenSettlementCreditsNFTOwnerAndBaseVendor() public {
  address host=vm.addr(44);InstanceRegistry ins=InstanceRegistry(address(0x102));PoRWClaimManager claims=PoRWClaimManager(address(0x103));
  vm.mockCall(address(claims),abi.encodeWithSelector(claims.currentEpoch.selector),abi.encode(uint64(1)));
  vm.mockCall(address(claims),abi.encodeWithSelector(claims.beacon.selector),abi.encode(bytes32(uint256(1))));
  vm.mockCall(address(ins),abi.encodeWithSelector(ins.enrolled.selector),abi.encode(uint256(1)));
  vm.mockCall(address(ins),abi.encodeWithSelector(ins.sortitionPick.selector),abi.encode(host));
  vm.mockCall(address(ins),abi.encodeWithSelector(ins.resolve.selector,host),abi.encode(host));
  MultiAssetTaskMarket m=new MultiAssetTaskMarket(meps,ins,claims,5);
  c=new FlyCollection(BASE_F,BASE_M,root(),2,PRICE,0,FEE,0,treasury,meps,IInstanceBonding(address(0)),LineageRegistry(address(0)),0,0,IRoyaltyMarket(address(m)),1000,FlyCollection.Shares(vendor,1000,500,admin));
  uint id=adopt(alice,0,0,DF);vm.prank(alice);bytes32 mid=c.register(id,DF,mep(keccak256("token-real-model")));
  TestToken t=new TestToken();t.mint(address(this),10000);t.approve(address(m),10000);m.setTokenAllowed(address(t),true);
  vm.prank(host);m.setAcceptedToken(address(t),true);
  ITaskMarket.Task memory task_=ITaskMarket.Task(mid,0,20,1,bytes32(0),1000,uint64(block.number+100),1);
  vm.expectRevert(bytes("token beneficiary"));m.postTokenTask(task_,address(t),bytes32(0));
  m.setTokenBeneficiaryAllowed(address(c),true);bytes32 tid=m.postTokenTask(task_,address(t),bytes32(0));
  // Disabling receiver admission cannot prevent delivery for an already-posted task.
  m.setTokenBeneficiaryAllowed(address(c),false);bytes32 r=keccak256("root");
  (uint8 v,bytes32 rs,bytes32 ss)=vm.sign(44,m.resultDigest(tid,r,r));m.submitResult(tid,ITaskMarket.Result(r,r),abi.encodePacked(rs,ss,v));m.settle(tid);
  assertEq(t.balanceOf(host),900);assertEq(c.tokenOwed(address(t),alice),90);assertEq(c.tokenOwed(address(t),vendor),10);
  assertEq(c.owed(alice),0);vm.prank(alice);c.transferFrom(alice,bob,id);assertEq(c.tokenOwed(address(t),bob),0);
  vm.prank(alice);c.withdrawToken(address(t));vm.prank(vendor);c.withdrawToken(address(t));assertEq(t.balanceOf(alice),90);assertEq(t.balanceOf(vendor),10);assertEq(t.balanceOf(address(c)),0);
 }
}
