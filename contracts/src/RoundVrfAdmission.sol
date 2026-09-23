// SPDX-License-Identifier: 0BSD
pragma solidity ^0.8.20;
import "./VrfAdmission.sol";

/// @notice Bounded shared VRF rounds with per-task precommitted pools and independent reservations.
/// Capacity leases and bond holds belong to this controller for their entire lifetime.
contract RoundVrfAdmission {
    error InvalidAdmission();

    struct Request {
        uint64 maxSessionEnd;
        uint8 state;
        bytes32 snapshotHash;
    }

    struct Round {
        uint64 closeBlock;
        uint64 randomnessDeadline;
        uint256 requestId;
        uint64 fulfilledAt;
        uint64 allocationDeadline;
        uint8 state;
        uint16 taskCount;
        uint256 word;
    }
    uint64 public immutable ROUND_BLOCKS;
    uint8 public immutable MAX_ROUND_TASKS;
    uint256 public currentRound;
    mapping(uint256 => Round) private rounds;
    mapping(bytes32 => uint256) public taskRound;
    mapping(uint256 => uint256) public requestRound;
    mapping(address => uint256) public hostRound;
    mapping(address => bytes32[]) private pending;
    mapping(bytes32 => mapping(address => uint256)) private pendingIndex;

    struct Candidate {
        address host;
        address signer;
        uint256 weight;
    }
    address public immutable MARKET;
    InstanceRegistry public immutable instances;
    address public immutable coordinator;
    bytes32 public immutable keyHash;
    uint256 public immutable subId;
    uint16 public immutable requestConfirmations;
    uint32 public immutable callbackGasLimit;
    bool public immutable nativePayment;
    uint64 public immutable WAIT_BLOCKS;
    uint64 public immutable ACTIVATION_BLOCKS;
    uint64 public immutable READY_TTL;
    address public immutable feeRecipient;
    uint8 public constant MAX_CANDIDATES = 32;
    mapping(address => uint256) public admissionFee;
    address[32] public readyRoster;
    mapping(address => uint8) private seatPlusOne;
    mapping(address => uint64) public readyUntil;
    mapping(address => uint256) public readinessNonce;
    mapping(bytes32 => Request) private requests;
    mapping(bytes32 => Candidate[]) private pools;
    mapping(bytes32 => mapping(address => address)) public taskSigner;
    event ReadinessChanged(address indexed host, bool ready, uint256 nonce);
    event Allocated(bytes32 indexed taskId, address first, address second);
    modifier onlyMarket() {
        require(msg.sender == MARKET, InvalidAdmission());
        _;
    }

    constructor(
        InstanceRegistry registry,
        VrfAdmission.Config memory c,
        address[] memory tokens,
        uint256[] memory fees,
        uint64 roundBlocks,
        uint8 maxRoundTasks
    ) {
        require(
            c.coordinator.code.length > 0 && c.keyHash != bytes32(0) && c.subId != 0 && c.requestConfirmations > 0
                && c.callbackGasLimit >= 100000 && c.waitBlocks > 0 && c.activationBlocks > 0 && c.readyTTL > 0
                && c.feeRecipient != address(0) && tokens.length == fees.length,
            InvalidAdmission()
        );
        require(roundBlocks > 0 && maxRoundTasks > 0 && maxRoundTasks <= 64, InvalidAdmission());
        ROUND_BLOCKS = roundBlocks;
        MAX_ROUND_TASKS = maxRoundTasks;
        MARKET = msg.sender;
        instances = registry;
        coordinator = c.coordinator;
        keyHash = c.keyHash;
        subId = c.subId;
        requestConfirmations = c.requestConfirmations;
        callbackGasLimit = c.callbackGasLimit;
        nativePayment = c.nativePayment;
        WAIT_BLOCKS = c.waitBlocks;
        ACTIVATION_BLOCKS = c.activationBlocks;
        READY_TTL = c.readyTTL;
        feeRecipient = c.feeRecipient;
        for (uint256 j; j < tokens.length; j++) {
            require(fees[j] > 0 && admissionFee[tokens[j]] == 0, InvalidAdmission());
            admissionFee[tokens[j]] = fees[j];
        }
        require(admissionFee[address(0)] > 0, InvalidAdmission());
    }

    function ready(address host) public view returns (bool) {
        uint256 roundId = hostRound[host];
        if (
            roundId != 0
                && (roundId != currentRound
                    || block.number >= rounds[roundId].closeBlock
                    || rounds[roundId].taskCount >= MAX_ROUND_TASKS)
        ) return false;
        return readyUntil[host] >= block.number && seatPlusOne[host] != 0 && instances.weightOf(host) > 0
            && instances.exitAt(host) == 0 && IVrfMarket(MARKET).hostCapacity().capacityOf(host) > 0;
    }

    function _remove(address host) private {
        uint8 seat = seatPlusOne[host];
        if (seat != 0) {
            delete readyRoster[seat - 1];
            delete seatPlusOne[host];
            delete readyUntil[host];
            readinessNonce[host]++;
            emit ReadinessChanged(host, false, readinessNonce[host]);
        }
    }

    function pruneReady() public {
        for (uint256 j; j < MAX_CANDIDATES; j++) {
            address host = readyRoster[j];
            if (host != address(0) && !ready(host)) _remove(host);
        }
    }

    function setReady(address host, bool value) external onlyMarket {
        if (!value) {
            if (seatPlusOne[host] == 0) readinessNonce[host]++;
            else _remove(host);
            return;
        }
        require(
            pending[host].length == 0 && instances.weightOf(host) > 0 && instances.exitAt(host) == 0
                && IVrfMarket(MARKET).hostCapacity().capacityOf(host) > 0,
            InvalidAdmission()
        );
        pruneReady();
        if (seatPlusOne[host] == 0) {
            for (uint256 j; j < MAX_CANDIDATES; j++) {
                if (readyRoster[j] == address(0)) {
                    readyRoster[j] = host;
                    seatPlusOne[host] = uint8(j + 1);
                    break;
                }
            }
            require(seatPlusOne[host] != 0, InvalidAdmission());
        }
        readyUntil[host] = uint64(block.number) + READY_TTL;
        readinessNonce[host]++;
        emit ReadinessChanged(host, true, readinessNonce[host]);
    }

    function admit(bytes32 id, bytes32 mepId, address token, uint64 epoch, uint64 maxEnd) external onlyMarket {
        Request storage r = requests[id];
        require(id != 0 && r.state == 0, InvalidAdmission());
        uint256 roundId = currentRound;
        if (roundId == 0 || block.number >= rounds[roundId].closeBlock) {
            roundId = ++currentRound;
            rounds[roundId].closeBlock = uint64(block.number) + ROUND_BLOCKS;
            rounds[roundId].randomnessDeadline = rounds[roundId].closeBlock + WAIT_BLOCKS;
            rounds[roundId].state = 5;
        }
        Round storage round = rounds[roundId];
        require(round.state == 5 && round.taskCount < MAX_ROUND_TASKS, InvalidAdmission());
        taskRound[id] = roundId;
        r.state = 5;
        r.maxSessionEnd = maxEnd;
        HostCapacity capacity = IVrfMarket(MARKET).hostCapacity();
        uint256 cap = instances.weightCap(mepId);
        bytes32 hash = keccak256(abi.encode(block.chainid, MARKET, id, mepId, token, epoch, maxEnd));
        for (uint256 j; j < MAX_CANDIDATES; j++) {
            address host = readyRoster[j];
            if (
                host == address(0) || !ready(host) || (hostRound[host] != 0 && hostRound[host] != roundId)
                    || !instances.isEligible(host, mepId, epoch)
                    || (token != address(0) && !IVrfMarket(MARKET).acceptedToken(host, token))
            ) continue;
            address signer = IVrfMarket(MARKET).readinessSigner(host);
            if (instances.resolve(signer) != host) continue;
            if (signer != host) {
                (, uint64 expiry) = instances.delegations(signer);
                if (expiry < maxEnd) continue;
            }
            uint256 weight = instances.weightOf(host);
            if (weight > cap) weight = cap;
            if (weight == 0 || !capacity.reserve(id, host, maxEnd)) continue;
            require(pending[host].length < 64, InvalidAdmission());
            hostRound[host] = roundId;
            pending[host].push(id);
            pendingIndex[id][host] = pending[host].length;
            instances.hold(host);
            pools[id].push(Candidate(host, signer, weight));
            taskSigner[id][host] = signer;
            hash = keccak256(abi.encode(hash, host, signer, weight));
        }
        uint8 count = uint8(pools[id].length);
        require(count >= 2, InvalidAdmission());
        r.snapshotHash = hash;
        round.taskCount++;
        emit TaskCollected(id, roundId, hash, count);
    }

    event TaskCollected(bytes32 indexed taskId, uint256 indexed roundId, bytes32 snapshotHash, uint8 candidates);
    event RoundSealed(uint256 indexed roundId, uint256 indexed requestId);
    event RoundFulfilled(uint256 indexed roundId, uint256 indexed requestId, uint64 fulfilledAt);

    function sealRound(uint256 roundId) external onlyMarket {
        Round storage r = rounds[roundId];
        require(
            r.state == 5 && r.taskCount > 0 && block.number >= r.closeBlock && block.number <= r.randomnessDeadline,
            InvalidAdmission()
        );
        r.state = 1;
        uint256 requestId = IVrfCoordinatorV25(coordinator)
            .requestRandomWords(
                IVrfCoordinatorV25.RandomWordsRequest(
                    keyHash,
                    subId,
                    requestConfirmations,
                    callbackGasLimit,
                    1,
                    abi.encodeWithSelector(bytes4(keccak256("VRF ExtraArgsV1")), nativePayment)
                )
            );
        require(requestId != 0 && requestRound[requestId] == 0, InvalidAdmission());
        r.requestId = requestId;
        requestRound[requestId] = roundId;
        emit RoundSealed(roundId, requestId);
    }

    /// @notice No candidate loops, payments or market calls in the coordinator callback.
    function rawFulfillRandomWords(uint256 requestId, uint256[] calldata words) external {
        require(msg.sender == coordinator, InvalidAdmission());
        uint256 roundId = requestRound[requestId];
        if (roundId == 0 || words.length != 1) return;
        Round storage r = rounds[roundId];
        if (r.state != 1 || block.number > r.randomnessDeadline) return;
        r.word = words[0];
        r.fulfilledAt = uint64(block.number);
        r.allocationDeadline = uint64(block.number) + ACTIVATION_BLOCKS;
        r.state = 2;
        emit RoundFulfilled(roundId, requestId, uint64(block.number));
    }

    function candidates(bytes32 id) external view returns (Candidate[] memory) {
        return pools[id];
    }

    function roundInfo(uint256 id) external view returns (uint64, uint64, uint256, uint64, uint64, uint8, uint16) {
        Round storage r = rounds[id];
        return
            (r.closeBlock, r.randomnessDeadline, r.requestId, r.fulfilledAt, r.allocationDeadline, r.state, r.taskCount);
    }

    function requestInfo(bytes32 id) external view returns (uint256, uint64, uint64, uint64, uint64, uint8, uint8) {
        Request storage t = requests[id];
        Round storage r = rounds[taskRound[id]];
        uint8 state = t.state == 5 ? r.state : t.state;
        return (
            r.requestId,
            r.randomnessDeadline,
            r.fulfilledAt,
            r.allocationDeadline,
            t.maxSessionEnd,
            state,
            uint8(pools[id].length)
        );
    }

    /// @notice Net admission charge after the round's VRF request; the remainder of the prepaid cap is refundable.
    function admissionCharge(bytes32 id, address token) external view returns (uint256) {
        uint256 roundId = taskRound[id];
        if (roundId == 0) return 0;
        Round storage r = rounds[roundId];
        return r.requestId == 0 ? 0 : admissionFee[token] / r.taskCount;
    }

    function canExpire(bytes32 id) external view returns (bool) {
        Request storage t = requests[id];
        Round storage r = rounds[taskRound[id]];
        return t.state == 5
            && ((r.state == 5 || r.state == 1)
                && block.number > r.randomnessDeadline
                || r.state == 2
                && block.number > r.allocationDeadline);
    }

    function allocate(bytes32 id) external onlyMarket returns (address a, address b, uint64 activation) {
        Request storage r = requests[id];
        Round storage round = rounds[taskRound[id]];
        require(r.state == 5 && round.state == 2 && block.number <= round.allocationDeadline, InvalidAdmission());
        Candidate[] storage pool = pools[id];
        uint256 weight;
        for (uint256 j; j < pool.length; j++) {
            weight += pool[j].weight;
        }
        uint256 draw = uint256(
            keccak256(abi.encode("AIGG_ROUND_VRF_FIRST_V1", round.word, taskRound[id], id, r.snapshotHash))
        ) % weight;
        uint256 first;
        for (uint256 j; j < pool.length; j++) {
            if (draw < pool[j].weight) {
                first = j;
                a = pool[j].host;
                break;
            }
            draw -= pool[j].weight;
        }
        draw = uint256(keccak256(abi.encode("AIGG_ROUND_VRF_SECOND_V1", round.word, taskRound[id], id, r.snapshotHash)))
            % (weight - pool[first].weight);
        for (uint256 j; j < pool.length; j++) {
            if (j == first) continue;
            if (draw < pool[j].weight) {
                b = pool[j].host;
                break;
            }
            draw -= pool[j].weight;
        }
        r.state = 3;
        activation = round.allocationDeadline;
        for (uint256 j; j < pool.length; j++) {
            address host = pool[j].host;
            if (host != a && host != b) _release(id, host);
        }
        emit Allocated(id, a, b);
    }

    function pendingTasks(address host) external view returns (bytes32[] memory) {
        return pending[host];
    }

    function pendingTask(address host) external view returns (bytes32) {
        return pending[host].length == 0 ? bytes32(0) : pending[host][0];
    }

    function hasPendingTask(bytes32 id, address host) external view returns (bool) {
        return pendingIndex[id][host] != 0;
    }

    function _release(bytes32 id, address host) private {
        uint256 index = pendingIndex[id][host];
        if (index == 0) return;
        bytes32[] storage ids = pending[host];
        bytes32 last = ids[ids.length - 1];
        ids[index - 1] = last;
        pendingIndex[last][host] = index;
        ids.pop();
        delete pendingIndex[id][host];
        if (ids.length == 0) {
            delete hostRound[host];
            _remove(host);
        }
        instances.release(host);
        IVrfMarket(MARKET).hostCapacity().release(id, host);
    }

    function release(bytes32 id) external onlyMarket {
        Request storage r = requests[id];
        require(r.state != 0 && r.state != 4, InvalidAdmission());
        r.state = 4;
        for (uint256 j; j < pools[id].length; j++) {
            _release(id, pools[id][j].host);
        }
    }
}
