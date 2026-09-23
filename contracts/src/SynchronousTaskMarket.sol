// SPDX-License-Identifier: 0BSD
pragma solidity ^0.8.20;

import "aigg-porw/interfaces/PorwMesh.sol";
import "aigg-porw/mesh/InstanceRegistry.sol";
import "aigg-porw/mesh/PoRWClaimManager.sol";
import "aigg-porw/mesh/HostCapacity.sol";
import "aigg-porw/mesh/PorwEIP712.sol";
import "./TokenTransfer.sol";

library SynchronousLimits {
    uint32 internal constant MAX_IN_DEGREE = 16384;
    uint32 internal constant MAX_ROW_CHUNK = 1024;
}

interface ISynchronousRoyaltyReceiver {
    function MARKET() external view returns (address);
    function supportsTokenRoyalties() external view returns (bool);
    function royaltyRecipients(bytes32) external view returns (address, address, uint16);
}

interface ISynchronousDisputes {
    function ROUND_BLOCKS() external view returns (uint64);
    function openDispute(bytes32, address, address) external;
    function timeout(bytes32) external;
}

/// @notice Two ready executors agree or adjudicate during one finite session. Agreement and
/// adjudication rely on an independent honest executor; neither proves arbitrary output validity.
/// Admission/asset conventions derived from MultiAssetTaskMarket (0BSD).
contract SynchronousTaskMarket {
    error InvalidSession();
    mapping(bytes32 => uint32) public profileMaxInDegree;
    event ProfileSupportSet(bytes32 indexed mepId, uint32 maxInDegree);

    /// Owner certifies the exact immutable profile after measuring its CSR. No base inheritance.
    function setProfileSupport(bytes32 mepId, uint32 maxInDegree) public {
        require(msg.sender == owner && maxInDegree <= SynchronousLimits.MAX_IN_DEGREE, InvalidSession());
        IMEPRegistry.MEP memory m = meps.getMEP(mepId);
        require(maxInDegree == 0 || supportedExecKind(m.execKind), InvalidSession());
        profileMaxInDegree[mepId] = maxInDegree;
        emit ProfileSupportSet(mepId, maxInDegree);
    }

    function setProfileSupports(bytes32[] calldata ids, uint32[] calldata degrees) external {
        require(ids.length > 0 && ids.length <= 32 && ids.length == degrees.length, InvalidSession());
        for (uint256 j; j < ids.length; j++) {
            setProfileSupport(ids[j], degrees[j]);
        }
    }

    function supportedExecKind(bytes32 kind) public view returns (bool) {
        return kind == keccak256("aigg:exec:int-spmv-q16:v1") || meps.lifWeightUnit(kind) != 0;
    }
    using PorwMeshHash for ITaskMarket.Task;
    uint256 public constant protocolVersion = 1;
    uint64 public constant challengeWindow = 0;
    uint32 public constant MAX_ROOTS = 512;
    uint32 public constant MAX_RUNS = 65536;
    uint64 public immutable COMMIT_BLOCKS;
    uint64 public immutable REVEAL_BLOCKS;
    uint64 public immutable DISPUTE_BLOCKS;
    uint64 public immutable TASK_TIMEOUT;
    IMEPRegistry public immutable meps;
    InstanceRegistry public immutable instances;
    PoRWClaimManager public immutable claimManager;
    address public immutable owner;
    address public disputes;
    HostCapacity public hostCapacity;
    bool public hasPostedTask;
    bool private busy;
    modifier guard() {
        require(!busy, InvalidSession());
        busy = true;
        _;
        busy = false;
    }
    enum Status {
        Missing,
        Committing,
        Revealing,
        Disputing,
        Completed,
        Inconclusive,
        AwaitingRandomness
    }

    struct StoredTask {
        ITaskMarket.Task t;
        address client;
        uint64 epoch;
        uint64 postedAt;
        uint64 settledAt;
        bool exists;
        bool settled;
        bool disputed;
        bool repudiated;
    }

    struct Session {
        Status state;
        uint64 commitDeadline;
        uint64 revealDeadline;
        uint64 totalDeadline;
    }
    mapping(bytes32 => StoredTask) public tasks;
    mapping(bytes32 => Session) internal sessions;
    mapping(bytes32 => address[]) internal chosen;
    mapping(address => bool) internal _readyValues;

    function ready(address host) public view virtual returns (bool) {
        return _readyValues[host];
    }
    mapping(address => address) public readinessSigner;
    mapping(address => uint256) internal _readinessNonce;

    function readinessNonce(address host) public view virtual returns (uint256) {
        return _readinessNonce[host];
    }
    mapping(address => bytes32) internal _pendingTask;

    function pendingTask(address host) public view virtual returns (bytes32) {
        return _pendingTask[host];
    }

    function hasPendingTask(bytes32 id, address host) public view virtual returns (bool) {
        return pendingTask(host) == id;
    }

    function _setReadinessSigner(address host, address signer) internal virtual {
        readinessSigner[host] = signer;
    }

    mapping(bytes32 => mapping(address => bytes32)) public commitments;
    mapping(bytes32 => mapping(address => bool)) public submitted;
    mapping(bytes32 => mapping(address => ITaskMarket.Result)) private results;
    mapping(bytes32 => uint32) public batchRuns;
    mapping(bytes32 => address) public paymentToken;
    mapping(address => bool) public tokenAllowed;
    mapping(address => bool) public tokenBeneficiaryAllowed;
    mapping(address => mapping(address => bool)) public acceptedToken;
    mapping(address => mapping(address => uint256)) public credits;
    mapping(bytes32 => uint256) public royalties;
    mapping(bytes32 => mapping(address => uint256)) public tokenRoyalties;
    mapping(bytes32 => bytes32) public settledDigest;
    mapping(bytes32 => address) public settledRef;
    mapping(bytes32 => uint8) public paidExecutors;
    event TaskPosted(bytes32 indexed taskId, bytes32 indexed mepId, uint8 redundancy);
    event TaskAsset(bytes32 indexed taskId, address indexed token, uint256 fee);
    event BatchPosted(bytes32 indexed taskId, uint32 runs, bytes32 runsRoot);
    event SessionDeadlines(bytes32 indexed taskId, uint64 commitDeadline, uint64 revealDeadline, uint64 totalDeadline);
    event ReadinessChanged(address indexed host, bool ready, uint256 nonce);
    event ResultCommitted(bytes32 indexed taskId, address indexed host, bytes32 commitment);
    event ResultSubmitted(bytes32 indexed taskId, address indexed executor, bytes32 execDigest);
    event DisputeOpened(bytes32 indexed taskId, address a, address b);
    event TaskSettled(bytes32 indexed taskId, bytes32 execDigest, address[] executors);
    event SessionClosed(bytes32 indexed taskId, uint8 outcome, bytes32 digest);
    event RoyaltyAccrued(bytes32 indexed taskId, bytes32 indexed mepId, uint256 amount);
    event TokenRoyaltyAccrued(bytes32 indexed taskId, bytes32 indexed mepId, address indexed token, uint256 amount);

    constructor(
        IMEPRegistry m,
        InstanceRegistry i,
        PoRWClaimManager cm,
        uint64 commitBlocks,
        uint64 revealBlocks,
        uint64 disputeBlocks
    ) {
        require(commitBlocks > 0 && revealBlocks > 0 && disputeBlocks > 0, InvalidSession());
        meps = m;
        instances = i;
        claimManager = cm;
        owner = msg.sender;
        COMMIT_BLOCKS = commitBlocks;
        REVEAL_BLOCKS = revealBlocks;
        DISPUTE_BLOCKS = disputeBlocks;
        TASK_TIMEOUT = commitBlocks + revealBlocks + disputeBlocks;
    }

    function setDisputes(address d) external {
        require(msg.sender == owner && disputes == address(0) && !hasPostedTask && d != address(0), InvalidSession());
        disputes = d;
    }

    function setHostCapacity(address c) external {
        require(msg.sender == owner && !hasPostedTask && address(hostCapacity) == address(0), InvalidSession());
        require(HostCapacity(c).authorizedMarkets(address(this)), InvalidSession());
        hostCapacity = HostCapacity(c);
    }

    function setTokenAllowed(address token, bool allowed) external {
        require(msg.sender == owner && token != address(0) && token.code.length > 0, InvalidSession());
        tokenAllowed[token] = allowed;
    }

    function setTokenBeneficiaryAllowed(address beneficiary, bool allowed) external {
        require(msg.sender == owner, InvalidSession());
        if (allowed) {
            require(
                ISynchronousRoyaltyReceiver(beneficiary).MARKET() == address(this)
                    && ISynchronousRoyaltyReceiver(beneficiary).supportsTokenRoyalties(),
                InvalidSession()
            );
        }
        tokenBeneficiaryAllowed[beneficiary] = allowed;
    }

    function setAcceptedToken(address token, bool accepted) external {
        require(token != address(0), InvalidSession());
        acceptedToken[msg.sender][token] = accepted;
    }

    function _typed(bytes32 h) private view returns (bytes32) {
        return PorwEIP712.digest(PorwEIP712.domainSeparator(address(this)), h);
    }

    function readinessDigest(address host, bool value, uint64 expiry, uint256 nonce) public view returns (bytes32) {
        return _typed(
            keccak256(
                abi.encode(
                    keccak256("Readiness(address host,bool ready,uint64 expiry,uint256 nonce)"),
                    host,
                    value,
                    expiry,
                    nonce
                )
            )
        );
    }

    function setReady(bool value) external {
        address host = instances.resolve(msg.sender);
        _authorize(host, msg.sender, value ? uint64(block.number) + _sessionWindow() : uint64(block.number));
        _setReadinessSigner(host, msg.sender);
        _ready(host, value);
    }

    function setReadyBySig(address host, bool value, uint64 expiry, uint256 nonce, bytes calldata signature) external {
        require(block.number <= expiry && nonce == readinessNonce(host), InvalidSession());
        address signer = PorwEIP712.recover(readinessDigest(host, value, expiry, nonce), signature);
        _authorize(host, signer, value ? uint64(block.number) + _sessionWindow() : uint64(block.number));
        _setReadinessSigner(host, signer);
        _ready(host, value);
    }

    function _ready(address host, bool value) internal virtual {
        require(!value || pendingTask(host) == bytes32(0), InvalidSession());
        _readyValues[host] = value;
        _readinessNonce[host]++;
        emit ReadinessChanged(host, value, readinessNonce(host));
    }

    function _authorize(address host, address signer, uint64 through) private view {
        require(host != address(0) && instances.resolve(signer) == host, InvalidSession());
        if (signer != host) {
            (address delegated, uint64 expiry) = instances.delegations(signer);
            require(delegated == host && expiry >= through, InvalidSession());
        }
    }

    function taskId(ITaskMarket.Task calldata t, address token, bytes32 nonce, uint32 runs, address client)
        public
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encode(
                keccak256("AIGG_SYNCHRONOUS_TASK_V1"), block.chainid, address(this), token, client, t, nonce, runs
            )
        );
    }

    function tokenTaskId(ITaskMarket.Task calldata t, address token, bytes32 nonce, uint32 runs, address client)
        external
        view
        returns (bytes32)
    {
        return taskId(t, token, nonce, runs, client);
    }

    function postTask(ITaskMarket.Task calldata t, bytes32 nonce) external payable guard returns (bytes32) {
        return this.postSession{value: msg.value}(t, address(0), nonce, 0, msg.sender);
    }

    function postBatch(ITaskMarket.Task calldata t, uint32 runs, bytes32 nonce)
        external
        payable
        guard
        returns (bytes32)
    {
        require(runs >= 2, InvalidSession());
        return this.postSession{value: msg.value}(t, address(0), nonce, runs, msg.sender);
    }

    function postTokenTask(ITaskMarket.Task calldata t, address token, bytes32 nonce) external guard returns (bytes32) {
        require(tokenAllowed[token], InvalidSession());
        return this.postSession(t, token, nonce, 0, msg.sender);
    }

    function postTokenBatch(ITaskMarket.Task calldata t, address token, uint32 runs, bytes32 nonce)
        external
        guard
        returns (bytes32)
    {
        require(tokenAllowed[token] && runs >= 2, InvalidSession());
        return this.postSession(t, token, nonce, runs, msg.sender);
    }

    function minimumDisputeBlocks(uint32 neurons, uint32 runs, bool lif) public view returns (uint64) {
        uint64 rounds = 2 + 2 * (SynchronousLimits.MAX_IN_DEGREE / SynchronousLimits.MAX_ROW_CHUNK) + (lif ? 1 : 0);
        while (neurons > 1) {
            neurons = (neurons + 1) / 2;
            rounds++;
        }
        if (runs > 0) {
            rounds++;
            while (runs > 1) {
                runs = (runs + 1) / 2;
                rounds++;
            }
        }
        return rounds * ISynchronousDisputes(disputes).ROUND_BLOCKS();
    }

    function postSession(ITaskMarket.Task calldata t, address token, bytes32 nonce, uint32 runs, address client)
        external
        payable
        returns (bytes32 id)
    {
        require(msg.sender == address(this), InvalidSession());
        require(disputes != address(0) && address(hostCapacity) != address(0), InvalidSession());
        require(t.redundancy == 2 && t.fee > 0, InvalidSession());
        if (token != address(0)) {
            (address beneficiary, uint16 bps) = meps.termsOf(t.mepId);
            require(bps == 0 || beneficiary.code.length == 0 || tokenBeneficiaryAllowed[beneficiary], InvalidSession());
        }
        uint256 charged = _charge(token, t.fee);
        require(msg.value == (token == address(0) ? charged : 0), InvalidSession());
        require(t.steps > 0 && t.commitStride > 0 && t.commitStride <= t.steps, InvalidSession());
        IMEPRegistry.MEP memory m = meps.getMEP(t.mepId);
        bool lif = meps.lifWeightUnit(m.execKind) != 0;
        require(profileMaxInDegree[t.mepId] > 0 && supportedExecKind(m.execKind), InvalidSession());
        require(m.synapses <= type(uint32).max - 63, InvalidSession());
        require(m.neurons > 0 && m.neurons < type(uint32).max, InvalidSession());
        require(
            lif
                ? (uint256(t.steps) + t.commitStride - 1) / t.commitStride <= MAX_ROOTS && t.commitStride <= MAX_ROOTS
                : t.steps <= MAX_ROOTS && t.commitStride == 1,
            InvalidSession()
        );
        require(runs == 0 || (lif && runs <= MAX_RUNS && t.stimulusSeed == 0), InvalidSession());
        require(DISPUTE_BLOCKS >= minimumDisputeBlocks(m.neurons, runs, lif), InvalidSession());
        uint64 total = uint64(block.number) + _sessionWindow();
        require(t.deadline == 0 || t.deadline >= total, InvalidSession());
        id = taskId(t, token, nonce, runs, client);
        require(!tasks[id].exists, InvalidSession());
        uint64 epoch = claimManager.currentEpoch();
        tasks[id] = StoredTask(t, client, epoch, uint64(block.number), 0, true, false, false, false);
        paymentToken[id] = token;
        batchRuns[id] = runs;
        hasPostedTask = true;
        _admit(id, token, epoch, total);
        if (token != address(0)) TokenTransfer.pull(token, client, address(this), charged);
        emit TaskPosted(id, t.mepId, 2);
        emit TaskAsset(id, token, t.fee);
        if (runs > 0) emit BatchPosted(id, runs, t.initStateRoot);
        emit SessionDeadlines(id, sessions[id].commitDeadline, sessions[id].revealDeadline, total);
    }

    function _sessionWindow() internal view virtual returns (uint64) {
        return TASK_TIMEOUT;
    }

    function _charge(address, uint256 fee) internal virtual returns (uint256) {
        return fee;
    }

    function _admit(bytes32 id, address token, uint64 epoch, uint64 total) internal virtual {
        bytes32 beacon = claimManager.beacon(epoch);
        require(beacon != bytes32(0), InvalidSession());
        sessions[id] = Session(
            Status.Committing,
            uint64(block.number) + COMMIT_BLOCKS,
            uint64(block.number) + COMMIT_BLOCKS + REVEAL_BLOCKS,
            total
        );
        uint256 len = instances.enrolled(tasks[id].t.mepId);
        require(len > 0, InvalidSession());
        for (uint32 j; j < 128 && chosen[id].length < 2; j++) {
            address h = instances.sortitionPick(
                tasks[id].t.mepId, epoch, len, PorwMeshHash.sortition(beacon, tasks[id].t.mepId, id, j)
            );
            if (
                h == address(0) || !ready(h) || pendingTask(h) != bytes32(0)
                    || (token != address(0) && !acceptedToken[h][token])
            ) {
                continue;
            }
            address signer = readinessSigner[h];
            if (instances.resolve(signer) != h) continue;
            if (signer != h) {
                (, uint64 end) = instances.delegations(signer);
                if (end < total) continue;
            }
            if (!hostCapacity.reserve(id, h, total)) continue;
            _readyValues[h] = false;
            _readinessNonce[h]++;
            _pendingTask[h] = id;
            chosen[id].push(h);
            instances.hold(h);
            emit ReadinessChanged(h, false, _readinessNonce[h]);
        }
        require(chosen[id].length == 2, InvalidSession());
    }

    function sessionState(bytes32 id) external view returns (uint8, uint64, uint64, uint64) {
        Session storage s = sessions[id];
        return (uint8(s.state), s.commitDeadline, s.revealDeadline, s.totalDeadline);
    }

    function totalDeadline(bytes32 id) external view returns (uint64) {
        return sessions[id].totalDeadline;
    }

    function disputeActive(bytes32 id) external view returns (bool) {
        return sessions[id].state == Status.Disputing;
    }

    function executors(bytes32 id) external view returns (address[] memory) {
        return chosen[id];
    }

    function taskInfo(bytes32 id) external view returns (bytes32, uint32, address, uint32, uint32) {
        StoredTask storage s = tasks[id];
        return (s.t.mepId, s.t.stimulusSeed, s.client, s.t.steps, s.t.commitStride);
    }

    function taskInitStateRoot(bytes32 id) external view returns (bytes32) {
        return tasks[id].t.initStateRoot;
    }

    function resultOf(bytes32 id, address host) external view returns (bytes32, bytes32) {
        ITaskMarket.Result storage r = results[id][host];
        return (r.execDigest, r.execRoot);
    }

    function resultCommitment(bytes32 id, address host, bytes32 digest, bytes32 root, bytes32 salt)
        public
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encode(
                keccak256("AIGG_SYNCHRONOUS_RESULT_V1"), block.chainid, address(this), id, host, digest, root, salt
            )
        );
    }

    function commitmentDigest(bytes32 id, address host, bytes32 commitment) public view returns (bytes32) {
        return _typed(
            keccak256(
                abi.encode(
                    keccak256("ResultCommitment(bytes32 taskId,address host,bytes32 commitment)"), id, host, commitment
                )
            )
        );
    }

    function resultDigest(bytes32 id, address host, bytes32 digest, bytes32 root) public view returns (bytes32) {
        return _typed(
            keccak256(
                abi.encode(
                    keccak256("SynchronousResult(bytes32 taskId,address host,bytes32 execDigest,bytes32 execRoot)"),
                    id,
                    host,
                    digest,
                    root
                )
            )
        );
    }

    function commitResult(bytes32 id, address host, bytes32 commitment, bytes calldata signature) external {
        Session storage s = sessions[id];
        require(s.state == Status.Committing && block.number <= s.commitDeadline, InvalidSession());
        require(
            hasPendingTask(id, host) && id != bytes32(0) && commitment != bytes32(0)
                && commitments[id][host] == bytes32(0),
            InvalidSession()
        );
        _authorize(host, PorwEIP712.recover(commitmentDigest(id, host, commitment), signature), s.totalDeadline);
        commitments[id][host] = commitment;
        emit ResultCommitted(id, host, commitment);
        if (commitments[id][chosen[id][0]] != bytes32(0) && commitments[id][chosen[id][1]] != bytes32(0)) {
            s.state = Status.Revealing;
        }
    }

    function revealResult(
        bytes32 id,
        address host,
        ITaskMarket.Result calldata r,
        bytes32 salt,
        bytes calldata signature
    ) external guard {
        Session storage s = sessions[id];
        require(s.state == Status.Revealing && block.number <= s.revealDeadline, InvalidSession());
        require(hasPendingTask(id, host) && id != bytes32(0) && !submitted[id][host], InvalidSession());
        require(commitments[id][host] == resultCommitment(id, host, r.execDigest, r.execRoot, salt), InvalidSession());
        _authorize(
            host, PorwEIP712.recover(resultDigest(id, host, r.execDigest, r.execRoot), signature), s.totalDeadline
        );
        require(batchRuns[id] == 0 || r.execDigest == PorwMeshHash.batchDigest(r.execRoot), InvalidSession());
        results[id][host] = r;
        submitted[id][host] = true;
        emit ResultSubmitted(id, host, r.execDigest);
        address a = chosen[id][0];
        address b = chosen[id][1];
        if (!submitted[id][a] || !submitted[id][b]) return;
        if (results[id][a].execRoot != results[id][b].execRoot) {
            s.state = Status.Disputing;
            tasks[id].disputed = true;
            emit DisputeOpened(id, a, b);
            ISynchronousDisputes(disputes).openDispute(id, a, b);
        } else if (results[id][a].execDigest == results[id][b].execDigest) {
            _close(id, a, false);
        } else {
            _close(id, address(0), false);
        }
    }

    function expire(bytes32 id) public virtual {
        Session storage s = sessions[id];
        if (s.state == Status.Disputing) {
            ISynchronousDisputes(disputes).timeout(id);
            return;
        }
        require(
            (s.state == Status.Committing && block.number > s.commitDeadline)
                || (s.state == Status.Revealing && block.number > s.revealDeadline),
            InvalidSession()
        );
        _close(id, address(0), false);
    }

    function onDisputeResolved(bytes32 id, address loser, address winner) external {
        require(msg.sender == disputes && sessions[id].state == Status.Disputing, InvalidSession());
        if (winner != address(0)) {
            require(
                block.number <= sessions[id].totalDeadline && winner != loser && hasPendingTask(id, winner)
                    && hasPendingTask(id, loser),
                InvalidSession()
            );
        }
        _close(id, winner, true);
    }

    function _close(bytes32 id, address winner, bool adjudicated) internal {
        StoredTask storage t = tasks[id];
        Session storage s = sessions[id];
        require(!t.settled && t.exists, InvalidSession());
        s.state = winner == address(0) ? Status.Inconclusive : Status.Completed;
        t.settled = true;
        t.settledAt = uint64(block.number);
        t.disputed = false;
        address token = paymentToken[id];
        address[] memory paid = new address[](winner == address(0) ? 0 : adjudicated ? 1 : 2);
        if (winner == address(0)) {
            credits[token][t.client] += t.t.fee;
        } else {
            (address ben, uint16 bps) = meps.termsOf(t.t.mepId);
            uint256 cut = ben == address(0) ? 0 : t.t.fee * bps / 10000;
            if (token == address(0)) {
                royalties[t.t.mepId] += cut;
                emit RoyaltyAccrued(id, t.t.mepId, cut);
            } else {
                if (!_creditRoyalty(t.t.mepId, token, ben, cut)) tokenRoyalties[t.t.mepId][token] += cut;
                emit TokenRoyaltyAccrued(id, t.t.mepId, token, cut);
            }
            uint256 n = paid.length;
            uint256 share = (t.t.fee - cut) / n;
            for (uint256 j; j < n; j++) {
                paid[j] = adjudicated ? winner : chosen[id][j];
                credits[token][paid[j]] += share;
            }
            credits[token][t.client] += (t.t.fee - cut) % n;
            settledDigest[id] = results[id][winner].execDigest;
            settledRef[id] = winner;
            paidExecutors[id] = uint8(n);
        }
        _release(id);
        emit TaskSettled(id, settledDigest[id], paid);
        emit SessionClosed(id, uint8(s.state), settledDigest[id]);
    }

    function _release(bytes32 id) internal virtual {
        for (uint256 j; j < 2; j++) {
            address h = chosen[id][j];
            delete _pendingTask[h];
            instances.release(h);
            hostCapacity.release(id, h);
        }
    }

    function _creditRoyalty(bytes32 mepId, address token, address beneficiary, uint256 amount) private returns (bool) {
        if (!tokenBeneficiaryAllowed[beneficiary] || amount == 0) return false;
        bytes memory data = abi.encodeCall(ISynchronousRoyaltyReceiver.royaltyRecipients, (mepId));
        bytes memory output = new bytes(96);
        bool ok;
        uint256 holder;
        uint256 vendor;
        uint256 bps;
        assembly ("memory-safe") {
            ok := staticcall(100000, beneficiary, add(data, 32), mload(data), add(output, 32), 96)
            ok := and(ok, eq(returndatasize(), 96))
            holder := mload(add(output, 32))
            vendor := mload(add(output, 64))
            bps := mload(add(output, 96))
        }
        if (
            !ok || holder == 0 || holder > type(uint160).max || vendor > type(uint160).max || bps > 10000
                || (bps > 0 && vendor == 0)
        ) {
            return false;
        }
        uint256 base = amount * bps / 10000;
        credits[token][address(uint160(holder))] += amount - base;
        credits[token][address(uint160(vendor))] += base;
        return true;
    }

    function withdrawCredit(address token, address payable recipient) external guard returns (uint256 amount) {
        amount = credits[token][msg.sender];
        require(amount > 0, InvalidSession());
        credits[token][msg.sender] = 0;
        _send(token, recipient, amount);
    }

    function withdrawRoyalty(bytes32 mepId) external guard returns (uint256 amount) {
        (address ben,) = meps.termsOf(mepId);
        require(msg.sender == ben, InvalidSession());
        amount = royalties[mepId];
        royalties[mepId] = 0;
        _send(address(0), payable(ben), amount);
    }

    function withdrawTokenRoyalty(bytes32 mepId, address token) external guard returns (uint256 amount) {
        (address ben,) = meps.termsOf(mepId);
        require(msg.sender == ben, InvalidSession());
        amount = tokenRoyalties[mepId][token];
        tokenRoyalties[mepId][token] = 0;
        _send(token, payable(ben), amount);
    }

    function _send(address token, address payable recipient, uint256 amount) private {
        if (token != address(0)) {
            TokenTransfer.send(token, recipient, amount);
        } else {
            (bool ok,) = recipient.call{value: amount}("");
            require(ok, InvalidSession());
        }
    }
}
