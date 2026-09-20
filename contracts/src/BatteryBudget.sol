// SPDX-License-Identifier: 0BSD
pragma solidity ^0.8.20;
import "./BatteryJob.sol";

/// Atomic breeding plus earmarked battery budget, compatible with an existing collection.
/// Parents must belong to the caller and approve this adapter; the child is transferred back in this transaction.
contract BatteryBudget {
    FlyCollection public immutable collection;
    TaskMarket public immutable market;
    address public immutable operator;
    BatteryPolicy public policy;
    mapping(uint256=>address) public jobOf;
    bool private busy;
    event Funded(uint256 indexed tokenId,address indexed job,address indexed payer,bytes32 versionHash,uint256 amount);
    modifier guard(){require(!busy,"reentrant");busy=true;_;busy=false;}
    constructor(FlyCollection c,TaskMarket m,address op,BatteryPolicy memory p){
        require(address(c).code.length>0 && address(m).code.length>0 && op!=address(0),"configuration");
        require(p.versionHash!=bytes32(0)&&p.runsRoot!=bytes32(0)&&p.runs>=2&&p.runs<=4096,"battery");
        require(p.steps>0&&p.stride>0&&p.steps%p.stride==0&&p.redundancy>=2&&p.attempts>0&&p.attempts<=10&&p.fee>0&&p.lifetime>0,"terms");
        collection=c;market=m;operator=op;policy=p;
    }
    function budget() public view returns(uint256){return policy.fee*policy.attempts;}
    function _fund(uint256 id,address who) internal returns(address job){
        require(jobOf[id]==address(0),"already funded");
        job=address(new BatteryJob{value:budget()}(collection,market,operator,who,id,policy));jobOf[id]=job;
        emit Funded(id,job,who,policy.versionHash,budget());
    }
    function fund(uint256 id) external payable guard returns(address){
        require(collection.ownerOf(id)==msg.sender && msg.value==budget(),"owner/budget");return _fund(id,msg.sender);
    }
    function breed(uint256 a,uint256 b) external payable guard returns(uint256 id){
        require(collection.ownerOf(a)==msg.sender && collection.ownerOf(b)==msg.sender,"parent owner");
        uint256 fee=collection.BREED_FEE();require(msg.value==fee+budget(),"fee and budget");
        id=collection.breed{value:fee}(a,b); _fund(id,msg.sender);
        collection.safeTransferFrom(address(this),msg.sender,id);
    }
}
