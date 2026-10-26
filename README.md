# DMY Better

代码源 newoj（`newoj.daimayuan.top`）的油猴增强脚本。发布在 [Greasy Fork](https://greasyfork.org/zh-CN/scripts/600021-dmy-better)，源码在本仓库。

## 功能

- **解除复制限制**：页面禁止选中、复制、右键的限制全部去掉。
- **复制 MD**：题目页左下角按钮，把题面（含 KaTeX 公式、样例、表格、图片）复制为 Markdown。
- **保存题目**：把当前题目渲染成 PDF，连同题目附件一起下载到以题目命名的文件夹。
- **保存整个比赛**：在比赛页逐题加载并保存，按「比赛名/题号. 题名/」分文件夹。

这三个功能也都在油猴菜单里。

## 安装

先在浏览器装 [Tampermonkey](https://www.tampermonkey.net/)（或 Violentmonkey），然后任选一种：

- **从 Greasy Fork 安装**（推荐，国内访问更稳）：<https://greasyfork.org/zh-CN/scripts/600021-dmy-better>
- **从 GitHub 安装**：打开 <https://raw.githubusercontent.com/koma404/DMY-Better/HEAD/dmy-better.user.js>

脚本没有写死更新地址，油猴会从你安装时的地址检查更新：从 Greasy Fork 装的从 Greasy Fork 更新，从 GitHub 装的从 GitHub 更新。修改脚本后记得把 `@version` 加一，否则油猴不会更新。

## 配置

题面容器、标题、附件的选择器写在脚本开头的配置区，代码源改版时改那里即可。PDF 的渲染宽度和清晰度也在那里调。

PDF 生成用到 html2canvas 和 jsPDF，通过 `@require` 从 cdnjs 加载；如果安装时提示库下载失败，可能是网络访问不了 cdnjs。

## 相关脚本

[Contest → Claude 一键解题](https://github.com/koma404/oj-claude-helper)：在 Codeforces / AtCoder / 洛谷 / LeetCode / Vjudge / 代码源 题目页一键把题面发给 Claude。在代码源上和本脚本一起用效果最好：DMY Better 负责复制 Markdown 和下载，Contest → Claude 负责发给 Claude。
