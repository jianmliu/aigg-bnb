// SPDX-License-Identifier: 0BSD
pragma solidity ^0.8.20;
interface ISynchronousBatteryMarket {
 function sessionState(bytes32) external view returns(uint8,uint64,uint64,uint64);
 function credits(address,address) external view returns(uint256);
 function withdrawCredit(address,address payable) external returns(uint256);
}
/// Version is pinned at job construction. Once synchronous, a failed state read never falls back to legacy acceptance.
library BatterySettlement {
 function isSynchronous(address market) internal view returns(bool){
  (bool ok,bytes memory data)=market.staticcall(abi.encodeWithSignature("protocolVersion()"));
  if(!ok||data.length==0)return false;
  require(data.length==32&&abi.decode(data,(uint256))==1,"unsupported market protocol");return true;
 }
 function phase(address market,bytes32 id) internal view returns(uint8 p){(p,,,)=ISynchronousBatteryMarket(market).sessionState(id);}
 function pull(address market,address token) internal {
  if(ISynchronousBatteryMarket(market).credits(token,address(this))>0)
   ISynchronousBatteryMarket(market).withdrawCredit(token,payable(address(this)));
 }
}
