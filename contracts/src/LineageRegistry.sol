// SPDX-License-Identifier: 0BSD
pragma solidity ^0.8.20;

import "aigg-porw/mesh/FlyDeltaRecordVerifier.sol";

/// @title LineageRegistry — who a derived brain is, provably
/// @notice A procedural brain (FLYDELTAv3, in-place layout) is a recipe; what the mesh executes is the payload the
///         recipe produces, identified by its `model_id`. Somebody has to say what that `model_id` is, and nobody can
///         compute it on-chain: it is the Merkle root of tens of megabytes. This registry makes the statement
///         accountable instead. A registration posts `(delta, model_id)` with a bond and opens a challenge window;
///         anyone may show ONE record, or one static byte, of the declared payload to contradict the recipe
///         (`FlyDeltaRecordVerifier`, ~0.2 M gas), which takes the bond and kills the registration. An unchallenged
///         registration becomes final and its `model_id` can be built on.
///
///         Why it is sound to check one generation at a time: a child's check reads its parents' COMMITTED tiles, so
///         parents must be final before a child registers. A wrong parent would have been challengeable in its own
///         window; after that its root is simply what the lineage is.
///
///         A base is not declared, it is proven: tile 0 of the payload carries the header, from which `synOffset` and
///         the tile count follow, and the opening verifies against the base's `model_id` with that very count.
///
///         Nothing here is owned or upgradable. The bond and the window are immutable.
contract LineageRegistry {
    FlyDeltaRecordVerifier public immutable VERIFIER;
    uint256 public immutable REGISTRATION_BOND;
    uint64 public immutable CHALLENGE_BLOCKS;
    address public immutable SINK; // receives the half of a forfeited bond the challenger does not get

    enum Status { None, Pending, Final, Fraud }
    struct Registration { bytes32 modelId; bytes32 baseModelId; bytes32 parentA; bytes32 parentB; address registrant; uint64 challengeEnd; Status status; }

    mapping(bytes32 => FlyDeltaRecordVerifier.Lineage) internal _bases; // base model_id -> layout constants of its lineage
    mapping(bytes32 => Registration) public registrations;              // delta id = keccak(delta bytes)
    mapping(bytes32 => bytes32) public deltaOfModel;                    // model_id -> the delta id that claimed it

    event BaseRegistered(bytes32 indexed baseModelId, uint64 nTiles, uint64 synOffset, uint64 synapses, uint16 nameLen);
    /// @dev the delta bytes ride in the log: that is where a challenger gets the recipe from
    event Registered(bytes32 indexed deltaId, bytes32 indexed modelId, bytes32 indexed baseModelId, address registrant, uint64 challengeEnd, bytes delta);
    event Finalized(bytes32 indexed deltaId, bytes32 indexed modelId);
    event Fraud(bytes32 indexed deltaId, bytes32 indexed modelId, address indexed challenger, uint64 at, int16 expected, int16 got);

    constructor(FlyDeltaRecordVerifier verifier, uint256 registrationBond, uint64 challengeBlocks, address sink) { require(challengeBlocks > 0 && sink != address(0), "window / sink"); VERIFIER = verifier; REGISTRATION_BOND = registrationBond; CHALLENGE_BLOCKS = challengeBlocks; SINK = sink; }

    // ---- bases ----
    function baseOf(bytes32 baseModelId) public view returns (FlyDeltaRecordVerifier.Lineage memory L) { L = _bases[baseModelId]; require(L.nTiles != 0, "unknown base"); }
    function isBase(bytes32 baseModelId) external view returns (bool) { return _bases[baseModelId].nTiles != 0; }

    /// @notice prove a base's layout from its first tile: FLYBRAINv2 header = magic | u64 neurons | u64 synapses | u16 name_len | name
    function registerBase(bytes32 baseModelId, bytes calldata tile0, bytes32[] calldata proof) external {
        require(_bases[baseModelId].nTiles == 0, "registered"); require(tile0.length == 4096, "tile size");
        require(bytes12(tile0[0:12]) == bytes12("FLYBRAINv2\x00\x00"), "not FLYBRAINv2");
        uint256 neurons = _le(tile0, 12, 8); uint256 synapses = _le(tile0, 20, 8); uint256 nameLen = _le(tile0, 28, 2);
        require(neurons > 0 && neurons <= type(uint32).max && synapses > 0 && synapses <= type(uint32).max, "header");
        uint256 synOffset = 30 + nameLen + 8 * neurons; uint256 nTiles = (synOffset + 10 * synapses + 4095) / 4096;
        require(VERIFIER.merkleVerifyCounted(baseModelId, VERIFIER.tileLeaf(0, tile0), 0, uint64(nTiles), proof), "tile 0 proof");
        _bases[baseModelId] = FlyDeltaRecordVerifier.Lineage(baseModelId, uint64(nTiles), uint64(synOffset), uint64(synapses), uint16(nameLen));
        emit BaseRegistered(baseModelId, uint64(nTiles), uint64(synOffset), uint64(synapses), uint16(nameLen));
    }
    function _le(bytes calldata d, uint256 off, uint256 n) internal pure returns (uint256 v) { for (uint256 i = 0; i < n; i++) v |= uint256(uint8(d[off + i])) << (8 * i); }

    // ---- registrations ----
    function deltaIdOf(bytes calldata delta) public pure returns (bytes32) { return keccak256(delta); }
    function statusOf(bytes32 deltaId) external view returns (Status) { return registrations[deltaId].status; }
    /// @notice the model_id a delta produces, once nobody could contradict it (reverts otherwise)
    function finalModelId(bytes32 deltaId) public view returns (bytes32) { Registration storage r = registrations[deltaId]; require(r.status == Status.Final, "not final"); return r.modelId; }

    /// @notice declare what an in-place cross produces. Its base must be registered and its parents final.
    function register(bytes calldata delta, bytes32 modelId) external payable returns (bytes32 deltaId) {
        require(msg.value == REGISTRATION_BOND, "bond"); require(modelId != bytes32(0), "model id");
        FlyDeltaRecordVerifier.Cross memory x = VERIFIER.decodeCross(delta); // in-place, no ops, well-formed
        FlyDeltaRecordVerifier.Lineage storage L = _bases[x.baseModelId]; require(L.nTiles != 0, "unknown base");
        deltaId = keccak256(delta);
        require(deltaOfModel[modelId] == bytes32(0) && _bases[modelId].nTiles == 0, "model id taken");
        { Status st = registrations[deltaId].status; require(st == Status.None || st == Status.Fraud, "registered"); } // a recipe whose wrong claim was struck down can be claimed again, correctly
        _parentOk(x.parentA, x.baseModelId); _parentOk(x.parentB, x.baseModelId);
        uint64 end = uint64(block.number) + CHALLENGE_BLOCKS;
        registrations[deltaId] = Registration(modelId, x.baseModelId, x.parentA, x.parentB, msg.sender, end, Status.Pending); deltaOfModel[modelId] = deltaId;
        emit Registered(deltaId, modelId, x.baseModelId, msg.sender, end, delta);
    }
    function _parentOk(bytes32 parent, bytes32 baseModelId) internal view {
        if (parent == bytes32(0)) return; // the base itself
        Registration storage p = registrations[parent]; require(p.status == Status.Final, "parent not final"); require(p.baseModelId == baseModelId, "parent of another base");
    }
    function _parentRoot(bytes32 parent) internal view returns (bytes32) { return parent == bytes32(0) ? bytes32(0) : registrations[parent].modelId; }
    function _pending(bytes32 deltaId) internal view returns (Registration storage r) { r = registrations[deltaId]; require(r.status == Status.Pending && block.number <= r.challengeEnd, "not challengeable"); }

    /// @notice show that record `j` of the declared payload is not what the recipe gives. Costs the challenger only gas;
    ///         a record that turns out consistent reverts and changes nothing.
    function challengeRecord(
        bytes calldata delta, uint64 j,
        FlyDeltaRecordVerifier.TileOpening[] calldata baseT, FlyDeltaRecordVerifier.TileOpening[] calldata aT,
        FlyDeltaRecordVerifier.TileOpening[] calldata bT, FlyDeltaRecordVerifier.TileOpening[] calldata childT
    ) external {
        bytes32 deltaId = keccak256(delta); Registration storage r = _pending(deltaId);
        (uint8 verdict, int16 expected, int16 got) = VERIFIER.checkRecord(_bases[r.baseModelId], delta, j, r.modelId, _parentRoot(r.parentA), _parentRoot(r.parentB), baseT, aT, bT, childT);
        require(verdict == 0, "consistent");
        _fraud(deltaId, r, _bases[r.baseModelId].synOffset + j * 10, expected, got);
    }
    /// @notice show that the declared payload differs from its base outside the name and the weight fields
    function challengeStatic(bytes32 deltaId, FlyDeltaRecordVerifier.TileOpening calldata baseT, FlyDeltaRecordVerifier.TileOpening calldata childT) external {
        Registration storage r = _pending(deltaId);
        (uint8 verdict, uint64 at) = VERIFIER.checkStaticTile(_bases[r.baseModelId], r.modelId, baseT, childT);
        require(verdict == 0, "consistent");
        _fraud(deltaId, r, at, 0, 0);
    }
    function _fraud(bytes32 deltaId, Registration storage r, uint64 at, int16 expected, int16 got) internal {
        r.status = Status.Fraud; delete deltaOfModel[r.modelId];
        emit Fraud(deltaId, r.modelId, msg.sender, at, expected, got);
        // Half to the challenger, half to the sink: if the whole bond came back, a registrant could strike down its own
        // wrong claim for free and squat a recipe indefinitely at the price of gas.
        uint256 reward = REGISTRATION_BOND / 2;
        (bool ok,) = msg.sender.call{value: reward}(""); require(ok, "pay");
        (ok,) = SINK.call{value: REGISTRATION_BOND - reward}(""); require(ok, "sink");
    }
    /// @notice after the window, an unchallenged registration is final and the bond goes back
    function finalize(bytes32 deltaId) external {
        Registration storage r = registrations[deltaId]; require(r.status == Status.Pending && block.number > r.challengeEnd, "not finalizable");
        r.status = Status.Final; emit Finalized(deltaId, r.modelId);
        (bool ok,) = r.registrant.call{value: REGISTRATION_BOND}(""); require(ok, "refund");
    }
}
