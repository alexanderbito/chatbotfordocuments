/* =====================================================================
   Song ngữ Việt / Anh

   Cách làm: dùng chính chuỗi tiếng Việt làm khoá. Nhờ vậy nếu thiếu bản
   dịch thì giao diện vẫn hiện tiếng Việt bình thường chứ không vỡ thành
   mã khoá, và code đọc vẫn tự nhiên.

   Có hai đường dịch:
   1. t('...') — gọi trực tiếp khi dựng chuỗi trong JS.
   2. translateDOM() — quét DOM sau mỗi lần render. Cần thiết vì các trang
      dựng HTML bằng innerHTML, không thể gắn data-i18n cho từng chỗ.
      Chỉ dịch khi nội dung khớp CHÍNH XÁC một khoá, và bỏ qua mọi thứ
      nằm trong phần tử đánh dấu data-no-i18n (tên tài liệu, tên thư mục,
      email, nội dung chat — những thứ là dữ liệu của người dùng).
   ===================================================================== */

const EN = {
  // --- Chung ---
  'Đăng nhập': 'Sign in', 'Đăng ký': 'Sign up', 'Đăng xuất': 'Sign out',
  'Huỷ': 'Cancel', 'Lưu': 'Save', 'Xoá': 'Delete', 'Đóng': 'Close', 'Gỡ': 'Remove',
  'Lưu thay đổi': 'Save changes', 'Làm mới': 'Refresh', 'Tiếp tục': 'Continue',
  'Trước': 'Previous', 'Sau': 'Next', 'Đang tải…': 'Loading…', 'Xem tất cả': 'View all',
  'Chọn tất cả': 'Select all', 'Bỏ chọn tất cả': 'Clear all', 'Quay lại': 'Back',
  'Vẫn xoá': 'Delete anyway', 'Vẫn lưu': 'Save anyway', 'Kiểm tra lại': 'Check again',
  'Về trang chủ': 'Back to home', 'vừa xong': 'just now',
  'Chatbot tài liệu doanh nghiệp': 'Chatbot for company documents',
  'Quản trị doanh nghiệp': 'Organization admin', 'Quản trị hệ thống': 'System admin',
  'Không gian hỏi đáp': 'Workspace', 'Doanh nghiệp': 'Organization',
  'Vận hành': 'Operations', 'Tài khoản': 'Account', 'Trò chuyện': 'Chat',
  'Kinh doanh': 'Business',

  // --- Trạng thái ---
  'Sẵn sàng': 'Ready', 'Đang xử lý': 'Processing', 'Đang nhận dạng': 'Running OCR',
  'Chờ thử lại': 'Retry pending', 'Lỗi': 'Failed', 'Hoạt động': 'Active',
  'Tạm khoá': 'Suspended', 'Chờ nhận lời mời': 'Invited', 'Đã khoá': 'Disabled',
  'Quản trị': 'Admin', 'Dùng thử': 'Trial',
  'Đã thanh toán': 'Paid', 'Quá hạn': 'Overdue', 'Đã thu': 'Received',
  'Chờ thu': 'Pending', 'Thất bại': 'Failed', 'Hoàn tiền': 'Refunded',
  'Thông tin': 'Info', 'Cảnh báo': 'Warning', 'Chủ sở hữu': 'Owner',

  // --- Đăng nhập / đăng ký ---
  'Email công việc': 'Work email', 'Mật khẩu': 'Password', 'Họ và tên': 'Full name',
  'Tên doanh nghiệp': 'Company name', 'Đang đăng nhập…': 'Signing in…',
  'Tạo tài khoản': 'Create account', 'Đang tạo tài khoản…': 'Creating account…',
  'Đăng ký doanh nghiệp': 'Create a company account',
  'Truy cập vào không gian làm việc của doanh nghiệp bạn.': 'Access your company workspace.',
  'Tài khoản đầu tiên sẽ là quản trị viên của doanh nghiệp.': 'The first account becomes the company administrator.',
  'Chưa có tài khoản?': "Don't have an account?", 'Đã có tài khoản?': 'Already have an account?',
  'Ít nhất 6 ký tự': 'At least 6 characters',
  'Dùng mật khẩu riêng, không trùng với email công việc.': 'Use a unique password, not the same as your work email.',
  'Biến kho tài liệu nội bộ': 'Turn your internal documents',
  'thành trợ lý hỏi đáp': 'into an answering assistant',
  'Tải tài liệu lên, hệ thống tự phân tích và tạo chatbot trả lời trong đúng phạm vi tài liệu của doanh nghiệp bạn.':
    'Upload your documents and the system builds a chatbot that answers strictly from them.',
  'Phân quyền rõ ràng': 'Clear permissions',
  'Admin quản lý tài liệu, thành viên chỉ hỏi đáp': 'Admins manage documents, members only ask questions',
  'Sắp xếp theo thư mục': 'Organised in folders',
  'Phân loại tài liệu theo phòng ban, dự án': 'Group documents by department or project',
  'Theo dõi mức sử dụng': 'Track usage',
  'Biết ai hỏi gì, dùng bao nhiêu hạn mức': 'See who asked what and how much quota is left',
  'Bắt đầu miễn phí': 'Start free', 'Dùng thử miễn phí': 'Start free trial',
  'Dùng thử miễn phí 3 ngày': 'Free for 3 days',
  'Đủ tính năng trong 3 ngày, trừ nhận dạng PDF scan. Hết 3 ngày, tài liệu sẽ bị xoá nếu bạn không nâng cấp.':
    'Every feature for 3 days, except scanned-PDF OCR. After 3 days your documents are deleted unless you upgrade.',
  'Miễn phí': 'Free', '/tháng': '/month', 'tài liệu': 'documents', 'thành viên': 'members',
  'lượt hỏi/tháng': 'questions/month',
  'Email hoặc mật khẩu không đúng': 'Incorrect email or password',
  'Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại.': 'Your session expired, please sign in again.',
  'Tham gia doanh nghiệp': 'Join the organization',
  'Bạn chưa thuộc doanh nghiệp nào': 'You are not part of any organization',
  'Hãy liên hệ quản trị viên doanh nghiệp để được mời vào tổ chức.':
    'Ask your company administrator to invite you.',

  // --- Điều hướng / tiêu đề trang ---
  'Tổng quan': 'Overview', 'Tài liệu & thư mục': 'Documents & folders',
  'Lịch sử hỏi đáp': 'Chat history', 'Gói cước': 'Plan & billing', 'Thiết lập': 'Settings',
  'Hỏi đáp tài liệu': 'Ask your documents', 'Lịch sử của tôi': 'My history',
  'Bảng quản trị': 'Admin console', 'Mở chatbot': 'Open chatbot', 'Bảng giá': 'Pricing',
  'Bức tranh nhanh về tài liệu, thành viên và mức sử dụng.': 'A quick picture of documents, members and usage.',
  'Tải lên, sắp xếp và kiểm soát tài liệu được đưa vào chatbot.': 'Upload, organise and control what the chatbot can read.',
  'Mời đồng nghiệp và phân quyền sử dụng chatbot.': 'Invite colleagues and set who can use the chatbot.',
  'Toàn bộ câu hỏi thành viên đã gửi và câu trả lời của chatbot.': 'Every question members asked and how the chatbot answered.',
  'Hạn mức đang dùng và lịch sử thanh toán.': 'Current usage and payment history.',
  'Hồ sơ doanh nghiệp và tài khoản của bạn.': 'Company profile and your account.',

  // --- Tài liệu ---
  'Tài liệu': 'Documents', 'Thư mục': 'Folders', 'Thư mục cha': 'Parent folder',
  'Tên thư mục': 'Folder name', 'Thư mục mới': 'New folder', 'Tạo thư mục': 'Create folder',
  'Tất cả tài liệu': 'All documents', 'Chưa phân loại': 'Unfiled',
  'Tải tài liệu lên': 'Upload documents', 'Tải lên': 'Upload', 'Tệp tài liệu': 'Files',
  'Chọn thư mục': 'Choose a folder', 'Chuyển thư mục': 'Move to folder',
  'Thư mục đích': 'Destination folder', 'Xử lý lại': 'Reprocess', 'Chạy lại ngay': 'Run again now',
  'Tải xuống': 'Download', 'Dung lượng': 'Size', 'Số đoạn': 'Chunks', 'Trạng thái': 'Status',
  'Tìm theo tên tài liệu…': 'Search by file name…', 'Chưa có tài liệu': 'No documents yet',
  'Chưa có tài liệu nào': 'No documents yet', 'Sửa thư mục và quyền': 'Edit folder and access',
  'Đổi tên': 'Rename', 'Người tải lên': 'Uploaded by',
  'Bấm "Tải tài liệu lên" để đưa tài liệu đầu tiên vào chatbot.': 'Click "Upload documents" to add your first file.',
  'Tài liệu mới nhất': 'Latest documents', 'Câu hỏi gần đây': 'Recent questions',
  'Xoá thư mục': 'Delete folder', 'Xoá tài liệu': 'Delete document',
  'Đã xoá tài liệu': 'Document deleted', 'Đã xoá thư mục': 'Folder deleted',
  'Đã lưu thư mục': 'Folder saved', 'Đã chuyển thư mục': 'Moved to folder',
  'Đang xử lý lại tài liệu': 'Reprocessing the document',
  'Chưa nhập tên thư mục': 'Please enter a folder name', 'Chưa chọn tệp': 'No file selected',

  // --- Quyền thư mục ---
  'Chế độ truy cập': 'Access', 'Công khai trong tổ chức': 'Public within the organization',
  'Riêng tư': 'Private',
  'Mọi thành viên đều hỏi chatbot được về tài liệu trong thư mục này': 'Every member can ask the chatbot about files in this folder',
  'Chỉ những người được chọn bên dưới mới hỏi được. Người khác không thấy thư mục và chatbot không đọc tài liệu bên trong.':
    'Only the people selected below can ask. Others never see this folder and the chatbot will not read from it.',
  'Ai được hỏi về tài liệu trong thư mục này?': 'Who can ask about files in this folder?',
  'Thư mục con nằm trong thư mục riêng tư cũng bị hạn chế theo — muốn đọc thư mục con thì phải có quyền ở tất cả thư mục cha riêng tư.':
    'Subfolders of a private folder inherit the restriction — access requires permission on every private parent folder.',
  'Thư mục riêng tư chưa có ai': 'Private folder with nobody selected',

  // --- Thành viên ---
  'Thành viên': 'Members', 'Mời thành viên': 'Invite member', 'Vai trò': 'Role',
  'Đổi vai trò': 'Change role', 'Gửi lời mời': 'Send invitation',
  'Gỡ khỏi tổ chức': 'Remove from organization', 'Sao chép link mời': 'Copy invite link',
  'Đăng nhập gần nhất': 'Last sign-in', 'Đã sao chép link mời': 'Invite link copied',
  'Đã cập nhật vai trò': 'Role updated', 'Đã gỡ thành viên': 'Member removed',
  'Thành viên — chỉ dùng chatbot': 'Member — chatbot only',
  'Quản trị — quản lý tài liệu và thành viên': 'Admin — manages documents and members',
  'Phân quyền hoạt động thế nào?': 'How permissions work',
  'Chưa nhập email': 'Please enter an email',
  'Đã thêm thành viên vào tổ chức': 'Member added to the organization',
  'Link mời đã sẵn sàng': 'Invite link ready', 'Sao chép link': 'Copy link',
  'Đã sao chép': 'Copied',

  // --- Hỏi đáp ---
  'Gửi': 'Send', 'Nhập câu hỏi…': 'Type your question…',
  'Đặt câu hỏi về tài liệu của doanh nghiệp…': 'Ask a question about your company documents…',
  'Enter để gửi · Shift+Enter xuống dòng': 'Enter to send · Shift+Enter for a new line',
  'Phạm vi:': 'Scope:', 'Tất cả tài liệu tôi được xem': 'All documents I can access',
  'Xin chào': 'Hello', 'Câu hỏi': 'Question', 'Người hỏi': 'Asked by',
  'Nguồn': 'Sources', 'Nguồn tham chiếu': 'Source documents', 'Trả lời': 'Answer',
  'Lúc': 'When', 'Thời gian xử lý': 'Response time', 'Chi tiết hỏi đáp': 'Conversation detail',
  'Chưa có câu hỏi nào': 'No questions yet', 'Tìm trong câu hỏi…': 'Search questions…',
  'Không có': 'None',
  'Hãy đặt câu hỏi về tài liệu nội bộ. Câu trả lời luôn kèm tên tài liệu nguồn.':
    'Ask about your internal documents. Every answer cites the source file.',
  '50 câu hỏi gần nhất bạn đã gửi.': 'Your 50 most recent questions.',
  'Lịch sử sẽ hiện ở đây sau khi bạn bắt đầu hỏi.': 'Your history appears here once you start asking.',

  // --- Gói cước & mức dùng ---
  'Mức sử dụng': 'Usage', 'Gói hiện tại': 'Current plan', 'Các gói khác': 'Other plans',
  'Lịch sử thanh toán': 'Payment history', 'Hạn dùng': 'Valid until',
  'Số tiền': 'Amount', 'Ngày': 'Date', 'Kỳ': 'Period', 'Kỳ dịch vụ': 'Service period',
  'Hình thức': 'Method', 'Chưa có giao dịch': 'No transactions yet',
  'Lượt hỏi tháng này': 'Questions this month', 'Lượt hỏi trong tháng': 'Questions this month',
  'Dung lượng lưu trữ': 'Storage used', 'Trang nhận dạng (OCR)': 'OCR pages',
  'Trang nhận dạng PDF scan (OCR)': 'Scanned PDF pages (OCR)', 'trong tháng này': 'this month',
  'đoạn đã lập chỉ mục': 'chunks indexed',
  'Nâng cấp lên gói này': 'Upgrade to this plan', 'Tổng thanh toán': 'Total',
  'Phương thức thanh toán': 'Payment method', 'Tiếp tục thanh toán': 'Continue to payment',
  'Chuyển khoản / VietQR': 'Bank transfer / VietQR',
  'PayPal / Thẻ quốc tế': 'PayPal / International card',
  'Quét mã VietQR bằng app ngân hàng bất kỳ': 'Scan the VietQR code with any banking app',
  'Gói có hiệu lực ngay sau khi hệ thống nhận được tiền.': 'Your plan activates as soon as the payment arrives.',
  'không giới hạn': 'unlimited', 'Chọn gói này': 'Choose plan',
  'Phổ biến nhất': 'Most popular', 'Không có gói khác': 'No other plans',
  'Chọn gói phù hợp với doanh nghiệp bạn': 'Pick the plan that fits your team',
  'Mọi gói đều dùng chung một hệ thống, khác nhau ở hạn mức. Đổi gói bất kỳ lúc nào.':
    'Every plan runs the same system — they differ only in limits. Change plan any time.',
  'Giá hiển thị bằng VNĐ, thanh toán bằng chuyển khoản / VietQR. Đổi sang English để xem giá USD.':
    'Prices in VND, paid by bank transfer / VietQR. Switch to English for USD pricing.',
  'Prices shown in USD, paid by PayPal. Switch to Tiếng Việt for VND pricing and bank transfer.':
    'Prices shown in USD, paid by PayPal. Switch to Tiếng Việt for VND pricing and bank transfer.',
  'Giá chưa bao gồm VAT. Cần hoá đơn đỏ, vui lòng liên hệ trước khi thanh toán.':
    'Prices exclude VAT. Contact us before paying if you need a VAT invoice.',
  'Billed monthly. Contact us for annual billing or custom limits.':
    'Billed monthly. Contact us for annual billing or custom limits.',
  'trang nhận dạng PDF scan': 'scanned-PDF OCR pages',
  'Không có nhận dạng PDF scan': 'No scanned-PDF OCR',
  'dung lượng': 'storage',
  '{n} ngày, sau đó tài liệu bị xoá': '{n} days, then documents are deleted',
  'Thanh toán gói {name}': 'Pay for {name}',
  'Nâng cấp lên gói {name}': 'Upgrade to {name}',
  'Chỉ quản trị viên doanh nghiệp mới đổi được gói': 'Only company admins can change the plan',
  'Máy chủ chưa bật cổng thanh toán nào. Liên hệ quản trị hệ thống.':
    'No payment gateway is enabled on the server. Contact the system administrator.',
  'Nếu gói hiện tại còn hạn, thời gian còn lại được cộng dồn thêm 1 tháng.':
    'If your current plan is still valid, one month is added to the remaining time.',

  // --- Thiết lập ---
  'Hồ sơ doanh nghiệp': 'Company profile', 'Tài khoản của bạn': 'Your account',
  'Email liên hệ': 'Contact email', 'Mã số thuế': 'Tax code', 'Mã tổ chức': 'Organization ID',
  'Lưu hồ sơ': 'Save profile', 'Đổi mật khẩu': 'Change password',
  'Mật khẩu hiện tại': 'Current password', 'Mật khẩu mới': 'New password',
  'Đã lưu hồ sơ': 'Profile saved', 'Đã lưu hồ sơ doanh nghiệp': 'Company profile saved',
  'Đã đổi mật khẩu': 'Password changed',

  // --- Dùng thử ---
  'Nâng cấp ngay': 'Upgrade now', 'Xem bảng giá': 'See pricing',
  'Thời gian dùng thử đã kết thúc. Vui lòng nâng cấp gói để tiếp tục sử dụng.':
    'Your trial has ended. Please upgrade to keep using the service.',
  'Dữ liệu đã bị xoá': 'Data has been deleted',
  'Tài liệu đã bị xoá. Nâng cấp để bắt đầu lại.': 'Your documents were deleted. Upgrade to start again.',
  'Nâng cấp ngay để giữ lại tài liệu của bạn.': 'Upgrade now to keep your documents.',
  'Bản dùng thử còn {time}': '{time} left in your trial',
  'hết hạn sẽ xoá toàn bộ tài liệu': 'all documents are deleted when it ends',
  '{d} ngày {h} giờ': '{d}d {h}h', '{h} giờ {m} phút': '{h}h {m}m', '{m} phút': '{m}m',
  '{n} phút trước': '{n} min ago', '{n} giờ trước': '{n}h ago', '{n} ngày trước': '{n}d ago',
  'sau {n} giây': 'in {n}s', 'sau {n} phút': 'in {n} min', 'sắp chạy': 'starting soon',
  'Tự chạy lại {when}': 'Retrying {when}',
  'Hết hạn dùng thử': 'Trial ended',

  // --- Thanh toán: trang kết quả ---
  'Thanh toán thành công': 'Payment successful',
  'Bạn đã huỷ thanh toán': 'Payment cancelled',
  'Thanh toán chưa hoàn tất': 'Payment not completed',
  'Chưa nhận được xác nhận': 'Still waiting for confirmation',
  'Không tìm thấy giao dịch': 'Transaction not found',
  'Thiếu thông tin giao dịch': 'Missing transaction details',
  'Đường dẫn không hợp lệ.': 'This link is not valid.',
  'Đang kiểm tra kết quả thanh toán…': 'Checking your payment…',
  'Về trang gói cước': 'Back to billing',
  'Không có khoản tiền nào bị trừ. Bạn có thể chọn lại gói bất kỳ lúc nào.':
    'Nothing was charged. You can pick a plan again at any time.',
  'Giao dịch không thành công. Bạn có thể thử lại.': 'The transaction did not go through. You can try again.',
  'Nếu bạn đã chuyển tiền, hệ thống sẽ tự cập nhật trong vài phút. Tải lại trang này để kiểm tra.':
    'If you have already paid, this will update within a few minutes. Reload to check.',
  'Giao dịch không tồn tại hoặc không thuộc doanh nghiệp của bạn.':
    'This transaction does not exist or does not belong to your organization.',
  // --- Bổ sung: chuỗi ghép với số và các chỗ còn sót ---
  '{ready} sẵn sàng · {failed} lỗi': '{ready} ready · {failed} failed',
  '{n} đoạn đã lập chỉ mục': '{n} chunks indexed',
  'Lượt hỏi 30 ngày gần nhất': 'Questions over the last 30 days',
  'Tổng {n} câu hỏi': '{n} questions total',
  'Hạn mức theo gói {name}': 'Limits on the {name} plan',
  '{total} câu hỏi · trang {page}/{pages}': '{total} questions · page {page}/{pages}',
  'OCR {n} trang': 'OCR {n} pages',
  'Lỗi {code}': 'Error {code}',
  'Phiên đăng nhập đã hết hạn': 'Your session has expired',

  // Nhãn nhóm nhật ký và phương thức trích xuất
  'Hỗn hợp': 'Mixed', 'Hỏi đáp': 'Chat', 'Thanh toán': 'Payments', 'Hệ thống': 'System',

  // Thư mục
  'Riêng tư — {n} người được đọc': 'Private — {n} people can read',
  'Thêm thư mục': 'Add folder', 'Thư mục riêng tư': 'Private folder',
  'Ví dụ: Quy trình nhân sự': 'e.g. HR procedures',
  'Thư mục: {name}': 'Folder: {name}',
  'Xoá "{name}"? Tài liệu bên trong sẽ chuyển về mục Chưa phân loại, không bị mất.':
    'Delete "{name}"? Files inside move to Unfiled — nothing is lost.',
  'Cảnh báo: tài liệu sẽ thành công khai': 'Warning: these documents will become public',
  '"{name}" đang ở chế độ riêng tư. Xoá thư mục sẽ đẩy tài liệu bên trong về mục Chưa phân loại, và MỌI thành viên trong tổ chức sẽ hỏi được nội dung đó. Vẫn tiếp tục?':
    '"{name}" is private. Deleting it moves its files to Unfiled, where EVERY member of the organization can ask about them. Continue?',
  'Chưa có thành viên thường': 'No regular members yet',
  'Hãy mời thành viên trước khi phân quyền.': 'Invite members before granting access.',
  '{n} quản trị viên của tổ chức luôn đọc được mọi thư mục nên không cần chọn ở đây.':
    'The {n} organization admins can always read every folder, so they are not listed here.',
  'Bạn chưa chọn thành viên nào. Thư mục sẽ chỉ quản trị viên đọc được, thành viên thường không hỏi được gì trong đó. Tiếp tục?':
    'You have not selected anyone. Only admins will be able to read this folder. Continue?',
  'Bỏ qua {n} email không thuộc tổ chức': 'Skipped {n} email(s) not in this organization',

  // Tài liệu
  'Hỗ trợ PDF (kể cả bản scan — hệ thống tự nhận dạng chữ), DOCX và TXT. Tối đa 25 MB mỗi tệp.':
    'Supports PDF (including scans — text is recognised automatically), DOCX and TXT. Max 25 MB per file.',
  'PDF scan xử lý lâu hơn và tính vào hạn mức trang nhận dạng của gói.':
    'Scanned PDFs take longer and count towards your plan\'s OCR page quota.',
  'Đang tải {i}/{total}: {name}…': 'Uploading {i}/{total}: {name}…',
  'Đã tải lên {ok} tệp': 'Uploaded {ok} file(s)', ', {n} tệp lỗi': ', {n} failed',
  'Thư mục đích cho "{name}"': 'Destination folder for "{name}"',
  'Chuyển vào "Chưa phân loại" nghĩa là mọi thành viên trong tổ chức đều hỏi được tài liệu này.':
    'Moving to Unfiled means every member of the organization can ask about this document.',
  'Xoá vĩnh viễn "{name}"? Chatbot sẽ không còn dùng tài liệu này.':
    'Permanently delete "{name}"? The chatbot will no longer use it.',
  'Tự chạy lại {when}': 'Retrying {when}',

  // Thành viên
  'chờ nhận lời mời': 'invited',
  'Vai trò của {email}': 'Role for {email}',
  'Gỡ {email} khỏi tổ chức? Họ sẽ không truy cập được chatbot nữa.':
    'Remove {email} from the organization? They will lose access to the chatbot.',
  'Sao chép link này:': 'Copy this link:',
  'Nếu email chưa có tài khoản, hệ thống tạo một link mời để bạn gửi cho họ.':
    'If the email has no account yet, an invite link is created for you to send them.',
  'Gửi link dưới đây cho {email} để họ tạo tài khoản và vào tổ chức:':
    'Send the link below to {email} so they can create an account and join:',

  // Gói cước
  'Doanh nghiệp đang dùng gói miễn phí.': 'This organization is on the free plan.',
  'Chưa gán gói': 'No plan assigned',
  '— Không có —': '— None —', ' (riêng tư)': ' (private)',
  'Gỡ thành viên': 'Remove member',
  'Máy chủ chưa bật cổng thanh toán nào. Liên hệ quản trị hệ thống để đổi gói.':
    'No payment gateway is enabled on the server. Contact the system administrator to change plan.',
  'Công ty TNHH ABC': 'Acme Corporation',
  'Nguyễn Văn A': 'Jane Smith',

  // Đăng ký / đăng nhập
  'Vui lòng nhập tên doanh nghiệp': 'Please enter your company name',
  'Bạn được mời vào "{org}" với vai trò {role}.': 'You were invited to "{org}" as {role}.',
  'quản trị': 'an admin', 'thành viên': 'a member',
  'Dữ liệu mỗi doanh nghiệp được cách ly hoàn toàn': 'Each company\'s data is fully isolated',

  // Chat
  'Bạn': 'You',
  'Chatbot chỉ trả lời dựa trên tài liệu đã được duyệt của {org}.':
    'The chatbot answers only from documents approved for {org}.',
  'Tóm tắt nội dung chính của tài liệu mới nhất': 'Summarise the main points of the latest document',
  'Quy trình xin nghỉ phép được quy định thế nào?': 'How does the leave request process work?',
  'Chính sách bảo mật thông tin gồm những điểm gì?': 'What does the information security policy cover?',

  // Trang tĩnh
  'Đang chuyển hướng…': 'Redirecting…',
  'Kết quả thanh toán': 'Payment result',
  'Chatbot tài liệu doanh nghiệp': 'Chatbot for company documents',
  'Không tìm thấy trang': 'Page not found',
  'Đường dẫn bạn truy cập không tồn tại hoặc đã bị thay đổi.': 'That address does not exist or has changed.',
};

const STORAGE_KEY = 'docbot_lang';

function detect() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'vi' || saved === 'en') return saved;
  } catch { /* chế độ riêng tư */ }
  const nav = (navigator.language || 'vi').toLowerCase();
  return nav.startsWith('vi') ? 'vi' : 'en';
}

let current = detect();

export function lang() { return current; }
export function isEnglish() { return current === 'en'; }

export function setLang(l) {
  current = l === 'en' ? 'en' : 'vi';
  try { localStorage.setItem(STORAGE_KEY, current); } catch { /* bỏ qua */ }
  document.documentElement.lang = current;
  location.reload();   // tải lại để mọi chỗ cùng đổi, kể cả dữ liệu lấy từ máy chủ
}

/** Dịch một chuỗi. Thiếu bản dịch thì trả lại nguyên tiếng Việt. */
export function t(vi, vars) {
  let out = current === 'en' ? (EN[vi] ?? vi) : vi;
  if (vars) for (const [k, v] of Object.entries(vars)) out = out.split(`{${k}}`).join(v);
  return out;
}

/* ---------- Tiền tệ đi theo ngôn ngữ ---------- */

/** Tiếng Việt xem giá VNĐ, tiếng Anh xem giá USD. */
export function currency() { return current === 'en' ? 'USD' : 'VND'; }

/** Cổng thanh toán gợi ý theo ngôn ngữ đang chọn. */
export function preferredProvider() { return current === 'en' ? 'paypal' : 'payos'; }

export function money(amount, cur = currency()) {
  const n = Number(amount || 0);
  if (cur === 'USD') {
    return `$${n.toLocaleString('en-US', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;
  }
  return `${n.toLocaleString('vi-VN')} đ`;
}

export function locale() { return current === 'en' ? 'en-GB' : 'vi-VN'; }

/* ---------- Dịch nội dung đã render ---------- */

// Không đưa OPTION vào đây: chữ trong <option> phần lớn là chữ giao diện và
// cần dịch. Dữ liệu người dùng (tên tổ chức, tên thư mục) được bảo vệ riêng
// bằng data-no-i18n đặt trên chính thẻ <option> hoặc <select> chứa nó.
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'CODE', 'PRE', 'TEXTAREA']);

function shouldSkip(node) {
  let el = node.parentElement;
  while (el) {
    if (SKIP_TAGS.has(el.tagName)) return true;
    if (el.hasAttribute && el.hasAttribute('data-no-i18n')) return true;
    el = el.parentElement;
  }
  return false;
}

/**
 * Quét và dịch các nút văn bản khớp CHÍNH XÁC một khoá trong từ điển.
 * Dữ liệu của người dùng (tên tài liệu, nội dung chat…) nằm trong phần tử
 * đánh dấu data-no-i18n nên không bị đụng tới.
 */
/**
 * Dịch tiêu đề tab. Tiêu đề có dạng "Phần A — Phần B"; dịch từng phần rồi
 * ghép lại, nhờ vậy "Hỏi đáp tài liệu — DocBot" thành "Ask your documents — DocBot".
 */
export function translateTitle() {
  if (current !== 'en') return;
  const raw = document.title;
  if (!raw) return;
  const parts = raw.split(' — ').map((x) => x.trim());
  const out = parts.map((x) => EN[x] || x).join(' — ');
  if (out !== raw) document.title = out;
}

export function translateDOM(root) {
  if (current !== 'en') return;
  if (!root) translateTitle();
  root = root || document.body;
  if (!root) return;

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const jobs = [];
  let node;
  while ((node = walker.nextNode())) {
    const raw = node.nodeValue;
    const trimmed = raw.trim();
    if (!trimmed || trimmed.length > 220) continue;
    const hit = EN[trimmed];
    if (hit && !shouldSkip(node)) jobs.push([node, raw.replace(trimmed, hit)]);
  }
  for (const [n, v] of jobs) n.nodeValue = v;

  for (const attr of ['placeholder', 'title', 'aria-label']) {
    const list = root.querySelectorAll ? root.querySelectorAll(`[${attr}]`) : [];
    list.forEach((el) => {
      if (el.closest('[data-no-i18n]')) return;
      const v = (el.getAttribute(attr) || '').trim();
      if (v && EN[v]) el.setAttribute(attr, EN[v]);
    });
  }
}

/** Theo dõi DOM để dịch phần mới render, gộp nhiều thay đổi làm một lượt. */
export function observeAndTranslate() {
  if (current !== 'en') return;
  translateDOM();

  let pending = false;
  const obs = new MutationObserver(() => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => { pending = false; translateDOM(); });
  });
  obs.observe(document.body, { childList: true, subtree: true, characterData: false });
}

/** Nút đổi ngôn ngữ. */
export function langSwitcherHtml() {
  return `
    <div class="lang-switch" data-no-i18n>
      <button type="button" data-lang="vi" class="${current === 'vi' ? 'active' : ''}">VI</button>
      <button type="button" data-lang="en" class="${current === 'en' ? 'active' : ''}">EN</button>
    </div>`;
}

export function bindLangSwitcher(root) {
  (root || document).querySelectorAll('[data-lang]').forEach((b) => {
    b.onclick = () => setLang(b.dataset.lang);
  });
}

document.documentElement.lang = current;
