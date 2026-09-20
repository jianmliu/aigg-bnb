// SPDX-License-Identifier: 0BSD
pragma solidity ^0.8.20;
import "./FlyCollection.sol";
import "./FounderInventoryVault.sol";

/// @notice A committed genesis set minted exclusively into a once-bound treasury vault.
/// Genesis mint is closed before binding; zero mint price never creates a public free mint.
contract TreasuryFounderCollection is FlyCollection {
    struct Config {
        bytes32 baseFemale; bytes32 baseMale; bytes32 genesisRoot; uint32 genesisSize;
        uint256 breedFee; uint256 hatchBounty; address treasury;
        IMEPRegistry meps; IInstanceBonding instances; LineageRegistry lineage;
        bytes32 baseMepFemale; bytes32 baseMepMale; IRoyaltyMarket market;
        uint16 royaltyBps; Shares shares;
    }
    address public immutable bootstrapper;
    address public inventoryVault;
    event InventoryVaultBound(address indexed vault);

    constructor(Config memory c) FlyCollection(c.baseFemale, c.baseMale, c.genesisRoot, c.genesisSize,
        0, 0, c.breedFee, c.hatchBounty, c.treasury, c.meps, c.instances, c.lineage,
        c.baseMepFemale, c.baseMepMale, c.market, c.royaltyBps, c.shares) {
        bootstrapper = msg.sender;
    }
    function setInventoryVault(FounderInventoryVault vault) external {
        require(msg.sender == bootstrapper, "bootstrapper only");
        require(inventoryVault == address(0), "already bound");
        require(address(vault).code.length > 0, "vault code");
        require(address(vault.collection()) == address(this) && vault.recipient() == TREASURY && vault.owner() == owner, "vault configuration");
        inventoryVault = address(vault);
        emit InventoryVaultBound(address(vault));
    }
    function _authorizeGenesisMint() internal view override {
        require(inventoryVault != address(0) && msg.sender == inventoryVault, "inventory vault only");
    }
}
