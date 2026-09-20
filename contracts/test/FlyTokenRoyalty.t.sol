// SPDX-License-Identifier: 0BSD
pragma solidity ^0.8.20;
import "./FlyCollectionRoyalty.t.sol";
import {TestToken} from "./MultiAssetTaskMarket.t.sol";
interface ITokenRoyaltyFly {
 function onTokenRoyalty(bytes32,address,uint256) external;
 function withdrawToken(address) external returns(uint256);
 function tokenOwed(address,address) external view returns(uint256);
}
contract FlyTokenRoyaltyTest is FlyCollectionRoyaltyTest {
 function test_tokenCreditStaysWithOwnerAtSettlement() public {
  (uint256 id,bytes32 mid)=adoptAndRegister(alice,0,0,DF,keccak256("token-model"));TestToken t=new TestToken();ITokenRoyaltyFly f=ITokenRoyaltyFly(address(c));
  t.mint(address(c),100);vm.prank(address(market));f.onTokenRoyalty(mid,address(t),100);
  vm.prank(alice);c.transferFrom(alice,bob,id);t.mint(address(c),50);vm.prank(address(market));f.onTokenRoyalty(mid,address(t),50);
  assertEq(f.tokenOwed(address(t),alice),100);assertEq(f.tokenOwed(address(t),bob),50);
  vm.prank(alice);f.withdrawToken(address(t));assertEq(t.balanceOf(alice),100);assertEq(c.owed(alice),0);
  vm.prank(bob);vm.expectRevert();f.onTokenRoyalty(mid,address(t),100);
 }
}
