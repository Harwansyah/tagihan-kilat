# Tagihan Kilat

**Tagihan stabilcoin untuk warung dan UMKM** — buat tagihan dalam tUSD8, kirim linknya lewat WhatsApp, pelanggan bayar tanpa perlu gas, dan uang langsung masuk ke wallet penjual.

Built for **Aevum Builder Challenge #1** (QDay) on **Aevum testnet** (chain `44005`).

> **Demo video:** [Tagihan Kilat — Demo | Aevum Builder Challenge #1](https://www.youtube.com/watch?v=I9j45I5b0dM) — 1:39 walkthrough (buat tagihan → bayar Standard → struk Lunas), recorded on the live demo with test wallets.

## Deployed on Aevum testnet

Deployed **25 Nov 2026** from commit `c57ca74` (deployer `0xf29542B13f26C4A90813415DB583b06d9206C1cf`, test-only wallet funded by the QDay Discord faucet).

| Kontrak | Alamat | Tx deploy |
|---|---|---|
| **Invoice** | [`0x0f54F0c9f4d577f5c7dD55f35eb53D124A4B964F`](https://explorer-test.qday.info/address/0x0f54F0c9f4d577f5c7dD55f35eb53D124A4B964F) | [`0xbc29349619fe387d5571b17299967c1199f9b0f8a6346631c33fd5205149e807`](https://explorer-test.qday.info/tx/0xbc29349619fe387d5571b17299967c1199f9b0f8a6346631c33fd5205149e807) |
| **Checkout** (contoh kit) | [`0x42D1240F55fC27bC936c099e576ab4279A7302F7`](https://explorer-test.qday.info/address/0x42D1240F55fC27bC936c099e576ab4279A7302F7) | [`0x8c558a0ef5693e22e04fa4e2c478b93e53619c5ec597036f9b37530cb050c773`](https://explorer-test.qday.info/tx/0x8c558a0ef5693e22e04fa4e2c478b93e53619c5ec597036f9b37530cb050c773) |

Token: **tUSD8** [`0x456569838f1d43009A91ebA4263147Afd7233483`](https://explorer-test.qday.info/address/0x456569838f1d43009A91ebA4263147Afd7233483) (6 desimal).

**Bukti end-to-end di testnet asli (25 Nov 2026):** dua tagihan dibuat dan dibayar lewat kontrak yang di-deploy — saldo penjual naik persis sebesar tagihan, dan event `Paid` tercatat di chain untuk keduanya.

| Tagihan | Cara bayar | Tx buat | Tx bayar |
|---|---|---|---|
| A — 0,50 tUSD8 "Nasi goreng x2, Es teh x1" | Standar (approve + pay) | [`0x66093a49…5e8282`](https://explorer-test.qday.info/tx/0x66093a4976665e04b546fc96a14e2c28047040f27db9e3060da688e55d5e8282) | [`0x5444dd8c…2b81b`](https://explorer-test.qday.info/tx/0x5444dd8cc005a6f45b82e781ed108fb01daece572208a1928ed8289504b2b81b) |
| B — 0,25 tUSD8 "Kopi susu x1" | Gasless (EIP-3009, relayer yang kirim) | [`0x52780e63…93d37a`](https://explorer-test.qday.info/tx/0x52780e63c804248d747dc463ec9f03af70b93633ec0d81fe585742df8f93d37a) | [`0x82cb24be…40ec`](https://explorer-test.qday.info/tx/0x82cb24be0c44ea6393e96a7943f89e5d88461351b4869bfae878544ee0a340ec) |

Catatan: pembayaran Gasless di atas dilakukan dengan memanggil `payWithAuthorization` langsung dari wallet relayer (jalur on-chain yang sama yang dipakai route `/api/relay`); route HTTP relayernya sendiri sudah teruji di E2E fork lokal. Sisa saldo deployer setelah E2E: ~0,948 tQDAY + 4,75 tUSD8.

## Masalahnya

Penjual kecil di Indonesia — warung makan, penjual kopi keliling, UMKM — sudah jualan lewat WhatsApp, tapi pembayarannya masih manual: transfer bank lalu kirim bukti screenshot, atau bayar tunai. Tidak ada tagihan yang bisa dicek statusnya, tidak ada bukti bayar yang bisa dipercaya kedua pihak.

Tagihan Kilat memberi mereka tagihan digital yang sederhana:

1. **Penjual** buat tagihan (barang + harga dalam tUSD8, nama pembeli, jatuh tempo) — satu transaksi, lalu bagikan link bayar lewat WhatsApp.
2. **Pembeli** buka link, bayar dengan tUSD8. Tidak punya tQDAY untuk gas? Pakai mode **Gasless**: cukup tanda tangan, relayer yang mengirimkan transaksinya.
3. **Keduanya** melihat status yang sama: tagihan berubah jadi **Lunas** dan struknya bisa dibuka siapa saja dari chain.

Tidak ada deposit, tidak ada biaya langganan, tidak ada akun yang harus dibuat — wallet adalah akunnya.

## Yang baru dari kit

Tagihan Kilat dibangun di atas Aevum Starter Kit, dan satu-satunya kontrak baru adalah intinya: `contracts/src/Invoice.sol`.

**Masalah yang diperbaiki.** Kit mendokumentasikan kelemahan `Checkout`: siapa pun bisa menandai order apa pun sebagai "lunas" dengan pembayaran debu — `pay(orderId, 1)` mendahului pembeli asli. `Invoice` memperbaikinya: **jumlah pembayaran diputuskan di chain, bukan oleh pemanggil**. `pay` dan `payWithAuthorization` sama-sama revert (`WrongAmount`) kecuali jumlahnya persis sama dengan tagihan. Selain itu:

- **Pembeli terikat** — kalau tagihan menyebut satu wallet pembeli, hanya wallet itu yang bisa membayar (`WrongPayer`).
- **Jatuh tempo** — setelah tanggal jatuh tempo tagihan tidak bisa dibayar (`InvoiceExpired`).
- **Batalkan** — penjual bisa membatalkan tagihan yang masih terbuka (`InvoiceIsCancelled`).
- **Dua cara bayar, seperti kit** — standar (approve + pay) dan gasless (EIP-3009 + relayer). Nonce tanda tangan terikat ke satu invoice (`authorizationNonce`), jadi tidak bisa dipakai ulang untuk tagihan lain.

`Checkout.sol` tetap ada di repo sebagai contoh dari kit, lengkap dengan tesnya — aplikasi ini tidak memakainya.

## Arsitektur

```
Penjual ──► web/src/app/invoices (buat tagihan) ──► Invoice.createInvoice ──► Aevum testnet
Pembeli ──► web/src/app/invoices/[id] (bayar) ──┬─► Standard: approve + Invoice.pay
                                                 └─► Gasless: sign EIP-3009 ──► /api/relay ──► Invoice.payWithAuthorization
Semua ──► web/src/app/receipts/[id] (struk, baca Invoice.invoiceOf)
        └─► web/src/app/activity (event Paid, dibaca per 1.000 block)
```

- **Kontrak** — `contracts/src/Invoice.sol` (Solidity 0.8.24, EVM Shanghai). Data per tagihan: `{seller, buyer, amount, dueAt, status, payer, paidAt, memo}`. Uang langsung ke penjual; kontrak tidak pernah menahan dana.
- **Web** — Next.js 16 + wagmi/RainbowKit, Bahasa Indonesia. Rincian tagihan (nama barang, nama pembeli) disimpan di `localStorage` penjual; chain adalah sumber kebenaran untuk jumlah, status, pembayar, dan waktu bayar.
- **Relayer** — `web/src/app/api/relay/route.ts` (dari kit, dijaga relnya): hanya `payWithAuthorization` di kontrak Invoice kita, hanya jumlah persis dari `invoiceOf` (dibaca dari chain, bukan dari request), hanya dari pembeli yang dituju, lewati yang sudah lunas/dibatalkan/kedaluarsa, simulasi dulu, lalu rate limit per IP/pembeli + batas harian.
- **Tes** — 21 tes unit `Invoice.t.sol` (termasuk fuzz) + 3 tes fork `InvoiceFork.t.sol` melawan tUSD8 asli; 11 tes unit `Checkout.t.sol` + 3 tes fork kit tetap hijau. Skrip E2E `web/scripts/e2e-fork.mjs` menjalankan alur lengkap di fork lokal: buat tagihan → bayar Standar → buat tagihan → bayar Gasless → cek relayer menolak pembayaran kedua.

Detail lengkap: [`docs/architecture.md`](docs/architecture.md) dan halaman **Dokumen** di aplikasi.

## Alur (workflow)

| Siapa | Langkah |
|---|---|
| Penjual | Hubungkan wallet → buka **Tagihan** → isi barang + harga, nama pembeli (opsional), alamat wallet pembeli (opsional), jatuh tempo, catatan → **Buat tagihan** → salin link, kirim ke pembeli |
| Pembeli | Buka link → periksa jumlah + penjual → pilih **Gasless** (tanda tangan saja) atau **Standar** (approve + bayar) → tunggu konfirmasi → buka **Struk** |
| Penjual | Lihat daftar **Tagihan saya** — status dibaca langsung dari chain (Belum dibayar / Lunas / Dibatalkan / Kedaluarsa); batalkan tagihan terbuka kalau perlu |

## Teknologi

- **Solidity 0.8.24** (Foundry, EVM Shanghai — Cancun tidak ada di Aevum), OpenZeppelin 5.1.0 (`SafeERC20`, `IERC20`)
- **tUSD8** — stablecoin USDC-style di Aevum testnet (`0x456569838f1d43009A91ebA4263147Afd7233483`, 6 desimal, EIP-2612 + EIP-3009)
- **Next.js 16** (App Router), **wagmi 2 + viem 2**, **RainbowKit 2**, **TanStack Query**
- **Node 22+**, **pnpm 10**, **Foundry 1.10**

## Menjalankan

```bash
git clone --recursive <repo-url>
cd <repo>
make install          # Solidity libs + JS packages
make check            # build, Shanghai opcode check, unit tests, fork tests, typecheck
```

Jalankan seluruh aplikasi di **salinan lokal Aevum** (tUSD8 asli, saldo test gratis):

```bash
# terminal 1: salinan lokal Aevum testnet di 127.0.0.1:8555 (chain 440050)
make fork

# terminal 2: deploy Invoice + Checkout, beri dirimu uang test
make deploy-fork                      # mencetak alamat Invoice dan Checkout
make deal TO=<alamat wallet kamu>     # 100 tUSD8 + 10 tQDAY, hanya di fork

cp web/.env.example web/.env.local
#   NEXT_PUBLIC_NETWORKS=fork,aevum
#   NEXT_PUBLIC_INVOICE_FORK=<alamat Invoice dari deploy-fork>
#   RELAYER_PRIVATE_KEY=<kunci test anvil>   (opsional: mengaktifkan mode Gasless)
make dev                              # http://localhost:3000
```

Coba alur lengkap tanpa browser: `node web/scripts/e2e-fork.mjs` (dari folder `web/`) — membuat 2 tagihan, membayar satu secara Standar dan satu secara Gasless lewat relayer, lalu memeriksa halaman-halaman merespons 200.

### Deploy ke Aevum testnet

```bash
cast wallet import aevum-deployer --interactive   # kunci wallet TEST saja
cast wallet address --account aevum-deployer      # isi dari faucet Discord
make deploy-aevum ACCOUNT=aevum-deployer          # mencetak alamat Invoice + Checkout
```

**Sudah di-deploy 25 Nov 2026** (lihat [bagian Deployed di atas](#deployed-on-aevum-testnet)): Invoice `0x0f54F0c9f4d577f5c7dD55f35eb53D124A4B964F`, Checkout `0x42D1240F55fC27bC936c099e576ab4279A7302F7`.

Lalu set `NEXT_PUBLIC_INVOICE_AEVUM` di `web/.env.local` dan tambahkan `aevum` ke `NEXT_PUBLIC_NETWORKS`. Untuk relayer di jaringan asli, beri wallet test sendiri dengan sedikit tQDAY — jangan pernah pakai kunci anvil (kuncinya publik).

### Deploy web app (Vercel)

Root Directory `web`, dan di Project Settings set:

- `NEXT_PUBLIC_NETWORKS=aevum`
- `NEXT_PUBLIC_INVOICE_AEVUM=<alamat Invoice>`
- `NEXT_PUBLIC_CHECKOUT_AEVUM=<alamat Checkout>` (opsional, referensi)
- `RELAYER_PRIVATE_KEY=<kunci wallet test relayer>`
- `TRUSTED_IP_HEADER=x-vercel-forwarded-for`

> **Judging counts activity on Aevum.** Kontrak, pembayaran, dan transfer harus terjadi di Aevum testnet. Yang hanya selesai di chain lain tidak dihitung.

## Perintah

```
make install        Ambil Solidity libs + JS packages
make build          Kompilasi kontrak + cek Shanghai-safe
make test           Tes unit (lokal, tanpa jaringan)
make test-fork      Tes melawan tUSD8 asli di fork lokal Aevum
make check          Semua yang dijalankan CI
make anvil          Chain lokal kosong (31337) dengan aturan EVM Aevum
make fork           Salinan lokal Aevum testnet di 127.0.0.1:8555 (chain 440050)
make deploy-local   Deploy MockUSD8 + Checkout + Invoice ke `make anvil`
make deploy-fork    Deploy Checkout + Invoice (tUSD8 asli) ke `make fork`
make deploy-aevum   Deploy Checkout + Invoice ke Aevum testnet (ACCOUNT=<keystore>)
make mint           Hanya `make anvil`: mint MockUSD8 (TO=, AMOUNT=)
make deal           Hanya `make fork`: beri TO tUSD8 dan tQDAY
make dev            Jalankan web app
```

## Batasan yang diketahui

- Rincian tagihan (nama barang, nama pembeli) hanya tersimpan di browser penjual (`localStorage`). Kalau penjual ganti browser, daftar "Tagihan saya" kosong — tapi tagihannya tetap ada di chain dan bisa dibuka lewat linknya. Penyimpanan bersama (database) adalah langkah berikutnya.
- Relayer menyimpan rate limit di memori proses (warisan kit): cukup untuk satu server, pindah ke Redis/database sebelum dipakai di serverless.
- Verifikasi kontrak di explorer belum tersedia — sertakan alamat + commit yang di-deploy di submission.
- Hanya satu alur (tagihan) yang dibangun; tidak ada payroll, crowdfunding, atau fitur lain.

## Lisensi dan kredit

- **Tagihan Kilat** — MIT. Lihat [`LICENSE`](LICENSE).
- **Based on Aevum Starter Kit (MIT, PQA Labs)** — kit ini © 2026 PQA Labs, lisensi MIT. File `LICENSE` dan `NOTICE.md` dari kit dipertahankan; header copyright di file-file yang disalin dari kit tetap ada. `Checkout.sol`, contoh-contoh di `examples/`, dan halaman Setup adalah karya kit.
- Dependensi pihak ketiga dan lisensinya: lihat [`NOTICE.md`](NOTICE.md).

## Submitting

Untuk Aevum Builder Challenge #1 di DoraHacks (`dorahacks.io/hackathon/qday`): repo publik ini + demo live + dokumen ini. Deadline **11 Des 2026 15:00 WIB**; judging 12–14 Des; pemenang 15 Des. Top 5 mempresentasikan demo 3–5 menit lewat video call.
