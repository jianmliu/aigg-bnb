// SPDX-License-Identifier: 0BSD
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/FlyCollection.sol";
import "aigg-porw/mesh/MEPRegistry.sol";
import "aigg-porw/mesh/InstanceRegistry.sol";
import "aigg-porw/mesh/PoRWClaimManager.sol";
import "aigg-porw/mesh/TaskMarket.sol";
import "aigg-porw/PorwVerifierKeccak.sol";

/// The royalty follows the fly. An individual's MEP is registered under terms whose beneficiary is the collection
/// itself, and the collection pays whoever owns the token -- so a sale needs no "update the address" step, and what
/// accrued before the sale is the seller's.
contract FlyCollectionRoyaltyTest is Test {
    FlyCollection c; MEPRegistry meps; AccruingMarket market;
    address alice = address(0xA11CE); address bob = address(0xB0B); address treasury = address(0x7EA);
    bytes32 constant BASE_F = keccak256("female-base"); bytes32 constant BASE_M = keccak256("male-base");
    bytes32 constant DF = keccak256("delta-female-0"); bytes32 constant DM = keccak256("delta-male-1");
    uint256 constant PRICE = 0.06 ether; uint256 constant FEE = 0.01 ether; uint16 constant BPS = 500; // 5%

    function leaf(uint32 i, uint8 sex, bytes32 d) internal pure returns (bytes32) { return keccak256(abi.encode(i, sex, d)); }
    function root() internal pure returns (bytes32) { bytes32 a = leaf(0, 0, DF); bytes32 b = leaf(1, 1, DM); return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a)); }
    function proofFor(uint32 i) internal pure returns (bytes32[] memory p) { p = new bytes32[](1); p[0] = i == 0 ? leaf(1, 1, DM) : leaf(0, 0, DF); }
    function mep(bytes32 modelId) internal pure returns (IMEPRegistry.MEP memory) {
        return IMEPRegistry.MEP({ modelId: modelId, schemeDigest: SCHEME_SKETCH_TILE_KECCAK_V3, execKind: keccak256("aigg:exec:int-lif:v1"),
            neurons: 139255, synapses: 2700513, synapseRoot: keccak256("syn"), weightsDA: bytes("gnfd://aigg-brains/x.bin") });
    }
    function profileId(IMEPRegistry.MEP memory m) internal pure returns (bytes32) { return PorwMeshHash.mepId(m.schemeDigest, m.modelId, m.execKind, m.neurons, m.synapses, m.synapseRoot); }
    function deploy(uint16 bps) internal returns (FlyCollection) {
        return new FlyCollection(BASE_F, BASE_M, root(), 2, PRICE, 0, FEE, 0, treasury, IMEPRegistry(address(meps)), IInstanceBonding(address(0)), LineageRegistry(address(0)), bytes32(0), bytes32(0), IRoyaltyMarket(address(market)), bps);
    }

    function setUp() public {
        meps = new MEPRegistry(); market = new AccruingMarket(meps); c = deploy(BPS);
        vm.deal(alice, 10 ether); vm.deal(bob, 10 ether); vm.deal(address(this), 10 ether);
    }
    function adoptAndRegister(address who, uint32 index, uint8 sex, bytes32 d, bytes32 modelId) internal returns (uint256 id, bytes32 mepId) {
        vm.startPrank(who); id = c.mint{value: PRICE}(index, sex, d, proofFor(index)); mepId = c.register(id, d, mep(modelId)); vm.stopPrank();
    }

    function test_an_adopted_fly_is_registered_under_terms_that_pay_the_collection() public {
        // before anyone adopts it there is no MEP for it at all -- and the base brains, which nobody adopts, carry no terms
        (uint256 id, bytes32 mepId) = adoptAndRegister(alice, 0, 0, DF, keccak256("applied-f"));
        assertEq(mepId, PorwMeshHash.mepIdWithTerms(profileId(mep(keccak256("applied-f"))), address(c), BPS), "the terms are inside the id");
        (address ben, uint16 bps) = meps.termsOf(mepId);
        assertEq(ben, address(c), "the beneficiary is the collection, which forwards: it never has to change"); assertEq(bps, BPS);
        (,,, bytes32 stored,,,,,,) = c.individuals(id); assertEq(stored, mepId); assertEq(c.tokenOfMep(mepId), id);
    }

    function test_a_collection_with_no_royalty_registers_plain_profiles_as_before() public {
        FlyCollection plain = deploy(0);
        vm.startPrank(alice); uint256 id = plain.mint{value: PRICE}(0, 0, DF, proofFor(0)); bytes32 mepId = plain.register(id, DF, mep(keccak256("applied-f"))); vm.stopPrank();
        assertEq(mepId, profileId(mep(keccak256("applied-f")))); (address ben,) = meps.termsOf(mepId); assertEq(ben, address(0));
    }

    function test_the_royalty_is_paid_to_whoever_owns_the_fly() public {
        (uint256 id, bytes32 mepId) = adoptAndRegister(alice, 0, 0, DF, keccak256("applied-f"));
        market.accrue{value: 1 ether}(mepId); // experiments against her fly settled: TaskMarket set this aside
        vm.prank(bob); c.settle(id);          // anyone may move it over; it is credited to the owner, not the caller
        assertEq(c.owed(alice), 1 ether); assertEq(c.owed(bob), 0); assertEq(market.royalties(mepId), 0);
        uint256 before = alice.balance; vm.prank(alice); c.withdraw(); assertEq(alice.balance, before + 1 ether); assertEq(c.owed(alice), 0);
        vm.prank(alice); vm.expectRevert(bytes("nothing owed")); c.withdraw();
    }

    function test_a_sale_needs_no_address_update_and_what_accrued_before_it_is_the_sellers() public {
        (uint256 id, bytes32 mepId) = adoptAndRegister(alice, 0, 0, DF, keccak256("applied-f"));
        market.accrue{value: 1 ether}(mepId);                       // earned while alice owned it, not yet collected
        vm.prank(alice); c.transferFrom(alice, bob, id);            // the sale settles it to her first
        assertEq(c.owed(alice), 1 ether, "the seller keeps what her fly earned"); assertEq(c.owed(bob), 0);
        market.accrue{value: 0.5 ether}(mepId);                     // earned after the sale
        c.settle(id); assertEq(c.owed(bob), 0.5 ether, "and the buyer is paid from then on, with nothing to update"); assertEq(c.owed(alice), 1 ether);
        (address ben,) = meps.termsOf(mepId); assertEq(ben, address(c), "the on-chain beneficiary never moved");
        vm.prank(bob); c.safeTransferFrom(bob, alice, id); assertEq(c.owed(bob), 0.5 ether); // safeTransferFrom goes the same way
    }

    function test_a_transfer_never_fails_for_lack_of_royalties_or_of_a_mep() public {
        vm.prank(alice); uint256 unregistered = c.mint{value: PRICE}(0, 0, DF, proofFor(0));
        vm.prank(alice); c.transferFrom(alice, bob, unregistered); assertEq(c.ownerOf(unregistered), bob); // no MEP yet
        (uint256 id,) = adoptAndRegister(alice, 1, 1, DM, keccak256("applied-m"));
        vm.prank(alice); c.transferFrom(alice, bob, id); assertEq(c.ownerOf(id), bob);                     // a MEP, nothing accrued
        assertEq(c.settle(id), 0); assertEq(c.settle(unregistered), 0);
    }

    function test_one_mep_pays_one_fly() public {
        (, bytes32 mepId) = adoptAndRegister(alice, 0, 0, DF, keccak256("applied-f"));
        // bob adopts the other individual and tries to bind it to alice's brain, to collect on it
        vm.startPrank(bob); uint256 other = c.mint{value: PRICE}(1, 1, DM, proofFor(1));
        vm.expectRevert(bytes("mep taken")); c.register(other, DM, mep(keccak256("applied-f"))); vm.stopPrank();
        assertEq(c.tokenOfMep(mepId), 1);
    }

    function test_only_the_market_may_pay_the_collection() public {
        (bool ok,) = address(c).call{value: 1 ether}(""); assertFalse(ok, "stray ether would be nobody's");
    }

    function test_a_royalty_needs_a_market_and_a_sane_rate() public {
        vm.expectRevert(bytes("royalty")); new FlyCollection(BASE_F, BASE_M, root(), 2, PRICE, 0, FEE, 0, treasury, IMEPRegistry(address(meps)), IInstanceBonding(address(0)), LineageRegistry(address(0)), bytes32(0), bytes32(0), IRoyaltyMarket(address(0)), BPS);
        vm.expectRevert(bytes("royalty")); new FlyCollection(BASE_F, BASE_M, root(), 2, PRICE, 0, FEE, 0, treasury, IMEPRegistry(address(meps)), IInstanceBonding(address(0)), LineageRegistry(address(0)), bytes32(0), bytes32(0), IRoyaltyMarket(address(market)), 10001);
    }

    /// the stand-in below is three lines of TaskMarket; this is the real one, to show the collection speaks to it
    function test_the_real_task_market_has_the_two_calls_the_collection_makes() public {
        InstanceRegistry inst = new InstanceRegistry(0.05 ether, 10);
        PoRWClaimManager cm = new PoRWClaimManager(IMEPRegistry(address(meps)), inst, new PorwVerifierKeccak(), 40, 10, 0.01 ether, 0.5 ether, IBeacon(address(0)));
        TaskMarket real = new TaskMarket(IMEPRegistry(address(meps)), inst, cm, 30);
        FlyCollection live = new FlyCollection(BASE_F, BASE_M, root(), 2, PRICE, 0, FEE, 0, treasury, IMEPRegistry(address(meps)), IInstanceBonding(address(0)), LineageRegistry(address(0)), bytes32(0), bytes32(0), IRoyaltyMarket(address(real)), BPS);
        vm.startPrank(alice); uint256 id = live.mint{value: PRICE}(0, 0, DF, proofFor(0)); bytes32 mepId = live.register(id, DF, mep(keccak256("applied-f"))); vm.stopPrank();
        assertEq(real.royalties(mepId), 0); assertEq(live.settle(id), 0); // reads the real mapping, and does not call withdrawRoyalty on nothing (it would revert)
        vm.prank(alice); live.transferFrom(alice, bob, id); assertEq(live.ownerOf(id), bob);
    }
}

/// TaskMarket's royalty side, verbatim in behaviour: fees set aside by mepId, collected only by the MEP's beneficiary
contract AccruingMarket is IRoyaltyMarket {
    MEPRegistry immutable meps; mapping(bytes32 => uint256) public royalties;
    constructor(MEPRegistry m) { meps = m; }
    function accrue(bytes32 mepId) external payable { royalties[mepId] += msg.value; }
    function withdrawRoyalty(bytes32 mepId) external returns (uint256 amt) {
        (address ben,) = meps.termsOf(mepId); require(msg.sender == ben, "beneficiary");
        amt = royalties[mepId]; require(amt > 0, "nothing"); royalties[mepId] = 0;
        (bool ok,) = msg.sender.call{value: amt}(""); require(ok, "withdraw");
    }
}
