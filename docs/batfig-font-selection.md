# BatFig 字体选择：Arial 与 Times New Roman

Arial 仍是新文字的默认字体。用户可在属性栏选择真实的 Times New Roman（新罗马），再调整字号、粗体和斜体。画布文字、面板编号和 Matplotlib 图内文字分别沿用原有编辑与保存路径；字体修改参与撤销和重做。

## 使用位置

选中画布文字或编号，在右侧属性栏的字体下拉框切换 Arial / Times New Roman。选中图内标题、轴标签、刻度或图例文字时，同一套排版控件作用于相应 Matplotlib 对象；多选使用现有批量属性编辑入口。

画布支持 `Li_{2}O`、`Zn^{2+}`、`mAh g^{-1}`、希腊字母和单位。编辑源文本时显示原始字符，结束编辑后显示后端排版预览。画布科学文本与 Matplotlib MathText 是不同的解析路径。

旧文件内保存的出版规范快照保持原样。若它仅接受 Arial，切换为 Times New Roman 后仍会提示不符合旧规范；通过已有规范同步入口明确采用新版规范，或保留旧规范要求。选择一种字体不会暗中修改文档的规范快照。

## 真实字体与导出

两种字体均从本机合法安装读取，核验字体身份、四种样式、字形覆盖和嵌入许可。缺字体、缺样式或缺字形时明确报错，不用 Helvetica、Liberation 或 Times-Roman 冒充目标字体。字体二进制不进入 Git、不打包，也不由字体 API 发送到浏览器。

RenderCore 的画布预览从实际字体排版后的 PDF 栅格生成，最终 PDF 保持矢量文字；PNG 来自相同合成路径。Matplotlib 图内文字独立验证其实际使用字体，不能只看下拉框名称。

Windows 验收使用系统中的 Arial 和 Times New Roman 四种 TTF。RenderCore 可通过 `BATFIG_ARIAL_DIR` 或 `BATFIG_TIMES_NEW_ROMAN_DIR` 指定对应字体目录；Matplotlib 使用其运行环境中安装的字体。

## 边界

- 默认 Arial 不变；三个历史通用字体族保留原语义，不冒称上述两种字体。
- 本轮只验收 Windows 本机；未验收 macOS、Linux 或独立桌面发行包。
- 单张 Matplotlib 图若同时要求两套不同的 custom MathText 字体集，明确拒绝；普通文字和独立画布文字对象可分别选字体。
- 完整 TeX、复杂数学排版、竖排、双向文字及汉字/emoji 的替代字体方案不在本轮范围内。
