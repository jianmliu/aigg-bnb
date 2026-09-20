// SPDX-License-Identifier: 0BSD
pragma solidity ^0.8.20;
interface IERC20Budget {
 function balanceOf(address) external view returns(uint256);
 function transfer(address,uint256) external returns(bool);
 function transferFrom(address,address,uint256) external returns(bool);
 function approve(address,uint256) external returns(bool);
}
/// Only conventional, non-rebasing tokens are supported. Never accept short transfers.
library TokenTransfer {
 function callToken(address token,bytes memory data) internal {
  require(token.code.length>0,"token code");(bool ok,bytes memory ret)=token.call(data);
  require(ok&&(ret.length==0||(ret.length==32&&abi.decode(ret,(bool)))),"token call");
 }
 function pull(address token,address from,address to,uint256 n) internal {
  uint256 before_=IERC20Budget(token).balanceOf(to);
  callToken(token,abi.encodeCall(IERC20Budget.transferFrom,(from,to,n)));
  require(IERC20Budget(token).balanceOf(to)==before_+n,"nonexact token");
 }
 function send(address token,address to,uint256 n) internal {
  if(n==0)return;uint256 before_=IERC20Budget(token).balanceOf(to);
  callToken(token,abi.encodeCall(IERC20Budget.transfer,(to,n)));
  require(IERC20Budget(token).balanceOf(to)==before_+n,"nonexact token");
 }
 function approve(address token,address spender,uint256 n) internal {
  callToken(token,abi.encodeCall(IERC20Budget.approve,(spender,0)));
  if(n>0)callToken(token,abi.encodeCall(IERC20Budget.approve,(spender,n)));
 }
}
