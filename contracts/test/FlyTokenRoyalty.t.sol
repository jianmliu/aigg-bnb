// SPDX-License-Identifier: 0BSD
pragma solidity ^0.8.20;
import "./FlyCollectionRoyalty.t.sol";
import {TestToken} from "./MultiAssetTaskMarket.t.sol";
interface ITokenRoyaltyFly {
 function settleToken(uint256,address) external returns(uint256);
 function royaltyRecipients(bytes32) external view returns(address,address,uint16);
 function onTokenRoyalty(bytes32,address,uint256) external;
 function withdrawToken(address) external returns(uint256);
 function tokenOwed(address,address) external view returns(uint256);
}
contract FlyTokenRoyaltyTest is FlyCollectionRoyaltyTest {
 function test_failedSnapshotRoyaltyCanBeRecoveredAndWithdrawn() public {
  (uint256 id,bytes32 mid)=adoptAndRegister(alice,0,0,DF,keccak256("recovery-model"));
  RecoveryRoyaltyMarket recovery=new RecoveryRoyaltyMarket();vm.etch(address(market),address(recovery).code);
  TestToken token=new TestToken();token.mint(address(market),100);RecoveryRoyaltyMarket(address(market)).accrue(mid,address(token),100);
  assertEq(ITokenRoyaltyFly(address(c)).settleToken(id,address(token)),100);
  assertEq(c.tokenOwed(address(token),alice),100);assertEq(RecoveryRoyaltyMarket(address(market)).tokenRoyalties(mid,address(token)),0);
  assertEq(ITokenRoyaltyFly(address(c)).settleToken(id,address(token)),0);
  vm.prank(alice);c.withdrawToken(address(token));assertEq(token.balanceOf(alice),100);
 }
 function test_synchronousRecipientsFollowCurrentOwner() public {
  (uint256 id,bytes32 mid)=adoptAndRegister(alice,0,0,DF,keccak256("sync-model"));
  (address holder,address vendor,uint16 share)=ITokenRoyaltyFly(address(c)).royaltyRecipients(mid);
  assertEq(holder,alice);assertEq(vendor,address(0));assertEq(share,0);
  vm.prank(alice);c.transferFrom(alice,bob,id);
  (holder,,)=ITokenRoyaltyFly(address(c)).royaltyRecipients(mid);assertEq(holder,bob);
  vm.expectRevert();ITokenRoyaltyFly(address(c)).royaltyRecipients(bytes32(uint256(123)));
 }
 function test_tokenCreditStaysWithOwnerAtSettlement() public {
  (uint256 id,bytes32 mid)=adoptAndRegister(alice,0,0,DF,keccak256("token-model"));TestToken t=new TestToken();ITokenRoyaltyFly f=ITokenRoyaltyFly(address(c));
  t.mint(address(c),100);vm.prank(address(market));f.onTokenRoyalty(mid,address(t),100);
  vm.prank(alice);c.transferFrom(alice,bob,id);t.mint(address(c),50);vm.prank(address(market));f.onTokenRoyalty(mid,address(t),50);
  assertEq(f.tokenOwed(address(t),alice),100);assertEq(f.tokenOwed(address(t),bob),50);
  vm.prank(alice);f.withdrawToken(address(t));assertEq(t.balanceOf(alice),100);assertEq(c.owed(alice),0);
  vm.prank(bob);vm.expectRevert();f.onTokenRoyalty(mid,address(t),100);
 }
}

contract RecoveryRoyaltyMarket {
 mapping(bytes32=>mapping(address=>uint256)) public tokenRoyalties;
 function accrue(bytes32 mid,address token,uint256 n) external{tokenRoyalties[mid][token]=n;}
 function withdrawTokenRoyalty(bytes32 mid,address token) external returns(uint256 n){n=tokenRoyalties[mid][token];tokenRoyalties[mid][token]=0;TestToken(token).transfer(msg.sender,n);}
}
