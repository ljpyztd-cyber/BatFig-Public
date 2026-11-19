# BatFig 本机 Arial 与 CSV 曲线闭环

日期：2026-10-04。基于 Tavotto v0.17.0 的本地 AGPL-3.0-only 衍生开发，保留上游许可证、版权与来源。本页描述本轮实现，不代表跨平台或发行验收。

后续版本增加了显式 Times New Roman 字体选择，默认 Arial 保持不变；当前字体使用与验收见 `batfig-font-selection.md`。下文保留 Arial/CSV 首轮记录。

## 使用

启动步骤见 [BATFIG.md](../BATFIG.md)。

在素材库选择“导入 CSV 曲线”，选择文件、X 列及一个或多个 Y 列，填写轴标题与单位，然后“生成并添加到画布”。仍使用原有对象编辑、撤销/重做、文档保存、快速编辑及 PDF/PNG 导出入口。

新文字与面板编号使用当前 BatFig 规范的 Arial。画布上下标可输入 `Li_{2}O`、`mAh g^{-1}`、`Zn^{2+}`；属性栏有常用希腊字母和单位按钮。科学解释模式会将识别的 Unicode 上下标统一用同一 Arial 字体合成。正文编辑时显示源文本，完成编辑后恢复真实排版预览。

## 两条字体路径

| 路径 | 校验与显示 | 导出 |
|---|---|---|
| Matplotlib 图内文字 | 显式 Arial 不追加 DejaVu 回退；检查实际 FT 字体族、字重/样式和 glyph，缺失报错。MathText custom 集在受支持表达式中使用 Arial | 实际 PDF 子集嵌入与图内覆盖冷启动重放验证 |
| RenderCore 画布文字 | 从本机读取并校验四种真实 Arial TTF 的 name/OS2/cmap、SHA-256 和嵌入权限，HarfBuzz 排版，经 canonical PDF 栅格化为预览；无浏览器 CSS 替代 | 可检索矢量 PDF 子集嵌入；PNG 来自同一 canonical PDF |

Windows 默认读取系统 Fonts 中的 `arial.ttf`、`arialbd.ttf`、`ariali.ttf`、`arialbi.ttf`。也可在启动前设置 `BATFIG_ARIAL_DIR` 指向合法安装的四种字体所在目录；此变量仅覆盖 RenderCore 字体解析，Matplotlib 使用其环境中安装的真实 Arial。缺文件、错误字体身份、禁止子集嵌入或缺字形均明确失败。

Arial 文件不复制到仓库、不会由字体 API 发送到浏览器，也不加入批准的可分发 OFL 字体包。历史文档的三个通用族保留原语义；不能将它们视作 Arial。

## CSV 契约与可复现性

- UTF-8（可带 BOM）、英文逗号分隔、首行为列名；2–64 列、最多 100000 条记录、5 MiB。
- 首尾空白归一后的列名必须唯一。选中的 X/Y 列必须全部是有限数值；不静默删除空行、缺值、非数字、NaN 或 Inf，不排序、不插值、不平滑。
- 每次导入在当前图库的 `batfig-imports/csv-<uuid>/` 创建独立目录：`source.csv` 保留原始字节；`figure.json` 保存源哈希、列映射、样式、系列身份；`figure.py` 是可独立运行的 Matplotlib 源码。
- 每次执行核对原始 CSV SHA-256；改了数据需要重新导入。导入本身只创建文件，运行使用已有 safe worker 和注册表；不会绕过会话认证、沙盒或项目隔离。
- 数据/spec 与画布文档的 artist 覆盖分开保存。图内颜色等视觉编辑不会冒称已经写回 spec。
- 生成源码中的系列 gid 稳定，但当前引擎仍以自身的 artist 身份与位置 gid 重放；没有完成旧 `.batpanel` 的版本映射或兼容。
- CSV 标签按字面 Unicode 处理，不将 `$...$` 当成 MathText。Arial 不含的字符明确失败；完整公式请使用受支持的画布科学文本，或自行提供经过验证的 Matplotlib 源码。
