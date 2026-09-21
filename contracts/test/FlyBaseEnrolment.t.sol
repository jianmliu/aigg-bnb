// SPDX-License-Identifier: 0BSD
pragma solidity ^0.8.20;
import "forge-std/Test.sol";
import "../src/FlyCollection.sol";
import "aigg-porw/mesh/MEPRegistry.sol";
import "aigg-porw/mesh/InstanceRegistry.sol";
contract FlyBaseEnrolmentTest is Test {
 MEPRegistry r; InstanceRegistry inst; FlyCollection c;
 bytes32 bf=keccak256("female");bytes32 bm=keccak256("male");bytes32 df=keccak256("df");bytes32 dm=keccak256("dm");bytes32 f;bytes32 m;
 function profile(bytes32 model) internal pure returns(IMEPRegistry.MEP memory){return IMEPRegistry.MEP(model,SCHEME_SKETCH_TILE_KECCAK_V3,keccak256("exec"),100,200,keccak256(abi.encode(model)),bytes("https://test.invalid/model"));}
 function leaf(uint32 i,uint8 sex,bytes32 delta) internal pure returns(bytes32){return keccak256(abi.encode(i,sex,delta));}
 function setUp() public {r=new MEPRegistry();inst=new InstanceRegistry(1 ether,100);inst.setMEPRegistry(address(r));f=r.registerMEP(profile(bf));m=r.registerMEP(profile(bm));bytes32 a=leaf(0,0,df);bytes32 b=leaf(1,1,dm);bytes32 root=a<b?keccak256(abi.encodePacked(a,b)):keccak256(abi.encodePacked(b,a));
 c=new FlyCollection(bf,bm,root,2,0,0,0,0,address(0x123),r,IInstanceBonding(address(inst)),LineageRegistry(address(0)),f,m,IRoyaltyMarket(address(0)),0,FlyCollection.Shares(address(0),0,0,address(0)));
 bytes32[] memory p=new bytes32[](1);p[0]=b;c.mint(0,0,df,p);p[0]=a;c.mint(1,1,dm,p);}
 function test_foundersBindToOwnBaseAndPlainRegistrationCannotSquat() public {
  IMEPRegistry.MEP memory child=profile(keccak256("child"));bytes32 plain=r.registerMEP(child);bytes32 id=c.register(1,df,child);assertTrue(id!=plain);assertEq(r.baseOf(id),f);assertEq(inst.enrollmentMep(id),f);
  bytes32 male=c.register(2,dm,profile(keccak256("mchild")));assertEq(r.baseOf(male),m);
 }
 function test_bredMaleStillUsesMaternalBasePool() public {uint256 kid=c.breed(1,2);vm.roll(block.number+2);c.hatch(kid);bytes32 id=c.register(kid,keccak256("kid-delta"),profile(keccak256("kid")));assertEq(r.baseOf(id),f);}
 function test_derivedPreregistrationIsReusable() public {IMEPRegistry.MEP memory child=profile(keccak256("pre"));bytes32 pre=r.registerDerivedMEP(child,f);assertEq(c.register(1,df,child),pre);}
 function test_baseIdentityWrapsBeforeCollectionRoyalty() public {
  bytes32 root=leaf(0,0,df);
  FlyCollection royalty=new FlyCollection(bf,bm,root,1,0,0,0,0,address(0x123),r,IInstanceBonding(address(inst)),LineageRegistry(address(0)),f,m,IRoyaltyMarket(address(0x999)),1000,FlyCollection.Shares(address(0),0,0,address(0)));
  royalty.mint(0,0,df,new bytes32[](0));IMEPRegistry.MEP memory child=profile(keccak256("royalty-child"));
  bytes32 pre=r.registerDerivedMEPWithTerms(child,f,address(royalty),1000);
  assertEq(royalty.register(1,df,child),pre);assertEq(r.baseOf(pre),f);
  (address beneficiary,uint16 bps)=r.termsOf(pre);assertEq(beneficiary,address(royalty));assertEq(bps,1000);
 }
}
