# Multi-Dictionary — Migration Hàn–Việt / Việt–Hàn

## Tổng quan

App từ điển đa ngữ đã được cập nhật để thêm 2 từ điển mới:
- **Hàn → Việt** (`kv.json.gz`) — dịch từ từ điển Hàn-Anh gốc (Dong-A Prime, 94,247 mục)
- **Việt → Hàn** (`vk.json.gz`) — dịch từ từ điển Anh-Hàn gốc (Dong-A Prime, 134,525 mục)

Các từ điển cũ (Anh↔Việt, Pháp↔Việt, Hàn↔Anh, Hán↔Việt) được giữ nguyên.

## Trạng thái dịch AI

Do giới hạn rate limit của API (~20 calls/phút), việc dịch toàn bộ 228K mục mất nhiều giờ.
File `kv_translations.jsonl` và `vk_translations.jsonl` lưu tiến độ dịch (append-only JSONL).
Có thể resume bất cứ lúc nào bằng `--resume`.

Kiểm tra tiến độ hiện tại:
```bash
cd /home/z/my-project
wc -l scripts/kv_translations.jsonl scripts/vk_translations.jsonl
# Hoặc đếm unique entries:
python3 -c "
import json
for f in ['scripts/kv_translations.jsonl', 'scripts/vk_translations.jsonl']:
    s = set()
    for line in open(f):
        try: s.add(json.loads(line)['i'])
        except: pass
    print(f'{f}: {len(s)} unique')
"
```

## Tiếp tục dịch

### Yêu cầu
- Node.js 18+ (hoặc Bun)
- z-ai-web-dev-sdk (đã cài tại `/home/z/.bun/install/global/node_modules/z-ai-web-dev-sdk`)
- File config `/home/z/.z-ai-config` (đã có sẵn trong môi trường này)

### Chạy dịch kv (Hàn → Việt)

```bash
cd /home/z/my-project

# Dịch toàn bộ (resume từ nơi dừng)
node scripts/translate_kv.mjs --resume --batch=10 --interval=3500

# Hoặc dịch N mục đầu tiên (test)
node scripts/translate_kv.mjs --limit=100 --batch=10 --interval=3500
```

### Chạy dịch vk (Việt → Hàn)

```bash
cd /home/z/my-project

# Dịch toàn bộ (resume từ nơi dừng)
node scripts/translate_vk.mjs --resume --batch=50 --interval=3000

# Hoặc dịch N mục đầu tiên (test)
node scripts/translate_vk.mjs --limit=500 --batch=50 --interval=3000
```

### Tham số

| Tham số | Mặc định | Mô tả |
|---------|----------|-------|
| `--limit=N` | 0 (all) | Giới hạn số mục cần dịch |
| `--batch=N` | 10 (kv) / 50 (vk) | Số mục mỗi API call |
| `--interval=N` | 3500 (kv) / 3000 (vk) | Khoảng cách tối thiểu giữa các call (ms) |
| `--resume` | false | Nạp tiến độ đã dịch từ JSONL, bỏ qua entry đã xong |

### Tốc độ ước tính

- Rate limit API: ~20 calls/phút
- kv: 10 entry/call × 17 call/phút ≈ 170 entry/phút → 94K mục ≈ 9.2 giờ
- vk: 50 entry/call × 20 call/phút ≈ 1000 entry/phút → 134K mục ≈ 2.2 giờ
- Tổng: ~11 giờ

Nếu bị 429 (Too Many Requests), script tự retry với backoff 30s × attempts.

## Rebuild file .gz

Sau khi dịch thêm, rebuild lại `kv.json.gz` và `vk.json.gz`:

```bash
cd /home/z/my-project
node scripts/rebuild_dict_files.mjs
```

Script này:
1. Đọc `ke.json.gz` (headword Hàn) + `kv_translations.jsonl` (body Việt) → `kv.json.gz`
2. Đọc `ek.json.gz` (body Hàn) + `vk_translations.jsonl` (headword Việt) → `vk.json.gz`
3. Entry chưa dịch sẽ giữ nguyên nội dung gốc (English cho kv, English headword cho vk)

## Test app local

```bash
cd /home/z/my-project/Multi-Dictionary
python3 -m http.server 8080
# Mở http://localhost:8080
```

## Push lên GitHub

```bash
cd /home/z/my-project/Multi-Dictionary

# Kiểm tra thay đổi
git status
git diff --stat

# Stage tất cả
git add .

# Commit
git commit -m "feat: thêm từ điển Hàn-Việt và Việt-Hàn (AI dịch)

- Thêm kv.json.gz (Hàn→Việt, 94K mục) 
- Thêm vk.json.gz (Việt→Hàn, 134K mục)
- Cập nhật index.html: thêm tab Hàn↔Việt, TTS, search
- Giữ nguyên ek/ke (Hàn↔Anh) để đối chiếu

Translations: scripts/kv_translations.jsonl, scripts/vk_translations.jsonl
Pipeline: scripts/translate_kv.mjs, scripts/translate_vk.mjs
Rebuild: scripts/rebuild_dict_files.mjs"

# Push (cần PAT hoặc SSH key đã config)
git push origin main
```

Nếu chưa có authentication:
```bash
# Cách 1: Dùng PAT
git remote set-url origin https://<USERNAME>:<PAT>@github.com/vntoan78/Multi-Dictionary.git
git push origin main

# Cách 2: SSH
git remote set-url origin git@github.com:vntoan78/Multi-Dictionary.git
git push origin main
```

## Cấu trúc file

```
Multi-Dictionary/
├── index.html              # App SPA (đã update cho kv/vk)
├── dict-data/
│   ├── av.json.gz          # Anh ↔ Việt (333K) — giữ nguyên
│   ├── pv.json.gz          # Pháp ↔ Việt (129K) — giữ nguyên
│   ├── ek.json.gz          # Anh → Hàn (134K) — giữ nguyên
│   ├── ke.json.gz          # Hàn → Anh (94K) — giữ nguyên
│   ├── kv.json.gz          # Hàn → Việt (94K) — MỚI (AI dịch)
│   ├── vk.json.gz          # Việt → Hàn (134K) — MỚI (AI dịch)
│   ├── hv.json.gz          # Hán → Việt (44K) — giữ nguyên
│   └── hv_gifs/            # 6,903 GIF nét bút — giữ nguyên
└── (README, .nojekyll)

/home/z/my-project/scripts/
├── translate_kv.mjs        # Pipeline dịch Hàn→Việt
├── translate_vk.mjs        # Pipeline dịch Việt→Hàn
├── rebuild_dict_files.mjs  # Build .gz từ JSONL + fallback
├── kv_translations.jsonl   # Tiến độ dịch kv (append-only)
└── vk_translations.jsonl   # Tiến độ dịch vk (append-only)
```

## Cách dịch hoạt động

### kv (Hàn → Việt)
- **Headword**: giữ nguyên tiếng Hàn (từ `ke.json.gz`)
- **Body**: dịch phần tiếng Anh sang tiếng Việt, giữ nguyên:
  - Markup DSL (`[b]`, `[c color]`, `[/td][/tr][/tbl]`, `\t3]`, etc.)
  - Tiếng Hàn (Hangul)
  - Hanja (chữ Hán)
  - IPA phiên âm
  - Ký hiệu (`✧ ❑ ✪ ♦ 〈〉《》【】`)

### vk (Việt → Hàn)
- **Headword**: dịch headword tiếng Anh sang tiếng Việt
- **Body**: giữ nguyên tiếng Hàn (từ `ek.json.gz`)

### Fallback
Entry chưa dịch:
- kv: body = tiếng Anh gốc (từ ke)
- vk: headword = tiếng Anh gốc (từ ek)
