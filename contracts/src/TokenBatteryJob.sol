// SPDX-License-Identifier: 0BSD
pragma solidity ^0.8.20;
import "./BatteryJob.sol";
import "./MultiAssetTaskMarket.sol";

/// Each job owns its own ERC-20 balance and is the market client, so asynchronous market refunds cannot mix jobs.
contract TokenBatteryJob {
    address public immutable paymentToken;
    FlyCollection public immutable collection;
    MultiAssetTaskMarket public immutable market;
    bool public immutable synchronous;
    address public immutable operator;
    address public immutable payer;
    uint256 public immutable tokenId;
    uint256 public immutable expiresAt;
    BatteryPolicy public policy;
    bytes32 public taskId;
    uint256 public attempt;
    bytes32 public artifactHash;
    bool public closed;
    bool private busy;
    event Posted(bytes32 indexed taskId, uint256 attempt);
    event Delivered(bytes32 indexed taskId, bytes32 artifactHash);
    event Refunded(address indexed payer, uint256 amount);
    modifier guard() { require(!busy, "reentrant"); busy = true; _; busy = false; }
    modifier worker() { require(msg.sender == operator, "operator"); _; }
    constructor(FlyCollection c, MultiAssetTaskMarket m, address op, address who, uint256 id, BatteryPolicy memory p,address token) {
        synchronous=BatterySettlement.isSynchronous(address(m));
        paymentToken=token;
        collection=c; market=m; operator=op; payer=who; tokenId=id; policy=p; expiresAt=block.timestamp+p.lifetime;

    }

    function settledFinal() public view returns (bool) {
        if (taskId == bytes32(0)) return true;
        if(synchronous){uint8 phase=BatterySettlement.phase(address(market),taskId);return phase==4||phase==5;}
        (,,,, uint64 at, bool exists, bool settled, bool disputed,) = market.tasks(taskId);
        return exists && settled && (!disputed || market.disputeResolved(taskId)) && block.number > uint256(at) + market.challengeWindow();
    }
    function accepted() public view returns (bool) {
        if (taskId == bytes32(0) || !settledFinal()) return false;
        if(synchronous)return BatterySettlement.phase(address(market),taskId)==4;
        (,,,,,,,, bool repudiated) = market.tasks(taskId);
        if (repudiated) return false;
        address ref = market.settledRef(taskId); if (ref == address(0)) return false;
        (,bytes32 root) = market.resultOf(taskId, ref);
        address[] memory ex=market.executors(taskId); uint256 count;
        for(uint256 i;i<ex.length;i++) if(market.submitted(taskId,ex[i])) {
            (,bytes32 r)=market.resultOf(taskId,ex[i]); if(r==root) count++;
        }
        return count>=policy.redundancy;
    }
    function post(uint64 deadline) external worker guard returns(bytes32 id) {
        require(!closed && block.timestamp < expiresAt && attempt < policy.attempts, "job closed/exhausted");
        require(settledFinal() && !accepted(), "active/accepted task");
        if(synchronous)BatterySettlement.pull(address(market),paymentToken);
        require(IERC20Budget(paymentToken).balanceOf(address(this))>=policy.fee && deadline>block.number, "funds/deadline");
        (,,,bytes32 mepId,,,,,,)=collection.individuals(tokenId); require(mepId!=bytes32(0), "waiting model");
        ITaskMarket.Task memory t=ITaskMarket.Task(mepId,0,policy.steps,policy.stride,policy.runsRoot,policy.fee,deadline,policy.redundancy);
        bytes32 nonce=keccak256(abi.encode(address(this), ++attempt));
        TokenTransfer.approve(paymentToken,address(market),policy.fee);
        id=market.postTokenBatch(t,paymentToken,policy.runs,nonce);
        TokenTransfer.approve(paymentToken,address(market),0); taskId=id; emit Posted(id,attempt);
    }
    function deliver(bytes32 hash) external worker guard {
        require(!closed && hash!=bytes32(0) && accepted(), "not final delivery");
        artifactHash=hash; closed=true; emit Delivered(taskId,hash);
    }
    function refund() external guard {
        require(msg.sender==payer && (closed || block.timestamp>=expiresAt) && settledFinal(), "refund unavailable");
        if(synchronous)BatterySettlement.pull(address(market),paymentToken);
        closed=true; uint256 amount=IERC20Budget(paymentToken).balanceOf(address(this)); require(amount>0,"empty");
        TokenTransfer.send(paymentToken,payer,amount); emit Refunded(payer,amount);
    }
}
