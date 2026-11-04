# Quý Phi Cloud v8.1 — Nhiều người ở trong một phòng

## Cập nhật an toàn trên GitHub Pages

1. Mở phiên bản Cloud đang dùng. Vào **Cài đặt → Xuất dữ liệu (.json)** để sao lưu trước. Giữ bản lưu JSON ngoài GitHub.
2. Trong máy tính, sao lưu file `index.html` cũ, sau đó thay bằng `index.html` mới trong thư mục dự án.
3. **Không thay `config.js`** đang chứa Project URL và Publishable key của Supabase. `cloud.js` phiên bản 8.0 giữ nguyên. Không cần chạy lại SQL.
4. Vào repository `manhquy3011/quyphi-cloud` → **Add file → Upload files** → tải **chỉ file `index.html` mới** lên, chọn thay thế file cũ, Commit changes. Nếu GitHub yêu cầu sửa file thay vì upload đè, mở file trên GitHub và dùng biểu tượng bút chì để thay toàn bộ nội dung, sau đó Commit.
5. Mở `https://manhquy3011.github.io/quyphi-cloud/`, tải lại trang (trên iPhone: Reload; khi cần xóa cache riêng của site, sao lưu JSON trước). Đảm bảo tất cả thiết bị cùng dùng phiên bản mới trước khi tiếp tục chỉnh sửa phòng.
6. Trong **Phòng trọ → Sửa phòng**, chọn **+ Thêm người ở**, nhập từng người, tích **Là người đại diện phòng** ở đúng một người và **Lưu phòng**.
7. Khi có người chuyển đi, mở **Sửa phòng**, bấm **Chuyển đi** ở hồ sơ đó (ngày chuyển đi mặc định là hôm nay, có thể đổi trong ô ngày), sau đó **Lưu phòng**. Hồ sơ nằm trong lịch sử; không còn được đếm là người ở hiện tại.
8. Chờ trạng thái **Đã đồng bộ lên Cloud**. Thử trên máy tính và điện thoại, nhấn **Tải dữ liệu mới** trên thiết bị kia.

## Nguyên tắc

- Mỗi người: họ tên, số điện thoại, CCCD/CMND tùy chọn, người lớn/trẻ em, ngày vào, ngày chuyển đi.
- Hóa đơn mới chỉ hiển thị người đại diện. Hóa đơn đã lập vẫn giữ nguyên tên, số tiền, chỉ số và số người tại thời điểm lập.
- Nước theo đầu người: số người **đang ở** trong phòng là mức mặc định cho hóa đơn mới; ở form hóa đơn vẫn có thể sửa số người khi nhập các tháng lịch sử. Không tự tính theo số ngày ở hoặc tự chia tiền khi có người đến/đi giữa tháng.
- Dữ liệu v8 cũ sẽ được chuyển khi tải: người đại diện cũ được giữ; nếu số người cũ lớn hơn số tên đã khai báo, ứng dụng tạo các hồ sơ **chưa cập nhật tên** để không làm mất số lượng. Hãy bổ sung tên, CCCD từng người khi biết.
- Nếu tất cả mọi người đã chuyển đi, phòng được ghi nhận là **phòng đang trống**; không thể lập hóa đơn **mới** cho phòng trống nhưng vẫn xem/sửa được hóa đơn cũ.
- Không tự xóa người cũ khỏi dữ liệu: đánh dấu ngày chuyển đi để lưu lịch sử. Có thể bấm **Cho ở lại** để sửa nếu thao tác nhầm.
- App đang lưu dữ liệu nhiều người ở trong JSON của cùng bảng `quyphi_app_state`; không cần bảng SQL mới.
- **Tránh dùng đồng thời file `index.html` v8 cũ và v8.1 mới trên hai thiết bị để chỉnh sửa**, vì ứng dụng cũ chưa biết các trường mới và có thể làm mất danh sách người ở mới nếu nó ghi trạng thái.
- CCCD là thông tin nhạy cảm: không chia sẻ bản JSON hoặc đưa nó lên GitHub. Lưu trên thiết bị tin cậy, bảo vệ tài khoản Supabase bằng mật khẩu mạnh.
