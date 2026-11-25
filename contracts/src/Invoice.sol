// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice EIP-3009 (USDC-style) signed transfers. tUSD8 on Aevum implements this.
interface IERC3009 {
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;
}

/// @title Invoice — Tagihan Kilat
/// @notice Stablecoin invoices for micro-sellers (warung / UMKM). A seller creates an invoice
///         with an exact amount in tUSD8, an optional buyer, a due date, and a short memo.
///         Payment is only accepted for the EXACT amount, only from the intended buyer (when
///         one is set), and only before the due date. Money goes straight to the seller and a
///         `Paid` event is the receipt.
///
/// @dev This is the kit's Checkout, renamed into an invoice (the kit's README says to do
///      exactly that) with the flaw it documents fixed: in the plain Checkout anyone could
///      mark any order "paid" with any amount (`pay(orderId, 1)` front-runs the real buyer).
///      Here the amount is decided on-chain by the invoice, not by whoever calls `pay`.
///
///      Two ways to pay, like Checkout:
///      1. `pay`: the buyer approves this contract, then calls `pay` (two transactions, buyer pays gas).
///      2. `payWithAuthorization`: the buyer signs an EIP-3009 message off-chain and anyone
///         (your backend, a relayer, the seller) submits it. The buyer needs no native gas.
///      The signed nonce must be `authorizationNonce(invoiceId)`, binding the signature to
///      this one invoice, so a relayer can't reuse it for a different invoice.
contract Invoice {
    using SafeERC20 for IERC20;

    enum Status {
        Open,
        Paid,
        Cancelled
    }

    struct InvoiceData {
        address seller;
        address buyer; // address(0) = anyone may pay
        uint256 amount; // tUSD8 base units (6 decimals)
        uint64 dueAt; // 0 = no expiry
        uint64 createdAt;
        Status status;
        address payer;
        uint64 paidAt;
        string memo; // what the invoice is for, e.g. "Nasi goreng x2, Es teh x1"
    }

    /// @notice Max memo length, in bytes. Keeps invoice creation cheap.
    uint256 public constant MAX_MEMO_BYTES = 200;

    IERC20 public immutable token;

    mapping(bytes32 invoiceId => InvoiceData) private _invoices;

    event InvoiceCreated(
        bytes32 indexed invoiceId, address indexed seller, address indexed buyer, uint256 amount, uint64 dueAt
    );
    event Paid(bytes32 indexed invoiceId, address indexed payer, uint256 amount);
    event InvoiceCancelled(bytes32 indexed invoiceId);

    error InvoiceExists(bytes32 invoiceId);
    error InvoiceNotFound(bytes32 invoiceId);
    error WrongAmount(uint256 expected, uint256 got);
    error WrongPayer(address expected, address got);
    error InvoiceExpired(bytes32 invoiceId);
    error InvoiceIsCancelled(bytes32 invoiceId);
    error AlreadyPaid(bytes32 invoiceId);
    error NotSeller();
    error ZeroAmount();
    error ZeroAddress();
    error MemoTooLong();

    constructor(IERC20 token_) {
        if (address(token_) == address(0)) revert ZeroAddress();
        token = token_;
    }

    /// @notice Create an invoice. `invoiceId` is chosen by the seller's app (unguessable random
    ///         32 bytes, like the kit's `newOrderId()`); the contract only checks it is unused.
    function createInvoice(bytes32 invoiceId, address buyer, uint256 amount, uint64 dueAt, string calldata memo)
        external
    {
        if (_invoices[invoiceId].seller != address(0)) revert InvoiceExists(invoiceId);
        if (amount == 0) revert ZeroAmount();
        if (bytes(memo).length > MAX_MEMO_BYTES) revert MemoTooLong();
        _invoices[invoiceId] = InvoiceData({
            seller: msg.sender,
            buyer: buyer,
            amount: amount,
            dueAt: dueAt,
            createdAt: uint64(block.timestamp),
            status: Status.Open,
            payer: address(0),
            paidAt: 0,
            memo: memo
        });
        emit InvoiceCreated(invoiceId, msg.sender, buyer, amount, dueAt);
    }

    /// @notice Cancel an open invoice. Only the seller. A cancelled invoice can never be paid.
    function cancelInvoice(bytes32 invoiceId) external {
        InvoiceData storage inv = _invoices[invoiceId];
        if (inv.seller == address(0)) revert InvoiceNotFound(invoiceId);
        if (msg.sender != inv.seller) revert NotSeller();
        if (inv.status == Status.Paid) revert AlreadyPaid(invoiceId);
        if (inv.status == Status.Cancelled) revert InvoiceIsCancelled(invoiceId);
        inv.status = Status.Cancelled;
        emit InvoiceCancelled(invoiceId);
    }

    /// @notice Pay an invoice with tokens you have approved to this contract.
    function pay(bytes32 invoiceId, uint256 amount) external {
        InvoiceData storage inv = _checkPayable(invoiceId, msg.sender, amount);
        _record(inv, invoiceId, msg.sender, amount);
        token.safeTransferFrom(msg.sender, inv.seller, amount);
    }

    /// @notice Pay an invoice with an EIP-3009 `ReceiveWithAuthorization` signed by `from`.
    /// @dev The signed nonce must be `authorizationNonce(invoiceId)`. That ties the signature
    ///      to this invoice, so a relayer can't reuse it to mark a different invoice as paid.
    ///      `to` in the signed message must be this contract.
    function payWithAuthorization(
        bytes32 invoiceId,
        address from,
        uint256 amount,
        uint256 validAfter,
        uint256 validBefore,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        InvoiceData storage inv = _checkPayable(invoiceId, from, amount);
        address seller = inv.seller;
        _record(inv, invoiceId, from, amount);
        _receive(invoiceId, from, amount, validAfter, validBefore, v, r, s);
        token.safeTransfer(seller, amount);
    }

    /// @dev Separate function so `payWithAuthorization` doesn't run out of stack slots.
    function _receive(
        bytes32 invoiceId,
        address from,
        uint256 amount,
        uint256 validAfter,
        uint256 validBefore,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) private {
        IERC3009(address(token)).receiveWithAuthorization(
            from, address(this), amount, validAfter, validBefore, authorizationNonce(invoiceId), v, r, s
        );
    }

    /// @notice The EIP-3009 nonce a buyer must sign to pay `invoiceId` through this contract.
    function authorizationNonce(bytes32 invoiceId) public view returns (bytes32) {
        return keccak256(abi.encode(address(this), invoiceId));
    }

    function invoiceOf(bytes32 invoiceId) external view returns (InvoiceData memory) {
        return _invoices[invoiceId];
    }

    function isPaid(bytes32 invoiceId) external view returns (bool) {
        return _invoices[invoiceId].status == Status.Paid;
    }

    /// @notice True when the invoice exists, is still open, and has passed its due date.
    function isExpired(bytes32 invoiceId) external view returns (bool) {
        InvoiceData storage inv = _invoices[invoiceId];
        return inv.seller != address(0) && inv.status == Status.Open && inv.dueAt != 0
            && block.timestamp > inv.dueAt;
    }

    /// @dev Shared payment guard: the invoice must exist, be open, be unexpired, be paid for
    ///      its exact amount, and (when a buyer is set) be paid by that buyer.
    function _checkPayable(bytes32 invoiceId, address payer, uint256 amount)
        private
        view
        returns (InvoiceData storage inv)
    {
        inv = _invoices[invoiceId];
        if (inv.seller == address(0)) revert InvoiceNotFound(invoiceId);
        if (inv.status == Status.Paid) revert AlreadyPaid(invoiceId);
        if (inv.status == Status.Cancelled) revert InvoiceIsCancelled(invoiceId);
        if (inv.dueAt != 0 && block.timestamp > inv.dueAt) revert InvoiceExpired(invoiceId);
        if (amount != inv.amount) revert WrongAmount(inv.amount, amount);
        if (inv.buyer != address(0) && payer != inv.buyer) revert WrongPayer(inv.buyer, payer);
    }

    function _record(InvoiceData storage inv, bytes32 invoiceId, address payer, uint256 amount) private {
        if (amount == 0) revert ZeroAmount();
        inv.status = Status.Paid;
        inv.payer = payer;
        inv.paidAt = uint64(block.timestamp);
        emit Paid(invoiceId, payer, amount);
    }
}
