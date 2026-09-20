// SPDX-License-Identifier: 0BSD
pragma solidity ^0.8.20;
import "./TestToken.sol";
contract TestSwapRouter {
 TestToken public token; uint256 public cost=0.02 ether; address public constant WETH=address(0x1234);
 constructor(TestToken t){token=t;}
 function getAmountsIn(uint amount,address[] calldata) external view returns(uint[] memory a){a=new uint[](2);a[0]=cost;a[1]=amount;}
 function setCost(uint256 v) external {cost=v;}
 function swapETHForExactTokens(uint amount,address[] calldata path,address to,uint deadline) external payable returns(uint[] memory a){
  require(block.timestamp<=deadline&&msg.value>=cost&&path.length==2&&path[0]==WETH&&path[1]==address(token),"swap");
  token.transfer(to,amount);(bool ok,)=msg.sender.call{value:msg.value-cost}("");require(ok,"refund");a=new uint[](2);a[0]=cost;a[1]=amount;
 }
}
