// SPDX-License-Identifier: 0BSD
pragma solidity ^0.8.20;
import "forge-std/Test.sol";
import "../src/MultiAssetTaskMarket.sol";
interface IAssets {
 function setTokenAllowed(address,bool) external;
 function setAcceptedToken(address,bool) external;
 function postTokenTask(ITaskMarket.Task calldata,address,bytes32) external returns(bytes32);
 function paymentToken(bytes32) external view returns(address);
 function tokenRoyalties(bytes32,address) external view returns(uint256);
 function withdrawTokenRoyalty(bytes32,address) external returns(uint256);
}
import "./mocks/TestToken.sol";
contract MultiAssetTaskMarketTest is Test {
 MultiAssetTaskMarket market; IAssets assets; TestToken coin; address host; address host2; address ben=address(0xBEEF);
 bytes32 mid=keccak256("model");
 function setUp() public {
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
 function test_tokenPaidAndRoyaltySeparateFromNative() public {
  enable();bytes32 id=assets.postTokenTask(task(),address(coin),bytes32(0));assertEq(assets.paymentToken(id),address(coin));submit(id);market.settle(id);
  assertEq(coin.balanceOf(host),91);assertEq(assets.tokenRoyalties(mid,address(coin)),10);assertEq(market.royalties(mid),0);
  vm.prank(ben);assets.withdrawTokenRoyalty(mid,address(coin));assertEq(coin.balanceOf(ben),10);
  bytes32 nativeId=market.postTask{value:101}(task(),bytes32(0));assertTrue(id!=nativeId);assertEq(assets.paymentToken(nativeId),address(0));submit(nativeId);market.settle(nativeId);assertEq(host.balance,91);assertEq(market.royalties(mid),10);
 }
 function test_noOptInCannotSpendAndTaxedTokensRejected() public {
  assets.setTokenAllowed(address(coin),true);vm.expectRevert();assets.postTokenTask(task(),address(coin),bytes32(0));assertEq(coin.balanceOf(address(this)),10000);
  vm.prank(host);assets.setAcceptedToken(address(coin),true);coin.setTax(true);vm.expectRevert();assets.postTokenTask(task(),address(coin),bytes32(0));assertEq(coin.balanceOf(address(market)),0);
 }
 function test_refundIsSameAssetAndClientBound() public {
  enable();bytes32 id=assets.postTokenTask(task(),address(coin),bytes32(0));vm.roll(block.number+6);market.settle(id);assertEq(coin.balanceOf(address(this)),10000);
  coin.mint(host2,101);vm.startPrank(host2);coin.approve(address(market),101);bytes32 other=assets.postTokenTask(task(),address(coin),bytes32(0));vm.stopPrank();assertTrue(id!=other);
 }
 function test_beneficiaryGainingCodeDoesNotChangePaymentMode() public {
  enable();bytes32 id=assets.postTokenTask(task(),address(coin),bytes32(0));vm.etch(ben,hex"60006000fd");submit(id);market.settle(id);assertEq(assets.tokenRoyalties(mid,address(coin)),10);
 }
 receive() external payable {}
}
