# Arsitektur Tagihan Kilat

## Gambaran

Tagihan Kilat adalah satu alur end-to-end: **penjual membuat tagihan → pembeli membayar → keduanya melihat struk yang sama**. Semua yang penting (jumlah, status, pembayar, waktu bayar) hidup di chain; rincian yang hanya untuk dibaca manusia (nama barang, nama pembeli) hidup di browser penjual.

```
┌─────────┐  createInvoice   ┌──────────────────┐
│ Penjual │ ───────────────► │  Invoice.sol     │
│ (web)   │  (1 tx, gas)     │  Aevum testnet   │
└─────────┘                  │  chain 44005     │
     ▲                       │                  │
     │ link bayar            │  pay /           │
     │ (WhatsApp)            │  payWithAuth     │
     ▼                       └──────┬───────────┘
┌─────────┐  approve+pay            │ Paid event
│ Pembeli │ ───────────────► ───────┘
│ (web)   │  atau sign EIP-3009 ──► /api/relay ──► payWithAuthorization
└─────────┘                          (relayer bayar gas)
```

## Kontrak: `contracts/src/Invoice.sol`

Satu kontrak, satu token (`tUSD8`, 6 desimal), satu penjual per tagihan. Berasal dari `Checkout.sol` milik kit — README kit sendiri menyuruh "rename Checkout into whatever you're building (an invoice…)" — dengan satu perbaikan yang menentukan.

### Data

```solidity
struct InvoiceData {
    address seller;
    address buyer;    // address(0) = siapa saja boleh bayar
    uint256 amount;   // base unit tUSD8
    uint64  dueAt;    // 0 = tanpa batas waktu
    uint64  createdAt;
    Status  status;   // Open | Paid | Cancelled
    address payer;
    uint64  paidAt;
    string  memo;     // maks 200 byte, mis. "Nasi goreng x2, Es teh x1"
}
```

### Fungsi

| Fungsi | Siapa | Aturan |
|---|---|---|
| `createInvoice(id, buyer, amount, dueAt, memo)` | penjual | id belum dipakai; amount > 0; memo ≤ 200 byte |
| `pay(id, amount)` | pembeli (setelah `approve`) | lihat guard di bawah |
| `payWithAuthorization(id, from, amount, validAfter, validBefore, v, r, s)` | siapa saja (relayer) | tanda tangan EIP-3009 dari pembeli; nonce = `authorizationNonce(id)` |
| `cancelInvoice(id)` | penjual, saat Open | — |
| `invoiceOf(id)` / `isPaid(id)` / `isExpired(id)` | siapa saja (view) | — |
| `authorizationNonce(id)` | siapa saja (view) | `keccak256(abi.encode(address(this), id))` |

### Guard pembayaran (`_checkPayable`, dipakai kedua cara bayar)

1. Tagihan ada, masih Open (bukan Paid/Cancelled).
2. Belum lewat `dueAt`.
3. **Jumlah harus persis sama** (`WrongAmount`) — ini perbaikan atas kelemahan kit, di mana `pay(orderId, 1)` bisa menandai order sebagai lunas dan mendahului pembeli asli.
4. Kalau `buyer` diisi, hanya wallet itu yang boleh bayar (`WrongPayer`).

Uang langsung ditransfer ke penjual (`safeTransferFrom` untuk Standar, `receiveWithAuthorization` + `safeTransfer` untuk Gasless). Kontrak tidak pernah menahan dana. Event `Paid(invoiceId, payer, amount)` adalah struk — tanda tangannya sama dengan `Checkout`, jadi halaman struk dan aktivitas membaca event yang sama.

### Kenapa bukan `Checkout` saja

`Checkout` memutuskan harga di aplikasi (`priceOf`), bukan di chain. Artinya "lunas" hanya bisa dipercaya kalau aplikasi ikut memeriksa jumlah — dan siapa pun bisa memanggil `pay(orderId, 1)`. Di Tagihan Kilat, jumlah adalah bagian dari tagihan itu sendiri, jadi `isPaid == true` selalu berarti uang penuh sudah sampai ke penjual. Halaman struk tidak perlu lagi memeriksa jumlah secara terpisah.

## Web app: `web/` (Next.js 16, wagmi, RainbowKit)

| Rute | Isi |
|---|---|
| `/` (Setup) | Pemeriksa: wallet, jaringan, saldo gas, saldo tUSD8, kontrak Invoice ter-deploy. Dari kit, dialihkan ke Invoice + Bahasa Indonesia. |
| `/invoices` | Buat tagihan (form: nama pembeli, alamat wallet pembeli, baris barang + harga, jatuh tempo, catatan) + daftar "Tagihan saya" (dari `localStorage`, status dibaca live dari chain, tombol salin link + batalkan). |
| `/invoices/[id]` | Halaman bayar: rincian tagihan dari chain (+ rincian dari `localStorage` kalau ada), pilih mode Gasless/Standar, langkah-langkah, dan tombol bayar. Menolak bayar kalau tagihan bukan untuk wallet yang terhubung, sudah kedaluarsa, atau dibatalkan. |
| `/receipts/[id]` | Struk: hanya percaya `invoiceOf` — status Lunas berarti uang penuh sampai ke penjual. Menampilkan penjual, pembayar, jumlah, jatuh tempo, catatan, dan transaksi (kalau link membawa `?tx=` dan transaksi itu benar-benar mengeluarkan event `Paid` untuk tagihan ini). |
| `/activity` | Semua event `Paid` dari kontrak Invoice, dibaca per 1.000 block (`getLogsChunked`) karena Aevum membatasi `eth_getLogs`. |
| `/docs` | Dokumentasi lengkap di satu halaman (kit + bagian "How invoices work"). |
| `/api/relay` | Relayer Gasless (lihat bawah). |

### Pustaka bersama

- `packages/aevum/` (dari kit, tidak diubah kecuali `contracts.ts`): konfigurasi chain, ABI `checkoutAbi` + **`invoiceAbi`** (baru), helper EIP-3009, `getLogsChunked`.
- `web/src/lib/invoice.ts` (baru): model `InvoiceDraft`, `localStorage` (simpan/muat daftar tagihan), `newInvoiceId`, `parseAmount`/`formatAmount` (6 desimal), `dueDateToTimestamp`/`dueDateLabel`, `invoiceLink`.
- `web/src/lib/env.ts`: `Network` mendapat field `invoice` (`NEXT_PUBLIC_INVOICE_AEVUM/FORK/LOCAL`). Field `checkout` dipertahankan untuk contoh kit.
- `web/src/lib/errors.ts`: pesan error berbahasa Indonesia untuk revert `Invoice` (`WrongAmount`, `WrongPayer`, `InvoiceExpired`, `InvoiceIsCancelled`, `InvoiceNotFound`, `MemoTooLong`).
- `web/src/components/useToken.ts`: token dibaca dari `Invoice.token()` (jatuh ke tUSD8 kalau tidak ada kontrak).

## Relayer: `web/src/app/api/relay/route.ts`

Dari kit, dengan rel yang sama — hanya targetnya berubah dari `Checkout` ke `Invoice`, dan satu rel diperkuat:

1. Hanya kontrak Invoice kita, hanya `payWithAuthorization`.
2. **Hanya jumlah persis dari `invoiceOf`** — dibaca dari chain di dalam route, bukan dari body request. Pemanggil tidak bisa meminta relayer membayar jumlah lain.
3. Hanya dari pembeli yang dituju (kalau tagihan menyebut pembeli).
4. Lewati tagihan yang sudah lunas, dibatalkan, atau kedaluarsa — dan yang sedang dikirim.
5. Simulasi dulu (tanda tangan jelek/kedaluarsa tidak makan gas).
6. Rate limit per IP (10/menit) dan per pembayar (3/menit), batas harian 500 tx, jendela tanda tangan maks 1 jam, kunci anvil ditolak di jaringan asli.

Batas-batas ini hidup di memori proses — cukup untuk satu server `next start`; di serverless pindahkan ke penyimpanan bersama (Redis/database). Kunci relayer adalah wallet test berisi sedikit tQDAY, bukan wallet bernilai.

## Pengujian

```
make check          # build + Shanghai check + tes unit + tes fork + typecheck
make test           # 32 tes unit: 21 Invoice (termasuk fuzz) + 11 Checkout
make test-fork      # 6 tes fork vs tUSD8 asli: 3 Invoice + 3 Checkout
node web/scripts/e2e-fork.mjs   # E2E di fork lokal (dari folder web/)
```

E2E (`web/scripts/e2e-fork.mjs`, 20 checks): penjual membuat tagihan 2,50 tUSD8 → pembeli membayar Standar (approve + pay) → saldo penjual naik persis 2,50 → penjual membuat tagihan 1,25 tUSD8 → pembeli menandatangani EIP-3009 → relayer mengirimkan (tx dari wallet relayer, bukan pembeli) → tagihan Lunas → relayer menolak pembayaran kedua (409) → semua halaman merespons 200.

## Keputusan yang sengaja tidak diambil

- **Tidak ada database.** Rincian tagihan hanya di `localStorage` penjual supaya tidak ada backend yang harus dijaga selama hackathon. Konsekuensinya: daftar "Tagihan saya" hilang kalau ganti browser — tagihannya sendiri tetap ada di chain dan bisa dibuka dari linknya.
- **Tidak ada harga dalam rupiah.** Jumlah tagihan ditulis langsung dalam tUSD8; konversi harga adalah urusan penjual.
- **Satu alur saja.** Payroll, crowdfunding, dan Confirmation of Payee sengaja tidak dibangun — satu alur yang selesai penuh lebih meyakinkan daripada tiga alur setengah jadi.
- **Tidak ada akun/registrasi.** Wallet adalah identitasnya; tidak ada server yang menyimpan data pengguna.

## Yang masih terbuka (setelah build ini)

1. **Faucet Discord** — butuh akun Discord harwansyah untuk `/faucet` (1 tQDAY + 5 tUSD8) sebelum deploy ke Aevum testnet asli.
2. **Deploy testnet + demo live (Vercel)** — setelah token faucet didapat.
3. **Repo GitHub publik** (di bawah `Harwansyah`) + pin di profil.
4. **Video demo 2 menit** — rekam alur buat → bayar Gasless → struk Lunas.
5. **Submit di DoraHacks** — sebelum 11 Des 2026 15:00 WIB, dari akun harwansyah. Kalau masuk Top 5: demo live 3–5 menit di video call, 15 Des.
