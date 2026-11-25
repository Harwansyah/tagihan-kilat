"use client";

import { addressUrl, invoiceAbi, txUrl } from "@aevum-kit/aevum";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { formatUnits, isHash, isHex, parseEventLogs, type Hex } from "viem";
import { useReadContract, useTransactionReceipt } from "wagmi";
import { useToken } from "@/components/useToken";
import { networkByChainId } from "@/lib/env";
import { dueDateLabel, invoiceLabel } from "@/lib/invoice";
import { useNetwork } from "@/lib/network";

const ZERO = "0x0000000000000000000000000000000000000000";

export default function ReceiptPage() {
  const { net: appNet } = useNetwork();
  const params = useParams<{ invoiceId: string }>();
  const search = useSearchParams();
  // Receipt links carry their chain, so they still work after you switch networks.
  const net = networkByChainId(Number(search.get("chain"))) ?? appNet;
  const appChain = net.chain;
  const invoiceAddress = net.invoice;
  const hasExplorer = net.hasExplorer;
  const invoiceId = params.invoiceId;
  const rawTx = search.get("tx");
  // Anything else in ?tx= is ignored, never shown: a receipt must not display text from the URL.
  const tx = rawTx && isHash(rawTx) ? rawTx : undefined;
  const validInvoice = isHex(invoiceId) && invoiceId.length === 66;
  const token = useToken();

  const invoice = useReadContract({
    address: invoiceAddress,
    abi: invoiceAbi,
    functionName: "invoiceOf",
    args: validInvoice ? [invoiceId as Hex] : undefined,
    chainId: appChain.id,
    query: { enabled: validInvoice && Boolean(invoiceAddress) },
  });
  const receipt = useTransactionReceipt({ hash: tx, chainId: appChain.id, query: { enabled: Boolean(tx) } });

  if (!validInvoice) {
    return (
      <main className="shell">
        <h1>Struk tidak ditemukan</h1>
        <p className="lede">ID tagihan itu tidak valid. ID tagihan adalah nilai hex 32 byte (0x + 64 karakter).</p>
      </main>
    );
  }

  const inv = invoice.data;
  const exists = Boolean(inv && inv.seller !== ZERO);
  // status: 0 Open, 1 Paid, 2 Cancelled. The contract only accepts the exact invoice amount,
  // so "paid" here always means the full amount reached the seller — no dust-payment trick.
  const paid = exists && inv!.status === 1;
  const cancelled = exists && inv!.status === 2;
  // Only show transaction details if that transaction really emitted Paid for this invoice.
  const paidLog =
    receipt.data && invoiceAddress
      ? parseEventLogs({ abi: invoiceAbi, logs: receipt.data.logs, eventName: "Paid" }).find(
          (l) => l.address.toLowerCase() === invoiceAddress.toLowerCase() && l.args.invoiceId.toLowerCase() === invoiceId.toLowerCase(),
        )
      : undefined;
  const txMatches = Boolean(paidLog);

  return (
    <main className="shell" style={{ maxWidth: 760 }}>
      <div>
        <p className="eyebrow">Struk · dibaca dari {appChain.name}</p>
        <h1>Tagihan {invoiceLabel(invoiceId as Hex)}</h1>
      </div>

      <section className="card stack">
        {!invoiceAddress ? (
          <div className="stack">
            <span className="status-pill warn">Tidak bisa dicek</span>
            <p style={{ color: "var(--text-muted)" }}>Tidak ada kontrak Invoice yang dikonfigurasi untuk {appChain.name} di aplikasi ini.</p>
          </div>
        ) : invoice.isLoading ? (
          <p className="empty">Membaca Invoice.invoiceOf…</p>
        ) : invoice.isError ? (
          <div className="stack">
            <span className="status-pill warn">Tidak bisa dicek</span>
            <p style={{ color: "var(--text-muted)" }}>
              Tidak bisa membaca tagihan dari {appChain.name}. RPC mungkin sedang sibuk.{" "}
              <button type="button" className="btn small" onClick={() => invoice.refetch()}>
                Coba lagi
              </button>
            </p>
          </div>
        ) : !exists ? (
          <div className="stack">
            <span className="status-pill warn">Tidak ditemukan</span>
            <p style={{ color: "var(--text-muted)" }}>
              Tidak ada tagihan dengan ID ini di {appChain.name}. Periksa link atau jaringannya.
            </p>
          </div>
        ) : cancelled ? (
          <div className="stack">
            <span className="status-pill warn">Dibatalkan</span>
            <p style={{ color: "var(--text-muted)" }}>Tagihan ini dibatalkan oleh penjual. Tidak ada pembayaran yang tercatat.</p>
            <dl className="kv">
              <dt>Penjual</dt>
              <dd>{inv!.seller}</dd>
              <dt>Jumlah</dt>
              <dd>
                {formatUnits(inv!.amount, token.decimals)} {token.symbol}
              </dd>
              {inv!.memo && (
                <>
                  <dt>Catatan</dt>
                  <dd>{inv!.memo}</dd>
                </>
              )}
            </dl>
          </div>
        ) : !paid ? (
          <div className="stack">
            <span className="status-pill warn">Belum dibayar</span>
            <p style={{ color: "var(--text-muted)" }}>
              Belum ada pembayaran untuk tagihan ini di {appChain.name}. Kalau baru saja bayar, tunggu beberapa detik lalu segarkan halaman.
            </p>
            <dl className="kv">
              <dt>Penjual</dt>
              <dd>{inv!.seller}</dd>
              <dt>Jumlah</dt>
              <dd>
                {formatUnits(inv!.amount, token.decimals)} {token.symbol}
              </dd>
              <dt>Jatuh tempo</dt>
              <dd>{dueDateLabel(inv!.dueAt)}</dd>
              {inv!.memo && (
                <>
                  <dt>Catatan</dt>
                  <dd>{inv!.memo}</dd>
                </>
              )}
            </dl>
            <Link className="btn" href={`/invoices/${invoiceId}`}>
              Bayar tagihan ini
            </Link>
          </div>
        ) : (
          <>
            <div className="check-top" style={{ alignItems: "center" }}>
              <span className="status-pill good">Lunas</span>
              <span className="fine">{new Date(Number(inv!.paidAt) * 1000).toLocaleString("id-ID")}</span>
            </div>
            <div className="receipt-amount">
              {formatUnits(inv!.amount, token.decimals)} <small style={{ fontSize: "0.4em", color: "var(--text-muted)" }}>{token.symbol}</small>
            </div>
            <dl className="kv">
              <dt>ID tagihan</dt>
              <dd>{invoiceId}</dd>
              <dt>Penjual</dt>
              <dd>{hasExplorer ? <a href={addressUrl(inv!.seller)} target="_blank" rel="noreferrer">{inv!.seller}</a> : inv!.seller}</dd>
              <dt>Pembayar</dt>
              <dd>{hasExplorer ? <a href={addressUrl(inv!.payer)} target="_blank" rel="noreferrer">{inv!.payer}</a> : inv!.payer}</dd>
              <dt>Jatuh tempo</dt>
              <dd>{dueDateLabel(inv!.dueAt)}</dd>
              {inv!.memo && (
                <>
                  <dt>Catatan</dt>
                  <dd>{inv!.memo}</dd>
                </>
              )}
              <dt>Kontrak Invoice</dt>
              <dd>{invoiceAddress}</dd>
              {txMatches && receipt.data && (
                <>
                  <dt>Block</dt>
                  <dd>{receipt.data.blockNumber.toString()}</dd>
                  <dt>Gas dipakai</dt>
                  <dd>{receipt.data.gasUsed.toString()}</dd>
                  <dt>Dikirim oleh</dt>
                  <dd>{receipt.data.from}</dd>
                  <dt>Transaksi</dt>
                  <dd>{hasExplorer ? <a href={txUrl(tx!)} target="_blank" rel="noreferrer">{tx}</a> : tx}</dd>
                </>
              )}
            </dl>
            {tx && receipt.data && !txMatches && (
              <p className="fine">Transaksi di link ini bukan pembayaran untuk tagihan ini, jadi tidak ditampilkan.</p>
            )}
            {txMatches && receipt.data && inv && receipt.data.from.toLowerCase() !== inv.payer.toLowerCase() && (
              <p className="fine">Pembayar tidak mengirim transaksi ini sendiri: relayer yang mengirimkan tanda tangannya (mode Gasless).</p>
            )}
          </>
        )}
      </section>

      <p className="fine">
        Halaman ini hanya percaya pada chain: ia memanggil <code>Invoice.invoiceOf(invoiceId)</code> dan memeriksa statusnya. Karena kontrak
        hanya menerima jumlah yang persis sama dengan tagihan, status Lunas berarti uang sudah sampai ke penjual.{" "}
        <Link href="/invoices">Buat tagihan baru</Link>
      </p>
    </main>
  );
}
