// SPDX-License-Identifier: 0BSD
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/CollectionWhitelist.sol";
import "../src/FlyCollection.sol";
import "aigg-porw/mesh/MEPRegistry.sol";

/// The whitelist is of collections. A recognised collection answers for its own brains, bred ones included; a
/// collection somebody deployed for themselves, and a MEP registered with no collection at all, are outside it.
contract CollectionWhitelistTest is Test {
    CollectionWhitelist w; MEPRegistry meps; FlyCollection ours; FlyCollection theirs;
    address curator = address(0xC0FFEE); address alice = address(0xA11CE); address bob = address(0xB0B); address treasury = address(0x7EA);
    bytes32 constant BASE_F = keccak256("female-base"); bytes32 constant BASE_M = keccak256("male-base");
    bytes32 constant DF = keccak256("delta-female-0"); bytes32 constant DM = keccak256("delta-male-1");
    uint256 constant PRICE = 0.06 ether; uint256 constant FEE = 0.01 ether;
    bytes32 baseF;

    function leaf(uint32 i, uint8 sex, bytes32 d) internal pure returns (bytes32) { return keccak256(abi.encode(i, sex, d)); }
    function root() internal pure returns (bytes32) { bytes32 a = leaf(0, 0, DF); bytes32 b = leaf(1, 1, DM); return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a)); }
    function proofFor(uint32 i) internal pure returns (bytes32[] memory p) { p = new bytes32[](1); p[0] = i == 0 ? leaf(1, 1, DM) : leaf(0, 0, DF); }
    function mep(bytes32 modelId) internal pure returns (IMEPRegistry.MEP memory) {
        return IMEPRegistry.MEP({ modelId: modelId, schemeDigest: SCHEME_SKETCH_TILE_KECCAK_V3, execKind: keccak256("aigg:exec:int-lif:v1"),
            neurons: 139255, synapses: 2700513, synapseRoot: keccak256("syn"), weightsDA: bytes("gnfd://aigg-brains/x.bin") });
    }
    function collection() internal returns (FlyCollection) {
        return new FlyCollection(BASE_F, BASE_M, root(), 2, PRICE, 0, FEE, 0, treasury, IMEPRegistry(address(meps)), IInstanceBonding(address(0)), LineageRegistry(address(0)), baseF, bytes32(0), IRoyaltyMarket(address(0)), 0, FlyCollection.Shares(address(0), 0, 0, address(0)));
    }
    function setUp() public {
        meps = new MEPRegistry(); baseF = meps.registerMEP(mep(BASE_F));
        w = new CollectionWhitelist(curator); ours = collection(); theirs = collection(); // the same code, the same genesis set: only one is recognised
        vm.prank(curator); w.add(address(ours), "the genesis collection");
        vm.deal(alice, 10 ether); vm.deal(bob, 10 ether);
    }
    function isListed(bytes32 id) internal view returns (bool ok) { (ok,) = w.listed(id); }

    function test_a_recognised_collection_answers_for_its_brains_bred_ones_included() public {
        (bool ok, address c) = w.listed(baseF); assertTrue(ok, "its base brain"); assertEq(c, address(ours));
        vm.startPrank(alice);
        uint256 f = ours.mint{value: PRICE}(0, 0, DF, proofFor(0)); uint256 m = ours.mint{value: PRICE}(1, 1, DM, proofFor(1));
        bytes32 mepF = ours.register(f, DF, mep(keccak256("applied-f"))); ours.register(m, DM, mep(keccak256("applied-m")));
        uint256 kid = ours.breed{value: FEE}(f, m); vm.roll(block.number + 2); ours.hatch(kid);
        bytes32 mepKid = ours.register(kid, keccak256("delta-kid"), mep(keccak256("applied-kid"))); vm.stopPrank();
        assertTrue(isListed(mepF), "an adopted fly, once registered");
        (ok, c) = w.listed(mepKid); assertTrue(ok, "a bred fly is listed with nobody's approval: it is a token of a listed collection"); assertEq(c, address(ours));
    }

    function test_a_collection_somebody_deploys_for_themselves_is_not_recognised() public {
        vm.startPrank(bob); uint256 id = theirs.mint{value: PRICE}(0, 0, DF, proofFor(0)); bytes32 mepId = theirs.register(id, DF, mep(keccak256("bobs-brain"))); vm.stopPrank();
        assertTrue(theirs.listed(mepId), "its own collection vouches for it"); assertFalse(isListed(mepId), "and that is not enough");
        assertFalse(w.isWhitelisted(address(theirs)));
        bytes32 loose = meps.registerMEP(mep(keccak256("no-collection"))); assertFalse(isListed(loose), "a MEP with no collection at all");
        assertFalse(isListed(bytes32(0)));
    }

    function test_only_the_curator_edits_the_list_and_only_with_something_that_can_answer() public {
        vm.prank(alice); vm.expectRevert(bytes("curator")); w.add(address(theirs), "");
        vm.startPrank(curator);
        vm.expectRevert(bytes("listed")); w.add(address(ours), "twice");
        vm.expectRevert(bytes("not a contract")); w.add(address(0xDEAD), "an address");
        vm.expectRevert(bytes("no listed()")); w.add(address(meps), "a contract that cannot answer");
        YesToEverything yes = new YesToEverything(); vm.expectRevert(bytes("lists the zero id")); w.add(address(yes), "a contract that answers yes to everything");
        w.add(address(theirs), "recognised after all"); vm.stopPrank();
        assertEq(w.collections().length, 2); assertTrue(w.isWhitelisted(address(theirs)));
    }

    function test_removing_a_collection_unrecognises_it_and_touches_nothing_else() public {
        vm.startPrank(alice); uint256 id = ours.mint{value: PRICE}(0, 0, DF, proofFor(0)); bytes32 mepId = ours.register(id, DF, mep(keccak256("applied-f"))); vm.stopPrank();
        vm.prank(curator); w.add(address(theirs), "");
        vm.prank(alice); vm.expectRevert(bytes("curator")); w.remove(address(ours), "");
        vm.prank(curator); w.remove(address(ours), "for the test");
        assertFalse(isListed(mepId)); assertFalse(w.isWhitelisted(address(ours)));
        assertEq(ours.ownerOf(id), alice); assertTrue(ours.listed(mepId)); assertTrue(meps.exists(mepId)); // the token, the binding and the MEP are where they were
        address[] memory left = w.collections(); assertEq(left.length, 1); assertEq(left[0], address(theirs), "the list stays packed");
        vm.prank(curator); vm.expectRevert(bytes("not listed")); w.remove(address(ours), "");
        vm.prank(curator); w.add(address(ours), "back"); assertTrue(isListed(mepId));
    }

    function test_a_collection_that_misbehaves_cannot_take_the_list_down() public {
        Moody moody = new Moody(); vm.prank(curator); w.add(address(moody), "well behaved when it was listed");
        vm.prank(curator); w.add(address(theirs), "");
        moody.sulk(); // it now reverts on every question
        assertTrue(isListed(baseF), "the others still answer"); assertFalse(isListed(keccak256("anything")));
    }

    function test_the_job_is_handed_over_in_two_steps_or_given_up_for_good() public {
        vm.prank(alice); vm.expectRevert(bytes("curator")); w.proposeCurator(alice);
        vm.prank(curator); w.proposeCurator(alice);
        assertEq(w.curator(), curator, "proposing changes nothing"); vm.prank(bob); vm.expectRevert(bytes("pending")); w.acceptCurator();
        vm.prank(alice); w.acceptCurator(); assertEq(w.curator(), alice); assertEq(w.pendingCurator(), address(0));
        vm.prank(curator); vm.expectRevert(bytes("curator")); w.add(address(theirs), "the old curator");
        vm.prank(alice); w.renounceCurator(); assertEq(w.curator(), address(0));
        vm.prank(alice); vm.expectRevert(bytes("curator")); w.add(address(theirs), "frozen");
        assertTrue(isListed(baseF), "and the list still answers");
    }

    function test_the_list_is_bounded() public {
        vm.startPrank(curator);
        for (uint256 i = w.collections().length; i < w.MAX_COLLECTIONS(); i++) w.add(address(new Moody()), "");
        Moody extra = new Moody(); vm.expectRevert(bytes("full")); w.add(address(extra), "one too many"); vm.stopPrank();
    }
}

contract YesToEverything is IListedCollection { function listed(bytes32) external pure returns (bool) { return true; } }
contract Moody is IListedCollection { bool sulking; function sulk() external { sulking = true; } function listed(bytes32) external view returns (bool) { require(!sulking, "no"); return false; } }
