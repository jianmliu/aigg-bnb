// SPDX-License-Identifier: 0BSD
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "aigg-porw/PorwVerifierKeccak.sol";
import "aigg-porw/mesh/MEPRegistry.sol";
import "aigg-porw/mesh/InstanceRegistry.sol";
import "aigg-porw/mesh/PoRWClaimManager.sol";
import "aigg-porw/mesh/TaskMarket.sol";
import "aigg-porw/mesh/ExecutionDisputes.sol";
import "aigg-porw/mesh/RelayRegistry.sol";
import "../src/CommitRevealBeacon.sol";
import "../src/CollectionWhitelist.sol";
import "../src/MultiAssetTaskMarket.sol";

/// Deploys the mesh with BNB-chain parameters (env-overridable; defaults = docs/DESIGN.md §4 at ~1 s blocks).
///   forge script script/DeployBNB.s.sol --rpc-url $RPC --broadcast --private-key $PK
contract DeployBNB is Script {
    struct Deployed { address verifier; address meps; address instances; address beacon; address claims; address market; address disputes; address relays; address whitelist; }
    function run() external returns (Deployed memory d) {
        uint64 epochBlocks = uint64(vm.envOr("EPOCH_BLOCKS", uint256(600)));
        uint64 commitBlocks = uint64(vm.envOr("COMMIT_BLOCKS", uint256(120)));
        uint64 revealBlocks = uint64(vm.envOr("REVEAL_BLOCKS", uint256(120)));
        uint256 beaconDeposit = vm.envOr("BEACON_DEPOSIT", uint256(0.1 ether));
        uint256 unit = vm.envOr("UNIT", uint256(0.05 ether));
        uint64 exitDelay = uint64(vm.envOr("EXIT_DELAY", uint256(3 * 600)));
        uint64 openingWindow = uint64(vm.envOr("OPENING_WINDOW", uint256(120)));
        uint256 openingDeposit = vm.envOr("OPENING_DEPOSIT", uint256(0.01 ether));
        uint256 slashAmount = vm.envOr("SLASH_AMOUNT", uint256(0.5 ether));
        uint64 taskTimeout = uint64(vm.envOr("TASK_TIMEOUT", uint256(600)));
        // how many epochs a valid residency claim keeps its instance eligible: staying eligible costs one materialization
        // every k epochs. 1 = a claim for the previous epoch (the original rule). Set once, at wiring.
        uint64 claimValidity = uint64(vm.envOr("CLAIM_VALIDITY_EPOCHS", uint256(1)));
        uint64 roundBlocks = uint64(vm.envOr("ROUND_BLOCKS", uint256(300)));
        uint256 relayBond = vm.envOr("RELAY_BOND", uint256(1 ether));
        // Standing for a replicator: for CHALLENGE_WINDOW blocks after a task settles, anybody may put up
        // CHALLENGE_DEPOSIT and a disagreeing result, and play the executors' bisection against the settled one.
        //  - the window may not outlast EXIT_DELAY (TaskMarket enforces it: a liar could otherwise settle, exit, and be
        //    challenged with nothing left to slash). The default is one epoch, cut down to EXIT_DELAY where that is
        //    shorter; a value given explicitly is passed as is and reverts if it is too long. 0 leaves the feature off.
        //  - the defender of a thrown-out challenge gets half the deposit, so half has to cover its side of a full
        //    bisection: ~1.75M of the ~3.5M gas in docs/DESIGN.md §5, i.e. 0.01 BNB pays for that up to ~5.7 gwei.
        //  - the other half goes to CHALLENGE_SINK, so that an executor cannot shield its own result by challenging
        //    itself for free. It defaults to the deployer; point it at the treasury on a real network.
        uint64 challengeWindow = uint64(vm.envOr("CHALLENGE_WINDOW", uint256(epochBlocks < exitDelay ? epochBlocks : exitDelay)));
        uint256 challengeDeposit = vm.envOr("CHALLENGE_DEPOSIT", uint256(0.02 ether));
        address challengeSink = vm.envOr("CHALLENGE_SINK", msg.sender);
        vm.startBroadcast();
        PorwVerifierKeccak verifier = new PorwVerifierKeccak();
        MEPRegistry meps = new MEPRegistry();
        InstanceRegistry inst = new InstanceRegistry(unit, exitDelay);
        CommitRevealBeacon beacon = new CommitRevealBeacon(epochBlocks, commitBlocks, revealBlocks, beaconDeposit);
        PoRWClaimManager claims = new PoRWClaimManager(meps, inst, verifier, epochBlocks, openingWindow, openingDeposit, slashAmount, IBeacon(address(beacon)));
        TaskMarket market = vm.envOr("MULTI_ASSET_MARKET", false)
            ? TaskMarket(address(new MultiAssetTaskMarket(meps, inst, claims, taskTimeout)))
            : new TaskMarket(meps, inst, claims, taskTimeout);
        ExecutionDisputes disputes = new ExecutionDisputes(meps, inst, market, roundBlocks, slashAmount);
        RelayRegistry relays = new RelayRegistry(relayBond, exitDelay);
        inst.setClaimManager(address(claims), claimValidity); inst.setSlasher(address(disputes), true); market.setDisputes(address(disputes));
        if (challengeWindow != 0) market.setChallengeParams(challengeDeposit, challengeWindow, challengeSink);
        // Which collections of brains this deployment recognises. It starts empty: collections are deployed later, against
        // these registries, and the curator lists them. The curator decides only what is listed -- it holds no funds and
        // no protocol role -- and defaults to the deployer; hand it to a multisig with proposeCurator / acceptCurator.
        CollectionWhitelist whitelist = new CollectionWhitelist(vm.envOr("CURATOR", msg.sender));
        vm.stopBroadcast();
        d = Deployed(address(verifier), address(meps), address(inst), address(beacon), address(claims), address(market), address(disputes), address(relays), address(whitelist));
        console.log("verifier", d.verifier); console.log("meps", d.meps); console.log("instances", d.instances); console.log("beacon", d.beacon);
        console.log("claims", d.claims); console.log("market", d.market); console.log("disputes", d.disputes); console.log("relays", d.relays); console.log("whitelist", d.whitelist);
        // deployments/<chainId>.json consumed by the relayer and the frontend
        string memory j = "d";
        vm.serializeUint(j, "chainId", block.chainid); vm.serializeUint(j, "epochBlocks", epochBlocks);
        vm.serializeAddress(j, "verifier", d.verifier); vm.serializeAddress(j, "meps", d.meps); vm.serializeAddress(j, "instances", d.instances); vm.serializeAddress(j, "beacon", d.beacon);
        vm.serializeAddress(j, "claims", d.claims); vm.serializeAddress(j, "market", d.market); vm.serializeAddress(j, "disputes", d.disputes);
        vm.serializeAddress(j, "relays", d.relays);
        string memory addrs = vm.serializeAddress(j, "whitelist", d.whitelist);
        string memory root = "r"; vm.serializeUint(root, "chainId", block.chainid); vm.serializeUint(root, "epochBlocks", epochBlocks); vm.serializeUint(root, "claimValidityEpochs", claimValidity);
        vm.serializeUint(root, "challengeWindow", challengeWindow); vm.serializeUint(root, "challengeDeposit", challengeWindow == 0 ? 0 : challengeDeposit);
        string memory out = vm.serializeString(root, "addresses", addrs);
        string memory file = string.concat(vm.projectRoot(), "/../deployments/", vm.toString(block.chainid), ".json");
        if (vm.envOr("WRITE_DEPLOYMENT", true)) vm.writeJson(out, file);
    }
}
