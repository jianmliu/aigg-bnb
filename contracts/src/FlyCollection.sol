// SPDX-License-Identifier: 0BSD
pragma solidity ^0.8.20;

import "aigg-porw/interfaces/PorwMesh.sol";
import "./LineageRegistry.sol";
import "./TokenTransfer.sol";

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
interface IBaseMEPs {
    function registerDerivedMEP(IMEPRegistry.MEP calldata m,bytes32 base) external returns(bytes32);
    function registerDerivedMEPWithTerms(IMEPRegistry.MEP calldata m,bytes32 base,address beneficiary,uint16 bps) external returns(bytes32);
    function baseOf(bytes32 id) external view returns(bytes32);
}
contract FlyCollection {
    // ---- the two bases ----
    uint8 public constant FEMALE = 0;
    uint8 public constant MALE = 1;
    uint8 public constant UNHATCHED = 2; // a bred individual nobody has hatched yet: its seed, and so its sex, does not exist
    bool public immutable BASE_ENROLMENT;
    bytes32 public immutable BASE_FEMALE; // model_id of the female base payload
    bytes32 public immutable BASE_MALE;   // model_id of the male base payload
    bytes32 public immutable BASE_MEP_FEMALE; // the bases' MEPs: what a minter is enrolled for, because it is what they can host on day one
    bytes32 public immutable BASE_MEP_MALE;   // (zero: bond without enrolling)

    // ---- economics, all immutable: no owner may move them after deployment ----
    uint256 public immutable MINT_PRICE;
    uint256 public immutable MINT_BOND;   // the part of MINT_PRICE that becomes the minter's bond
    uint256 public immutable BREED_FEE;
    uint256 public immutable HATCH_BOUNTY; // the part of BREED_FEE held for whoever hatches the child
    address public immutable TREASURY;    // where the non-bond remainder goes; fixed at deployment
    bytes32 public immutable GENESIS_ROOT;
    uint32 public immutable GENESIS_SIZE;

    IMEPRegistry public immutable MEPS;
    IInstanceBonding public immutable INSTANCES;
    /// @notice where a derived brain's model_id is declared, challenged and finalized. address(0): the legacy, self-punishing `register`.
    LineageRegistry public immutable LINEAGE;
    /// @notice The owner's royalty, in basis points of every fee settled for a task against an individual's brain; 0 = none.
    ///         It exists only once a fly is adopted AND registered: the base brains, which nobody adopts, are plain
    ///         royalty-free profiles, and an individual has no MEP at all until its owner registers one. From then on
    ///         its MEP carries terms (aigg-porw `registerMEPWithTerms`) whose beneficiary is THIS CONTRACT, which pays
    ///         whoever owns the token. That is why a sale needs no "update the address" step: the address on-chain
    ///         never was the owner's. The terms are inside the mep_id, so this rate is fixed for the collection's life.
    uint16 public immutable ROYALTY_BPS;
    /// @notice where the royalties are set aside (`TaskMarket.royalties`) and collected from (`withdrawRoyalty`)
    IRoyaltyMarket public immutable MARKET;
    /// @notice The BASE's share of that royalty, in basis points OF THE ROYALTY (not of the fee), and who collects it. A fly
    ///         is an edit of a released brain; whoever released the brain takes a fixed part of what its descendants earn.
    ///         ONE level, fixed here: it does not compound down a pedigree, so a bred fly is worth what a founder is. At
    ///         ROYALTY_BPS 1000 and BASE_SHARE_BPS 1000, of a fee of 1 the hosts share 0.90, the owner gets 0.09, the base 0.01.
    uint16 public immutable BASE_SHARE_BPS;
    address public immutable BASE_VENDOR;
    /// @notice ERC-2981: what a marketplace is ASKED to pay on a resale, to the treasury. A request and nothing more -- no
    ///         marketplace is bound by it and a plain transfer pays nothing -- which is why it is kept apart from the
    ///         royalty above, the one the protocol enforces. Capped at 10%, the most any venue honours.
    uint16 public immutable SALE_ROYALTY_BPS;
    /// @notice royalties already moved here and credited to an address, not yet withdrawn by it
    mapping(address => uint256) public owed;
    /// @notice one MEP pays one fly. Without this a second token registered to the same MEP could collect on it.
    mapping(bytes32 => uint256) public tokenOfMep;

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
        uint64 seedBlock;    // the block whose hash makes (made) the seed; 0 for genesis
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
    mapping(uint256 => address) internal _approved;
    mapping(address => mapping(address => bool)) public isApprovedForAll;

    event Transfer(address indexed from, address indexed to, uint256 indexed id);
    event Approval(address indexed owner, address indexed spender, uint256 indexed id);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);
    event Minted(uint256 indexed id, address indexed to, uint8 sex, bytes32 deltaHash, uint32 genesisIndex);
    event Bred(uint256 indexed id, uint256 indexed parentA, uint256 indexed parentB, uint64 seedBlock);
    event Rearmed(uint256 indexed id, uint64 seedBlock);
    event Hatched(uint256 indexed id, bytes32 seed, uint8 sex);
    event Registered(uint256 indexed id, bytes32 indexed mepId, bytes32 modelId);
    /// the owner's location hint, when the MEP was already in the registry under somebody else's (see _bindMEP)
    event WeightsHint(uint256 indexed id, bytes32 indexed mepId, bytes weightsDA);
    event RoyaltySettled(uint256 indexed id, address indexed owner, uint256 amount);
    event BaseShareSettled(uint256 indexed id, address indexed vendor, uint256 amount);
    event TreasuryCredited(uint256 amount);      // the treasury refused a payment: it is in `owed`, and the fly was not held up
    event RoyaltySettleFailed(uint256 indexed id); // the market refused: the transfer went through, the royalty is still there to settle
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event OwnerProposed(address indexed proposed);
    event RendererSet(address indexed renderer);
    // ERC-4906: a fly's metadata changes while it lives -- an egg hatches, a brain is registered, the renderer is replaced -- and a
    // marketplace that cached "egg" shows an egg for ever unless it is told. These are the telling.
    event MetadataUpdate(uint256 _tokenId);
    event BatchMetadataUpdate(uint256 _fromTokenId, uint256 _toTokenId);

    // ---- the owner: what a marketplace calls `owner()`, and the one thing it can do ----
    // Marketplaces let whoever `owner()` names edit the collection's page and set where a resale royalty is paid, so there
    // has to be one. Here it has exactly ONE power: choosing the contract that draws a token (`tokenURI`). Not the genesis
    // set, not a price, not a rate, not the treasury, not anybody's fly or money: those are immutable or the holders'.
    // Handed over in two steps, so that it cannot be sent to an address nobody holds; renounced, the renderer is frozen.
    address public owner;
    address public proposedOwner;
    /// @notice draws a token: name, attributes, picture. address(0): `tokenURI` is the empty string.
    ITokenRenderer public renderer;
    modifier onlyOwner() { require(msg.sender == owner, "owner"); _; }
    function setRenderer(ITokenRenderer r) external onlyOwner { renderer = r; emit RendererSet(address(r)); emit BatchMetadataUpdate(0, type(uint256).max); }
    function proposeOwner(address next) external onlyOwner { proposedOwner = next; emit OwnerProposed(next); }
    function acceptOwner() external { require(msg.sender == proposedOwner, "proposed"); emit OwnershipTransferred(owner, msg.sender); owner = msg.sender; proposedOwner = address(0); }
    function renounceOwner() external onlyOwner { emit OwnershipTransferred(owner, address(0)); owner = address(0); proposedOwner = address(0); }

    function ownerOf(uint256 id) public view returns (address o) { o = _ownerOf[id]; require(o != address(0), "no token"); }
    function balanceOf(address a) public view returns (uint256) { require(a != address(0), "zero"); return _balanceOf[a]; }
    function approve(address spender, uint256 id) external { address o = ownerOf(id); require(msg.sender == o || isApprovedForAll[o][msg.sender], "not authorised"); _approved[id] = spender; emit Approval(o, spender, id); }
    function getApproved(uint256 id) external view returns (address) { ownerOf(id); return _approved[id]; } // ERC-721: throws for a token that does not exist
    function setApprovalForAll(address op, bool ok) external { isApprovedForAll[msg.sender][op] = ok; emit ApprovalForAll(msg.sender, op, ok); }
    function transferFrom(address from, address to, uint256 id) public {
        require(from == _ownerOf[id], "wrong from"); require(to != address(0), "zero to");
        require(msg.sender == from || isApprovedForAll[from][msg.sender] || msg.sender == _approved[id], "not authorised");
        // The bond belongs to an address, not to a token: transferring an individual moves the research subject
        // and its fee share, and nothing else. The new owner bonds themselves if they want to run a node.
        // The fee share moves from here on: what the fly earned up to this block is credited to the seller first.
        _settle(id);
        _balanceOf[from]--; _balanceOf[to]++; _ownerOf[id] = to; delete _approved[id];
        emit Transfer(from, to, id);
    }
    function safeTransferFrom(address from, address to, uint256 id) external { safeTransferFrom(from, to, id, ""); }
    function safeTransferFrom(address from, address to, uint256 id, bytes memory data) public {
        transferFrom(from, to, id);
        require(to.code.length == 0 || IERC721Receiver(to).onERC721Received(msg.sender, from, id, data) == IERC721Receiver.onERC721Received.selector, "unsafe recipient");
    }
    /// @notice ERC721Metadata. Drawn by `renderer`, which reads this contract's public state and holds none of its own; a
    ///         renderer that reverts or runs away with the gas takes the picture down, never the token.
    function tokenURI(uint256 id) external view returns (string memory) {
        ownerOf(id); if (address(renderer) == address(0)) return "";
        try renderer.tokenURI{gas: 5_000_000}(address(this), id) returns (string memory uri) { return uri; } catch { return ""; }
    }
    /// @notice ERC-2981. See SALE_ROYALTY_BPS: what is asked for, from whoever chooses to honour it.
    function royaltyInfo(uint256, uint256 salePrice) external view returns (address receiver, uint256 royaltyAmount) { return (TREASURY, salePrice * SALE_ROYALTY_BPS / 10000); }
    // ERC-165, ERC-721, ERC721Metadata (0x5b5e139f = name ^ symbol ^ tokenURI), ERC-2981 (0x2a55205a) and ERC-4906 (0x49064906: events only)
    function supportsInterface(bytes4 i) external pure returns (bool) { return i == 0x01ffc9a7 || i == 0x80ac58cd || i == 0x5b5e139f || i == 0x2a55205a || i == 0x49064906; }

    /// @notice who else is paid, and who `owner()` is -- one argument, because the constructor had sixteen already.
    ///         `baseVendor` / `baseShareBps`: BASE_VENDOR / BASE_SHARE_BPS. `saleRoyaltyBps`: SALE_ROYALTY_BPS. `owner`: may be zero.
    struct Shares { address baseVendor; uint16 baseShareBps; uint16 saleRoyaltyBps; address owner; }
    constructor(
        bytes32 baseFemale, bytes32 baseMale, bytes32 genesisRoot, uint32 genesisSize,
        uint256 mintPrice, uint256 mintBond, uint256 breedFee, uint256 hatchBounty, address treasury,
        IMEPRegistry meps, IInstanceBonding instances, LineageRegistry lineage, bytes32 baseMepFemale, bytes32 baseMepMale,
        IRoyaltyMarket market, uint16 royaltyBps, Shares memory shares
    ) {
        require(mintBond <= mintPrice, "bond > price"); require(hatchBounty <= breedFee, "bounty > fee"); require(treasury != address(0), "treasury");
        BASE_FEMALE = baseFemale; BASE_MALE = baseMale; GENESIS_ROOT = genesisRoot; GENESIS_SIZE = genesisSize;
        MINT_PRICE = mintPrice; MINT_BOND = mintBond; BREED_FEE = breedFee; HATCH_BOUNTY = hatchBounty; TREASURY = treasury;
        MEPS = meps; INSTANCES = instances; LINEAGE = lineage; BASE_MEP_FEMALE = baseMepFemale; BASE_MEP_MALE = baseMepMale;
        (bool baseOk,bytes memory baseData)=address(instances).staticcall(abi.encodeWithSignature("mepRegistry()"));
        address configured=baseOk&&baseData.length==32?abi.decode(baseData,(address)):address(0);
        require(configured==address(0)||configured==address(meps),"base registry mismatch");
        BASE_ENROLMENT=configured!=address(0);
        if(BASE_ENROLMENT){
            require(meps.getMEP(baseMepFemale).modelId==baseFemale && meps.getMEP(baseMepMale).modelId==baseMale,"base models");
            require(IBaseMEPs(address(meps)).baseOf(baseMepFemale)==bytes32(0)&&IBaseMEPs(address(meps)).baseOf(baseMepMale)==bytes32(0),"root bases");
        }
        require(royaltyBps <= 10000 && (royaltyBps == 0 || address(market) != address(0)), "royalty"); // a rate needs somewhere to collect from
        MARKET = market; ROYALTY_BPS = royaltyBps;
        require(shares.baseShareBps <= 10000 && (shares.baseShareBps == 0 || shares.baseVendor != address(0)), "base share"); // a share needs somebody to pay
        require(shares.saleRoyaltyBps <= 1000, "sale royalty");
        BASE_SHARE_BPS = shares.baseShareBps; BASE_VENDOR = shares.baseVendor; SALE_ROYALTY_BPS = shares.saleRoyaltyBps;
        owner = shares.owner; emit OwnershipTransferred(address(0), shares.owner);
    }

    /// @notice Mint a genesis individual. The whole genesis set is committed at deployment as a Merkle root over
    ///         `keccak256(index ‖ sex ‖ deltaHash)`, so which individuals exist is fixed before anyone mints and
    ///         no owner can add to it afterwards. The delta bytes themselves are published off-chain and are
    ///         content-addressed by `deltaHash`.
    /// @dev    One action, one price: MINT_BOND of it becomes the minter's own stake, bonded through
    ///         `InstanceRegistry.bondFor` and enrolled for the BASE brain's MEP -- the brain they can host on day one -- so
    ///         the minter leaves this call owning an individual AND being a bonded instance. `bondFor` lets a payer only add
    ///         to a bond; the stake is the minter's from here on, and exit is theirs alone. Enrolling somebody else takes at
    ///         least one UNIT upstream, so MINT_BOND is either 0 (no bonding) or >= UNIT. Joining their own individual's
    ///         MEP is a later top-up once it is registered.
    function mint(uint32 genesisIndex, uint8 sex, bytes32 deltaHash, bytes32[] calldata proof) external payable returns (uint256 id) {
        _authorizeGenesisMint();
        require(msg.value == MINT_PRICE, "price");
        require(genesisIndex < GENESIS_SIZE && !genesisMinted[genesisIndex], "index");
        require(sex == FEMALE || sex == MALE, "sex");
        require(_verify(proof, GENESIS_ROOT, keccak256(abi.encode(genesisIndex, sex, deltaHash))), "not in the genesis set");
        genesisMinted[genesisIndex] = true;

        id = nextId++; totalSupply++;
        individuals[id] = Individual({
            baseModelId: sex == FEMALE ? BASE_FEMALE : BASE_MALE, deltaHash: deltaHash,
            modelId: bytes32(0), mepId: bytes32(0), sex: sex, generation: 0, parentA: 0, parentB: 0, seed: bytes32(0), seedBlock: 0
        });
        _balanceOf[msg.sender]++; _ownerOf[id] = msg.sender;
        emit Transfer(address(0), msg.sender, id); emit Minted(id, msg.sender, sex, deltaHash, genesisIndex);

        if (MINT_BOND > 0) {
            bytes32 baseMep = sex == FEMALE ? BASE_MEP_FEMALE : BASE_MEP_MALE; bytes32[] memory ids = new bytes32[](baseMep == bytes32(0) ? 0 : 1); if (baseMep != bytes32(0)) ids[0] = baseMep;
            INSTANCES.bondFor{value: MINT_BOND}(msg.sender, ids);
        }
        _toTreasury(MINT_PRICE - MINT_BOND);
    }

    /// @dev Legacy collections permit public genesis mint; inventory collections override this guard.
    function _authorizeGenesisMint() internal view virtual {}

    /// @notice Breed one female and one male individual. Both must be held (or approved) by the caller.
    /// @dev    The child is a variant of ONE base — a delta's ops are indices into one base's root-id table, and
    ///         the two bases index unrelated animals, so a merged edit list across bases is noise, not a hybrid.
    ///         What is recorded here is the RECIPE, not the result: the parents, and the block whose hash will
    ///         seed the child. The seed itself does not exist yet, and that is the point. Anything a single
    ///         transaction can read -- a past blockhash, the supply -- the caller can read first, so a seed made
    ///         here could be simulated and the transaction sent only when the answer (the sex, for one) suited.
    ///         The hash of the NEXT block is a value the caller does not hold while deciding to send this, and it
    ///         exists a block later: `hatch` turns it into the seed, seconds after breeding rather than an epoch. The child's delta is then derived off-chain by the published
    ///         deterministic function of (parent deltas, seed), and claimed with `register`. A wrong claim produces a `model_id` nobody can reproduce, so the MEP is simply
    ///         dead — self-punishing rather than trustless.
    ///         OPEN: which derivation. docs/TOKENOMICS.md §4 (a) pairing-as-entropy — implementable now — or (b)
    ///         pairing-as-projection through a cross-sex cell-type map, which needs external data this project
    ///         does not have. Putting the parents' delta bytes on-chain (SSTORE2, ~940k gas for 4.7 KB) would let
    ///         a later version derive the child here and make breeding trustless instead of self-punishing.
    function breed(uint256 a, uint256 b) external payable returns (uint256 id) {
        require(msg.value == BREED_FEE, "fee");
        require(_may(a) && _may(b), "not authorised");
        Individual storage A = individuals[a]; Individual storage B = individuals[b];
        // A child's recipe names its parents' deltas, so both must be pinned: an unborn parent (bred, not yet
        // registered) would put a zero in the seed and leave its owner free to pick the delta after seeing it.
        // Before the sex test, because an egg's sex is UNHATCHED, which "differs" from either sex.
        require(A.deltaHash != bytes32(0) && B.deltaHash != bytes32(0), "parents must have their deltas claimed");
        require(A.sex != B.sex, "breeding needs one of each sex");
        // the child takes the female parent's base: one base, chosen by a rule, not a blend
        Individual storage dam = A.sex == FEMALE ? A : B;
        uint64 seedBlock = uint64(block.number) + 1;

        id = nextId++; totalSupply++;
        individuals[id] = Individual({
            baseModelId: dam.baseModelId, deltaHash: bytes32(0), modelId: bytes32(0), mepId: bytes32(0),
            sex: UNHATCHED, generation: (A.generation > B.generation ? A.generation : B.generation) + 1,
            parentA: uint64(a), parentB: uint64(b), seed: bytes32(0), seedBlock: seedBlock
        });
        _balanceOf[msg.sender]++; _ownerOf[id] = msg.sender;
        emit Transfer(address(0), msg.sender, id); emit Bred(id, a, b, seedBlock);
        _toTreasury(BREED_FEE - HATCH_BOUNTY); // the bounty stays here until hatch
    }

    /// @notice Give a bred individual its seed, and with it its sex, from the hash of its seed block. Anyone may
    ///         call this -- every input is on-chain and the caller supplies none -- and whoever does is paid
    ///         HATCH_BOUNTY.
    /// @dev    The EVM keeps 256 block hashes, so a seed block can expire, and an expiry is the one lever a
    ///         grinder has: read the hash off-chain, dislike it, and wait it out. Two things take the lever away.
    ///         The bounty makes hatching a race from the first block it is possible, which the grinder has to
    ///         win against everyone for 256 blocks running; and `rearm` costs a whole BREED_FEE, so each redraw is
    ///         priced like the breeding it replaces. Threat model: the breeder, not the chain. A block producer
    ///         colluding with a breeder over one individual's seed is out of scope (docs/TOKENOMICS.md §4).
    function hatch(uint256 id) external returns (bytes32 seed) {
        Individual storage ind = individuals[id];
        require(ind.seedBlock != 0 && ind.seed == bytes32(0), "nothing to hatch");
        require(block.number > ind.seedBlock, "block pending");
        bytes32 h = blockhash(ind.seedBlock); require(h != bytes32(0), "expired");
        seed = keccak256(abi.encode(individuals[ind.parentA].deltaHash, individuals[ind.parentB].deltaHash, uint256(ind.parentA), uint256(ind.parentB), id, h));
        ind.seed = seed; ind.sex = uint8(uint256(seed) & 1);
        emit Hatched(id, seed, ind.sex); emit MetadataUpdate(id);
        if (HATCH_BOUNTY > 0) { (bool ok,) = msg.sender.call{value: HATCH_BOUNTY}(""); require(ok, "bounty"); } // after the state change: a re-entrant hatch finds nothing to hatch
    }

    /// @notice Point an egg whose seed block expired unhatched at the next block. Costs BREED_FEE, all of it to the
    ///         treasury (the bounty paid at breeding is still held): a new block is a new draw.
    function rearm(uint256 id) external payable {
        require(msg.value == BREED_FEE, "fee");
        Individual storage ind = individuals[id];
        require(ind.seedBlock != 0 && ind.seed == bytes32(0), "nothing to hatch");
        require(block.number > uint256(ind.seedBlock) + 256, "not expired");
        ind.seedBlock = uint64(block.number) + 1; emit Rearmed(id, ind.seedBlock);
        _toTreasury(msg.value);
    }

    /// @notice Claim this individual's delta (for a bred token) and register its MEP. Permissionless in spirit but
    ///         restricted to the owner, so nobody can bind someone else's individual to a dead MEP. Registration
    ///         is a separate act from minting because computing `model_id` means applying the delta to a 28 MB
    ///         base and hashing the result, which no contract can do.
    function register(uint256 id, bytes32 deltaHash, IMEPRegistry.MEP calldata m) external returns (bytes32 mepId) {
        require(address(LINEAGE) == address(0), "use registerDerived");
        require(msg.sender == ownerOf(id), "not the owner");
        Individual storage ind = individuals[id];
        require(ind.mepId == bytes32(0), "already registered");
        require(ind.seedBlock == 0 || ind.seed != bytes32(0), "not hatched"); // the delta is a function of the seed
        if (ind.deltaHash == bytes32(0)) ind.deltaHash = deltaHash; else require(ind.deltaHash == deltaHash, "delta");
        mepId = _bindMEP(id, m);
        ind.modelId = m.modelId; ind.mepId = mepId;
        emit Registered(id, mepId, m.modelId); emit MetadataUpdate(id);
    }

    /// @dev The MEP this profile IS, registered here if nobody has yet. `MEPRegistry.registerMEP` is permissionless and
    ///      reverts on an id that exists, and an individual's profile is no secret (its delta is on-chain), so calling it
    ///      unconditionally let anybody who registered the same profile first leave the token unable to bind, for good.
    ///      An id that exists is the same MEP -- every field a verdict depends on is inside it -- so there is nothing to
    ///      check and nothing to lose by binding to it. The one field outside the id is `weightsDA`, a location hint: the
    ///      registry then carries whatever the first registrant wrote, so the owner's is put on record here. Bytes fetched
    ///      through a wrong hint fail the `model_id` check before they load; the hint can waste a fetch, not corrupt one.
    function _bindMEP(uint256 id, IMEPRegistry.MEP calldata m) internal returns (bytes32 mepId) {
        require(m.schemeDigest == SCHEME_SKETCH_TILE_KECCAK_V3, "scheme");
        mepId = PorwMeshHash.mepId(m.schemeDigest, m.modelId, m.execKind, m.neurons, m.synapses, m.synapseRoot);
        bytes32 base;
        if(BASE_ENROLMENT){
            base=individuals[id].baseModelId==BASE_FEMALE?BASE_MEP_FEMALE:BASE_MEP_MALE;
            mepId=PorwMeshHash.mepIdWithBase(mepId,base);
        }
        // Under a royalty the individual IS the profile under this collection's terms -- another id, because the terms
        // are inside it. The registry is permissionless, so anybody may register the same bytes without terms; that MEP
        // is simply not this fly and not LISTED (below): the page does not show it, the relayer does not aggregate or
        // sponsor for it, the dataset does not count it. The royalty does not have to be priced against it.
        if (ROYALTY_BPS > 0) mepId = PorwMeshHash.mepIdWithTerms(mepId, address(this), ROYALTY_BPS);
        // One MEP pays one fly. Under the lineage registry a token can only reach the MEP of its own delta, so this
        // never fires for an honest one; under the legacy `register` it is what stops a second token from naming a
        // brain that is already somebody's and collecting on it.
        require(tokenOfMep[mepId] == 0, "mep taken"); tokenOfMep[mepId] = id;
        if (IMEPExists(address(MEPS)).exists(mepId)) emit WeightsHint(id, mepId, m.weightsDA);
        else if(BASE_ENROLMENT) require((ROYALTY_BPS>0?IBaseMEPs(address(MEPS)).registerDerivedMEPWithTerms(m,base,address(this),ROYALTY_BPS):IBaseMEPs(address(MEPS)).registerDerivedMEP(m,base))==mepId,"mep id");
        else require((ROYALTY_BPS > 0 ? IMEPTerms(address(MEPS)).registerMEPWithTerms(m, address(this), ROYALTY_BPS) : MEPS.registerMEP(m)) == mepId, "mep id");
    }

    // ---- the whitelist ----
    /// @notice Is this MEP one of the system's? The two base brains, and every brain bound to a token of this
    ///         collection -- adopted or bred, it makes no difference: a bred fly is a token like any other, so it is
    ///         listed the moment its owner registers it, with nobody's approval. What somebody registers on the MEP
    ///         registry by themselves is not: the registry is permissionless and has to be, but being in it confers
    ///         nothing here. This is the one question the page, the relayer and the dataset ask before they list,
    ///         serve or count a brain, and it is answered on-chain so that they cannot disagree.
    function listed(bytes32 mepId) external view returns (bool) {
        return mepId != bytes32(0) && (mepId == BASE_MEP_FEMALE || mepId == BASE_MEP_MALE || tokenOfMep[mepId] != 0);
    }

    // Token royalties are credited at task settlement, before NFT ownership can change.
    mapping(address=>mapping(address=>uint256)) public tokenOwed;
    mapping(address=>uint256) public tokenLiability;
    event TokenRoyaltyCredited(bytes32 indexed mepId,address indexed token,address indexed holder,uint256 amount);
    function supportsTokenRoyalties() external pure returns(bool){return true;}
    function onTokenRoyalty(bytes32 mepId,address token,uint256 amount) external {
        require(msg.sender==address(MARKET)&&token!=address(0),"market/token");
        uint256 id=tokenOfMep[mepId];address holder=ownerOf(id);
        require(amount>0&&IERC20Budget(token).balanceOf(address(this))>=tokenLiability[token]+amount,"unfunded royalty");
        tokenLiability[token]+=amount;uint256 base=amount*BASE_SHARE_BPS/10000;
        if(base>0)tokenOwed[token][BASE_VENDOR]+=base;
        tokenOwed[token][holder]+=amount-base;
        emit TokenRoyaltyCredited(mepId,token,holder,amount-base);
    }
    function withdrawToken(address token) external returns(uint256 amount){
        amount=tokenOwed[token][msg.sender];require(amount>0,"nothing owed");
        tokenOwed[token][msg.sender]=0;tokenLiability[token]-=amount;
        TokenTransfer.send(token,msg.sender,amount);
    }

    // ---- the royalty: set aside by TaskMarket under the MEP's terms, forwarded here to whoever owns the fly ----
    /// @notice Move what an individual's tasks have set aside into its CURRENT owner's credit. Anyone may call it --
    ///         the money goes to the owner whoever asks -- and a transfer calls it first, so a sale splits the royalty
    ///         at the block of the sale. Credited, not sent: an owner that refuses ether must not be able to block a
    ///         transfer, or anybody else's settle. `withdraw` is the owner's own call.
    function settle(uint256 id) external returns (uint256 amount) { ownerOf(id); return _settle(id); }
    /// @dev Every transfer passes through here, so nothing here may revert: a fly must stay transferable whatever the market
    ///      does. If the market refuses, the royalty stays where it is -- still this fly's, settled by the next call that works.
    function _settle(uint256 id) internal returns (uint256 amount) {
        bytes32 mepId = individuals[id].mepId; if (ROYALTY_BPS == 0 || mepId == bytes32(0)) return 0;
        try MARKET.royalties(mepId) returns (uint256 pending) { if (pending == 0) return 0; } catch { emit RoyaltySettleFailed(id); return 0; } // withdrawRoyalty reverts on nothing
        try MARKET.withdrawRoyalty(mepId) returns (uint256 got) { amount = got; } catch { emit RoyaltySettleFailed(id); return 0; }
        // the base's share comes off the top, once; the rest is the owner's. Both are credited, neither is sent.
        uint256 base = amount * BASE_SHARE_BPS / 10000; address o = _ownerOf[id];
        if (base > 0) { owed[BASE_VENDOR] += base; emit BaseShareSettled(id, BASE_VENDOR, base); }
        owed[o] += amount - base; emit RoyaltySettled(id, o, amount - base);
    }
    /// @dev Pay the treasury -- and if it will not take the money, credit it instead (`owed`, collected with `withdraw` like
    ///      anybody's). The treasury is fixed for the collection's life and may well be a contract that does something with
    ///      what it receives (a splitter, a buyback); whatever that something is, its failing must never stop somebody's
    ///      adoption or a birth. Gas is capped for the same reason: a treasury cannot make an adoption arbitrarily dear.
    function _toTreasury(uint256 amount) internal {
        if (amount == 0) return; (bool ok,) = TREASURY.call{value: amount, gas: 500_000}("");
        if (!ok) { owed[TREASURY] += amount; emit TreasuryCredited(amount); }
    }
    /// @notice collect everything credited to the caller
    function withdraw() external returns (uint256 amount) {
        amount = owed[msg.sender]; require(amount > 0, "nothing owed"); owed[msg.sender] = 0;
        (bool ok,) = msg.sender.call{value: amount}(""); require(ok, "withdraw");
    }
    /// @dev only the market pays this contract (a royalty arriving from `withdrawRoyalty`); stray ether would be nobody's
    receive() external payable { require(msg.sender == address(MARKET), "not the market"); }

    /// @notice Register an individual through the lineage registry: the delta is an in-place FLYDELTAv3 cross whose
    ///         `model_id` was declared there, survived its challenge window and is final — so the MEP bound here is the
    ///         one the recipe really produces, not merely the one its owner says it does. For a bred token the recipe is
    ///         not the owner's to choose: it must name the parents this contract recorded and carry the seed drawn at
    ///         breeding (docs/TOKENOMICS.md §4 (c)):
    ///         - parents on the same base: a true cross, `parentA` / `parentB` = the two parents' deltas;
    ///         - parents on different bases (one of each sex): the child sits on the dam's base, inherits from the dam
    ///           crossed with the published base, and the sire contributes entropy — its delta is inside the seed.
    function registerDerived(uint256 id, bytes calldata delta, IMEPRegistry.MEP calldata m) external returns (bytes32 mepId) {
        require(address(LINEAGE) != address(0), "no lineage registry"); require(msg.sender == ownerOf(id), "not the owner");
        Individual storage ind = individuals[id]; require(ind.mepId == bytes32(0), "already registered");
        require(ind.seedBlock == 0 || ind.seed != bytes32(0), "not hatched"); // the recipe carries the seed: an egg has none yet
        bytes32 deltaHash = keccak256(delta);
        if (ind.deltaHash == bytes32(0)) ind.deltaHash = deltaHash; else require(ind.deltaHash == deltaHash, "delta");
        require(LINEAGE.finalModelId(deltaHash) == m.modelId, "model id"); // reverts unless final
        FlyDeltaRecordVerifier.Cross memory x = LINEAGE.VERIFIER().decodeCross(delta); require(x.baseModelId == ind.baseModelId, "base");
        if (ind.generation > 0) {
            Individual storage A = individuals[ind.parentA]; Individual storage B = individuals[ind.parentB];
            require(x.recipe.seed == uint64(uint256(ind.seed)), "seed");
            if (A.baseModelId == B.baseModelId) require(x.parentA == A.deltaHash && x.parentB == B.deltaHash, "parents");
            else { Individual storage dam = A.baseModelId == ind.baseModelId ? A : B; require(x.parentA == dam.deltaHash && x.parentB == bytes32(0), "dam x base"); }
        }
        mepId = _bindMEP(id, m); ind.modelId = m.modelId; ind.mepId = mepId;
        emit Registered(id, mepId, m.modelId); emit MetadataUpdate(id);
    }

    function _may(uint256 id) internal view returns (bool) {
        address o = ownerOf(id);
        return msg.sender == o || isApprovedForAll[o][msg.sender] || msg.sender == _approved[id];
    }
    function _verify(bytes32[] calldata proof, bytes32 root, bytes32 leaf) internal pure returns (bool) {
        bytes32 h = leaf;
        for (uint256 i = 0; i < proof.length; i++) h = h < proof[i] ? keccak256(abi.encodePacked(h, proof[i])) : keccak256(abi.encodePacked(proof[i], h));
        return h == root;
    }
}

/// draws a token of `collection`: a data: or https: URI of its ERC721Metadata JSON. It reads the collection's public state.
interface ITokenRenderer { function tokenURI(address collection, uint256 id) external view returns (string memory); }
interface IERC721Receiver { function onERC721Received(address, address, uint256, bytes calldata) external returns (bytes4); }

/// @notice The sponsored-bonding call of aigg-porw's `InstanceRegistry`: a payer adds to someone else's bond (and only adds).
interface IMEPExists { function exists(bytes32 mepId) external view returns (bool); }
/// @notice aigg-porw MEPRegistry: the same profile under terms (a beneficiary and its share of every settled fee)
interface IMEPTerms { function registerMEPWithTerms(IMEPRegistry.MEP calldata m, address beneficiary, uint16 royaltyBps) external returns (bytes32 mepId); }
/// @notice the royalty side of aigg-porw's TaskMarket: what is set aside per MEP, and the beneficiary's withdrawal
interface IRoyaltyMarket { function royalties(bytes32 mepId) external view returns (uint256); function withdrawRoyalty(bytes32 mepId) external returns (uint256 amt); }
interface IInstanceBonding { function bondFor(address instance, bytes32[] calldata mepIds) external payable; }
