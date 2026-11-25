#!/usr/bin/env node
// End-to-end test of Tagihan Kilat on the local fork (make fork + make deploy-fork + make dev).
// Seller = anvil account 0, buyer = anvil account 1, relayer = anvil account 2 (in web/.env.local).
// Run from the web dir (needs viem from web/node_modules):  node scripts/e2e-fork.mjs
// Exits non-zero on the first failed assertion.
import { createPublicClient, createWalletClient, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const RPC = "http://127.0.0.1:8555";
const APP = "http://127.0.0.1:3000";
const INVOICE = "0x9280Bb6D4DF3ab0d4178A4de33cAED9465B8bA51";
const TUSD8 = "0x456569838f1d43009A91ebA4263147Afd7233483";
const CHAIN_ID = 440050;

const fork = {
  id: CHAIN_ID,
  name: "Aevum fork (local)",
  nativeCurrency: { name: "tQDAY", symbol: "tQDAY", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
};

const invoiceAbi = parseAbi([
  "function createInvoice(bytes32 invoiceId, address buyer, uint256 amount, uint64 dueAt, string memo)",
  "function pay(bytes32 invoiceId, uint256 amount)",
  "function payWithAuthorization(bytes32 invoiceId, address from, uint256 amount, uint256 validAfter, uint256 validBefore, uint8 v, bytes32 r, bytes32 s)",
  "function authorizationNonce(bytes32 invoiceId) view returns (bytes32)",
  "function invoiceOf(bytes32 invoiceId) view returns ((address seller, address buyer, uint256 amount, uint64 dueAt, uint64 createdAt, uint8 status, address payer, uint64 paidAt, string memo))",
  "function isPaid(bytes32 invoiceId) view returns (bool)",
]);
const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);

const seller = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const buyer = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");

const publicClient = createPublicClient({ chain: fork, transport: http(RPC) });
const sellerClient = createWalletClient({ account: seller, chain: fork, transport: http(RPC) });
const buyerClient = createWalletClient({ account: buyer, chain: fork, transport: http(RPC) });

let failures = 0;
function check(name, cond, extra = "") {
  console.log(`${cond ? "  PASS" : "  FAIL"} ${name}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
}

const id1 = "0x1111111111111111111111111111111111111111111111111111111111111111";
const id2 = "0x2222222222222222222222222222222222222222222222222222222222222222";

// --- 1. Seller creates invoice 1 (2.50 tUSD8, for the buyer) ---
console.log("\n[1] Create invoice 1 (2.50 tUSD8)");
let hash = await sellerClient.writeContract({
  address: INVOICE, abi: invoiceAbi, functionName: "createInvoice",
  args: [id1, buyer.address, 2_500_000n, 0n, "Nasi goreng x2, Es teh x1"],
});
await publicClient.waitForTransactionReceipt({ hash });
let inv = await publicClient.readContract({ address: INVOICE, abi: invoiceAbi, functionName: "invoiceOf", args: [id1] });
check("invoice 1 exists, seller is the seller", inv.seller.toLowerCase() === seller.address.toLowerCase());
check("invoice 1 amount is 2.50 tUSD8", inv.amount === 2_500_000n);
check("invoice 1 status is Open (0)", inv.status === 0);
check("invoice 1 memo stored", inv.memo === "Nasi goreng x2, Es teh x1");

// --- 2. Buyer pays invoice 1 the standard way (approve + pay) ---
console.log("\n[2] Standard pay for invoice 1");
const sellerBefore = await publicClient.readContract({ address: TUSD8, abi: erc20Abi, functionName: "balanceOf", args: [seller.address] });
hash = await buyerClient.writeContract({
  address: TUSD8, abi: erc20Abi, functionName: "approve", args: [INVOICE, 2_500_000n],
});
await publicClient.waitForTransactionReceipt({ hash });
hash = await buyerClient.writeContract({
  address: INVOICE, abi: invoiceAbi, functionName: "pay", args: [id1, 2_500_000n],
});
const receipt1 = await publicClient.waitForTransactionReceipt({ hash });
check("standard pay tx succeeded", receipt1.status === "success", `tx ${hash}`);
inv = await publicClient.readContract({ address: INVOICE, abi: invoiceAbi, functionName: "invoiceOf", args: [id1] });
check("invoice 1 status is Paid (1)", inv.status === 1);
check("invoice 1 payer is the buyer", inv.payer.toLowerCase() === buyer.address.toLowerCase());
const sellerAfter = await publicClient.readContract({ address: TUSD8, abi: erc20Abi, functionName: "balanceOf", args: [seller.address] });
check("seller received exactly 2.50 tUSD8", sellerAfter - sellerBefore === 2_500_000n, `+${sellerAfter - sellerBefore} base units`);

// --- 3. Seller creates invoice 2 (1.25 tUSD8) ---
console.log("\n[3] Create invoice 2 (1.25 tUSD8)");
hash = await sellerClient.writeContract({
  address: INVOICE, abi: invoiceAbi, functionName: "createInvoice",
  args: [id2, buyer.address, 1_250_000n, 0n, "Kopi x3"],
});
await publicClient.waitForTransactionReceipt({ hash });

// --- 4. Buyer pays invoice 2 gasless: sign EIP-3009, relayer submits ---
console.log("\n[4] Gasless pay for invoice 2 (sign + /api/relay)");
const nonce = await publicClient.readContract({ address: INVOICE, abi: invoiceAbi, functionName: "authorizationNonce", args: [id2] });
const now = BigInt(Math.floor(Date.now() / 1000));
const validAfter = 0n;
const validBefore = now + 600n;
const signature = await buyerClient.signTypedData({
  account: buyer,
  domain: { name: "tUSD8", version: "2", chainId: CHAIN_ID, verifyingContract: TUSD8 },
  types: {
    ReceiveWithAuthorization: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
    ],
  },
  primaryType: "ReceiveWithAuthorization",
  message: { from: buyer.address, to: INVOICE, value: 1_250_000n, validAfter, validBefore, nonce },
});
const relayRes = await fetch(`${APP}/api/relay`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    chainId: CHAIN_ID, invoiceId: id2, from: buyer.address,
    amount: "1250000", validAfter: validAfter.toString(), validBefore: validBefore.toString(), signature,
  }),
});
const relayData = await relayRes.json();
check("relayer accepted the gasless payment", relayRes.ok && Boolean(relayData.hash), relayRes.ok ? `tx ${relayData.hash}` : JSON.stringify(relayData));
if (relayData.hash) {
  const receipt2 = await publicClient.waitForTransactionReceipt({ hash: relayData.hash });
  check("gasless pay tx succeeded", receipt2.status === "success");
  check("relayer (not buyer) sent the tx", receipt2.from.toLowerCase() !== buyer.address.toLowerCase(), `from ${receipt2.from}`);
}
inv = await publicClient.readContract({ address: INVOICE, abi: invoiceAbi, functionName: "invoiceOf", args: [id2] });
check("invoice 2 status is Paid (1)", inv.status === 1);
check("invoice 2 payer is the buyer", inv.payer.toLowerCase() === buyer.address.toLowerCase());

// --- 5. Relayer rails: re-paying an already-paid invoice is refused ---
console.log("\n[5] Relayer refuses a second payment for invoice 2");
const replayRes = await fetch(`${APP}/api/relay`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    chainId: CHAIN_ID, invoiceId: id2, from: buyer.address,
    amount: "1250000", validAfter: validAfter.toString(), validBefore: validBefore.toString(), signature,
  }),
});
const replayData = await replayRes.json();
check("relayer refuses with 409", replayRes.status === 409, `${replayRes.status} ${JSON.stringify(replayData)}`);

// --- 6. Pages render ---
console.log("\n[6] Pages render");
for (const path of ["/", "/invoices", `/invoices/${id1}`, `/receipts/${id1}`, "/activity", "/docs"]) {
  const r = await fetch(`${APP}${path}`);
  check(`GET ${path} -> 200`, r.status === 200, `got ${r.status}`);
}

console.log(failures === 0 ? "\nE2E PASSED" : `\nE2E FAILED (${failures} checks)`);
process.exit(failures === 0 ? 0 : 1);
