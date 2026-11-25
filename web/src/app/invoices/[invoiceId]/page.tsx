"use client";

import { authorizationWindow, checkoutTypedData as invoiceTypedData, erc20Abi, invoiceAbi, txUrl } from "@aevum-kit/aevum";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { formatUnits, isHex, type Hash, type Hex } from "viem";
import { useAccount, useConfig, useReadContract } from "wagmi";
import { readContract, signTypedData, simulateContract, waitForTransactionReceipt, writeContract } from "wagmi/actions";
import { CheckIcon } from "@/components/Icons";
import { useToken } from "@/components/useToken";
import { useNetwork } from "@/lib/network";
import { explain } from "@/lib/errors";
import { dueDateLabel, formatAmount, invoiceLabel, loadInvoice, short, type InvoiceDraft } from "@/lib/invoice";

type Mode = "gasless" | "standard";
type Phase = "idle" | "working" | "done" | "error";

const STEPS: Record<Mode, { title: string; who: string }[]> = {
  gasless: [
    { title: "Tanda tangan otorisasi bayar", who: "EIP-3009 · wallet menandatangani, tanpa gas" },
    { title: "Relayer mengirim transaksi", who: "payWithAuthorization · relayer yang bayar gas" },
    { title: "Terkonfirmasi di Aevum", who: "Event Paid adalah struknya" },
  ],
  standard: [
    { title: "Setujui tUSD8", who: "approve(Invoice, jumlah persis) · kamu bayar gas" },
    { title: "Bayar tagihan", who: "Invoice.pay(invoiceId, amount) · kamu bayar gas" },
    { title: "Terkonfirmasi di Aevum", who: "Event Paid adalah struknya" },
  ],
};

const ZERO = "0x0000000000000000000000000000000000000000";

export default function PayInvoicePage() {
  const { net } = useNetwork();
  const appChain = net.chain;
  const invoiceAddress = net.invoice;
  const hasExplorer = net.hasExplorer;
  const config = useConfig();
  const { address, isConnected, chainId } = useAccount();
  const onChain = isConnected && chainId === appChain.id;
  const token = useToken();
  const params = useParams<{ invoiceId: string }>();
  const invoiceId = params.invoiceId;
  const validId = isHex(invoiceId) && invoiceId.length === 66;

  const [mode, setMode] = useState<Mode>("gasless");
  const [step, setStep] = useState(0);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<Hash | null>(null);
  const [block, setBlock] = useState<bigint | null>(null);
  const [draft, setDraft] = useState<InvoiceDraft | undefined>(undefined);

  useEffect(() => {
    if (validId) setDraft(loadInvoice(invoiceId as Hex));
  }, [validId, invoiceId]);

  const relay = useQuery({
    queryKey: ["relay-status", appChain.id],
    queryFn: async () => (await fetch(`/api/relay?chainId=${appChain.id}`)).json() as Promise<{ enabled: boolean; relayer: string | null }>,
  });
  const gaslessAvailable = relay.data?.enabled ?? false;
  useEffect(() => {
    if (relay.data) setMode(relay.data.enabled ? "gasless" : "standard");
  }, [relay.data]);

  const onChainInvoice = useReadContract({
    address: invoiceAddress,
    abi: invoiceAbi,
    functionName: "invoiceOf",
    args: validId ? [invoiceId as Hex] : undefined,
    chainId: appChain.id,
    query: { enabled: validId && Boolean(invoiceAddress), refetchInterval: 10_000 },
  });

  const balance = useReadContract({
    address: token.address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    chainId: appChain.id,
    query: { enabled: onChain && Boolean(token.address) },
  });

  const inv = onChainInvoice.data;
  const exists = Boolean(inv && inv.seller !== ZERO);
  const amount = exists ? inv!.amount : 0n;
  const status = exists ? inv!.status : undefined; // 0 Open, 1 Paid, 2 Cancelled
  const expired = exists && inv!.dueAt !== 0n && BigInt(Math.floor(Date.now() / 1000)) > inv!.dueAt;
  const buyerBound = exists && inv!.buyer !== ZERO;
  const wrongBuyer = buyerBound && address && inv!.buyer.toLowerCase() !== address.toLowerCase();
  const canPay = exists && status === 0 && !expired && !wrongBuyer;
  const enoughBalance = balance.data === undefined || balance.data >= amount;
  const busy = phase === "working";

  function reset(nextMode = mode) {
    setMode(nextMode);
    setStep(0);
    setPhase("idle");
    setError(null);
    setTxHash(null);
    setBlock(null);
  }

  /** Stop before any signature or gas is spent if this invoice was already paid. */
  async function assertUnpaid(id: Hex) {
    if (!invoiceAddress) return;
    const paid = await readContract(config, { address: invoiceAddress, abi: invoiceAbi, functionName: "isPaid", args: [id], chainId: appChain.id });
    if (paid) throw new Error("Tagihan ini sudah lunas.");
  }

  async function payGasless() {
    if (!address || !invoiceAddress || !token.address || !validId) return;
    await assertUnpaid(invoiceId as Hex);
    // 1. Sign. The nonce comes from the contract and ties this signature to this invoice.
    const nonce = await readContract(config, { address: invoiceAddress, abi: invoiceAbi, functionName: "authorizationNonce", args: [invoiceId as Hex], chainId: appChain.id });
    const { validAfter, validBefore } = authorizationWindow(600);
    const signature = await signTypedData(config, {
      account: address,
      ...invoiceTypedData(appChain.id, token.address, { from: address, to: invoiceAddress, value: amount, validAfter, validBefore, nonce }),
    });
    setStep(1);
    // 2. Hand it to the relayer (web/src/app/api/relay/route.ts).
    const res = await fetch("/api/relay", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chainId: appChain.id,
        invoiceId,
        from: address,
        amount: amount.toString(),
        validAfter: validAfter.toString(),
        validBefore: validBefore.toString(),
        signature,
      }),
    });
    const data = (await res.json()) as { hash?: Hash; error?: string };
    if (!res.ok || !data.hash) throw new Error(data.error ?? "Relayer tidak menerima pembayaran.");
    setTxHash(data.hash);
    setStep(2);
    return data.hash;
  }

  async function payStandard() {
    if (!address || !invoiceAddress || !token.address || !validId) return;
    await assertUnpaid(invoiceId as Hex);
    // 1. Approve exactly the invoice total, never an unlimited amount.
    const allowance = await readContract(config, { address: token.address, abi: erc20Abi, functionName: "allowance", args: [address, invoiceAddress], chainId: appChain.id });
    if (allowance < amount) {
      const approveHash = await writeContract(config, { address: token.address, abi: erc20Abi, functionName: "approve", args: [invoiceAddress, amount], chainId: appChain.id });
      await waitForTransactionReceipt(config, { hash: approveHash, chainId: appChain.id });
    }
    setStep(1);
    // 2. Pay. Simulate first: a revert shows up here with its reason, before the wallet asks for gas.
    const { request } = await simulateContract(config, { account: address, address: invoiceAddress, abi: invoiceAbi, functionName: "pay", args: [invoiceId as Hex, amount], chainId: appChain.id });
    const hash = await writeContract(config, request);
    setTxHash(hash);
    setStep(2);
    return hash;
  }

  async function onPay() {
    setError(null);
    setPhase("working");
    setStep(0);
    try {
      const hash = mode === "gasless" ? await payGasless() : await payStandard();
      if (!hash) throw new Error("Hubungkan wallet dulu.");
      const receipt = await waitForTransactionReceipt(config, { hash, chainId: appChain.id });
      if (receipt.status !== "success") throw new Error("Transaksi gagal di chain. Tidak ada yang terpotong.");
      setBlock(receipt.blockNumber);
      setStep(3);
      setPhase("done");
      balance.refetch();
      onChainInvoice.refetch();
    } catch (e) {
      setError(explain(e));
      setPhase("error");
    }
  }

  const cta = (() => {
    if (!isConnected) return "Hubungkan wallet untuk bayar";
    if (!onChain) return "Pindah jaringan untuk bayar";
    if (!invoiceAddress) return "Deploy Invoice dulu";
    if (!canPay) return "Tagihan ini tidak bisa dibayar";
    if (phase === "done") return "Bayar tagihan lain";
    if (phase === "error") return mode === "gasless" ? "Tanda tangan lagi" : "Coba lagi";
    if (busy) return ["Cek wallet…", mode === "gasless" ? "Menunggu relayer…" : "Cek wallet…", "Mengonfirmasi…"][step] ?? "Memproses…";
    return mode === "gasless" ? `Tanda tangan & bayar ${formatAmount(amount)} ${token.symbol}` : `Setujui & bayar ${formatAmount(amount)} ${token.symbol}`;
  })();
  const ctaDisabled = !onChain || !invoiceAddress || !canPay || busy || (!enoughBalance && phase !== "done");

  if (!validId) {
    return (
      <main className="shell">
        <h1>Tagihan tidak ditemukan</h1>
        <p className="lede">ID tagihan itu tidak valid. ID tagihan adalah nilai hex 32 byte (0x + 64 karakter).</p>
      </main>
    );
  }

  return (
    <main className="shell">
      <div className="page-head">
        <div>
          <p className="eyebrow">Tagihan Kilat · Bayar</p>
          <h1>Bayar tagihan {invoiceLabel(invoiceId as Hex)}</h1>
          <p className="lede">Bayar dengan tUSD8. Pilih Gasless kalau kamu tidak punya tQDAY — cukup tanda tangan, relayer yang mengirimkan.</p>
        </div>
      </div>

      <div className="row">
        <section className="card stack" aria-label="Tagihan" style={{ flex: "1 1 340px" }}>
          {!invoiceAddress ? (
            <p className="empty">Belum ada kontrak Invoice untuk {appChain.name}.</p>
          ) : onChainInvoice.isLoading ? (
            <p className="empty">Membaca tagihan dari chain…</p>
          ) : onChainInvoice.isError ? (
            <p className="empty">Tidak bisa membaca tagihan. RPC mungkin sedang sibuk.</p>
          ) : !exists ? (
            <div className="stack">
              <span className="status-pill warn">Tidak ditemukan</span>
              <p style={{ color: "var(--text-muted)" }}>Tidak ada tagihan dengan ID ini di {appChain.name}. Periksa link atau jaringannya.</p>
            </div>
          ) : (
            <>
              <div className="check-top" style={{ alignItems: "baseline" }}>
                <h2>{draft?.buyerName ? `Tagihan untuk ${draft.buyerName}` : "Tagihan"}</h2>
                {status === 1 ? (
                  <span className="status-pill good">Lunas</span>
                ) : status === 2 ? (
                  <span className="status-pill warn">Dibatalkan</span>
                ) : expired ? (
                  <span className="status-pill warn">Kedaluarsa</span>
                ) : (
                  <span className="status-pill warn">Belum dibayar</span>
                )}
              </div>
              <div className="lines">
                {(draft?.items ?? []).map((l) => (
                  <div key={l.label} className="line">
                    <span>{l.label}</span>
                    <span className="num">{l.amount}</span>
                  </div>
                ))}
                {!draft && inv!.memo && (
                  <div className="line">
                    <span>{inv!.memo}</span>
                    <span className="num">{formatAmount(amount)}</span>
                  </div>
                )}
                <div className="rule" />
                <div className="line" style={{ alignItems: "baseline" }}>
                  <span style={{ fontWeight: 600 }}>Total</span>
                  <span className="total">
                    {formatAmount(amount)} <small>{token.symbol}</small>
                  </span>
                </div>
              </div>
              <dl className="kv" style={{ fontSize: 13 }}>
                <dt>Penjual</dt>
                <dd>{short(inv!.seller)}</dd>
                <dt>Jatuh tempo</dt>
                <dd>{dueDateLabel(inv!.dueAt)}</dd>
                {inv!.memo && (
                  <>
                    <dt>Catatan</dt>
                    <dd>{inv!.memo}</dd>
                  </>
                )}
                {status === 1 && (
                  <>
                    <dt>Dibayar oleh</dt>
                    <dd>{short(inv!.payer)}</dd>
                    <dt>Dibayar pada</dt>
                    <dd>{new Date(Number(inv!.paidAt) * 1000).toLocaleString("id-ID")}</dd>
                  </>
                )}
                <dt>Kontrak Invoice</dt>
                <dd>{invoiceAddress ? short(invoiceAddress) : "belum di-deploy"}</dd>
                <dt>Saldo kamu</dt>
                <dd>{balance.data !== undefined ? `${formatUnits(balance.data, token.decimals)} ${token.symbol}` : "—"}</dd>
              </dl>
              {status === 1 && (
                <Link className="btn small" href={`/receipts/${invoiceId}?chain=${appChain.id}${txHash ? `&tx=${txHash}` : ""}`}>
                  Lihat struk
                </Link>
              )}
            </>
          )}
        </section>

        <section className="card stack" aria-label="Pembayaran" style={{ flex: "1.3 1 420px" }}>
          <div className="modes" role="radiogroup" aria-label="Mode pembayaran">
            {(
              [
                { id: "gasless", title: "Gasless", tag: "EIP-3009", desc: gaslessAvailable ? "Tanda tangan sekali. Relayer yang mengirim. Kamu tidak perlu tQDAY." : "Mati: set RELAYER_PRIVATE_KEY di web/.env.local untuk mengaktifkan." },
                { id: "standard", title: "Standar", tag: "approve + pay", desc: "Dua transaksi wallet. Kamu bayar gas dengan tQDAY." },
              ] as const
            ).map((m) => (
              <button
                key={m.id}
                type="button"
                role="radio"
                className="mode"
                aria-checked={mode === m.id}
                disabled={busy || (m.id === "gasless" && !gaslessAvailable)}
                onClick={() => reset(m.id)}
              >
                <span className="mode-top">
                  {m.title}
                  <span className="tag">{m.tag}</span>
                </span>
                <span className="mode-desc">{m.desc}</span>
              </button>
            ))}
          </div>

          <ol className="steps">
            {STEPS[mode].map((s, i) => {
              const done = step > i;
              const active = busy && step === i;
              return (
                <li key={s.title} className={`step ${done ? "done" : active ? "active" : ""}`}>
                  <div className="step-dot">{done ? <CheckIcon /> : i + 1}</div>
                  <div className="step-body">
                    <div className="step-top">
                      <span className="step-title">{s.title}</span>
                      <span className="step-state">{done ? "Selesai" : active ? "Berlangsung…" : "Menunggu"}</span>
                    </div>
                    <p className="step-who">{s.who}</p>
                  </div>
                </li>
              );
            })}
          </ol>

          {wrongBuyer && (
            <div className="notice warn" role="status">
              <strong>Tagihan ini bukan untuk kamu</strong>
              <span>
                Tagihan ini ditujukan ke wallet {short(inv!.buyer)}. Hanya wallet itu yang bisa membayar. Minta penjual membuatkan tagihan baru
                untukmu.
              </span>
            </div>
          )}

          {expired && status === 0 && (
            <div className="notice warn" role="status">
              <strong>Tagihan sudah kedaluarsa</strong>
              <span>Jatuh temponya {dueDateLabel(inv!.dueAt)}. Minta penjual membuatkan tagihan baru.</span>
            </div>
          )}

          {status === 2 && (
            <div className="notice warn" role="status">
              <strong>Tagihan dibatalkan</strong>
              <span>Penjual membatalkan tagihan ini. Tidak ada yang perlu dibayar.</span>
            </div>
          )}

          {!enoughBalance && phase !== "done" && canPay && (
            <div className="notice warn" role="status">
              <strong>tUSD8 tidak cukup</strong>
              <span>
                Tagihan ini {formatAmount(amount)} {token.symbol}. Lihat halaman <Link href="/">Setup</Link> untuk cara mendapatkan token
                test.
              </span>
            </div>
          )}

          {error && (
            <div className="notice bad" role="alert">
              <strong>Pembayaran gagal</strong>
              <span>{error}</span>
            </div>
          )}

          {phase === "done" && txHash && (
            <div className="notice good" role="status">
              <div className="row-between">
                <strong>
                  Lunas {formatAmount(amount)} {token.symbol}
                  {block !== null ? ` · terkonfirmasi di block ${block.toLocaleString("id-ID")}` : ""}
                </strong>
                <span style={{ display: "flex", gap: 16 }}>
                  {hasExplorer && (
                    <a href={txUrl(txHash)} target="_blank" rel="noreferrer">
                      Explorer
                    </a>
                  )}
                  <Link href={`/receipts/${invoiceId}?tx=${txHash}&chain=${appChain.id}`}>Lihat struk</Link>
                </span>
              </div>
            </div>
          )}

          <button type="button" className="btn big block" disabled={ctaDisabled} onClick={onPay}>
            {cta}
          </button>
          <p className="fine">
            {mode === "gasless"
              ? "Tanda tangan berlaku 10 menit, untuk jumlah yang persis sama dengan tagihan, dan hanya untuk tagihan ini."
              : "Persetujuan (approve) hanya untuk jumlah tagihan, tidak pernah tanpa batas."}
          </p>
        </section>
      </div>
    </main>
  );
}
