// SPDX-License-Identifier: 0BSD
pragma solidity ^0.8.20;
import "./MultiAssetTaskMarket.t.sol";
contract CapacityFixture is Test {
 MultiAssetTaskMarket market; IAssets assets; TestToken coin; address host; address host2; address ben=address(0xBEEF);
 bytes32 mid=keccak256("model");
 function setUp() public virtual {
  host=vm.addr(11);host2=vm.addr(12);
  IMEPRegistry meps=IMEPRegistry(address(0x101));InstanceRegistry ins=InstanceRegistry(address(0x102));PoRWClaimManager cm=PoRWClaimManager(address(0x103));
  vm.mockCall(address(meps),abi.encodeWithSelector(meps.getMEP.selector),abi.encode(IMEPRegistry.MEP(bytes32(0),bytes32(0),bytes32(0),1,0,bytes32(0),hex"")));
  vm.mockCall(address(meps),abi.encodeWithSelector(meps.lifWeightUnit.selector),abi.encode(uint32(0)));
  vm.mockCall(address(meps),abi.encodeWithSelector(meps.termsOf.selector),abi.encode(ben,uint16(1000)));
  vm.mockCall(address(cm),abi.encodeWithSelector(cm.currentEpoch.selector),abi.encode(uint64(1)));
  vm.mockCall(address(cm),abi.encodeWithSelector(cm.beacon.selector),abi.encode(bytes32(uint256(1))));
  vm.mockCall(address(ins),abi.encodeWithSelector(ins.enrolled.selector),abi.encode(uint256(1)));
  vm.mockCall(address(ins),abi.encodeWithSelector(ins.sortitionPick.selector),abi.encode(host));
  vm.mockCall(address(ins),abi.encodeWithSelector(ins.resolve.selector,host),abi.encode(host));
  market=new MultiAssetTaskMarket(meps,ins,cm,5);assets=IAssets(address(market));coin=new TestToken();coin.mint(address(this),10000);coin.approve(address(market),type(uint256).max);vm.deal(address(this),1 ether);
 }
 function task() internal view returns(ITaskMarket.Task memory){return ITaskMarket.Task(mid,0,1,1,bytes32(0),101,uint64(block.number+100),1);}
 function enable() internal {assets.setTokenAllowed(address(coin),true);vm.prank(host);assets.setAcceptedToken(address(coin),true);}
 function submit(bytes32 id) internal {bytes32 r=keccak256("result");(uint8 v,bytes32 rs,bytes32 ss)=vm.sign(11,market.resultDigest(id,r,r));market.submitResult(id,ITaskMarket.Result(r,r),abi.encodePacked(rs,ss,v));}
 receive() external payable {}
}
interface ICapacityMarket { function setHostCapacity(address) external; }
contract CapacityMarketGateTest is CapacityFixture {
 function test_capacityCannotBeEnabledAfterLegacyTask() public {
  market.postTask{value:101}(task(),bytes32(0));
  // Unwired legacy mode must remain usable, but cannot later change open-task accounting.
  vm.expectRevert(bytes("capacity wiring"));
  ICapacityMarket(address(market)).setHostCapacity(address(0x123));
 }
}
import "aigg-porw/mesh/HostCapacity.sol";
import "aigg-porw/mesh/TaskMarket.sol";
contract HostCapacityMarketTest is CapacityFixture {
 HostCapacity capacity;
 function setUp() public override {super.setUp();capacity=new HostCapacity();capacity.setMarket(address(market),true);vm.prank(host);capacity.setCapacity(1);}
 function wire() internal {ICapacityMarket(address(market)).setHostCapacity(address(capacity));}
 function test_capacityFullThenAcceptedResultReleases() public {
  wire();bytes32 a=market.postTask{value:101}(task(),bytes32(uint256(1)));assertEq(capacity.activeSlots(host),1);
  vm.expectRevert();market.postTask{value:101}(task(),bytes32(uint256(2)));
  submit(a);assertEq(capacity.activeSlots(host),0);assertTrue(market.submitted(a,host));market.postTask{value:101}(task(),bytes32(uint256(2)));
  bytes32 r=keccak256("result");(uint8 v,bytes32 rs,bytes32 ss)=vm.sign(11,market.resultDigest(a,r,r));
  vm.expectRevert(bytes("submitted"));market.submitResult(a,ITaskMarket.Result(r,r),abi.encodePacked(rs,ss,v));assertEq(capacity.activeSlots(host),1);
 }
 function test_expiryIgnoresTaskDeadlineAndLateResultCannotReleaseNewTask() public {
  wire();ITaskMarket.Task memory t=task();t.deadline=1;bytes32 a=market.postTask{value:101}(t,bytes32(uint256(1)));
  vm.roll(block.number+5);assertEq(capacity.activeSlots(host),1);vm.expectRevert();market.postTask{value:101}(task(),bytes32(uint256(2)));
  vm.roll(block.number+1);bytes32 b=market.postTask{value:101}(task(),bytes32(uint256(2)));submit(a);assertEq(capacity.activeSlots(host),1);assertEq(market.executors(a)[0],host);submit(b);assertEq(capacity.activeSlots(host),0);
 }
 function test_underfillRollsBackReservationsAndTokenPayment() public {
  wire();enable();ITaskMarket.Task memory t=task();t.redundancy=2;
  vm.expectRevert();market.postTask{value:101}(t,bytes32(0));assertEq(capacity.activeSlots(host),0);
  vm.expectRevert();assets.postTokenTask(t,address(coin),bytes32(0));assertEq(capacity.activeSlots(host),0);assertEq(coin.balanceOf(address(this)),10000);
 }
 function test_crossMarketNativeAndTokenShareCapacity() public {
  wire();enable();TaskMarket other=new TaskMarket(market.meps(),market.instances(),market.claimManager(),5);capacity.setMarket(address(other),true);ICapacityMarket(address(other)).setHostCapacity(address(capacity));
  bytes32 a=assets.postTokenTask(task(),address(coin),bytes32(0));vm.expectRevert();other.postTask{value:101}(task(),bytes32(0));submit(a);
  other.postTask{value:101}(task(),bytes32(0));vm.expectRevert();assets.postTokenTask(task(),address(coin),bytes32(uint256(1)));assertEq(capacity.activeSlots(host),1);
 }
 function test_revocationBlocksNewDrawButAcceptedResultStillReleases() public {
  wire();bytes32 id=market.postTask{value:101}(task(),bytes32(0));capacity.setMarket(address(market),false);
  vm.expectRevert(bytes("market"));market.postTask{value:101}(task(),bytes32(uint256(1)));submit(id);assertEq(capacity.activeSlots(host),0);
 }
 function test_invalidSignerAndMalformedBatchKeepLease() public {
  wire();vm.mockCall(address(market.meps()),abi.encodeWithSelector(market.meps().lifWeightUnit.selector),abi.encode(uint32(1)));
  bytes32 id=market.postBatch{value:101}(task(),2,bytes32(0));bytes32 r=keccak256("result");
  (uint8 v,bytes32 rs,bytes32 ss)=vm.sign(11,market.resultDigest(id,r,r));
  vm.expectRevert(bytes("batch digest"));market.submitResult(id,ITaskMarket.Result(r,r),abi.encodePacked(rs,ss,v));assertEq(capacity.activeSlots(host),1);
  (v,rs,ss)=vm.sign(12,market.resultDigest(id,r,r));vm.mockCall(address(market.instances()),abi.encodeWithSelector(market.instances().resolve.selector,host2),abi.encode(host2));
  vm.expectRevert(bytes("not an executor"));market.submitResult(id,ITaskMarket.Result(r,r),abi.encodePacked(rs,ss,v));assertEq(capacity.activeSlots(host),1);
 }
 function test_wiringRequiresOwnerAuthorizationAndContractOnlyOnce() public {
  vm.prank(host);vm.expectRevert();ICapacityMarket(address(market)).setHostCapacity(address(capacity));
  vm.expectRevert();ICapacityMarket(address(market)).setHostCapacity(address(123));
  capacity.setMarket(address(market),false);vm.expectRevert();wire();capacity.setMarket(address(market),true);wire();vm.expectRevert();wire();
 }
}
