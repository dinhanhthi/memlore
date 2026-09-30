# Chữ dài cần cân nhắc

Danh sách này chỉ ghi lại, không sửa chữ nào. Mọi chỗ tràn chữ đã được xử lý bằng bố cục (cỡ chữ, ngắt dòng, vị trí). Những mục dưới đây vẫn hiển thị được nhưng khá dài hoặc nên thống nhất cách viết.

## themes (Tuỳ chỉnh)

- Tiêu đề (narration.vi.json): "Tuỳ chỉnh app theo phong cách của bạn." dùng "Tuỳ", còn chỗ khác trong phim dùng "tùy" ("Tất cả tùy chọn. Quyết định của bạn."). Nên thống nhất một kiểu.
- `themes.layout.left.line2` = "nội dung, danh sách, thanh bên": dài, phải thu nhỏ chữ và xuống 2 dòng trong cột nhãn 290 px. Gợi ý: "nội dung, danh sách".
- `themes.layout.mid.line2` = "thanh bên, nội dung, danh sách": như trên. Gợi ý: "thanh bên, nội dung".
- `themes.layout.classic.line2` = "thanh bên, danh sách, nội dung": như trên. Gợi ý: "thanh bên, danh sách".
- `themes.layout.left.name` = "Nội dung bên trái": phải giảm cỡ chữ để vừa 2 dòng. Gợi ý: "Nội dung trái".
- `themes.railDs` = "HỆ GIAO DIỆN · CHẾ ĐỘ": phải giảm cỡ chữ để vừa 1 dòng. Gợi ý: "GIAO DIỆN · CHẾ ĐỘ".

## local (Chỉ có trên máy)

- Tiêu đề (narration.vi.json): "Chỉ tồn tại trên thiết bị của bạn." xuống 3 dòng ở cột trái. Vẫn đẹp, nhưng nếu muốn 2 dòng: "Chỉ ở trên thiết bị của bạn."

## onThisDay (Cùng ngày)

- Thẻ ảnh "Ngày đầu ở căn hộ mới" xuống 2 dòng trong thẻ nhỏ. Gợi ý: "Ngày đầu ở nhà mới".

## aiCards

- Tên tính năng "Viết tiếp & viết lại", "Gợi ý viết sâu hơn", "Tìm kiếm ngữ nghĩa", "Trò chuyện hằng ngày" xuống 2 dòng trong ô lưới cuối cảnh. Chấp nhận được. Gợi ý nếu muốn 1 dòng: "Viết tiếp", "Gợi ý sâu hơn", "Tìm theo nghĩa", "Trò chuyện".
- Câu nhận xét ở thẻ "Phân tích chủ đề": "Căng thẳng công việc dịu đi vào những tuần bạn đi bộ đường dài." phải giảm còn 27 px để vừa 1 dòng. Gợi ý: "Căng thẳng dịu đi vào những tuần bạn đi bộ."

## Ghi chú khác (không phải chữ)

- Ảnh chụp app trong cảnh themes có giao diện tiếng Việt nhưng nội dung mẫu (ví dụ "A fresh start") vẫn là tiếng Anh vì dữ liệu demo của app.

## Sau khi sửa lời thoại (resync)

Phim giờ dài 264,0 s. Các cảnh đã dài hơn (cũ → mới, giây): calendar 5,5 → 9,0; tags 6 → 7; onThisDay 7 → 8,5; stats 5 → 7,5; aiCards 50 → 52,5; secondYou 9 → 13; mcp 12,5 → 16; import 9 → 11; open 6,5 → 7,5; intro 14,5 → 15; local 10 → 10,5; locks 19,5 → 20; editor 12,5 → 13. **Nhạc nền phải được tạo lại** (music.mjs rồi mix.mjs) vì nhịp cắt cảnh đã dịch; bản `music/` và `audio.wav` hiện tại đã lệch với timeline mới.

Hình ảnh đã được chỉnh lại theo giọng mới (chỉ code cảnh, không đổi chữ): lịch điền ngày từ đầu câu đến hết câu, stats trải các thẻ theo độ dài câu, editor gõ đoạn văn chậm lại cho kịp câu, lưới cuối aiCards lắc nhẹ, open hiện sticker đầu sớm hơn, themes giãn các bước cách nhau tối thiểu 0,3 s. Những chỗ dưới đây là chữ trên màn hình không còn khớp giọng, hoặc giọng nhồi quá nhiều vào quá ít thời gian; bạn quyết định.

- themes: câu "Giao diện Memlore do bạn quyết định cùng vô số cách kết hợp. Ba hệ giao diện khác nhau, tuỳ chỉnh sáng tối, màu sắc, bố cục và phông chữ." nhồi "màu sắc, bố cục và phông chữ" vào khoảng 1,1 s nên các bước màu nhấn, bố cục, phông chỉ cách nhau 0,05 đến 0,2 s; hình ảnh đã bị giãn ra (các bước trễ hơn lời tới khoảng 1 s, phần cuối cảnh không còn tiếng). Gợi ý: tách thành hai câu, ví dụ "Ba hệ giao diện khác nhau, sáng hoặc tối. Rồi chọn màu nhấn, bố cục và phông chữ." và để chừa khoảng lặng sau "phông chữ".
- onThisDay: giọng gọi tên tính năng là "Ngày này năm xưa", nhưng tiêu đề trên màn hình là "Cùng ngày. Trong quá khứ." Gợi ý: đổi tiêu đề thành "Ngày này năm xưa." (hoặc đổi giọng thành "Cùng ngày").
- map: giọng nói "nhật ký theo bản đồ", còn tiêu đề/nhãn trên màn hình nói về bản đồ theo cách khác; nếu giữ giọng thì tiêu đề nên là "Nhật ký theo bản đồ." để khớp. Câu giọng cũng dài (liệt kê ảnh, video, ghi âm, kỷ niệm) so với số lần ghim xuất hiện; gợi ý rút: "Bạn sẽ thấy ảnh, video, ghi âm và kỷ niệm đúng nơi chúng đã xảy ra."
- secondYou: giọng "Memlore có thể ghi nhớ... học cách viết giống bạn. Một phiên bản thứ hai của chính mình." nhưng tiêu đề màn hình là "Gặp con người thứ hai của bạn." và nhãn "Bạn thứ hai". Gợi ý: tiêu đề "Một phiên bản thứ hai của bạn."; câu cuối "bật hay tắt chức năng này" nói rất nhanh (cuối 3 giây), có thể rút thành "Bạn toàn quyền chỉnh sửa, bật hay tắt."
- stats: trong lời thoại có "thổng thể" (sai chính tả, nên là "tổng thể"); tiêu đề "Câu chuyện của bạn, qua những con số." trong khi giọng nói "thói quen viết". Gợi ý: "Thói quen viết của bạn, qua những con số."
- calendar: giọng nói "Lịch sáng lên ở mỗi ngày bạn đã viết... cái nhìn tổng quát về quãng thời gian qua hay theo dõi cảm xúc của mình biến chuyển thế nào", còn tiêu đề là "Mỗi ngày, trong tầm mắt." Hơi lệch về phần tâm trạng; gợi ý thêm ý tâm trạng vào tiêu đề: "Mỗi ngày và tâm trạng, trong tầm mắt."
- mcp: tiêu đề "Viết nhật ký từ các AI agent khác." trong khi giọng nói "kết nối ChatGPT, Claude hay bất kỳ ứng dụng MCP nào". Gợi ý: "Viết nhật ký từ AI agent của bạn." Câu giọng khá dài (14,6 s); cảnh đã thêm chuyển động nhẹ cho hai cửa sổ.
- tags: giọng "Thẻ giúp mọi thứ gọn gàng, theo cách của bạn" khá ngắn sau câu dài, còn tiêu đề "Cuộc sống của bạn, thẻ của bạn." Chấp nhận được; nếu muốn khớp hơn: "Thẻ của bạn, cách của bạn."
- open: 2,6 s đầu giọng nói chưa tới "mã nguồn mở" (Tuyệt nhất là gì? App là một phần mềm...) và màn hình không có chữ nào; mình cho sticker đầu hiện sớm. Gợi ý nếu muốn đẹp hơn: thêm một tiêu đề ngắn như "Tuyệt nhất là gì?" trong cảnh.
