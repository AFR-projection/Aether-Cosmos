# Per-Account Backup & Restore (`/backup`) — Design

Status: **spec, menunggu review**
Tanggal: 2026-09-03
Pendahulu: `docs/superpowers/specs/2026-09-01-backup-design.md` (backup sistem/instance — **tidak disentuh**)

---

## 1. Tujuan

Setiap akun — user biasa **dan** master — bisa mengunduh backup miliknya sendiri dan
mengembalikannya ke akunnya sendiri. Dua domain yang benar-benar terpisah:

| Domain | Nama file | Isi |
| --- | --- | --- |
| Files | `afr-files-YYYYMMDD.afrbak` | struktur folder, record file, **dan isi byte file** |
| Second Brain | `afr-brain-YYYYMMDD.afrbak` | seluruh baris tabel brain milik akun itu |

User memilih salah satu domain. **Tidak ada tombol "backup semua".** Domain terikat
secara kriptografis (header + AAD tiap chunk), sehingga arsip Files tidak bisa dipakai
sebagai Brain dan sebaliknya — ditolak sebelum byte pertama diproses, bukan lewat `if`.

Target akhirnya bukan "file bisa diunduh dan diunggah lagi", tapi **artefak
disaster-recovery**: VPS lama mati, DB hilang, akun dibuat ulang di instance baru, dan
`.afrbak` lama tetap bisa direstore.

### 1.1 Di luar lingkup

- `/admin/backup` (backup sistem penuh: R2-resident, terjadwal, retention) **tetap apa
  adanya**. Tidak ada baris yang dihapus atau diubah di sana.
- Share/permission ke akun lain tidak masuk arsip — itu data milik orang lain.
- Restore lintas akun oleh master. Bukan fitur ini.
- Tidak ada jadwal otomatis untuk scope akun: unduhan berakhir di perangkat user,
  dan sesuatu yang berakhir di browser tidak bisa dijadwalkan.
- Tidak ada resume unduhan/unggahan. Koneksi putus = file terpotong, dan itu terdeteksi
  saat inspect (trailer tidak ada), jadi tidak pernah menjadi restore separuh.

## 2. Kenapa ini subsistem baru, bukan flag yang dibalik

`src/features/backup/application/owner.ts` sudah punya `USER_SCOPE_ENABLED = false` dan
skema `0027_backup.sql` sudah memodelkan `owner_key = 'user:<uuid>'`. Menyalakannya saja
tidak cukup, karena dua alasan yang tidak bisa ditawar:

1. **`pg_dump` tidak bisa memotong baris per user.** Mesin ekspor yang ada (`pg_dump
   --format=custom` di `infrastructure/pg.ts`) bekerja per tabel. Scope akun butuh
   produsen yang berbeda: query per tabel dengan `WHERE user_id = $1`, di-stream.
2. **`pg_restore` tidak bisa menyisip ke satu akun.** Restore per akun butuh importer
   row-level dengan remapping kepemilikan, penanganan konflik, penegakan kuota, dan
   jaminan keras bahwa ia tidak bisa menulis baris milik user lain.

Selain itu, restore yang ada hari ini adalah CLI (`scripts/backup-restore.ts`, 1.857
baris) — sengaja, karena restore sistem dipakai justru saat aplikasinya rusak. Restore
per akun adalah kebalikannya: aplikasinya sehat, satu akun yang kehilangan isi. Itu
memang layak jadi tombol.

## 3. Identitas akun & disaster recovery

Ini bagian yang menentukan apakah fitur ini backup sungguhan atau cuma ekspor.

### 3.1 `accountBackupId`

Root identitas kriptografis backup adalah **`accountBackupId`**: 32 byte acak, dibuat
sekali per akun, ditampilkan ke user dalam bentuk base32 berkelompok (`AFR-7K2M-9QX4-…`)
supaya bisa dikenali manusia, dan **ditanam di dalam SUMMARY terenkripsi setiap arsip**.

Bukan `users.id`, karena DB rebuild memberi UUID baru dan arsip lama langsung jadi
sampah. Bukan email, karena email bisa berubah dan karena identitas kriptografis tidak
boleh bergantung pada string yang bisa diedit di halaman settings. **Email hanya
metadata** di dalam SUMMARY — dipakai untuk membantu manusia mengenali arsipnya di layar
preview ("backup ini dari akun `budi@…`"), tidak pernah sebagai gerbang.

### 3.2 Satu akun boleh mengikat lebih dari satu identitas

Tabel `account_backup_identities (user_id, account_backup_id, bound_at, source)` dengan
`source ∈ {'generated','adopted'}`. Tepat satu baris `generated` per akun — itu yang
dipakai untuk arsip baru. Baris `adopted` adalah identitas dari instance lain yang sudah
dibuktikan milik pemanggil, dan diterima saat restore.

Aturan pencocokan saat restore:

1. `accountBackupId` di arsip cocok dengan salah satu identitas terikat pemanggil →
   lolos, buka lewat keyslot 0, tanpa friksi apa pun.
2. Tidak cocok → **wajib** mengetikkan recovery phrase. Kalau keyslot 1 terbuka,
   `accountBackupId` arsip itu di-`adopt` ke akun pemanggil, dicatat di audit, dan
   restore lanjut.

Jalur (2) adalah jalur disaster recovery, dan ia bekerja tanpa DB lama, tanpa akun lama,
tanpa email yang sama, di instance mana pun yang punya `BACKUP_MASTER_KEY`-nya sendiri —
karena keyslot 1 tidak bergantung pada server sama sekali.

### 3.3 Adoption bukan bypass authorization

Pemanggil tetap `requireAuth()` dan scope **selalu** id pemanggil yang terautentikasi;
`ownerId` tidak pernah diterima dari klien. Adoption hanya mengizinkan arsip masuk ke
**akun pemanggil sendiri** — ia melonggarkan pemeriksaan *kepemilikan arsip*, bukan
otorisasi akun. Ini konsisten dengan invarian di `owner.ts`: *scope user selalu id
pemanggil, never a parameter.*

Server **tidak boleh** memakai salinan sisi-server apa pun untuk melewati langkah (2).
Frasa harus benar-benar diketik pemanggil. Kalau tidak, master yang punya akses DB +
env bisa meng-adopt arsip user lain ke akunnya sendiri.

Konsekuensi yang diterima dengan sadar: siapa pun yang memegang recovery phrase user A
bisa merestore arsip A ke akunnya. Itu tidak menambah paparan — memegang frasa itu
sudah cukup untuk mendekripsi arsipnya secara offline. Peristiwanya dicatat keras di
audit (`backup_restore_adopted`).

## 4. Hierarki kunci

```
BACKUP_MASTER_KEY (env, 32 byte acak, keyId)     recovery phrase (9 kata, di kepala user)
        |                                                 |
        |                                          Argon2id(phrase, phraseSalt)
        |                                                 |
        |                                        RWK (recovery wrapping key)
        |                                                 |
   keyslot[0] = wrap(DEK)                        keyslot[1] = wrap(DEK)
        \___________________________  ___________________________/
                                    \/
                        DEK (32 byte acak, per arsip)
                                    |
                    AES-256-GCM atas SUMMARY, INDEX, CHUNKS
```

### 4.1 `BACKUP_MASTER_KEY`

Env var **tersendiri**, bukan turunan `SESSION_SECRET`. Alasannya bukan estetika:
catatan project ini mencatat rotasi `SESSION_SECRET` sudah pernah merusak Gmail App
Password dan 2FA. `SESSION_SECRET` memang *ingin* dirotasi (invalidasi sesi); kunci
backup justru tidak boleh. Umur berbeda dan tujuan berbeda ⇒ secret berbeda.

Divalidasi saat boot bila fitur aktif: panjang tepat 32 byte setelah decode, dan menolak
nilai berentropi rendah (mis. seluruh byte sama). Tidak pernah masuk log, response, atau
pesan error.

### 4.2 Rotasi

`keyId` wajib ada di HEADER. `BACKUP_MASTER_KEY_PREVIOUS` menerima daftar kunci lama;
unwrap keyslot 0 mencoba `keyId` yang tercantum, tidak pernah mencoba semua secara buta.

Aturan penghapusan kunci lama, ditulis apa adanya: **server tidak bisa tahu arsip mana
yang masih ada**, karena arsipnya di perangkat user. Jadi kunci lama tidak punya titik
"aman dihapus" yang bisa dihitung. Yang bisa dijamin: setiap arsip selalu punya keyslot
1, jadi tidak ada arsip yang *bergantung tunggal* pada satu kunci. Menghapus kunci lama
berarti arsip dari era itu butuh recovery phrase-nya. Itu keputusan operator, dan
dokumen ini mewajibkan peringatan itu muncul di UI admin saat kunci dicabut.

### 4.3 Recovery phrase

Sembilan kata dari `domain/wordlist.ts` yang sudah ada, dengan Argon2id memakai parameter
dari `domain/kek.ts`. Frasa → Argon2id → **wrapping key** → membungkus DEK. Frasa
**tidak pernah** dipakai langsung sebagai kunci AES.

**Frasanya tidak disimpan di server.** Yang disimpan hanya `RWK` yang disegel di bawah
`BACKUP_MASTER_KEY` (kolom `wrapped_kek` di `backup_keys` yang sudah ada), plus
`phraseSalt`. Itu cukup untuk membungkus DEK saat ekspor tanpa server tahu frasanya, dan
memastikan jalur recovery benar-benar independen: kalau `BACKUP_MASTER_KEY` hilang, `RWK`
tersegel itu ikut hilang, tapi frasa yang diketik user menurunkan `RWK` yang sama dari
nol.

`phraseSalt` per **akun** (bukan per arsip) dan ikut ditanam di HEADER setiap arsip, agar
penurunan ulang bisa jalan tanpa DB. Satu frasa berlaku untuk semua arsip akun itu —
user tidak perlu menyimpan sembilan kata baru setiap kali mengunduh.

> **Perubahan dari pembahasan sebelumnya, perlu dicatat:** karena frasanya tidak
> disimpan, **frasa tidak bisa ditampilkan ulang.** Ia muncul sekali, saat pertama kali
> disiapkan, di balik konfirmasi "sudah saya simpan". Yang bisa dilakukan kemudian hanya
> *mengganti* frasa (menurunkan `RWK` baru; arsip lama tetap terbuka lewat keyslot 0 dan
> lewat frasa lamanya). Ini konsekuensi langsung dari syarat "recovery phrase menjadi
> jalur recovery independen" — sesuatu yang server simpan bukan jalur independen.

## 5. Format arsip `.afrbak`

Container biner sendiri. Bukan ZIP, bukan tar. Dibuka text editor → biner. Dibuka
7-Zip/WinRAR → *not a valid archive*. Importer AFR tahu strukturnya dan tetap tidak bisa
membaca apa pun tanpa kunci.

```
+-----------+------------------------------------------------------------------+
| PREAMBLE  | 32 byte, tata letak TETAP, plaintext                             |
|           |   0..7    MAGIC "AFRBAK1\0"                                      |
|           |   8..9    formatVersion  (u16 BE)                                |
|           |   10      domain         (1 = files, 2 = brain)                  |
|           |   11      flags          (dicadangkan, harus 0)                  |
|           |   12..15  headerLength   (u32 BE)                                |
|           |   16..19  summaryLength  (u32 BE, terenkripsi, <= 64 KiB)        |
|           |   20..27  indexLength    (u64 BE, terenkripsi, tanpa batas)      |
|           |   28..31  chunkSize      (u32 BE)                                |
+-----------+------------------------------------------------------------------+
| HEADER    | plaintext, canonical, panjang = headerLength                     |
|           |   backupId (uuid), createdAt (ms u64), keyId,                     |
|           |   keyslot[0] {alg, nonce, ct}   <- wrap(DEK) di bawah master key  |
|           |   keyslot[1] {alg, nonce, ct}   <- wrap(DEK) di bawah RWK         |
|           |   phraseSalt, argon2 {m, t, p}                                    |
|           |   summaryNonce, indexNonce                                        |
+-----------+------------------------------------------------------------------+
| HDR_HMAC  | 32 byte. HMAC-SHA256 atas PREAMBLE || HEADER, kunci = master key |
+-----------+------------------------------------------------------------------+
| SUMMARY   | AES-256-GCM(DEK, summaryNonce). Kecil, berbatas keras.           |
|           |   accountBackupId, sourceInstanceId, email (metadata),           |
|           |   counts {folders, files, memories, rows}, totalBytes,           |
|           |   dateRange {from, to}, appVersion, schemaVersion                |
+-----------+------------------------------------------------------------------+
| INDEX     | AES-256-GCM(DEK, indexNonce). NDJSON, boleh besar.               |
|           |   files : {path, size, sha256, mime, createdAt, updatedAt}       |
|           |   brain : {table, rowId, orderKey}                               |
+-----------+------------------------------------------------------------------+
| CHUNKS    | N x AES-256-GCM(DEK, nonce(chunkIndex))                          |
|           | AAD = canonical(backupId, domain, formatVersion, chunkIndex)      |
+-----------+------------------------------------------------------------------+
| TRAILER   | plaintext: chunkCount (u64), payloadSha256 (32 byte),            |
|           | totalPlaintextBytes (u64)                                        |
+-----------+------------------------------------------------------------------+
| TRL_HMAC  | 32 byte. HMAC-SHA256 atas HDR_HMAC || TRAILER, kunci = DEK       |
+-----------+------------------------------------------------------------------+
```

### 5.1 Batas integritas — apa tepatnya yang diautentikasi

- **`HDR_HMAC`** mengautentikasi `PREAMBLE || HEADER` **byte demi byte**, dengan
  `BACKUP_MASTER_KEY` (`keyId` diambil dari HEADER yang sedang diperiksa; kalau `keyId`
  tidak dikenal, arsip ditolak tanpa mencoba kunci lain). Ini mengunci `domain`,
  `formatVersion`, ketiga panjang, `chunkSize`, dan kedua keyslot. Konsekuensinya:
  penyerang tidak bisa menukar `domain` dari `brain` ke `files`, tidak bisa memperbesar
  `summaryLength`, dan tidak bisa menukar keyslot dari arsip lain.
- **`SUMMARY`, `INDEX`, tiap `CHUNK`** diautentikasi oleh tag GCM masing-masing di bawah
  DEK. Chunk tambahan mengikat AAD, jadi ia juga terikat posisi.
- **`TRAILER`** diautentikasi `TRL_HMAC` di bawah **DEK**, dan HMAC-nya mencakup
  `HDR_HMAC`, sehingga trailer dari arsip lain tidak bisa ditempel.
- `TRL_HMAC` memakai DEK, bukan master key, supaya verifikasi akhir tetap mungkin di
  jalur recovery (keyslot 1) di instance yang `BACKUP_MASTER_KEY`-nya berbeda.

### 5.2 Serialisasi kanonik

HEADER, SUMMARY, TRAILER, dan tiap AAD diserialisasi **deterministik**: kunci objek
terurut leksikografis, tanpa spasi, integer sebagai desimal tanpa `+`/nol depan, biner
sebagai base64 tanpa padding, `undefined`/`null` dihilangkan bukan ditulis. Satu writer
kanonik dipakai oleh exporter dan verifier, dan diuji round-trip; kalau serialisasi tidak
deterministik, HMAC-nya jadi lotere.

### 5.3 Nonce & anti-penukaran chunk

Nonce chunk = `prefix(8 byte acak per arsip) || u32BE(chunkIndex)`. Karena `chunkIndex`
ada di nonce **dan** di AAD, chunk tidak bisa ditukar, diulang, dihapus, atau dipindah
tanpa terdeteksi. `chunkCount` di TRAILER menutup pemotongan di ujung; `payloadSha256`
menutup kombinasi valid-per-chunk tapi salah secara keseluruhan.

### 5.4 SUMMARY kecil, INDEX bebas

`summaryLength` dibatasi **64 KiB** oleh format, dan `headerLength` dibatasi 16 KiB.
Preview karena itu hanya perlu membaca `32 + headerLength + 32 + summaryLength` byte
pertama, yang dijamin **≤ 81 KiB** — tidak bergantung pada jumlah file sama sekali.

Klien membaca 32 byte PREAMBLE lebih dulu (tata letaknya tetap, jadi bisa dibaca tanpa
tahu versi), lalu melakukan ranged-read kedua sebesar `headerLength + 32 + summaryLength`.
Dua permintaan kecil, tanpa asumsi.

INDEX tidak dibatasi ukuran, hanya dibatasi jumlah baris (§9). Ia dibaca importer secara
streaming, tidak pernah dimuat utuh ke memori.

### 5.5 Tanpa kompresi

Versi format ini **tidak** mengompres apa pun di dalam envelope. Tidak ada rasio yang
bisa dijadikan bomb, dan `totalPlaintextBytes` di TRAILER langsung sebanding dengan byte
yang benar-benar ditulis. Kalau kompresi ditambahkan nanti, ia naik `formatVersion` dan
wajib membawa batas rasio.

## 6. Alur export

Dua langkah. Langkah kedua adalah unduhan native browser.

### 6.1 `POST /api/backup/takeout/prepare`

Body `{ domain }`. Melakukan:

1. `requireAuth()`, tolak `isImpersonating`, `validateCsrf`, rate limit.
2. Kalau akun belum punya `accountBackupId` → buat, simpan.
3. Kalau akun belum punya `RWK` → hasilkan frasa 9 kata, turunkan `RWK`, segel di bawah
   `BACKUP_MASTER_KEY`, simpan. **Frasa dikembalikan di response ini, sekali, dan tidak
   pernah lagi.** UI menampilkannya di dialog dengan checkbox "sudah saya simpan".
4. Hitung ringkasan (jumlah + total byte) untuk ditampilkan di kartu.
5. Terbitkan **ticket**.

Ticket = `base64url(canonical(payload)) || "." || base64url(HMAC)`, dengan payload
`{ ticketId, domain, userId, sessionId, issuedAt, expiresAt }`.

- **Tidak ada key material di dalamnya.** Bukan "DEK terbungkus" — tidak ada DEK sama
  sekali. DEK dibuat di dalam handler GET saat stream dimulai, dan keyslot dirakit di
  situ juga.
- Expiry **90 detik** — hanya perlu menutup jarak antara klik dan navigasi.
- **Bukan single-use, dan tidak diklaim single-use.** Stateless berarti tidak ada yang
  bisa membakarnya.
- Yang membuat replay tidak berbahaya: handler GET tetap menjalankan `requireAuth()`
  penuh, lalu `ticket.userId` harus sama dengan user terautentikasi **dan**
  `ticket.sessionId` harus sama dengan sesi yang sedang dipakai. Jadi ticket bukan
  kredensial — ia pembawa parameter yang ditandatangani. Memutarnya ulang berarti
  mengunduh data sendiri, yang bisa dilakukan dengan klik ulang. Biaya satu-satunya
  adalah egress/CPU, dan itu ditutup rate limit.

### 6.2 `GET /api/backup/takeout/[ticket]`

`requireAuth()` → verifikasi tanda tangan → cek expiry → cek `userId` + `sessionId` →
buat DEK → rakit keyslot → stream.

Respons: `Content-Disposition: attachment; filename="afr-<domain>-<YYYYMMDD>.afrbak"`,
`Content-Type: application/octet-stream`, `Cache-Control: no-store`. Tanpa
`Content-Length` (panjang total tidak diketahui di awal karena INDEX dibangun sambil
jalan) ⇒ `Transfer-Encoding: chunked`.

Tidak butuh CSRF: read-only, dan ticket bukan bearer.

### 6.3 Profil memori

Tidak ada yang dikumpulkan lebih dulu. Konsumsi RAM datar pada orde `chunkSize` (1 MiB)
plus satu buffer objek R2 yang sedang transit.

- **brain** — query per tabel dengan cursor, urutan FK deterministik, tiap baris menjadi
  satu baris NDJSON, langsung didorong ke encryptor.
- **files** — struktur folder + record dulu, lalu per file `GetObject` dari R2 →
  disalurkan langsung ke encryptor → langsung ke socket. Satu file transit sekali.

**Nol tulisan ke R2.** Yang terpakai hanya egress baca (gratis di R2) dan Class B ops.

### 6.4 INDEX dibangun saat stream, bukan saat prepare

Ringkasan di langkah 6.1 hanya untuk layar; INDEX dan SUMMARY di dalam arsip dibangun
ulang saat streaming, dan **yang di dalam arsip itu yang otoritatif**. Kalau user
mengunggah file di antara dua langkah itu, angka di layar beda satu, dan arsipnya tetap
konsisten dengan dirinya sendiri. Ini juga alasan ticket tidak perlu menyimpan state:
tidak ada apa pun dari langkah 1 yang harus bertahan kecuali parameter.

## 7. Alur restore

Urutannya **selalu**: `validate → reserve → import/stage → verify → commit`.
**Tidak pernah** `delete → import`.

### 7.1 `POST /api/backup/restore/inspect` — preview tanpa unggah

Klien membaca PREAMBLE (32 byte) dengan `File.slice()`, lalu prefiks
`headerLength + 32 + summaryLength` (dijamin ≤ 81 KiB), dan mengirim **hanya itu**.

Server: MAGIC → PREAMBLE → `HDR_HMAC` → keyslot 0 → dekripsi SUMMARY. Mengembalikan
domain, `createdAt`, jumlah folder/file/memory, `totalBytes`, rentang tanggal, email
sumber (metadata), dan status kepemilikan.

Kalau keyslot 0 gagal (instance lain, `BACKUP_MASTER_KEY` berbeda, `keyId` tidak
dikenal) **atau** `accountBackupId` tidak cocok dengan identitas terikat pemanggil, UI
meminta recovery phrase **di titik ini** — sebelum satu byte pun diunggah.

Nol byte menginap di server. Nol staging di R2.

### 7.2 Angka yang ditampilkan, dan yang tidak diklaim

`INDEX` tidak dikirim di langkah preview, jadi split per-file tidak bisa dihitung dari
SUMMARY. Dua tingkat, dan UI tidak boleh mengaburkan bedanya:

- `indexLength ≤ 2 MiB` → klien melakukan ranged-read ketiga atas INDEX, dan layar
  menampilkan angka pasti: *"812 dipulihkan, 435 dilewati."*
- Lebih besar → layar menampilkan angka SUMMARY saja (*"1.247 file · 3,2 GB"*) dan
  menyatakan bahwa rincian dilewati/dipulihkan dilaporkan setelah import. **Tidak ada
  angka split yang ditampilkan sebagai fakta sebelum INDEX penuh tersedia.**

### 7.3 `POST /api/backup/restore` — import

`multipart/form-data` streaming: field `mode` (`merge` | `replace`), field opsional
`recoveryPhrase`, lalu field file. Handler tidak pernah memuat body ke memori.

**Tahap 1 — validate.** Aturan penolakan #1–#8 (§9) dijalankan atas
PREAMBLE/HEADER/SUMMARY sebelum tahap berikutnya; #9 adalah pemeriksaan kuota dan jatuh di
tahap 2, karena ia butuh lock. Keduanya tetap **sebelum tulisan pertama**, yang memang
klaimnya. `mode` divalidasi terhadap domain kartu yang dipakai. Mismatch domain berhenti
di sini.

**Tahap 2 — reserve.** Satu transaksi, dan **transaksi ini di-commit sendiri**: buat baris
`restore_batches` (`state = 'staging'`), `SELECT … FOR UPDATE` atas baris kuota pemanggil,
hitung `used + reserved + summary.totalBytes ≤ limit`, tulis baris `restore_reservations`,
commit. Gagal → `413`, tanpa satu byte pun ditulis.

Kedua baris itu **wajib** commit di sini, bukan ikut transaksi import. Dua alasan, dan
keduanya mengikat: reservasi hanya authoritative terhadap restore lain kalau ia terlihat
oleh sesi lain, dan `restore_reservations.restore_batch_id` menunjuk ke
`restore_batches(id)` — kalau baris induknya lahir di dalam transaksi import Brain, sebuah
`ROLLBACK` akan menyeret induk reservasinya sendiri.

**Tahap 3 — import/stage.** Memakai `restoreBatchId` dari tahap 2. Lalu, per batch:

- **Files** — dekripsi chunk → validasi path (§11) → `PutObject` ke **key R2 baru**
  (`r2Key` baru, tidak pernah menimpa objek yang ada) → insert baris `files`/`folders`
  dengan `restore_batch_id = <id>`. Baris folder dibangun dengan `materializedPath` yang
  **dihitung ulang di server**, bukan diambil dari arsip.
- **Brain** — insert NDJSON per batch mengikuti urutan FK, **di dalam satu transaksi**
  (lihat catatan di bawah). Tidak ada kolom staging: isolasi transaksi yang menyembunyikan
  barisnya.
- Counter byte berjalan dibandingkan terus ke reservasi. Lewat sedikit pun → **abort**.
  Ini yang menutup arsip yang mengaku 100 MB tapi payload-nya 50 GB: ia mati di tengah
  tanpa pernah menembus kuota, dan tahap 5 tidak pernah jalan.

**Bagaimana baris yang di-stage disembunyikan — dan kenapa dua domain memakai mekanisme
berbeda.**

*Brain* di-import **di dalam satu transaksi DB** — transaksi ketiga, terpisah dari
transaksi reservasi tahap 2. Baris yang belum di-commit tidak terlihat oleh sesi lain
menurut definisi MVCC, jadi tidak ada kolom staging, tidak ada trik visibilitas, dan tidak
ada baris data yang bisa menggantung: kegagalan = `ROLLBACK`, dan seluruh baris brain yang
sudah masuk hilang bersamanya. Mode `replace` menghapus baris lama di transaksi yang sama.
Ini bisa dilakukan karena brain seluruhnya baris DB — cap-nya 500.000 baris kecil, dan
satu transaksi sebesar itu adalah pekerjaan normal untuk PostgreSQL.

Yang tetap tertinggal setelah `ROLLBACK` hanya pembukuannya: baris `restore_batches` +
`restore_reservations` dari tahap 2, yang memang sengaja hidup di luar transaksi import.
Keduanya disapu (§7.6).

*Files* tidak bisa begitu, karena penulisan objek R2 tidak transaksional dan tidak bisa
di-`ROLLBACK`. Karena itu Files memakai staging eksplisit: baris di-insert dengan
`deleted_at = NOW()` **dan** `restore_batch_id = <id>`. Konsekuensinya penting — setiap
query baca yang sudah ada memfilter `deleted_at IS NULL`, jadi baris yang di-stage
**otomatis tidak terlihat tanpa satu pun jalur baca diubah**. Tidak ada kolom `visible`
baru, tidak ada join baru di jalur panas.

Satu tempat yang perlu disesuaikan: query Recycle Bin, yang justru mencari
`deleted_at IS NOT NULL`. Ia mendapat tambahan `AND restore_batch_id IS NULL`, supaya
batch yang sedang di-stage tidak muncul di tong sampah user sebagai sampah palsu. Itu
satu-satunya perubahan pada jalur baca yang ada.

**Tahap 4 — verify.** `chunkCount`, `payloadSha256`, `TRL_HMAC`, jumlah baris yang
tertulis, dan total byte dibandingkan dengan INDEX + TRAILER. Satu pun tidak cocok →
batch ditinggalkan (Files) atau `ROLLBACK` (Brain), tidak pernah di-commit.

**Tahap 5 — commit.**

*Brain* — `COMMIT` transaksi yang sudah berjalan sejak tahap 3. Selesai.

*Files* — satu transaksi baru:

- `merge` → `UPDATE … SET deleted_at = NULL, restore_batch_id = NULL WHERE
  restore_batch_id = <id>`. Tidak ada yang dihapus, titik.
- `replace` → **soft-delete** baris lama domain itu milik pemanggil
  (`deleted_at = NOW()` pada baris dengan `restore_batch_id IS NULL`), **lalu** aktifkan
  batch baru dengan pernyataan yang sama seperti `merge`. Dua pernyataan, satu
  transaksi, atomik. Urutannya penting: predikat `restore_batch_id IS NULL` pada
  pernyataan pertama itulah yang mencegah ia ikut menghapus baris yang baru masuk.

Lalu `restore_batches.state = 'committed'`, `recalculateUsedBytes(ownerId)`, hapus baris
reservasi, `cacheDelPattern`, audit.

### 7.4 Kenapa `replace` tidak merusak apa pun saat gagal

Gagal di 1%, 50%, atau 99% → tahap 5 tidak pernah dijalankan, jadi **tidak ada yang
dihapus dan tidak ada yang ditukar**. Data lama utuh dan tetap visible sepanjang waktu.

Sisa yang tertinggal berbeda per domain, dan bedanya bukan detail. *Brain* tidak
meninggalkan satu baris data pun — `ROLLBACK` menghapus jejaknya sendiri. *Files*
meninggalkan baris tak-visible + objek R2 baru. Keduanya sama-sama meninggalkan pembukuan
tahap 2 (`restore_batches` + `restore_reservations`), dan seluruh sisa itu membawa
`restoreBatchId` sehingga sweeper bisa membersihkannya.

Dan karena penghapusan di tahap 5 adalah **soft delete**, "Ganti total" mendarat di
Recycle Bin, bukan di kehampaan. Selama retention window, user bisa mengurungkannya.
Mesin ini sudah ada: `deleted_at`, `/recycle-bin`, `recalculateUsedBytes`, deletion
worker. Tidak ada yang perlu dibangun ulang.

### 7.5 Aturan merge

Kecocokan ditentukan oleh `sha256` isi **dan** path — bukan nama saja. Sudah ada →
dilewati (byte-nya tidak ditulis ke R2, menghemat Class A ops). Belum ada → dipulihkan.
Path sama tapi `sha256` berbeda → masuk sebagai `nama (restored)`, dua-duanya bertahan,
user yang memutuskan.

Karena itu `merge` **idempoten**: diklik sepuluh kali berturut-turut hasilnya sama.

### 7.6 Sweeper

`src/features/backup/application/sweep.ts` yang sudah ada diperluas: batch dengan
`state = 'staging'` yang lebih tua dari 24 jam → `state = 'aborted'`, lepaskan
reservasinya, dan — untuk domain `files` — hapus baris yang di-stage beserta objek R2 yang
dirujuknya. Untuk domain `brain` tidak ada baris data yang perlu dihapus; yang disapu
hanya pembukuannya. Idempoten, dan aman dijalankan bersamaan dengan import yang sedang
berjalan karena batasnya berbasis umur.

## 8. Kuota

- **Inspect** hanya untuk umpan balik UI. Tidak otoritatif, dan tidak boleh dipakai
  sebagai gerbang.
- **Saat import benar-benar mulai**, reservasi diambil dengan locking (§7.3 tahap 2).
  Dua restore bersamaan tidak bisa dua-duanya lolos: yang kedua menunggu lock, lalu
  melihat `reserved` yang pertama.
- **Counter aktual** dibandingkan terus ke reservasi selama import; melebihi → abort.
- **Reservasi yang ditinggalkan** dibersihkan sweeper (§7.6), jadi crash tidak
  mengunci kuota selamanya.

## 9. Aturan penolakan

Semuanya dijalankan **sebelum** tulisan pertama. Nomor alasan masuk audit.

| # | Kondisi | Pesan ke user |
| --- | --- | --- |
| 1 | MAGIC bukan `AFRBAK1\0`, atau `flags != 0` | Bukan file backup AFR. |
| 2 | `formatVersion` lebih besar dari yang didukung | Backup dari versi yang lebih baru. |
| 3 | `HDR_HMAC` tidak cocok, atau `keyId` tidak dikenal | *generik (§12)* |
| 4 | keyslot 0 dan keyslot 1 dua-duanya gagal dibuka | *generik (§12)* |
| 5 | `domain` di header ≠ domain kartu yang dipakai | Ini backup **Files**, bukan **Brain**. |
| 6 | `accountBackupId` tidak cocok **dan** frasa tidak diberikan/salah | *generik (§12)* |
| 7 | `summaryLength` > 64 KiB, `headerLength` > 16 KiB, atau panjang tidak konsisten | Berkas rusak. |
| 8 | `counts.rows` melebihi cap domain (§11) | Backup terlalu besar untuk diproses. |
| 9 | `used + reserved + totalBytes` > limit kuota | Ruang tidak cukup. |

Setelah tulisan dimulai, kegagalan berikut membatalkan batch (tanpa merusak data lama):
chunk hilang/keluar urutan, tag GCM gagal, `payloadSha256` beda, `chunkCount` beda,
`TRL_HMAC` beda, arsip terpotong, path tidak lolos validator, counter melebihi reservasi.

## 10. Otorisasi

| Endpoint | Metode | Auth | CSRF | Gate tambahan |
| --- | --- | --- | --- | --- |
| `/api/backup/takeout/prepare` | POST | `requireAuth` | wajib | rate limit 1/10 mnt/domain |
| `/api/backup/takeout/[ticket]` | GET | `requireAuth` + ticket match | tidak (read-only) | — |
| `/api/backup/restore/inspect` | POST | `requireAuth` | wajib | rate limit |
| `/api/backup/restore` | POST | `requireAuth` | wajib | step-code untuk `replace` |
| `/api/backup/identity` | GET | `requireAuth` | tidak | — |

- `isImpersonating` **ditolak** di semua endpoint — guard-nya sudah ada di
  `app/api/backup/_guard.ts`.
- `validateCsrf` di semua POST. `tests/csrf-coverage.test.ts` sudah mengunci ini: route
  baru yang lupa akan membuat suite merah tanpa siapa pun perlu ingat.
- **`ownerId` tidak pernah diterima dari klien.** Scope selalu pemanggil yang
  terautentikasi, sesuai invarian `owner.ts`.
- `ownerFingerprint`/`accountBackupId` adalah pemeriksaan **anti-salah-akun**, bukan
  pengganti otorisasi. Backup user A tidak bisa masuk ke akun user B hanya karena server
  memegang `BACKUP_MASTER_KEY` — pencocokan identitas gagal, dan satu-satunya jalan lain
  adalah frasa yang harus **diketik** (§3.3).
- Recovery phrase **bukan** bypass otorisasi akun: ia hanya melonggarkan pemeriksaan
  kepemilikan arsip, ke dalam akun pemanggil sendiri.

## 11. Arsip adalah hostile input, 100%

Setiap angka di dalam arsip dianggap bohong sampai dibuktikan.

- **Path** melewati validator kanonik yang sama dengan jalur normal
  (`entityNameSchema` + `checkEntityName` di `src/shared/lib/security/entity-name.ts`).
  Ditolak: path absolut, `..`, segmen kosong, segmen `.`, dan **segmen yang mengandung
  `/`**. Yang terakhir bukan paranoia: `materializedPath` dibangun dengan menggabungkan
  path induk dan nama anak, jadi nama bersegmen-slash membuat `a/b` di root dan `b` di
  dalam `a` menghasilkan string yang sama — dan setiap operasi subtree di aplikasi ini
  memilih baris berdasarkan prefiks path. Ini kelas bug yang baru ditutup di
  `tests/materialized-path-prefix.test.ts`; arsip jahat tidak boleh jadi jalan masuk
  kedua.
- **`materializedPath` dan `depth` dihitung ulang di server**, tidak pernah diambil dari
  arsip.
- **Ukuran** tidak dipercaya: counter berjalan vs reservasi (§8).
- **Jumlah baris** dibatasi cap keras per domain — `files`: 200.000 baris file + 50.000
  folder; `brain`: 500.000 baris total. Melebihi → penolakan #8, sebelum import.
- **MIME & nama** tidak pernah menentukan `Content-Type`. Nilai dari arsip dilewatkan
  validator MIME yang sudah dipakai jalur upload; yang tidak lolos jatuh ke
  `application/octet-stream`.
- **Tidak ada kompresi** di versi format ini (§5.5).
- `r2Key` dari arsip **diabaikan**; key baru selalu dihasilkan server.
- `userId`, `id`, dan timestamp `createdAt` dari baris brain diremap: `userId` → pemanggil,
  id → uuid baru dengan tabel pemetaan agar FK internal arsip tetap konsisten.

## 12. Error handling

Kegagalan dekripsi dan integritas **tidak boleh** menjadi oracle kriptografis. Satu pesan
untuk semuanya:

> **Backup tidak dapat dibuka. Passphrase salah atau file rusak.**

Dipakai untuk penolakan #3, #4, #6, kegagalan tag GCM, `TRL_HMAC` yang tidak cocok, dan
arsip terpotong — tanpa membedakan mana yang terjadi. Detail teknis (alasan mana dari
sembilan, offset, `keyId`) hanya masuk audit dan log internal.

Penolakan yang **bukan** kriptografis boleh spesifik, karena tidak membocorkan apa pun
dan sangat membantu: domain keliru (#5), kuota tidak cukup (#9), versi format lebih baru
(#2), bukan file AFR (#1).

Jangan pernah masuk log, response, atau pesan error, dalam bentuk apa pun:
`BACKUP_MASTER_KEY`, `BACKUP_MASTER_KEY_PREVIOUS`, DEK, RWK, recovery phrase, isi file,
plaintext arsip, dan **path lengkap**. Untuk path: catat jumlahnya, atau hash-nya —
jangan isinya, karena nama folder seseorang bisa lebih sensitif daripada isinya.

## 13. Audit trail

Enam event baru (migration 0028 menambah label ke `activity_action`, di atas enam yang
sudah ditambahkan 0027), plus satu untuk adoption:

`backup_takeout` · `backup_restore_preview` · `backup_restore_merge` ·
`backup_restore_replace` · `backup_recovery_view` · `backup_restore_refused` ·
`backup_restore_adopted`

Setiap entri menyimpan: `backupId`, `domain`, `mode`, `rowCount`, `totalBytes`, IP,
`result`, `reason` (untuk penolakan: nomor 1–9), `restoreBatchId` bila ada,
`formatVersion`, `keyId`. `backup_restore_replace` juga menyimpan jumlah baris yang
di-soft-delete, sehingga ada jejak untuk mundur.

Tidak pernah menyimpan: recovery phrase, DEK, RWK, plaintext, atau path lengkap.

`backup_recovery_view` dicatat saat frasa ditampilkan (sekali, saat pembuatan) dan saat
frasa diganti — bukan saat "dilihat ulang", karena §4.3 menghapus kemampuan itu.

## 14. UI

Satu halaman baru `app/backup/page.tsx`, identik untuk semua role. Satu entri sidebar di
`src/shell/layouts/sidebar.tsx` setelah `/recycle-bin`, tampil untuk semua role — master
masuk lewat pintu yang sama, jadi tidak perlu menumpang `/settings` (master tidak punya
halaman itu) dan tidak perlu lewat `/admin`.

Dua kartu, `Files` dan `Second Brain`, masing-masing dengan:

- ringkasan isi akun saat ini (jumlah + ukuran),
- **Download backup** → dialog frasa (hanya sekali, saat pertama) → unduhan browser,
- **Restore dari file** → pilih file → preview → pilih mode → konfirmasi.

Layar restore menampilkan isi arsip lebih dulu, lalu dua mode berdampingan dengan angka
nyata (§7.2). Mode `replace` butuh dua gerbang: konfirmasi biasa, lalu step-code. Sisi
server memakai `checkStepCode()` dari `src/shared/lib/security/step-code-gate.ts` yang
sudah ada — itu memang dirancang untuk dipakai banyak pemanggil.

Sisi klien tidak begitu: dialog step-code yang ada hidup sebagai
`app/admin/backup/_step-code-dialog.tsx`, komponen privat satu route. **Keputusan: dialog
baru dibuat terpisah untuk halaman ini, dan `/admin/backup` sama sekali tidak disentuh.**
Mengangkat berkas itu ke lokasi bersama akan lebih rapi, tapi itu berarti mengubah
`/admin/backup`, dan larangan itu lebih bernilai daripada menghindari satu dialog kembar.
Biayanya jujur: ada dua dialog step-code di pohon ini, dan yang kedua memakai
`checkStepCode()` yang sama sehingga logika keamanannya tetap satu sumber.

Aturan visual mengikuti kontrak yang sudah berlaku di project ini: token dari
`globals.css`, teks memakai varian `-ink`, glif di atas fill memakai `--on-*`, dan
`npm run lint:contrast` harus lulus AA di dua tema. Semua string lewat i18n — kunci baru
ditambahkan secara aditif ke `en.ts`, `id.ts`, `zh-CN.ts`, dan `npm run check:i18n` harus
tetap hijau.

## 15. Skema (migration 0028)

```sql
-- identitas backup yang tahan DB rebuild
CREATE TABLE account_backup_identities (
  user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_backup_id text NOT NULL,
  source            text NOT NULL CHECK (source IN ('generated','adopted')),
  bound_at          timestamptz NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, account_backup_id)
);
CREATE UNIQUE INDEX account_backup_identities_one_generated
  ON account_backup_identities (user_id) WHERE source = 'generated';

-- batch restore yang di-stage lalu ditukar
CREATE TABLE restore_batches (
  id              uuid PRIMARY KEY,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  domain          text NOT NULL CHECK (domain IN ('brain','files')),
  mode            text NOT NULL CHECK (mode IN ('merge','replace')),
  state           text NOT NULL CHECK (state IN ('staging','committed','aborted')),
  backup_id       uuid NOT NULL,
  format_version  integer NOT NULL,
  key_id          text,
  expected_rows   bigint NOT NULL,
  expected_bytes  bigint NOT NULL,
  written_rows    bigint NOT NULL DEFAULT 0,
  written_bytes   bigint NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT NOW(),
  updated_at      timestamptz NOT NULL DEFAULT NOW()
);

-- reservasi kuota
CREATE TABLE restore_reservations (
  restore_batch_id uuid PRIMARY KEY REFERENCES restore_batches(id) ON DELETE CASCADE,
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bytes            bigint NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT NOW()
);

-- staging Files saja; Brain memakai isolasi transaksi (§7.3), jadi tidak butuh kolom
ALTER TABLE files   ADD COLUMN restore_batch_id uuid REFERENCES restore_batches(id) ON DELETE SET NULL;
ALTER TABLE folders ADD COLUMN restore_batch_id uuid REFERENCES restore_batches(id) ON DELETE SET NULL;
CREATE INDEX files_restore_batch   ON files (restore_batch_id)   WHERE restore_batch_id IS NOT NULL;
CREATE INDEX folders_restore_batch ON folders (restore_batch_id) WHERE restore_batch_id IS NOT NULL;

-- 7 label audit baru, pola sama dengan 0027
ALTER TYPE "activity_action" ADD VALUE IF NOT EXISTS 'backup_takeout';
ALTER TYPE "activity_action" ADD VALUE IF NOT EXISTS 'backup_restore_preview';
ALTER TYPE "activity_action" ADD VALUE IF NOT EXISTS 'backup_restore_merge';
ALTER TYPE "activity_action" ADD VALUE IF NOT EXISTS 'backup_restore_replace';
ALTER TYPE "activity_action" ADD VALUE IF NOT EXISTS 'backup_recovery_view';
ALTER TYPE "activity_action" ADD VALUE IF NOT EXISTS 'backup_restore_refused';
ALTER TYPE "activity_action" ADD VALUE IF NOT EXISTS 'backup_restore_adopted';
```

`activity_action` adalah enum PostgreSQL sungguhan (`schema.ts:135`), dan 0027 sudah
memakai pola `ALTER TYPE … ADD VALUE IF NOT EXISTS`. Tiap pernyataan wajib dipisah
`--> statement-breakpoint`: nilai enum yang baru ditambahkan tidak boleh dipakai di
transaksi yang sama dengan yang menambahkannya.

Tabel brain mana yang boleh direstore **tidak** didaftar ulang di sini. Sumber tunggalnya
sudah ada: `src/features/backup/domain/table-classification.ts`, yang sudah memisahkan
core / files / brain / derived-excluded / never-restored. Importer memakai daftar itu, dan
sebuah test struktural memastikan tabel brain baru yang muncul di skema harus
diklasifikasikan di sana sebelum suite hijau — supaya tabel baru tidak diam-diam hilang
dari backup.

`backup_keys` yang sudah ada dipakai ulang untuk `RWK` tersegel + `phraseSalt`
(`wrapped_kek`, `kdf_salt`, `key_epoch`) — tidak ada tabel baru untuk itu.

**Catatan:** `0027_backup.sql` **belum diterapkan**. 0028 bertumpu di atasnya. Kedua
migration tetap di tangan pemilik project; dokumen ini tidak menjalankan apa pun.

## 16. Rencana testing

Tiga tingkat, karena tidak semua hal di daftar ini bisa dibuktikan tanpa database.

- **Unit (murni, `environment: "node"`)** — format, kripto, kanonikalisasi, validator.
  Tidak menyentuh DB atau R2. Ini mayoritas, dan ini yang jalan di CI seperti 152 file
  test yang sudah ada.
- **Integration** — importer/exporter terhadap PostgreSQL nyata + R2 palsu (in-memory
  object store). Butuh harness baru: `tests/helpers/backup-harness.ts` yang menyiapkan
  skema, dua akun, dan store objek yang bisa disuntik kegagalan.
- **Disaster recovery** — skenario yang membuang instance: DB dijatuhkan dan dibangun
  ulang dari migration, akun dibuat ulang, `BACKUP_MASTER_KEY` diganti.

| # | Skenario (dari daftar wajib) | Berkas | Tingkat |
| --- | --- | --- | --- |
| 1 | export → import Files, round-trip byte-identik | `backup-account-roundtrip.test.ts` | integration |
| 2 | export → import Brain, round-trip | `backup-account-roundtrip.test.ts` | integration |
| 3 | arsip Files dipakai di kartu Brain → tolak #5 | `backup-account-domain-binding.test.ts` | unit |
| 4 | arsip Brain dipakai di kartu Files → tolak #5 | `backup-account-domain-binding.test.ts` | unit |
| 5 | arsip user A diunggah user B → tolak #6 | `backup-account-ownership.test.ts` | integration |
| 6 | pindah VPS: `.env` ikut, DB ikut → restore lolos keyslot 0 | `backup-account-disaster.test.ts` | DR |
| 7 | DB dijatuhkan, dibangun ulang, akun dibuat ulang → restore lolos lewat frasa + adopt | `backup-account-disaster.test.ts` | DR |
| 8 | email berubah → restore tetap lolos (email bukan identitas) | `backup-account-ownership.test.ts` | integration |
| 9 | frasa benar → buka; frasa salah → pesan generik | `backup-account-keyslots.test.ts` | unit |
| 10 | `BACKUP_MASTER_KEY` diganti total → keyslot 0 mati, frasa menyelamatkan | `backup-account-disaster.test.ts` | DR |
| 11 | rotasi: arsip `keyId` lama dibuka lewat `..._PREVIOUS` | `backup-account-keyslots.test.ts` | unit |
| 12 | tiap byte HEADER dibalik satu-satu → semua tertolak | `backup-account-tamper.test.ts` | unit |
| 13 | SUMMARY dan INDEX dirusak → tag GCM gagal | `backup-account-tamper.test.ts` | unit |
| 14 | chunk dirusak → tag GCM gagal, batch dibatalkan | `backup-account-tamper.test.ts` | unit |
| 15 | arsip dipotong di 10/50/90% → tertolak, bukan restore separuh | `backup-account-tamper.test.ts` | unit |
| 16 | chunk hilang, diulang, ditukar posisi, dipindah antar-arsip | `backup-account-tamper.test.ts` | unit |
| 17 | TRAILER diedit, atau ditempel dari arsip lain | `backup-account-tamper.test.ts` | unit |
| 18 | path `../`, absolut, `a/b` sebagai satu nama, segmen kosong | `backup-account-hostile-path.test.ts` | unit |
| 19 | `counts.rows` di atas cap → tolak #8 sebelum import | `backup-account-caps.test.ts` | unit |
| 20 | SUMMARY mengaku 1 MB, payload 5 GB → abort saat counter lewat | `backup-account-quota.test.ts` | integration |
| 21 | dua restore bersamaan berlomba kuota → satu lolos, satu `413` | `backup-account-quota.test.ts` | integration |
| 22 | reservasi + batch ditinggalkan → sweeper melepas keduanya | `backup-account-sweep.test.ts` | integration |
| 23 | import dimatikan di 1%, 50%, 99% | `backup-account-failure.test.ts` | integration |
| 24 | `replace` gagal di tiap titik → data lama utuh & tetap visible | `backup-account-failure.test.ts` | integration |
| 25 | restore arsip yang sama dua/tiga kali → `merge` idempoten | `backup-account-idempotent.test.ts` | integration |
| 26 | ticket kedaluwarsa (91 detik) → tolak | `backup-account-ticket.test.ts` | unit |
| 27 | ticket diputar ulang → hanya mengunduh data sendiri, tidak pernah data orang lain | `backup-account-ticket.test.ts` | unit |
| 28 | ticket user lain / sesi lain → tolak | `backup-account-ticket.test.ts` | unit |
| 29 | `isImpersonating` di kelima endpoint (§10) → tolak | `backup-account-guard.test.ts` | unit |
| 30 | CSRF: route baru masuk cakupan yang sudah ada | `csrf-coverage.test.ts` (ada) | struktural |
| 31 | ketujuh event audit muncul dengan field lengkap, dan tidak ada rahasia di dalamnya | `backup-account-audit.test.ts` | integration |

Empat tambahan di luar daftar wajib, lahir dari mekanisme staging per-domain di §7.3. Ini
bukan pelebaran lingkup — tanpa keempatnya, klaim "gagal di tengah tidak merusak apa pun"
tidak terbukti untuk Brain sama sekali:

| # | Skenario | Berkas | Tingkat |
| --- | --- | --- | --- |
| 32 | import Brain dimatikan di tengah → `ROLLBACK`, nol baris brain baru tertinggal | `backup-account-failure.test.ts` | integration |
| 33 | `replace` Brain gagal setelah `DELETE` di transaksi yang sama → baris lama kembali utuh | `backup-account-failure.test.ts` | integration |
| 34 | baris Files yang di-stage tidak muncul di listing, search, ZIP, **maupun** Recycle Bin | `backup-account-staging-visibility.test.ts` | integration |
| 35 | Brain gagal → pembukuan tahap 2 tertinggal → sweeper melepas reservasinya | `backup-account-sweep.test.ts` | integration |

Nomor 34 adalah yang paling mudah dilewatkan dan paling mahal kalau salah: ia menguji
klaim inti bahwa staging Files gratis di jalur baca. Kalau satu query lupa memfilter
`deleted_at IS NULL`, restore yang sedang berjalan akan bocor ke UI sebagai file separuh
jadi.

### 16.1 Test struktural tambahan

Mengikuti pola `tests/materialized-path-prefix.test.ts` dan `tests/csrf-coverage.test.ts`
— menjaga jaminan di seluruh pohon sumber, bukan di satu jalur kode:

- **Tidak ada rahasia yang bisa masuk log.** Pindai sumber: tidak ada `console.*` /
  logger yang menerima variabel bernama `dek`, `rwk`, `phrase`, `masterKey`, atau
  `plaintext`. Daftar nama yang dilarang ditulis eksplisit.
- **`ownerId` tidak pernah dari klien.** Tidak ada route backup yang membaca `ownerId`
  atau `userId` dari body/query.
- **Setiap endpoint restore memanggil validator path.** Importer tidak boleh punya jalur
  yang menulis `materializedPath` tanpa melewati `checkEntityName`.
- **Penghapusan baris lama tidak pernah mendahului import.** Di seluruh importer, satu-satunya
  pernyataan yang menyentuh baris ber-`restore_batch_id IS NULL` (atau baris brain yang sudah
  ada) harus berada di dalam fungsi commit tahap 5. Test ini tidak bisa sekadar mencari
  `deleted_at = NOW()` — staging Files justru menulis `deleted_at = NOW()` pada baris
  **baru**, dan itu sah. Yang dicari adalah `DELETE FROM` / `SET deleted_at` di berkas
  importer di luar modul commit; modul commit-nya sendiri (`commit-files.ts`,
  `commit-brain.ts`) dikecualikan secara eksplisit dan namanya ditulis di test, supaya
  pengecualiannya harus disengaja dan terlihat di diff.
- **Klasifikasi tabel tetap lengkap.** `tests/backup-table-classification.test.ts` yang sudah
  ada menjamin setiap `pgTable` di `schema.ts` masuk tepat satu kelas. Tiga tabel 0028
  (`account_backup_identities`, `restore_batches`, `restore_reservations`) masuk kelas
  `never`: baris restore milik instance, bukan milik akun, dan mengembalikan salah satunya
  akan menjadi pembukuan yang menunjuk ke batch yang tidak ada.

### 16.2 Gerbang selesai

Belum boleh dianggap selesai sebelum semuanya hijau: `npm run lint` (0 error),
`npx next typegen`, `npx tsc --noEmit`, `npm run check:i18n`, `npm run lint:contrast`,
`npm test`, `npm run build`.

## 17. Batas jujur

- `BACKUP_MASTER_KEY` bocor **dan** arsipnya dicuri = arsip terbuka. Keyslot 1 tidak
  menolong di skenario itu; ia melindungi dari *kehilangan* kunci, bukan kebocoran.
- Tidak ada resume. Koneksi putus di 80% menghasilkan file terpotong, dan itu terdeteksi
  saat inspect — jadi ia tidak pernah menjadi restore separuh, hanya unduhan yang gagal.
- Recovery phrase yang hilang **dan** `BACKUP_MASTER_KEY` yang hilang = arsip mati.
  Tidak ada pintu ketiga, dan tidak boleh ada.
- Arsip tidak membawa share/permission, thumbnail yang bisa dihasilkan ulang, atau
  turunan yang bisa dihitung ulang (embedding, FTS index). Semua itu dibangun ulang
  setelah restore oleh jalur yang sudah ada.

## 18. Keputusan yang dikunci

| Keputusan | Nilai |
| --- | --- |
| Staging di R2 saat export | **tidak ada** — stream langsung ke browser |
| Format | `.afrbak` biner sendiri, tanpa kompresi |
| Domain | dua arsip terpisah, terikat di header + AAD |
| Root identitas | `accountBackupId` (acak, di SUMMARY terenkripsi) |
| Email | metadata saja, bukan gerbang |
| Slot kunci | 0 = `BACKUP_MASTER_KEY`, 1 = Argon2id(frasa) → RWK |
| Frasa disimpan server | **tidak** — hanya RWK tersegel; frasa tidak bisa ditampilkan ulang |
| Ticket | stateless, 90 detik, tanpa key material, bukan single-use |
| Batas SUMMARY | 64 KiB keras; preview membaca ≤ 81 KiB |
| Urutan restore | validate → reserve → import/stage → verify → commit |
| Pembukuan reservasi | `restore_batches` + `restore_reservations` di-commit di tahap 2, di luar transaksi import |
| Staging Brain | isolasi transaksi (MVCC) — tanpa kolom staging |
| Staging Files | `deleted_at = NOW()` + `restore_batch_id`, memakai filter baca yang sudah ada |
| `replace` | isi-lalu-tukar; penghapusan lama = soft delete ke Recycle Bin |
| Kuota | reservasi berkunci saat import mulai + counter berjalan |
| `/admin/backup` | tidak disentuh |

## 19. Urutan kerja

1. ~~Finalisasi spec~~ → dokumen ini.
2. **Review pemilik project.** ← sedang di sini
3. Migration `0028` (setelah spec disetujui; dijalankan pemilik project).
4. Implementasi bertahap: format & kripto (unit-testable, tanpa DB) → exporter →
   importer `merge` → importer `replace` + staging → UI → sweeper.
5. Jalankan unit + integration + security + DR test.
6. Gerbang §16.2.

Tidak ada kode sebelum langkah 2 selesai. Perubahan arsitektur apa pun setelah ini
diangkat lebih dulu, tidak diselipkan.
