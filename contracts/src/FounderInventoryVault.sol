// SPDX-License-Identifier: 0BSD
pragma solidity ^0.8.20;

import "./FlyCollection.sol";
import "./TreasuryInventorySale.sol";

/// @notice Founder custody for an existing treasury that cannot operate NFTs.
/// Only the fixed collection can be managed; all sale proceeds and royalties go to recipient.
contract FounderInventoryVault {
    FlyCollection public immutable collection;
    TreasuryInventorySale public immutable sale;
    address payable public immutable recipient;
    address public owner;
    address public proposedOwner;
    event OwnerProposed(address indexed next);
    event OwnershipTransferred(address indexed previous, address indexed next);
    modifier onlyOwner() { require(msg.sender == owner, "owner only"); _; }

    constructor(FlyCollection nft, address payable recipient_, address owner_) {
        require(address(nft).code.length > 0 && recipient_ != address(0) && owner_ != address(0), "configuration");
        collection = nft; recipient = recipient_; owner = owner_;
        sale = new TreasuryInventorySale(address(nft), address(this));
        nft.setApprovalForAll(address(sale), true);
    }
    receive() external payable {
        (bool ok,) = recipient.call{value: msg.value}(""); require(ok, "recipient payment");
    }
    function mint(uint32 index, uint8 sex, bytes32 deltaHash, bytes32[] calldata proof) external payable onlyOwner returns (uint256) {
        return collection.mint{value: msg.value}(index, sex, deltaHash, proof);
    }
    function register(uint256 id, bytes32 deltaHash, IMEPRegistry.MEP calldata m) external onlyOwner returns (bytes32) {
        return collection.register(id, deltaHash, m);
    }
    function registerDerived(uint256 id, bytes calldata delta, IMEPRegistry.MEP calldata m) external onlyOwner returns (bytes32) {
        return collection.registerDerived(id, delta, m);
    }
    function list(uint256 id, uint256 price, uint256 expiresAt) external onlyOwner { sale.list(id, price, expiresAt); }
    function cancel(uint256 id) external onlyOwner { sale.cancel(id); }
    function collect() external { collection.withdraw(); }
    function collectToken(address token) external {
        uint256 amount = collection.withdrawToken(token);
        TokenTransfer.send(token, recipient, amount);
    }
    function proposeOwner(address next) external onlyOwner {
        require(next != address(0), "zero owner"); proposedOwner = next; emit OwnerProposed(next);
    }
    function acceptOwner() external {
        require(msg.sender == proposedOwner, "proposed owner only");
        emit OwnershipTransferred(owner, msg.sender); owner = msg.sender; proposedOwner = address(0);
    }
    function onERC721Received(address, address, uint256, bytes calldata) external view returns (bytes4) {
        require(msg.sender == address(collection), "collection only");
        return this.onERC721Received.selector;
    }
}
