// SPDX-License-Identifier: 0BSD
pragma solidity ^0.8.20;
import "./FlyCollectionRevision.t.sol";
import "../src/FounderInventoryVault.sol";

contract FounderInventoryVaultTest is Test {
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

    FounderInventoryVault vault;
    function setUp() public {
        setupCollection();
        vault = new FounderInventoryVault(c, payable(treasury), admin);
    }
    function stock() internal returns (uint256 tokenId) {
        vm.deal(admin, 1 ether);
        vm.prank(admin);
        tokenId = vault.mint{value: PRICE}(0, 0, DF, proofFor(0));
    }
    function test_vaultSaleForwardsFullProceedsToExistingTreasury() public {
        uint256 tokenId = stock();
        assertEq(c.ownerOf(tokenId), address(vault));
        vm.prank(admin); vault.list(tokenId, 0.01 ether, block.timestamp + 100);
        uint256 beforeBalance = treasury.balance;
        TreasuryInventorySale venue = vault.sale();
        vm.prank(bob); venue.buy{value: 0.01 ether}(tokenId, 0.01 ether, 1, block.timestamp + 10);
        assertEq(c.ownerOf(tokenId), bob);
        assertEq(treasury.balance - beforeBalance, 0.01 ether);
        assertEq(address(vault).balance, 0);
    }
    function test_vaultOwnerCanRegisterAndCancel() public {
        uint256 tokenId = stock();
        vm.prank(admin); bytes32 mid = vault.register(tokenId, DF, mep(keccak256("inventory-model")));
        assertTrue(mid != bytes32(0));
        vm.prank(admin); vault.list(tokenId, 0.01 ether, block.timestamp + 100);
        vm.prank(admin); vault.cancel(tokenId);
        assertFalse(vault.sale().available(tokenId));
    }
    function test_vaultRejectsUnauthorizedManagement() public {
        uint256 tokenId = stock();
        vm.startPrank(bob);
        vm.expectRevert("owner only"); vault.list(tokenId, 1 ether, block.timestamp + 100);
        vm.expectRevert("owner only"); vault.cancel(tokenId);
        vm.expectRevert("owner only"); vault.register(tokenId, DF, mep(keccak256("bad")));
        vm.expectRevert("owner only"); vault.mint(1, 1, DM, proofFor(1));
        vm.stopPrank();
    }
    function test_inventoryRoyaltiesRemainPayableAfterSale() public {
        uint256 tokenId = stock();
        vm.prank(admin); bytes32 mid = vault.register(tokenId, DF, mep(keccak256("royalty-model")));
        market.accrue{value: 1 ether}(mid);
        vm.prank(admin); vault.list(tokenId, 0.01 ether, block.timestamp + 100);
        TreasuryInventorySale venue = vault.sale();
        vm.prank(bob); venue.buy{value: 0.01 ether}(tokenId, 0.01 ether, 1, block.timestamp + 10);
        uint256 beforeBalance = treasury.balance;
        vault.collect();
        assertEq(treasury.balance - beforeBalance, 0.9 ether);
        assertEq(c.owed(address(vault)), 0);
    }
    function test_refusingRecipientRollsBackSale() public {
        uint256 tokenId = stock();
        vm.prank(admin); vault.list(tokenId, 0.01 ether, block.timestamp + 100);
        vm.etch(treasury, hex"60006000fd");
        TreasuryInventorySale venue = vault.sale();
        uint256 beforeBalance = bob.balance;
        vm.prank(bob); vm.expectRevert("treasury payment");
        venue.buy{value: 0.01 ether}(tokenId, 0.01 ether, 1, block.timestamp + 10);
        assertEq(c.ownerOf(tokenId), address(vault));
        assertEq(bob.balance, beforeBalance);
        assertTrue(venue.available(tokenId));
    }
    function test_ownerHandoverRequiresAcceptance() public {
        vm.prank(bob); vm.expectRevert("owner only"); vault.proposeOwner(bob);
        vm.prank(admin); vault.proposeOwner(bob);
        assertEq(vault.owner(), admin);
        vm.prank(alice); vm.expectRevert("proposed owner only"); vault.acceptOwner();
        vm.prank(bob); vault.acceptOwner();
        assertEq(vault.owner(), bob);
        assertEq(vault.proposedOwner(), address(0));
    }
}
