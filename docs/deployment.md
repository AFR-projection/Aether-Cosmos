# Deploy Storage ByAFR di VPS Ubuntu (dari nol)

Panduan production untuk user **non-developer**.  
Target: VPS Ubuntu fresh + domain → **`./install.sh`** → selesai dengan HTTPS.

> Local development → lihat [README.md](README.md)

---

## 🔁 Redeploy / update (baca ini dulu kalau udah pernah install)

Udah pernah deploy dan cuma mau naikin fitur/fix terbaru? **Cukup 3 baris, ga ada langkah tambahan:**

```bash
cd /opt/storage-by-afr
git pull          # ambil update terbaru dari GitHub
./update.sh       # backup → validate → rebuild → migrate DB → health check
```

Atau lebih singkat lagi — `./update.sh` **otomatis `git pull` sendiri**, jadi bisa langsung:

```bash
cd /opt/storage-by-afr && ./update.sh
```

Itu aja. Script-nya ngurusin semuanya: backup `.env` + nginx, rebuild container, sinkron schema database, renew SSL, dan health check di akhir. Kalau ada yang gagal, dia berhenti dan kasih tau.

**Syarat: push dulu ke GitHub.** `./update.sh` menarik kode dari repo, jadi commit + push perubahan lu dulu dari PC lokal sebelum jalanin di VPS.

### Kenapa update DB selalu aman (ga perlu langkah manual)

- Database (**Neon**) dan Redis itu **layanan eksternal** — VPS cuma nyambung ke sana, DB-nya sama persis dengan yang dipakai saat development.
- `./update.sh` menyinkronkan schema via **`npm run db:push`** (bukan `drizzle-kit migrate`). `db:push` membandingkan `lib/db/schema.ts` langsung ke DB dan hanya menerapkan yang beda — kalau schema & DB udah cocok, dia **no-op** (ga ngapa-ngapain).
- Perubahan schema yang sudah diterapkan ke Neon saat development (contoh: rename kolom, kolom enkripsi, index full-text) **sudah live** begitu VPS konek — jadi redeploy tinggal rebuild kode aplikasinya.

> ⚠️ **Perhatian rename kolom.** `db:push` aman untuk nambah kolom/index. Tapi untuk **rename kolom**, terapkan dulu perubahannya ke Neon **sebelum** redeploy (biar `db:push` lihatnya sebagai "sudah cocok", bukan "drop kolom lama + bikin baru" yang menghapus data). Selama alurnya "apply ke Neon dulu → baru redeploy", data aman.

---

## Ringkasan install pertama (30 detik)

```bash
ssh ubuntu@IP-VPS
git clone <repo-url> /opt/storage-by-afr
cd /opt/storage-by-afr
chmod +x install.sh deploy.sh update.sh

cp .env.example .env
nano .env    # isi DATABASE_URL, R2, domain — paste 1 baris penuh!

./install.sh
```

**`.env` manual** — sama seperti dulu. Wizard opsional: `./install.sh --wizard`

---

## Server requirement

| Item | Minimum |
|------|---------|
| OS | Ubuntu 22.04 / 24.04 LTS |
| RAM | 2 GB (4 GB recommended) |
| CPU | 2 vCPU |
| Disk | 20 GB SSD |
| Port | **80** dan **443** terbuka (firewall + cloud security group) |

### Layanan eksternal (gratis tier OK)

1. **Neon PostgreSQL** — https://neon.tech  
2. **Cloudflare R2** — https://dash.cloudflare.com → R2  
3. **Domain** — A record mengarah ke IP VPS

---

## Langkah 1 — Siapkan domain

Di panel DNS domain kamu:

| Type | Name | Value |
|------|------|-------|
| A | storage (atau @) | IP-VPS-KAMU |

Tunggu 5–30 menit sampai DNS propagate.  
Cek: `ping storage.example.com` harus menunjuk ke IP VPS.

---

## Langkah 2 — Firewall VPS

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
sudo ufw status
```

Di panel cloud provider (Tencent, AWS, dll.) buka juga **Security Group** port 80 & 443.

---

## Langkah 3 — Buat `.env` & install

```bash
ssh ubuntu@IP-VPS

sudo apt update && sudo apt install -y git curl

git clone <repo-url> /opt/storage-by-afr
cd /opt/storage-by-afr

chmod +x install.sh deploy.sh update.sh

cp .env.example .env
nano .env
```

### Isi `.env` (contoh)

```env
NODE_ENV=production
DEPLOY_DOMAIN=storage.dataku.id
CERTBOT_EMAIL=admin@storage.dataku.id

DATABASE_URL=postgresql://user:pass@ep-xxx.neon.tech/neondb?sslmode=require

R2_ACCOUNT_ID=...
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_BUCKET_NAME=strogebyafr
R2_PUBLIC_URL=https://pub-xxxx.r2.dev

MASTER_USERNAME=ByAFR
MASTER_PASSWORD=password-min-10-char
SESSION_SECRET=random-64-char-hex

NEXT_PUBLIC_APP_URL=https://storage.dataku.id
COOKIE_SECURE=true
HSTS_ENABLED=true
REDIS_URL=redis://redis:6379
REDIS_DISABLED=false
```

**Penting:** `DATABASE_URL` harus **1 baris penuh** dari Neon.  
Jangan sampai terpotong jadi `...?sslmode>` — itu penyebab deploy gagal.

Deploy:

```bash
./install.sh
```

Script otomatis:
- Validasi `.env` (format)
- Request SSL Let's Encrypt
- Generate nginx config
- Build & start Docker (app, worker, redis, nginx)
- Database migrate + admin bootstrap

### Wizard (opsional)

Kalau mau wizard interaktif: `./install.sh --wizard`
- Build & start containers
- Database migration + bootstrap admin
- Health check semua service

**Output sukses:**

```
Application : Running
Database    : Connected
Redis       : OK
Worker      : OK
SSL         : Active
URL         : https://storage.example.com
```

### Setelah install — aktifkan WhatsApp (OTP)

OTP & notifikasi WA butuh **sender terhubung** (Baileys). Setelah app jalan:

1. Login sebagai master → **Admin → WhatsApp**
2. **Add Sender** → scan QR atau pakai pairing code
3. Pastikan status **Connected** (hijau)
4. Coba register user baru — harus terima pesan pairing di WhatsApp

Setelah itu, session tersimpan di volume Docker `wa_sessions` dan **auto-restore** tiap restart/update.

---

## Langkah 4 — R2 CORS (wajib untuk upload)

1. Edit `docker/r2-cors.json` — ganti `your-domain.com` dengan domain kamu  
2. Cloudflare Dashboard → R2 → Bucket → Settings → CORS  
   Atau via Wrangler:
   ```bash
   wrangler r2 bucket cors set NAMA-BUCKET --file docker/r2-cors.json
   ```

---

## Neon: allowlist IP VPS

Neon free tier kadang perlu allow IP VPS:
- Neon Dashboard → Project → Settings → IP Allow  
- Tambahkan IP publik VPS kamu

---

## Perintah sehari-hari

| Command | Fungsi |
|---------|--------|
| `./install.sh` | Install pertama (wizard + deploy) |
| `./deploy.sh` | Deploy ulang pakai `.env` existing (tanpa `git pull`) |
| `./update.sh` | **Redeploy/update** — git pull + backup + rebuild + migrate + health check |
| `npm run deploy:logs` | Lihat log |
| `npm run deploy:health` | Cek status service |

> **`./update.sh` vs `./deploy.sh`:** pakai **`./update.sh`** untuk naikin versi (dia pull kode terbaru + backup + migrate). Pakai `./deploy.sh` kalau cuma mau rebuild dari kode yang sudah ada di VPS tanpa narik update.

---

## Backup

Installer backup otomatis saat `./update.sh`:
- `.deploy/backups/.env.TIMESTAMP`
- `.deploy/backups/nginx.TIMESTAMP.conf`

Backup manual yang disarankan:
- File `.env` (simpan offline, berisi secrets)
- Neon: built-in backup / branch di dashboard
- R2: data sudah di Cloudflare

---

## Update versi aplikasi

```bash
cd /opt/storage-by-afr
./update.sh
```

Otomatis: backup → git pull → validate → rebuild → migration → health check.

---

## Troubleshooting

### Login tidak work / CSRF error

- Pastikan akses via **HTTPS** (`https://domain.com`)
- `NEXT_PUBLIC_APP_URL` di `.env` harus `https://domain.com` (wizard set otomatis)
- Rebuild app setelah ubah URL: `./deploy.sh`

### SSL gagal

- DNS belum pointing ke VPS → perbaiki A record, tunggu propagate
- Port 80 blocked → buka firewall & security group
- Jalankan ulang: `sudo bash scripts/deploy/ssl.sh`

### Docker permission denied

```bash
sudo usermod -aG docker $USER
newgrp docker
# atau langsung:
sudo ./install.sh
```

Installer otomatis pakai `sudo docker` jika perlu.

### Database connection failed

- Cek `DATABASE_URL` di Neon dashboard — **harus 1 baris penuh** (jangan terpotong)
- Neon → Project Settings → **IP Allow** → tambahkan IP VPS (installer menampilkan IP saat gagal)
- Atau nonaktifkan IP restriction sementara di Neon
- Test: `npm run deploy:health`

### `.env` rusak (ada `"` atau baris baru di tengah value)

Bug wizard lama bisa menghasilkan:

```env
R2_SECRET_ACCESS_KEY="
acf230cb..."
```

Perbaiki otomatis:

```bash
./install.sh --fix-env
```

Atau buat ulang dari wizard:

```bash
./install.sh --force-wizard
```

### Upload gagal (CORS)

- Update R2 CORS dengan domain HTTPS kamu
- `NEXT_PUBLIC_APP_URL` harus match browser URL

### File terenkripsi: download minta passphrase / tidak bisa masuk ZIP

Ini **normal & disengaja**, bukan bug. File yang diupload dengan enkripsi itu **end-to-end** (dienkripsi di browser sebelum sampai ke server), jadi:

- **Download** file terenkripsi akan memunculkan dialog passphrase dulu, lalu didekripsi di browser dan disimpan sebagai file asli. Passphrase **tidak pernah** dikirim ke server.
- **ZIP / batch download** menolak file terenkripsi — server tidak memegang passphrase sehingga tidak bisa memasukkan file aslinya ke arsip. Download file terenkripsi satu per satu.
- Kalau passphrase hilang, file **tidak bisa** dipulihkan oleh siapa pun (termasuk admin) — itu memang inti dari enkripsi E2E.

### Worker FAIL di health check

```bash
docker compose -f docker/docker-compose.yml logs worker --tail 50
```

Penyebab umum: Redis down, DATABASE_URL salah, R2 credential invalid.

### OTP / notifikasi WhatsApp tidak jalan

WhatsApp di app ini **self-hosted (Baileys)** — bukan Fonnte/Twilio. Session disimpan di disk (`wa-sessions/`) dan socket harus hidup di proses app.

Setelah deploy/update VPS:

1. Pastikan volume `wa_sessions` terpasang (sudah di `docker-compose.yml`).
2. Cek log bootstrap:
   ```bash
   docker compose -f docker/docker-compose.yml logs app --tail 100 | grep -i WA
   ```
   Harus ada `[WA Bootstrap] Restored ...` atau `[WA] Connected: ...`.
3. Kalau `missingSession` / status `disconnected`: buka **Admin → WhatsApp**, reconnect (QR atau pairing code). Session lama hilang kalau deploy sebelum volume diaktifkan.
4. Satu instance app saja (jangan scale replica) — socket Baileys stateful di memory.
5. Setelah reconnect sekali, restart/redeploy berikutnya harus auto-restore (session di volume).

Health check menampilkan baris **WhatsApp** (`OK` / `WARN` / `FAIL`).

### HTTP 403 saat curl homepage

Sudah diperbaiki — bot block tidak lagi block halaman utama.  
Protected API tetap aman.

### Reset password admin

```bash
docker compose -f docker/docker-compose.yml --profile setup run --rm setup
# atau di host dengan .env:
npm run reset-master-password
```

---

## Arsitektur deploy

```
Internet → Nginx (:443 SSL) → Next.js app (:3000)
                           ↘ Redis → Worker (thumbnail, cleanup)
Neon PostgreSQL (external)
Cloudflare R2 (external)
WhatsApp Baileys (in-app) + volume wa_sessions
Let's Encrypt (auto renew via cron)
```

---

## File penting

| File | Fungsi |
|------|--------|
| `install.sh` | Entry point install |
| `update.sh` | Safe update |
| `.env` | Secrets (auto-generated wizard) |
| `docker/generated/nginx.conf` | Nginx auto-generated |
| `scripts/deploy/` | Modular deploy scripts |

---

## Untuk developer

Lihat juga [README.md](README.md) untuk local development.

Legacy script `scripts/vps-deploy.sh` masih ada tapi **disarankan pakai `./install.sh`**.
