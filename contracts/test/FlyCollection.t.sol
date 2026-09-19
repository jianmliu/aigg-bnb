// SPDX-License-Identifier: 0BSD
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/FlyCollection.sol";
import "aigg-porw/mesh/MEPRegistry.sol";

contract FlyCollectionTest is Test {
    FlyCollection c; MEPRegistry meps;
    address alice = address(0xA11CE); address bob = address(0xB0B); address treasury = address(0x7EA);
    bytes32 constant BASE_F = keccak256("female-base"); bytes32 constant BASE_M = keccak256("male-base");
    bytes32 constant DF = keccak256("delta-female-0"); bytes32 constant DM = keccak256("delta-male-1");
    uint256 constant PRICE = 0.06 ether; uint256 constant FEE = 0.01 ether; uint256 constant BOUNTY = 0.002 ether;

    // a two-leaf genesis set: index 0 female, index 1 male
    function leaf(uint32 i, uint8 sex, bytes32 d) internal pure returns (bytes32) { return keccak256(abi.encode(i, sex, d)); }
    function root() internal pure returns (bytes32) { bytes32 a = leaf(0, 0, DF); bytes32 b = leaf(1, 1, DM); return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a)); }
    function proofFor(uint32 i) internal pure returns (bytes32[] memory p) { p = new bytes32[](1); p[0] = i == 0 ? leaf(1, 1, DM) : leaf(0, 0, DF); }

    function setUp() public {
        meps = new MEPRegistry();
        // MINT_BOND 0 here; FlyCollectionBond.t.sol mints with a real InstanceRegistry and a bond
        c = new FlyCollection(BASE_F, BASE_M, root(), 2, PRICE, 0, FEE, BOUNTY, treasury, IMEPRegistry(address(meps)), IInstanceBonding(address(0)), LineageRegistry(address(0)), bytes32(0), bytes32(0), IRoyaltyMarket(address(0)), 0, FlyCollection.Shares(address(0), 0, 0, address(0)));
        vm.deal(alice, 10 ether); vm.deal(bob, 10 ether);
    }

    function mintF(address who) internal returns (uint256) { vm.prank(who); return c.mint{value: PRICE}(0, 0, DF, proofFor(0)); }
    function mintM(address who) internal returns (uint256) { vm.prank(who); return c.mint{value: PRICE}(1, 1, DM, proofFor(1)); }

    function test_genesis_is_fixed_at_deployment() public {
        uint256 id = mintF(alice);
        assertEq(c.ownerOf(id), alice); assertEq(treasury.balance, PRICE, "the whole price went to the treasury when MINT_BOND is 0");
        (bytes32 base,,,, uint8 sex, uint32 gen,,,,) = c.individuals(id);
        assertEq(base, BASE_F); assertEq(sex, 0); assertEq(gen, 0);
        vm.prank(bob); vm.expectRevert(bytes("index")); c.mint{value: PRICE}(0, 0, DF, proofFor(0)); // no minting the same individual twice
        vm.prank(bob); vm.expectRevert(bytes("not in the genesis set")); c.mint{value: PRICE}(1, 1, keccak256("invented"), proofFor(1)); // nor one nobody committed to
        vm.prank(bob); vm.expectRevert(bytes("index")); c.mint{value: PRICE}(2, 0, DF, proofFor(0)); // nor past the end of the set
    }

    function test_breeding_needs_one_of_each_sex_and_the_child_sits_on_one_base() public {
        uint256 f = mintF(alice); uint256 m = mintM(alice);
        vm.prank(alice); vm.expectRevert(bytes("breeding needs one of each sex")); c.breed{value: FEE}(f, f);
        vm.roll(50);
        vm.prank(alice); uint256 kid = c.breed{value: FEE}(f, m);
        (bytes32 base, bytes32 dh,,, uint8 sex, uint32 gen, uint64 pa, uint64 pb, bytes32 seed, uint64 seedBlock) = c.individuals(kid);
        assertEq(base, BASE_F, "the child is a variant of one base, not a blend of two");
        assertEq(dh, bytes32(0), "the recipe is recorded; the delta is claimed at registration");
        assertEq(gen, 1); assertEq(pa, uint64(f)); assertEq(pb, uint64(m));
        // nothing the breeder could have simulated: the seed and the sex do not exist until the NEXT block does
        assertEq(seed, bytes32(0)); assertEq(sex, c.UNHATCHED()); assertEq(seedBlock, 51);
        assertEq(c.ownerOf(kid), alice); assertEq(treasury.balance, 2 * PRICE + FEE - BOUNTY); assertEq(address(c).balance, BOUNTY, "held for whoever hatches it");
    }

    function test_an_unborn_child_cannot_breed_until_its_delta_is_pinned() public {
        uint256 f = mintF(alice); uint256 m = mintM(alice);
        vm.prank(alice); uint256 kid = c.breed{value: FEE}(f, m);
        // bred but not registered: its deltaHash is still zero, so a grandchild's seed would bind nothing of this
        // parent -- and its owner could choose the delta to claim AFTER seeing the grandchild's seed
        vm.prank(alice); vm.expectRevert(bytes("parents must have their deltas claimed")); c.breed{value: FEE}(kid, f);
        vm.prank(alice); vm.expectRevert(bytes("parents must have their deltas claimed")); c.breed{value: FEE}(m, kid);
        vm.roll(block.number + 2); vm.prank(bob); c.hatch(kid);
        vm.prank(alice); c.register(kid, keccak256("delta-kid"), baseMep(keccak256("applied-kid")));
        (,,,, uint8 sex,,,,,) = c.individuals(kid);
        vm.prank(alice); c.breed{value: FEE}(kid, sex == 0 ? m : f); // born: it breeds like anyone else
    }

    function test_the_seed_comes_from_a_block_that_did_not_exist_at_breeding() public {
        uint256 f = mintF(alice); uint256 m = mintM(alice);
        vm.roll(100); vm.prank(alice); uint256 kid = c.breed{value: FEE}(f, m); // bred in block 100: the seed block is 101
        (,,,,,,,,, uint64 seedBlock) = c.individuals(kid); assertEq(seedBlock, 101);
        vm.expectRevert(bytes("block pending")); c.hatch(kid);                 // same block
        vm.roll(101); vm.expectRevert(bytes("block pending")); c.hatch(kid);   // the seed block itself: its hash does not exist inside it
        vm.roll(102); bytes32 h = keccak256("block"); vm.setBlockhash(101, h);
        vm.prank(bob); c.hatch(kid); // anyone may: there is nothing to choose, and being first is paid
        (,,,, uint8 sex,,,, bytes32 seed,) = c.individuals(kid);
        assertEq(seed, keccak256(abi.encode(DF, DM, f, m, kid, h)), "the recipe and the block hash, nothing the caller supplies");
        assertEq(sex, uint8(uint256(seed) & 1));
        assertEq(bob.balance, 10 ether + BOUNTY, "the bounty is what makes waiting out the window a race the grinder loses"); assertEq(address(c).balance, 0);
        vm.expectRevert(bytes("nothing to hatch")); c.hatch(kid); // once
        vm.expectRevert(bytes("nothing to hatch")); c.hatch(f);   // and a genesis individual was never an egg
    }

    function test_the_last_block_of_the_window_still_hatches() public {
        uint256 f = mintF(alice); uint256 m = mintM(alice);
        vm.roll(100); vm.prank(alice); uint256 kid = c.breed{value: FEE}(f, m); // bred in block 100: the seed block is 101
        vm.roll(101 + 256); vm.setBlockhash(101, keccak256("block")); // the EVM keeps 256 hashes
        vm.prank(alice); vm.expectRevert(bytes("not expired")); c.rearm{value: FEE}(kid);
        vm.prank(bob); c.hatch(kid);
    }

    function test_an_expired_egg_is_rearmed_at_the_price_of_breeding_again() public {
        uint256 f = mintF(alice); uint256 m = mintM(alice);
        vm.roll(100); vm.prank(alice); uint256 kid = c.breed{value: FEE}(f, m); // bred in block 100: the seed block is 101
        vm.roll(101 + 257); // nobody hatched it for 256 blocks and the hash is gone
        vm.expectRevert(bytes("expired")); c.hatch(kid);
        // a fresh block is a fresh draw, so it is not free: letting a seed one dislikes expire costs a whole BREED_FEE
        vm.prank(alice); vm.expectRevert(bytes("fee")); c.rearm{value: FEE - 1}(kid);
        uint256 before = treasury.balance;
        vm.prank(bob); c.rearm{value: FEE}(kid); // anyone who pays
        (,,,,,,,, bytes32 seed, uint64 armed) = c.individuals(kid);
        assertEq(seed, bytes32(0)); assertEq(armed, 359, "the block after the one it was re-armed in"); assertEq(treasury.balance, before + FEE, "all of it: the bounty from breeding is still held");
        vm.roll(360); bytes32 h = keccak256("block-2"); vm.setBlockhash(359, h); vm.prank(alice); c.hatch(kid);
        (,,,,,,,, seed,) = c.individuals(kid);
        assertEq(seed, keccak256(abi.encode(DF, DM, f, m, kid, h))); assertEq(address(c).balance, 0, "one bounty, paid once");
    }

    function test_an_egg_cannot_be_registered() public {
        uint256 f = mintF(alice); uint256 m = mintM(alice);
        vm.prank(alice); uint256 kid = c.breed{value: FEE}(f, m);
        // the delta is a function of the seed: claiming one before the seed exists is claiming something else
        vm.prank(alice); vm.expectRevert(bytes("not hatched")); c.register(kid, keccak256("delta-kid"), baseMep(keccak256("applied-kid")));
    }

    function test_breeding_requires_holding_or_approval_of_both_parents() public {
        uint256 f = mintF(alice); uint256 m = mintM(bob);
        vm.prank(alice); vm.expectRevert(bytes("not authorised")); c.breed{value: FEE}(f, m);
        vm.prank(bob); c.approve(alice, m);
        vm.prank(alice); uint256 kid = c.breed{value: FEE}(f, m);
        assertEq(c.ownerOf(kid), alice, "the breeder keeps the child");
    }

    function test_registration_binds_the_mep_once_and_only_by_the_owner() public {
        uint256 id = mintF(alice);
        IMEPRegistry.MEP memory m = IMEPRegistry.MEP({ modelId: keccak256("applied"), schemeDigest: SCHEME_SKETCH_TILE_KECCAK_V3, execKind: keccak256("aigg:exec:int-lif:v1"),
            neurons: 139255, synapses: 2700513, synapseRoot: keccak256("syn"), weightsDA: bytes("gnfd://aigg-brains/x.bin") });
        vm.prank(bob); vm.expectRevert(bytes("not the owner")); c.register(id, DF, m); // nobody can bind someone else's individual to a dead MEP
        vm.prank(alice); bytes32 mepId = c.register(id, DF, m);
        (,, bytes32 modelId, bytes32 stored,,,,,,) = c.individuals(id);
        assertEq(modelId, m.modelId); assertEq(stored, mepId); assertTrue(meps.exists(mepId));
        vm.prank(alice); vm.expectRevert(bytes("already registered")); c.register(id, DF, m);
    }

    /// The registry is permissionless and an individual's profile is public, so anybody can register it first. That used
    /// to leave the token unable to bind, for good. An id that exists is the same MEP, so the token binds to it.
    function test_a_profile_somebody_registered_first_still_binds() public {
        uint256 id = mintF(alice);
        IMEPRegistry.MEP memory m = IMEPRegistry.MEP({ modelId: keccak256("applied"), schemeDigest: SCHEME_SKETCH_TILE_KECCAK_V3, execKind: keccak256("aigg:exec:int-lif:v1"),
            neurons: 139255, synapses: 2700513, synapseRoot: keccak256("syn"), weightsDA: bytes("gnfd://aigg-brains/x.bin") });
        IMEPRegistry.MEP memory squat = m; squat.weightsDA = bytes("nowhere");
        vm.prank(bob); bytes32 first = meps.registerMEP(squat); // the front-runner, straight at the registry
        squat.weightsDA = bytes("gnfd://aigg-brains/x.bin"); // (m and squat alias in memory: put the owner's hint back)
        vm.expectEmit(true, true, false, true); emit WeightsHint(id, first, bytes("gnfd://aigg-brains/x.bin"));
        vm.prank(alice); bytes32 mepId = c.register(id, DF, m);
        assertEq(mepId, first, "the same MEP: every field a verdict depends on is inside the id");
        (,, bytes32 modelId, bytes32 stored,,,,,,) = c.individuals(id); assertEq(modelId, m.modelId); assertEq(stored, mepId);
        vm.prank(alice); vm.expectRevert(bytes("already registered")); c.register(id, DF, m);
    }
    event WeightsHint(uint256 indexed id, bytes32 indexed mepId, bytes weightsDA);

    function test_transfer_moves_the_subject_and_nothing_else() public {
        uint256 id = mintF(alice);
        vm.prank(alice); c.transferFrom(alice, bob, id);
        assertEq(c.ownerOf(id), bob); assertEq(c.balanceOf(alice), 0); assertEq(c.balanceOf(bob), 1);
        // the bond is an address's, not a token's: there is nothing here that could have moved with it
        vm.prank(alice); vm.expectRevert(bytes("not authorised")); c.transferFrom(bob, alice, id);
    }

    function baseMep(bytes32 modelId) internal pure returns (IMEPRegistry.MEP memory) {
        return IMEPRegistry.MEP({ modelId: modelId, schemeDigest: SCHEME_SKETCH_TILE_KECCAK_V3, execKind: keccak256("aigg:exec:int-lif:v1"),
            neurons: 139255, synapses: 2700513, synapseRoot: keccak256("syn"), weightsDA: bytes("gnfd://aigg-brains/base.bin") });
    }

    function test_erc165_claims_only_what_is_implemented() public view {
        assertTrue(c.supportsInterface(0x01ffc9a7), "ERC-165"); assertTrue(c.supportsInterface(0x80ac58cd), "ERC-721");
        // ERC721Metadata is name ^ symbol ^ tokenURI, and ERC-2981 is royaltyInfo: claimed because they are there (FlyCollectionRevision.t.sol)
        assertEq(bytes4(0x5b5e139f), bytes4(keccak256("name()")) ^ bytes4(keccak256("symbol()")) ^ bytes4(keccak256("tokenURI(uint256)")));
        assertEq(bytes4(0x2a55205a), bytes4(keccak256("royaltyInfo(uint256,uint256)")));
        assertTrue(c.supportsInterface(0x5b5e139f), "ERC721Metadata"); assertTrue(c.supportsInterface(0x2a55205a), "ERC-2981"); assertFalse(c.supportsInterface(0xffffffff));
        assertFalse(c.supportsInterface(0xd9b67a26), "not ERC-1155");
    }

    function test_the_price_is_exact_and_the_economics_have_no_admin() public {
        vm.prank(alice); vm.expectRevert(bytes("price")); c.mint{value: PRICE - 1}(0, 0, DF, proofFor(0));
        assertEq(c.MINT_PRICE(), PRICE); assertEq(c.TREASURY(), treasury);
        // every economic parameter is immutable: there is no setter to call
    }
}
