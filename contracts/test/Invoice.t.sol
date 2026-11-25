// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Invoice} from "../src/Invoice.sol";
import {MockUSD8} from "../src/mocks/MockUSD8.sol";
import {Signing} from "./Signing.sol";

contract InvoiceTest is Test {
    MockUSD8 token;
    Invoice invoice;
    address seller = makeAddr("seller");
    address buyer;
    uint256 buyerKey;
    address stranger = makeAddr("stranger");
    address relayer = makeAddr("relayer");

    bytes32 constant INV = keccak256("invoice-1");
    uint256 constant PRICE = 5e6; // 5 tUSD8

    function setUp() public {
        (buyer, buyerKey) = makeAddrAndKey("buyer");
        token = new MockUSD8();
        invoice = new Invoice(IERC20(address(token)));
        token.mint(buyer, 100e6);
        token.mint(stranger, 100e6);
    }

    function _create() internal {
        vm.prank(seller);
        invoice.createInvoice(INV, buyer, PRICE, 0, "Nasi goreng x2, Es teh x1");
    }

    // ---------- createInvoice ----------

    function test_create_storesFieldsAndEmits() public {
        vm.expectEmit(true, true, true, true, address(invoice));
        emit Invoice.InvoiceCreated(INV, seller, buyer, PRICE, 0);
        vm.prank(seller);
        invoice.createInvoice(INV, buyer, PRICE, 0, "Nasi goreng x2, Es teh x1");

        Invoice.InvoiceData memory d = invoice.invoiceOf(INV);
        assertEq(d.seller, seller);
        assertEq(d.buyer, buyer);
        assertEq(d.amount, PRICE);
        assertEq(d.dueAt, 0);
        assertEq(uint8(d.status), uint8(Invoice.Status.Open));
        assertEq(d.payer, address(0));
        assertEq(d.memo, "Nasi goreng x2, Es teh x1");
        assertFalse(invoice.isPaid(INV));
    }

    function test_create_rejectsDuplicateId() public {
        _create();
        vm.prank(seller);
        vm.expectRevert(abi.encodeWithSelector(Invoice.InvoiceExists.selector, INV));
        invoice.createInvoice(INV, buyer, PRICE, 0, "again");
    }

    function test_create_rejectsZeroAmount() public {
        vm.prank(seller);
        vm.expectRevert(Invoice.ZeroAmount.selector);
        invoice.createInvoice(INV, buyer, 0, 0, "free?");
    }

    function test_create_rejectsLongMemo() public {
        vm.prank(seller);
        vm.expectRevert(Invoice.MemoTooLong.selector);
        invoice.createInvoice(INV, buyer, PRICE, 0, string(new bytes(201)));
    }

    // ---------- pay (approve + call) ----------

    function test_pay_movesExactFundsToSeller() public {
        _create();
        vm.startPrank(buyer);
        token.approve(address(invoice), PRICE);
        vm.expectEmit(true, true, false, true, address(invoice));
        emit Invoice.Paid(INV, buyer, PRICE);
        invoice.pay(INV, PRICE);
        vm.stopPrank();

        assertEq(token.balanceOf(seller), PRICE);
        assertEq(token.balanceOf(address(invoice)), 0);
        assertTrue(invoice.isPaid(INV));
        Invoice.InvoiceData memory d = invoice.invoiceOf(INV);
        assertEq(d.payer, buyer);
        assertEq(d.paidAt, block.timestamp);
        assertEq(uint8(d.status), uint8(Invoice.Status.Paid));
    }

    function test_pay_rejectsWrongAmount() public {
        _create();
        vm.startPrank(buyer);
        token.approve(address(invoice), PRICE);
        // The kit's documented flaw, fixed: a dust payment can no longer mark it paid.
        vm.expectRevert(abi.encodeWithSelector(Invoice.WrongAmount.selector, PRICE, 1));
        invoice.pay(INV, 1);
        vm.expectRevert(abi.encodeWithSelector(Invoice.WrongAmount.selector, PRICE, PRICE + 1));
        invoice.pay(INV, PRICE + 1);
        vm.stopPrank();
        assertFalse(invoice.isPaid(INV));
    }

    function test_pay_rejectsWrongBuyer() public {
        _create();
        vm.startPrank(stranger);
        token.approve(address(invoice), PRICE);
        vm.expectRevert(abi.encodeWithSelector(Invoice.WrongPayer.selector, buyer, stranger));
        invoice.pay(INV, PRICE);
        vm.stopPrank();
    }

    function test_pay_allowsAnyoneWhenBuyerUnset() public {
        vm.prank(seller);
        invoice.createInvoice(INV, address(0), PRICE, 0, "open invoice");
        vm.startPrank(stranger);
        token.approve(address(invoice), PRICE);
        invoice.pay(INV, PRICE);
        vm.stopPrank();
        assertEq(token.balanceOf(seller), PRICE);
        assertEq(invoice.invoiceOf(INV).payer, stranger);
    }

    function test_pay_revertsOnSecondPayment() public {
        _create();
        vm.startPrank(buyer);
        token.approve(address(invoice), 2 * PRICE);
        invoice.pay(INV, PRICE);
        vm.expectRevert(abi.encodeWithSelector(Invoice.AlreadyPaid.selector, INV));
        invoice.pay(INV, PRICE);
        vm.stopPrank();
    }

    function test_pay_revertsWhenExpired() public {
        vm.prank(seller);
        invoice.createInvoice(INV, buyer, PRICE, uint64(block.timestamp + 1 days), "due tomorrow");
        vm.warp(block.timestamp + 2 days);
        assertTrue(invoice.isExpired(INV));
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(Invoice.InvoiceExpired.selector, INV));
        invoice.pay(INV, PRICE);
    }

    function test_pay_revertsOnUnknownInvoice() public {
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(Invoice.InvoiceNotFound.selector, INV));
        invoice.pay(INV, PRICE);
    }

    // ---------- cancel ----------

    function test_cancel_onlySellerAndOnlyWhenOpen() public {
        _create();
        vm.prank(stranger);
        vm.expectRevert(Invoice.NotSeller.selector);
        invoice.cancelInvoice(INV);

        vm.expectEmit(true, false, false, true, address(invoice));
        emit Invoice.InvoiceCancelled(INV);
        vm.prank(seller);
        invoice.cancelInvoice(INV);

        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(Invoice.InvoiceIsCancelled.selector, INV));
        invoice.pay(INV, PRICE);
    }

    function test_cancel_revertsWhenPaid() public {
        _create();
        vm.startPrank(buyer);
        token.approve(address(invoice), PRICE);
        invoice.pay(INV, PRICE);
        vm.stopPrank();
        vm.prank(seller);
        vm.expectRevert(abi.encodeWithSelector(Invoice.AlreadyPaid.selector, INV));
        invoice.cancelInvoice(INV);
    }

    // ---------- payWithAuthorization (EIP-3009, gasless for the buyer) ----------

    function _sign(bytes32 invoiceId, uint256 value, uint256 validBefore)
        internal
        view
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        Signing.Auth memory a = Signing.Auth({
            from: buyer,
            to: address(invoice),
            value: value,
            validAfter: 0,
            validBefore: validBefore,
            nonce: invoice.authorizationNonce(invoiceId)
        });
        return Signing.signReceive(vm, buyerKey, token.DOMAIN_SEPARATOR(), a);
    }

    function test_payWithAuthorization_relayerSubmits() public {
        _create();
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _sign(INV, PRICE, deadline);

        vm.prank(relayer); // the buyer never sends a transaction
        invoice.payWithAuthorization(INV, buyer, PRICE, 0, deadline, v, r, s);

        assertEq(token.balanceOf(seller), PRICE);
        assertEq(token.balanceOf(buyer), 95e6);
        assertEq(invoice.invoiceOf(INV).payer, buyer);
    }

    function test_payWithAuthorization_signatureIsBoundToInvoice() public {
        _create();
        bytes32 other = keccak256("invoice-2");
        vm.prank(seller);
        invoice.createInvoice(other, buyer, PRICE, 0, "second invoice");
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _sign(INV, PRICE, deadline);

        // Same signature, different invoice id: the nonce no longer matches, so it fails.
        vm.prank(relayer);
        vm.expectRevert(MockUSD8.InvalidSignature.selector);
        invoice.payWithAuthorization(other, buyer, PRICE, 0, deadline, v, r, s);
    }

    function test_payWithAuthorization_cannotChangeAmount() public {
        _create();
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _sign(INV, PRICE, deadline);

        // The invoice's exact-amount check fires before the signature is even verified.
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(Invoice.WrongAmount.selector, PRICE, PRICE + 1));
        invoice.payWithAuthorization(INV, buyer, PRICE + 1, 0, deadline, v, r, s);
    }

    function test_payWithAuthorization_rejectsWrongAmountOnChain() public {
        _create();
        // Even with a signature for a different amount, the invoice check fires first.
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _sign(INV, 1, deadline);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(Invoice.WrongAmount.selector, PRICE, 1));
        invoice.payWithAuthorization(INV, buyer, 1, 0, deadline, v, r, s);
    }

    function test_payWithAuthorization_expired() public {
        _create();
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _sign(INV, PRICE, deadline);
        vm.warp(deadline);

        vm.expectRevert(MockUSD8.AuthorizationExpired.selector);
        invoice.payWithAuthorization(INV, buyer, PRICE, 0, deadline, v, r, s);
    }

    function test_payWithAuthorization_noReplay() public {
        _create();
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _sign(INV, PRICE, deadline);
        invoice.payWithAuthorization(INV, buyer, PRICE, 0, deadline, v, r, s);

        vm.expectRevert(abi.encodeWithSelector(Invoice.AlreadyPaid.selector, INV));
        invoice.payWithAuthorization(INV, buyer, PRICE, 0, deadline, v, r, s);
    }

    function test_constructor_rejectsZeroAddress() public {
        vm.expectRevert(Invoice.ZeroAddress.selector);
        new Invoice(IERC20(address(0)));
    }

    function testFuzz_createAndPay(bytes32 invoiceId, uint256 amount) public {
        vm.assume(invoiceId != bytes32(0));
        amount = bound(amount, 1, 100e6);
        vm.prank(seller);
        invoice.createInvoice(invoiceId, buyer, amount, 0, "fuzz");
        vm.startPrank(buyer);
        token.approve(address(invoice), amount);
        invoice.pay(invoiceId, amount);
        vm.stopPrank();
        assertEq(token.balanceOf(seller), amount);
        assertEq(invoice.invoiceOf(invoiceId).amount, amount);
        assertTrue(invoice.isPaid(invoiceId));
    }
}
