// SPDX-License-Identifier: 0BSD
pragma solidity ^0.8.20;

import "aigg-porw/interfaces/PorwMesh.sol";
import "aigg-porw/PorwVerifierKeccak.sol";
import "aigg-porw/mesh/InstanceRegistry.sol";
import "./SynchronousTaskMarket.sol";
import "aigg-porw/mesh/LifRowCheck.sol";

/// @notice Bounded synchronous fork of aigg-porw ExecutionDisputes (0BSD).
/// Local fraud proofs establish one liar under an independent honest-executor assumption.
/// Silence is inconclusive and never a fraud proof. Market owns every assignment hold.
contract SynchronousExecutionDisputes is IExecutionDisputes {
    error InvalidProof();
    uint64 public immutable ROUND_BLOCKS;
    uint256 public immutable SLASH_AMOUNT;
    uint32 public constant MAX_IN_DEGREE = SynchronousLimits.MAX_IN_DEGREE;
    uint32 public constant MAX_ROW_CHUNK = SynchronousLimits.MAX_ROW_CHUNK;
    mapping(bytes32 => mapping(address => uint32)) public rowTotal;
    uint32 internal constant CLAMP_Q16 = 65536;
    IMEPRegistry public immutable meps;
    InstanceRegistry public immutable instances;
    SynchronousTaskMarket public immutable market;

    struct Party {
        bytes32 execRoot;
        bytes32[] actRoots;
        bool revealed;
        bytes32 node;
        bytes32[2] pair;
        bool posted;
        bytes32 leaf;
        uint32 act;
        uint64[] sums;
        bool rowPosted;
    }

    struct Dispute {
        bytes32 mepId;
        uint32 neurons;
        uint32 synapses;
        uint32 steps;
        uint32 stimulusSeed;
        bytes32 synapseRoot;
        Phase phase;
        uint32 step;
        bytes32 prevRoot;
        uint32 level;
        uint32 idx;
        uint32 neuron;
        uint64 deadline;
        bool exists;
        address loser;
    }

    struct LifDispute {
        bool lif; // wUnit: the kind's weight unit (MEPRegistry.lifWeightUnit)
        uint32 stride;
        uint32 segments;
        uint32 seg;
        bytes32 initStateRoot;
        uint32 wUnit;
    }

    struct LifParty {
        bytes32[] stepRoots;
        bool refined;
        LifRowCheck.State state;
        int64[] sums;
        bool rowPosted;
    }

    /// a batch dispute, before it becomes one run's dispute: where the run bisection is, and what each party opened
    struct BatchDispute {
        uint32 runs; // the runs root is lifs[taskId].initStateRoot until the run is opened
        uint32 level;
        uint32 idx;
    }
    mapping(bytes32 => BatchDispute) public batches;
    mapping(bytes32 => mapping(address => bool)) internal runOpened;
    mapping(bytes32 => Dispute) public disputes;
    mapping(bytes32 => LifDispute) public lifs;
    mapping(bytes32 => mapping(address => LifParty)) internal lifParties;
    mapping(bytes32 => mapping(address => Party)) internal parties;
    mapping(bytes32 => address) public partyA;
    mapping(bytes32 => address) public partyB;

    constructor(IMEPRegistry m, InstanceRegistry i, SynchronousTaskMarket mk, uint64 roundBlocks, uint256 slashAmount) {
        require(roundBlocks > 0, InvalidProof());
        meps = m;
        instances = i;
        market = mk;
        ROUND_BLOCKS = roundBlocks;
        SLASH_AMOUNT = slashAmount;
    }

    // ---- lifecycle ----
    function openDispute(bytes32 taskId, address a, address b) external {
        require(msg.sender == address(market), InvalidProof());
        require(!disputes[taskId].exists && market.disputeActive(taskId), InvalidProof());
        // steps and the commit stride come from the TASK: both parties executed the same stored Task, and
        // postTask has already bounded them so every round of this dispute is postable.
        (bytes32 mepId, uint32 seed,, uint32 steps, uint32 stride) = market.taskInfo(taskId);
        IMEPRegistry.MEP memory m = meps.getMEP(mepId);
        Dispute storage d = disputes[taskId];
        d.mepId = mepId;
        d.neurons = m.neurons;
        d.synapses = m.synapses;
        d.steps = steps;
        d.stimulusSeed = seed;
        d.synapseRoot = m.synapseRoot;
        d.phase = Phase.Step;
        d.exists = true;
        d.deadline = _nextDeadline(taskId);
        uint32 wu = meps.lifWeightUnit(m.execKind);
        if (wu != 0) {
            LifDispute storage ld = lifs[taskId];
            ld.lif = true;
            ld.wUnit = wu;
            ld.stride = stride;
            ld.segments = (steps + stride - 1) / stride;
            ld.initStateRoot = market.taskInitStateRoot(taskId);
        }
        partyA[taskId] = a;
        partyB[taskId] = b;
        // Holds belong to the market from assignment through terminal settlement.
        // `node` starts at each party's execRoot. Only a batch reads it there -- its execRoot is the root of the run-result
        // tree, which the Run phase bisects -- and for a single task the neuron bisection sets it again before using it.
        {
            (, bytes32 ra) = market.resultOf(taskId, a);
            parties[taskId][a].execRoot = ra;
            parties[taskId][a].node = ra;
        }
        {
            (, bytes32 rb) = market.resultOf(taskId, b);
            parties[taskId][b].execRoot = rb;
            parties[taskId][b].node = rb;
        }
        uint32 runs = market.batchRuns(taskId);
        uint32 top = 0;
        if (runs != 0) {
            top = _levels(runs) - 1; // a batch: first find the run
            batches[taskId] = BatchDispute(runs, top, 0);
            d.phase = Phase.Run;
        }
        emit DisputeRound(taskId, d.phase, top, runs != 0 ? 0 : steps);
    }

    /// @dev a party may act through its delegated session key (the tab's key); state is keyed by the instance.
    ///      The direct branch changes nothing for an instance -- `resolve` already returns a bonded signer
    ///      unchanged -- and it is what lets a CHALLENGER play: it is not an instance, has no bond and no
    ///      session key, so `resolve` would give address(0) and it could not post a single round.
    function _who(bytes32 taskId) internal view returns (address w) {
        if (forwardedHost != address(0) && forwardedTask == taskId) return forwardedHost;
        if (msg.sender == partyA[taskId] || msg.sender == partyB[taskId]) return msg.sender;
        w = instances.resolve(msg.sender);
        require(w != address(0) && (w == partyA[taskId] || w == partyB[taskId]), InvalidProof());
    }

    /// @dev "phase" is what eight entry points say when called out of turn; said once, it is a call instead of a copy.
    ///      This contract is within a few hundred bytes of EIP-170, and the revert data is unchanged.
    function _phase(bool ok) internal pure {
        require(ok, InvalidProof());
    }

    function _party(bytes32 taskId) internal view returns (Party storage) {
        return parties[taskId][_who(taskId)];
    }

    function _other(bytes32 taskId, address who) internal view returns (address) {
        return who == partyA[taskId] ? partyB[taskId] : partyA[taskId];
    }

    // ---- Run phase (batches): the run-result trees are bisected by `postChildren`, the same rounds as the neuron
    //      bisection over another tree (width = runs, position in `batches`); then the run is opened ----
    /// @notice At the leaf: each party opens ITS result for run `idx` (the run's own execRoot, bound to the leaf it was
    ///         bisected to) together with the run's input against the task's runs root. Each party brings the input
    ///         itself -- it executed it -- so neither can stall the other by withholding it. When both have opened,
    ///         the dispute is run idx's: its seed, its state_0 root, the two execRoots, and `Phase.Step` as ever.
    function openRun(
        bytes32 taskId,
        bytes32 runExecRoot,
        uint32 seed,
        bytes32 initStateRoot,
        bytes32[] calldata inputProof
    ) external {
        _live(taskId);
        Dispute storage d = disputes[taskId];
        BatchDispute storage bd = batches[taskId];
        _phase(d.exists && d.phase == Phase.Run && bd.level == 0);
        address me = _who(taskId);
        Party storage p = parties[taskId][me];
        require(!runOpened[taskId][me], InvalidProof());
        bytes memory k = _le32(bd.idx); // the leaves of PorwMeshHash.runResultLeaf / runLeaf, with this contract's own LE32
        require(keccak256(bytes.concat(k, runExecRoot)) == p.node, InvalidProof());
        require(
            _verify(
                lifs[taskId].initStateRoot,
                keccak256(bytes.concat(k, _le32(seed), initStateRoot)),
                bd.idx,
                bd.runs,
                inputProof
            ),
            InvalidProof()
        );
        p.execRoot = runExecRoot;
        runOpened[taskId][me] = true;
        if (!runOpened[taskId][_other(taskId, me)]) return;
        // both opened the same leaf of the same runs root, so they named the same input: the task's state_0 root stops
        // being the root of the runs and becomes the run's
        d.stimulusSeed = seed;
        lifs[taskId].initStateRoot = initStateRoot;
        d.phase = Phase.Step;
        d.deadline = _nextDeadline(taskId);
        emit DisputeRound(taskId, Phase.Step, bd.idx, d.steps);
    }

    // ---- Step phase ----
    function revealRoots(bytes32 taskId, bytes32[] calldata actRoots) external {
        _live(taskId);
        Dispute storage d = disputes[taskId];
        _phase(d.exists && d.phase == Phase.Step);
        Party storage p = _party(taskId);
        require(!p.revealed, InvalidProof());
        LifDispute storage ld = lifs[taskId];
        uint32 count = ld.lif ? ld.segments : d.steps;
        require(actRoots.length == count && _rootOf(actRoots) == p.execRoot, InvalidProof());
        p.actRoots = actRoots;
        p.revealed = true;
        Party storage q = parties[taskId][_other(taskId, _who(taskId))];
        if (!q.revealed) return;
        uint32 s = 0;
        while (s < count && p.actRoots[s] == q.actRoots[s]) s++;
        require(s < count, InvalidProof()); // identical roots cannot yield different execRoots
        if (ld.lif) {
            // first differing SEGMENT: refine to steps first
            ld.seg = s;
            d.prevRoot = s == 0 ? ld.initStateRoot : p.actRoots[s - 1];
            d.phase = Phase.Refine;
            d.deadline = _nextDeadline(taskId);
            emit DisputeRound(taskId, Phase.Refine, s, 0);
            return;
        }
        d.step = s + 1;
        d.prevRoot = s == 0 ? bytes32(0) : p.actRoots[s - 1];
        _startNeuron(taskId, d, p, q, p.actRoots[s], q.actRoots[s]);
    }

    function _startNeuron(
        bytes32 taskId,
        Dispute storage d,
        Party storage p,
        Party storage q,
        bytes32 nodeP,
        bytes32 nodeQ
    ) internal {
        p.node = nodeP;
        q.node = nodeQ;
        d.level = _levels(d.neurons) - 1;
        d.idx = 0;
        d.phase = Phase.Neuron;
        d.deadline = _nextDeadline(taskId);
        if (d.level == 0) {
            d.phase = Phase.Synapse;
            d.neuron = 0;
            p.leaf = p.node;
            q.leaf = q.node;
        }
        emit DisputeRound(taskId, d.phase, d.level, 0);
    }

    // ---- Refine phase (int-lif): per-step roots inside the first differing segment ----
    function postStepRoots(bytes32 taskId, bytes32[] calldata roots) external {
        _live(taskId);
        Dispute storage d = disputes[taskId];
        LifDispute storage ld = lifs[taskId];
        _phase(d.exists && d.phase == Phase.Refine);
        address me = _who(taskId);
        Party storage p = parties[taskId][me];
        LifParty storage lp = lifParties[taskId][me];
        require(!lp.refined, InvalidProof());
        uint32 s0 = ld.seg * ld.stride;
        uint32 len = d.steps - s0 < ld.stride ? d.steps - s0 : ld.stride;
        require(roots.length == len && roots[len - 1] == p.actRoots[ld.seg], InvalidProof()); // must end at the committed segment root
        lp.stepRoots = roots;
        lp.refined = true;
        address o = _other(taskId, me);
        LifParty storage lq = lifParties[taskId][o];
        if (!lq.refined) return;
        uint32 j = 0;
        while (j < len && lp.stepRoots[j] == lq.stepRoots[j]) j++;
        require(j < len, InvalidProof()); // the chains end at different segment roots, so they differ somewhere
        d.step = s0 + j + 1; // else: the agreed previous segment root already in d.prevRoot
        if (j > 0) d.prevRoot = lp.stepRoots[j - 1];
        _startNeuron(taskId, d, p, parties[taskId][o], lp.stepRoots[j], lq.stepRoots[j]);
    }

    // ---- Neuron phase, and a batch's Run phase: each party posts the children of its current node ----
    function postChildren(bytes32 taskId, bytes32 left, bytes32 right) external {
        _live(taskId);
        Dispute storage d = disputes[taskId];
        BatchDispute storage bd = batches[taskId];
        bool run = d.phase == Phase.Run;
        uint32 level = run ? bd.level : d.level;
        uint32 idx = run ? bd.idx : d.idx;
        _phase(d.exists && (run || d.phase == Phase.Neuron) && level > 0);
        Party storage p = _party(taskId);
        require(!p.posted, InvalidProof());
        if (2 * idx + 1 >= _width(run ? bd.runs : d.neurons, level - 1)) require(right == left, InvalidProof()); // duplicate-last
        require(keccak256(bytes.concat(left, right)) == p.node, InvalidProof());
        p.pair = [left, right];
        p.posted = true;
        Party storage q = parties[taskId][_other(taskId, _who(taskId))];
        if (!q.posted) return;
        bool goLeft = p.pair[0] != q.pair[0];
        require(goLeft || p.pair[1] != q.pair[1], InvalidProof());
        uint32 child = goLeft ? 2 * idx : 2 * idx + 1;
        p.node = goLeft ? p.pair[0] : p.pair[1];
        q.node = goLeft ? q.pair[0] : q.pair[1];
        p.posted = false;
        q.posted = false;
        d.deadline = _nextDeadline(taskId);
        if (run) {
            bd.idx = child; // at level 0 the parties open the run (openRun)
            bd.level = level - 1;
        } else {
            d.idx = child;
            d.level = level - 1;
            if (level == 1) {
                d.neuron = child;
                p.leaf = p.node;
                q.leaf = q.node;
                d.phase = Phase.Synapse;
            }
        }
        emit DisputeRound(taskId, d.phase, level - 1, child);
    }

    // Rows are uploaded in fixed-size chunks so each sponsored move fits the chain transaction gas cap.
    function postRow(bytes32 taskId, uint32 claimedAct, uint64[] calldata sums) external {
        postRowChunk(taskId, 0, uint32(sums.length), claimedAct, sums);
    }

    function postRowChunk(bytes32 taskId, uint32 offset, uint32 total, uint32 claimedAct, uint64[] calldata sums)
        public
    {
        _live(taskId);
        Dispute storage d = disputes[taskId];
        _phase(d.phase == Phase.Synapse && !lifs[taskId].lif);
        address me = _who(taskId);
        Party storage p = parties[taskId][me];
        require(!p.rowPosted, InvalidProof());
        require(keccak256(bytes.concat(_le32(d.neuron), _le32(claimedAct))) == p.leaf, InvalidProof());
        _rowChunk(taskId, me, offset, total, p.sums.length, sums.length);
        p.act = claimedAct;
        for (uint256 j; j < sums.length; j++) {
            p.sums.push(sums[j]);
        }
        p.rowPosted = p.sums.length == total;
        d.deadline = _nextDeadline(taskId);
    }

    function postRowLif(
        bytes32 taskId,
        int32 v,
        int32 g,
        uint16 refr,
        uint16 flags,
        uint32 count,
        int64[] calldata sums
    ) external {
        postRowLifChunk(taskId, 0, uint32(sums.length), v, g, refr, flags, count, sums);
    }

    function postRowLifChunk(
        bytes32 taskId,
        uint32 offset,
        uint32 total,
        int32 v,
        int32 g,
        uint16 refr,
        uint16 flags,
        uint32 count,
        int64[] calldata sums
    ) public {
        _live(taskId);
        Dispute storage d = disputes[taskId];
        _phase(d.phase == Phase.Synapse && lifs[taskId].lif);
        address me = _who(taskId);
        LifParty storage lp = lifParties[taskId][me];
        require(!lp.rowPosted, InvalidProof());
        LifRowCheck.State memory st = LifRowCheck.State(v, g, refr, flags, count);
        require(LifRowCheck.stateLeaf(d.neuron, st) == parties[taskId][me].leaf, InvalidProof());
        _rowChunk(taskId, me, offset, total, lp.sums.length, sums.length);
        lp.state = st;
        for (uint256 j; j < sums.length; j++) {
            lp.sums.push(sums[j]);
        }
        lp.rowPosted = lp.sums.length == total;
        d.deadline = _nextDeadline(taskId);
    }

    function _rowChunk(bytes32 id, address host, uint32 offset, uint32 total, uint256 have, uint256 length) private {
        require(total <= MAX_IN_DEGREE && offset == have && offset <= total, InvalidProof());
        uint256 remaining = total - offset;
        require(length == (remaining > MAX_ROW_CHUNK ? MAX_ROW_CHUNK : remaining), InvalidProof());
        if (offset == 0) rowTotal[id][host] = total;
        else require(rowTotal[id][host] == total, InvalidProof());
    }

    /// @notice final adjudication (int-lif) once both rows are posted; anyone may call with the openings
    function proveSynapseTermLif(bytes32 taskId, LifTermProof calldata pf) external {
        _live(taskId);
        Dispute storage d = disputes[taskId];
        _phase(d.exists && d.phase == Phase.Synapse && lifs[taskId].lif);
        LifParty storage a = lifParties[taskId][partyA[taskId]];
        LifParty storage b = lifParties[taskId][partyB[taskId]];
        require(a.rowPosted && b.rowPosted, InvalidProof());
        uint32 n = d.neurons;
        uint32 len = _rowLen(d, pf.csrRoot, pf.rowRoot, pf.bounds);
        // the neuron's own previous state, against the agreed previous-step root
        LifRowCheck.State memory prev = _state(pf.self);
        require(_verify(d.prevRoot, LifRowCheck.stateLeaf(d.neuron, prev), d.neuron, n, pf.self.proof), InvalidProof());
        bool lenA = a.sums.length == len;
        bool lenB = b.sums.length == len;
        if (lenA != lenB) return _resolve(taskId, lenA ? partyB[taskId] : partyA[taskId], "row length");
        require(lenA, InvalidProof());
        uint32 unit = lifs[taskId].wUnit;
        bool rowA = _rowOkLif(a, prev, len, d, unit);
        bool rowB = _rowOkLif(b, prev, len, d, unit);
        if (rowA != rowB) return _resolve(taskId, rowA ? partyB[taskId] : partyA[taskId], "row check");
        require(rowA, InvalidProof());
        (uint32 pre, uint16 wu) = _recordAt(d, pf.csrRoot, pf.chunk, pf.kStar, pf.bounds);
        uint32 j = pf.kStar - pf.bounds.start;
        require(a.sums[j] != b.sums[j] && (j == 0 || a.sums[j - 1] == b.sums[j - 1]), InvalidProof());
        // the input neuron's previous state (did it spike at s-1?), against the same agreed root
        LifRowCheck.State memory preState = _state(pf.pre);
        require(_verify(d.prevRoot, LifRowCheck.stateLeaf(pre, preState), pre, n, pf.pre.proof), InvalidProof());
        int64 term = int64(int16(wu)) * LifRowCheck.spiked(preState);
        bool okA = a.sums[j] == (j == 0 ? int64(0) : a.sums[j - 1]) + term;
        bool okB = b.sums[j] == (j == 0 ? int64(0) : b.sums[j - 1]) + term;
        require(okA != okB, InvalidProof());
        _resolve(taskId, okA ? partyB[taskId] : partyA[taskId], "term");
    }

    function _state(StateOpening calldata o) internal pure returns (LifRowCheck.State memory) {
        return LifRowCheck.State(o.v, o.g, o.refr, o.flags, o.count);
    }

    // ---- what the two term proofs share: the row's bounds, and the synapse record at k* ----
    /// @dev csrRoot and rowRoot are the MEP's (synapseRoot), and the disputed neuron's row is [start, end) of it
    function _rowLen(Dispute storage d, bytes32 csrRoot, bytes32 rowRoot, RowBounds calldata bounds)
        internal
        view
        returns (uint32)
    {
        require(keccak256(bytes.concat(csrRoot, rowRoot)) == d.synapseRoot, InvalidProof());
        require(
            _verify(rowRoot, _leaf32(d.neuron, bounds.start), d.neuron, d.neurons + 1, bounds.startProof)
                && _verify(rowRoot, _leaf32(d.neuron + 1, bounds.end), d.neuron + 1, d.neurons + 1, bounds.endProof),
            InvalidProof()
        );
        return bounds.end - bounds.start;
    }

    /// @dev the record at CSR position k* of that row, from the opened chunk: its presynaptic neuron and its weight
    function _recordAt(
        Dispute storage d,
        bytes32 csrRoot,
        ChunkOpening calldata chunk,
        uint32 kStar,
        RowBounds calldata bounds
    ) internal view returns (uint32 pre, uint16 w) {
        require(kStar >= bounds.start && kStar < bounds.end, InvalidProof());
        require(
            chunk.c == kStar / CSR_CHUNK
                && _verify(
                    csrRoot,
                    keccak256(bytes.concat(_le32(chunk.c), chunk.records)),
                    chunk.c,
                    (d.synapses + CSR_CHUNK - 1) / CSR_CHUNK,
                    chunk.proof
                ),
            InvalidProof()
        );
        uint32 off = (kStar - chunk.c * CSR_CHUNK) * 10;
        require(chunk.records.length >= off + 10, InvalidProof());
        uint32 post;
        (pre, post, w) = _record(chunk.records, off);
        require(post == d.neuron, InvalidProof());
    }

    function _rowOkLif(LifParty storage p, LifRowCheck.State memory prev, uint32 len, Dispute storage d, uint32 wUnit)
        internal
        view
        returns (bool)
    {
        int64 I = len == 0 ? int64(0) : p.sums[len - 1];
        return LifRowCheck.same(LifRowCheck.transition(prev, I, d.neuron, d.step, d.stimulusSeed, wUnit), p.state);
    }

    /// @notice final adjudication once both rows are posted (anyone may call with the openings)
    function proveSynapseTerm(
        bytes32 taskId,
        uint32 kStar,
        bytes32 csrRoot,
        bytes32 rowRoot,
        RowBounds calldata bounds,
        ChunkOpening calldata chunk,
        uint32 actPre,
        bytes32[] calldata actProof
    ) external {
        _live(taskId);
        Dispute storage d = disputes[taskId];
        _phase(d.exists && d.phase == Phase.Synapse && !lifs[taskId].lif);
        Party storage a = parties[taskId][partyA[taskId]];
        Party storage b = parties[taskId][partyB[taskId]];
        require(a.rowPosted && b.rowPosted, InvalidProof());
        uint32 n = d.neurons;
        uint32 len = _rowLen(d, csrRoot, rowRoot, bounds);
        bool lenA = a.sums.length == len;
        bool lenB = b.sums.length == len;
        if (lenA != lenB) return _resolve(taskId, lenA ? partyB[taskId] : partyA[taskId], "row length");
        require(lenA, InvalidProof());
        bool rowA = _rowOk(a, len);
        bool rowB = _rowOk(b, len);
        if (rowA != rowB) return _resolve(taskId, rowA ? partyB[taskId] : partyA[taskId], "row check");
        require(rowA, InvalidProof());
        (uint32 pre, uint16 w) = _recordAt(d, csrRoot, chunk, kStar, bounds);
        uint32 j = kStar - bounds.start;
        require(a.sums[j] != b.sums[j] && (j == 0 || a.sums[j - 1] == b.sums[j - 1]), InvalidProof());
        // input activation
        if (d.step == 1) require(actPre == _stimulus(pre, d.stimulusSeed), InvalidProof());
        else require(_verify(d.prevRoot, _leaf32(pre, actPre), pre, n, actProof), InvalidProof());
        uint64 term = uint64(w) * uint64(actPre);
        bool okA = a.sums[j] == (j == 0 ? 0 : a.sums[j - 1]) + term;
        bool okB = b.sums[j] == (j == 0 ? 0 : b.sums[j - 1]) + term;
        require(okA != okB, InvalidProof());
        _resolve(taskId, okA ? partyB[taskId] : partyA[taskId], "term");
    }

    function timeout(bytes32 taskId) external {
        Dispute storage d = disputes[taskId];
        require(
            d.exists && d.phase != Phase.Resolved && market.disputeActive(taskId) && block.number > d.deadline,
            InvalidProof()
        );
        d.phase = Phase.Resolved;
        market.onDisputeResolved(taskId, address(0), address(0));
        emit DisputeResolved(taskId, address(0), address(0));
    }
    mapping(address => uint256) public slashCredits;

    receive() external payable {
        require(msg.sender == address(instances), InvalidProof());
    }

    function withdrawSlash(address payable recipient) external {
        uint256 amount = slashCredits[msg.sender];
        require(amount != 0, InvalidProof());
        slashCredits[msg.sender] = 0;
        (bool ok,) = recipient.call{value: amount}("");
        require(ok, InvalidProof());
    }

    function _resolve(bytes32 taskId, address loser, string memory) internal {
        _live(taskId);
        Dispute storage d = disputes[taskId];
        address winner = _other(taskId, loser);
        d.phase = Phase.Resolved;
        d.loser = loser;
        uint256 beforeBalance = address(this).balance;
        instances.slash(loser, SLASH_AMOUNT, address(this), "porw:exec-fraud");
        slashCredits[winner] += address(this).balance - beforeBalance;
        market.onDisputeResolved(taskId, loser, winner);
        emit DisputeResolved(taskId, loser, winner);
    }
    mapping(bytes32 => uint256) public roundNonce;

    function _nextDeadline(bytes32 taskId) private returns (uint64) {
        roundNonce[taskId]++;
        uint64 next = uint64(block.number) + ROUND_BLOCKS;
        uint64 end = market.totalDeadline(taskId);
        return next < end ? next : end;
    }

    function _live(bytes32 taskId) private view {
        Dispute storage d = disputes[taskId];
        require(
            d.exists && d.phase != Phase.Resolved && market.disputeActive(taskId) && block.number <= d.deadline
                && block.number <= market.totalDeadline(taskId),
            InvalidProof()
        );
    }
    mapping(bytes32 => mapping(address => uint256)) public moveNonce;
    address private forwardedHost;
    bytes32 private forwardedTask;

    function hasOpenedRun(bytes32 id, address host) external view returns (bool) {
        return runOpened[id][host];
    }

    function partyState(bytes32 id, address host) external view returns (Party memory) {
        return parties[id][host];
    }

    function lifPartyState(bytes32 id, address host) external view returns (LifParty memory) {
        return lifParties[id][host];
    }

    function moveDigest(
        bytes32 id,
        address host,
        uint8 phase,
        uint256 round,
        uint256 nonce,
        uint64 expiry,
        bytes32 dataHash
    ) public view returns (bytes32) {
        return PorwEIP712.digest(
            PorwEIP712.domainSeparator(address(this)),
            keccak256(
                abi.encode(
                    keccak256(
                        "DisputeMove(bytes32 taskId,address host,uint8 phase,uint256 round,uint256 nonce,uint64 expiry,bytes32 dataHash)"
                    ),
                    id,
                    host,
                    phase,
                    round,
                    nonce,
                    expiry,
                    dataHash
                )
            )
        );
    }

    function forwardMove(
        bytes32 id,
        address host,
        uint8 phase,
        uint256 round,
        uint256 nonce,
        uint64 expiry,
        bytes calldata data,
        bytes calldata signature
    ) external {
        _live(id);
        require(
            forwardedHost == address(0) && host != address(0) && (host == partyA[id] || host == partyB[id]),
            InvalidProof()
        );
        require(
            phase == uint8(disputes[id].phase) && round == roundNonce[id] && nonce == moveNonce[id][host]
                && block.number <= expiry && expiry <= market.totalDeadline(id),
            InvalidProof()
        );
        require(data.length >= 36 && bytes32(data[4:36]) == id, InvalidProof());
        bytes4 selector = bytes4(data[:4]);
        require(
            selector == this.openRun.selector || selector == this.revealRoots.selector
                || selector == this.postStepRoots.selector || selector == this.postChildren.selector
                || selector == this.postRow.selector || selector == this.postRowLif.selector
                || selector == this.postRowChunk.selector || selector == this.postRowLifChunk.selector
                || selector == this.proveSynapseTerm.selector || selector == this.proveSynapseTermLif.selector,
            InvalidProof()
        );
        address signer =
            PorwEIP712.recover(moveDigest(id, host, phase, round, nonce, expiry, keccak256(data)), signature);
        require(instances.resolve(signer) == host, InvalidProof());
        if (signer != host) {
            (address delegated, uint64 end) = instances.delegations(signer);
            require(delegated == host && end >= market.totalDeadline(id), InvalidProof());
        }
        moveNonce[id][host]++;
        forwardedHost = host;
        forwardedTask = id;
        (bool ok, bytes memory result) = address(this).delegatecall(data);
        if (!ok) assembly ("memory-safe") { revert(add(result, 32), mload(result)) }
        delete forwardedHost;
        delete forwardedTask;
    }

    // ---- helpers (LE32 leaves, counted keccak Merkle, tree geometry, stimulus rule) ----
    function _rowOk(Party storage p, uint32 len) internal view returns (bool) {
        if (len == 0) return p.act == 0;
        uint64 v = p.sums[len - 1] >> 16;
        return p.act == (v > CLAMP_Q16 ? CLAMP_Q16 : uint32(v));
    }

    function _record(bytes calldata rec, uint32 off) internal pure returns (uint32 pre, uint32 post, uint16 w) {
        for (uint256 i = 0; i < 4; i++) {
            pre |= uint32(uint8(rec[off + i])) << uint32(8 * i);
            post |= uint32(uint8(rec[off + 4 + i])) << uint32(8 * i);
        }
        w = uint16(uint8(rec[off + 8])) | (uint16(uint8(rec[off + 9])) << 8);
    }

    function _le32(uint32 x) internal pure returns (bytes memory o) {
        o = new bytes(4);
        for (uint256 i = 0; i < 4; i++) {
            o[i] = bytes1(uint8(x >> uint32(8 * i)));
        }
    }

    function _leaf32(uint32 a, uint32 b) internal pure returns (bytes32) {
        return keccak256(bytes.concat(_le32(a), _le32(b)));
    }

    function _fmix32(uint32 h) internal pure returns (uint32) {
        unchecked {
            h ^= h >> 16;
            h *= 0x85EBCA6B;
            h ^= h >> 13;
            h *= 0xC2B2AE35;
            h ^= h >> 16;
        }
        return h;
    }

    function _stimulus(uint32 i, uint32 seed) internal pure returns (uint32) {
        unchecked {
            return _fmix32(i * 0x9E3779B9 + seed) % 100 == 0 ? CLAMP_Q16 : 0;
        }
    }

    function _width(uint32 n, uint32 level) internal pure returns (uint32 w) {
        w = n;
        for (uint32 l = 0; l < level; l++) {
            w = (w + 1) / 2;
        }
    }

    function _levels(uint32 n) internal pure returns (uint32 c) {
        uint32 w = n;
        c = 1;
        while (w > 1) {
            w = (w + 1) / 2;
            c++;
        }
    }

    function _rootOf(bytes32[] calldata leaves) internal pure returns (bytes32) {
        if (leaves.length == 0) return keccak256("");
        bytes32[] memory lvl = leaves;
        while (lvl.length > 1) {
            bytes32[] memory nx = new bytes32[]((lvl.length + 1) / 2);
            for (uint256 i = 0; i < nx.length; i++) {
                nx[i] = keccak256(bytes.concat(lvl[2 * i], 2 * i + 1 < lvl.length ? lvl[2 * i + 1] : lvl[2 * i]));
            }
            lvl = nx;
        }
        return lvl[0];
    }

    function _verify(bytes32 root, bytes32 leaf, uint64 index, uint64 count, bytes32[] calldata proof)
        internal
        pure
        returns (bool)
    {
        if (count == 0 || index >= count) return false;
        bytes32 acc = leaf;
        uint64 width = count;
        uint256 pi = 0;
        while (width > 1) {
            if (pi >= proof.length) return false;
            bytes32 sib = proof[pi];
            if (index % 2 == 0) {
                if (index + 1 == width && sib != acc) return false;
                acc = keccak256(bytes.concat(acc, sib));
            } else {
                acc = keccak256(bytes.concat(sib, acc));
            }
            index /= 2;
            width = width / 2 + width % 2;
            pi++;
        }
        return pi == proof.length && acc == root;
    }
}
