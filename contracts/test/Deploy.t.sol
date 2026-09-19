// SPDX-License-Identifier: 0BSD
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../script/DeployBNB.s.sol";
import "../script/DeployCollection.s.sol";

/// The deployment script wires the mesh with the BNB parameters and the commit-reveal beacon.
contract DeployTest is Test {
    function test_deploy_wiring() public {
        DeployBNB s = new DeployBNB(); DeployBNB.Deployed memory d = s.run();
        InstanceRegistry inst = InstanceRegistry(d.instances); PoRWClaimManager cm = PoRWClaimManager(d.claims); TaskMarket m = TaskMarket(payable(d.market));
        assertEq(inst.claimManager(), d.claims); assertTrue(inst.slasher(d.disputes)); assertEq(m.disputes(), d.disputes);
        assertEq(address(cm.beaconProvider()), d.beacon, "claims roll from the commit-reveal beacon");
        assertEq(cm.EPOCH_BLOCKS(), 600); assertEq(inst.UNIT(), 0.05 ether); assertEq(cm.SLASH_AMOUNT(), 0.5 ether); assertEq(RelayRegistry(d.relays).BOND(), 1 ether);
        assertEq(CommitRevealBeacon(d.beacon).EPOCH_BLOCKS(), 600);
        CollectionWhitelist w = CollectionWhitelist(d.whitelist); assertEq(w.collections().length, 0, "the whitelist starts empty"); assertTrue(w.curator() != address(0), "and has a curator");
        // a replicator has standing: one epoch to challenge a settled result, inside the exit delay, half of a lost deposit to the sink
        assertEq(m.challengeWindow(), 600); assertLe(m.challengeWindow(), inst.EXIT_DELAY()); assertEq(m.challengeDepositWei(), 0.02 ether);
        assertEq(m.challengeSink(), address(this), "defaults to whoever ran the script");
        assertEq(m.requiredChallengeDeposit(bytes32(0)), 0.02 ether);
        _challengeWindowCases();
    }
    /// The ways CHALLENGE_WINDOW can be set. The environment belongs to the process and forge runs tests in parallel, so
    /// this is called from the one test above rather than being tests of its own, which would deploy with each other's variables.
    function _challengeWindowCases() internal {
        vm.setEnv("WRITE_DEPLOYMENT", "false");
        // the default follows EXIT_DELAY down, because TaskMarket refuses a window that outlasts it
        vm.setEnv("EXIT_DELAY", "5");
        assertEq(TaskMarket(payable(new DeployBNB().run().market)).challengeWindow(), 5);
        vm.setEnv("EXIT_DELAY", "1800");
        // 0 leaves the feature off, and off is safe: challengeResult reverts "disabled"
        vm.setEnv("CHALLENGE_WINDOW", "0");
        TaskMarket m = TaskMarket(payable(new DeployBNB().run().market));
        assertEq(m.challengeWindow(), 0); assertEq(m.challengeSink(), address(0));
        // an explicit window is not silently shortened: too long is a failed deployment, not a quietly different one.
        // Last, because the reverted run leaves its broadcast open.
        vm.setEnv("CHALLENGE_WINDOW", "1801");
        DeployBNB s = new DeployBNB(); vm.expectRevert(bytes("window")); s.run();
    }

    /// the collection goes on top of a deployed mesh, from the published genesis file, and is listed by the curator
    function test_deploy_the_genesis_collection_and_list_it() public {
        vm.setEnv("CURATOR", vm.toString(DEFAULT_SENDER)); // what a real run has: the curator is whoever broadcasts, not this test contract
        DeployBNB.Deployed memory d = new DeployBNB().run();
        bytes32 baseMep = MEPRegistry(d.meps).registerMEP(IMEPRegistry.MEP({ modelId: keccak256("base"), schemeDigest: SCHEME_SKETCH_TILE_KECCAK_V3, execKind: keccak256("aigg:exec:int-lif:v1"), neurons: 1, synapses: 1, synapseRoot: keccak256("s"), weightsDA: bytes("gnfd://b/o") }));
        vm.setEnv("MEPS", vm.toString(d.meps)); vm.setEnv("INSTANCES", vm.toString(d.instances)); vm.setEnv("MARKET", vm.toString(d.market)); vm.setEnv("WHITELIST", vm.toString(d.whitelist));
        vm.setEnv("BASE_MEP_FEMALE", vm.toString(baseMep)); vm.setEnv("MINT_PRICE", "10000000000000000"); vm.setEnv("MINT_BOND", "5000000000000000"); vm.setEnv("BREED_FEE", "5000000000000000"); vm.setEnv("HATCH_BOUNTY", "100000000000000");
        (FlyCollection c, bool listed) = new DeployCollection().run();
        assertEq(c.GENESIS_SIZE(), 100); assertEq(c.GENESIS_ROOT(), 0x02d6d4d2941aef5844a9d017809e27be55a6d739aa83c0e2786038563adc4d78, "the root on-chain is the root of the published file");
        assertEq(c.MINT_PRICE(), 0.01 ether); assertEq(c.MINT_BOND(), 0.005 ether); assertEq(c.ROYALTY_BPS(), 1000); assertEq(address(c.MARKET()), d.market); assertEq(c.BASE_MEP_FEMALE(), baseMep);
        assertTrue(listed); (bool ok, address by) = CollectionWhitelist(d.whitelist).listed(baseMep); assertTrue(ok, "and its base brain is one of the system's"); assertEq(by, address(c));
    }
}
