---
name: camera-grammar
description: 专业镜头语法词表与「何时用」— 官方 MiniMax H3 分镜表规范 + 社区 152★ Claude Skill（景别/角度/运镜/Drone）+ JZL 镜头规则包口径。写 video_prompt / video_prompt_full_ref 的机位句时从这里取词与选型；不改变主 skill 的产出契约。
---

> **火宝短剧流水线接入说明**：本技能**对所有题材生效**（与 `xianxia-cinematic-video-director` 那份不同 —— 那份带题材门控）；与主 skill `video-prompt` 的硬规则冲突时**以主 skill 为准**（主 skill 管：六段式格式、切镜数、物理/常识行、LoRA key 词、声音、站位、`extreme close-up` → `close-up` 降级）。本文件只提供**词表与选型（何时用）**，不新增产出契约。
> 搬运方式：下面 **A / B / C 三节 = `Rylaispirit/cinematic-video-prompt-skill` 的 `references/01-camera-angles-and-movement.md` 原样照搬**（含越南语解释列，一列没删，方便回查原仓库）；**D–H 是引用式摘录**，每条带 file:line 出处。
> **生效路径 = 注入，不是按需拉**：本 Agent（`prompt_generator`）1019 已摘掉 workspace 文件工具与 `read_prompt_library`，读不到任何 `references/*.md`；本文件靠 `AGENT_SKILL_MAP` 的前缀匹配整份注入（`backend/src/agents/skills.ts:132-134` 原话「目录自身及其子目录下所有 SKILL.md 都会注入…设置页新建的子技能无需改代码即可生效」）。

**用法（三步）**：① 先问「这一镜要给观众什么」，在 **C（功能分组）** 与 **D（官方逐秒规范）** 里定功能；② 回 **B1/B2/B3** 挑具体那条 Golden Prompt；③ 写进句子时必须**三件齐**（类型 ＋ `with small|large amplitude` ＋ `at slow|fast speed`）**并写成它在画面里的效果**（哪件地标从哪儿移到哪儿，见 D 的 `:64` 例句）。**一镜一条运镜，不叠加。**
# Camera Angles & Camera Movement — Góc máy & Chuyển động máy

Tham chiếu đầy đủ. SKILL.md chỉ giữ bản rút gọn; tra file này khi cần góc máy hoặc cú máy đặc biệt.

## A. Góc máy & cỡ cảnh (Angles & Shot Sizes)

| Prompt (EN) | Giải thích (VI) |
|---|---|
| Extreme Close-up (Detail Focus) | Siêu cận, tập trung vào chi tiết rất nhỏ (mắt, vân tay), nhấn kết cấu |
| Macro Angle (Texture Focus) | Siêu cận, nhấn kết cấu bề mặt vật thể |
| Pushed-in Close-up | Cận cảnh như máy đang được đẩy sát vào mặt, tạo căng thẳng |
| The Reaction Shot (Close Up) | Cận gương mặt/cử chỉ để bắt phản ứng cảm xúc |
| Medium Close Up (MCU) | Từ vai trở lên, tập trung biểu cảm |
| Full Body Shot | Bao trọn toàn thân từ đầu đến chân |
| Extreme Long Shot (ELS) / Distant View | Cực xa, con người chỉ là chấm nhỏ, nhấn sự bao la |
| Extreme Wide Shot (Small Subject) | Cực rộng, chủ thể nhỏ bé cô độc |
| Panoramic View | Góc rộng bao quát không gian lớn, phong cảnh |
| Eye-Level Shot (Neutral Perspective) | Ngang tầm mắt, trực tiếp, tự nhiên, trung lập |
| Shoulder-Level Shot | Ngang vai, hơi cao hơn tầm mắt |
| Hip-Level Shot | Ngang hông, nhấn trang phục hoặc bối cảnh |
| High Angle (Dominating View) | Máy cao nhìn xuống, chủ thể nhỏ bé, dễ bị kiểm soát |
| Elevated Shot | Cao hơn tầm mắt nhưng chưa tới High Angle, bao quát nhóm người |
| Low Angle (Empowering View) | Máy thấp nhìn lên, chủ thể mạnh mẽ, quyền lực |
| The Hero Shot (Low Angle) | Góc thấp căn chỉnh để tôn vinh sức mạnh chủ thể |
| Subjective Low Angle | Góc thấp mô phỏng nhân vật đang nhìn lên vật lớn hơn |
| Worm's-eye View (Ground Level) | Từ sát đất hất thẳng lên, chủ thể vĩ đại, thường kèm bầu trời kịch tính |
| Floor Angle | Cực thấp sát sàn, không gian quanh chủ thể trông rộng lớn |
| Extreme Low Angle (Ground Haze) | Cực thấp sát đất, thêm mờ nhẹ tiền cảnh gần ống kính |
| Bird's-eye View (Directly Overhead) | Thẳng từ trên cao xuống, cảnh vật thành hình khối phẳng |
| Overhead Flat Lay | Thẳng từ trên xuống bề mặt phẳng, ẩm thực / sắp xếp vật phẩm |
| Overhead (Symmetrical Pattern) | Thẳng đứng từ trên, nhấn hoa văn / hình đối xứng trên mặt đất |
| Overhead (Looking Down on a Group) | Từ trên nhìn xuống nhóm người, nhấn quan hệ không gian |
| High Angle (Overhead Pattern) | Góc cao làm nổi sự lặp lại của hoa văn dưới đất |
| Ceiling Angle (Looking Down) | Nhìn xuống từ trần nhà, cảm giác giám sát |
| Drone View (Low Altitude) | Từ trên cao nhưng gần chủ thể, cảm giác bay lượn |
| Aerial View | Góc nhìn từ trên không |
| Canted Angle / Dutch Tilt | Máy nghiêng, chân trời lệch, bất ổn hoặc kịch tính |
| Oblique Angle | Nghiêng nhẹ hơn Dutch Tilt, hơi lén lút |
| Three-Quarter View | Nghiêng 45°, góc nịnh mắt nhất cho chân dung |
| Side Profile Shot (90 Degree Angle) | Chụp thẳng từ một bên, đường nét hồ sơ |
| Reverse Profile Shot | Từ bên cạnh hơi xoay về sau, thấy gáy và một phần mặt, bí ẩn |
| Profile View (Action) | Nghiêng nhưng cơ thể đang hành động |
| Over-the-Shoulder | Qua vai nhân vật, dùng cho đối thoại |
| P.O.V (Point of View) | Góc nhìn thứ nhất qua mắt nhân vật |
| P.O.V (Object Perspective) | Góc nhìn của một vật thể (từ trong cốc cà phê, dưới gầm xe) |
| Counter-Angle | Góc đối diện với góc đã thiết lập, đối chiếu điểm nhìn |
| Low Horizon Line (Emphasize Sky) | Chân trời rất thấp, bầu trời rộng lớn |
| High Horizon Line (Emphasize Ground) | Chân trời rất cao, nhấn mặt đất/tiền cảnh |
| Centered Composition (Angle Neutral) | Trực diện, trung tính, chủ thể chính giữa |
| Off-Center Subject Placement | Chủ thể lệch khỏi trung tâm có chủ đích |
| Foreground View (Intense) | Tập trung vật tiền cảnh rất gần, bị phóng đại |
| Wide Angle (Intimate View) | Góc rộng đặt rất gần chủ thể, thân mật, méo nhẹ |
| Near-Far Juxtaposition | Vật rất gần + vật rất xa, tiêu cự rộng nhấn chênh lệch |
| Forced Perspective | Sắp đặt để vật xa trông gần/nhỏ hơn thực tế, ảo giác kích thước |
| Split Diopter Shot | Cả tiền cảnh và hậu cảnh ở khoảng cách khác nhau đều nét |
| Deep Focus (Compositional Angle) | Mọi thứ từ tiền cảnh đến hậu cảnh đều nét |
| Shallow Focus (Compositional Angle) | Chỉ chủ thể nét, mọi thứ khác nhòe |
| Point of Focus (Isolated Background) | Nét vào chủ thể ở khoảng cách cụ thể, nền và tiền cảnh nhòe hoàn toàn |
| Infinity Focus | Lấy nét vô cực, mọi thứ từ một điểm trở đi đều nét |
| Through the Keyhole/Peephole Angle | Nhìn qua lỗ nhỏ, khung bị chặn, mờ viền |
| Looking Down Through Glass | Nhìn xuyên bề mặt trong suốt xuống chủ thể, có phản chiếu/khúc xạ |
| Shelf Angle | Ngay trên cao hướng xuống nhóm vật trên kệ/bàn, tĩnh vật |
| Cross-Section Angle | Cắt ngang vật thể, thấy cấu trúc bên trong |
| Verticality Emphasis | Nhấn đường thẳng đứng (nhà chọc trời, cây cao) |
| Horizontality Emphasis | Nhấn đường ngang, sự trải dài (bãi biển, chân trời) |
| Vertical Angle (High/Low) | Khung dọc, áp dụng cho cả góc cao và thấp |
| Point of Interest Angle | Định vị để làm nổi một chi tiết trung tâm câu chuyện |
| The Reveal Angle | Sắp xếp để lộ yếu tố bất ngờ ở hậu cảnh |
| Stabilized Shot (No Camera Shake) | Vững chắc, không rung |
| Handheld Look (Subtle) | Rung nhẹ cầm tay, điện ảnh hoặc tài liệu |
| Shoulder Mount Look | Máy trên vai người quay, rung nhẹ, thô ráp, chân thực |
| Mobile Phone Angle (Casual/Authentic) | Chụp nhanh tự nhiên bằng điện thoại, có thể dọc |
| Hidden Camera Angle (Candid) | Chụp lén, không chuẩn bị |
| Whip Pan Transition (Implied Angle) | Ảnh tĩnh nhòe mạnh ngang/dọc mô phỏng xoay máy nhanh |
| The Trinity Angle (Matrix Style) | Máy xoay quanh chủ thể bắt khoảnh khắc kịch tính |
| Whip Around Angle | Máy xoay nhanh 360° quanh chủ thể |
| Reverse-Dolly Angle | Máy từ từ lùi xa, lộ không gian rộng hơn |
| Focus Magnification View | Mô phỏng phóng to kiểm tra nét thủ công |

## B. Chuyển động camera (Camera Movement) — Golden Prompts

### B1. Cơ bản
| Golden Prompt | Mô tả | Khi nào dùng |
|---|---|---|
| Slow smooth dolly in toward subject | Máy từ từ tiến lại gần chủ thể (như trên ray) | Nhân vật nhận ra điều quan trọng; tăng tập trung, căng thẳng, thân mật |
| Slow dolly out, pull back to reveal | Máy từ từ lùi xa | Kết cảnh, sự cô đơn, tiết lộ bối cảnh rộng |
| Side tracking shot, camera trucks left | Máy đi ngang song song chủ thể đang di chuyển | Đi bộ, chạy, đua xe, giữ nhịp hành động |
| Truck Left / Truck Right | Toàn bộ máy dịch ngang (như đi ngang kệ siêu thị) | Quét theo hàng vật thể |
| Slow pan right / Pan Left | Máy đứng yên, xoay đầu ống kính | Quét phong cảnh, giới thiệu không gian, dõi theo ánh mắt |
| Tilt up from feet to face | Ngước từ dưới lên | Giới thiệu trang phục, tôn sự uy nghi |
| Tilt Down | Cúi xuống | Tiết lộ chi tiết dưới đất, thể hiện yếu thế |
| Pedestal up / Pedestal down | Thân máy tịnh tiến lên/xuống (khác Tilt) | Tiết lộ chiều cao, nhìn thấy vật bị che |
| Handheld camera style, slight shake | Cầm tay, rung nhẹ tự nhiên | Raw realism, tài liệu, cãi vã, hồi hộp |
| Shaky Cam | Rung mạnh | Cháy nổ, hỗn loạn, chiến tranh |
| Steadicam / Gimbal Smooth | Mượt như bay | MV, thời trang, dream vibe |
| Static shot / Locked-off | Máy đứng yên hoàn toàn | Talking head, trang trọng |

### B2. Nâng cao
| Golden Prompt | Mô tả | Khi nào dùng |
|---|---|---|
| Arc shot, 360-degree orbit around subject | Xoay vòng 360° quanh chủ thể đứng yên | Giới thiệu trang phục, hero shot, lãng mạn cặp đôi |
| Crane shot up / Jib up | Nâng từ thấp lên cao thẳng đứng, mượt hơn drone | Kết cảnh, mở từ chi tiết ra toàn cảnh, hùng vĩ |
| Slow zoom in / Slow zoom out | Thu/phóng tiêu cự, máy đứng yên; không gian phẳng hơn Dolly | Tập trung từ từ, quan sát lén |
| Crash zoom / Snap zoom | Zoom cực nhanh đột ngột | Hài, giật mình, kung-fu, nhận ra sự thật sốc |
| Dolly zoom / Vertigo effect | Máy lùi + zoom vào (hoặc ngược lại), hậu cảnh bóp méo, chủ thể giữ nguyên | Choáng váng, sợ hãi, nhận thức đột ngột |
| Whip pan / Swish pan | Pan cực nhanh tạo vệt mờ | Chuyển cảnh vô hình, hỗn loạn, nhịp nhanh |
| Camera roll / Rolling shot | Xoay trục nghiêng, chân trời đảo lộn | Vũ trụ, chiến đấu trên không, bị đánh ngã, mất phương hướng |
| Barrel roll / 360-degree roll | Xoay 360° quanh trục ống kính | Hành động không gian, rơi tự do, đảo lộn thế giới |
| POV shot (Point of View) | Nhìn qua mắt nhân vật | Game bắn súng, kinh dị, nhập vai |
| SnorriCam shot / Body mount camera | Máy gắn vào người diễn viên, mặt đứng yên giữa khung | Say xỉn, hoảng loạn, bị rượt đuổi, tâm lý bất ổn |
| Bullet time effect | Thời gian ngưng, máy xoay quanh chủ thể lơ lửng | Né đạn kiểu Matrix, thể thao đỉnh cao |
| Z-axis rotation / Corkscrew shot | Vừa tiến vừa xoay như mũi khoan | Đường hầm, lỗ sâu vũ trụ, giấc mơ |
| Continuous long take / One-shot | Quay liên tục không cắt qua nhiều địa điểm | Kể chuyện liền mạch, căng thẳng, chân thực |
| The "Spielberg" Face | Slow Dolly In + Low Angle vào mặt kinh ngạc | Nhân vật thấy điều kỳ diệu (khủng long, UFO) |
| Following shot | Máy theo sau lưng chủ thể | Đi theo nhân vật, góc thứ 3 |
| Leading shot | Máy đi lùi phía trước mặt chủ thể | Thấy biểu cảm khi họ đang đi tới |
| Sweeping shot | Lướt qua phong cảnh rộng lớn | Hùng vĩ, giới thiệu bối cảnh |

### B3. Drone / bay lượn / đặc biệt
| Golden Prompt | Mô tả | Khi nào dùng |
|---|---|---|
| Fast FPV drone shot, aerial flyover | Bay tốc độ cao góc chim bay | Du lịch, thể thao mạo hiểm, đuổi bắt, mở đầu hoành tráng |
| Drone fly-through gap | Bay xuyên khe hẹp, cửa sổ | Khéo léo, khám phá nội thất từ ngoài, rượt đuổi |
| Fly through / Pass through shot | Bay xuyên qua vật thể (lỗ khóa, vòng lửa) | Chuyển cảnh, khám phá bên trong |
| Drone dive / Nosedive shot | Lao thẳng đứng từ trời xuống | Nhảy dù, từ toàn cảnh thành phố xuống cận đường phố |
| Drone nose-down to tilt-up reveal | Drone chúi xuống rồi ngước lên lộ chủ thể | Reveal hoành tráng |
| God's eye spiral | Top-down xoay tròn xoắn ốc lên/xuống | Nằm trên giường, bàn ăn, giữa cánh đồng hoa |
| Looking back drone shot | Bay lùi nhưng ống kính hướng về trước | Luyến tiếc, rời xa, nhìn lại hành trình |
| Top-down tracking shot | Nhìn thẳng từ trên, đi theo nhân vật | Mê cung, rừng rậm, nhân vật như kiến trên bàn cờ |
| Glider shot / Cable cam | Lướt êm và dài trên không như treo dây cáp | Sự kiện thể thao, đám đông lễ hội |
| Hyperlapse, moving time-lapse | Máy đi quãng dài trong khi thời gian trôi nhanh | Thành phố nhộn nhịp, ngày→đêm, hành trình |
| Vortex shot / Spinning tunnel / Spiraling down | Bị hút vào đường hầm xoáy | Du hành thời gian, ký ức, ảo giác, rơi xuống vực |
| Underwater drift, floating camera | Trôi lơ lửng bồng bềnh như dưới nước | Dream sequence, cảnh nước, thời trang nàng thơ |
| Sliding shot / Slider movement | Trượt ngang mượt qua vật cản tiền cảnh | Hiệu ứng parallax, tăng chiều sâu 3D |
| Reveal shot, sliding past foreground object | Lướt qua vật tiền cảnh để lộ cảnh chính | Tò mò, chuyển cảnh, giới thiệu phản diện/địa điểm bí mật |
| Chase camera, high speed shaking | Bám sát nhân vật chạy trốn, rung mạnh, nhòe | Rượt đuổi, hoảng loạn |
| Stop motion style camera | Chuyển động giật cục, thiếu khung hình | MV, quảng cáo phá cách, quirky |

## C. Tóm tắt nhóm cú máy (Cinematic Shot Groups)

**Chiều sâu & kịch tính (Depth & Drama):** Dolly In / Push In · Dolly Out / Pull Back · Zoom In · Crash Zoom · Dolly Zoom (Vertigo).
**Ngang & dọc (Scanning):** Pan · Whip Pan · Tilt Up · Tilt Down · Truck.
**Bám đuổi (Action & Tracking):** Tracking Shot · Following Shot · Leading Shot · Arc Shot / 360 Orbit.
**Trên cao (Grand & Epic):** Drone Shot / Aerial · Bird's Eye / Top-down · Crane / Jib · Sweeping Shot.
**Phong cách cầm máy (Vibe & Realism):** Handheld · Shaky Cam · Steadicam / Gimbal · FPV Drone.

## D. 官方分镜表规范（MiniMax-AI/MiniMax-H3 仓库自带的 skill 包，一手）

`skills/3d-animation-short-generator/references/shot-table-spec.md`（同仓库还有 `.claude/skills/h3-prompt-writing/references/ref-en.txt` = 我们这模式的正典）：

- `:23` **Shot Description 列必含**：shot size、**camera movement**、Dutch-angle design、performance style、SFX、negative prompt、**video-model generation notes** —— 官方在同一行写明模型分工：**H3 强在包装词与文字/UI/motion-graphics 清晰度，Seedance 2.0 才是 cinematic camera** ⇒ 在 H3 上，运镜写对了也不保证执行（1019 实测三条提示词的机位句全 static、用户判「没有镜头移动的感觉 纯粹是切换」与此一致）。
- `:38` `Per-Second Directives` 必须**从第一帧覆盖到最后一帧**，逐拍含 action、pose、expression、**camera movement**、spatial position、sound cue、continuity handoff。
- `:65` 每一拍都要五要素齐（action/pose/expression · camera · spatial · audio cue · handoff），亚秒拍（`2.0–2.5s`）允许但**段间不许留时间缝**。
- `:39` **官方点名禁止含糊**：`avoid vague timing such as "continues moving" without body, camera, or prop detail` —— 我们实测写过的 `camera continues static` / `camera continues` 正是这一条。
- `:64` 运镜的「有移动感」写法（官方例句原话）：`door-frame moves from right third to center as camera orbits left` ← **把运镜写成它在画面里的效果**：同一句里给出哪件地标/主体从画面哪儿滑到哪儿，而不是只说「camera trucks at slow speed」。
- `ref-en.txt:7` 每个 shot 都要 establish：composition、subject appearance and position、environment and lighting、actions and state changes、**camera movement**、current sound、参考素材真正生效的位置。
- `ref-en.txt:219` 运镜写成当前 shot 内的自然英文，含类型、幅度、速度「**when they need to be expressed**」（官方允许省，这台模型实测省 = 运镜整个消失 ⇒ 我们一律写全，见主 skill「三件齐」）。
- `ref-en.txt:82 / :143 / :185` **`<Video N>` 可以只传机位**：参考视频供 camera movement / cuts / rhythm / temporal structure 时标 `weak_reference`、归 `reference generation`，且必须明写它**不贡献** identity / wardrobe / props / location。本平台适配器目前只有 9 个图槽（`MAX_IMAGES=9`）、没有视频参考 = 已知缺口（台账未结⑰）。

## E. JZL 镜头规则包（本机已装，`E:/AI/ComfyUI/custom_nodes/ComfyUI-JZL-MiniMax-H3/sheding/`）

`h3_shot_rules.py`（558 行）+ `styles/*.md`（8 个题材「镜头语言库」）：

- `:22-23` 分段七要素的字段表：**景别** [远景/全景/中景/近景/特写]、**运镜** [固定/推/拉/摇/移/跟/**升**/**降**]（八类，升降我们有缺）
- `:82` 「**每个分段必须写全七要素**……⑤运镜（**类型+幅度+速度**）」← 运镜是**逐 3 秒段**的硬要求，不是整条一次
- `:75` 「**静止镜头也要有 1 处微副运动**（呼吸/衣角/光影/尘埃/水汽）避免画面死板」
- `:88` 「每个 [Shot N] 平均**每秒至少 2 个可被相机拍到的事实**（6 秒镜头至少 12 个）」；可见事实清单 = 肢体质心/朝向变化、接触点、受力形变、位移、道具状态变化、表情肌变化、环境反应、副运动、**镜头运动**、同步声音、引用元素出现位置；「禁止用形容词与心理描写顶替可见事实」
- `:85` 运镜必须作为画面的自然动作主语融入句子，**绝不允许当独立标签堆在句尾**；幅度/速度的选用交给题材镜头语言库
- `:108 / :126` 切镜与运镜的**节奏由题材库决定**（动作类快切、温情类舒缓），全局不做统一规定
- `styles/04-甜宠爽文.md:71-74` 按节拍定档的实例：前期压抑缓慢（沉默+特写）→ 中期逆转爆发（快剪/**极速推近面部**）→ 后期从容慢镜头；**仰拍 = 逆袭高大、俯拍 = 被压渺小、环绕 = 心动对视**；`:59` 副运动清单（衣摆/长发/裙摆/首饰反光/气泡）、`:60` 密度每秒 ≥2
- `:185` 中文自然写法例句：`摄影机以小幅慢速向前推`

## F. 各家方言与「运动必填」（`luozhilzh/video-prompt-reverse`，44★，pushed 2026-10-17）

- `:7` 一句话诊断：**「开源工具普遍只描述『画面里有什么』，不描述『怎么动』」**（运镜 / 时序 / 主体运动 / 物理连续是四个独立维度）
- `:61` 框架里「**运动（必填）** = 运镜 + 主体运动 + 时序」；`:89`「每 clip **一主运动，避免冲突**」（与我们「一镜一运镜不叠加」同）
- `:30` 各家运镜方言表：**海螺（MiniMax 系）指令式** `[推进][左摇][固定]`，同组 ≤3 条、顺序运镜用「然后」；**即梦量化** `镜头高度1.6米,匀速前推,速度0.8米/秒,焦段24毫米`；`:125` 对照表里「固定锁定 static」各家写法（`"static camera"` / `[固定]` / 「固定镜头」 / preset / `locked-off shot`）
- **注意**：H3 的文本编码器是 Qwen3-VL、吃自然语言句子（`docs/prompt-vulva-terms.md` 里已记这条），所以**指令式 `[推进]` 不搬进我们**；量化写法（机位高度/速度 m/s/焦段）是**待测**，官方 H3 口径里没有这一项。

## G. 生成侧的运镜杠杆（`mrhz1973/ai-video-director`，**跟我们同栈**：ComfyUI 本地 + H3 ref2va + `.agents/skills/`）

`comfyui-harness/lib/h3-lora-catalog.mjs`（v0.15.0）登记的 H3 LoRA 家族（loader = `LoraLoaderModelOnly`，与我们桥的 210 号同一机制；每条 pin 了 SHA256）：

| profile id | 文件名 | catalog default | 他们 issue #69 的实测建议 |
|---|---|---|---|
| `camera-motion` | `camera_motion_h3_lora_v1_3000_pruned.safetensors`（SHA `9d7d98d7…`） | 0.8 | **~0.55，只在真要运镜时挂**；0.75 实测 **~1.62× 脸尺度漂**（unwanted push-in） |
| `spatial-physics` | `wushu_spatial_physics_clean_3000_pruned.safetensors`（`7d14f370…`） | 0.3 | 0.25 = 头部/落地机制；~0.55 = 呼吸姿态真实且**保住构图**（1.00×）；0.70 → 1.58× |
| `action` | `wushu_action_h3_lora_v5_3000_pruned.safetensors`（`136c1692…`） | 0.5 | ~0.35 = 反应/决断拍的最佳（保住画面）；0.50–0.65 → 1.71–1.74× |
| `realism-people` | `h3-realism-people-t2v-i2v-r2v.safetensors`（`acc52960…`，trigger `r34l1sm`） | 0.7 | 0.40–0.55 用于近景；0.85 → 1.43×、1.00 → 1.58× |

- #69 的总结论（20 单、同 general close-up 配置、prompt 与 seed 变）：**「recurring failure mode 不是丢身份（identity 意外地稳），是 unwanted push-in / scale drift / reframing」**，且强度越高越明显 ⇒ 他们要求「**只在明确要运镜时才挂 Camera Motion，别当通用画质 LoRA**」。这条与我们 1019 实测「`extreme close-up` 把器官画满整幅（用户判「阴部太大了」）」同族，给我们的 `extreme close-up`→`close-up` 降级与 0.7 强度上限提供社区数据支撑。
- 他们自己加的 caveat（照实搬）：「prompts and seeds differ across the 20 jobs ⇒ 不要断定是某个 LoRA 强度单独造成的漂移；这是相关性模式与可用工作区间，不是隔离出的因果」，并列出下一步受控 A/B（同图同 prompt 同 seed，只换 LoRA/强度）。
- **未进生产**：我们这边挂任何 LoRA 的实测时间税 = 1.45×（skin_realism）/ 2.0×（pussy_spread LoKr），要试 `camera-motion` 得先下载权重 + 进 key 登记表 + 实测每步税（台账未结⑰）。

## H. 机位当几何算（BSAI，本机已装）

`E:/AI/ComfyUI/custom_nodes/BSAI-ComfyUI-Sol-H3/h3_t8/nodes_meridian.py:168-200` = **MiniMaxH3MeridianCameraEXPT8「Meridian 3 · 运镜／时间编辑器（T8）」**：`preset`（含 `slide`、orbit 等）＋ `strength`（tooltip 原话「相对固定枢轴深度的位移；orbit 为 strength×100 度。大位移补洞更多，非性能/画质保证」）＋ `camera_plan`（「高级编辑器自动写入规范 JSON；留空使用预设」）＋ `warp_preview` 输出（节点描述明写「预览是灰洞点云 warp，**不是生成视频**」）。这条是「运镜**保证**发生」的硬路（不靠模型读句子），代价与门禁写在 `h3_t8/director_capabilities.py:105`：「几何权重、ConvRot INT8 与完整 P2/P3/P4 质量门禁独立记录，不从 D2 生成结果冒充」。**未评估**（台账未结⑭：先回答「素材从哪来」再烧卡）。

## I. 这份里**没有**的（别当已采纳）

- 焦段 / 景深 / 胶片语法（Rylaispirit 的 `references/04-lens-technical-film.md`，10.6 KB）—— 我们提示词里目前零镜头词汇，要不要接由你定；
- 灯光 / 构图 / 风格配色 / 材质天气（同仓库 02/03/05/06 四份）—— 我们的风格预设与场景 skill 已覆盖一部分；
- 量化机位写法（F 节「即梦」那条）—— 待测，未写进硬规则；
- `<Video N>` 视频参考（D 节最后一条）—— 平台还没有这条通道，未实现。
