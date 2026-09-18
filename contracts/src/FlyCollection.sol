// SPDX-License-Identifier: 0BSD
pragma solidity ^0.8.20;

import "aigg-porw/interfaces/PorwMesh.sol";

/// @title FlyCollection — a fixed collection of fly-brain individuals
/// @notice An individual is a FLYDELTAv1 edit of one of two released brains (a female and a male base). The token
///         carries which base it varies, the hash of its delta, and — once somebody has applied that delta and
///         computed the result — the `model_id` and `mep_id` it registers as. Owning an individual means owning a
///         research subject: the mesh executes tasks against it and the owner takes a share of the fees.
///
///         What a token is NOT is the stake, and it is NOT an execution licence. Both of those are deliberate:
///
///         - The stake stays fungible. `InstanceRegistry.slash` moves value to the winner of a dispute; an NFT is
///           a bad instrument for that (the punishment becomes the floor price of an illiquid asset, and
///           `weightOf = bonded / UNIT` stops being a parameter the protocol controls). Minting *funds* a bond
///           instead of replacing it: one action, one price, and the minter comes out owning an individual and
///           being a bonded instance.
///         - Anyone may execute any MEP. `TaskMarket` draws sortition over the instances bonded for a given MEP,
///           so redundancy 2 needs two of them holding that brain. If a token were the sole right to run its own
///           brain, every MEP would have exactly one executor, no task could be cross-checked, and no dispute
///           could ever happen — which is the one property this system has that its neighbours do not.
///
///         See docs/TOKENOMICS.md. Two things there are still open and are marked OPEN below.
contract FlyCollection {
    // ---- the two bases ----
    uint8 public constant FEMALE = 0;
    uint8 public constant MALE = 1;
    bytes32 public immutable BASE_FEMALE; // model_id of the female base payload
    bytes32 public immutable BASE_MALE;   // model_id of the male base payload

    // ---- economics, all immutable: no owner may move them after deployment ----
    uint256 public immutable MINT_PRICE;
    uint256 public immutable MINT_BOND;   // the part of MINT_PRICE that becomes the minter's bond
    uint256 public immutable BREED_FEE;
    address public immutable TREASURY;    // where the non-bond remainder goes; fixed at deployment
    bytes32 public immutable GENESIS_ROOT;
    uint32 public immutable GENESIS_SIZE;

    IMEPRegistry public immutable MEPS;
    IInstanceBonding public immutable INSTANCES;

    struct Individual {
        bytes32 baseModelId; // which base this varies
        bytes32 deltaHash;   // keccak256 of the FLYDELTAv1 bytes
        bytes32 modelId;     // model_id of the applied payload, once claimed
        bytes32 mepId;       // once registered on the MEP registry
        uint8 sex;
        uint32 generation;
        uint64 parentA;      // 0 for genesis
        uint64 parentB;
        bytes32 seed;        // breeding seed; the child's delta is derived from the parents' deltas and this
    }

    mapping(uint256 => Individual) public individuals;
    mapping(uint256 => bool) public genesisMinted; // by genesis index
    uint256 public totalSupply;
    uint256 internal nextId = 1;

    // ---- ERC-721 core ----
    // NOTE: hand-written to keep the repository dependency-free, in the style of the neutral contracts. It is the
    // least interesting code here and the most standard; have it reviewed against a vetted implementation, or
    // replace it with one, before this holds anything of value.
    string public name = "Fly Brain Individuals";
    string public symbol = "FLYBRAIN";
    mapping(uint256 => address) internal _ownerOf;
    mapping(address => uint256) internal _balanceOf;
    mapping(uint256 => address) public getApproved;
    mapping(address => mapping(address => bool)) public isApprovedForAll;

    event Transfer(address indexed from, address indexed to, uint256 indexed id);
    event Approval(address indexed owner, address indexed spender, uint256 indexed id);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);
    event Minted(uint256 indexed id, address indexed to, uint8 sex, bytes32 deltaHash, uint32 genesisIndex);
    event Bred(uint256 indexed id, uint256 indexed parentA, uint256 indexed parentB, bytes32 seed);
    event Registered(uint256 indexed id, bytes32 indexed mepId, bytes32 modelId);

    function ownerOf(uint256 id) public view returns (address o) { o = _ownerOf[id]; require(o != address(0), "no token"); }
    function balanceOf(address a) public view returns (uint256) { require(a != address(0), "zero"); return _balanceOf[a]; }
    function approve(address spender, uint256 id) external { address o = ownerOf(id); require(msg.sender == o || isApprovedForAll[o][msg.sender], "not authorised"); getApproved[id] = spender; emit Approval(o, spender, id); }
    function setApprovalForAll(address op, bool ok) external { isApprovedForAll[msg.sender][op] = ok; emit ApprovalForAll(msg.sender, op, ok); }
    function transferFrom(address from, address to, uint256 id) public {
        require(from == _ownerOf[id], "wrong from"); require(to != address(0), "zero to");
        require(msg.sender == from || isApprovedForAll[from][msg.sender] || msg.sender == getApproved[id], "not authorised");
        // The bond belongs to an address, not to a token: transferring an individual moves the research subject
        // and its fee share, and nothing else. The new owner bonds themselves if they want to run a node.
        _balanceOf[from]--; _balanceOf[to]++; _ownerOf[id] = to; delete getApproved[id];
        emit Transfer(from, to, id);
    }
    function safeTransferFrom(address from, address to, uint256 id) external { safeTransferFrom(from, to, id, ""); }
    function safeTransferFrom(address from, address to, uint256 id, bytes memory data) public {
        transferFrom(from, to, id);
        require(to.code.length == 0 || IERC721Receiver(to).onERC721Received(msg.sender, from, id, data) == IERC721Receiver.onERC721Received.selector, "unsafe recipient");
    }
    function supportsInterface(bytes4 i) external pure returns (bool) { return i == 0x01ffc9a7 || i == 0x80ac58cd || i == 0x5b5e139f; }

    constructor(
        bytes32 baseFemale, bytes32 baseMale, bytes32 genesisRoot, uint32 genesisSize,
        uint256 mintPrice, uint256 mintBond, uint256 breedFee, address treasury,
        IMEPRegistry meps, IInstanceBonding instances
    ) {
        require(mintBond <= mintPrice, "bond > price"); require(treasury != address(0), "treasury");
        BASE_FEMALE = baseFemale; BASE_MALE = baseMale; GENESIS_ROOT = genesisRoot; GENESIS_SIZE = genesisSize;
        MINT_PRICE = mintPrice; MINT_BOND = mintBond; BREED_FEE = breedFee; TREASURY = treasury;
        MEPS = meps; INSTANCES = instances;
    }

    /// @notice Mint a genesis individual. The whole genesis set is committed at deployment as a Merkle root over
    ///         `keccak256(index ‖ sex ‖ deltaHash)`, so which individuals exist is fixed before anyone mints and
    ///         no owner can add to it afterwards. The delta bytes themselves are published off-chain and are
    ///         content-addressed by `deltaHash`.
    /// @dev    MINT_BOND is bonded for the minter against the BASE brain, which is the one they can host on day
    ///         one; joining their own individual's MEP is a later top-up once it is registered.
    ///         OPEN (upstream): this needs `InstanceRegistry.bondFor(address,bytes32[])`. `bond()` bonds
    ///         `msg.sender`, so a contract cannot bond on a user's behalf; sponsored bonding is a general thing
    ///         the neutral registry should have. Until it exists, MINT_BOND must be 0 and the minter bonds
    ///         separately — which is exactly the two-step flow this design is trying to remove.
    function mint(uint32 genesisIndex, uint8 sex, bytes32 deltaHash, bytes32[] calldata proof) external payable returns (uint256 id) {
        require(msg.value == MINT_PRICE, "price");
        require(genesisIndex < GENESIS_SIZE && !genesisMinted[genesisIndex], "index");
        require(sex == FEMALE || sex == MALE, "sex");
        require(_verify(proof, GENESIS_ROOT, keccak256(abi.encode(genesisIndex, sex, deltaHash))), "not in the genesis set");
        genesisMinted[genesisIndex] = true;

        id = nextId++; totalSupply++;
        individuals[id] = Individual({
            baseModelId: sex == FEMALE ? BASE_FEMALE : BASE_MALE, deltaHash: deltaHash,
            modelId: bytes32(0), mepId: bytes32(0), sex: sex, generation: 0, parentA: 0, parentB: 0, seed: bytes32(0)
        });
        _balanceOf[msg.sender]++; _ownerOf[id] = msg.sender;
        emit Transfer(address(0), msg.sender, id); emit Minted(id, msg.sender, sex, deltaHash, genesisIndex);

        if (MINT_BOND > 0) { bytes32[] memory none = new bytes32[](0); INSTANCES.bondFor{value: MINT_BOND}(msg.sender, none); }
        (bool ok,) = TREASURY.call{value: MINT_PRICE - MINT_BOND}(""); require(ok, "treasury");
    }

    /// @notice Breed one female and one male individual. Both must be held (or approved) by the caller.
    /// @dev    The child is a variant of ONE base — a delta's ops are indices into one base's root-id table, and
    ///         the two bases index unrelated animals, so a merged edit list across bases is noise, not a hybrid.
    ///         What is recorded here is the RECIPE, not the result: the parents and a seed. The child's delta is
    ///         derived off-chain by the published deterministic function of (parent deltas, seed), and claimed
    ///         with `register`. A wrong claim produces a `model_id` nobody can reproduce, so the MEP is simply
    ///         dead — self-punishing rather than trustless.
    ///         OPEN: which derivation. docs/TOKENOMICS.md §4 (a) pairing-as-entropy — implementable now — or (b)
    ///         pairing-as-projection through a cross-sex cell-type map, which needs external data this project
    ///         does not have. Putting the parents' delta bytes on-chain (SSTORE2, ~940k gas for 4.7 KB) would let
    ///         a later version derive the child here and make breeding trustless instead of self-punishing.
    function breed(uint256 a, uint256 b) external payable returns (uint256 id) {
        require(msg.value == BREED_FEE, "fee");
        require(_may(a) && _may(b), "not authorised");
        Individual storage A = individuals[a]; Individual storage B = individuals[b];
        require(A.sex != B.sex, "breeding needs one of each sex");
        // the child takes the female parent's base: one base, chosen by a rule, not a blend
        Individual storage dam = A.sex == FEMALE ? A : B;
        bytes32 seed = keccak256(abi.encode(A.deltaHash, B.deltaHash, a, b, blockhash(block.number - 1), totalSupply));

        id = nextId++; totalSupply++;
        individuals[id] = Individual({
            baseModelId: dam.baseModelId, deltaHash: bytes32(0), modelId: bytes32(0), mepId: bytes32(0),
            sex: uint8(uint256(seed) & 1), generation: (A.generation > B.generation ? A.generation : B.generation) + 1,
            parentA: uint64(a), parentB: uint64(b), seed: seed
        });
        _balanceOf[msg.sender]++; _ownerOf[id] = msg.sender;
        emit Transfer(address(0), msg.sender, id); emit Bred(id, a, b, seed);
        (bool ok,) = TREASURY.call{value: msg.value}(""); require(ok, "treasury");
    }

    /// @notice Claim this individual's delta (for a bred token) and register its MEP. Permissionless in spirit but
    ///         restricted to the owner, so nobody can bind someone else's individual to a dead MEP. Registration
    ///         is a separate act from minting because computing `model_id` means applying the delta to a 28 MB
    ///         base and hashing the result, which no contract can do.
    function register(uint256 id, bytes32 deltaHash, IMEPRegistry.MEP calldata m) external returns (bytes32 mepId) {
        require(msg.sender == ownerOf(id), "not the owner");
        Individual storage ind = individuals[id];
        require(ind.mepId == bytes32(0), "already registered");
        if (ind.deltaHash == bytes32(0)) ind.deltaHash = deltaHash; else require(ind.deltaHash == deltaHash, "delta");
        mepId = MEPS.registerMEP(m);
        ind.modelId = m.modelId; ind.mepId = mepId;
        emit Registered(id, mepId, m.modelId);
    }

    function _may(uint256 id) internal view returns (bool) {
        address o = ownerOf(id);
        return msg.sender == o || isApprovedForAll[o][msg.sender] || msg.sender == getApproved[id];
    }
    function _verify(bytes32[] calldata proof, bytes32 root, bytes32 leaf) internal pure returns (bool) {
        bytes32 h = leaf;
        for (uint256 i = 0; i < proof.length; i++) h = h < proof[i] ? keccak256(abi.encodePacked(h, proof[i])) : keccak256(abi.encodePacked(proof[i], h));
        return h == root;
    }
}

interface IERC721Receiver { function onERC721Received(address, address, uint256, bytes calldata) external returns (bytes4); }

/// @notice The sponsored-bonding call the mint needs. `InstanceRegistry.bond()` bonds `msg.sender`, so a contract
///         cannot bond for a user; this is the upstream addition docs/TOKENOMICS.md asks for.
interface IInstanceBonding { function bondFor(address instance, bytes32[] calldata mepIds) external payable; }
