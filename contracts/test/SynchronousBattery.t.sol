// SPDX-License-Identifier: 0BSD
pragma solidity ^0.8.20;
import "forge-std/Test.sol";
import "../src/TokenBatteryJob.sol";
import "./mocks/TestToken.sol";
contract BatterySessionMock {
 uint8 public phase=5; uint256 public posts;
 mapping(address=>mapping(address=>uint256)) public credits;
 function protocolVersion() external pure returns(uint256){return 1;}
 function sessionState(bytes32) external view returns(uint8,uint64,uint64,uint64){return(phase,0,0,0);}
 function setPhase(uint8 p) external{phase=p;}
 function tasks(bytes32) external view returns(ITaskMarket.Task memory,address,uint64,uint64,uint64,bool,bool,bool,bool){ITaskMarket.Task memory t;return(t,address(0),0,0,0,true,phase>=4,false,false);}
 function challengeWindow() external pure returns(uint64){return 0;}
 function settledRef(bytes32) external pure returns(address){return address(0xBEEF);}
 function resultOf(bytes32,address) external pure returns(bytes32,bytes32){return(bytes32(uint256(1)),bytes32(uint256(1)));}
 function executors(bytes32) external pure returns(address[] memory e){e=new address[](1);e[0]=address(0xBEEF);}
 function submitted(bytes32,address) external pure returns(bool){return true;}
 function postBatch(ITaskMarket.Task calldata,uint32,bytes32) external payable returns(bytes32){phase=1;return bytes32(++posts);}
 function postTokenBatch(ITaskMarket.Task calldata t,address token,uint32,bytes32) external returns(bytes32){TokenTransfer.pull(token,msg.sender,address(this),t.fee);phase=1;return bytes32(++posts);}
 function credit(address token,address job,uint256 n) external{credits[token][job]+=n;}
 function withdrawCredit(address token,address payable recipient) external returns(uint256 n){n=credits[token][msg.sender];credits[token][msg.sender]=0;if(token==address(0)){(bool ok,)=recipient.call{value:n}("");require(ok);}else TokenTransfer.send(token,recipient,n);}
 receive() external payable{}
}
contract SynchronousBatteryTest is Test {
 BatterySessionMock market; FlyCollection collection; BatteryPolicy policy;
 function setUp() public {
  market=new BatterySessionMock();collection=FlyCollection(payable(address(0xC011)));
  policy=BatteryPolicy(bytes32(uint256(1)),bytes32(uint256(2)),2,1,1,2,2,100,1000);
  vm.mockCall(address(collection),abi.encodeWithSignature("individuals(uint256)",1),abi.encode(uint256(0),uint256(0),bytes32(0),bytes32(uint256(1)),uint256(0),uint256(0),uint256(0),uint256(0),uint256(0),uint256(0)));
  vm.deal(address(this),10000);
 }
 function test_nativeAdjudicatedCompletionAcceptedWithoutMatchingBothRoots() public {
  BatteryJob j=new BatteryJob{value:200}(collection,TaskMarket(payable(address(market))),address(this),address(this),1,policy);
  j.post(uint64(block.number+100));market.setPhase(4);assertTrue(j.accepted());j.deliver(bytes32(uint256(1)));assertTrue(j.closed());
 }
 function test_nativeInconclusivePullRefundIncludedInPayerRefund() public {
  BatteryJob j=new BatteryJob{value:200}(collection,TaskMarket(payable(address(market))),address(this),address(this),1,policy);
  j.post(uint64(block.number+100));market.setPhase(5);market.credit(address(0),address(j),100);assertFalse(j.accepted());
  vm.warp(block.timestamp+1001);uint256 before_=address(this).balance;j.refund();assertEq(address(this).balance-before_,200);assertEq(market.credits(address(0),address(j)),0);
 }
 function test_tokenRefundRecoveredBeforeSecondAttemptAndFinalRefund() public {
  TestToken token=new TestToken();TokenBatteryJob j=new TokenBatteryJob(collection,MultiAssetTaskMarket(payable(address(market))),address(this),address(this),1,policy,address(token));token.mint(address(j),200);
  j.post(uint64(block.number+100));market.setPhase(5);market.credit(address(token),address(j),100);
  j.post(uint64(block.number+100));assertEq(token.balanceOf(address(j)),100);assertEq(market.credits(address(token),address(j)),0);
  market.setPhase(4);assertTrue(j.accepted());j.deliver(bytes32(uint256(3)));j.refund();assertEq(token.balanceOf(address(this)),100);
 }
 function test_nonterminalNeverAcceptedOrRefundable() public {
  BatteryJob j=new BatteryJob{value:200}(collection,TaskMarket(payable(address(market))),address(this),address(this),1,policy);
  j.post(uint64(block.number+100));vm.warp(block.timestamp+1001);assertFalse(j.accepted());vm.expectRevert();j.refund();
 }
 receive() external payable{}
}
