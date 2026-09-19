// SPDX-License-Identifier: 0BSD
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/FlyCollection.sol";
import "../src/FlyRenderer.sol";
import "aigg-porw/mesh/MEPRegistry.sol";
import { AccruingMarket } from "./FlyCollectionRoyalty.t.sol";

/// What the mainnet revision added: the base's share of the royalty, ERC-2981, an owner with one power, and tokenURI.
contract FlyCollectionRevisionTest is Test {
    FlyCollection c; MEPRegistry meps; AccruingMarket market; FlyRenderer art;
    address alice = address(0xA11CE); address bob = address(0xB0B); address treasury = address(0x7EA); address vendor = address(0xBA5E); address admin = address(0xAD);
    bytes32 constant BASE_F = keccak256("female-base"); bytes32 constant BASE_M = keccak256("male-base");
    bytes32 constant DF = keccak256("delta-female-0"); bytes32 constant DM = keccak256("delta-male-1");
    uint256 constant PRICE = 0.06 ether; uint256 constant FEE = 0.01 ether;

    function leaf(uint32 i, uint8 sex, bytes32 d) internal pure returns (bytes32) { return keccak256(abi.encode(i, sex, d)); }
    function root() internal pure returns (bytes32) { bytes32 a = leaf(0, 0, DF); bytes32 b = leaf(1, 1, DM); return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a)); }
    function proofFor(uint32 i) internal pure returns (bytes32[] memory p) { p = new bytes32[](1); p[0] = i == 0 ? leaf(1, 1, DM) : leaf(0, 0, DF); }
    function mep(bytes32 modelId) internal pure returns (IMEPRegistry.MEP memory) {
        return IMEPRegistry.MEP({ modelId: modelId, schemeDigest: SCHEME_SKETCH_TILE_KECCAK_V3, execKind: keccak256("aigg:exec:int-lif:v1"), neurons: 139255, synapses: 2700513, synapseRoot: keccak256("syn"), weightsDA: bytes("gnfd://aigg-brains/x.bin") });
    }
    function deploy(uint16 royaltyBps, FlyCollection.Shares memory s) internal returns (FlyCollection) {
        return new FlyCollection(BASE_F, BASE_M, root(), 2, PRICE, 0, FEE, 0, treasury, IMEPRegistry(address(meps)), IInstanceBonding(address(0)), LineageRegistry(address(0)), bytes32(0), bytes32(0), IRoyaltyMarket(address(market)), royaltyBps, s);
    }
    function setUp() public {
        meps = new MEPRegistry(); market = new AccruingMarket(meps); art = new FlyRenderer();
        c = deploy(1000, FlyCollection.Shares(vendor, 1000, 500, admin)); // the decided numbers: 10% royalty, a tenth of it to the base, 5% asked on resale
        vm.deal(alice, 10 ether); vm.deal(bob, 10 ether);
    }
    function adopt(address who, uint32 index, uint8 sex, bytes32 d) internal returns (uint256 id) { vm.prank(who); id = c.mint{value: PRICE}(index, sex, d, proofFor(index)); }

    // ---- the base's share ----
    function test_of_the_royalty_a_tenth_is_the_bases_and_the_rest_the_owners() public {
        uint256 id = adopt(alice, 0, 0, DF); vm.prank(alice); bytes32 mepId = c.register(id, DF, mep(keccak256("applied-f")));
        market.accrue{value: 1 ether}(mepId); // what TaskMarket set aside: 10% of 10 ether of fees
        assertEq(c.settle(id), 1 ether, "settle reports what it moved");
        assertEq(c.owed(alice), 0.9 ether, "the owner"); assertEq(c.owed(vendor), 0.1 ether, "the base"); assertEq(c.owed(treasury), 0, "the treasury is not the vendor here");
        uint256 before = vendor.balance; vm.prank(vendor); c.withdraw(); assertEq(vendor.balance, before + 0.1 ether, "and collects it the way an owner does");
    }
    function test_the_share_does_not_move_with_the_fly_and_a_sale_still_splits_at_its_block() public {
        uint256 id = adopt(alice, 0, 0, DF); vm.prank(alice); bytes32 mepId = c.register(id, DF, mep(keccak256("applied-f")));
        market.accrue{value: 1 ether}(mepId); vm.prank(alice); c.transferFrom(alice, bob, id); market.accrue{value: 0.5 ether}(mepId); c.settle(id);
        assertEq(c.owed(alice), 0.9 ether); assertEq(c.owed(bob), 0.45 ether); assertEq(c.owed(vendor), 0.15 ether);
        assertEq(address(c).balance, 1.5 ether, "every wei it holds is somebody's credit");
    }
    function test_one_wei_of_royalty_is_the_owners_rounding_never_pays_the_base_more() public {
        uint256 id = adopt(alice, 0, 0, DF); vm.prank(alice); bytes32 mepId = c.register(id, DF, mep(keccak256("applied-f")));
        market.accrue{value: 9}(mepId); c.settle(id); assertEq(c.owed(vendor), 0); assertEq(c.owed(alice), 9);
    }
    function test_no_share_no_vendor_and_a_share_needs_one() public {
        FlyCollection plain = deploy(1000, FlyCollection.Shares(address(0), 0, 0, address(0)));
        vm.prank(alice); uint256 id = plain.mint{value: PRICE}(0, 0, DF, proofFor(0)); vm.prank(alice); bytes32 mepId = plain.register(id, DF, mep(keccak256("applied-f")));
        market.accrue{value: 1 ether}(mepId); plain.settle(id); assertEq(plain.owed(alice), 1 ether, "as before the revision");
        vm.expectRevert(bytes("base share")); deploy(1000, FlyCollection.Shares(address(0), 1000, 0, address(0)));
        vm.expectRevert(bytes("base share")); deploy(1000, FlyCollection.Shares(vendor, 10001, 0, address(0)));
    }

    // ---- ERC-2981 ----
    function test_a_resale_is_asked_for_five_percent_to_the_treasury() public {
        uint256 id = adopt(alice, 0, 0, DF); (address to, uint256 amt) = c.royaltyInfo(id, 2 ether);
        assertEq(to, treasury); assertEq(amt, 0.1 ether); assertTrue(c.supportsInterface(0x2a55205a));
        vm.expectRevert(bytes("sale royalty")); deploy(0, FlyCollection.Shares(address(0), 0, 1001, address(0))); // nobody honours more than 10%
    }
    function test_and_a_plain_transfer_pays_nothing_it_is_a_request() public {
        uint256 id = adopt(alice, 0, 0, DF); uint256 t = treasury.balance; vm.prank(alice); c.transferFrom(alice, bob, id); assertEq(treasury.balance, t); assertEq(c.ownerOf(id), bob);
    }

    // ---- the owner: one power ----
    function test_the_owner_is_who_the_deployment_named_and_can_only_choose_the_renderer() public {
        assertEq(c.owner(), admin);
        vm.prank(alice); vm.expectRevert(bytes("owner")); c.setRenderer(art);
        vm.prank(admin); c.setRenderer(art); assertEq(address(c.renderer()), address(art));
    }
    function test_ownership_moves_in_two_steps_and_can_be_renounced() public {
        vm.prank(alice); vm.expectRevert(bytes("owner")); c.proposeOwner(alice);
        vm.prank(admin); c.proposeOwner(bob); assertEq(c.owner(), admin, "proposing moves nothing");
        vm.prank(alice); vm.expectRevert(bytes("proposed")); c.acceptOwner();
        vm.prank(bob); c.acceptOwner(); assertEq(c.owner(), bob); assertEq(c.proposedOwner(), address(0));
        vm.prank(admin); vm.expectRevert(bytes("owner")); c.setRenderer(art);
        vm.prank(bob); c.setRenderer(art); vm.prank(bob); c.renounceOwner(); assertEq(c.owner(), address(0));
        vm.prank(bob); vm.expectRevert(bytes("owner")); c.setRenderer(ITokenRenderer(address(0))); // renounced: the renderer is frozen
        assertEq(address(c.renderer()), address(art));
    }

    // ---- tokenURI ----
    function test_without_a_renderer_the_uri_is_empty_and_a_token_that_does_not_exist_reverts() public {
        uint256 id = adopt(alice, 0, 0, DF); assertEq(c.tokenURI(id), ""); assertTrue(c.supportsInterface(0x5b5e139f));
        vm.expectRevert(bytes("no token")); c.tokenURI(99);
    }
    function test_a_fly_is_drawn_on_chain_from_its_own_state() public {
        vm.prank(admin); c.setRenderer(art); uint256 f = adopt(alice, 0, 0, DF); uint256 m = adopt(alice, 1, 1, DM);
        string memory uri = c.tokenURI(f); assertTrue(_starts(uri, "data:application/json;base64,"), "a data: URI: no server to keep alive");
        string memory json = string(_unb64(_after(uri, 29)));
        assertTrue(_has(json, '"name":"Fly #1"')); assertTrue(_has(json, '{"trait_type":"Sex","value":"female"}')); assertTrue(_has(json, '{"trait_type":"Founder","value":"yes"}'));
        assertTrue(_has(json, '{"trait_type":"Stage","value":"hatched"}')); assertTrue(_has(json, '"image":"data:image/svg+xml;base64,'));
        assertTrue(_has(string(_unb64(_after(c.tokenURI(m), 29))), '"value":"male"'));
        assertTrue(keccak256(bytes(c.tokenURI(f))) != keccak256(bytes(c.tokenURI(m))), "two flies, two pictures");
        assertEq(keccak256(bytes(c.tokenURI(f))), keccak256(bytes(c.tokenURI(f))), "and the same fly is always the same picture");
        // an egg: bred, not hatched. No seed, so no brain to draw, and no sex to state
        vm.prank(alice); uint256 egg = c.breed{value: FEE}(f, m); string memory ej = string(_unb64(_after(c.tokenURI(egg), 29)));
        assertTrue(_has(ej, '{"trait_type":"Stage","value":"egg"}')); assertTrue(_has(ej, '"value":"unknown"')); assertTrue(_has(ej, '{"trait_type":"Dam","value":"#1"},{"trait_type":"Sire","value":"#2"}'));
        // registered: the stage says so
        vm.prank(alice); c.register(f, DF, mep(keccak256("applied-f"))); assertTrue(_has(string(_unb64(_after(c.tokenURI(f), 29))), '"value":"registered"'));
    }
    function test_the_picture_is_well_formed_svg_with_mirrored_neurons() public {
        vm.prank(admin); c.setRenderer(art); uint256 f = adopt(alice, 0, 0, DF); string memory json = string(_unb64(_after(c.tokenURI(f), 29)));
        bytes memory j = bytes(json); uint256 at = _find(j, bytes('base64,')) + 7; uint256 end = j.length - 2; bytes memory b = new bytes(end - at); for (uint256 i = 0; i < b.length; i++) b[i] = j[at + i];
        string memory svg = string(_unb64(b)); assertTrue(_starts(svg, "<svg xmlns")); assertTrue(_has(svg, "</svg>")); assertTrue(_has(svg, 'fill="#d7263d"'), "the eyes are wild-type red, always");
        assertEq(_count(bytes(svg), bytes("<circle")), 24, "twelve neurons, mirrored");
    }
    function test_a_renderer_that_reverts_or_burns_the_gas_takes_the_picture_down_never_the_token() public {
        uint256 id = adopt(alice, 0, 0, DF);
        ITokenRenderer bad = new RevertingRenderer(); ITokenRenderer spin = new SpinningRenderer(); // created first: a prank is spent on the next call, and `new` is one
        vm.prank(admin); c.setRenderer(bad); assertEq(c.tokenURI(id), "");
        vm.prank(admin); c.setRenderer(spin); assertEq(c.tokenURI{gas: 8_000_000}(id), "");
        vm.prank(alice); c.transferFrom(alice, bob, id); assertEq(c.ownerOf(id), bob);
    }

    // ---- string helpers (test only) ----
    function _starts(string memory s, string memory p) internal pure returns (bool) { bytes memory a = bytes(s); bytes memory b = bytes(p); if (a.length < b.length) return false; for (uint256 i = 0; i < b.length; i++) if (a[i] != b[i]) return false; return true; }
    function _after(string memory s, uint256 n) internal pure returns (bytes memory o) { bytes memory a = bytes(s); o = new bytes(a.length - n); for (uint256 i = 0; i < o.length; i++) o[i] = a[n + i]; }
    function _find(bytes memory a, bytes memory b) internal pure returns (uint256) { for (uint256 i = 0; i + b.length <= a.length; i++) { bool ok = true; for (uint256 k = 0; k < b.length; k++) if (a[i + k] != b[k]) { ok = false; break; } if (ok) return i; } return type(uint256).max; }
    function _has(string memory s, string memory p) internal pure returns (bool) { return _find(bytes(s), bytes(p)) != type(uint256).max; }
    function _count(bytes memory a, bytes memory b) internal pure returns (uint256 n) { for (uint256 i = 0; i + b.length <= a.length; i++) { bool ok = true; for (uint256 k = 0; k < b.length; k++) if (a[i + k] != b[k]) { ok = false; break; } if (ok) n++; } }
    function _unb64(bytes memory d) internal pure returns (bytes memory o) {
        uint256 pad = d.length > 0 && d[d.length - 1] == "=" ? (d[d.length - 2] == "=" ? 2 : 1) : 0; o = new bytes(d.length / 4 * 3 - pad); uint256 j;
        for (uint256 i = 0; i < d.length; i += 4) { uint256 w = (_v(d[i]) << 18) | (_v(d[i + 1]) << 12) | (_v(d[i + 2]) << 6) | _v(d[i + 3]);
            if (j < o.length) o[j++] = bytes1(uint8(w >> 16)); if (j < o.length) o[j++] = bytes1(uint8(w >> 8)); if (j < o.length) o[j++] = bytes1(uint8(w)); }
    }
    function _v(bytes1 ch) internal pure returns (uint256) { uint8 x = uint8(ch); if (x >= 65 && x <= 90) return x - 65; if (x >= 97 && x <= 122) return x - 71; if (x >= 48 && x <= 57) return x + 4; if (x == 43) return 62; if (x == 47) return 63; return 0; }
}
contract RevertingRenderer is ITokenRenderer { function tokenURI(address, uint256) external pure returns (string memory) { revert("no"); } }
contract SpinningRenderer is ITokenRenderer { function tokenURI(address, uint256) external pure returns (string memory) { uint256 x; while (true) x++; return ""; } }
