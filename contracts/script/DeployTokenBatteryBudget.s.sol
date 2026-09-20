// SPDX-License-Identifier: 0BSD
pragma solidity ^0.8.20;
import "forge-std/Script.sol";
import "../src/TokenBatteryBudget.sol";
contract DeployTokenBatteryBudget is Script {
 function run() external returns(TokenBatteryBudget factory){
  uint256 runs=vm.envUint("BATTERY_RUNS");uint256 steps=vm.envUint("BATTERY_STEPS");uint256 stride=vm.envUint("BATTERY_STRIDE");uint256 redundancy=vm.envUint("BATTERY_REDUNDANCY");uint256 attempts=vm.envUint("BATTERY_ATTEMPTS");uint256 lifetime=vm.envUint("BATTERY_LIFETIME_SECONDS");
  require(runs<=type(uint32).max&&steps<=type(uint32).max&&stride<=type(uint32).max&&redundancy<=type(uint8).max&&attempts<=type(uint8).max&&lifetime<=type(uint64).max,"policy overflow");
  BatteryPolicy memory p=BatteryPolicy(vm.envBytes32("BATTERY_VERSION_HASH"),vm.envBytes32("BATTERY_RUNS_ROOT"),uint32(runs),uint32(steps),uint32(stride),uint8(redundancy),uint8(attempts),vm.envUint("BATTERY_FEE_UNITS"),uint64(lifetime));
  FlyCollection c=FlyCollection(payable(vm.envAddress("BATTERY_COLLECTION")));MultiAssetTaskMarket m=MultiAssetTaskMarket(vm.envAddress("BATTERY_MARKET"));
  address op=vm.envAddress("BATTERY_OPERATOR");address token=vm.envAddress("BATTERY_PAYMENT_TOKEN");address router=vm.envOr("BATTERY_SWAP_ROUTER",address(0));
  vm.startBroadcast();factory=new TokenBatteryBudget(c,m,op,p,token,IExactOutputRouter(router));vm.stopBroadcast();
 }
}
