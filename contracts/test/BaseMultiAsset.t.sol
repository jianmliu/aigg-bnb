// SPDX-License-Identifier: 0BSD
pragma solidity ^0.8.20;
import "./MultiAssetIntegration.t.sol";
contract BaseMultiAssetTest is MultiAssetIntegrationTest {
 function test_basePoolTokenChildDisputeSlashesAndPreservesAsset() public {
  inst.setMEPRegistry(address(meps));bytes32 base=mepId;TestToken token=tokenSetup();
  IMEPRegistry.MEP memory profile=meps.getMEP(base);profile.modelId=keccak256("child");
  mepId=meps.registerDerivedMEP(profile,base);
  assertEq(inst.enrolled(mepId),2);assertEq(inst.weightCap(mepId),inst.weightCap(base));
  bytes32 id=market.postTokenTask(task(2),address(token),"basechild");address[] memory ex=market.executors(id);
  (bytes32 execution,,,,)=market.taskInfo(id);assertEq(execution,mepId);
  (ITaskMarket.Result memory ra,,)=FX.resultA0();(ITaskMarket.Result memory rb,,)=FX.resultB0();
  submit(id,ex[0],ra.execDigest,ra.execRoot);submit(id,ex[1],rb.execDigest,rb.execRoot);market.settle(id);
  uint256 beforeBond=inst.bonded(ex[1]);vm.prank(ex[0]);disp.revealRoots(id,FX.actRootsA());vm.roll(block.number+11);disp.timeout(id);
  assertTrue(market.disputeResolved(id));assertEq(inst.bonded(ex[1]),beforeBond-SLASH);assertEq(token.balanceOf(ex[0]),task(2).fee);assertEq(token.balanceOf(ex[1]),0);
 }
}
