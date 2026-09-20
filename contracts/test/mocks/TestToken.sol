// SPDX-License-Identifier: 0BSD
pragma solidity ^0.8.20;
contract TestToken {
 uint8 public constant decimals=18;
 mapping(address=>uint256) public balanceOf;
 mapping(address=>mapping(address=>uint256)) public allowance;
 bool public tax;
 function setTax(bool b) external {tax=b;}
 function mint(address a,uint256 n) external {balanceOf[a]+=n;}
 function approve(address a,uint256 n) external returns(bool){allowance[msg.sender][a]=n;return true;}
 function transfer(address a,uint256 n) external returns(bool){_move(msg.sender,a,n);return true;}
 function transferFrom(address a,address b,uint256 n) external returns(bool){allowance[a][msg.sender]-=n;_move(a,b,n);return true;}
 function _move(address a,address b,uint256 n) internal {balanceOf[a]-=n;balanceOf[b]+=tax?n-1:n;}
}
