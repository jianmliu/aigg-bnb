// SPDX-License-Identifier: 0BSD
pragma solidity ^0.8.20;

/// @title CollectionWhitelist — which collections of brains this system recognises
/// @notice The mesh underneath is permissionless and stays that way: anybody may register a MEP, bond for it, host it,
///         post a task against it. Nothing here can stop any of that, and nothing here touches a token, a bond, a fee
///         or a royalty. What this contract answers is a different question -- whose brains are OURS: which ones the
///         page lists, the relayer aggregates claims and sponsors gas for, and the dataset counts.
///
///         The unit is the COLLECTION, the way a marketplace verifies a collection rather than its items. A listed
///         collection answers for its own brains (`IListedCollection.listed`): its bases and every brain bound to one
///         of its tokens. So an adopted fly is recognised when its owner registers it, and a BRED fly is recognised the
///         same way, with nobody's approval -- it is a token of a recognised collection like any other. A collection
///         somebody deploys for themselves is a perfectly good collection and is not on this list until the curator
///         puts it there; a MEP registered straight on the registry belongs to no collection at all.
///
/// @dev    This is the first contract in the repository with somebody in charge of it, so what that somebody can do is
///         kept to the minimum that makes a list a list: add a collection, remove one, hand the job over (in two
///         steps, so it cannot be sent to a typo), or give it up for good, which freezes the list. Removing a
///         collection un-recognises it and does nothing else: its tokens, their owners, their royalties and every
///         settled task are exactly where they were.
contract CollectionWhitelist {
    uint256 public constant MAX_COLLECTIONS = 64; // `listed` walks the list; this is what keeps that walk a view

    address public curator;
    address public pendingCurator;
    address[] internal _collections;
    mapping(address => uint256) internal _slot; // 1-based position in _collections; 0 = not listed

    event CollectionListed(address indexed collection, string note);
    event CollectionDelisted(address indexed collection, string reason);
    event CuratorProposed(address indexed from, address indexed to);
    event CuratorChanged(address indexed from, address indexed to);

    modifier onlyCurator() { require(msg.sender == curator, "curator"); _; }

    constructor(address curator_) { require(curator_ != address(0), "curator"); curator = curator_; emit CuratorChanged(address(0), curator_); }

    // ---- the list ----
    /// @param note why, for the record: a name, a link to the genesis set. It is an event, not state.
    function add(address collection, string calldata note) external onlyCurator {
        require(_slot[collection] == 0, "listed"); require(_collections.length < MAX_COLLECTIONS, "full");
        // it has to be able to answer for its brains, and the zero id is nobody's: a contract that says yes to it
        // would say yes to every unset base and every unregistered token
        require(collection.code.length > 0, "not a contract");
        try IListedCollection(collection).listed(bytes32(0)) returns (bool zero) { require(!zero, "lists the zero id"); } catch { revert("no listed()"); }
        _collections.push(collection); _slot[collection] = _collections.length;
        emit CollectionListed(collection, note);
    }
    function remove(address collection, string calldata reason) external onlyCurator {
        uint256 s = _slot[collection]; require(s != 0, "not listed");
        address last = _collections[_collections.length - 1];
        _collections[s - 1] = last; _slot[last] = s; _collections.pop(); delete _slot[collection];
        emit CollectionDelisted(collection, reason);
    }
    function isWhitelisted(address collection) external view returns (bool) { return _slot[collection] != 0; }
    function collections() external view returns (address[] memory) { return _collections; }

    /// @notice Is this brain one of the system's, and whose is it? The first listed collection that claims it. A base
    ///         brain may be claimed by several (each names its bases); the answer is then any one of them, and `ok` is
    ///         what matters. A collection that reverts, or runs out of gas, is skipped rather than allowed to take the
    ///         list down with it.
    function listed(bytes32 mepId) external view returns (bool ok, address collection) {
        if (mepId == bytes32(0)) return (false, address(0));
        for (uint256 i = 0; i < _collections.length; i++) {
            try IListedCollection(_collections[i]).listed{gas: 100_000}(mepId) returns (bool yes) { if (yes) return (true, _collections[i]); } catch {}
        }
        return (false, address(0));
    }

    // ---- the curator ----
    function proposeCurator(address to) external onlyCurator { pendingCurator = to; emit CuratorProposed(curator, to); }
    function acceptCurator() external { require(msg.sender == pendingCurator, "pending"); emit CuratorChanged(curator, msg.sender); curator = msg.sender; pendingCurator = address(0); }
    /// @notice give the job up for good: the list is frozen as it stands, and no one can ever be curator again
    function renounceCurator() external onlyCurator { emit CuratorChanged(curator, address(0)); curator = address(0); pendingCurator = address(0); }
}

/// @notice what a collection has to be able to say to be listed: is this brain one of yours?
interface IListedCollection { function listed(bytes32 mepId) external view returns (bool); }
