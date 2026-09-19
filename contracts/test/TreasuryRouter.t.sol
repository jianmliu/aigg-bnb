// SPDX-License-Identifier: 0BSD
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/TreasuryRouter.sol";
import "../src/FlyCollection.sol";
import "aigg-porw/mesh/MEPRegistry.sol";
import { AccruingMarket } from "./FlyCollectionRoyalty.t.sol";

/// A fixed address for a treasury whose destination can change: everything it holds leaves only to the destination,
/// anybody may make it leave, and the owner chooses the destination and nothing else.
contract TreasuryRouterTest is Test {
    TreasuryRouter r; address admin = address(0xAD); address payable safe = payable(address(0x5AFE)); address payable safe2 = payable(address(0x5AFE2));
    address alice = address(0xA11CE); address bob = address(0xB0B);
    function setUp() public { r = new TreasuryRouter(admin, safe); vm.deal(alice, 10 ether); vm.deal(bob, 10 ether); }

    function test_it_takes_money_on_the_2300_gas_stipend_and_does_nothing_with_it() public {
        vm.prank(alice); payable(address(r)).transfer(1 ether); // `transfer`: 2300 gas, what the stingiest marketplace sends
        assertEq(address(r).balance, 1 ether); assertEq(safe.balance, 0);
    }
    function test_anybody_may_sweep_and_the_money_can_only_go_to_the_destination() public {
        vm.prank(alice); (bool ok,) = address(r).call{value: 1 ether}(""); assertTrue(ok);
        uint256 b = bob.balance; vm.prank(bob); assertEq(r.sweep(), 1 ether); assertEq(safe.balance, 1 ether); assertEq(bob.balance, b, "the caller gets nothing");
        assertEq(r.sweep(), 0, "nothing to sweep is not an error");
    }
    function test_the_owner_chooses_the_destination_and_nobody_else_does() public {
        vm.prank(alice); vm.expectRevert(bytes("owner")); r.setDestination(payable(alice));
        vm.prank(admin); vm.expectRevert(bytes("zero")); r.setDestination(payable(address(0)));
        vm.prank(admin); r.setDestination(safe2); vm.deal(address(r), 2 ether); r.sweep(); assertEq(safe2.balance, 2 ether); assertEq(safe.balance, 0);
        vm.expectRevert(bytes("zero")); new TreasuryRouter(address(0), safe); vm.expectRevert(bytes("zero")); new TreasuryRouter(admin, payable(address(0)));
    }
    function test_ownership_moves_in_two_steps_and_renounced_the_destination_is_fixed_for_good() public {
        vm.prank(admin); r.proposeOwner(bob); assertEq(r.owner(), admin); vm.prank(alice); vm.expectRevert(bytes("proposed")); r.acceptOwner();
        vm.prank(bob); r.acceptOwner(); assertEq(r.owner(), bob); vm.prank(admin); vm.expectRevert(bytes("owner")); r.setDestination(safe2);
        vm.prank(bob); r.renounceOwner(); vm.prank(bob); vm.expectRevert(bytes("owner")); r.setDestination(safe2);
        vm.deal(address(r), 1 ether); r.sweep(); assertEq(safe.balance, 1 ether, "and it goes on forwarding");
    }
    function test_a_destination_that_refuses_loses_nothing_the_money_waits() public {
        Refuser x = new Refuser(); vm.prank(admin); r.setDestination(payable(address(x))); vm.deal(address(r), 1 ether);
        vm.expectRevert(bytes("destination refused")); r.sweep(); assertEq(address(r).balance, 1 ether);
        vm.prank(admin); r.setDestination(safe); r.sweep(); assertEq(safe.balance, 1 ether);
    }
    function test_resale_royalties_paid_in_tokens_are_forwarded_whatever_the_token_returns() public {
        GoodToken g = new GoodToken(); SilentToken s = new SilentToken(); g.mint(address(r), 5e18); s.mint(address(r), 7e6);
        vm.prank(bob); assertEq(r.rescue(address(g)), 5e18); assertEq(g.balanceOf(safe), 5e18);
        assertEq(r.rescue(address(s)), 7e6, "a token that returns nothing (USDT's shape)"); assertEq(s.balanceOf(safe), 7e6); assertEq(r.rescue(address(s)), 0);
        vm.expectRevert(bytes("not a token")); r.rescue(address(0xdead));
    }

    // ---- as a FlyCollection's treasury ----
    function test_as_a_collections_treasury_it_is_paid_at_adoption_and_collects_the_bases_share() public {
        MEPRegistry meps = new MEPRegistry(); AccruingMarket market = new AccruingMarket(meps);
        bytes32 DF = keccak256("delta-female-0"); bytes32 DM = keccak256("delta-male-1"); bytes32 a = keccak256(abi.encode(uint32(0), uint8(0), DF)); bytes32 b = keccak256(abi.encode(uint32(1), uint8(1), DM));
        bytes32 root = a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a)); bytes32[] memory proof = new bytes32[](1); proof[0] = b;
        FlyCollection c = new FlyCollection(keccak256("f"), keccak256("m"), root, 2, 0.06 ether, 0, 0.01 ether, 0, address(r), IMEPRegistry(address(meps)), IInstanceBonding(address(0)), LineageRegistry(address(0)), bytes32(0), bytes32(0),
            IRoyaltyMarket(address(market)), 1000, FlyCollection.Shares(address(r), 1000, 500, admin));
        uint256 g = gasleft(); vm.prank(alice); uint256 id = c.mint{value: 0.06 ether}(0, 0, DF, proof); g -= gasleft();
        assertEq(address(r).balance, 0.06 ether, "pushed at adoption"); assertEq(c.owed(address(r)), 0, "not credited: it took it"); assertLt(g, 250_000, "and an adopter pays for no work of the treasury's");
        (address to,) = c.royaltyInfo(id, 1 ether); assertEq(to, address(r), "ERC-2981 asks marketplaces to pay here too");
        // a royalty settles: the base's tenth is CREDITED to the router (credits are never pushed), and anybody can bring it home
        vm.prank(alice); bytes32 mepId = c.register(id, DF, IMEPRegistry.MEP({ modelId: keccak256("applied"), schemeDigest: SCHEME_SKETCH_TILE_KECCAK_V3, execKind: keccak256("aigg:exec:int-lif:v1"), neurons: 1, synapses: 1, synapseRoot: keccak256("s"), weightsDA: bytes("gnfd://x") }));
        market.accrue{value: 1 ether}(mepId); c.settle(id); assertEq(c.owed(address(r)), 0.1 ether);
        vm.prank(bob); assertEq(r.collect(IOwed(address(c))), 0.1 ether); assertEq(address(r).balance, 0.16 ether); r.sweep(); assertEq(safe.balance, 0.16 ether);
    }
}
contract Refuser { receive() external payable { revert("no"); } }
contract GoodToken { mapping(address => uint256) public balanceOf; function mint(address to, uint256 n) external { balanceOf[to] += n; } function transfer(address to, uint256 n) external returns (bool) { balanceOf[msg.sender] -= n; balanceOf[to] += n; return true; } }
contract SilentToken { mapping(address => uint256) public balanceOf; function mint(address to, uint256 n) external { balanceOf[to] += n; } function transfer(address to, uint256 n) external { balanceOf[msg.sender] -= n; balanceOf[to] += n; } }
