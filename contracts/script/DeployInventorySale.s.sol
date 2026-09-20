// SPDX-License-Identifier: 0BSD
pragma solidity ^0.8.20;
import "forge-std/Script.sol";
import "../src/TreasuryInventorySale.sol";
contract DeployInventorySale is Script {
    function run() external returns (TreasuryInventorySale sale) {
        address collection = vm.envAddress("SALE_COLLECTION");
        address treasury = vm.envAddress("SALE_TREASURY");
        vm.startBroadcast();
        sale = new TreasuryInventorySale(collection, treasury);
        vm.stopBroadcast();
    }
}
