// SPDX-License-Identifier: 0BSD
pragma solidity ^0.8.20;
import "aigg-porw/mesh/InstanceRegistry.sol";
import "aigg-porw/mesh/HostCapacity.sol";

interface IVrfMarket {
    function hostCapacity() external view returns (HostCapacity);
    function readinessSigner(address) external view returns (address);
    function acceptedToken(address, address) external view returns (bool);
}

interface IVrfCoordinatorV25 {
    struct RandomWordsRequest {
        bytes32 keyHash;
        uint256 subId;
        uint16 requestConfirmations;
        uint32 callbackGasLimit;
        uint32 numWords;
        bytes extraArgs;
    }
    function requestRandomWords(RandomWordsRequest calldata request) external returns (uint256);
}

/// @notice Immutable VRF v2.5 admission controller. The global opt-in roster bounds all scans.
/// Capacity leases and bond holds belong to this controller for their entire lifetime.
contract VrfAdmission {
    error InvalidAdmission();

    struct Config {
        address coordinator;
        bytes32 keyHash;
        uint256 subId;
        uint16 requestConfirmations;
        uint32 callbackGasLimit;
        bool nativePayment;
        uint64 waitBlocks;
        uint64 activationBlocks;
        uint64 readyTTL;
        address feeRecipient;
    }

    struct Request {
        uint256 requestId;
        uint64 randomnessDeadline;
        uint64 fulfilledAt;
        uint64 allocationDeadline;
        uint64 maxSessionEnd;
        uint8 state;
        uint256 word;
        bytes32 snapshotHash;
    }

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
    mapping(address => bytes32) public pendingTask;
    mapping(bytes32 => Request) private requests;
    mapping(bytes32 => Candidate[]) private pools;
    mapping(uint256 => bytes32) public requestTask;
    mapping(bytes32 => mapping(address => address)) public taskSigner;
    event ReadinessChanged(address indexed host, bool ready, uint256 nonce);
    event RandomnessRequested(
        bytes32 indexed taskId, uint256 indexed requestId, bytes32 snapshotHash, uint8 candidates
    );
    event RandomnessFulfilled(bytes32 indexed taskId, uint256 indexed requestId, uint64 fulfilledAt);
    event Allocated(bytes32 indexed taskId, address first, address second);
    modifier onlyMarket() {
        require(msg.sender == MARKET, InvalidAdmission());
        _;
    }

    constructor(InstanceRegistry registry, Config memory c, address[] memory tokens, uint256[] memory fees) {
        require(
            c.coordinator.code.length > 0 && c.keyHash != bytes32(0) && c.subId != 0 && c.requestConfirmations > 0
                && c.callbackGasLimit >= 100000 && c.waitBlocks > 0 && c.activationBlocks > 0 && c.readyTTL > 0
                && c.feeRecipient != address(0) && tokens.length == fees.length,
            InvalidAdmission()
        );
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
            pendingTask[host] == 0 && instances.weightOf(host) > 0 && instances.exitAt(host) == 0
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
        r.state = 1;
        r.randomnessDeadline = uint64(block.number) + WAIT_BLOCKS;
        r.maxSessionEnd = maxEnd;
        HostCapacity capacity = IVrfMarket(MARKET).hostCapacity();
        uint256 cap = instances.weightCap(mepId);
        bytes32 hash = keccak256(abi.encode(block.chainid, MARKET, id, mepId, token, epoch, maxEnd));
        for (uint256 j; j < MAX_CANDIDATES; j++) {
            address host = readyRoster[j];
            if (
                host == address(0) || !ready(host) || pendingTask[host] != 0
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
            _remove(host);
            pendingTask[host] = id;
            instances.hold(host);
            pools[id].push(Candidate(host, signer, weight));
            taskSigner[id][host] = signer;
            hash = keccak256(abi.encode(hash, host, signer, weight));
        }
        uint8 count = uint8(pools[id].length);
        require(count >= 2, InvalidAdmission());
        r.snapshotHash = hash;
        // The callback cannot match until the coordinator returns and its id is bound below.
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
        require(requestId != 0 && requestTask[requestId] == 0, InvalidAdmission());
        r.requestId = requestId;
        requestTask[requestId] = id;
        emit RandomnessRequested(id, requestId, hash, count);
    }

    /// @notice No candidate loops, payments or market calls in the coordinator callback.
    function rawFulfillRandomWords(uint256 requestId, uint256[] calldata words) external {
        require(msg.sender == coordinator, InvalidAdmission());
        bytes32 id = requestTask[requestId];
        if (id == 0 || words.length != 1) return;
        Request storage r = requests[id];
        if (r.state != 1 || block.number > r.randomnessDeadline) return;
        r.word = words[0];
        r.fulfilledAt = uint64(block.number);
        r.allocationDeadline = uint64(block.number) + ACTIVATION_BLOCKS;
        r.state = 2;
        emit RandomnessFulfilled(id, requestId, uint64(block.number));
    }

    function candidates(bytes32 id) external view returns (Candidate[] memory) {
        return pools[id];
    }

    function requestInfo(bytes32 id) external view returns (uint256, uint64, uint64, uint64, uint64, uint8, uint8) {
        Request storage r = requests[id];
        return (
            r.requestId,
            r.randomnessDeadline,
            r.fulfilledAt,
            r.allocationDeadline,
            r.maxSessionEnd,
            r.state,
            uint8(pools[id].length)
        );
    }

    function canExpire(bytes32 id) external view returns (bool) {
        Request storage r = requests[id];
        return
            (r.state == 1 && block.number > r.randomnessDeadline)
                || (r.state == 2 && block.number > r.allocationDeadline);
    }

    function allocate(bytes32 id) external onlyMarket returns (address a, address b, uint64 activation) {
        Request storage r = requests[id];
        require(r.state == 2 && block.number <= r.allocationDeadline, InvalidAdmission());
        Candidate[] storage pool = pools[id];
        uint256 weight;
        for (uint256 j; j < pool.length; j++) {
            weight += pool[j].weight;
        }
        uint256 draw = uint256(keccak256(abi.encode("AIGG_VRF_FIRST_V1", r.word, id, r.snapshotHash))) % weight;
        uint256 first;
        for (uint256 j; j < pool.length; j++) {
            if (draw < pool[j].weight) {
                first = j;
                a = pool[j].host;
                break;
            }
            draw -= pool[j].weight;
        }
        draw = uint256(keccak256(abi.encode("AIGG_VRF_SECOND_V1", r.word, id, r.snapshotHash)))
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
        activation = r.allocationDeadline;
        for (uint256 j; j < pool.length; j++) {
            address host = pool[j].host;
            if (host != a && host != b) _release(id, host);
        }
        emit Allocated(id, a, b);
    }

    function _release(bytes32 id, address host) private {
        if (pendingTask[host] != id) return;
        delete pendingTask[host];
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
