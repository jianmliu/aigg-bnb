// SPDX-License-Identifier: 0BSD
pragma solidity ^0.8.20;

interface IInventoryNFT {
    function ownerOf(uint256 id) external view returns (address);
    function getApproved(uint256 id) external view returns (address);
    function isApprovedForAll(address owner, address operator) external view returns (bool);
    function safeTransferFrom(address from, address to, uint256 id) external;
}

/// @notice Native-BNB sale of existing NFTs owned by a fixed treasury. No minting, bonds, swaps or LP operations.
/// @dev Listings are noncustodial, expire, and bind a monotonically increasing revision. Treasury must cancel before
/// moving inventory elsewhere: an unexpired listing remains authorized if the token later returns with approval.
/// All proceeds go to the seller treasury; no additional ERC-2981 resale royalty is deducted by this venue.
contract TreasuryInventorySale {
    IInventoryNFT public immutable collection;
    address public immutable treasury;
    struct Listing { uint256 price; uint256 expiresAt; uint256 revision; }
    mapping(uint256 => Listing) public listings;
    bool private entered;
    event Listed(uint256 indexed tokenId, uint256 price, uint256 expiresAt, uint256 revision);
    event Cancelled(uint256 indexed tokenId, uint256 revision);
    event Adopted(uint256 indexed tokenId, address indexed buyer, uint256 price, uint256 revision);
    modifier nonReentrant() { require(!entered, "reentrant"); entered = true; _; entered = false; }
    modifier onlyTreasury() { require(msg.sender == treasury, "treasury only"); _; }
    constructor(address nft, address seller) {
        require(nft.code.length > 0 && seller != address(0), "configuration");
        collection = IInventoryNFT(nft); treasury = seller;
    }
    function available(uint256 id) public view returns (bool) {
        Listing memory q = listings[id];
        if (q.price == 0 || block.timestamp > q.expiresAt) return false;
        try collection.ownerOf(id) returns (address owner) {
            return owner == treasury && (collection.getApproved(id) == address(this) || collection.isApprovedForAll(treasury, address(this)));
        } catch { return false; }
    }
    function list(uint256 id, uint256 price, uint256 expiresAt) external onlyTreasury nonReentrant {
        require(price > 0 && expiresAt > block.timestamp, "terms");
        require(collection.ownerOf(id) == treasury, "inventory owner");
        require(collection.getApproved(id) == address(this) || collection.isApprovedForAll(treasury, address(this)), "approval");
        uint256 revision = listings[id].revision + 1;
        listings[id] = Listing(price, expiresAt, revision);
        emit Listed(id, price, expiresAt, revision);
    }
    function cancel(uint256 id) external onlyTreasury nonReentrant {
        uint256 revision = listings[id].revision + 1;
        listings[id] = Listing(0, 0, revision); emit Cancelled(id, revision);
    }
    function buy(uint256 id, uint256 expectedPrice, uint256 expectedRevision, uint256 deadline) external payable nonReentrant {
        require(msg.sender != treasury && block.timestamp <= deadline, "buyer/deadline");
        Listing memory q = listings[id];
        require(available(id), "unavailable");
        require(q.price == expectedPrice && q.revision == expectedRevision && msg.value == q.price, "quote/payment");
        listings[id] = Listing(0, 0, q.revision + 1);
        collection.safeTransferFrom(treasury, msg.sender, id);
        (bool ok,) = treasury.call{value: msg.value}(""); require(ok, "treasury payment");
        emit Adopted(id, msg.sender, msg.value, q.revision);
    }
}
