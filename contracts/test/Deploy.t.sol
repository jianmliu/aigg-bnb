// SPDX-License-Identifier: 0BSD
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../script/DeployBNB.s.sol";

/// The deployment script wires the mesh with the BNB parameters and the commit-reveal beacon.
contract DeployTest is Test {
    function test_deploy_wiring() public {
        DeployBNB s = new DeployBNB(); DeployBNB.Deployed memory d = s.run();
        InstanceRegistry inst = InstanceRegistry(d.instances); PoRWClaimManager cm = PoRWClaimManager(d.claims); TaskMarket m = TaskMarket(payable(d.market));
        assertEq(inst.claimManager(), d.claims); assertTrue(inst.slasher(d.disputes)); assertEq(m.disputes(), d.disputes);
        assertEq(address(cm.beaconProvider()), d.beacon, "claims roll from the commit-reveal beacon");
        assertEq(cm.EPOCH_BLOCKS(), 600); assertEq(inst.UNIT(), 0.05 ether); assertEq(cm.SLASH_AMOUNT(), 0.5 ether); assertEq(RelayRegistry(d.relays).BOND(), 1 ether);
        assertEq(CommitRevealBeacon(d.beacon).EPOCH_BLOCKS(), 600);
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
}
