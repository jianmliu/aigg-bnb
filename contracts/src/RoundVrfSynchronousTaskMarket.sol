// SPDX-License-Identifier: 0BSD
pragma solidity ^0.8.20;
import "./SynchronousTaskMarket.sol";
import "./RoundVrfAdmission.sol";

/// @notice The v1 execution protocol with task-and-pool locking before unknown VRF randomness.
contract RoundVrfSynchronousTaskMarket is SynchronousTaskMarket {
    uint256 public constant admissionVersion = 3;
    RoundVrfAdmission public immutable admission;
    uint64 private immutable sessionWindow;
    mapping(address => uint256) public admissionFeesAccrued;
    event AdmissionFeeAccrued(address indexed token, address indexed recipient, uint256 fee);

    constructor(
        IMEPRegistry m,
        InstanceRegistry i,
        PoRWClaimManager cm,
        uint64 commitBlocks,
        uint64 revealBlocks,
        uint64 disputeBlocks,
        VrfAdmission.Config memory config,
        address[] memory tokens,
        uint256[] memory fees,
        uint64 roundBlocks,
        uint8 maxRoundTasks
    ) SynchronousTaskMarket(m, i, cm, commitBlocks, revealBlocks, disputeBlocks) {
        admission = new RoundVrfAdmission(i, config, tokens, fees, roundBlocks, maxRoundTasks);
        sessionWindow = TASK_TIMEOUT + roundBlocks + config.waitBlocks + config.activationBlocks;
    }

    function ready(address host) public view override returns (bool) {
        return admission.ready(host);
    }

    function readinessNonce(address host) public view override returns (uint256) {
        return admission.readinessNonce(host);
    }

    function pendingTask(address host) public view override returns (bytes32) {
        return admission.pendingTask(host);
    }

    function pendingTasks(address host) external view returns (bytes32[] memory) {
        return admission.pendingTasks(host);
    }

    function hasPendingTask(bytes32 id, address host) public view override returns (bool) {
        return admission.hasPendingTask(id, host);
    }

    function _setReadinessSigner(address host, address signer) internal override {
        // A live-authorized owner may revoke readiness without replacing reserved task routing.
        if (pendingTask(host) == 0) readinessSigner[host] = signer;
    }

    function sealRound(uint256 roundId) external guard {
        admission.sealRound(roundId);
    }

    function taskSigner(bytes32 id, address host) external view returns (address) {
        return admission.taskSigner(id, host);
    }

    function admissionFee(address token) external view returns (uint256) {
        return admission.admissionFee(token);
    }

    function _ready(address host, bool value) internal override {
        admission.setReady(host, value);
        emit ReadinessChanged(host, value, readinessNonce(host));
    }

    function _sessionWindow() internal view override returns (uint64) {
        return sessionWindow;
    }

    function _charge(address token, uint256 fee) internal override returns (uint256) {
        uint256 cost = admission.admissionFee(token);
        require(cost > 0, InvalidSession());
        address recipient = admission.feeRecipient();
        credits[token][recipient] += cost;
        admissionFeesAccrued[token] += cost;
        emit AdmissionFeeAccrued(token, recipient, cost);
        return fee + cost;
    }

    function _admit(bytes32 id, address token, uint64 epoch, uint64 total) internal override {
        sessions[id] = Session(Status.AwaitingRandomness, 0, 0, total);
        admission.admit(id, tasks[id].t.mepId, token, epoch, total);
    }

    function allocate(bytes32 id) external guard {
        require(sessions[id].state == Status.AwaitingRandomness, InvalidSession());
        (address a, address b, uint64 activation) = admission.allocate(id);
        chosen[id].push(a);
        chosen[id].push(b);
        sessions[id] = Session(
            Status.Committing,
            activation + COMMIT_BLOCKS,
            activation + COMMIT_BLOCKS + REVEAL_BLOCKS,
            activation + TASK_TIMEOUT
        );
        emit SessionDeadlines(id, sessions[id].commitDeadline, sessions[id].revealDeadline, sessions[id].totalDeadline);
    }

    function expire(bytes32 id) public override {
        if (sessions[id].state == Status.AwaitingRandomness) {
            require(admission.canExpire(id), InvalidSession());
            _close(id, address(0), false);
        } else {
            super.expire(id);
        }
    }

    function _release(bytes32 id) internal override {
        admission.release(id);
    }
}
