// SPDX-License-Identifier: 0BSD
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/FlyCollection.sol";
import "../src/CollectionWhitelist.sol";

/// Deploys the genesis FlyCollection against an existing mesh and, when the broadcaster is the whitelist's curator,
/// lists it. The genesis set is not a parameter: it is read from the published file (flybnb/genesis/genesis-v1.json),
/// so the root that goes on-chain is the root of the file anybody can check.
///   MEPS, INSTANCES, MARKET, WHITELIST   the mesh (DeployBNB) -- deploy.sh passes them from .env.<network>
///   BASE_MEP_FEMALE [, BASE_MEP_MALE]    the base brains' MEP ids: what an adopter is bonded for, and what the collection lists
///   MINT_PRICE, MINT_BOND, BREED_FEE, HATCH_BOUNTY, ROYALTY_BPS   (wei / bps). Mainnet intent: 0.1 / 0.05 / 0.05 / 0.001 BNB, 1000 bps
///   TREASURY (default: the broadcaster), LINEAGE (default: none -- the legacy `register`), BASE_MALE (default: zero, no male base yet)
///   forge script script/DeployCollection.s.sol --rpc-url $RPC --broadcast --private-key $PK
contract DeployCollection is Script {
    using stdJson for string;
    function run() external returns (FlyCollection c, bool listed) {
        string memory g = vm.readFile(string.concat(vm.projectRoot(), "/../flybnb/genesis/genesis-v1.json"));
        bytes32 root = g.readBytes32(".root"); uint32 size = uint32(g.readUint(".size")); bytes32 baseFemale = g.readBytes32(".baseModelId");
        uint256 price = vm.envOr("MINT_PRICE", uint256(0.1 ether)); uint256 bond = vm.envOr("MINT_BOND", uint256(0.05 ether));
        uint256 breedFee = vm.envOr("BREED_FEE", uint256(0.05 ether)); uint256 bounty = vm.envOr("HATCH_BOUNTY", uint256(0.001 ether));
        uint16 bps = uint16(vm.envOr("ROYALTY_BPS", uint256(1000)));
        address whitelist = vm.envOr("WHITELIST", address(0));
        vm.startBroadcast();
        c = new FlyCollection(baseFemale, vm.envOr("BASE_MALE", bytes32(0)), root, size, price, bond, breedFee, bounty, vm.envOr("TREASURY", msg.sender),
            IMEPRegistry(vm.envAddress("MEPS")), IInstanceBonding(vm.envAddress("INSTANCES")), LineageRegistry(vm.envOr("LINEAGE", address(0))),
            vm.envBytes32("BASE_MEP_FEMALE"), vm.envOr("BASE_MEP_MALE", bytes32(0)), IRoyaltyMarket(vm.envAddress("MARKET")), bps);
        // listing is the curator's call; if that is somebody else, the collection is deployed and waits for them
        if (whitelist != address(0)) { try CollectionWhitelist(whitelist).add(address(c), "the genesis collection: the FlyBnB pilot's hundred founders") { listed = true; } catch {} }
        vm.stopBroadcast();
        console.log("collection", address(c)); console.log("genesis size", size); console.logBytes32(root); console.log("listed", listed);
    }
}
