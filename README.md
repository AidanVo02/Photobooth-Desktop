# Saigon Tếu Photobooth Desktop

Ứng dụng Photobooth toàn màn hình dành cho kiosk Saigon Tếu. Dự án hỗ trợ webcam hoặc Canon EOS, ghép ảnh theo layout, áp dụng bộ lọc/khung, in ảnh và tạo QR dẫn tới album riêng trên Cloudflare Pages.

## Luồng sử dụng

1. **Chọn layout**: ảnh đơn, nhanh 2 ảnh, dải 3 ảnh, lưới 4 ô hoặc Tếu Họa Ca.
2. **Chụp ảnh**: Live Camera View, đếm ngược 5 giây, hướng dẫn vùng ảnh sẽ được giữ lại, xác nhận hoặc chụp lại từng vị trí.
3. **Chỉnh ảnh**: chọn bộ lọc và khung ảnh. Sticker chưa được triển khai.
4. **Nhận ảnh**: chọn in ảnh kèm QR hoặc chỉ nhận QR.

Khách quét QR phải hoàn thành khảo sát trước khi API trả URL ảnh và cho phép xem/tải album.

## Kiến trúc

```text
Electron Desktop
  ├─ Webcam / Canon EOS
  ├─ Ghép và xuất ảnh 1200 × 1800 px
  ├─ In qua máy in mặc định của Windows
  ├─ Upload ảnh lên ImgBB
  └─ Tạo photo session qua Cloudflare API

Cloudflare Pages
  ├─ Trang khảo sát và album trên điện thoại
  ├─ Pages Functions API
  └─ Giao tiếp riêng với Supabase

Supabase
  ├─ photo_sessions
  ├─ survey_responses
  └─ survey_responses_export
```

- Ảnh thực tế được lưu trên **ImgBB**.
- Cloudflare Pages phục vụ giao diện album và API.
- Supabase lưu metadata phiên ảnh và câu trả lời khảo sát.
- `SUPABASE_SERVICE_ROLE_KEY` chỉ được đặt trong Cloudflare, không đặt trong desktop hoặc trình duyệt.

## Yêu cầu

- Windows 10/11.
- Node.js và npm.
- Canon EOS Utility/EDSDK nếu dùng Canon EOS.
- Máy in Windows đã được đặt làm máy in mặc định nếu sử dụng tính năng in.
- Tài khoản ImgBB, Cloudflare Pages và Supabase.

## Clone dự án

`cloudflare-album` là Git submodule trỏ tới repository riêng.

```powershell
git clone --recurse-submodules https://github.com/AidanVo02/Photobooth-Desktop.git
cd Photobooth-Desktop
```

Nếu đã clone mà chưa có nội dung album:

```powershell
git submodule update --init --recursive
```

## Cài đặt ứng dụng desktop

```powershell
npm install
Copy-Item .env.example .env
```

Điền `.env`:

```env
IMGBB_API_KEY="YOUR_IMGBB_API_KEY"
PHOTO_ALBUM_API_URL="https://YOUR_PROJECT.pages.dev"
PHOTO_ALBUM_PUBLIC_URL="https://YOUR_PROJECT.pages.dev"
PHOTOBOOTH_API_SECRET="SAME_SECRET_AS_CLOUDFLARE"
EDSDK_DIR="C:\\Program Files (x86)\\Canon\\EOS Utility\\EU2"
```

Không commit `.env`. File này chứa khóa truy cập thật.

Chạy ứng dụng:

```powershell
npm start
```

Electron được cấu hình chạy toàn màn hình. Nút **Camera** ở góc trên bên phải dùng để chọn webcam, Canon EOS, kết nối lại EOS và chụp thử.

## Canon EOS

Mã tích hợp EOS nằm trong `tools/eos-camera-service`. Khi ứng dụng chạy, `main.js` biên dịch service C# bằng .NET Framework compiler x86 nếu file thực thi chưa tồn tại hoặc mã nguồn đã thay đổi.

Đường dẫn EDSDK mặc định:

```text
C:\Program Files (x86)\Canon\EOS Utility\EU2
```

Nếu cài ở vị trí khác, cập nhật `EDSDK_DIR` trong `.env`.

Có thể xem hướng dẫn và smoke test tại:

- `tools/eos-camera-service/README.md`
- `tools/eos-smoke-test/README.md`

## Máy in

Ứng dụng dùng `pdf-to-printer` và gửi file JPG tới máy in mặc định của Windows. Trước khi vận hành:

1. Cài driver máy in.
2. Đặt Canon Selphy hoặc máy cần dùng làm **Default printer**.
3. Thiết lập đúng khổ 4 × 6 inch trong Windows/driver.
4. Chạy thử ít nhất một lượt trước sự kiện.

## Cấu hình Supabase

Mở Supabase SQL Editor và chạy lần lượt:

1. `cloudflare-album/supabase/migrations/001_photo_sessions.sql`
2. `cloudflare-album/supabase/migrations/002_survey_responses.sql`
3. `cloudflare-album/supabase/migrations/003_survey_responses_export_view.sql`

Không xóa bảng `survey_responses`. View `survey_responses_export` chỉ đọc và chuyển dữ liệu từ bảng này thành tiêu đề/câu trả lời tiếng Việt dễ xuất Excel.

Xem hoặc tải khảo sát:

1. Mở **Supabase → Table Editor**.
2. Chọn `survey_responses_export`.
3. Chọn **Export data → CSV**.
4. Trong Excel, import bằng **Data → From Text/CSV**, chọn UTF-8 và delimiter `Comma`.

## Deploy Cloudflare Album

Repository album riêng:

https://github.com/Truongvy265/cloudflare-album

Cloudflare Pages cần cấu hình:

- Project root: repository album.
- Build command: để trống.
- Build output directory: `public`.
- Functions directory: `functions` (Pages tự nhận diện).

Variables/Secrets:

```text
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
PHOTOBOOTH_API_SECRET
```

`PHOTOBOOTH_API_SECRET` phải giống giá trị trong `.env` của desktop. Sau khi push branch deploy của repository album, kiểm tra deployment trên Cloudflare Pages trước khi chạy kiosk.

Xem thêm hướng dẫn tại `cloudflare-album/README.md`.

## Dữ liệu và bảo mật

- Album hết hạn logic sau 30 ngày.
- API public chỉ trả metadata trước khảo sát, không trả URL ảnh.
- URL ảnh chỉ được trả sau khi khảo sát hợp lệ đã lưu thành công.
- Supabase bật RLS và không cấp policy đọc/ghi công khai cho bảng khảo sát.
- Không commit `.env`, `.dev.vars`, service-role key hoặc ảnh khách.
- `assets/captures`, `assets/prints` và `assets/eos-preview` là dữ liệu runtime và đã được Git ignore.
- Cần thiết lập chính sách lưu/xóa phù hợp vì khảo sát chứa họ tên, email và số điện thoại.

## Kiểm tra trước khi vận hành

- Camera Live View hiển thị ổn định.
- Crop guide đổi đúng theo từng layout.
- Mỗi vị trí có thể xác nhận và chụp lại.
- Ảnh ghép đúng tỷ lệ và không méo.
- In thử thành công bằng máy in mặc định.
- Upload ImgBB thành công.
- QR mở đúng Cloudflare album.
- Form khảo sát lưu được vào Supabase.
- Album chỉ hiển thị sau khi gửi khảo sát.
- `survey_responses_export` hiển thị tiếng Việt đúng.

Kiểm tra cú pháp nhanh:

```powershell
node --check main.js
node --check renderer.js
node --check cloudflare-album/public/assets/album.js
```

## Các file chính

- `index.html`: giao diện kiosk toàn màn hình.
- `renderer.js`: state, camera, chụp lại, ghép ảnh, filter, upload và QR.
- `main.js`: Electron, EOS IPC, Cloudflare API và máy in.
- `assets/frames`: tài nguyên khung ảnh.
- `cloudflare-album/public`: giao diện khảo sát/album trên điện thoại.
- `cloudflare-album/functions`: Cloudflare Pages Functions API.
- `cloudflare-album/supabase/migrations`: schema và view Supabase.

## Ghi chú phát triển

- Kích thước ảnh xuất hiện tại là `1200 × 1800 px` (tỷ lệ 2:3).
- Thuật toán ghép dùng center-crop; crop guide Live View sử dụng cùng tỷ lệ với từng ô ảnh.
- Khi cập nhật repository album, commit/push trong `cloudflare-album` trước, sau đó cập nhật con trỏ submodule trong repository desktop.
- Không commit ảnh chụp thử hoặc file build EOS `.exe`.
