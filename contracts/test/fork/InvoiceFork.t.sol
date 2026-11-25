// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Invoice} from "../../src/Invoice.sol";
import {Signing} from "../Signing.sol";

interface ITUSD8 is IERC20 {
    function DOMAIN_SEPARATOR() external view returns (bytes32);
    function authorizationState(address, bytes32) external view returns (bool);
}

/// @notice Runs Invoice against the REAL tUSD8 on a local fork of Aevum testnet. No funds needed:
///         `deal` writes a balance into the fork only.
///         Run with: make test-fork   (or: forge test --match-path 'test/fork/*' --fork-url aevum --evm-version shanghai)
contract InvoiceForkTest is Test {
    ITUSD8 constant TUSD8 = ITUSD8(0x456569838f1d43009A91ebA4263147Afd7233483);

    function test_realTusd8_createAndPay() public {
        address seller = makeAddr("seller");
        address buyer = makeAddr("buyer");
        Invoice invoice = new Invoice(TUSD8);
        deal(address(TUSD8), buyer, 10e6);

        bytes32 invoiceId = keccak256("fork-invoice");
        vm.prank(seller);
        invoice.createInvoice(invoiceId, buyer, 3e6, 0, "Kopi x3");

        vm.startPrank(buyer);
        TUSD8.approve(address(invoice), 3e6);
        invoice.pay(invoiceId, 3e6);
        vm.stopPrank();

        assertEq(TUSD8.balanceOf(seller), 3e6);
        assertTrue(invoice.isPaid(invoiceId));
        assertEq(invoice.invoiceOf(invoiceId).memo, "Kopi x3");
    }

    function test_realTusd8_rejectsWrongAmount() public {
        address seller = makeAddr("seller");
        address buyer = makeAddr("buyer");
        Invoice invoice = new Invoice(TUSD8);
        deal(address(TUSD8), buyer, 10e6);

        bytes32 invoiceId = keccak256("fork-invoice-2");
        vm.prank(seller);
        invoice.createInvoice(invoiceId, buyer, 3e6, 0, "Kopi x3");

        vm.startPrank(buyer);
        TUSD8.approve(address(invoice), 3e6);
        vm.expectRevert(abi.encodeWithSelector(Invoice.WrongAmount.selector, 3e6, 1));
        invoice.pay(invoiceId, 1);
        vm.stopPrank();
        assertFalse(invoice.isPaid(invoiceId));
    }

    function test_realTusd8_payWithAuthorization() public {
        address seller = makeAddr("seller");
        (address buyer, uint256 key) = makeAddrAndKey("buyer");
        Invoice invoice = new Invoice(TUSD8);
        deal(address(TUSD8), buyer, 10e6);

        bytes32 invoiceId = keccak256("fork-invoice-3");
        vm.prank(seller);
        invoice.createInvoice(invoiceId, buyer, 5e6, 0, "Nasi goreng x5");

        uint256 deadline = block.timestamp + 1 hours;
        Signing.Auth memory a = Signing.Auth({
            from: buyer,
            to: address(invoice),
            value: 5e6,
            validAfter: 0,
            validBefore: deadline,
            nonce: invoice.authorizationNonce(invoiceId)
        });
        (uint8 v, bytes32 r, bytes32 s) = Signing.signReceive(vm, key, TUSD8.DOMAIN_SEPARATOR(), a);

        vm.prank(makeAddr("relayer"));
        invoice.payWithAuthorization(invoiceId, buyer, 5e6, 0, deadline, v, r, s);

        assertEq(TUSD8.balanceOf(seller), 5e6);
        assertEq(TUSD8.balanceOf(buyer), 5e6);
        assertTrue(TUSD8.authorizationState(buyer, invoice.authorizationNonce(invoiceId)));
    }
}
