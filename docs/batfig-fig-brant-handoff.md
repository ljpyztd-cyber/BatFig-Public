# fig-brant 与 BatFig 的交接

## 两种用途

普通 fig-brant 出图继续默认 600 dpi 白色不透明 PNG。用户明确要求放入 BatFig 编辑时，使用独立的交接模式：固定物理尺寸的 Matplotlib Figure、透明面板底、矢量 PDF 与参考 PNG，同时保留源码、实际数据、spec、样式快照和来源哈希。BatFig 页面保持白色；可编辑性来自 Matplotlib 源码和 artist，不来自 PDF 文件扩展名。

## 已发现的适配问题

- fig-brant helper 和 style rc 中的 `bbox_inches="tight"` 会让导出页面尺寸随刻度和标签变化。交接模式须清除 `savefig.bbox`，让 Figure 本身的物理尺寸与 PDF 页面一致；普通模式不受影响。
- 仅用单个轴的 tight bbox 裁剪复合图可能遗漏独立色条、右侧 Y 轴或 Figure 文字。每个面板应独立构建完整 Figure，连同它的双轴、色条和图例。
- BatFig 当前捕获不保留 savefig 的 bbox/pad/dpi/transparent 参数，见 [捕获契约](rules/backend/figure-capture-and-execution.md)。因此透明底必须在 Figure 和二维 Axes patch 上设置，不能只传 `transparent=True`。
- 字体家族的候选列表可能产生替代字体。交接模式明确采用真实 Arial，或用户选择的 Times New Roman；核对使用字形与最终 PDF 嵌入，字体文件不随包分发。

## 布局与编辑契约

推荐交接 Figure 与目标单元采用一致比例，并统一主数据轴框。色条保留为独立轴，双 Y 轴保留真实关联。图幅、轴框和字号都在源 spec 中明确，避免仅靠最终拼版缩放补救过小文字。

几何描述使用左上原点，分别记录数据轴框、含标签外框以及轴角色。预录轴框只作来源参考；BatFig 的对齐以当前变体的精确 manifest 为准，排除色条，重合 twin 轴自然共用边界。源码、数据、spec、字体、尺寸或轴位置改变后必须重建，不使用旧 PNG 或旧 JSON 猜测。

fig-brant 的语义 ID 不冒充 BatFig runtime gid。数据、单位、映射等结构变化回到 spec；画布上的视觉覆盖保存在 overrides 中。源结构改变后重新核对目标身份，不将任意 artist 修改声称已经回写科研 spec。

BatFig 当前 [统一拼版](batfig-panel-grid.md) 默认 `ceil(sqrt(n))` 列、4:3 单元、3 mm 图幅间距、8 mm 页边距。同列按左轴线、同行按下轴线对齐；源图等比缩放。不同轴框会产生额外留白，单元间距不等于可见图边缘间距。任何可见面板锁定、固定或成组都会阻止整次拼版。
