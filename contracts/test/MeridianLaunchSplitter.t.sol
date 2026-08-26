// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {MeridianLaunchSplitter, MeridianSplitterFactory} from "../MeridianLaunchSplitter.sol";

contract MockToken {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "bal");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract MockEscrow {
    MockToken public token;
    mapping(address => uint256) public nativeOwed;
    mapping(address => mapping(address => uint256)) public tokenOwed;

    constructor(MockToken token_) {
        token = token_;
    }

    receive() external payable {}

    function owe(address recipient, uint256 amount) external payable {
        nativeOwed[recipient] += amount;
    }

    function oweToken(address recipient, uint256 amount) external {
        tokenOwed[recipient][address(token)] += amount;
    }

    function balanceOf(address recipient) external view returns (uint256) {
        return nativeOwed[recipient];
    }

    function balanceOfToken(address recipient, address t) external view returns (uint256) {
        return tokenOwed[recipient][t];
    }

    function claim() external {
        uint256 amt = nativeOwed[msg.sender];
        nativeOwed[msg.sender] = 0;
        (bool ok,) = msg.sender.call{value: amt}("");
        require(ok, "send");
    }

    function claimToken(address t) external {
        uint256 amt = tokenOwed[msg.sender][t];
        tokenOwed[msg.sender][t] = 0;
        MockToken(t).transfer(msg.sender, amt);
    }
}

contract MeridianLaunchSplitterTest is Test {
    address team = makeAddr("team");
    address treasury = makeAddr("treasury");
    address rando = makeAddr("rando");
    MockToken usdg;
    MockEscrow escrow;
    MeridianLaunchSplitter splitter;

    function setUp() public {
        usdg = new MockToken();
        escrow = new MockEscrow(usdg);
        splitter = new MeridianLaunchSplitter(team, treasury, address(escrow));
    }

    function test_constructor_rejectsZeroAddresses() public {
        vm.expectRevert(MeridianLaunchSplitter.ZeroAddress.selector);
        new MeridianLaunchSplitter(address(0), treasury, address(escrow));
        vm.expectRevert(MeridianLaunchSplitter.ZeroAddress.selector);
        new MeridianLaunchSplitter(team, address(0), address(escrow));
    }

    function test_erc20_split_is_80_20() public {
        usdg.mint(address(splitter), 1000e6);
        vm.prank(rando); // permissionless crank
        splitter.split(address(usdg));
        assertEq(usdg.balanceOf(treasury), 200e6, "router share");
        assertEq(usdg.balanceOf(team), 800e6, "team share");
    }

    function test_native_split_is_80_20() public {
        vm.deal(address(splitter), 10 ether);
        splitter.split(address(0));
        assertEq(treasury.balance, 2 ether);
        assertEq(team.balance, 8 ether);
    }

    function test_rounding_dust_goes_to_team() public {
        usdg.mint(address(splitter), 9_999);
        splitter.split(address(usdg));
        assertEq(usdg.balanceOf(treasury), 1_999); // floor of 19.99 percent
        assertEq(usdg.balanceOf(team), 8_000);
    }

    function test_zero_balance_is_a_noop() public {
        splitter.split(address(usdg));
        splitter.split(address(0));
        assertEq(usdg.balanceOf(treasury), 0);
        assertEq(treasury.balance, 0);
    }

    function test_claimAndSplit_pulls_erc20_from_escrow() public {
        usdg.mint(address(escrow), 500e6);
        escrow.oweToken(address(splitter), 500e6);
        vm.prank(rando);
        splitter.claimAndSplit(address(usdg));
        assertEq(usdg.balanceOf(treasury), 100e6);
        assertEq(usdg.balanceOf(team), 400e6);
        assertEq(escrow.balanceOfToken(address(splitter), address(usdg)), 0);
    }

    function test_claimAndSplit_pulls_native_from_escrow() public {
        vm.deal(address(escrow), 4 ether);
        escrow.owe(address(splitter), 4 ether);
        splitter.claimAndSplit(address(0));
        assertEq(treasury.balance, 0.8 ether);
        assertEq(team.balance, 3.2 ether);
    }

    function test_split_ratio_constant_is_20_percent() public view {
        assertEq(splitter.ROUTER_BPS(), 2000);
    }

    function test_factory_create_matches_predict_and_pins_parties() public {
        MeridianSplitterFactory factory = new MeridianSplitterFactory(treasury, address(escrow));
        bytes32 salt = keccak256("first-launch");
        address predicted = factory.predict(team, salt);
        address created = factory.create(team, salt);
        assertEq(created, predicted, "CREATE2 prediction");
        MeridianLaunchSplitter s = MeridianLaunchSplitter(payable(created));
        assertEq(s.team(), team);
        assertEq(s.treasury(), treasury);
        assertEq(address(s.escrow()), address(escrow));
    }

    function test_factory_same_salt_cannot_deploy_twice() public {
        MeridianSplitterFactory factory = new MeridianSplitterFactory(treasury, address(escrow));
        bytes32 salt = keccak256("dup");
        factory.create(team, salt);
        vm.expectRevert();
        factory.create(team, salt);
    }

    function test_factory_isSplitter_is_provenance_not_selfreport() public {
        // The forgery the registry must resist (audit finding 2): a look-alike
        // splitter reporting the real treasury while it is NOT ours.
        MeridianSplitterFactory factory = new MeridianSplitterFactory(treasury, address(escrow));
        address real = factory.create(team, keccak256("genuine"));
        assertTrue(factory.isSplitter(real), "a factory-made splitter is recognized");

        // A hand-deployed splitter with identical getters (team/treasury) is
        // NOT recognized, because the factory never made it.
        MeridianLaunchSplitter forged = new MeridianLaunchSplitter(team, treasury, address(escrow));
        assertEq(forged.treasury(), treasury, "the forgery's getter LIES convincingly");
        assertFalse(factory.isSplitter(address(forged)), "but provenance exposes it");
        assertFalse(factory.isSplitter(address(0xdead)), "and an arbitrary address is not a splitter");
    }
}
