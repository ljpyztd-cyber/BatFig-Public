# Running BatFig from source · 从源码运行 BatFig

On Windows, use Python 3.12, Node.js 22 and pnpm 11.27.1. Install Arial locally for the default figure profile. Times New Roman is available for figures using that family. BatFig checks the requested fonts when rendering.

在 Windows 上安装 Python 3.12、Node.js 22 和 pnpm 11.27.1。默认科研字体为本机安装的 Arial，也可以显式选用 Times New Roman。请在仓库根目录用 PowerShell 运行以下命令。

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -e ".[worker]"
.\.venv\Scripts\python.exe scripts/fetch_fonts.py
.\.venv\Scripts\python.exe scripts/build_frontend.py
.\start_batfig.ps1
```

Open the local session link printed by the launcher. On later starts, run `.\start_batfig.ps1`. The launcher uses port 5194 by default and creates its working directories under `codex-files/`. The Python package and command retain the upstream name `tavotto`.

打开启动脚本输出的本机会话链接。下次启动只需运行 `.\start_batfig.ps1`。素材库的“导入 CSV 曲线”可以选择 X 列和多个 Y 列。图内编辑使用 Matplotlib 源脚本，页面上的文字和面板位置可以在画布里调整。

- [CSV 曲线与科学文字](docs/batfig-arial-csv.md)
- [字体选择](docs/batfig-font-selection.md)
- [热图配色与对齐](docs/batfig-color-and-layout.md)
- [整画布拼版](docs/batfig-panel-grid.md)

BatFig incorporates [Tavotto v0.17.0](https://github.com/Tavotto/Tavotto/tree/720b90b08461444080490028ec66e1070254bbde) under [AGPL-3.0-only](LICENSE). The public source includes the BatFig changes through October 22, 2026.
