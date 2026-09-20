// SPDX-License-Identifier: 0BSD
pragma solidity ^0.8.20;
import "./FlyCollectionRevision.t.sol";
import "../src/TreasuryInventorySale.sol";

contract RefusingBuyer {
    function buy(TreasuryInventorySale s, uint256 id) external payable { s.buy{value: msg.value}(id, msg.value, 1, block.timestamp + 60); }
}
contract ReenteringBuyer {
    TreasuryInventorySale sale;
    bool public blocked;
    function buy(TreasuryInventorySale s, uint256 id) external payable { sale = s; s.buy{value: msg.value}(id, msg.value, 1, block.timestamp + 60); }
    function onERC721Received(address, address, uint256 id, bytes calldata) external returns (bytes4) {
        (bool ok,) = address(sale).call(abi.encodeCall(sale.buy, (id, 1 ether, 1, block.timestamp + 60)));
        blocked = !ok;
        return this.onERC721Received.selector;
    }
}
contract TreasuryInventorySaleTest is Test {
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
    function setupCollection() internal {
        meps = new MEPRegistry(); market = new AccruingMarket(meps); art = new FlyRenderer();
        c = deploy(1000, FlyCollection.Shares(vendor, 1000, 500, admin)); // the decided numbers: 10% royalty, a tenth of it to the base, 5% asked on resale
        vm.deal(alice, 10 ether); vm.deal(bob, 10 ether);
    }
    function adopt(address who, uint32 index, uint8 sex, bytes32 d) internal returns (uint256 id) { vm.prank(who); id = c.mint{value: PRICE}(index, sex, d, proofFor(index)); }


    TreasuryInventorySale sale;
    uint256 id;
    function setUp() public {
        setupCollection();
        id = adopt(alice, 0, 0, DF);
        sale = new TreasuryInventorySale(address(c), alice);
        vm.startPrank(alice); c.approve(address(sale), id); sale.list(id, 1 ether, block.timestamp + 100); vm.stopPrank();
    }
    function test_inventoryPurchasePaysSellerWithoutMintOrBond() public {
        uint256 before = alice.balance;
        vm.prank(bob); sale.buy{value: 1 ether}(id, 1 ether, 1, block.timestamp + 10);
        assertEq(c.ownerOf(id), bob); assertEq(c.totalSupply(), 1); assertEq(alice.balance, before + 1 ether); assertEq(address(sale).balance, 0);
        vm.prank(bob); vm.expectRevert(); sale.buy{value: 1 ether}(id, 1 ether, 1, block.timestamp + 10);
    }
    function test_changedQuoteAndCancelledListingCannotExecute() public {
        vm.prank(alice); sale.list(id, 2 ether, block.timestamp + 100);
        vm.prank(bob); vm.expectRevert(); sale.buy{value: 1 ether}(id, 1 ether, 1, block.timestamp + 10);
        vm.prank(alice); sale.cancel(id);
        vm.prank(bob); vm.expectRevert(); sale.buy{value: 2 ether}(id, 2 ether, 2, block.timestamp + 10);
        assertEq(c.ownerOf(id), alice);
    }
    function test_wrongPaymentExpiredQuoteAndRevokedApprovalFail() public {
        vm.prank(bob); vm.expectRevert(); sale.buy{value: 2 ether}(id, 1 ether, 1, block.timestamp + 10);
        vm.warp(block.timestamp + 101);
        vm.prank(bob); vm.expectRevert(); sale.buy{value: 1 ether}(id, 1 ether, 1, block.timestamp + 10);
        vm.prank(alice); sale.list(id, 1 ether, block.timestamp + 100);
        vm.prank(alice); c.approve(address(0), id);
        vm.prank(bob); vm.expectRevert(); sale.buy{value: 1 ether}(id, 1 ether, 2, block.timestamp + 10);
    }
    function test_onlyTreasuryCanListAndCancel() public {
        vm.prank(bob); vm.expectRevert(); sale.list(id, 1 ether, block.timestamp + 100);
        vm.prank(bob); vm.expectRevert(); sale.cancel(id);
        vm.prank(alice); c.transferFrom(alice, bob, id);
        vm.prank(alice); vm.expectRevert(); sale.list(id, 1 ether, block.timestamp + 100);
    }
    function test_rejectedNFTDeliveryRollsBackPaymentAndListing() public {
        RefusingBuyer buyer = new RefusingBuyer(); uint256 before = alice.balance;
        vm.expectRevert(); buyer.buy{value: 1 ether}(sale, id);
        assertEq(alice.balance, before); assertEq(c.ownerOf(id), alice);
        (uint256 price,,) = sale.listings(id); assertEq(price, 1 ether);
    }
    function test_saleSettlesPastRoyaltiesToSeller() public {
        vm.prank(alice); bytes32 mid = c.register(id, DF, mep(keccak256("sale-model")));
        market.accrue{value: 1 ether}(mid);
        vm.prank(bob); sale.buy{value: 1 ether}(id, 1 ether, 1, block.timestamp + 10);
        assertEq(c.owed(alice), 0.9 ether); assertEq(c.owed(bob), 0);
    }
    function test_rejectedTreasuryPaymentRollsBackNFTAndBuyerFunds() public {
        vm.etch(alice, hex"60006000fd");
        uint256 before = bob.balance;
        vm.prank(bob); vm.expectRevert(bytes("treasury payment")); sale.buy{value: 1 ether}(id, 1 ether, 1, block.timestamp + 10);
        assertEq(bob.balance, before); assertEq(c.ownerOf(id), alice); assertTrue(sale.available(id));
    }
    function test_expiredBuyerDeadlineAndTransferredInventoryFail() public {
        vm.warp(50);
        vm.prank(bob); vm.expectRevert(bytes("buyer/deadline")); sale.buy{value: 1 ether}(id, 1 ether, 1, 49);
        vm.prank(alice); c.transferFrom(alice, bob, id);
        assertFalse(sale.available(id));
        vm.prank(bob); vm.expectRevert(bytes("unavailable")); sale.buy{value: 1 ether}(id, 1 ether, 1, 60);
    }

    function test_recipientCallbackCannotReenter() public {
        ReenteringBuyer buyer = new ReenteringBuyer();
        buyer.buy{value: 1 ether}(sale, id);
        assertTrue(buyer.blocked()); assertEq(c.ownerOf(id), address(buyer));
    }

}
