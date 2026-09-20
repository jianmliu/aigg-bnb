// SPDX-License-Identifier: 0BSD
pragma solidity ^0.8.20;
import "./FlyCollection.sol";
import "aigg-porw/mesh/TaskMarket.sol";

/// One fixed, versioned battery policy. Redeploy to change terms; existing jobs retain theirs.
struct BatteryPolicy {
    bytes32 versionHash; bytes32 runsRoot; uint32 runs; uint32 steps; uint32 stride;
    uint8 redundancy; uint8 attempts; uint256 fee; uint64 lifetime;
}

/// Each job owns its own native balance and is the market client, so asynchronous market refunds cannot mix jobs.
contract BatteryJob {
    FlyCollection public immutable collection;
    TaskMarket public immutable market;
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
    constructor(FlyCollection c, TaskMarket m, address op, address who, uint256 id, BatteryPolicy memory p) payable {
        collection=c; market=m; operator=op; payer=who; tokenId=id; policy=p; expiresAt=block.timestamp+p.lifetime;
        require(msg.value == p.fee * p.attempts, "budget");
    }
    receive() external payable { require(msg.sender == address(market), "market refund only"); }
    function settledFinal() public view returns (bool) {
        if (taskId == bytes32(0)) return true;
        (,,,, uint64 at, bool exists, bool settled, bool disputed,) = market.tasks(taskId);
        if(disputed){
            // New multi-asset markets distinguish historical disputes from unresolved ones.
            (bool ok,bytes memory data)=address(market).staticcall(abi.encodeWithSignature("disputeResolved(bytes32)",taskId));
            if(ok&&data.length==32&&abi.decode(data,(bool)))disputed=false;
        }
        return exists && settled && !disputed && block.number > uint256(at) + market.challengeWindow();
    }
    function accepted() public view returns (bool) {
        if (taskId == bytes32(0) || !settledFinal()) return false;
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
        require(address(this).balance>=policy.fee && deadline>block.number, "funds/deadline");
        (,,,bytes32 mepId,,,,,,)=collection.individuals(tokenId); require(mepId!=bytes32(0), "waiting model");
        ITaskMarket.Task memory t=ITaskMarket.Task(mepId,0,policy.steps,policy.stride,policy.runsRoot,policy.fee,deadline,policy.redundancy);
        bytes32 nonce=keccak256(abi.encode(address(this), ++attempt));
        id=market.postBatch{value:policy.fee}(t,policy.runs,nonce); taskId=id; emit Posted(id,attempt);
    }
    function deliver(bytes32 hash) external worker guard {
        require(!closed && hash!=bytes32(0) && accepted(), "not final delivery");
        artifactHash=hash; closed=true; emit Delivered(taskId,hash);
    }
    function refund() external guard {
        require(msg.sender==payer && (closed || block.timestamp>=expiresAt) && settledFinal(), "refund unavailable");
        closed=true; uint256 amount=address(this).balance; require(amount>0,"empty");
        (bool ok,)=payer.call{value:amount}(""); require(ok,"refund"); emit Refunded(payer,amount);
    }
}
