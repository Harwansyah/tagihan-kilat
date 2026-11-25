"use client";

import { invoiceAbi } from "@aevum-kit/aevum";
import Link from "next/link";
import { useEffect, useState } from "react";
import { isAddress, type Hex } from "viem";
import { useAccount, useConfig, useReadContract } from "wagmi";
import { simulateContract, waitForTransactionReceipt, writeContract } from "wagmi/actions";
import { useNetwork } from "@/lib/network";
import { explain } from "@/lib/errors";
import {
  dueDateLabel,
  dueDateToTimestamp,
  formatAmount,
  invoiceLabel,
  invoiceLink,
  loadInvoices,
  newInvoiceId,
  parseAmount,
  saveInvoice,
  short,
  type InvoiceDraft,
} from "@/lib/invoice";

type Phase = "idle" | "working" | "done" | "error";

interface ItemRow {
  label: string;
  amount: string;
}

/** One saved invoice with its live status read from the chain. */
function InvoiceRow({ draft }: { draft: InvoiceDraft }) {
  const { net } = useNetwork();
  const appChain = net.chain;
  const invoiceAddress = net.invoice;
  const config = useConfig();
  const { address } = useAccount();
  const [copied, setCopied] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);

  const onChain = useReadContract({
    address: invoiceAddress,
    abi: invoiceAbi,
    functionName: "invoiceOf",
    args: [draft.id],
    chainId: appChain.id,
    query: { enabled: Boolean(invoiceAddress), refetchInterval: 15_000 },
  });

  const inv = onChain.data;
  const status = inv ? inv.status : undefined; // 0 Open, 1 Paid, 2 Cancelled
  const expired = inv ? inv.dueAt !== 0n && BigInt(Math.floor(Date.now() / 1000)) > inv.dueAt : false;
  const isSeller = address && inv && inv.seller.toLowerCase() === address.toLowerCase();

  async function onCancel() {
    if (!invoiceAddress || !address) return;
    setCancelError(null);
    setCancelling(true);
    try {
      const { request } = await simulateContract(config, {
        account: address,
        address: invoiceAddress,
        abi: invoiceAbi,
        functionName: "cancelInvoice",
        args: [draft.id],
        chainId: appChain.id,
      });
      const hash = await writeContract(config, request);
      await waitForTransactionReceipt(config, { hash, chainId: appChain.id });
      onChain.refetch();
    } catch (e) {
      setCancelError(explain(e));
    } finally {
      setCancelling(false);
    }
  }

  async function onCopy() {
    try {
      await navigator.clipboard.writeText(invoiceLink(window.location.origin, draft.id));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard unavailable: the link is right above it.
    }
  }

  const pill =
    status === 1 ? (
      <span className="status-pill good">Lunas</span>
    ) : status === 2 ? (
      <span className="status-pill warn">Dibatalkan</span>
    ) : expired ? (
      <span className="status-pill warn">Kedaluarsa</span>
    ) : (
      <span className="status-pill warn">Belum dibayar</span>
    );

  return (
    <div className="card stack" style={{ padding: 18 }}>
      <div className="check-top" style={{ alignItems: "center" }}>
        <span>
          <strong>{draft.buyerName || "Pembeli"}</strong>{" "}
          <span className="mono" style={{ color: "var(--text-muted)" }}>
            {invoiceLabel(draft.id)}
          </span>
        </span>
        {pill}
      </div>
      <div className="lines">
        {draft.items.map((it) => (
          <div key={it.label} className="line">
            <span>{it.label}</span>
            <span className="num">{it.amount}</span>
          </div>
        ))}
        <div className="rule" />
        <div className="line" style={{ alignItems: "baseline" }}>
          <span style={{ fontWeight: 600 }}>Total</span>
          <span className="total">
            {draft.total} <small>tUSD8</small>
          </span>
        </div>
      </div>
      <dl className="kv" style={{ fontSize: 13 }}>
        <dt>Jatuh tempo</dt>
        <dd>{dueDateLabel(BigInt(dueDateToTimestamp(draft.dueDate)))}</dd>
        {draft.memo && (
          <>
            <dt>Catatan</dt>
            <dd>{draft.memo}</dd>
          </>
        )}
        {inv && status === 1 && (
          <>
            <dt>Dibayar oleh</dt>
            <dd>{short(inv.payer)}</dd>
          </>
        )}
      </dl>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
        <Link className="btn small" href={`/invoices/${draft.id}`}>
          {status === 1 ? "Lihat struk" : "Buka tagihan"}
        </Link>
        <button type="button" className="btn small secondary" onClick={onCopy}>
          {copied ? "Link disalin ✓" : "Salin link bayar"}
        </button>
        {isSeller && status === 0 && !expired && (
          <button type="button" className="btn small warn" disabled={cancelling} onClick={onCancel}>
            {cancelling ? "Membatalkan…" : "Batalkan"}
          </button>
        )}
      </div>
      {cancelError && (
        <div className="notice bad" role="alert">
          <span>{cancelError}</span>
        </div>
      )}
    </div>
  );
}

export default function InvoicesPage() {
  const { net } = useNetwork();
  const appChain = net.chain;
  const invoiceAddress = net.invoice;
  const config = useConfig();
  const { address, isConnected, chainId } = useAccount();
  const onChain = isConnected && chainId === appChain.id;

  const [buyerName, setBuyerName] = useState("");
  const [buyerAddress, setBuyerAddress] = useState("");
  const [items, setItems] = useState<ItemRow[]>([
    { label: "Nasi goreng", amount: "2.00" },
    { label: "Es teh", amount: "0.50" },
  ]);
  const [dueDate, setDueDate] = useState("");
  const [memo, setMemo] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [createdId, setCreatedId] = useState<Hex | null>(null);
  const [saved, setSaved] = useState<InvoiceDraft[]>([]);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setSaved(loadInvoices());
  }, []);

  const parsedItems = items.map((it) => ({ ...it, value: parseAmount(it.amount) }));
  const allValid = parsedItems.every((it) => it.label.trim() && it.value !== null && it.value > 0n);
  const total = parsedItems.reduce((sum, it) => sum + (it.value ?? 0n), 0n);
  const buyerOk = buyerAddress.trim() === "" || isAddress(buyerAddress.trim());
  const memoOk = memo.length <= 200;

  function setItem(i: number, patch: Partial<ItemRow>) {
    setItems((prev) => prev.map((it, j) => (j === i ? { ...it, ...patch } : it)));
  }

  async function onCreate() {
    if (!address || !invoiceAddress || !allValid || !buyerOk || !memoOk) return;
    setError(null);
    setPhase("working");
    try {
      const id = newInvoiceId();
      const { request } = await simulateContract(config, {
        account: address,
        address: invoiceAddress,
        abi: invoiceAbi,
        functionName: "createInvoice",
        args: [id, buyerAddress.trim() === "" ? "0x0000000000000000000000000000000000000000" : (buyerAddress.trim() as Hex), total, BigInt(dueDateToTimestamp(dueDate)), memo.trim()],
        chainId: appChain.id,
      });
      const hash = await writeContract(config, request);
      await waitForTransactionReceipt(config, { hash, chainId: appChain.id });
      const draft: InvoiceDraft = {
        id,
        items: parsedItems.map((it) => ({ label: it.label.trim(), amount: it.amount.trim() })),
        total: formatAmount(total),
        buyerName: buyerName.trim(),
        buyerAddress: buyerAddress.trim() ? (buyerAddress.trim() as Hex) : undefined,
        dueDate,
        memo: memo.trim(),
        createdAt: Date.now(),
      };
      saveInvoice(draft);
      setSaved(loadInvoices());
      setCreatedId(id);
      setPhase("done");
    } catch (e) {
      setError(explain(e));
      setPhase("error");
    }
  }

  async function onCopyLink() {
    if (!createdId) return;
    try {
      await navigator.clipboard.writeText(invoiceLink(window.location.origin, createdId));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard unavailable: the link is shown above it.
    }
  }

  const cta = !isConnected
    ? "Hubungkan wallet dulu"
    : !onChain
      ? "Pindah jaringan dulu"
      : !invoiceAddress
        ? "Deploy Invoice dulu"
        : phase === "working"
          ? "Membuat tagihan…"
          : "Buat tagihan";

  return (
    <main className="shell">
      <div className="page-head">
        <div>
          <p className="eyebrow">Tagihan Kilat · Invoice</p>
          <h1>Tagihan</h1>
          <p className="lede">
            Buat tagihan dalam tUSD8 untuk pelanggan warung atau UMKM — kirim linknya lewat WhatsApp, pelanggan bayar tanpa perlu gas
            (mode Gasless), dan uang langsung masuk ke wallet penjual. Jumlahnya dicatat di chain, jadi tidak bisa dibayar kurang.
          </p>
        </div>
      </div>

      {!invoiceAddress ? (
        <div className="card empty">
          Belum ada kontrak Invoice untuk {net.label}. Set <code>NEXT_PUBLIC_INVOICE_{net.key.toUpperCase()}</code> di{" "}
          <code>web/.env.local</code> setelah deploy (lihat halaman Setup).
        </div>
      ) : (
        <div className="row">
          <section className="card stack" aria-label="Buat tagihan" style={{ flex: "1 1 340px" }}>
            <h2>Buat tagihan baru</h2>

            <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 14 }}>
              Nama pembeli <span style={{ color: "var(--text-muted)" }}>(opsional — tampil di daftar)</span>
              <input className="field" value={buyerName} onChange={(e) => setBuyerName(e.target.value)} placeholder="cth: Bu Sari" />
            </label>

            <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 14 }}>
              Alamat wallet pembeli <span style={{ color: "var(--text-muted)" }}>(opsional — kalau diisi, hanya dia yang bisa bayar)</span>
              <input
                className="field"
                value={buyerAddress}
                onChange={(e) => setBuyerAddress(e.target.value)}
                placeholder="0x… (kosongkan = siapa saja boleh bayar)"
              />
            </label>
            {buyerAddress.trim() !== "" && !buyerOk && <p className="fine" style={{ color: "var(--bad)" }}>Alamat wallet tidak valid.</p>}

            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <span style={{ fontSize: 14 }}>Barang / jasa</span>
              {items.map((it, i) => (
                <div key={i} style={{ display: "flex", gap: 8 }}>
                  <input className="field" value={it.label} onChange={(e) => setItem(i, { label: e.target.value })} placeholder="Nama barang" aria-label="Nama barang" />
                  <input
                    className="field"
                    value={it.amount}
                    onChange={(e) => setItem(i, { amount: e.target.value })}
                    placeholder="0.00"
                    inputMode="decimal"
                    aria-label="Jumlah dalam tUSD8"
                    style={{ maxWidth: 130 }}
                  />
                  <button type="button" className="btn small ghost" disabled={items.length <= 1} onClick={() => setItems((p) => p.filter((_, j) => j !== i))} aria-label="Hapus baris">
                    ✕
                  </button>
                </div>
              ))}
              <button type="button" className="btn small secondary" onClick={() => setItems((p) => [...p, { label: "", amount: "" }])}>
                + Tambah baris
              </button>
            </div>

            <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 14 }}>
              Jatuh tempo <span style={{ color: "var(--text-muted)" }}>(opsional — setelah tanggal ini tagihan tidak bisa dibayar)</span>
              <input className="field" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
            </label>

            <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 14 }}>
              Catatan <span style={{ color: "var(--text-muted)" }}>(opsional, maks 200 karakter — tercatat di chain)</span>
              <input className="field" value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="cth: Pesanan makan siang, antar jam 12" maxLength={200} />
            </label>

            <div className="lines">
              <div className="rule" />
              <div className="line" style={{ alignItems: "baseline" }}>
                <span style={{ fontWeight: 600 }}>Total</span>
                <span className="total">
                  {formatAmount(total)} <small>tUSD8</small>
                </span>
              </div>
            </div>

            {error && (
              <div className="notice bad" role="alert">
                <strong>Tagihan gagal dibuat</strong>
                <span>{error}</span>
              </div>
            )}

            {phase === "done" && createdId && (
              <div className="notice good" role="status">
                <strong>Tagihan dibuat! Bagikan link ini ke pembeli:</strong>
                <span className="mono" style={{ overflowWrap: "anywhere" }}>
                  {invoiceLink(typeof window !== "undefined" ? window.location.origin : "", createdId)}
                </span>
                <span style={{ display: "flex", gap: 16 }}>
                  <button type="button" className="btn small" onClick={onCopyLink}>
                    {copied ? "Disalin ✓" : "Salin link"}
                  </button>
                  <Link href={`/invoices/${createdId}`}>Buka halaman bayar</Link>
                </span>
              </div>
            )}

            <button
              type="button"
              className="btn big block"
              disabled={!onChain || !invoiceAddress || phase === "working" || !allValid || !buyerOk || !memoOk || total === 0n}
              onClick={onCreate}
            >
              {cta}
            </button>
            <p className="fine">
              Membuat tagihan adalah satu transaksi dari wallet penjual (butuh sedikit tQDAY untuk gas). Pembayar tidak perlu gas kalau pakai
              mode Gasless.
            </p>
          </section>

          <section className="stack" aria-label="Tagihan saya" style={{ flex: "1.3 1 420px" }}>
            <h2 style={{ fontSize: 18, fontWeight: 600 }}>Tagihan saya</h2>
            {saved.length === 0 ? (
              <div className="card empty">
                Belum ada tagihan di browser ini. Tagihan yang dibuat di sini tersimpan di browser penjual; statusnya dibaca langsung dari
                chain.
              </div>
            ) : (
              saved.map((d) => <InvoiceRow key={d.id} draft={d} />)
            )}
          </section>
        </div>
      )}
    </main>
  );
}
