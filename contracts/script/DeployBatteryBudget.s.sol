// SPDX-License-Identifier: 0BSD
pragma solidity ^0.8.20;
import "forge-std/Script.sol";
import "../src/BatteryBudget.sol";
contract DeployBatteryBudget is Script {
    function run() external returns(BatteryBudget factory){
        BatteryPolicy memory p=BatteryPolicy(vm.envBytes32("BATTERY_VERSION_HASH"),vm.envBytes32("BATTERY_RUNS_ROOT"),uint32(vm.envUint("BATTERY_RUNS")),uint32(vm.envUint("BATTERY_STEPS")),uint32(vm.envUint("BATTERY_STRIDE")),uint8(vm.envUint("BATTERY_REDUNDANCY")),uint8(vm.envUint("BATTERY_ATTEMPTS")),vm.envUint("BATTERY_FEE_WEI"),uint64(vm.envUint("BATTERY_LIFETIME_SECONDS")));
        FlyCollection c=FlyCollection(payable(vm.envAddress("BATTERY_COLLECTION")));TaskMarket m=TaskMarket(vm.envAddress("BATTERY_MARKET"));address op=vm.envAddress("BATTERY_OPERATOR");
        vm.startBroadcast();factory=new BatteryBudget(c,m,op,p);vm.stopBroadcast();
    }
}
