// SPDX-License-Identifier: GPL-3.0
pragma solidity >=0.8.0 <0.9.0;

import {IERC20} from "@openzeppelin/interfaces/IERC20.sol";

import "./ComposableCoW.base.t.sol";
import "../src/interfaces/IAggregatorV3Interface.sol";
import "../src/types/DutchAuction.sol";

contract ComposableCoWDutchAuctionTest is BaseComposableCoWTest {
    IERC20 constant SELL_TOKEN = IERC20(address(0x1));
    IERC20 constant BUY_TOKEN = IERC20(address(0x2));
    address constant SELL_ORACLE = address(0x3);
    address constant BUY_ORACLE = address(0x4);
    bytes32 constant APP_DATA = bytes32(0x0);

    DutchAuction dutchAuction;
    address safe;

    function setUp() public virtual override(BaseComposableCoWTest) {
        super.setUp();

        dutchAuction = new DutchAuction();
    }

    function priceToAddress(int256 price) internal returns (address) {
        return address(uint160(int160(price)));
    }

    function mockOracle(address mock, int256 price) internal returns (IAggregatorV3Interface iface) {
        iface = IAggregatorV3Interface(mock);
        vm.mockCall(mock, abi.encodeWithSelector(iface.latestRoundData.selector), abi.encode(0, price, 0, 0, 0));
        vm.mockCall(mock, abi.encodeWithSelector(iface.decimals.selector), abi.encode(18));
    }

    function test_limitPriceAtStart_concrete() public {
        DutchAuction.Data memory data = DutchAuction.Data({
            sellToken: SELL_TOKEN,
            buyToken: BUY_TOKEN,
            sellAmount: 1 ether,
            appData: APP_DATA,
            receiver: address(0x0),
            isPartiallyFillable: false,
            sellTokenPriceOracle: mockOracle(SELL_ORACLE, 2 ether),
            buyTokenPriceOracle: mockOracle(BUY_ORACLE, 1 ether),
            startTs: 1_000_000,
            duration: 600,
            timeStep: 60,
            startPrice: 2 ether,
            endPrice: 1 ether
        });
        vm.warp(1_000_000);

        GPv2Order.Data memory res =
            dutchAuction.getTradeableOrder(safe, address(0), bytes32(0), abi.encode(data), bytes(""));

        assertEq(res.buyAmount, 2 ether);
    }

    function test_limitPriceAtEnd_concrete() public {
        DutchAuction.Data memory data = DutchAuction.Data({
            sellToken: SELL_TOKEN,
            buyToken: BUY_TOKEN,
            sellAmount: 1 ether,
            appData: APP_DATA,
            receiver: address(0x0),
            isPartiallyFillable: false,
            sellTokenPriceOracle: mockOracle(SELL_ORACLE, 2 ether),
            buyTokenPriceOracle: mockOracle(BUY_ORACLE, 1 ether),
            startTs: 1_000_000,
            // multiples of 10 avoids rounding issues
            duration: 100,
            timeStep: 10,
            startPrice: 2 ether,
            endPrice: 1 ether
        });
        vm.warp(1_000_100);

        GPv2Order.Data memory res =
            dutchAuction.getTradeableOrder(safe, address(0), bytes32(0), abi.encode(data), bytes(""));

        assertEq(res.buyAmount, 1 ether);
    }

    function test_limitPriceAtMiddle_concrete() public {
        DutchAuction.Data memory data = DutchAuction.Data({
            sellToken: SELL_TOKEN,
            buyToken: BUY_TOKEN,
            sellAmount: 1 ether,
            appData: APP_DATA,
            receiver: address(0x0),
            isPartiallyFillable: false,
            sellTokenPriceOracle: mockOracle(SELL_ORACLE, 2 ether),
            buyTokenPriceOracle: mockOracle(BUY_ORACLE, 1 ether),
            startTs: 1_000_000,
            // multiples of 10 avoids rounding issues
            duration: 100,
            timeStep: 10,
            startPrice: 2 ether,
            endPrice: 1 ether
        });
        vm.warp(1_000_050);

        GPv2Order.Data memory res =
            dutchAuction.getTradeableOrder(safe, address(0), bytes32(0), abi.encode(data), bytes(""));

        assertEq(res.buyAmount, 15 * 10 ** 17);
    }

    function test_limitPriceWithinBounds_fuzz(uint256 timePassed, uint32 duration) public {
        vm.assume(timePassed <= 100);
        vm.assume(timePassed > 0);
        vm.assume(timePassed <= duration);
        vm.assume(duration <= 3600);
        vm.assume(duration > 0);

        DutchAuction.Data memory data = DutchAuction.Data({
            sellToken: SELL_TOKEN,
            buyToken: BUY_TOKEN,
            sellAmount: 1 ether,
            appData: APP_DATA,
            receiver: address(0x0),
            isPartiallyFillable: false,
            sellTokenPriceOracle: mockOracle(SELL_ORACLE, 2 ether),
            buyTokenPriceOracle: mockOracle(BUY_ORACLE, 1 ether),
            startTs: 1_000_000,
            duration: duration,
            timeStep: 10,
            startPrice: 2 ether,
            endPrice: 1 ether
        });
        vm.warp(1_000_000 + timePassed);

        GPv2Order.Data memory res =
            dutchAuction.getTradeableOrder(safe, address(0), bytes32(0), abi.encode(data), bytes(""));

        assertGe(res.buyAmount, 1 ether);
        assertLe(res.buyAmount, 2 ether);
    }

    /*

    function test_strikePriceMet_fuzz(int256 sellTokenOraclePrice, int256 buyTokenOraclePrice, int256 strike) public {
        vm.assume(buyTokenOraclePrice > 0);
        vm.assume(sellTokenOraclePrice > 0);
        vm.assume(strike > 0);
        vm.assume(sellTokenOraclePrice / buyTokenOraclePrice <= strike);

        StopLoss.Data memory data = StopLoss.Data({
            sellToken: SELL_TOKEN,
            buyToken: BUY_TOKEN,
            sellTokenPriceOracle: mockOracle(SELL_ORACLE, sellTokenOraclePrice),
            buyTokenPriceOracle: mockOracle(BUY_ORACLE, buyTokenOraclePrice),
            strike: strike,
            sellAmount: 1 ether,
            buyAmount: 1 ether,
            appData: APP_DATA,
            receiver: address(0x0),
            isSellOrder: false,
            isPartiallyFillable: false,
            validityBucketSeconds: 15 minutes
        });

        // 25 June 2023 18:40:51
        vm.warp(1687718451);

        GPv2Order.Data memory order =
            stopLoss.getTradeableOrder(safe, address(0), bytes32(0), abi.encode(data), bytes(""));
        assertEq(address(order.sellToken), address(SELL_TOKEN));
        assertEq(address(order.buyToken), address(BUY_TOKEN));
        assertEq(order.sellAmount, 1 ether);
        assertEq(order.buyAmount, 1 ether);
        assertEq(order.receiver, address(0x0));
        assertEq(order.validTo, 1687718700);
        assertEq(order.appData, APP_DATA);
        assertEq(order.feeAmount, 0);
        assertEq(order.kind, GPv2Order.KIND_BUY);
        assertEq(order.partiallyFillable, false);
        assertEq(order.sellTokenBalance, GPv2Order.BALANCE_ERC20);
        assertEq(order.buyTokenBalance, GPv2Order.BALANCE_ERC20);
    }

    function test_validTo() public {
        StopLoss.Data memory data = StopLoss.Data({
            sellToken: SELL_TOKEN,
            buyToken: BUY_TOKEN,
            sellTokenPriceOracle: mockOracle(SELL_ORACLE, 99 ether),
            buyTokenPriceOracle: mockOracle(BUY_ORACLE, 100 ether),
            strike: 1,
            sellAmount: 1 ether,
            buyAmount: 1 ether,
            appData: APP_DATA,
            receiver: address(0x0),
            isSellOrder: false,
            isPartiallyFillable: false,
            validityBucketSeconds: 1 hours
        });

        // 25 June 2023 18:59:59
        vm.warp(1687712399);
        GPv2Order.Data memory order =
            stopLoss.getTradeableOrder(safe, address(0), bytes32(0), abi.encode(data), bytes(""));
        assertEq(order.validTo, 1687712400); // 25 June 2023 19:00:00

        // 25 June 2023 19:00:00
        vm.warp(1687712400);
        order = stopLoss.getTradeableOrder(safe, address(0), bytes32(0), abi.encode(data), bytes(""));
        assertEq(order.validTo, 1687716000); // 25 June 2023 20:00:00
    }
    */
}
