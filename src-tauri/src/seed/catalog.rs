//! Static demo catalog for seed_demo_data (no DB I/O).
//!
//! Journals, tags, and entries are pure data. The runner maps day offsets to
//! unix timestamps, creates rows via production paths, and synthesizes media
//! according to each entry's [`DemoMediaPlan`].
//!
//! Journal names are stable (`[Demo] …`); the runner reuses them on re-run
//! and only inserts a new, generation-varied entry batch.
//!
//! **Language mix:** ~80% Vietnamese / ~20% English journal stories.
//! Each entry is a real personal narrative with ≥5 paragraphs and a clear
//! emotional arc. Every entry has a required DB emotion in `{good, neutral, bad}`
//! chosen to match that arc (not random). Prose may still carry richer feelings
//! (proud, hope, angry, sad, success, …) beyond the 3-state DB tag.
//! **Photos:** more than 60% of entries include inline photos (Picsum).

/// A demo journal row template. Display names include `[Demo]` so re-runs stay
/// identifiable; the runner reuses journals by this exact name.
#[derive(Debug, Clone, Copy)]
pub struct DemoJournal {
    pub name: &'static str,
    pub color: &'static str,
}

/// A demo tag template.
#[derive(Debug, Clone, Copy)]
pub struct DemoTag {
    pub name: &'static str,
    pub color: &'static str,
}

/// Optional location attached to an entry (matches entry location fields).
#[derive(Debug, Clone, Copy)]
pub struct DemoLocation {
    pub name: &'static str,
    pub lat: f64,
    pub lng: f64,
}

/// How the runner should attach media for this entry.
#[derive(Debug, Clone, Copy)]
pub struct DemoMediaPlan {
    /// Number of inline photos (Picsum / synth later). Zero means none.
    pub inline_photos: u8,
    /// Attach a synthetic audio clip (`insertion_mode=attached`).
    pub attach_audio: bool,
    /// Attach a synthetic file (PDF/txt, attached).
    pub attach_file: bool,
}

/// Static demo entry. `journal_index` indexes into [`demo_journals`].
/// `day_offset` is relative to "now" (negative = past). Runner converts to unix.
#[derive(Debug, Clone, Copy)]
pub struct DemoEntry {
    pub journal_index: usize,
    pub title: &'static str,
    pub paragraphs: &'static [&'static str],
    /// Days relative to now; negative = past.
    pub day_offset: i32,
    /// Required DB emotion: `"good" | "neutral" | "bad"`.
    /// Must match the entry's narrative arc (not random / not decorative).
    pub emotion: &'static str,
    pub tag_names: &'static [&'static str],
    pub favorite: bool,
    pub location: Option<DemoLocation>,
    pub weather: Option<&'static str>,
    pub media: DemoMediaPlan,
}

const NO_MEDIA: DemoMediaPlan = DemoMediaPlan {
    inline_photos: 0,
    attach_audio: false,
    attach_file: false,
};

const PHOTOS_1: DemoMediaPlan = DemoMediaPlan {
    inline_photos: 1,
    attach_audio: false,
    attach_file: false,
};

const PHOTOS_2: DemoMediaPlan = DemoMediaPlan {
    inline_photos: 2,
    attach_audio: false,
    attach_file: false,
};

const PHOTOS_1_AUDIO: DemoMediaPlan = DemoMediaPlan {
    inline_photos: 1,
    attach_audio: true,
    attach_file: false,
};

const PHOTOS_1_FILE: DemoMediaPlan = DemoMediaPlan {
    inline_photos: 1,
    attach_audio: false,
    attach_file: true,
};

// ── Journals ────────────────────────────────────────────────────────────────

const JOURNALS: &[DemoJournal] = &[
    DemoJournal {
        name: "[Demo] Personal",
        color: "#8B5CF6",
    },
    DemoJournal {
        name: "[Demo] Work",
        color: "#3B82F6",
    },
    DemoJournal {
        name: "[Demo] Travel",
        color: "#10B981",
    },
];

// ── Tags ────────────────────────────────────────────────────────────────────

const TAGS: &[DemoTag] = &[
    DemoTag {
        name: "demo",
        color: "#7C3AED",
    },
    DemoTag {
        name: "travel",
        color: "#10B981",
    },
    DemoTag {
        name: "work",
        color: "#3B82F6",
    },
    DemoTag {
        name: "gratitude",
        color: "#F59E0B",
    },
    DemoTag {
        name: "sức khỏe",
        color: "#EF4444",
    },
    DemoTag {
        name: "gia đình",
        color: "#EC4899",
    },
];

// ── Vietnamese stories (32 entries ≈ 80%) ───────────────────────────────────

/// Proud — shipped a product after months of doubt.
const P_VI_PROUD: &[&str] = &[
    "Hôm nay tôi bấm nút deploy lần cuối và ngồi im nhìn thanh progress chạy hết. Không ai vỗ tay, không có pháo hoa — chỉ có một dòng log xanh và tiếng quạt laptop. Vậy mà ngực tôi phồng lên như vừa leo xong một ngọn đồi dài.",
    "Ba tháng trước, chính tôi cũng không tin dự án này sẽ ra đời. Mỗi sprint đều trễ một chút, mỗi demo đều bị hỏi lại cùng một câu: “Khi nào xong?” Tôi mang theo nỗi sợ bị coi là không đủ năng lực, và nỗi sợ đó ăn mòn giấc ngủ nhiều hơn cả deadline.",
    "Nhưng team đã không bỏ cuộc. Có những buổi tối chúng tôi ngồi sửa bug đến khuya, ăn mì ly trong phòng họp, cười vì lỗi ngớ ngẩn rồi im lặng khi lỗi nghiêm trọng. Tôi học được rằng tự hào không đến từ khoảnh khắc bấm nút, mà từ chuỗi ngày chọn ở lại khi dễ dàng rời đi.",
    "Buổi chiều, tôi gọi cho mẹ. Bà không hiểu “deploy” là gì, chỉ hỏi con có mệt không và đã ăn cơm chưa. Tôi nói con xong việc rồi, giọng run một chút. Mẹ im một nhịp rồi bảo: “Mẹ biết con làm được.” Câu đó nhẹ hơn mọi email khen thưởng.",
    "Tối nay tôi viết những dòng này không phải để khoe thành tích. Tôi muốn nhớ cảm giác này — cái cảm giác đứng vững sau khi nghi ngờ chính mình. Nếu sau này lại có giai đoạn tối, hãy mở lại entry này và nhớ: mình từng vượt qua một núi lớn hơn.",
];

/// Happy — family reunion after years apart.
const P_VI_HAPPY: &[&str] = &[
    "Sáng nay sân bay Tân Sơn Nhất đông như hội. Tôi đứng gần cửa ra với tấm biển viết tay “Chào ba!” chữ hơi lệch vì tay run. Khi ba xuất hiện với vali cũ và nụ cười quen thuộc, cả thế giới như thu lại thành một cái ôm dài.",
    "Ba đi làm xa năm năm. Video call không thay được mùi thuốc lá trên áo và cái vỗ vai nặng tay. Chúng tôi ngồi ở quán phở gần nhà ga, ăn vội, nói chuyện lộn xộn từ thời tiết đến hàng xóm. Không có bài diễn văn nào — chỉ có tiếng tô chạm nhau và tiếng cười.",
    "Về nhà, mẹ đã nấu sẵn canh chua và cá kho. Bàn ăn chật chỗ vì có thêm em họ. Ai cũng nói lớn, ai cũng muốn kể chuyện của mình. Tôi ngồi nhìn và bất chợt thấy mình may mắn đến mức gần như sợ: sợ ngày này sẽ trôi qua quá nhanh.",
    "Chiều, ba mang ra album ảnh cũ. Có tấm tôi hồi lớp một, tóc cắt ngắn, cười hở nướu. Ba kể lại lần đưa tôi đi mua vở đầu năm. Những ký ức tưởng đã mờ bỗng hiện rõ như vừa xảy ra tuần trước. Hạnh phúc đôi khi chỉ là được nghe lại chuyện cũ từ người mình thương.",
    "Đêm nay nhà sáng đèn đến muộn. Tôi viết trong khi mọi người vẫn nói chuyện ngoài phòng khách. Nếu có ai hỏi tôi hạnh phúc nhất năm nay là khi nào, câu trả lời sẽ là hôm nay — không có thành tích lớn, chỉ có cả nhà ngồi cùng một bàn.",
];

/// Hope — after a failed interview, choosing to continue.
const P_VI_HOPE: &[&str] = &[
    "Email từ chối đến lúc 9 giờ sáng. Chủ đề ngắn gọn: “Cảm ơn bạn đã tham gia.” Tôi đọc hai lần, đóng laptop, rồi mở lại như hy vọng chữ sẽ đổi. Không đổi. Cà phê trên bàn nguội ngắt mà tôi vẫn cầm ly.",
    "Tôi đã luyện phỏng vấn suốt ba tuần. Ghi chú dán kín tường, mock interview với bạn bè, thức khuya đọc case study. Thất bại lần này không chỉ là một “không” — nó chạm vào câu hỏi tôi hay giấu: mình có đang đi đúng hướng không?",
    "Buổi trưa tôi đi bộ quanh công viên thay vì lướt mạng. Gió mát, trẻ con chạy, ai đó tập yoga trên thảm xanh. Thế giới vẫn quay. Điều đó nghe tầm thường, nhưng hôm nay nó cứu tôi. Tôi không cần cả thế giới dừng lại để thương tôi; tôi cần một lý do để bước tiếp.",
    "Chiều, tôi viết lại những gì làm được tốt trong buổi phỏng vấn và những chỗ còn lủng củng. Không phải để tự trách, mà để biến thất bại thành bản đồ. Có một khoảng trống về system design — vậy thì học. Có một câu trả lời vòng vo — vậy thì luyện ngắn gọn hơn.",
    "Hy vọng không phải là tin rằng lần sau chắc chắn đậu. Hy vọng là tin rằng nỗ lực hôm nay làm mình xứng đáng với cơ hội tốt hơn, dù kết quả còn chưa biết. Tôi sẽ nộp đơn khác vào thứ Hai. Đêm nay, tôi cho phép mình buồn — rồi ngủ sớm.",
];

/// Sad — goodbye to a close friend moving abroad.
const P_VI_SAD: &[&str] = &[
    "Lan lên máy bay lúc 23:40. Tôi đứng sau kính sân bay đến khi máy bay khuất hẳn trong đêm. Mưa nhẹ. Áo khoác ướt vai mà tôi không nhận ra cho đến khi về tới xe buýt.",
    "Chúng tôi biết nhau mười hai năm — từ ký túc xá ẩm mốc đến những lần thất nghiệp, thất tình, và cả những lần “chỉ cần một ly trà sữa là ổn”. Bây giờ Lan đi định cư. Tôi vui cho bạn, thật. Nhưng vui và buồn có thể ngồi chung một ghế.",
    "Trước khi vào cổng, Lan đưa tôi một cuốn sổ nhỏ. Bên trong là danh sách những quán ăn chúng tôi từng hẹn mà chưa kịp đi. “Lần sau về, mình gạch hết,” bạn nói. Tôi gật. Không dám hứa ngày. Chỉ dám hứa sẽ giữ sổ.",
    "Về nhà, phòng vẫn còn mùi nước hoa Lan để quên trên bàn. Tôi không dọn ngay. Có những nỗi buồn cần được để yên một đêm, như vết thương chưa muốn băng. Tôi bật playlist cũ chúng tôi hay nghe lúc lái xe vòng Hồ Tây.",
    "Sáng mai cuộc sống sẽ đòi hỏi email, deadline, và vẻ mặt bình thường. Nhưng đêm nay tôi cho phép mình khóc. Không phải vì thế giới bất công — chỉ vì một người quan trọng đang bay ra khỏi quỹ đạo quen thuộc của tôi. Buồn cũng là một cách nói: mình đã từng yêu thương rất thật.",
];

/// Angry — unfair credit taken at work.
const P_VI_ANGRY: &[&str] = &[
    "Trong buổi họp all-hands, slide mang tên người khác hiện lên với đúng giải pháp tôi đã đề xuất hai tuần trước. Không ai nhắc đến tôi. Tim đập mạnh đến mức tôi nghe thấy trong tai. Tôi cười lịch sự vì camera đang bật.",
    "Sau họp, tôi mở lại thread Slack cũ. Có timestamp, có file đính kèm, có phản hồi “hay quá, để mình cân nhắc.” Bằng chứng nằm đó. Vậy mà trên sân khấu, câu chuyện đã được kể lại như thể ý tưởng rơi từ trên trời vào đúng một người.",
    "Cơn giận của tôi không chỉ vì mất credit. Nó vì cảm giác bị xóa khỏi chính công sức của mình. Tôi đã thức khuya, test edge cases, viết doc. Giờ tất cả bị gói thành một dòng bullet trên slide của người khác. Tức đến mức tay run khi gõ phím.",
    "Tôi cân nhắc gửi email dài cho sếp. Rồi xóa nháp. Rồi viết lại ngắn hơn. Cuối cùng tôi hẹn 1:1 và nói thẳng, giọng cố giữ đều. Sếp gật, xin lỗi, hứa sẽ “clarify với team.” Tôi không biết lời hứa đó nặng bao nhiêu. Nhưng ít nhất tôi không nuốt cơn giận đến mức nó thành độc.",
    "Viết entry này để khỏi mang cơn giận về nhà và trút lên người vô can. Ngày mai tôi sẽ làm việc chuyên nghiệp như vẫn thế — nhưng tôi sẽ ghi nhận công sức của mình rõ ràng hơn, sớm hơn, và không chờ người khác kể hộ câu chuyện của tôi.",
];

/// Disappointed — personal goal missed (half marathon).
const P_VI_DISAPPOINTED: &[&str] = &[
    "Đồng hồ dừng ở 2:18:41. Mục tiêu của tôi là dưới 2:00. Tôi chống tay lên đầu gối ngay sau vạch đích, thở hổn hển, và cảm giác thất vọng ập đến trước cả niềm vui vì đã về đích.",
    "Sáu tháng tập luyện. Lịch chạy dán trên tủ lạnh. Giày mòn đế. Những buổi sáng 5 giờ khi phố còn tối và tôi vẫn ra đường. Tôi tưởng kỷ luật sẽ đổi lấy một con số đẹp. Hóa ra cơ thể có quyền nói “chưa” dù ý chí đã nói “có”.",
    "Km 28 tôi bắt đầu chuột rút. Km 32 tôi phải đi bộ. Người ta vượt lên, cổ vũ, vỗ vai. Tôi cười gượng. Trong đầu chỉ có một câu lặp lại: “Mình đã làm sai chỗ nào?” Thất vọng với kết quả dễ lẫn với thất vọng với chính mình.",
    "Về nhà, tôi suýt không đăng ảnh finisher. Rồi vẫn đăng, chú thích ngắn: “Xong rồi. Chậm hơn kỳ vọng, nhưng xong.” Bạn bè khen. Tôi đọc từng comment và thấy mình khó tiếp nhận lời khen — như thể chưa “đủ tư cách” vì trượt mốc thời gian.",
    "Đêm nay tôi chọn viết thật: tôi thất vọng. Không cần tô hồng ngay. Nhưng tôi cũng biết một điều khác — tôi đã không bỏ cuộc giữa chừng. Mùa giải sau vẫn còn. Con số 2:00 chưa biến mất; nó chỉ chưa thuộc về hôm nay.",
];

/// Success — promotion after long stretch.
const P_VI_SUCCESS: &[&str] = &[
    "Sếp gọi vào phòng họp nhỏ lúc 4 giờ chiều. Tôi nghĩ là review sprint. Thay vào đó, sếp nói: “Team muốn đề xuất thăng cấp cho bạn.” Tôi nghe rõ từng chữ mà não vẫn trễ nửa nhịp, như mạng lag.",
    "Hai năm trước tôi vào công ty với tâm thế “chỉ cần đừng bị đuổi.” Tôi học codebase như học một thành phố lạ: lạc lối, hỏi đường, dần nhớ shortcut. Có quý làm tốt, có quý chật vật. Thành công hôm nay không phải phép màu — nó là tổng của rất nhiều ngày bình thường được làm tử tế.",
    "Sau buổi nói chuyện, tôi gửi tin cho người yêu: “Em được promote.” Ba dấu chấm hiện rồi biến. Rồi một tin đến: “Anh tự hào!” Tôi cười một mình trong toilet công ty vì không muốn đồng nghiệp thấy mắt ướt.",
    "Tôi không quên những lần suýt bỏ cuộc — bug production lúc nửa đêm, feedback gay gắt, cảm giác mình là mắt xích yếu. Mỗi lần ấy tôi đều nghĩ thành công là của người khác. Hôm nay tôi giữ lấy khoảnh khắc này: mình cũng được công nhận.",
    "Tối về, tôi mua bánh tiramisu chia cả nhà. Không phải để khoe chức danh. Là để đánh dấu: nỗ lực thầm lặng đôi khi vẫn được nhìn thấy. Ngày mai công việc vẫn khó. Nhưng hôm nay, tôi cho phép mình vui trọn.",
];

/// Gratitude — ordinary day, deep thanks.
const P_VI_GRATITUDE: &[&str] = &[
    "Không có sự kiện lớn hôm nay. Chỉ có nước nóng lúc tắm sáng, cơm nguội còn ăn được, và tin nhắn “nhớ mang áo mưa” từ mẹ. Tôi vẫn muốn viết, vì biết ơn hay chết yểu nếu không được gọi tên.",
    "Trưa, đồng nghiệp để lại trên bàn tôi một hộp trái cây “thừa từ nhà”. Không phải quà sang. Nhưng đúng lúc tôi quên mang đồ ăn. Sự tử tế nhỏ như thế làm cả buổi chiều dịu lại. Tôi nhận ra mình hay chờ điều lớn để cảm thấy may mắn — trong khi cuộc sống đang lặng lẽ chu cấp.",
    "Chiều mưa. Tôi ngồi trong quán cà phê góc phố, làm việc chậm hơn bình thường. Ngoài kính, người ta chạy tìm chỗ trú. Trong quán, tiếng máy xay và mùi hạt cà phê. Tôi viết ra ba điều biết ơn: sức khỏe đủ để đi làm, công việc còn thử thách nhưng chưa bóp nghẹt, và những người vẫn trả lời tin nhắn của tôi.",
    "Có giai đoạn tôi chỉ ghi nhật ký khi mọi thứ sụp. Hôm nay tôi tập thói quen ngược lại: ghi khi mọi thứ “ổn.” Vì “ổn” cũng là một món quà, chỉ kém ồn ào hơn khủng hoảng.",
    "Trước khi ngủ, tôi đọc lại danh sách. Ngắn thôi. Nhưng đủ để nhắc tôi rằng cuộc đời không trống rỗng chỉ vì chưa có tin vui lớn. Biết ơn không xóa khó khăn; nó chỉ đặt khó khăn vào đúng tỷ lệ.",
];

/// Neutral / anxious — waiting for medical results.
const P_VI_ANXIOUS: &[&str] = &[
    "Phiếu hẹn tái khám ghi 14:30. Đồng hồ mới 13:10 mà tôi đã ngồi trong hành lang bệnh viện. Màn hình gọi số nhảy chậm như cố tình. Tôi cầm điện thoại nhưng không đọc được gì quá hai dòng.",
    "Tuần trước bác sĩ nói “cần thêm xét nghiệm để loại trừ.” Cụm từ “loại trừ” nghe khoa học, nhưng với bệnh nhân nó giống như treo một dấu hỏi lớn trên ngực. Tôi Google đêm đó — sai lầm kinh điển — rồi phải gập máy vì càng đọc càng sợ.",
    "Người ngồi cạnh tôi là một bà cụ và cháu gái. Họ nói chuyện về chợ và giá rau. Sự bình thường ấy trấn an lạ kỳ. Tôi hiểu lo âu không phải lúc nào cũng cần triết lý; đôi khi chỉ cần tiếng đời sống vẫn chạy quanh mình.",
    "Khi được gọi vào, tim đập nhanh. Bác sĩ lật hồ sơ, đeo kính, nói chậm: các chỉ số ổn, chỉ cần theo dõi thêm và thay đổi sinh hoạt. Tôi gật liên tục, cảm ơn hơi nhiều lần. Bước ra ngoài, không khí nóng của Sài Gòn bỗng dễ thở hơn.",
    "Tôi viết entry này ở trạng thái “trung tính” — không vỡ oà, không sụp đổ. Chỉ là một người vừa bước qua căn phòng chờ. Bài học nhỏ: cơ thể cần chăm sóc sớm hơn là hoảng loạn muộn. Tuần này tôi sẽ ngủ đủ và đi bộ mỗi chiều, không phải vì sợ, mà vì trân trọng.",
];

/// Travel joy — Đà Nẵng morning.
const P_VI_TRAVEL_DN: &[&str] = &[
    "Đà Nẵng 5:40 sáng. Biển còn giữ màu xám xanh của đêm chưa tan. Tôi đi chân đất trên cát ướt, nước sóng chạm mắt cá chân, lạnh và sạch. Thành phố du lịch lúc này thuộc về người dậy sớm và những chú chó chạy theo chủ.",
    "Tôi đến đây một mình sau một quý làm việc căng. Không itinerary dày đặc. Chỉ muốn nghe sóng đủ lâu để đầu óc hết kêu như thông báo Slack. Chiếc xe máy thuê vẫn còn mùi nhựa mới; tôi phóng chậm dọc bãi biển, mũ bảo hiểm hơi rộng.",
    "Ăn bún chả cá ở quán có bốn bàn. Bà chủ hỏi “đi một mình hả?” với giọng không tò mò thái quá. Tô bún nóng, chả dai, nước dùng ngọt vị biển. Ăn xong tôi ngồi thêm năm phút chỉ để nhìn người ta bắt đầu ngày mới.",
    "Trưa lên Ngũ Hành Sơn, leo chậm, đổ mồ hôi, thỉnh thoảng dừng chụp ảnh rồi xóa vì không muốn biến chuyến đi thành gallery. Tôi muốn nhớ bằng da thịt: hơi thở dốc, bóng mát trong động, tiếng gió trên đỉnh.",
    "Tối về khách sạn, chân mỏi, đầu nhẹ. Du lịch không phải lúc nào cũng cần “check-in địa điểm viral.” Đôi khi chỉ cần một thành phố cho phép mình im lặng mà không bị coi là kỳ cục. Đà Nẵng đã cho tôi điều đó hôm nay.",
];

/// Lonely — quiet apartment after roommate left.
const P_VI_LONELY: &[&str] = &[
    "Căn hộ đột nhiên rộng gấp đôi sau khi Hùng chuyển đi. Không phải vì đồ đạc ít hơn — dù kệ sách đã thưa — mà vì tiếng động biến mất. Không còn tiếng game khuya, không còn mùi trứng chiên sáng sớm, không còn ai hỏi “mày ăn gì chưa?”",
    "Tôi tưởng mình sẽ thích sự yên tĩnh. Tuần đầu đúng là thích: ngủ sớm, dọn dẹp theo ý mình, bật nhạc không cần tai nghe. Tuần thứ hai, yên tĩnh đổi chất. Nó không còn là khoảng thở; nó thành khoảng trống.",
    "Tối nay tôi nấu canh chua cho một người. Nồi nhỏ vẫn nhiều. Ăn xong rửa bát, nhìn ra ban công thành phố đèn vàng. Tôi mở mạng xã hội rồi đóng lại. Cô đơn không phải lúc nào cũng muốn trò chuyện — đôi khi chỉ muốn có ai đó cùng im trong cùng một không gian.",
    "Tôi nhắn tin cho Hùng: “Nhà ổn không?” Bạn trả lời ngay kèm ảnh phòng trọ mới. Chúng tôi chat vài câu rồi dừng. Khoảng cách không chỉ là km; nó là nhịp sống lệch nhau. Tôi không trách ai. Chỉ ghi nhận: mình đang nhớ một thói quen có người ở cạnh.",
    "Ngày mai tôi sẽ gọi thêm một người bạn lâu không gặp, hoặc ra quán làm việc. Không phải để trốn cô đơn bằng ồn ào, mà để nhắc mình rằng cô đơn là cảm xúc, không phải bản án. Đêm nay, tôi để đèn bàn sáng và viết cho đủ dài — như nói chuyện với một phiên bản biết lắng nghe của chính mình.",
];

/// Peaceful morning routine reclaim.
const P_VI_PEACEFUL: &[&str] = &[
    "Tôi thức lúc 5:50 mà không cần chuông. Ánh sáng len qua rèm mỏng. Pha cà phê phin, nghe từng giọt rơi vào ly. Không mở điện thoại trong hai mươi phút đầu. Kỷ luật nhỏ này đang chữa tôi chậm rãi.",
    "Trước đây buổi sáng của tôi là cuộc đua: tin nhắn, lịch họp, tin tức xấu. Não bật chế độ phòng thủ trước khi chân chạm đất. Giờ tôi chọn viết vài dòng, duỗi vai, nhìn ra đường còn vắng. Hòa bình không ầm ĩ. Nó chỉ cần được bảo vệ khỏi sự vội.",
    "Tôi mang sổ ra ban công. Hàng xóm tưới cây. Xe máy thưa. Trong sổ, tôi không cố viết hay — chỉ ghi cơ thể cảm thấy thế nào, trời ra sao, việc quan trọng nhất trong ngày là gì. Ba câu. Đủ để neo tâm trí.",
    "Có người bảo routine buổi sáng là mốt productivity. Với tôi, nó là hàng rào. Sau hàng rào ấy, thế giới vẫn hỗn loạn, nhưng tôi bước vào với tư thế đứng vững hơn. Không phải kiểm soát mọi thứ; chỉ là không để mọi thứ kiểm soát ngay từ phút đầu.",
    "Khi cuối cùng tôi mở laptop, inbox vẫn đầy. Nhưng nhịp tim đều. Entry này là lời cảm ơn gửi cho phiên bản mình biết dừng lại. Nếu chỉ giữ được một thói quen năm nay, tôi muốn giữ buổi sáng yên tĩnh này.",
];

/// Frustrated — estimation drift & crunch.
const P_VI_FRUSTRATED: &[&str] = &[
    "Sprint review hôm nay kéo dài gần hai tiếng. Demo thì mượt; phần “chưa xong” thì dài hơn phần “đã xong.” Tôi ngồi nhìn bảng ticket và cảm thấy bực — với tiến độ, với ước lượng, và một phần với chính mình vì đã gật đầu nhận story quá lớn.",
    "Chúng tôi không lười. Team code gần như mỗi ngày. Vấn đề là khoảng cách giữa “nghe có vẻ nhỏ” và “thực ra dính ba hệ thống legacy.” Mỗi lần đào xuống lại thấy thêm một phụ thuộc. Bực nhất là mang cảm giác đã cố hết sức mà bảng vẫn đỏ.",
    "Trong retro, không khí thẳng thắn đến mức hơi căng. Ai cũng mệt. Có người muốn giảm scope, có người muốn thêm người. Tôi nói: mình cần estimation trung thực hơn, và quyền nói “không” sớm hơn. Nói ra thì dễ; giữ được kỷ luật ấy ở sprint sau mới khó.",
    "Tan họp, tôi đi bộ một vòng quanh tòa nhà cho nguội đầu. Không muốn mang cáu về nhà. Frustration không phải lúc nào cũng xấu — nó báo hiệu rằng quy trình đang ma sát với thực tế. Bỏ qua nó thì sprint sau lại lặp.",
    "Đêm nay tôi viết rõ ba thay đổi sẽ đề xuất: spike trước khi commit story lớn, limit WIP, và demo giữa sprint để lộ rủi ro sớm. Không bảo đảm sẽ được chấp nhận hết. Nhưng ghi ra khiến cơn bực biến thành việc có thể làm, thay vì đám mây treo trên đầu.",
];

/// Proud of a sibling — family pride.
const P_VI_PROUD_FAMILY: &[&str] = &[
    "Em gái bảo tin được học bổng lúc tôi đang rửa chén. Nước vẫn chảy, tôi đứng khựng, rồi cười to đến mức hàng xóm chắc nghe thấy. Em nói nhanh, hơi thở gấp, như sợ tin vui sẽ bay mất nếu kể chậm.",
    "Tôi nhớ ngày em thi trượt năm nhất đại học, khóc trên ghế xe bus. Hôm đó tôi chỉ biết mua trà đào và ngồi im. Không có bài học nào hay ho. Chỉ có mặt tôi ở đó. Nhìn em hôm nay, tôi thấy quãng đường dài không nằm trên giấy chứng nhận — nó nằm ở những lần đứng dậy sau điểm liệt.",
    "Bố mẹ phản ứng kiểu người Việt: mừng, rồi lo ngay “qua bên đó ăn uống ra sao.” Em vừa cười vừa dỗ. Nhà chúng tôi không giỏi diễn thuyết cảm xúc, nhưng biết bày mâm cơm đặc biệt. Tối nay có tôm rim và canh khổ qua — món em thích từ nhỏ.",
    "Sau bữa ăn, em mang giấy tờ ra giải thích ngành học. Tôi hiểu được khoảng 60%, gật 100%. Tự hào đôi khi không cần hiểu hết chi tiết; chỉ cần hiểu người mình thương đang nở ra phiên bản dũng cảm hơn.",
    "Trước khi ngủ, tôi nhắn em: “Anh tự hào. Không chỉ vì học bổng — vì em không bỏ cuộc.” Em thả một sticker cười mếu. Vậy là đủ. Ngày của em, nhưng tôi cũng được ấm bởi ánh sáng ấy.",
];

/// Recovery — coming back after burnout.
const P_VI_RECOVERY: &[&str] = &[
    "Hôm nay là ngày thứ mười tôi không mở laptop công việc sau 7 giờ tối. Nghe tầm thường, nhưng với tôi đó là cột mốc. Hai tháng trước, “hết giờ” chỉ là lý thuyết; thực tế là tôi mang office trong đầu đến tận lúc chải răng.",
    "Burnout của tôi không đến bằng một vụ nổ. Nó đến bằng những sáng mệt sẵn, những cuối tuần không nghỉ được, và việc cáu với người thân vì chuyện nhỏ. Cơ thể đã gửi hóa đơn trước khi tôi chịu đọc.",
    "Tôi nhờ bác sĩ, nói chuyện với sếp, xin giảm tải một phần. Không hùng tráng. Có lúc tôi xấu hổ vì “yếu.” Rồi nhận ra xin giúp đỡ cũng là kỹ năng nghề nghiệp — kỹ năng giữ mình đủ lành để còn làm việc lâu dài.",
    "Tuần này tôi chạy bộ nhẹ ba buổi, ngủ trước 23 giờ, và viết nhật ký thay vì cuộn mạng. Năng lượng chưa về 100%, nhưng màu sắc ngày đã bớt xám. Recovery không phải nút reset; nó là chỉnh lại nhịp, ngày này qua ngày khác.",
    "Nếu tương lai tôi lại muốn chứng minh giá trị bằng cách tự hủy, hãy đọc lại entry này. Mình đã từng gần vỡ, và mình đã chọn lành. Đó cũng là một dạng thành công — chỉ ít được khoe trên LinkedIn hơn.",
];

/// Hanoi weekend — bittersweet nostalgia.
const P_VI_HANOI: &[&str] = &[
    "Hà Nội cuối tuần mang mùi trà đá và lá khô. Tôi ngồi ghế nhựa vỉa hè Hồ Hoàn Kiếm, cốc trà đặc, nhìn người ta chụp ảnh rùa và cầu Thê Húc. Thành phố này luôn khiến tôi vừa thân vừa lạ mỗi lần trở lại.",
    "Tôi lớn lên ở đây trước khi vào Nam làm việc. Mỗi lần về, phố cũ ngắn hơn trong ký ức. Căn nhà xưa đổi mặt tiền. Quán bún hết chỗ cho chuỗi trà sữa. Tôi không phản đối sự đổi thay — chỉ cần vài phút để thương phiên bản phố của mình.",
    "Chiều, tôi ghé hiệu sách cũ gần Tràng Thi. Mua được một cuốn tiểu thuyết mỏng, gáy sờn, chữ người đọc trước để lại ở lề. Đọc vài trang trong quán cà phê nhỏ, tiếng xe ngoài phố thành nhạc nền. Du lịch trong chính quê hương có vị ngọt lạ.",
    "Tối ăn chả cá với bạn cũ. Chúng tôi nói về công việc, về người đã lấy vợ, về người vẫn “đang tính.” Cười nhiều. Im lặng cũng nhiều. Có những tình bạn không cần cập nhật status liên tục vẫn còn sống nếu gặp lại vẫn nhận ra nhịp của nhau.",
    "Trên tàu điện về chỗ nghỉ, tôi viết những dòng này bằng một ngón cái. Hà Nội không giải quyết deadline ở Sài Gòn. Nó chỉ nhắc tôi rằng mình đến từ đâu, và vẫn còn những con phố cho phép mình chậm lại mà không bị phạt.",
];

// ── English stories (8 entries ≈ 20%) ───────────────────────────────────────

/// Success — job offer after a long search.
const P_EN_SUCCESS: &[&str] = &[
    "The offer email landed at 7:12 a.m., right as the kettle clicked off. I read the salary line twice, then the start date, then the whole thing again as if the words might rearrange into a prank. They did not. I sat on the kitchen floor and laughed until my eyes watered.",
    "This search took five months. I rewrote my résumé until the verbs felt dishonest, practiced system-design answers in the shower, and collected rejections that arrived with the cheerful emptiness of templates. Some nights I wondered whether persistence was noble or just stubbornness wearing a nicer coat.",
    "What changed was not a single viral interview hack. It was quieter: a friend who did a mock loop with me on a Sunday, a notebook of failures turned into checklists, and the decision to apply for roles that scared me instead of ones that only soothed my ego. Confidence came late, like a guest who arrives after the work is already done.",
    "I called my sister before I told anyone at my current job. She screamed into the phone so loudly I had to hold it away from my ear. We talked about the apartment I might finally afford to paint, about leaving a team I still respect, about the fear that success will demand a new kind of performance.",
    "Tonight I am not optimizing my life. I am eating good noodles and letting the win be a win. Tomorrow I will negotiate a detail or two, and next month I will be the nervous new hire again. But this entry is a pin in the map: the long stretch ended, and I crossed it.",
];

/// Disappointed — product launch canceled.
const P_EN_DISAPPOINTED: &[&str] = &[
    "They canceled the launch on a Tuesday afternoon with a calendar invite titled “Quick sync.” There was nothing quick about it. Leadership walked through the metrics, the budget, the strategic pivot, and then the sentence that emptied the room: we are not shipping.",
    "I had lived inside that product for nine months. I knew every empty state, every onboarding snag, every compromise we made to hit a date that no longer mattered. Hearing it described as “learnings” felt like watching someone summarize a relationship as a spreadsheet.",
    "After the call I went for a walk without a destination. The weather was unfairly beautiful. People outside were buying coffee and living days that did not include a dead roadmap. I wanted to be angry at someone specific, but disappointment is often fog — hard to punch, easy to breathe in.",
    "Back at my desk I archived the launch checklist. Checking off “cancel comms” felt obscene. A teammate dropped a note in chat: “Proud of what we built anyway.” I stared at it a long time. Pride and disappointment can share a body; they do not cancel each other cleanly.",
    "I am writing this so I do not pretend I am fine too quickly. Something I cared about will not meet the world. That hurts. I will take the useful pieces forward, yes — but first I will let the loss be real for one honest evening.",
];

/// Happy — old friends dinner.
const P_EN_HAPPY: &[&str] = &[
    "Marie and Theo flew in for one night only, and we closed the little Italian place on the corner like we used to in our twenties. The waiter stopped asking if we wanted another bottle and just started bringing water and dessert menus with a knowing smile.",
    "We told the same stories with new punchlines. The apartment with the broken heater. The road trip that ended in a ditch and a sunrise. The year we all pretended to have careers before any of us actually did. Time folded; the years between visits thinned until they felt like a long weekend.",
    "I watched Marie laugh with her whole face and thought about how rare it is to be known without a highlight reel. They have seen me broke, dramatic, unkind, and trying again. Friendship like that is not light. It is ballast. It keeps the self from drifting into whatever version is most convenient for strangers.",
    "Outside, the city was loud and ordinary. Inside our booth, joy had a texture — warm bread, bad jokes, the relief of not performing competence. I did not check work email once. That alone might be the purest luxury I get all quarter.",
    "Walking home, I felt full in a way food cannot explain. Happiness is not always fireworks. Sometimes it is three people who still choose the same table after the map of their lives has been redrawn. I am putting this night in writing so future-me cannot claim the year was only deadlines.",
];

/// Angry — bureaucratic runaround.
const P_EN_ANGRY: &[&str] = &[
    "I spent four hours at the municipal office to be told I was in the wrong line, then the right line with the wrong form, then the correct form with a stamp from a desk that closes at 2 p.m. It was 2:07. The clerk said “come back Thursday” with the calm of someone describing the weather.",
    "Anger arrived hot and precise. Not the cinematic kind — the jaw-tight kind that makes your hearing narrow. I had taken a half day off work, printed everything they listed online, and still lost to a rule that was not written anywhere a citizen could find it without a guide and a lucky morning.",
    "I walked outside and stood on the steps until my hands unclenched. A man next to me was explaining the same maze to his mother in another language. We exchanged the tired smile of people who have been processed by a system that confuses friction with order.",
    "On the train home I drafted three furious emails and sent none of them. Rage wants an audience; usefulness wants a plan. I listed what I still need: the stamp, an earlier arrival, and a willingness to treat this like a quest with side missions instead of a referendum on my worth.",
    "I am logging the anger anyway. It is information. It says a process wasted my time and treated my day as disposable. Thursday I will go back with the right papers and a cooler head — but I will not gaslight myself into calling this inconvenience “no big deal.” It was a big deal to the hours I do not get back.",
];

/// Hope / nervous — first week in a new city.
const P_EN_NEW_CITY: &[&str] = &[
    "The moving van left at noon and the apartment still echoed. Boxes stacked like a skyline of decisions I have not unpacked. I sat on the floor with a cold sandwich and a map app open to “grocery near me,” feeling both free and slightly unmoored.",
    "I chose this city for a job and for a version of myself that wanted wider sidewalks and strangers who do not know my old nicknames. Ambition sounds clean in a cover letter. In an empty living room it sounds like a question: will I build a life here, or just rent space?",
    "Evening walk without destination. A bookstore with a bell on the door. A dog that sniffed my shoe like a welcome committee. I texted a friend back home a photo of a mural and received three heart emojis, which is not a community, but it is a thread.",
    "Sleep was thin. Sirens, unfamiliar pipes, the fridge’s unfamiliar hum. Loneliness at 2 a.m. is louder than daytime bravery. I wrote a list of small missions for tomorrow: find coffee, find a gym trial, introduce myself to one neighbor without oversharing.",
    "I am hopeful, not because everything is settled, but because nothing is finished. A new city is a blank page that still asks for sentences. Tonight I will stop expecting instant belonging and start collecting ordinary days until they stack into a home.",
];

/// Happy — surprise concert night.
const P_EN_CONCERT: &[&str] = &[
    "Alex covered my eyes in the lobby and only uncovered them when the marquee lit up with the band we swore we would see “someday.” Someday became tonight. I made a sound that embarrassed me and delighted me in equal measure.",
    "We stood near the back because tickets were last-minute miracles. The first song hit like a time machine: same chorus we blasted in a beat-up car at nineteen, same stupid harmony we never got right. I sang anyway. So did half the room.",
    "Between sets I looked at Alex’s face in the colored light and thought about how rare it is to be known and still surprised. Romance is not only anniversaries on calendars; sometimes it is someone tracking a tour date and keeping a secret for three weeks.",
    "The encore stretched longer than planned. Sweat, sore feet, a stranger’s shoulder bumping mine in shared joy. Outside, the night air felt sharper. We bought overpriced merch without debating the price, which is how you know a night has already paid for itself.",
    "Home after midnight, ears ringing, voice rough. I am writing this half-asleep because happiness evaporates if you only feel it. Pin this night: not productivity, not optimization — just two people choosing music over sleep and calling it a win.",
];

/// Angry — neighbor noise and ignored boundaries.
const P_EN_NEIGHBOR: &[&str] = &[
    "The bass started at 11:40 p.m. again. Not music so much as a physical event in the floorboards. I counted to one hundred, then two hundred, then put on shoes and walked upstairs with a politeness I did not feel.",
    "He opened the door mid-laugh, volume still high. I explained work starts early, walls are thin, this is the third week. He nodded the way people nod when they plan to forget. “Just one more hour,” he said, as if my sleep were a negotiable feature.",
    "Back downstairs I sat on the edge of the bed with my jaw clenched so hard it ached. Anger here is not dramatic; it is the slow burn of having your home stop feeling like a refuge. I hate that I practiced the conversation in my head like a performance review.",
    "I documented times, recorded a short clip for the building manager, and emailed the lease clause about quiet hours. Bureaucracy is a cold tool, but tools are what you use when goodwill fails. I do not want a feud. I want silence I paid rent for.",
    "Writing this so the anger becomes a plan instead of a night-long spiral. Tomorrow I follow up once, calmly. If nothing changes, I escalate. My boundaries are not optional etiquette. They are the difference between resting and resenting the place I live.",
];

/// Sad — anniversary of a loss.
const P_EN_GRIEF: &[&str] = &[
    "The calendar square looked ordinary until I remembered what it was. Three years since Dad died. No black clothes required by society anymore, which somehow makes the private weather worse — you carry a storm no one else scheduled.",
    "I made his coffee the way he liked it and left the second mug untouched on the counter. Rituals are ridiculous until they are the only bridge left. I played the jazz station he pretended not to love and cried into a dish towel like a person in a movie I would mock.",
    "Grief at year three is not the collapse of year one. It is a quiet ambush in grocery aisles when you see his brand of crackers. It is laughing at a joke and then feeling guilty for the laugh. It is missing advice you can almost hear but cannot verify.",
    "I walked to the river and told him about the job, about the apartment, about the plant I have somehow kept alive. People say the dead cannot hear. I do not need proof. I need a place to put the sentences that still have his name in them.",
    "Tonight I will not force cheer. I will light one candle, eat something warm, and go to bed early. Love does not end on a death date; it changes shape. This entry is a small room where that shape is allowed to sit without being rushed out the door.",
];

// ── More Vietnamese stories (batch 2) ───────────────────────────────────────

/// Nervous hope — first day at new company.
const P_VI_FIRST_DAY: &[&str] = &[
    "Tôi đến sớm hai mươi phút và vẫn sợ trễ. Thẻ ra vào mới cứng ngắc, logo lạ trên áo. Lễ tân mỉm cười quá chuyên nghiệp khiến tôi càng thấy mình là người ngoài. Cà phê trong ly giấy run nhẹ khi tôi cầm.",
    "Onboarding là một rừng tab: HR, IT, security training, channel Slack dài hơn timeline năm trước. Tôi gật liên tục, ghi chú lung tung, quên mất một nửa tên đồng nghiệp ngay sau khi bắt tay. Não tôi đang ở chế độ “đừng làm trò hề”.",
    "Trưa đồng nghiệp rủ đi ăn. Họ nói chuyện project như một ngôn ngữ riêng. Tôi cười đúng chỗ, hỏi vài câu an toàn, và thầm biết ơn vì không ai ép tôi phát biểu ngay ngày đầu. Cảm giác hy vọng trộn lo âu: mình sẽ thuộc về đây, hay chỉ là khách qua đường có hợp đồng?",
    "Chiều được assign ticket “easy win”. Tôi mở codebase và lạc ngay lập tức. Không sao — ngày đầu không phải ngày tỏa sáng. Ngày đầu là ngày còn mặt để hỏi. Tôi hỏi người mentor ba câu, rồi tự tra thêm hai giờ.",
    "Về nhà, giày còn bụi hành lang công ty mới. Tôi viết entry này để nhớ: mọi người từng là người mới. Ngày mai tôi sẽ nhớ tên ít nhất năm người. Không cần hoàn hảo — chỉ cần xuất hiện và học.",
];

/// Sad — ending a long relationship.
const P_VI_BREAKUP: &[&str] = &[
    "Chúng tôi nói chuyện ở quán cà phê quen, bàn góc, đúng chỗ từng hẹn hò năm năm trước. Lần này không có nắm tay dưới bàn. Chỉ có hai ly nguội và một câu ai cũng biết sẽ đến: “Có lẽ mình nên dừng.”",
    "Không có ai phản bội ầm ĩ. Chỉ có sự lệch nhịp tích tụ — việc, ước mơ, cách im lặng. Yêu thương vẫn còn, nhưng không đủ để khiêng cả hai về cùng một tương lai. Buồn kiểu này trong veo và nặng, như mang nước đầy mà không được đổ.",
    "Chia đồ mất cả buổi tối. Ai giữ nồi, ai giữ album. Những món nhỏ bất ngờ làm đau nhất: cái ly mẻ, tấm postcard du lịch. Tôi gói chúng cẩn thận như gói một giai đoạn, dù biết sẽ không mở lại sớm.",
    "Bạn bè nhắn “em ổn không?” Tôi trả lời “ổn” vì không muốn kể lại từ đầu. Sự thật là lồng ngực trống và mọi playlist đều thành bẫy. Tôi tắt nhạc, mở quạt, nằm nhìn trần nhà đến khuya.",
    "Viết ra không phải để kết án ai. Là để thừa nhận: kết thúc cũng là một hành động can đảm khi tiếp tục chỉ còn thói quen. Ngày mai tôi sẽ trả chìa khóa. Đêm nay tôi cho phép mình khóc mà không phải giải thích.",
];

/// Happy / gratitude — cooking for parents.
const P_VI_COOK_PARENTS: &[&str] = &[
    "Hôm nay tôi nấu đầy đủ mâm: canh, cá kho, rau xào, cơm. Mẹ ngồi ghế soi từng bước như monitors build. Ba thì chỉ hỏi “bao giờ ăn?” đúng phong cách đảm bảo chất lượng bằng đói.",
    "Tôi không phải đầu bếp. Có lúc cá hơi khê, canh hơi mặn. Mẹ vẫn khen “ngon”, đúng kiểu khen để tiếp sức. Ba gắp miếng cá, gật gù, rồi kể chuyện ngày xưa mẹ cũng cháy nồi lần đầu. Cả bàn cười. Không khí nhà bỗng rộng ra.",
    "Trong lúc rửa bát, tôi nhận ra hạnh phúc hôm nay không nằm ở món hoàn hảo. Nó nằm ở việc được phục vụ người đã phục vụ mình cả tuổi thơ — một sự đảo chiều nhỏ nhưng đủ làm mắt ướt.",
    "Sau bữa, ba bật radio cải lương nhỏ. Mẹ phơi đồ. Tôi ngồi bậc cửa uống nước lọc, nghe tiếng xe ngoài hẻm. Những ngày làm việc xa nhà khiến cảnh này trở thành xa xỉ. Hôm nay tôi có mặt. Vậy là đủ.",
    "Trước khi ngủ tôi ghi lại công thức cá kho của mẹ — không phải vì sợ quên gia vị, mà vì muốn giữ giọng mẹ trong từng bước. Mai phải về thành phố. Tối nay no bụng và no một thứ khác: cảm giác được là con trong ngôi nhà còn nguyên.",
];

/// Angry — late because of traffic chaos / bad planning around me.
const P_VI_TRAFFIC_ANGRY: &[&str] = &[
    "Cuộc họp khách hàng lúc 9:00. Lúc 8:55 tôi vẫn kẹt ở ngã tư, còi xe đầy tai, mồ hôi ướt áo dù máy lạnh bật tối đa. Tin nhắn “em đang trên đường” gửi đi trông như lời xin lỗi rẻ tiền.",
    "Không phải lần đầu thành phố này nuốt thời gian của tôi. Nhưng hôm nay cơn giận đặc biệt vì tôi đã xuất phát sớm, chọn tuyến “an toàn”, rồi vẫn bị một vụ ùn ứ không báo trước bẻ gãy kế hoạch. Cảm giác mất kiểm soát biến thành nóng trong họng.",
    "Vào phòng họp muộn mười hai phút. Nụ cười khách lịch sự đến mức tôi càng muốn biến mất. Đồng nghiệp liếc nhìn. Tôi trình bày vẫn rõ, nhưng trong đầu chỉ muốn đập nhẹ tay lái vào vô-lăng đã để ngoài bãi.",
    "Tan họp, tôi không về ngay bàn. Đi bộ một vòng cho nguội. Giận giao thông dễ thành giận cả ngày nếu không được đặt đúng chỗ. Tôi thở, uống nước, viết ba việc cần follow-up — lấy lại quyền điều khiển phần còn lại của ngày.",
    "Tối nay ghi lại để mai đặt lịch họp quan trọng muộn hơn giờ cao điểm, hoặc gọi video khi đường xấu. Cơn giận là tín hiệu hệ thống, không phải tính cách. Tôi không muốn biến thành người cáu bẳn chỉ vì đèn đỏ.",
];

/// Proud — public speaking went well.
const P_VI_SPEAKING: &[&str] = &[
    "Trước khi lên sân khấu tay tôi lạnh ngắt. Slide đã duyệt năm lần, nhưng não vẫn chạy kịch bản thảm họa: mic hỏng, quên lời, khán giả nhìn điện thoại. Tôi uống một ngụm nước và bước ra.",
    "Ba phút đầu giọng run. Rồi câu chuyện thật về lỗi production năm ngoái kéo được tiếng cười. Không khí phòng đổi. Tôi thấy mình không còn đọc slide — mình đang nói với người thật. Tự hào len vào từ từ, không ồn.",
    "Phần Q&A có câu hỏi khó. Tôi không giả vờ biết hết. Nói “em sẽ kiểm tra và trả lời sau” mà vẫn giữ được uy tín. Trước đây tôi nghĩ chuyên gia là người không bao giờ trống; giờ tôi nghĩ chuyên gia là người trung thực có cấu trúc.",
    "Sau sự kiện, hai bạn lạ lại cảm ơn vì “nói dễ hiểu”. Một tin nhắn từ sếp: “Good job.” Ngắn, nhưng đủ. Tôi ngồi trên taxi về, nhìn đèn đường, và mỉm cười một mình như người vừa hạ cánh an toàn.",
    "Entry này để tặng người hay trốn micro. Mình đã sợ, mình vẫn làm, và thế giới không sụp. Lần sau vẫn sẽ run — nhưng sẽ run với bằng chứng là mình từng đứng vững.",
];

/// Disappointed — failed professional cert exam.
const P_VI_CERT_FAIL: &[&str] = &[
    "Màn hình hiện “Did not pass” lúc 11:17. Tôi đọc lại như đọc sai ngôn ngữ. Hai tháng ôn, đề thi thử xanh lè, vậy mà hôm nay một cụm câu hỏi lạ đã kéo điểm xuống dưới chuẩn một khoảng nhỏ đến mức cay.",
    "Ra khỏi trung tâm thi, nắng gắt. Tôi không muốn gọi ai. Thất vọng với kết quả trộn với xấu hổ vô lý — như thể điểm thi là thước đo cả con người. Lý trí biết không phải vậy. Cảm xúc thì chưa kịp nghe lý trí.",
    "Về nhà, sổ ghi chép còn mở trang “exam day checklist.” Nhìn nó tôi muốn xé. Rồi thôi. Xé không biến trượt thành đậu. Tôi ghi ra những phần yếu: networking scenario, time management đoạn cuối. Đau nhưng hữu ích.",
    "Bạn nhắn “sao rồi?” Tôi gõ “trượt” rồi xóa, gõ lại “chưa đậu, sẽ thi lại.” Ngôn từ quan trọng. “Chưa” giữ cửa mở. Tối nay không ôn. Tối nay ăn gì đó ngon và không tự gọi mình là thất bại.",
    "Kỳ thi sau tám tuần nữa. Tôi đặt lịch như đặt hẹn với phiên bản biết đứng dậy. Thất vọng được phép ở lại một đêm. Từ ngày mai, nó phải nhường chỗ cho kế hoạch.",
];

/// Travel joy — Hội An lantern night.
const P_VI_HOIAN: &[&str] = &[
    "Hội An về đêm như bước vào postcard. Đèn lồng đỏ cam phản trên mặt sông Hoài. Tôi thuê xe đạp, đi chậm, không cần đích. Mùi bánh mì và gỗ cũ trộn trong gió mát.",
    "Ngồi thuyền thả hoa đăng cảm giác hơi du lịch công nghiệp, nhưng khi ngọn nến nhỏ trôi đi tôi vẫn im. Du lịch không phải lúc nào cũng cần “authentic tuyệt đối” — đôi khi chỉ cần một khoảnh khắc cho phép mình mềm lại.",
    "Ăn cao lầu ở quán nhỏ, bàn gỗ mòn. Chủ quán kể mùa mưa khách vắng. Tôi nghe, gật, trả thêm tiền tip vì câu chuyện chân thật hơn mọi review năm sao. Thành phố đẹp hơn khi có giọng người sống trong nó.",
    "Đêm khuya phố vắng dần. Tôi ngồi bờ sông viết vài dòng bằng điện thoại. Xa Sài Gòn không xóa deadline, nhưng đủ để nhớ mình còn là người biết ngạc nhiên trước ánh sáng trên mặt nước.",
    "Mai đi Mỹ Sơn sớm. Giày đã để sẵn. Tối nay ngủ trong nhà cổ, quạt trần kêu rè nhẹ. Tôi biết ơn vì còn đủ sức khỏe và tiền bạc cho một chuyến đi ngắn — đặc ân không phải ai cũng có, không nên coi là mặc định.",
];

/// Anxious — money tight before payday.
const P_VI_MONEY_ANXIETY: &[&str] = &[
    "Mở app ngân hàng lúc nửa đêm là thói quen xấu. Số dư đủ sống đến cuối tháng nếu không có sự cố. Não tôi thì chuyên dựng sự cố: xe hỏng, ốm, bạn vay. Lo âu tài chính không cần lý do lớn để vận hành.",
    "Tôi lập lại bảng chi tiêu dù đã thuộc. Cà phê bớt một nửa, ăn ngoài cắt, gói hàng “add to cart” rồi xóa. Kiểm soát nhỏ giúp thở được. Nhưng đằng sau là xấu hổ — như thể người lớn thật thì không bao giờ phải đếm từng khoản.",
    "Nói với người yêu sự thật: tháng này eo hẹp. Không diễn “em ổn.” Người ấy chỉ gật và rủ nấu ăn ở nhà. Sự nhẹ nhõm đến nhanh hơn khoản tiền vay. Được chia sẻ nỗi lo làm nó bớt sắc.",
    "Tôi biết đây không phải nghèo cùng cực. Vẫn có mái nhà, việc làm, cơm ăn. Vậy mà sợ vẫn thật. So sánh với người khó hơn không xóa được cảm giác bất an; nó chỉ thêm tội lỗi. Tôi chọn ghi nhận cảm xúc rồi tìm việc làm được.",
    "Cuối tuần sẽ nhận lương. Trước đó, tôi giữ kỷ luật và không dùng lo âu làm lý do mua sắm “cho đỡ buồn.” Entry này là lời nhắc: tiền quan trọng, nhưng nhân phẩm không gắn với số dư tạm thời trên app.",
];

/// Happy — cousin's wedding.
const P_VI_WEDDING: &[&str] = &[
    "Đám cưới em họ ở quê, sân rạp dựng giữa nắng. Tôi mặc áo hơi chật vì bận không thử trước. Nhạc mở lớn, trẻ con chạy, bàn tiệc đầy hộp khăn lạnh. Hỗn loạn theo kiểu chỉ có giỗ chạp và cưới mới có.",
    "Nhìn cô dâu bước ra, bà ngoại lau mắt. Tôi cũng ướt theo dù không định. Hạnh phúc tập thể có sức lây. Những người họ hàng cả năm không gặp ôm nhau như chưa từng bận rộn.",
    "Trong tiệc, hai người chú tranh luận bóng đá còn lớn hơn nhạc. Tôi ngồi với mấy em nhỏ, bóc bánh kẹo, nghe chúng kể trường lớp. Đám cưới đôi khi là cổng về nhà hơn là sự kiện của cặp đôi.",
    "Chụp ảnh tập thể loạn xạ. Ai cũng bảo “cười lên”, ai cũng chớp mắt. Tấm nào cũng hơi lệch và vì thế đáng giữ. Tôi gửi vài ảnh cho mẹ đang không về được. Mẹ thả tim liên tục.",
    "Về thành phố tối muộn, giày dính bụi sân. Tai còn vang nhạc đám cưới. Tôi viết trong xe khách: hôm nay nhắc tôi rằng gia đình dù lộn xộn vẫn là nơi mình được gọi tên từ nhỏ — và điều đó vẫn ấm.",
];

/// Neutral — argument then repair with partner.
const P_VI_REPAIR: &[&str] = &[
    "Cãi nhau bắt đầu từ chuyện rửa bát và kết thúc ở “em không bao giờ lắng nghe.” Cổ điển đến mức muốn cười, nếu không thì đang buồn. Cửa phòng khép. Căn hộ chật hơn bình thường.",
    "Một tiếng sau tôi gõ cửa, không phải vì đã thắng lý, mà vì im lặng đang trở thành vũ khí. Chúng tôi ngồi xuống sàn, lưng dựa tường, nói lại từ đầu — lần này chậm hơn, ít “luôn luôn” và “không bao giờ” hơn.",
    "Hóa ra cả hai đều mệt sau tuần làm việc dài. Cái bát chỉ là ngòi. Tôi xin lỗi vì giọng cao. Người ấy xin lỗi vì đóng cửa. Không có giải pháp điện ảnh. Chỉ có hai người chọn không để ego lớn hơn mối quan hệ.",
    "Đêm đó không có “make-up hoàn hảo.” Có bát được rửa chung và một tập phim dở. Đủ. Hòa giải đôi khi trông rất đời thường, và đó là dấu hiệu tốt.",
    "Tôi ghi lại để nhớ: xung đột không phải dấu chấm hết. Cách mình quay lại sau xung đột mới định nghĩa an toàn. Ngày mai vẫn sẽ có bát. Hy vọng sẽ có thêm kiên nhẫn.",
];

/// Sad — saying goodbye to childhood pet.
const P_VI_PET: &[&str] = &[
    "Phòng khám thú y sáng nay im hơn mọi khi. Múc nằm trong lồng mang, thở nông. Bác sĩ nói nhẹ, tôi gật như hiểu, dù tai chỉ nghe từng mảnh. Mười hai năm ối ăm — từ bé xíu đến già khụ.",
    "Quyết định “buông” không bao giờ cảm thấy đúng hoàn toàn. Chỉ cảm thấy bớt sai hơn so với bắt nó chịu thêm. Tôi xoa đầu nó, nói cảm ơn vì đã đợi tôi về mỗi tối, kể cả những ngày tôi về muộn và tâm trạng xấu.",
    "Về nhà, chén ăn vẫn ở góc bếp. Dây dắt vẫn treo. Căn hộ đầy khoảng trống hình con chó. Tôi ngồi xuống chỗ nó hay nằm và khóc một trận không kìm được. Buồn này trong sạch và dứt khoát.",
    "Bạn bè nói “nó sống vui.” Tôi biết. Vẫn muốn thêm một buổi sáng nữa nghe móng vuốt cào cửa. Mất mát nhỏ theo thước đo thế giới, nhưng lớn theo thước đo nhà tôi.",
    "Tối nay tôi cất đồ của Múc vào hộp, không phải để quên, mà để không vấp phải nỗi đau mỗi lần mở tủ. Sẽ có lúc nuôi tiếp — chưa phải bây giờ. Bây giờ chỉ cần thương nó cho trọn.",
];

/// Frustrated — mentorship moment when junior is blocked by process.
const P_VI_MENTOR: &[&str] = &[
    "Cậu junior gửi tin nhắn lúc 10 đêm: “anh ơi em bị stuck, access chưa có.” Tôi thở dài không phải vì cậu, mà vì quy trình mất ba ngày cho thứ lẽ ra xong trong một giờ. Cậu ấy hăng, hệ thống thì chậm.",
    "Sáng nay tôi ngồi pair, không phải để code thay, mà để chỉ cách hỏi đúng chỗ và ghi lại blocker. Nhìn cậu hiểu ra, tôi nhớ mình năm xưa cũng từng nghĩ mình kém khi thực ra môi trường đang ma sát.",
    "Buổi chiều access được cấp. Cậu merge PR đầu tiên, nhỏ thôi nhưng mắt sáng. Tôi tự hào kiểu lạ — không phải vì tôi giỏi, mà vì ai đó vừa được mở đường. Mentorship cho lại năng lượng khi công việc dễ thành máy móc.",
    "Trong standup tôi nêu lại bottleneck onboarding. Không chỉ trút giận; đề xuất checklist cụ thể. Có người gật, có người “để xem.” Thay đổi tổ chức chậm, nhưng im lặng thì chắc chắn không đổi.",
    "Tối viết entry này thay cho việc cuộn mạng. Nếu giữ được một việc có nghĩa trong tuần, đó là giúp người mới bớt tự nghi ngờ vì lỗi của hệ thống. Đó cũng là cách tôi muốn được đối xử.",
];

/// Peaceful — rainy Sunday reading.
const P_VI_RAIN_READ: &[&str] = &[
    "Trời mưa từ sáng, kiểu mưa không vội. Tôi pha trà, mở cửa sổ nhỏ, nghe nước chảy xuống mái tôn hàng xóm. Không lịch họp, không phải “tối ưu cuối tuần.” Chỉ có một cuốn sách và cái chăn.",
    "Đọc được bốn chương. Nhân vật làm một việc ngớ ngẩn và tôi bật cười một mình. Lâu rồi không có khoảng im ắng đủ dài để tiếng cười nhỏ đó nghe rõ. Hòa bình không cần núi rừng — đôi khi chỉ cần mưa và điện thoại để ở phòng khác.",
    "Trưa nấu mì trứng. Ăn chậm. Rửa chén ngay vì muốn giữ cảm giác gọn. Những việc nhà tầm thường trở nên dễ chịu khi không bị deadline nhìn từ phía sau.",
    "Chiều mưa nặng hơn. Tôi nằm dài, nghĩ về tuần tới mà không để nó chiếm hết chủ nhật. Ghi ra hai việc quan trọng thôi, rồi gập sổ. Phần còn lại để ngày mai.",
    "Đêm mưa vẫn còn. Tôi viết vài dòng biết ơn cho một ngày “không có gì xảy ra.” Trong một đời ồn, ngày không có gì xảy ra là thành tựu. Mai đường ướt, xe cộ loạn — nhưng tối nay êm.",
];

/// Angry / disappointed — small online scam.
const P_VI_SCAM: &[&str] = &[
    "Tôi chuyển tiền giữ chỗ cho “shop uy tín” trên mạng. Sau đó là im lặng. Tin nhắn đã gửi. Số điện thoại không nghe. Cảm giác bị lừa bắt đầu bằng phủ nhận: chắc họ bận, chắc hệ thống chậm.",
    "Hai ngày sau account biến mất. Số tiền không lớn so với lương, nhưng đủ để tôi giận chính mình. Tức kẻ lừa đảo, và tức vì đã bỏ qua vài tín hiệu đỏ chỉ vì giá hời. Xấu hổ trộn giận là hỗn hợp khó nuốt.",
    "Tôi báo cáo nền tảng, lưu bằng chứng, cảnh báo nhóm bạn. Không chắc lấy lại được tiền. Làm vậy để cơn giận có đường đi, thay vì biến thành nghi ngờ mọi người quanh mình.",
    "Tối nay đọc lại tin nhắn cũ. Thấy rõ thao túng: tạo gấp, khen khách, đẩy “chỉ còn một suất.” Bài học đắt cho một khóa học ngắn về tâm lý vội. Tôi không phải ngu — tôi đã bị thiết kế để vội.",
    "Mai sẽ gọi ngân hàng hỏi khả năng tra soát. Cũng sẽ không kể chuyện này như trò đùa tự giễu quá đà. Bị lừa là dữ kiện, không phải nhân phẩm. Giận được. Rồi siết lại quy tắc chi tiêu online và đi tiếp.",
];

/// Neutral hope — starting therapy / counseling (practical step, not celebration).
const P_VI_THERAPY: &[&str] = &[
    "Buổi counseling đầu tiên lúc 6 giờ chiều. Phòng nhỏ, hai ghế, một hộp khăn giấy đặt đúng chỗ khiến tôi vừa muốn cười vừa muốn khóc. Tôi nói lung tung mười phút đầu. Người ấy chỉ nghe.",
    "Không có khoảnh khắc “aha” điện ảnh. Có vài câu hỏi làm tôi im lâu. Im lặng trong therapy khác im lặng trong họp — nó không phạt. Nó chờ. Tôi nhận ra mình ít khi được chờ như thế.",
    "Ra về, đường tối, xe cộ vẫn ồn. Trong đầu nhẹ hơn một grad. Không phải hết vấn đề. Chỉ là vấn đề được đặt lên bàn thay vì mang một mình như balo không được tháo. Hy vọng lúc này rất thực dụng: “mình sẽ quay lại tuần sau.”",
    "Tôi từng nghĩ tìm giúp đỡ là yếu. Giờ nghĩ nó giống đi khám khi sốt — không anh hùng, không hèn, chỉ là chăm sóc. Nếu bạn đọc lại entry này lúc đang do dự, hãy coi đây là cái gật đầu từ một người cũng từng do dự.",
    "Đêm nay tôi không ép bản thân viết diary “sâu.” Chỉ ghi: đã đến, đã nói, đã đặt lịch. Những bước nhỏ vẫn là bước. Mai làm việc như bình thường, nhưng với thêm một đồng minh trong hành trình hiểu mình.",
];

/// Neutral/good — teaching niece to ride bike.
const P_VI_BIKE: &[&str] = &[
    "Cháu gái bảo “cô ơi cháu muốn bỏ bánh phụ.” Công viên chiều, gió nhẹ, đầu gối cháu đã có một vết xước cũ như huy hiệu. Tôi chạy theo xe, một tay giữ yên, vừa hụt hơi vừa la “đạp đều!”",
    "Lần ngã thứ hai cháu khóc. Tôi cũng muốn bỏ cuộc hộ cháu. Rồi cháu đứng dậy, lau mặt, bảo “còn một lần nữa.” Can đảm của trẻ làm người lớn xấu hổ theo kiểu đẹp. Tôi gật, nắm chắc hơn.",
    "Khi tôi buông tay mà xe vẫn đi, cả hai cùng hét. Không phải hét to trên mạng — hét thật ngoài đời, hơi ngố, rất vui. Một ông đi bộ quay lại cười. Buổi chiều bỗng thành lễ kỷ niệm nhỏ.",
    "Về nhà, cháu khoe mẹ trước cả khi cởi giày. Tôi uống nước, chân mỏi, ngực đầy. Tự hào lần này không gắn KPI. Chỉ là được chứng kiến ai đó vượt qua sợ hãi trong vòng nửa giờ.",
    "Tối viết vài dòng để giữ cái cảm giác nhẹ. Công việc tuần này vẫn rối. Nhưng trong đầu tôi có hình ảnh một chiếc xe đạp chạy thẳng và một đứa trẻ cười hở nướu. Đủ để cân lại vài email khó chịu.",
];

// ── Entries (40: 32 VI + 8 EN, ~120-day span) ───────────────────────────────

const ENTRIES: &[DemoEntry] = &[
    // 0 — VI proud / success (favorite, photos)
    DemoEntry {
        journal_index: 1,
        title: "Bấm deploy và thấy mình lớn hơn",
        paragraphs: P_VI_PROUD,
        day_offset: 0,
        emotion: "good",
        tag_names: &["demo", "work"],
        favorite: true,
        location: None,
        weather: Some("Clear · 31°C"),
        media: PHOTOS_2,
    },
    // 1 — EN success
    DemoEntry {
        journal_index: 1,
        title: "The offer finally came",
        paragraphs: P_EN_SUCCESS,
        day_offset: -1,
        emotion: "good",
        tag_names: &["work", "demo"],
        favorite: true,
        location: None,
        weather: Some("Sunny · 22°C"),
        media: PHOTOS_1,
    },
    // 2 — VI happy family
    DemoEntry {
        journal_index: 0,
        title: "Ba về nhà sau năm năm",
        paragraphs: P_VI_HAPPY,
        day_offset: -3,
        emotion: "good",
        tag_names: &["gia đình", "gratitude", "demo"],
        favorite: true,
        location: Some(DemoLocation {
            name: "Sân bay Tân Sơn Nhất, TP.HCM",
            lat: 10.8188,
            lng: 106.6519,
        }),
        weather: Some("Partly cloudy · 33°C"),
        media: PHOTOS_1,
    },
    // 3 — VI hope after rejection
    DemoEntry {
        journal_index: 0,
        title: "Email từ chối và chút hy vọng còn lại",
        paragraphs: P_VI_HOPE,
        day_offset: -5,
        emotion: "neutral",
        tag_names: &["work", "demo"],
        favorite: false,
        location: None,
        weather: None,
        media: NO_MEDIA,
    },
    // 4 — VI sad goodbye
    DemoEntry {
        journal_index: 0,
        title: "Tiễn bạn ra sân bay lúc mưa",
        paragraphs: P_VI_SAD,
        day_offset: -7,
        emotion: "bad",
        tag_names: &["demo"],
        favorite: false,
        location: Some(DemoLocation {
            name: "Sân bay Nội Bài, Hà Nội",
            lat: 21.2187,
            lng: 105.8042,
        }),
        weather: Some("Rain · 24°C"),
        media: PHOTOS_1,
    },
    // 5 — VI angry at work + file attach
    DemoEntry {
        journal_index: 1,
        title: "Slide mang tên người khác",
        paragraphs: P_VI_ANGRY,
        day_offset: -9,
        emotion: "bad",
        tag_names: &["work", "demo"],
        favorite: false,
        location: None,
        weather: None,
        media: PHOTOS_1_FILE,
    },
    // 6 — EN disappointed launch cancel
    DemoEntry {
        journal_index: 1,
        title: "They canceled the launch",
        paragraphs: P_EN_DISAPPOINTED,
        day_offset: -11,
        emotion: "bad",
        tag_names: &["work"],
        favorite: false,
        location: None,
        weather: None,
        media: NO_MEDIA,
    },
    // 7 — VI disappointed race
    DemoEntry {
        journal_index: 0,
        title: "Về đích chậm hơn kỳ vọng",
        paragraphs: P_VI_DISAPPOINTED,
        day_offset: -14,
        emotion: "bad",
        tag_names: &["sức khỏe", "demo"],
        favorite: false,
        location: Some(DemoLocation {
            name: "Phú Mỹ Hưng, TP.HCM",
            lat: 10.7292,
            lng: 106.7217,
        }),
        weather: Some("Cloudy · 29°C"),
        media: PHOTOS_1,
    },
    // 8 — VI success promotion
    DemoEntry {
        journal_index: 1,
        title: "Được thăng cấp một cách bất ngờ",
        paragraphs: P_VI_SUCCESS,
        day_offset: -16,
        emotion: "good",
        tag_names: &["work", "gratitude"],
        favorite: true,
        location: None,
        weather: None,
        media: PHOTOS_1,
    },
    // 9 — EN happy dinner friends
    DemoEntry {
        journal_index: 0,
        title: "Dinner that folded the years",
        paragraphs: P_EN_HAPPY,
        day_offset: -18,
        emotion: "good",
        tag_names: &["gratitude", "demo"],
        favorite: true,
        location: None,
        weather: Some("Clear · 18°C"),
        media: PHOTOS_1,
    },
    // 10 — VI gratitude ordinary day
    DemoEntry {
        journal_index: 0,
        title: "Biết ơn những điều nhỏ không ồn ào",
        paragraphs: P_VI_GRATITUDE,
        day_offset: -21,
        emotion: "good",
        tag_names: &["gratitude", "demo"],
        favorite: false,
        location: None,
        weather: Some("Rain · 27°C"),
        media: PHOTOS_1,
    },
    // 11 — VI anxious hospital
    DemoEntry {
        journal_index: 0,
        title: "Ngồi hành lang bệnh viện chờ kết quả",
        paragraphs: P_VI_ANXIOUS,
        day_offset: -24,
        emotion: "neutral",
        tag_names: &["sức khỏe", "demo"],
        favorite: false,
        location: None,
        weather: None,
        media: NO_MEDIA,
    },
    // 12 — VI travel Đà Nẵng + photo
    DemoEntry {
        journal_index: 2,
        title: "Sáng sớm một mình ở Đà Nẵng",
        paragraphs: P_VI_TRAVEL_DN,
        day_offset: -28,
        emotion: "good",
        tag_names: &["travel", "sức khỏe"],
        favorite: false,
        location: Some(DemoLocation {
            name: "Bãi biển Mỹ Khê, Đà Nẵng",
            lat: 16.0598,
            lng: 108.2487,
        }),
        weather: Some("Sunny · 30°C"),
        media: PHOTOS_2,
    },
    // 13 — VI lonely
    DemoEntry {
        journal_index: 0,
        title: "Căn hộ rộng sau khi bạn cùng phòng chuyển đi",
        paragraphs: P_VI_LONELY,
        day_offset: -32,
        emotion: "bad",
        tag_names: &["demo"],
        favorite: false,
        location: None,
        weather: None,
        media: NO_MEDIA,
    },
    // 14 — VI peaceful morning
    DemoEntry {
        journal_index: 0,
        title: "Buổi sáng giữ lại cho mình",
        paragraphs: P_VI_PEACEFUL,
        day_offset: -36,
        emotion: "good",
        tag_names: &["gratitude", "sức khỏe"],
        favorite: false,
        location: None,
        weather: Some("Clear · 26°C"),
        media: PHOTOS_1,
    },
    // 15 — VI frustrated work
    DemoEntry {
        journal_index: 1,
        title: "Sprint đỏ và cơn bực cần được viết ra",
        paragraphs: P_VI_FRUSTRATED,
        day_offset: -40,
        emotion: "bad",
        tag_names: &["work", "demo"],
        favorite: false,
        location: None,
        weather: None,
        media: NO_MEDIA,
    },
    // 16 — EN angry bureaucracy
    DemoEntry {
        journal_index: 0,
        title: "Four hours for the wrong stamp",
        paragraphs: P_EN_ANGRY,
        day_offset: -44,
        emotion: "bad",
        tag_names: &["demo"],
        favorite: false,
        location: None,
        weather: Some("Overcast · 16°C"),
        media: NO_MEDIA,
    },
    // 17 — VI proud of sibling + audio
    DemoEntry {
        journal_index: 0,
        title: "Em gái được học bổng",
        paragraphs: P_VI_PROUD_FAMILY,
        day_offset: -48,
        emotion: "good",
        tag_names: &["gia đình", "gratitude"],
        favorite: true,
        location: None,
        weather: None,
        media: PHOTOS_1_AUDIO,
    },
    // 18 — VI recovery burnout
    DemoEntry {
        journal_index: 0,
        title: "Mười ngày không mang việc về sau 7 giờ tối",
        paragraphs: P_VI_RECOVERY,
        day_offset: -54,
        emotion: "good",
        tag_names: &["sức khỏe", "demo"],
        favorite: false,
        location: None,
        weather: None,
        media: NO_MEDIA,
    },
    // 19 — VI Hanoi travel nostalgia
    DemoEntry {
        journal_index: 2,
        title: "Trà đá vỉa hè và phố cũ Hà Nội",
        paragraphs: P_VI_HANOI,
        day_offset: -60,
        emotion: "neutral",
        tag_names: &["travel", "demo"],
        favorite: false,
        location: Some(DemoLocation {
            name: "Hồ Hoàn Kiếm, Hà Nội",
            lat: 21.0285,
            lng: 105.8542,
        }),
        weather: Some("Cool · 22°C"),
        media: PHOTOS_1,
    },
    // 20 — VI first day new job
    DemoEntry {
        journal_index: 1,
        title: "Ngày đầu ở công ty mới",
        paragraphs: P_VI_FIRST_DAY,
        day_offset: -63,
        emotion: "neutral",
        tag_names: &["work", "demo"],
        favorite: false,
        location: None,
        weather: Some("Cloudy · 30°C"),
        media: PHOTOS_1,
    },
    // 21 — EN new city
    DemoEntry {
        journal_index: 2,
        title: "Boxes and a new skyline",
        paragraphs: P_EN_NEW_CITY,
        day_offset: -66,
        emotion: "neutral",
        tag_names: &["travel", "demo"],
        favorite: false,
        location: Some(DemoLocation {
            name: "Portland, Oregon",
            lat: 45.5152,
            lng: -122.6784,
        }),
        weather: Some("Drizzle · 12°C"),
        media: PHOTOS_1,
    },
    // 22 — VI breakup
    DemoEntry {
        journal_index: 0,
        title: "Ly cà phê nguội và một lời kết thúc",
        paragraphs: P_VI_BREAKUP,
        day_offset: -69,
        emotion: "bad",
        tag_names: &["demo"],
        favorite: false,
        location: None,
        weather: None,
        media: NO_MEDIA,
    },
    // 23 — VI cook for parents
    DemoEntry {
        journal_index: 0,
        title: "Nấu một mâm cơm cho ba mẹ",
        paragraphs: P_VI_COOK_PARENTS,
        day_offset: -72,
        emotion: "good",
        tag_names: &["gia đình", "gratitude"],
        favorite: true,
        location: None,
        weather: Some("Clear · 28°C"),
        media: PHOTOS_1,
    },
    // 24 — EN concert happy
    DemoEntry {
        journal_index: 0,
        title: "Someday became tonight",
        paragraphs: P_EN_CONCERT,
        day_offset: -75,
        emotion: "good",
        tag_names: &["gratitude", "demo"],
        favorite: true,
        location: Some(DemoLocation {
            name: "Fillmore, San Francisco",
            lat: 37.7840,
            lng: -122.4330,
        }),
        weather: None,
        media: PHOTOS_1,
    },
    // 25 — VI traffic angry
    DemoEntry {
        journal_index: 1,
        title: "Kẹt xe và mười hai phút muộn",
        paragraphs: P_VI_TRAFFIC_ANGRY,
        day_offset: -78,
        emotion: "bad",
        tag_names: &["work", "demo"],
        favorite: false,
        location: Some(DemoLocation {
            name: "Quận 1, TP.HCM",
            lat: 10.7769,
            lng: 106.7009,
        }),
        weather: Some("Hot · 34°C"),
        media: PHOTOS_1,
    },
    // 26 — VI public speaking proud
    DemoEntry {
        journal_index: 1,
        title: "Lên sân khấu dù tay lạnh ngắt",
        paragraphs: P_VI_SPEAKING,
        day_offset: -81,
        emotion: "good",
        tag_names: &["work", "demo"],
        favorite: false,
        location: None,
        weather: None,
        media: PHOTOS_1_FILE,
    },
    // 27 — EN neighbor angry
    DemoEntry {
        journal_index: 0,
        title: "Bass through the floorboards again",
        paragraphs: P_EN_NEIGHBOR,
        day_offset: -84,
        emotion: "bad",
        tag_names: &["demo"],
        favorite: false,
        location: None,
        weather: None,
        media: NO_MEDIA,
    },
    // 28 — VI cert fail disappointed
    DemoEntry {
        journal_index: 1,
        title: "Màn hình hiện Did not pass",
        paragraphs: P_VI_CERT_FAIL,
        day_offset: -87,
        emotion: "bad",
        tag_names: &["work", "demo"],
        favorite: false,
        location: None,
        weather: Some("Sunny · 32°C"),
        media: PHOTOS_1,
    },
    // 29 — VI Hội An travel
    DemoEntry {
        journal_index: 2,
        title: "Đèn lồng trên sông Hoài",
        paragraphs: P_VI_HOIAN,
        day_offset: -90,
        emotion: "good",
        tag_names: &["travel", "gratitude"],
        favorite: false,
        location: Some(DemoLocation {
            name: "Phố cổ Hội An",
            lat: 15.8801,
            lng: 108.3380,
        }),
        weather: Some("Warm · 27°C"),
        media: PHOTOS_2,
    },
    // 30 — VI money anxiety
    DemoEntry {
        journal_index: 0,
        title: "Mở app ngân hàng lúc nửa đêm",
        paragraphs: P_VI_MONEY_ANXIETY,
        day_offset: -93,
        emotion: "bad",
        tag_names: &["demo"],
        favorite: false,
        location: None,
        weather: None,
        media: NO_MEDIA,
    },
    // 31 — VI wedding happy
    DemoEntry {
        journal_index: 0,
        title: "Đám cưới em họ ở quê",
        paragraphs: P_VI_WEDDING,
        day_offset: -96,
        emotion: "good",
        tag_names: &["gia đình", "demo"],
        favorite: true,
        location: None,
        weather: Some("Sunny · 33°C"),
        media: PHOTOS_2,
    },
    // 32 — EN grief
    DemoEntry {
        journal_index: 0,
        title: "Three years on a plain calendar square",
        paragraphs: P_EN_GRIEF,
        day_offset: -99,
        emotion: "bad",
        tag_names: &["gratitude", "demo"],
        favorite: false,
        location: None,
        weather: Some("Grey · 10°C"),
        media: PHOTOS_1,
    },
    // 33 — VI repair after argument
    DemoEntry {
        journal_index: 0,
        title: "Cãi nhau vì bát đĩa rồi ngồi xuống sàn",
        paragraphs: P_VI_REPAIR,
        day_offset: -102,
        emotion: "neutral",
        tag_names: &["gia đình", "demo"],
        favorite: false,
        location: None,
        weather: None,
        media: NO_MEDIA,
    },
    // 34 — VI pet goodbye
    DemoEntry {
        journal_index: 0,
        title: "Tạm biệt Múc sau mười hai năm",
        paragraphs: P_VI_PET,
        day_offset: -105,
        emotion: "bad",
        tag_names: &["gia đình", "demo"],
        favorite: false,
        location: None,
        weather: None,
        media: PHOTOS_1,
    },
    // 35 — VI mentor proud
    DemoEntry {
        journal_index: 1,
        title: "PR đầu tiên của cậu junior",
        paragraphs: P_VI_MENTOR,
        day_offset: -108,
        emotion: "good",
        tag_names: &["work", "gratitude"],
        favorite: false,
        location: None,
        weather: None,
        media: PHOTOS_1,
    },
    // 36 — VI rainy reading peaceful
    DemoEntry {
        journal_index: 0,
        title: "Chủ nhật mưa và một cuốn sách",
        paragraphs: P_VI_RAIN_READ,
        day_offset: -111,
        emotion: "good",
        tag_names: &["gratitude", "demo"],
        favorite: false,
        location: None,
        weather: Some("Rain · 25°C"),
        media: PHOTOS_1,
    },
    // 37 — VI scam angry
    DemoEntry {
        journal_index: 0,
        title: "Bị lừa một khoản nhỏ trên mạng",
        paragraphs: P_VI_SCAM,
        day_offset: -114,
        emotion: "bad",
        tag_names: &["demo"],
        favorite: false,
        location: None,
        weather: None,
        media: NO_MEDIA,
    },
    // 38 — VI therapy: cautious hope after first session (not celebration)
    DemoEntry {
        journal_index: 0,
        title: "Buổi counseling đầu tiên",
        paragraphs: P_VI_THERAPY,
        day_offset: -117,
        emotion: "neutral",
        tag_names: &["sức khỏe", "demo"],
        favorite: false,
        location: None,
        weather: None,
        media: PHOTOS_1_AUDIO,
    },
    // 39 — VI bike with niece
    DemoEntry {
        journal_index: 0,
        title: "Cháu bỏ bánh phụ ở công viên",
        paragraphs: P_VI_BIKE,
        day_offset: -120,
        emotion: "good",
        tag_names: &["gia đình", "gratitude"],
        favorite: true,
        location: Some(DemoLocation {
            name: "Công viên 23/9, TP.HCM",
            lat: 10.7690,
            lng: 106.6900,
        }),
        weather: Some("Breezy · 29°C"),
        media: PHOTOS_1,
    },
];

// ── Public API ──────────────────────────────────────────────────────────────

/// Demo journals (`[Demo]` prefix in names). Length is always 3.
pub fn demo_journals() -> &'static [DemoJournal] {
    JOURNALS
}

/// Demo tags (mixed EN/VI names).
pub fn demo_tags() -> &'static [DemoTag] {
    TAGS
}

/// Demo entries spanning roughly 120 days of day offsets (40 curated stories).
pub fn demo_entries() -> &'static [DemoEntry] {
    ENTRIES
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Rough heuristic: body has Vietnamese diacritics common in VI prose.
    fn has_vietnamese_diacritics(s: &str) -> bool {
        s.chars().any(|c| {
            matches!(
                c,
                'ă' | 'â'
                    | 'ê'
                    | 'ô'
                    | 'ơ'
                    | 'ư'
                    | 'đ'
                    | 'Ă'
                    | 'Â'
                    | 'Ê'
                    | 'Ô'
                    | 'Ơ'
                    | 'Ư'
                    | 'Đ'
                    | 'á'
                    | 'à'
                    | 'ả'
                    | 'ã'
                    | 'ạ'
                    | 'é'
                    | 'è'
                    | 'ẻ'
                    | 'ẽ'
                    | 'ẹ'
                    | 'í'
                    | 'ì'
                    | 'ỉ'
                    | 'ĩ'
                    | 'ị'
                    | 'ó'
                    | 'ò'
                    | 'ỏ'
                    | 'õ'
                    | 'ọ'
                    | 'ú'
                    | 'ù'
                    | 'ủ'
                    | 'ũ'
                    | 'ụ'
                    | 'ý'
                    | 'ỳ'
                    | 'ỷ'
                    | 'ỹ'
                    | 'ỵ'
            )
        })
    }

    /// Latin-heavy EN: mostly ASCII letters/spaces, no VI diacritics.
    fn looks_english_body(s: &str) -> bool {
        if has_vietnamese_diacritics(s) {
            return false;
        }
        let letters: Vec<char> = s.chars().filter(|c| c.is_alphabetic()).collect();
        if letters.is_empty() {
            return false;
        }
        let ascii_letters = letters.iter().filter(|c| c.is_ascii_alphabetic()).count();
        ascii_letters * 100 / letters.len() >= 90
    }

    fn entry_body(e: &DemoEntry) -> String {
        e.paragraphs.join("\n")
    }

    fn is_vietnamese_entry(e: &DemoEntry) -> bool {
        has_vietnamese_diacritics(&entry_body(e)) || has_vietnamese_diacritics(e.title)
    }

    fn is_english_entry(e: &DemoEntry) -> bool {
        looks_english_body(&entry_body(e)) && !has_vietnamese_diacritics(e.title)
    }

    #[test]
    fn entry_count_is_forty() {
        let n = demo_entries().len();
        assert_eq!(n, 40, "expected exactly 40 seed entries, got {n}");
    }

    #[test]
    fn journal_count_is_three() {
        assert_eq!(demo_journals().len(), 3);
        for j in demo_journals() {
            assert!(
                j.name.contains("[Demo]"),
                "journal name must contain [Demo]: {}",
                j.name
            );
        }
    }

    #[test]
    fn language_split_about_80_vi_20_en() {
        let entries = demo_entries();
        let n = entries.len();
        let vi = entries.iter().filter(|e| is_vietnamese_entry(e)).count();
        let en = entries.iter().filter(|e| is_english_entry(e)).count();
        assert_eq!(
            vi + en,
            n,
            "every entry must classify as VI or EN (vi={vi}, en={en}, n={n})"
        );
        // ~80% VI: allow 70–90% so small catalog size changes stay valid.
        let vi_pct = vi * 100 / n;
        assert!(
            (70..=90).contains(&vi_pct),
            "expected ~80% Vietnamese entries, got {vi_pct}% ({vi}/{n})"
        );
        let en_pct = en * 100 / n;
        assert!(
            (10..=30).contains(&en_pct),
            "expected ~20% English entries, got {en_pct}% ({en}/{n})"
        );
    }

    #[test]
    fn each_entry_has_at_least_five_paragraphs() {
        for e in demo_entries() {
            assert!(
                e.paragraphs.len() >= 5,
                "entry {:?} has {} paragraphs, need ≥5",
                e.title,
                e.paragraphs.len()
            );
            for p in e.paragraphs {
                assert!(
                    p.trim().len() >= 40,
                    "paragraph too short in {:?}: {:?}",
                    e.title,
                    &p[..p.len().min(60)]
                );
            }
        }
    }

    #[test]
    fn every_entry_has_valid_emotion_matching_arc() {
        let mut good = 0usize;
        let mut neutral = 0usize;
        let mut bad = 0usize;
        for e in demo_entries() {
            match e.emotion {
                "good" => good += 1,
                "neutral" => neutral += 1,
                "bad" => bad += 1,
                other => panic!("invalid emotion {other:?} on entry {}", e.title),
            }
        }
        let n = demo_entries().len();
        assert_eq!(
            good + neutral + bad,
            n,
            "every entry must have good|neutral|bad (good={good}, neutral={neutral}, bad={bad}, n={n})"
        );
        assert!(good >= 3, "expected several good entries, got {good}");
        assert!(neutral >= 1, "expected ≥1 neutral, got {neutral}");
        assert!(bad >= 3, "expected several bad entries, got {bad}");
    }

    /// Spot-check that curated emotions follow the story, not a random rotation.
    #[test]
    fn emotion_matches_known_story_arcs() {
        let by_title: std::collections::HashMap<&str, &str> = demo_entries()
            .iter()
            .map(|e| (e.title, e.emotion))
            .collect();

        // Celebratory / proud / happy arcs → good
        assert_eq!(by_title["Bấm deploy và thấy mình lớn hơn"], "good");
        assert_eq!(by_title["The offer finally came"], "good");
        assert_eq!(by_title["Ba về nhà sau năm năm"], "good");
        assert_eq!(by_title["Em gái được học bổng"], "good");
        assert_eq!(by_title["Cháu bỏ bánh phụ ở công viên"], "good");

        // Loss / anger / failure arcs → bad
        assert_eq!(by_title["Tiễn bạn ra sân bay lúc mưa"], "bad");
        assert_eq!(by_title["Slide mang tên người khác"], "bad");
        assert_eq!(by_title["They canceled the launch"], "bad");
        assert_eq!(by_title["Tạm biệt Múc sau mười hai năm"], "bad");
        assert_eq!(by_title["Three years on a plain calendar square"], "bad");

        // Mixed / waiting / bittersweet arcs → neutral
        assert_eq!(by_title["Email từ chối và chút hy vọng còn lại"], "neutral");
        assert_eq!(by_title["Ngồi hành lang bệnh viện chờ kết quả"], "neutral");
        assert_eq!(
            by_title["Cãi nhau vì bát đĩa rồi ngồi xuống sàn"],
            "neutral"
        );
        assert_eq!(by_title["Boxes and a new skyline"], "neutral");
    }

    #[test]
    fn has_favorite_and_media_plans() {
        let entries = demo_entries();
        assert!(
            entries.iter().any(|e| e.favorite),
            "expected at least one favorite"
        );
        assert!(
            entries.iter().any(|e| e.media.inline_photos > 0),
            "expected inline_photos > 0"
        );
        let with_photos = entries.iter().filter(|e| e.media.inline_photos > 0).count();
        let pct = with_photos * 100 / entries.len();
        assert!(
            pct > 60,
            "expected >60% entries with photos, got {pct}% ({with_photos}/{})",
            entries.len()
        );
        assert!(
            entries.iter().any(|e| e.media.attach_audio),
            "expected attach_audio"
        );
        assert!(
            entries.iter().any(|e| e.media.attach_file),
            "expected attach_file"
        );
        assert!(
            entries.iter().any(|e| e.location.is_some()),
            "expected at least one location"
        );
        assert!(
            entries.iter().any(|e| e.weather.is_some()),
            "expected at least one weather"
        );
    }

    #[test]
    fn journal_indices_in_range() {
        let n = demo_journals().len();
        for e in demo_entries() {
            assert!(
                e.journal_index < n,
                "journal_index {} out of range for {}",
                e.journal_index,
                e.title
            );
        }
    }

    #[test]
    fn day_offset_spans_about_120_days() {
        let entries = demo_entries();
        let min = entries.iter().map(|e| e.day_offset).min().unwrap();
        let max = entries.iter().map(|e| e.day_offset).max().unwrap();
        let span = max - min;
        assert!(
            span >= 100,
            "day_offset span should be >= 100 days, got {span} (min={min}, max={max})"
        );
    }

    #[test]
    fn tag_refs_exist_in_catalog() {
        let tag_set: std::collections::HashSet<&str> = demo_tags().iter().map(|t| t.name).collect();
        for e in demo_entries() {
            for name in e.tag_names {
                assert!(
                    tag_set.contains(name),
                    "entry {} references unknown tag {name}",
                    e.title
                );
            }
        }
    }

    #[test]
    fn entries_have_nonempty_paragraphs() {
        for e in demo_entries() {
            assert!(
                !e.paragraphs.is_empty(),
                "entry {} has no paragraphs",
                e.title
            );
            for p in e.paragraphs {
                assert!(!p.trim().is_empty(), "empty paragraph in {}", e.title);
            }
        }
    }

    #[test]
    fn titles_are_meaningful_and_unique() {
        let mut seen = std::collections::HashSet::new();
        for e in demo_entries() {
            assert!(
                e.title.chars().count() >= 8,
                "title too short: {:?}",
                e.title
            );
            assert!(
                seen.insert(e.title),
                "duplicate title in catalog: {:?}",
                e.title
            );
        }
    }
}
