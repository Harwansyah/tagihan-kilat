import { keccak256, toHex, type Hex } from "viem";

/**
 * An invoice, as the app sees it. The contract only stores `id`, `buyer`, `amount`,
 * `dueAt` and `memo` — the item lines and the buyer name live here, in the seller's
 * browser (localStorage), and in the payment link. The chain is the source of truth for
 * amount, status, payer and paid time; this file is the source of truth for the details.
 */
export interface InvoiceDraft {
  id: Hex;
  /** What was sold, one line per item, e.g. "Nasi goreng x2". */
  items: { label: string; amount: string }[];
  total: string;
  buyerName: string;
  buyerAddress?: Hex;
  /** ISO date (yyyy-mm-dd) or empty for no due date. */
  dueDate: string;
  memo: string;
  createdAt: number;
}

const STORAGE_KEY = "tagihan-kilat:invoices:v1";

export function newInvoiceId(): Hex {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return keccak256(toHex(bytes));
}

/** Short, human-friendly label for a bytes32 invoice id. */
export function invoiceLabel(invoiceId: Hex): string {
  return `#${invoiceId.slice(2, 6).toUpperCase()}-${invoiceId.slice(-4).toUpperCase()}`;
}

export function short(value: string, head = 6, tail = 4): string {
  return value.length > head + tail + 1 ? `${value.slice(0, head)}…${value.slice(-tail)}` : value;
}

/** "2026-12-01" → unix seconds at the end of that day, or 0 for no due date. */
export function dueDateToTimestamp(dueDate: string): number {
  if (!dueDate) return 0;
  const [y, m, d] = dueDate.split("-").map(Number);
  if (!y || !m || !d) return 0;
  return Math.floor(new Date(Date.UTC(y, m - 1, d, 16, 59, 59)).getTime() / 1000);
}

export function dueDateLabel(dueAt: bigint): string {
  if (dueAt === 0n) return "Tanpa batas waktu";
  return new Date(Number(dueAt) * 1000).toLocaleDateString("id-ID", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

/** Save a draft the seller created, so the dashboard can list it later. */
export function saveInvoice(draft: InvoiceDraft): void {
  try {
    const list = loadInvoices();
    const next = [draft, ...list.filter((d) => d.id !== draft.id)].slice(0, 100);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Private mode / storage full: the invoice still exists on-chain.
  }
}

export function loadInvoices(): InvoiceDraft[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as InvoiceDraft[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function loadInvoice(id: Hex): InvoiceDraft | undefined {
  return loadInvoices().find((d) => d.id.toLowerCase() === id.toLowerCase());
}

/** Build the shareable payment link for an invoice. */
export function invoiceLink(origin: string, id: Hex): string {
  return `${origin}/invoices/${id}`;
}

/** Parse a decimal tUSD8 amount ("12.50") into base units (6 decimals). Returns null when invalid. */
export function parseAmount(value: string): bigint | null {
  const m = /^\d+(?:[.,]\d{1,6})?$/.exec(value.trim());
  if (!m) return null;
  const [whole, frac = ""] = value.trim().replace(",", ".").split(".");
  try {
    return BigInt(whole) * 1_000_000n + BigInt((frac + "000000").slice(0, 6) || "0");
  } catch {
    return null;
  }
}

/** Base units (6 decimals) → "12.50". */
export function formatAmount(amount: bigint): string {
  const whole = amount / 1_000_000n;
  const frac = amount % 1_000_000n;
  return `${whole}.${frac.toString().padStart(6, "0").replace(/0+$/, "") || "0"}`;
}
