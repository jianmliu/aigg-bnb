// SPDX-License-Identifier: 0BSD
pragma solidity ^0.8.20;
import "./TokenBatteryJob.sol";
interface IExactOutputRouter {
 function getAmountsIn(uint amountOut,address[] calldata path) external view returns(uint[] memory);
 function WETH() external view returns(address);
 function swapETHForExactTokens(uint amountOut,address[] calldata path,address to,uint deadline) external payable returns(uint[] memory);
}
/// Separate, optional token budget factory. Native BatteryBudget remains independently usable.
/// The user's transaction authorizes its parents, maximum BNB spend (msg.value), and absolute deadline.
contract TokenBatteryBudget {
    FlyCollection public immutable collection;
    MultiAssetTaskMarket public immutable market;
    address public immutable operator;
    address public immutable paymentToken;
    IExactOutputRouter public immutable router;
    address public immutable wrappedNative;
    BatteryPolicy public policy;
    mapping(uint256=>address) public jobOf;
    bool private busy;
    event Funded(uint256 indexed tokenId,address indexed job,address indexed payer,address paymentToken,uint256 amount);
    event BudgetPurchased(address indexed payer,uint256 nativeSpent,uint256 tokenAmount);
    modifier guard(){require(!busy,"reentrant");busy=true;_;busy=false;}
    constructor(FlyCollection c,MultiAssetTaskMarket m,address op,BatteryPolicy memory p,address token,IExactOutputRouter r){
        require(address(c).code.length>0&&address(m).code.length>0&&op!=address(0)&&token.code.length>0,"configuration");
        require(p.versionHash!=0&&p.runsRoot!=0&&p.runs>=2&&p.runs<=4096,"battery");
        require(p.steps>0&&p.stride>0&&p.steps%p.stride==0&&p.redundancy>=2&&p.attempts>0&&p.attempts<=10&&p.fee>0&&p.lifetime>0,"terms");
        require(c.ROYALTY_BPS()==0||(address(c.MARKET())==address(m)&&c.supportsTokenRoyalties()),"royalty market");
        require(m.tokenAllowed(token),"token not enabled");
        collection=c;market=m;operator=op;policy=p;paymentToken=token;router=r;
        wrappedNative=address(r)==address(0)?address(0):r.WETH();
        require(address(r)==address(0)||(address(r).code.length>0&&wrappedNative!=address(0)&&wrappedNative!=token),"router");
    }
    receive() external payable {require(msg.sender==address(router),"router refund only");}
    function budget() public view returns(uint256){return policy.fee*policy.attempts;}
    function quoteNativeInput() external view returns(uint256){
        require(address(router)!=address(0),"no router");address[] memory path=new address[](2);path[0]=wrappedNative;path[1]=paymentToken;
        uint256[] memory amounts=router.getAmountsIn(budget(),path);require(amounts.length==2&&amounts[1]==budget(),"quote");return amounts[0];
    }
    function _fund(uint256 id,address who) internal returns(address job){
        require(jobOf[id]==address(0),"already funded");
        job=address(new TokenBatteryJob(collection,market,operator,who,id,policy,paymentToken));
        jobOf[id]=job;TokenTransfer.send(paymentToken,job,budget());
        emit Funded(id,job,who,paymentToken,budget());
    }
    function fund(uint256 id) external guard returns(address){
        require(collection.ownerOf(id)==msg.sender,"owner");
        TokenTransfer.pull(paymentToken,msg.sender,address(this),budget());return _fund(id,msg.sender);
    }
    function _parents(uint256 a,uint256 b) internal view {
        require(collection.ownerOf(a)==msg.sender&&collection.ownerOf(b)==msg.sender,"parent owner");
    }
    function _breed(uint256 a,uint256 b) internal returns(uint256 id){
        id=collection.breed{value:collection.BREED_FEE()}(a,b);_fund(id,msg.sender);
        collection.safeTransferFrom(address(this),msg.sender,id);
    }
    function breed(uint256 a,uint256 b) external payable guard returns(uint256 id){
        _parents(a,b);require(msg.value==collection.BREED_FEE(),"breed fee");
        TokenTransfer.pull(paymentToken,msg.sender,address(this),budget());return _breed(a,b);
    }
    function breedWithBNB(uint256 a,uint256 b,uint256 deadline) external payable guard returns(uint256 id){
        _parents(a,b);uint256 fee=collection.BREED_FEE();
        require(address(router)!=address(0)&&block.timestamp<=deadline&&msg.value>fee,"swap terms");
        uint256 beforeNative=address(this).balance-msg.value;
        uint256 beforeToken=IERC20Budget(paymentToken).balanceOf(address(this));
        address[] memory path=new address[](2);path[0]=wrappedNative;path[1]=paymentToken;
        uint256[] memory amounts=router.swapETHForExactTokens{value:msg.value-fee}(budget(),path,address(this),deadline);
        require(amounts.length==2&&amounts[0]<=msg.value-fee&&amounts[1]==budget(),"swap quote");
        require(IERC20Budget(paymentToken).balanceOf(address(this))==beforeToken+budget(),"swap output");
        require(address(this).balance==beforeNative+msg.value-amounts[0],"swap refund");
        id=_breed(a,b);
        uint256 excess=msg.value-fee-amounts[0];
        if(excess>0){(bool ok,)=msg.sender.call{value:excess}("");require(ok,"refund");}
        emit BudgetPurchased(msg.sender,amounts[0],budget());
    }
}
