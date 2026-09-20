// SPDX-License-Identifier: 0BSD
pragma solidity ^0.8.20;

/// @title TreasuryRouter — a fixed address for a treasury whose destination can change
/// @notice A FlyCollection's TREASURY is immutable: it is where the collection's share of every adoption, birth and re-arm
///         goes, where ERC-2981 asks marketplaces to pay, and (until a base has a vendor of its own) where the base's share
///         of every royalty is credited -- for the collection's whole life. A life is longer than any one wallet, multisig or
///         buyback scheme, so the collection points HERE, and this forwards to wherever the treasury currently is.
///
///         It is not a proxy. There is no delegatecall and no replaceable logic: what can change is one address, the
///         `destination`, and everything this contract ever holds can leave only to that address. So:
///           - the owner's whole power is choosing the destination (two-step handover; renounced, it is fixed for good).
///             It reaches nobody's fly, no price and no rate: those are the collection's, and immutable.
///           - `sweep`, `collect` and `rescue` are permissionless. They can only move money TO the destination, so there is
///             nothing to protect, and a treasury that depends on its owner remembering to sweep is a worse treasury.
///           - `receive` does nothing at all. The collection hands its treasury a capped amount of gas and credits what it
///             will not take; marketplaces pay royalties with as little as the 2300-gas stipend. Doing work here -- a swap,
///             a split, even an event -- would make every adopter pay for it, or make a payment bounce. Work belongs to
///             the destination, which can be a contract with its own `sweep(minOut)` and its own slippage.
contract TreasuryRouter {
    address public owner;
    address public proposedOwner;
    address payable public destination;

    event DestinationSet(address indexed destination);
    event OwnerProposed(address indexed proposed);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event Swept(address indexed destination, uint256 amount);
    event Collected(address indexed from, uint256 amount);
    event Rescued(address indexed token, address indexed destination, uint256 amount);

    modifier onlyOwner() { require(msg.sender == owner, "owner"); _; }

    constructor(address owner_, address payable destination_) {
        require(owner_ != address(0) && destination_ != address(0), "zero");
        owner = owner_; destination = destination_;
        emit OwnershipTransferred(address(0), owner_); emit DestinationSet(destination_);
    }

    receive() external payable {}

    /// @notice forward everything held to the destination. Anyone may call it.
    function sweep() public returns (uint256 amount) {
        amount = address(this).balance; if (amount == 0) return 0;
        (bool ok,) = destination.call{value: amount}(""); require(ok, "destination refused");
        emit Swept(destination, amount);
    }
    /// @notice pull what a collection has credited to this address (`FlyCollection.owed`: the base's share of royalties,
    ///         and anything the collection could not push). It arrives through `receive`; `sweep` forwards it. Anyone may call it.
    function collect(IOwed from) external returns (uint256 amount) { amount = from.withdraw(); emit Collected(address(from), amount); }
    /// @notice forward an ERC-20 held here -- marketplaces pay resale royalties in WBNB and stablecoins as often as in BNB.
    ///         Written for tokens that return nothing as well as for those that return a bool. Anyone may call it.
    function rescue(address token) external returns (uint256 amount) {
        (bool s, bytes memory d) = token.staticcall(abi.encodeWithSignature("balanceOf(address)", address(this))); require(s && d.length >= 32, "not a token");
        amount = abi.decode(d, (uint256)); if (amount == 0) return 0;
        (bool ok, bytes memory r) = token.call(abi.encodeWithSignature("transfer(address,uint256)", destination, amount));
        require(ok && (r.length == 0 || abi.decode(r, (bool))), "transfer failed");
        emit Rescued(token, destination, amount);
    }

    function setDestination(address payable next) external onlyOwner { require(next != address(0), "zero"); destination = next; emit DestinationSet(next); }
    function proposeOwner(address next) external onlyOwner { proposedOwner = next; emit OwnerProposed(next); }
    function acceptOwner() external { require(msg.sender == proposedOwner, "proposed"); emit OwnershipTransferred(owner, msg.sender); owner = msg.sender; proposedOwner = address(0); }
    /// @notice give the destination up for good: from here on it cannot change
    function renounceOwner() external onlyOwner { emit OwnershipTransferred(owner, address(0)); owner = address(0); proposedOwner = address(0); }
}
interface IOwed { function withdraw() external returns (uint256 amount); }
